// plan55 片④-a：预筛的**采信层**判据 —— 只测"模型说的话能不能信"，不测"分得对不对"。
// ⚠️ 本文件全绿**不等于**筛得准（plan55 §六）：分组质量只能靠人眼，见 plan55 片④ 验收一节。

import { describe, expect, it } from 'vitest'
import { MEMORY_LIMITS, utf8Bytes, validateMemoryFields, type MemoryEntry } from '@shared/memory'
import {
  PRESCREEN_SYSTEM_PROMPT,
  buildPrescreenPrompt,
  composeMergedBody,
  fitUtf8Bytes,
  parsePrescreenResult
} from '@main/memory/prescreen'

function cand(name: string, cls: MemoryEntry['class'], desc = '一条摘要'): MemoryEntry {
  return {
    name,
    description: desc,
    class: cls,
    origin: 'model',
    evidence: null,
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    body: '这条提案的正文不应出现在给模型的提示里。',
    file: `/mem/notes/candidates/${name}.md`
  }
}

const A = cand('verbatim-raw-output', 'default', '要求逐字回贴 stdout')
const B = cand('verbatim-raw-stdout', 'default', '要求逐字回贴 stdout 输出')
const S = cand('prefers-tables', 'style', '汇报用表格')
const ALL = [A, B, S]

const merged = (sources: string[], over: Record<string, unknown> = {}) => ({
  sources,
  name: 'verbatim-output',
  description: '要求逐字回贴原始 stdout',
  class: 'default',
  body: '用户要求子代理逐字回贴原始 stdout，并严格禁止任务书之外的探测或命令。',
  ...over
})

describe('合格输出：全簇采信、来源可追', () => {
  it('两条同义提案并成一簇，第三条单独成簇 ⇒ uncovered 为空', () => {
    const raw = JSON.stringify([
      merged(['c1', 'c2']),
      merged(['c3'], { name: 'prefers-tables', description: '汇报用表格', class: 'style', body: '汇报数据用表格呈现。' })
    ])
    const r = parsePrescreenResult(raw, ALL)
    expect(r.rejected).toEqual([])
    expect(r.clusters).toHaveLength(2)
    expect(r.uncovered).toEqual([])
  })

  it('合并稿保留限定条件原文（丢限定 = 得到一条比用户说过的更宽松的规矩）', () => {
    const r = parsePrescreenResult(JSON.stringify([merged(['c1', 'c2'])]), [A, B])
    expect(r.clusters[0]!.body).toContain('严格禁止')
  })

  // 审查 B2：这一档原来只查**来源**的分类，输出分类是模型自由发挥的 ——
  // 而"没有 conflictWith 的批准"走 `save(origin:'user')`，画像来源闸根本不在那条路上。
  it('来源全是 default，模型却把合并稿写成 profile ⇒ 整簇退回', () => {
    const r = parsePrescreenResult(JSON.stringify([merged(['c1', 'c2'], { class: 'profile' })]), [A, B])
    expect(r.clusters).toHaveLength(0)
    expect(r.rejected[0]!.reason).toContain('不许参与合并')
  })

  it('合并稿 class 与来源不一致（两条 default 写成 knowledge）⇒ 退回', () => {
    const r = parsePrescreenResult(JSON.stringify([merged(['c1', 'c2'], { class: 'knowledge' })]), [A, B])
    expect(r.clusters).toHaveLength(0)
    expect(r.rejected[0]!.reason).toContain('class 与来源不一致')
  })

  it('同分类的多条照常采信（上面两条不许把合并本身判死）', () => {
    const r = parsePrescreenResult(JSON.stringify([merged(['c1', 'c2'])]), [A, B])
    expect(r.clusters).toHaveLength(1)
    expect(r.rejected).toEqual([])
  })
})

describe('退回的形状：任何一条不合格 ⇒ 整簇不采信，候选一条不丢', () => {
  const cases: Array<[string, string, unknown, string]> = [
    ['来源不存在', 'ghost', merged(['c99']), '不存在'],
    ['没有来源指针', 'no-sources', merged([]), '没有来源'],
    ['style 参与合并', 'style-merge', merged(['c1', 'c3'], { class: 'style' }), '不许参与合并'],
    ['缺 body', 'no-body', merged(['c1'], { body: '' }), '有缺'],
    ['class 不合法', 'bad-class', merged(['c1'], { class: 'wisdom' }), '不合法'],
    ['来源重复', 'dup-src', merged(['c1', 'c1']), '重复']
  ]
  for (const [title, key, payload, needle] of cases) {
    it(title, () => {
      const r = parsePrescreenResult(JSON.stringify([payload]), ALL)
      expect(r.clusters, key).toHaveLength(0)
      expect(r.rejected[0]!.reason).toContain(needle)
    })
  }

  it('整份不是 JSON ⇒ 全部候选原样退回，不静默消失', () => {
    const r = parsePrescreenResult('我觉得可以这样合并……', ALL)
    expect(r.clusters).toEqual([])
    expect(r.uncovered.map((c) => c.name).sort()).toEqual(['prefers-tables', 'verbatim-raw-output', 'verbatim-raw-stdout'])
    expect(r.rejected[0]!.reason).toContain('JSON')
  })

  it('输出是对象不是数组 ⇒ 同样整份退回', () => {
    const r = parsePrescreenResult(JSON.stringify({ sources: [A.file] }), ALL)
    expect(r.clusters).toEqual([])
    expect(r.uncovered).toHaveLength(3)
  })

  it('模型漏掉某条候选 ⇒ 它出现在 uncovered（不许被"没提到"当成"该消失"）', () => {
    const r = parsePrescreenResult(JSON.stringify([merged(['c1'])]), ALL)
    expect(r.uncovered.map((c) => c.name)).toContain('prefers-tables')
  })

  it('```json 围栏照样能解析（模型常加）', () => {
    const raw = '```json\n' + JSON.stringify([merged(['c1', 'c2'])]) + '\n```'
    expect(parsePrescreenResult(raw, [A, B]).clusters).toHaveLength(1)
  })
})

