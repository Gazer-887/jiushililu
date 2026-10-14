// 修正批 · 子代理 job 域（C 组：按实际 job 装配父子独立浏览器上下文）
//
// 来源：独审端 runner 反例 4（真实派发两子代理，createTask 只观察到 1 次）。
// 本文件走 **runAgent → spawn_agents → scheduler 真实派发**（不人为构造 adapter），
// 断言父与两个子任务、以及**同角色两个并发 job** 各自拥有独立的浏览器任务上下文与授权状态；
// 并用交错导航 + 定向拒绝验证许可互不串。仅替换模型与浏览器外设，runner/scheduler/工具为生产实现。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelSettings } from '@shared/ipc'

const stub = vi.hoisted(() => ({ chat: vi.fn() }))
vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: any[]) => stub.chat(...args),
  chatWithToolsOpenAI: (...args: any[]) => stub.chat(...args)
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: (...args: any[]) => stub.chat(...args),
  chatWithToolsAnthropic: (...args: any[]) => stub.chat(...args)
}))

import { runAgent } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import { setBrowserAdapter, type BrowserAdapter, type BrowserTaskContext } from '@main/agent/browser-bridge'
import { TaskAuthorizer } from '@main/browser-policy'

const settings = {
  providerType: 'openai-compatible', baseURL: 'http://never-used.invalid', model: 'local-fake',
  temperature: null, topP: null, topK: null, maxTokens: 4096, timeoutMs: 30000, stream: true,
  contextWindow: 131072, reasoningEffort: 'default', maxToolRounds: 8, inputModalities: ['text']
} as ModelSettings
const done = { text: '完成', toolCalls: [] }
const call = (name: string, args: unknown) => ({ text: '', toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }] })
const toolNamesIn = (messages: Array<{ role: string; content: unknown }>): string[] =>
  messages
    .filter((m) => m.role === 'tool')
    .map((m) => /<tool_output name="([^"]+)"/.exec(String(m.content))?.[1] ?? '')

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-nb-job-'))
  const ws = join(dir, 'ws')
  const agents = join(dir, 'agents')
  mkdirSync(ws)
  mkdirSync(agents)
  const confirms: any[] = []
  const creations: Array<BrowserTaskContext | undefined> = []
  const effects: any[] = []
  const ctx: any = {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: agents,
    userAgentsDir: join(dir, 'user'),
    checkpoints: createCheckpointStore(join(dir, 'checkpoints')),
    // 定向拒绝：a.test 的站点授权被拒（用于验证拒绝不跨 job 串）
    confirmCommand: async (req: any) => { confirms.push(req); return !String(req.where).includes('a.test') }
  }
  // 只替换浏览器外设：真实 createBrowserTools → createTask → TaskAuthorizer 走生产实现
  const fakeBase: any = { currentUrl: () => 'http://127.0.0.1:8111/form', assertReady: () => {} }
  fakeBase.createTask = (_signal: any, task?: BrowserTaskContext) => {
    creations.push(task)
    const auth = new TaskAuthorizer(task?.confirm ?? null)
    return {
      ...fakeBase,
      createTask: undefined,
      navigate: async (url: string) => {
        const r = await auth.authorize({ tool: 'browser_navigate', args: { url }, agent: task?.agent ?? '', site: new URL(url).origin })
        if (!r.allowed) throw new Error(r.reason)
        effects.push({ navigate: url, agent: task?.agent })
        return { url, title: '本地页' }
      },
      readPage: async () => '本地页'
    }
  }
  setBrowserAdapter(fakeBase as BrowserAdapter)
  return { dir, ctx, confirms, creations, effects, agents }
}

beforeEach(() => { stub.chat.mockReset() })

