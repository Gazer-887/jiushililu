import { describe, expect, it } from 'vitest'
import { toolCallDetail } from '@shared/tool-detail'

// 工具调用的「一句人话」（plan7 交互层）：界面显示「read_file · src/main/index.ts」而不是干巴巴的「执行中…」。
// 重点：模型给的 JSON **不可靠** —— 任何解析失败都不能把工具卡片搞崩。

describe('toolCallDetail（工具调用的"一句人话"）', () => {
  it('按工具取最说明问题的那个字段', () => {
    expect(toolCallDetail('read_file', '{"path":"src/main/index.ts"}')).toBe('src/main/index.ts')
    expect(toolCallDetail('run_command', '{"command":"npm run build"}')).toBe('npm run build')
    expect(toolCallDetail('search_files', '{"query":"TODO"}')).toBe('TODO')
    expect(toolCallDetail('browser_navigate', '{"url":"https://example.com"}')).toBe(
      'https://example.com'
    )
  })

  it('未知工具退到"第一个非空字符串值"', () => {
    expect(toolCallDetail('mystery_tool', '{"whatever":"something"}')).toBe('something')
  })

  it('数组参数只说"几项"，不把 JSON 摊到界面上', () => {
    const args = JSON.stringify({
      jobs: [
        { agent: 'reviewer', task: 'x' },
        { agent: 'planner', task: 'y' }
      ]
    })
    const out = toolCallDetail('spawn_agents', args)
    expect(out).toContain('reviewer')
    expect(out).toContain('2 项')
  })

  it('拿不到就返回空串 —— 界面退回"执行中…"，绝不能因为解析失败崩掉', () => {
    expect(toolCallDetail('read_file', '{坏掉的 JSON')).toBe('')
    expect(toolCallDetail('read_file', '')).toBe('')
    expect(toolCallDetail('read_file', 'null')).toBe('')
    expect(toolCallDetail('read_file', '[1,2]')).toBe('')
    expect(toolCallDetail('read_file', '{"path":123}')).toBe('')
  })

  it('超长值截断（界面只显示一行）', () => {
    const out = toolCallDetail('run_command', JSON.stringify({ command: 'x'.repeat(200) }))
    expect(out.length).toBeLessThanOrEqual(81)
    expect(out.endsWith('…')).toBe(true)
  })

  it('多行值折成一行', () => {
    expect(toolCallDetail('run_command', JSON.stringify({ command: 'a\nb' }))).toBe('a b')
  })
})
