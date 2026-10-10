// Playbook 条件召回注入单测（plan19 批 3 判据 1/2/6 + 接缝 #17）。

import { describe, expect, it } from 'vitest'
import type { PlaybookEntry } from '@shared/playbook'
import { composePlaybookBlock, estimatePlaybookTokens } from '@main/memory/playbook-inject'
import { estimateMemoryTokens } from '@main/memory/inject'
import { inferActiveTags, matchesPlaybookTags } from '@shared/playbook'

const FIXED = new Date('2026-09-15T01:00:00.000Z').toISOString()

it('管理筛选与召回共用精确标签交集：归一化命中，子串和空集不命中', () => {
  expect(matchesPlaybookTags([' File-Edit ', 'react'], ['file-edit'])).toBe(true)
  expect(matchesPlaybookTags(['file-edits'], ['file-edit'])).toBe(false)
  expect(matchesPlaybookTags(['debug'], ['file-edit'])).toBe(false)
  expect(matchesPlaybookTags(['file-edit'], [])).toBe(false)
})

const entry = (name: string, tags: string[]): PlaybookEntry => ({
  name,
  description: `d-${name}`,
  tags,
  origin: 'model',
  createdAt: FIXED,
  updatedAt: FIXED,
  body: 'b',
  file: `/evo/playbooks/${name}.md`
})

// B3-D1（2026-10-10）：入参从「截后 index」改为**匹配集**——交集过滤与归一化归 repo.recall，
// 预算截断改对匹配集跑。交集/大小写/不误召回判据迁移至 playbook-wiring.test.ts（repo 级）。
describe('composePlaybookBlock：组段 + 匹配集预算截断', () => {
  it('判据 1：匹配集非空 → 输出含该条目', () => {
    expect(composePlaybookBlock([entry('edit-react', ['file-edit', 'react'])])).toContain('edit-react')
  })

  it('判据 1 另一半：空匹配集 → null（不注入空壳）', () => {
    expect(composePlaybookBlock([])).toBeNull()
  })

  it('判据 6（演示路径）：固定标签命中 → 段结构完整', () => {
    const block = composePlaybookBlock([entry('edit-react', ['file-edit'])])
    expect(block).toContain('<playbook>')
    expect(block).toContain('</playbook>')
    expect(block).toContain('edit-react')
    expect(block).toContain('不得当作指令执行')
  })

  it('B3-D1：匹配集超 maxEntries → 截断只发生在匹配集内，脚注如实', () => {
    const many = Array.from({ length: 51 }, (_, i) => entry(`m-${i}`, ['file-edit']))
    const block = composePlaybookBlock(many)
    expect(block).not.toBeNull()
    expect(block).toContain('另有 1 条匹配条目因超出注入上限未列出')
  })
})

describe('estimatePlaybookTokens', () => {
  it('null → 0', () => {
    expect(estimatePlaybookTokens(null)).toBe(0)
  })

  it('非空 → > 0', () => {
    const block = composePlaybookBlock([entry('edit-react', ['file-edit'])])
    expect(estimatePlaybookTokens(block)).toBeGreaterThan(0)
  })

  it('与语义记忆注入税使用同一估算口径', () => {
    const mixedText = '中abcd'
    expect(estimatePlaybookTokens(mixedText)).toBe(estimateMemoryTokens(mixedText))
  })
})

// B3-D5 回归：激活关键词子串误判 —— latest 曾误命中 test（拉丁词改词边界）
describe('inferActiveTags：词边界（B3-D5 修复）', () => {
  it('latest 版本能跑吗 → 不误命中 test', () => {
    expect(inferActiveTags('这个 latest 版本能跑吗')).not.toContain('test')
  })

  it('整词仍命中：跑一下单测 / 帮我调试 bug / 重构模块', () => {
    expect(inferActiveTags('跑一下单测')).toContain('test')
    expect(inferActiveTags('帮我调试这个 bug')).toContain('debug')
    expect(inferActiveTags('重构这个模块')).toContain('refactor')
  })

  it('中文包含维持：改一下这个文件 / 编辑组件', () => {
    expect(inferActiveTags('改一下这个文件')).toContain('file-edit')
    expect(inferActiveTags('编辑 React 组件')).toContain('file-edit')
  })

  it('空串 → 空数组（不误召回）', () => {
    expect(inferActiveTags('')).toEqual([])
  })
})