describe('C · 父子独立（独审 runner 反例 4 等价迁移）', () => {
  it('父 + 两个子代理各建独立任务上下文；父与子、子与子互不共用', async () => {
    const f = makeFixture()
    writeFileSync(join(f.agents, 'parent.md'), '---\nname: parent\ndescription: 派发\ntools: [spawn_agents]\n---\nPARENT_MARKER')
    for (const name of ['child-a', 'child-b']) {
      writeFileSync(join(f.agents, `${name}.md`), `---\nname: ${name}\ndescription: 独立子任务\ntools: [read_file]\n---\nCHILD_MARKER ${name}`)
    }
    stub.chat.mockImplementation(async (_s: any, _k: any, messages: any[]) => {
      const system = String(messages[0].content)
      if (system.includes('PARENT_MARKER')) return done
      if (system.includes('CHILD_MARKER child-a')) return call('browser_navigate', { url: 'http://a.test/x' })
      if (system.includes('CHILD_MARKER child-b')) return call('browser_navigate', { url: 'http://b.test/x' })
      return done
    })
    // 父派发一次：两个子代理各自导航到不同站点（a.test 会被定向拒绝）
    stub.chat.mockImplementationOnce(async () =>
      call('spawn_agents', { jobs: [{ agent: 'child-a', task: '去 a' }, { agent: 'child-b', task: '去 b' }] })
    )
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', agentName: 'parent', permission: 'write',
      nativeBrowser: true, history: [{ role: 'user', content: '把两个独立任务分别交给两个子代理' }]
    })

    // 父 + 两子 = 3 个任务上下文，且对象身份互异（不是同一个被复用）
    expect(f.creations.length, '父与两个子任务必须各建任务').toBeGreaterThanOrEqual(3)
    expect(new Set(f.creations).size, '不得复用同一可变上下文对象').toBe(f.creations.length)
    const agents = f.creations.map((c) => c?.agent)
    expect(agents).toContain('parent')
    expect(agents).toContain('child-a')
    expect(agents).toContain('child-b')

    // 确认卡按实际发起者署名；a.test 被拒不影响 b.test（授权状态互不串）
    const byWhere = (s: string): any[] => f.confirms.filter((c) => String(c.where).includes(s))
    expect(byWhere('a.test')[0]?.agent, 'a 的卡署 a 的名').toBe('child-a')
    expect(byWhere('b.test')[0]?.agent, 'b 的卡署 b 的名').toBe('child-b')
    expect(f.effects.map((e) => e.navigate), 'b 被放行、a 被拒').toContain('http://b.test/x')
    expect(f.effects.map((e) => e.navigate)).not.toContain('http://a.test/x')
  })

  it('同角色两个并发 job 也各建自己的上下文（不按角色名缓存）', async () => {
    const f = makeFixture()
    writeFileSync(join(f.agents, 'parent.md'), '---\nname: parent\ndescription: 派发\ntools: [spawn_agents]\n---\nPARENT_MARKER')
    writeFileSync(join(f.agents, 'worker.md'), '---\nname: worker\ndescription: 同角色两个 job\ntools: [read_file]\n---\nWORKER_MARKER')
    let parentCalls = 0
    stub.chat.mockImplementation(async (_s: any, _k: any, messages: any[]) => {
      const system = String(messages[0].content)
      if (system.includes('PARENT_MARKER')) {
        parentCalls += 1
        return parentCalls === 1 ? call('spawn_agents', { jobs: [{ agent: 'worker', task: '任务一' }, { agent: 'worker', task: '任务二' }] }) : done
      }
      if (system.includes('WORKER_MARKER')) return call('browser_navigate', { url: 'http://b.test/x' })
      return done
    })
    await runAgent(f.ctx, {
      settings, apiKey: 'synthetic', conversationId: 'review', agentName: 'parent', permission: 'write',
      nativeBrowser: true, history: [{ role: 'user', content: '两个同角色子任务' }]
    })
    const workers = f.creations.filter((c) => c?.agent === 'worker')
    // 恰好 2 个（若 chatFactory 再求值一次 toolsFor，这里会变成 4 —— 同源装配的回归判据）
    expect(workers, '两个 worker 各一份，且无重复求值漂移').toHaveLength(2)
    expect(new Set(workers).size, '两个 worker 的对象身份互异').toBe(2)
  })
})
