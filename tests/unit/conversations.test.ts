import { describe, expect, it } from 'vitest'
import { deriveTitle, groupByWorkspace, workspaceLabel } from '@main/store/conversations-core'
import type { ConversationMeta } from '@shared/ipc'

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
