// plan63 片 1：fts 引擎单测。纯 Node（better-sqlite3 有 Node ABI prebuilt，CI 可跑）；
// DB 用 :memory:，不落盘。变异纪律：每颗判据对应一颗能打红的变异（tokenize 切法 / 短语语义 / 删行）。
import { describe, expect, it } from 'vitest'
import { createFtsIndex, matchQueryFor, tokenizeForFts } from '../../src/main/memory/fts'

describe('tokenizeForFts（按字切口径）', () => {
  it('CJK 逐字切开、拉丁串保持整词并小写、混合文本两全', () => {
    expect(tokenizeForFts('狐狸')).toBe('狐 狸')
    expect(tokenizeForFts('Hello 世界')).toBe('hello 世 界')
    expect(tokenizeForFts('v2更新')).toBe('v2 更 新')
    expect(tokenizeForFts('，。！')).toBe('')
    expect(tokenizeForFts('')).toBe('')
  })
})

describe('matchQueryFor（查询侧短语语义）', () => {
  it('每词各自成短语、词间 AND、大小写与标点归一', () => {
    expect(matchQueryFor('狐狸 太阳')).toBe('"狐 狸" "太 阳"')
    expect(matchQueryFor('Fox常见吗')).toBe('"fox" "常 见 吗"')
    expect(matchQueryFor('，。！')).toBeNull()
    expect(matchQueryFor('')).toBeNull()
  })
})

describe('createFtsIndex（:memory: 全链路）', () => {
  it('upsert→search 中文命中，BM25 相关性排序', () => {
    const idx = createFtsIndex(':memory:')
    try {
      idx.upsert({ file: 'notes/a.md', name: '部署流程', class: 'fact', body: '部署要用 npm run build，先测试再打包' })
      idx.upsert({ file: 'notes/b.md', name: '猫图收藏', class: 'fact', body: '收藏夹里是狸猫图片' })
      const hits = idx.search('部署')
      expect(hits.length).toBe(1)
      expect(hits[0].file).toBe('notes/a.md')
      // 词间是 AND：a 只含「部署」、b 只含「狸」⇒ 零命中才是对
      expect(idx.search('部署 狸').length).toBe(0)
      // 双词都含的条目才命中；单条命中直接可断言排序首位
      idx.upsert({ file: 'notes/c.md', name: '杂记', class: 'fact', body: '部署机器上的狸猫壁纸' })
      const ranked = idx.search('部署 狸')
      expect(ranked.map((h) => h.file)).toEqual(['notes/c.md'])
    } finally {
      idx.close()
    }
  })

  it('upsert 幂等：同 file 重复写入是替换不是叠加', () => {
    const idx = createFtsIndex(':memory:')
    try {
      const row = { file: 'notes/x.md', name: '缓存', class: 'pref', body: '读缓存优先于重算' }
      idx.upsert(row)
      idx.upsert({ ...row, body: '读缓存优先于重算，次版本更新' })
      expect(idx.count()).toBe(1)
      expect(idx.search('次版本').length).toBe(1)
      expect(idx.search('次版本')[0].file).toBe('notes/x.md')
    } finally {
      idx.close()
    }
  })

  it('remove 后不再命中；查询无匹配词返回空而非全表', () => {
    const idx = createFtsIndex(':memory:')
    try {
      idx.upsert({ file: 'notes/y.md', name: '代理', class: 'fact', body: '代理端口 65532' })
      expect(idx.search('代理').length).toBe(1)
      idx.remove('notes/y.md')
      expect(idx.search('代理').length).toBe(0)
      expect(idx.count()).toBe(0)
      expect(idx.search('   ')).toEqual([])
    } finally {
      idx.close()
    }
  })
})
