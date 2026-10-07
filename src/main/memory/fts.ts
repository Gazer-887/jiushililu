// 记忆全文检索引擎（plan63 片 1 · D-154/D-156）：SQLite FTS5 + BM25。
// 接缝只有一处：DB 路径由调用方注入（主进程装配 userData 目录，单测传 ':memory:'），本文件不 import electron。
// ⚠️ better-sqlite3 必须钉 v12——v13 的 N-API 版在 Node 20/22 segfault（上游 #1514 未修），
// 构建链双 ABI 处理见 scripts/afterpack-sqlite-prebuilt.cjs。
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

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

export interface FtsHit {
  /** 条目文件名（记忆区相对路径），接线侧据此回指条目原文 */
  file: string
  name: string
  class: string
  /** bm25 值：越小越相关（FTS5 惯例，负值常见），本接口不做归一，也不提供 snippet（原词形态由调用方回原文取） */
  score: number
}

export interface FtsIndex {
  /** 幂等：同 file 重复 upsert 是替换不是叠加；remove 过的 file 重新 upsert 等价首次 */
  upsert(input: { file: string; name: string; class: string; body: string }): void
  remove(file: string): void
  /** query 走 matchQueryFor 口径；空查询返回空数组（不是全表） */
  search(query: string, limit?: number): FtsHit[]
  count(): number
  close(): void
}

export function createFtsIndex(dbPath: string): FtsIndex {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(' +
      "body, name UNINDEXED, class UNINDEXED, file UNINDEXED, tokenize='unicode61')"
  )
  const del = db.prepare('DELETE FROM memory_fts WHERE file = ?')
  const ins = db.prepare('INSERT INTO memory_fts (body, name, class, file) VALUES (?, ?, ?, ?)')
  const upsert = db.transaction((input: { file: string; name: string; class: string; body: string }) => {
    del.run(input.file)
    // 入库文本 = 正文与条目名都参与检索；name 另存 UNINDEXED 列供结果回显
    ins.run(`${tokenizeForFts(input.body)} ${tokenizeForFts(input.name)}`, input.name, input.class, input.file)
  })
  return {
    upsert(input) {
      upsert(input)
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
    close() {
      db.close()
    }
  }
}
