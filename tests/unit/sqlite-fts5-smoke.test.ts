// 构建链冒烟（B4 · D-154/D-156）：better-sqlite3 在 Node 侧可加载、FTS5 编译选项在、
// 中文按字切检索通路可命中。Electron ABI 半由打包点验覆盖（app.asar.unpacked 内真加载），
// 本测试只兜 CI 的 Linux 侧；两侧都绿才算构建链验通。
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

describe('B4 构建链冒烟：better-sqlite3 + FTS5', () => {
  it('Node 侧加载 + FTS5 编译选项在 + 按字切中文可命中', () => {
    const db = new Database(':memory:')
    try {
      const opts = db.pragma('compile_options') as { compile_options: string }[]
      const fts5 = opts.some((o) => o.compile_options === 'ENABLE_FTS5')
      expect(fts5, '本构建的 SQLite 未编译进 FTS5').toBe(true)

      // 中文检索设计口径（切片期拍板前为准）：unicode61 不切 CJK ⇒ 入库与查询都按字切
      db.exec('CREATE VIRTUAL TABLE smoke_fts USING fts5(body)')
      db.prepare('INSERT INTO smoke_fts VALUES (?)').run('狐 狸 晒 太 阳')
      const hit = db
        .prepare("SELECT body FROM smoke_fts WHERE smoke_fts MATCH '\"狐 狸\"'")
        .get() as { body: string } | undefined
      expect(hit?.body, '按字切 MATCH 未命中').toBe('狐 狸 晒 太 阳')
      const miss = db
        .prepare("SELECT body FROM smoke_fts WHERE smoke_fts MATCH '\"狐 猫\"'")
        .get() as { body: string } | undefined
      expect(miss, '不该命中的查询命中了').toBeUndefined()
    } finally {
      db.close()
    }
  })
})
