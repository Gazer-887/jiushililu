// Playbook 工具单测（plan19 批 3 接缝 #18）。
// 走内存 backend；与 memory-tools.test.ts 同一形状。

import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@shared/agent'
import { createPlaybookRepo, type PlaybookRepo } from '@main/memory/playbook-core'
import { createPlaybookTools } from '@main/agent/tools/playbook-tools'

const ROOT = '/evo/playbooks'
const FIXED = new Date('2026-09-15T01:30:00.000Z')

function setup() {
  const files = new Map<string, string>()
  const events: string[] = []
  const backend = {
    listFiles: () => [...files.keys()].sort(),
    read: (f: string) => files.get(f) ?? null,
    write: (f: string, t: string) => void files.set(f, t),
    remove: (f: string) => files.delete(f),
    pathFor: (slug: string) => `${ROOT}/${slug}.md`,
    appendEvent: (line: string) => void events.push(line)
  }
  const repo: PlaybookRepo = createPlaybookRepo(backend, {
    now: () => FIXED,
    onWarn: () => {},
    conversationId: () => 'c1'
  })
  const tools = createPlaybookTools({ repo, conversationId: () => 'c1' })
  const byName = (n: string): AgentTool => tools.find((t) => t.schema.name === n)!
  return { repo, events, byName, files }
}

const GOOD = {
  name: 'edit-react-component',
  description: '编辑 React 组件的标准流程',
  tags: ['file-edit', 'react'],
  body: '正文。'
}

describe('save_playbook：写入', () => {
  it('写成 → 明确回话，且事件流有 playbook_write', async () => {
    const { byName, events } = setup()
    const out = await byName('save_playbook').execute(GOOD)
    expect(out).toContain('已保存')
    expect(out).toContain('file-edit')
    expect(JSON.parse(events[0]!).kind).toBe('playbook_write')
  })

  it('凭据进 body → 拒', async () => {
    const { byName } = setup()
    const out = await byName('save_playbook').execute({ ...GOOD, body: '密钥 sk-abcdefghijklmnop' })
    expect(out).toContain('没有写入')
    expect(out).toContain('凭据')
  })

  it('标签为空 → 拒', async () => {
    const { byName } = setup()
    const out = await byName('save_playbook').execute({ ...GOOD, tags: [] })
    expect(out).toContain('没有写入')
  })

  it('撞名 → 拒', async () => {
    const { byName } = setup()
    await byName('save_playbook').execute(GOOD)
    const out = await byName('save_playbook').execute({ ...GOOD, description: '换个说法' })
    expect(out).toContain('没有写入')
    expect(out).toContain('同名')
  })
})

describe('recall_playbook：按标签召回', () => {
  it('命中 → 返回正文', async () => {
    const { byName } = setup()
    await byName('save_playbook').execute(GOOD)
    const out = await byName('recall_playbook').execute({ tags: ['file-edit'] })
    expect(out).toContain('edit-react-component')
    expect(out).toContain('正文。')
  })

  it('不命中 → 提示无匹配', async () => {
    const { byName } = setup()
    await byName('save_playbook').execute(GOOD)
    const out = await byName('recall_playbook').execute({ tags: ['debug'] })
    expect(out).toContain('没有匹配')
  })

  it('空标签 → 提示', async () => {
    const { byName } = setup()
    const out = await byName('recall_playbook').execute({ tags: [] })
    expect(out).toContain('请提供至少一个标签')
  })

  it('召回落 playbook_recall 事件（可观测）', async () => {
    const { byName, events } = setup()
    await byName('save_playbook').execute(GOOD)
    const lenBefore = events.length
    await byName('recall_playbook').execute({ tags: ['file-edit'] })
    expect(events.length).toBe(lenBefore + 1)
    const last = JSON.parse(events[events.length - 1]!)
    expect(last.kind).toBe('playbook_recall')
    expect(last.name).toBe('edit-react-component')
    expect(last.found).toBe(true)
  })
})
