import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceWriter } from '@main/workspace-write'
import { contentRevision } from '@main/file-revision'
import { createFileTools } from '@main/agent/tools/file-tools'
import { runAgentLoop } from '@main/agent/loop'

const root = mkdtempSync(join(tmpdir(), 'jsll-conflict-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('检查点之后发生外部修改时拒绝提交，保留人工内容', async () => {
  const path = join(root, 'external.txt')
  writeFileSync(path, '初始')
  const writer = createWorkspaceWriter(root, {
    trash: async () => {},
    beforeChange: () => writeFileSync(path, '人工版本')
  })
  await expect(writer.write('external.txt', 'Agent 版本')).rejects.toThrow('文件已变更')
  expect(readFileSync(path, 'utf8')).toBe('人工版本')
})

it('两个服务实例并发写同一版本，只有一个提交成功', async () => {
  writeFileSync(join(root, 'shared.txt'), '初始')
  const a = createWorkspaceWriter(root, { trash: async () => {} })
  const b = createWorkspaceWriter(root, { trash: async () => {} })
  const outcomes = await Promise.allSettled([
    a.write('shared.txt', '甲'), b.write('shared.txt', '乙')
  ])
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1)
})

it('人工改动后整文件写入拒绝旧读取版本，不覆盖也不继续工具链', async () => {
  const path = join(root, 'agent.txt')
  writeFileSync(path, '初始')
  const tools = createFileTools(createWorkspaceWriter(root, { trash: async () => {} }))
  await tools.find((t) => t.schema.name === 'read_file')!.execute({ path: 'agent.txt' })
  writeFileSync(path, '人工内容')
  const chat = async () => ({ text: '', toolCalls: [
    { id: '1', name: 'write_file', arguments: JSON.stringify({ path: 'agent.txt', content: '旧 Agent 内容' }) },
    { id: '2', name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist.txt', content: '错误继续' }) }
  ] })
  await expect(runAgentLoop({ systemPrompt: '测试', history: [], tools, chat,
    maxRounds: 2, contextWindow: 4096 })).rejects.toThrow('文件已变更')
  expect(readFileSync(path, 'utf8')).toBe('人工内容')
})

it('同内容不同保存时间仍以内容版本为准；新建目标不能覆盖后来出现的文件', async () => {
  const writer = createWorkspaceWriter(root, { trash: async () => {} })
  writeFileSync(join(root, 'revision.txt'), '正文')
  await expect(writer.write('revision.txt', '下一版', contentRevision('正文'))).resolves.toContain('已写入')
  writeFileSync(join(root, 'new-target.txt'), '别人的文件')
  await expect(writer.write('new-target.txt', '覆盖', null)).rejects.toThrow('文件已变更')
  expect(readFileSync(join(root, 'new-target.txt'), 'utf8')).toBe('别人的文件')
})

it('联接别名与真实路径共享提交队列，不允许两个版本都覆盖成功', async () => {
  const folder = join(root, 'folder')
  mkdirSync(folder)
  symlinkSync(folder, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(folder, 'same.txt'), '初始')
  const writer = createWorkspaceWriter(root, { trash: async () => {} })
  const results = await Promise.allSettled([
    writer.write('folder/same.txt', '甲'), writer.write('alias/same.txt', '乙')
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
})
