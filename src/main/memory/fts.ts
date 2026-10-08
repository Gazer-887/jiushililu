// 记忆全文检索引擎（plan63 片 1 · D-154/D-156）：SQLite FTS5 + BM25。
// 接缝只有一处：DB 路径由调用方注入（主进程装配 userData 目录，单测传 ':memory:'），本文件不 import electron。
// ⚠️ better-sqlite3 必须钉 v12——v13 的 N-API 版在 Node 20/22 segfault（上游 #1514 未修），
// 构建链双 ABI 处理见 scripts/afterpack-sqlite-prebuilt.cjs。
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { MemorySearchHit } from '@shared/memory'

/** CJK 区段（假名 / 汉字扩展 / 谚文）：unicode61 把连续 CJK 当一整块词，必须应用层逐字切开 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const WORD_RE = /[A-Za-z0-9_]/

/**
 * 入库/索引文本的切分：CJK 逐字成 token、拉丁/数字串保持整词并转小写、其余字符当分隔符。
 * ⚠️ 查询侧必须走 matchQueryFor（语义是"短语"），直接把本函数输出塞进 MATCH 语义会变成整串连续匹配。
 */
export function tokenizeForFts(text: string): string {
  const out: string[] = []
  let latin = ''
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      if (latin !== '') out.push(latin)
      latin = ''
      out.push(ch)
    } else if (WORD_RE.test(ch)) {
      latin += ch.toLowerCase()
    } else if (latin !== '') {
      out.push(latin)
      latin = ''
    }
  }
  if (latin !== '') out.push(latin)
  return out.join(' ')
}

/**
 * 查询串 → FTS5 MATCH 表达式：按「拉丁串 | 连续 CJK 串」切词（中英混排如「部署npm」拆成两个意图），
 * 每词 CJK 逐字后包成短语，词间 AND。例：「狐狸 太阳」→ `"狐 狸" "太 阳"`；
 * 无可检索内容返回 null（调用方按空查询处理）。
 */
export function matchQueryFor(text: string): string | null {
  const words = text.match(/[A-Za-z0-9_]+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g)
  if (words === null) return null
  const phrases = words
    .map((w) => tokenizeForFts(w).split(' ').filter((t) => t !== ''))
    .filter((ts) => ts.length > 0)
    .map((ts) => `"${ts.join(' ')}"`)
  return phrases.length > 0 ? phrases.join(' ') : null
}

export type FtsHit = MemorySearchHit

export interface FtsDocument {
  file: string
  name: string
  class: string
  body: string
}

export interface FtsIndex {
  /** 幂等：同 file 重复 upsert 是替换不是叠加；remove 过的 file 重新 upsert 等价首次 */
  upsert(input: FtsDocument): void
  /** 单事务替换完整生效快照；失败回滚，不能留下半份索引。 */
  replace(entries: readonly FtsDocument[]): void
  remove(file: string): void
  /** query 走 matchQueryFor 口径；空查询返回空数组（不是全表） */
  search(query: string, limit?: number): FtsHit[]
  count(): number
  /** 清空全表。启动全量重建用（索引是衍生缓存，重建是自愈手段） */
  clear(): void
  close(): void
}

export function createFtsIndex(dbPath: string): FtsIndex {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

  // 连接策略：文件路径走「每操作短连接」（开-写-关），调用方因此不持任何常驻句柄——
  // 记忆写频低（人工/反思级），每次开销毫秒级；而测试惯用「建目录→跑→rmSync」的清理模式，
  // 常驻连接会让 Windows 的 rmSync 撞 EPERM（55 条假红实测）。:memory:（单测）保持常驻，否则数据不落。
  if (dbPath === ':memory:') {
    const db = new Database(dbPath)
    installSchema(db)
    const bound = bindOps(db)
    return {
      ...bound,
      close() {
        db.close()
      }
    }
  }
  const withDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(dbPath)
    try {
      installSchema(db)
      return fn(db)
    } finally {
      db.close()
    }
  }
  return {
    upsert(input) {
      withDb((db) => bindOps(db).upsert(input))
    },
    replace(entries) {
      withDb((db) => bindOps(db).replace(entries))
    },
    remove(file) {
      withDb((db) => bindOps(db).remove(file))
    },
    search(query, limit = 8) {
      return withDb((db) => bindOps(db).search(query, limit))
    },
    count() {
      return withDb((db) => bindOps(db).count())
    },
    clear() {
      withDb((db) => bindOps(db).clear())
    },
    close() {
      /* 短连接模式无常驻句柄，幂等空操作 */
    }
  }
}

function installSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(' +
      "body, name UNINDEXED, class UNINDEXED, file UNINDEXED, tokenize='unicode61')"
  )
}

function bindOps(db: Database.Database): FtsIndex {
  const del = db.prepare('DELETE FROM memory_fts WHERE file = ?')
  const ins = db.prepare('INSERT INTO memory_fts (body, name, class, file) VALUES (?, ?, ?, ?)')
  const insert = (input: FtsDocument): void => {
    // 正文与名称参与检索；名称另存 UNINDEXED 列回显，不提供原文片段。
    ins.run(`${tokenizeForFts(input.body)} ${tokenizeForFts(input.name)}`, input.name, input.class, input.file)
  }
  const upsert = db.transaction((input: FtsDocument) => {
    del.run(input.file)
    insert(input)
  })
  const replace = db.transaction((entries: readonly FtsDocument[]) => {
    db.exec('DELETE FROM memory_fts')
    for (const entry of entries) insert(entry)
  })
  return {
    upsert(input) {
      upsert(input)
    },
    replace(entries) {
      replace(entries)
    },
    remove(file) {
      del.run(file)
    },
    search(query, limit = 8) {
      const match = matchQueryFor(query)
      if (match === null) return []
      return db
        .prepare(
          'SELECT file, name, class, bm25(memory_fts) AS score ' +
            'FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score LIMIT ?'
        )
        .all(match, limit) as FtsHit[]
    },
    count() {
      return (db.prepare('SELECT count(*) AS n FROM memory_fts').get() as { n: number }).n
    },
    clear() {
      db.exec('DELETE FROM memory_fts')
    },
    close() {
      /* 由持有者决定，bindOps 自身不关 */
    }
  }
}
