// S147判据12：从真实repo/工具出口断言新日志，只使用合成字符串，不读取真实日志/凭据。
import { describe, expect, it } from 'vitest'
import { createMemoryTools } from '@main/agent/tools/memory-tools'
import { serializeEvent, type MemoryEvent } from '@main/memory/events'
import { createMemoryRepo } from '@main/memory/memory-core'
import { createPlaybookRepo } from '@main/memory/playbook-core'
import { createArchiveMock } from '../helpers/memory-archive-mock'

const MASK = '[已脱敏]'
const STAMP = '2026-10-09T00:00:00.000Z'
const CONVERSATION = '821e6c57-a617-4f01-ae34-d939ff1c0028'
const ENTROPY = 'aB3xK9mQ2pR7tY5wL8nC4vB6dF1gH0jZ'
const ROOT = '/mem/notes'

function setup() {
  const files = new Map<string, string>()
  const lines: string[] = []
  const archive = createArchiveMock({ files, notesRoot: ROOT, archRoot: '/mem/archived' })
  const repo = createMemoryRepo({
    listFiles: () => [...files.keys()],
    listCandidates: () => [],
    candidatePathFor: (slug) => `/mem/candidates/${slug}.md`,
    pathFor: (slug) => `${ROOT}/${slug}.md`,
    write: (file, text) => { files.set(file, text) },
    appendEvent: (line) => { lines.push(line) },
    ...archive.backend
  }, { now: () => new Date(STAMP), conversationId: () => CONVERSATION })
  const recall = createMemoryTools({ repo, conversationId: () => CONVERSATION })
    .find((tool) => tool.schema.name === 'recall')!
  return { repo, recall, lines, files }
}

describe('拒写与未命中原始输入不得成为凭据日志', () => {
  it.each([
    'sk-abcdefghijklmnop',
    'ghp_abcdefghijklmnop',
    'sk-abcdefghijklmnop ghp_zyxwvutsrqponmlk',
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_MATERIAL_NOT_A_KEY\n-----END PRIVATE KEY-----'
  ])('拒写名称整字段净化，覆盖多种形状及PEM正文：%s', (name) => {
    const { repo, lines, files } = setup()
    expect(repo.save({ name, description: '合成资料', class: 'knowledge', origin: 'user', body: '正常正文。' }).ok).toBe(false)
    expect(files.size).toBe(0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'write', name: MASK, rejected: true, conversationId: CONVERSATION, at: STAMP
    })
    expect(lines[0]).not.toContain('SYNTHETIC_PRIVATE_MATERIAL')
  })

  it('recall未命中的混合原始查询净化，但仍记录found:false', async () => {
    const { recall, lines } = setup()
    await recall.execute({ name: '请找 ghp_abcdefghijklmnop 和 sk-zyxwvutsrqponmlk' })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'recall', found: false, name: MASK })
    expect(lines[0]).not.toContain('ghp_')
    expect(lines[0]).not.toContain('sk-')
  })

  it('未经确认的高熵拒写名称与未命中查询也净化', async () => {
    const { repo, recall, lines } = setup()
    const saved = repo.save({ name: ENTROPY, description: '原始长串', class: 'knowledge', origin: 'user', body: '正文。' })
    expect(saved).toMatchObject({ ok: false, needsConfirm: true })
    await recall.execute({ name: ENTROPY })
    expect(lines.map((line) => JSON.parse(line).name)).toEqual([MASK, MASK])
    expect(lines.join('\n')).not.toContain(ENTROPY)
  })
})

describe('公共序列化出口与正常身份兼容', () => {
  it('真实经验手册repo拒写名称也经过净化，不能只验孤立序列化函数', () => {
    const lines: string[] = []
    const files = new Map<string, string>()
    const repo = createPlaybookRepo({
      listFiles: () => [...files.keys()],
      read: (file) => files.get(file) ?? null,
      write: (file, text) => { files.set(file, text) },
      remove: (file) => files.delete(file),
      pathFor: (slug) => `/evo/playbooks/${slug}.md`,
      appendEvent: (line) => { lines.push(line) }
    }, { now: () => new Date(STAMP), conversationId: () => CONVERSATION })
    const saved = repo.save({ name: 'ghp_abcdefghijklmnop', description: '合成手册', tags: ['file-edit'], origin: 'model', body: '普通步骤。' })
    expect(saved.ok).toBe(false)
    expect(files.size).toBe(0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'playbook_write', name: MASK, rejected: true })
  })

  it('固定字段与数组中的硬拒形状一并净化，不修改调用方对象', () => {
    const event: MemoryEvent = {
      kind: 'inject', at: STAMP, conversationId: CONVERSATION,
      names: ['harbor', 'ghp_abcdefghijklmnop', 'sk-zyxwvutsrqponmlk']
    }
    const before = structuredClone(event)
    const output = JSON.parse(serializeEvent(event))
    expect(output).toEqual({ ...event, names: ['harbor', MASK, MASK] })
    expect(event).toEqual(before)
    expect(output.at).toBe(STAMP)
    expect(output.conversationId).toBe(CONVERSATION)
  })

  it('经验手册拒写事件经过同一出口，reason中的硬拒形状也不残留', () => {
    const event: MemoryEvent = {
      kind: 'playbook_write', at: STAMP, conversationId: CONVERSATION,
      name: 'routine', rejected: true, reason: '合成错误 ghp_abcdefghijklmnop sk-zyxwvutsrqponmlk'
    }
    expect(JSON.parse(serializeEvent(event))).toEqual({ ...event, reason: MASK })
  })

  it('用户已确认的高熵合法名称保持精确身份，正常UUID及成功回取不被误净化', async () => {
    const { repo, recall, lines } = setup()
    const saved = repo.save({
      name: ENTROPY, description: '用户确认的合法标识', class: 'knowledge', origin: 'user',
      body: '已确认的普通资料。', confirmed: true
    })
    expect(saved.ok).toBe(true)
    expect(await recall.execute({ name: ENTROPY })).toContain('已确认的普通资料')
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { kind: 'write', name: ENTROPY, conversationId: CONVERSATION },
      { kind: 'recall', name: ENTROPY, found: true, conversationId: CONVERSATION }
    ])
  })

  it('普通无凭据事件仍逐字序列化，正常拒写原因保持', () => {
    const event: MemoryEvent = {
      kind: 'write', at: STAMP, conversationId: CONVERSATION,
      name: 'harbor', rejected: true, reason: '已存在同名条目，请编辑那一条'
    }
    expect(serializeEvent(event)).toBe(JSON.stringify(event))
  })
})
