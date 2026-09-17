import { describe, expect, it } from 'vitest'
import {
  deriveTitle,
  fitStoredBudget,
  groupByWorkspace,
  normalizeHistory,
  workspaceLabel
} from '@main/store/conversations-core'
import { chatMessagesSchema, storedMessagesSchema } from '@main/schemas'
import type { ChatMessage, ConversationMeta } from '@shared/ipc'

function meta(over: Partial<ConversationMeta> & { id: string }): ConversationMeta {
  return {
    title: 't',
    workspace: 'D:/ws',
    model: 'm',
    skills: [],
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    ...over
  }
}

describe('deriveTitle（会话标题推导）', () => {
  it('取首个非空行，去掉 Markdown 标记', () => {
    expect(deriveTitle('## 帮我写个脚本\n后面还有')).toBe('帮我写个脚本')
    expect(deriveTitle('\n\n**加粗**的标题')).toBe('加粗的标题')
    expect(deriveTitle('见 [文档](https://x.com) 说明')).toBe('见 文档 说明')
  })

  it('超长截断到 24 字并加省略号', () => {
    const long = '一'.repeat(40)
    const title = deriveTitle(long)
    expect(title.length).toBe(25) // 24 + …
    expect(title.endsWith('…')).toBe(true)
  })

  it('空输入回退默认标题', () => {
    expect(deriveTitle('')).toBe('新对话')
    expect(deriveTitle(undefined)).toBe('新对话')
    expect(deriveTitle('   \n  ')).toBe('新对话')
  })
})

describe('workspaceLabel（工作区展示名）', () => {
  it('取路径末段，兼容反斜杠与结尾斜杠', () => {
    expect(workspaceLabel('D:\\jsllworkplace_for_test')).toBe('jsllworkplace_for_test')
    expect(workspaceLabel('D:/a/b/')).toBe('b')
    expect(workspaceLabel('C:\\Users\\Gazer\\proj')).toBe('proj')
  })
})