describe('给模型的东西：只带摘要，正文不出境', () => {
  it('提示里含文件名 / class / name / description，不含任何一条正文', () => {
    const prompt = buildPrescreenPrompt(ALL)
    expect(prompt).toContain('c1')
    expect(prompt).toContain('要求逐字回贴 stdout')
    expect(prompt).not.toContain('这条提案的正文不应出现在给模型的提示里')
  })
})

describe('合并稿正文：附来源清单，仍不附正文', () => {
  it('附录列出被并掉的每条 name + description', () => {
    const r = parsePrescreenResult(JSON.stringify([merged(['c1', 'c2'])]), [A, B])
    const byFile = new Map(ALL.map((c) => [c.file, c]))
    const body = composeMergedBody(r.clusters[0]!, byFile)
    expect(body).toContain('【并自以下提案】')
    expect(body).toContain('verbatim-raw-output')
    expect(body).toContain('verbatim-raw-stdout')
    expect(body).not.toContain('这条提案的正文不应出现在给模型的提示里')
  })
})

describe('system prompt 内容（防悄悄改坏，同 reflection-prompt 的理由）', () => {
  it('保留"限定条件不许丢"与"style / profile 不许合并"两条', () => {
    expect(PRESCREEN_SYSTEM_PROMPT).toContain('限定条件')
    expect(PRESCREEN_SYSTEM_PROMPT).toContain('不许丢')
    expect(PRESCREEN_SYSTEM_PROMPT).toMatch(/style\s*或\s*profile/)
    expect(PRESCREEN_SYSTEM_PROMPT).toContain('不要合并')
  })

  it('禁止新增输入里没有的事实', () => {
    expect(PRESCREEN_SYSTEM_PROMPT).toContain('不许新增')
  })
})

// ── 审查 R-A2：正文上限是**字节**数，按字符截会假通过 ────────────────────────────
describe('合并稿正文按 UTF-8 字节收（R-A2）', () => {
  const byFile = new Map<string, MemoryEntry>([
    ['/mem/notes/candidates/verbatim-raw-output.md', A],
    ['/mem/notes/candidates/verbatim-raw-stdout.md', B]
  ])
  const sources = ['/mem/notes/candidates/verbatim-raw-output.md', '/mem/notes/candidates/verbatim-raw-stdout.md']

  it('中文正文超上限 ⇒ 裁模型那段、**留来源清单**，整份能过校验（不是整条被拒）', () => {
    const out = composeMergedBody(
      { sources, name: 'm', description: '一条合并摘要', class: 'default' as const, body: '要'.repeat(3000) },
      byFile
    )
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MEMORY_LIMITS.maxBodyBytes)
    expect(out).toContain('【并自以下提案】')
    expect(out).toContain('尾部已截断')
    expect(
      validateMemoryFields({ name: 'm', description: '一条合并摘要', body: out }).ok
    ).toBe(true)
  })

  it('没超限时一字不动（截断不许变成常态）', () => {
    const out = composeMergedBody(
      { sources, name: 'm', description: '一条合并摘要', class: 'default' as const, body: '短句。' },
      byFile
    )
    expect(out.startsWith('短句。')).toBe(true)
    expect(out).not.toContain('截断')
  })

  it('fitUtf8Bytes 按码点收，不劈开代理对（半个 surrogate 会让后面整段变乱码）', () => {
    const out = fitUtf8Bytes('😀😀😀', 6)
    expect(out).toBe('😀')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false)
  })
})

  it('来源清单自己就超上限时也只许裁到上限内（末尾那道兜底不是摆设）', () => {
    const many = Array.from({ length: 300 }, (_, i) => `c${i}.md`)
    const bigMap = new Map<string, MemoryEntry>(
      many.map((f) => [
        f,
        { ...A, file: f, name: `n${f}`, description: '一段不短的来源摘要文字，用来把清单本身撑过上限。' }
      ])
    )
    const out = composeMergedBody(
      { sources: many, name: 'm', description: '一条合并摘要', class: 'default' as const, body: '正文。' },
      bigMap
    )
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MEMORY_LIMITS.maxBodyBytes)
  })
