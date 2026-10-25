import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkspaceWriter } from '../../src/main/workspace-write'
import { createFileTools } from '../../src/main/agent/tools/file-tools'
import { runAgentLoop } from '../../src/main/agent/loop'
import { storedMessagesSchema } from '../../src/main/schemas'
import type { ToolEvent } from '../../src/shared/agent'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('产物只来自真实成功写入', () => {
  it('write_file/edit成功后给文件卡，start/失败/无变化均不冒称产出，重启载体保留路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsl-artifact-success-')); roots.push(root)
    const tools = createFileTools(createWorkspaceWriter(root, { trash: async () => {} }))
    const events: ToolEvent[] = []
    const steps = [
      { name: 'write_file', args: { path: 'made.txt', content: 'BEFORE_EDIT_SENTINEL' } },
      { name: 'edit', args: { path: 'made.txt', edits: [{ oldText: 'BEFORE_EDIT_SENTINEL', newText: 'AFTER_EDIT_SENTINEL' }] } },
      { name: 'edit', args: { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] } },
      { name: 'edit', args: { path: 'made.txt', edits: [{ oldText: 'AFTER_EDIT_SENTINEL', newText: 'AFTER_EDIT_SENTINEL' }] } },
      { name: 'write_file', args: { path: '../rejected.txt', content: 'NO_WRITE' } }
    ]
    let step = 0
    await runAgentLoop({ systemPrompt: 'fixture', history: [{ role: 'user', content: 'make and edit' }], tools, onToolEvent: event => events.push(event),
      chat: async () => {
        const next = steps[step++]
        return next ? { text: null, toolCalls: [{ id: `tool-${step}`, name: next.name, arguments: JSON.stringify(next.args) }] } : { text: 'done', toolCalls: [] }
      } })
    expect(readFileSync(join(root, 'made.txt'), 'utf8')).toBe('AFTER_EDIT_SENTINEL')
    expect(events.filter(e => e.phase === 'start').every(e => !e.artifactPaths?.length)).toBe(true)
    expect(events.filter(e => e.artifactPaths?.length)).toMatchObject([
      { id: 'tool-1', phase: 'end', artifactPaths: ['made.txt'] },
      { id: 'tool-2', phase: 'end', artifactPaths: ['made.txt'] }
    ])
    const parsed = storedMessagesSchema.parse([{ role: 'assistant', content: 'done', segments: events.filter(e => e.phase !== 'start').map(event => ({ kind: 'tool', event })) }])
    expect(parsed[0].segments?.filter(s => s.kind === 'tool' && s.event.artifactPaths?.length)).toHaveLength(2)
  })
})