describe('groupByWorkspace（按工作区分组）', () => {
  it('同工作区归一组，组内按更新时间倒序', () => {
    const groups = groupByWorkspace([
      meta({ id: 'a', workspace: 'D:/w1', updatedAt: 100 }),
      meta({ id: 'b', workspace: 'D:/w1', updatedAt: 300 }),
      meta({ id: 'c', workspace: 'D:/w2', updatedAt: 200 })
    ])
    expect(groups).toHaveLength(2)
    const g1 = groups.find((g) => g.workspace === 'D:/w1')!
    expect(g1.items.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('组间按各自最新时间倒序（最近用过的排最上面）', () => {
    const groups = groupByWorkspace([
      meta({ id: 'a', workspace: 'D:/old', updatedAt: 100 }),
      meta({ id: 'b', workspace: 'D:/new', updatedAt: 500 })
    ])
    expect(groups.map((g) => g.label)).toEqual(['new', 'old'])
  })

  it('空列表返回空数组', () => {
    expect(groupByWorkspace([])).toEqual([])
  })
})

describe('normalizeHistory（存盘前的消息规整）', () => {
  const u = (content: string): ChatMessage => ({ role: 'user', content })
  const a = (content: string): ChatMessage => ({ role: 'assistant', content })

  // 这一组钉的是一条**真实的数据丢失渠道**：流式占位（content:''）过不了落盘校验，
  // "没吐字就切会话 / 点停止 / 关窗口"会让整次保存被拒 —— 而调用方是 `void persistActive()`，界面一个字都不提示。
  it('丢掉末尾的"流式占位"（这条以前会让整次保存被拒）', () => {
    const out = normalizeHistory([u('你好'), a('你好，'), a('')])
    expect(out).toHaveLength(2)
    expect(out[1]!.content).toBe('你好，')
  })

  it('中间的空消息也丢掉（空 content 本来就违反契约）', () => {
    const out = normalizeHistory([u('一'), a(''), u('二')])
    expect(out.map((m) => m.content)).toEqual(['一', '二'])
  })

  it('纯空白也算空（发模型那条路早就用 trim 判了，两边口径必须一致）', () => {
    expect(normalizeHistory([u('一'), a('   \n  ')])).toHaveLength(1)
  })

  it('全是空 → 空数组（调用方据此跳过保存，而不是报错）', () => {
    expect(normalizeHistory([a('')])).toEqual([])
    expect(normalizeHistory([])).toEqual([])
  })

  it('正常消息**原样保留、顺序不变**（规整不许动有效数据）', () => {
    const list = [u('一'), a('二'), u('三'), a('四')]
    expect(normalizeHistory(list)).toEqual(list)
  })

  // ── plan36 S1：分段让"空正文的中间轮次"成为合法状态 ──
  const segTool = { kind: 'tool' as const, event: { id: 't1', name: 'fetch_url', phase: 'end' as const } }

  it('空 content 但带分段的 assistant **保留**（丢了回滚索引就错位）', () => {
    const withSeg: ChatMessage = { role: 'assistant', content: '', segments: [segTool] }
    const out = normalizeHistory([u('一'), withSeg, a('收尾')])
    expect(out).toHaveLength(3)
    expect(out[1]!.segments).toHaveLength(1)
  })

  it('空 content 且**无**分段仍被丢（旧语义不变）', () => {
    expect(normalizeHistory([u('一'), a('')])).toHaveLength(1)
  })
})

describe('fitStoredBudget（plan36 坑 4：超预算丢分段保正文）', () => {
  const big = (n: number): string => 'x'.repeat(n)
  const withSeg = (content: string): ChatMessage => ({
    role: 'assistant',
    content,
    segments: [{ kind: 'thinking', text: big(1000) }]
  })

  it('预算内 → 原样返回 stripped=0', () => {
    const list = [withSeg('a'), withSeg('b')]
    const out = fitStoredBudget(list, 100_000)
    expect(out.stripped).toBe(0)
    expect(out.messages[0]!.segments).toBeDefined()
  })

  it('超预算 → 从最老开始丢分段，正文一条不丢', () => {
    const list = [withSeg(big(500)), withSeg(big(500)), withSeg(big(500))]
    const out = fitStoredBudget(list, 1600)
    expect(out.stripped).toBeGreaterThan(0)
    expect(out.messages.every((m) => m.content.length === 500)).toBe(true)
    expect(out.messages.filter((m) => m.segments).length).toBeLessThan(3)
  })

  it('正文本身就超 → 丢光分段仍原样返回（交给 strict 审整条拒，不静默裁正文）', () => {
    const list: ChatMessage[] = [
      { role: 'assistant', content: big(5000), segments: [{ kind: 'text', text: 'seg' }] }
    ]
    const out = fitStoredBudget(list, 1000)
    expect(out.stripped).toBe(1)
    expect(out.messages[0]!.content.length).toBe(5000)
  })

  it('★ 预算降级的产出**必须仍然过落盘校验**（空正文 + 分段的轮次不得被降级成非法）', () => {
    // plan36 坑 3 的延伸：中间轮"只有思考/工具没有正文"的消息，靠 segments 撑着才合法
    // （storedMessagesSchema 允许「空 content + 非空 segments」）。若预算降级把它的 segments 删掉，
    // 它就变成「空 content + 无 segments」= 非法 → 落盘**整批被拒**（ipc.ts:930 的调用方），用户消息全丢。
    const list: ChatMessage[] = [
      { role: 'assistant', content: '', segments: [{ kind: 'thinking', text: big(3000) }] },
      { role: 'assistant', content: big(50), segments: [{ kind: 'thinking', text: big(3000) }] }
    ]
    const out = fitStoredBudget(list, 500)
    const parsed = storedMessagesSchema.safeParse(out.messages)
    expect(parsed.success).toBe(true)
  })
})

describe('storedMessagesSchema · 分段校验（plan36 双 schema）', () => {
  it('assistant 空 content + 合法分段 → 过审', () => {
    const ok = storedMessagesSchema.safeParse([
      { role: 'assistant', content: '', segments: [{ kind: 'tool', event: { id: 't1', name: 'list_dir', phase: 'end' } }] }
    ])
    expect(ok.success).toBe(true)
  })

  it('user 带分段 → 拒（分段只属于 assistant）', () => {
    const bad = storedMessagesSchema.safeParse([
      { role: 'user', content: 'hi', segments: [{ kind: 'text', text: 'x' }] }
    ])
    expect(bad.success).toBe(false)
  })

  it('tool 段缺 event / text 段缺 text → 拒', () => {
    expect(storedMessagesSchema.safeParse([{ role: 'assistant', content: '', segments: [{ kind: 'tool' }] }]).success).toBe(false)
    expect(storedMessagesSchema.safeParse([{ role: 'assistant', content: '', segments: [{ kind: 'text' }] }]).success).toBe(false)
  })

  it('★ 模型侧 chatMessagesSchema **必须剥掉 segments**（分段不出境，审查坑 2）', () => {
    const parsed = chatMessagesSchema.parse([
      { role: 'assistant', content: 'hi', segments: [{ kind: 'text', text: 'hi' }] }
    ])
    expect('segments' in (parsed[0] as object)).toBe(false)
  })
})
