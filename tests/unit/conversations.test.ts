import { describe, expect, it } from 'vitest'
import {
  deriveTitle,
  groupByWorkspace,
  normalizeHistory,
  workspaceLabel
} from '@main/store/conversations-core'
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

  // 这一组钉的是一条**真实的数据丢失渠道**：
  // 渲染端按下发送时会立刻塞一条 `{role:'assistant', content:''}` 的占位（流式往上长），
  // 而落盘校验要求 content ≥1 字符 —— 于是"流式没吐字就切会话 / 点停止 / 关窗口"
  // 保存必然被拒；调用方又是 `void persistActive()`，界面上一个字都没有。
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
})
