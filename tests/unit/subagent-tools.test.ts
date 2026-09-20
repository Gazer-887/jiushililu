// 子代理工具集装配回归（plan51 F1）。
// ⚠️ 判据一律读**模型通道实收的 schema**，不读函数返回值 —— 上一版 `subagentTools = 主代理 tools 减 spawn_agents`
// 就是"返回值看着对、实收不对"，而那形状此前零测试覆盖。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import type { AgentRuntimeContext } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import { createBackgroundTaskStore } from '@main/agent/background-tasks'

const spy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))
vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...a: unknown[]) => spy(...(a as [])),
  chatWithToolsOpenAI: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] })),
  chatWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))

const { runAgent, subagentToolNamesFor } = await import('@main/agent/runner')

const settings: ModelSettings = {
  providerType: 'openai-compatible',
  baseURL: 'https://api.example.com',
  model: 'test-model',
  temperature: null,
  topP: null,
  topK: null,
  maxTokens: 4096,
  timeoutMs: 60000,
  stream: true,
  contextWindow: 131072,
  reasoningEffort: 'default',
  maxToolRounds: 8,
  supportsImages: false
}

function makeCtx(): AgentRuntimeContext {
  const base = mkdtempSync(join(tmpdir(), 'jsl-sub-tools-'))
  const ws = join(base, 'ws')
  mkdirSync(ws, { recursive: true })
  return {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
}

/** 写一个内置 Agent 定义（内置目录 = 生产里随包那批的真实来源） */
function addAgent(ctx: AgentRuntimeContext, name: string, tools: string[], body = '职责占位'): void {
  mkdirSync(ctx.builtinAgentsDir, { recursive: true })
  writeFileSync(
    join(ctx.builtinAgentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} 的描述\ntools: [${tools.join(', ')}]\n---\n${body}`,
    'utf8'
  )
}

function schemasOf(i: number): Array<{ name: string }> {
  return ((spy.mock.calls[i]?.[3] ?? []) as Array<{ name: string }>)
}
const namesOf = (i: number): string[] => schemasOf(i).map((s) => s.name)
const systemOf = (i: number): string =>
  (((spy.mock.calls[i]?.[2] ?? []) as Array<{ role: string; content: string }>).find(
    (m) => m.role === 'system'
  )?.content as string) ?? ''

/** 子代理那一轮的下标（按 `你是子代理「x」` 定位，不靠调用顺序猜） */
function subagentCallIndex(name: string): number {
  const at = spy.mock.calls.findIndex((_, i) => systemOf(i).includes(`你是子代理「${name}」`))
  expect(at, `没有以子代理身份被调用：${name}`).toBeGreaterThanOrEqual(0)
  return at
}

const spawnOnce = (agent: string): void => {
  spy.mockResolvedValueOnce({
    text: '派出去',
    // @ts-expect-error 测试替身：只填本组用例用到的字段
    toolCalls: [{ id: 'j1', name: 'spawn_agents', arguments: JSON.stringify({ jobs: [{ agent, task: '干活' }] }) }]
  })
}

beforeEach(() => spy.mockClear())

describe('① 子代理按自己的 def 装配（plan51 F1）', () => {
  it('声明了 run_command 的 executor 被派发后**实收**含 run_command', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'write_file', 'list_dir', 'search_files', 'run_command'])
    spawnOnce('code-executor')
    spy.mockResolvedValueOnce({ text: '完成', toolCalls: [] })

    // 主会话用默认工具集（本身不含 run_command）—— 差别必须落在子代理身上
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干活' }], permission: 'full-access' })

    expect(namesOf(0)).not.toContain('run_command')
    expect(namesOf(subagentCallIndex('code-executor'))).toContain('run_command')
  })

  it('★ 只收窄不越权：声明只读的 reviewer **拿不到** write_file / edit', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'quality-reviewer', ['read_file', 'list_dir', 'search_files'])
    spawnOnce('quality-reviewer')
    spy.mockResolvedValueOnce({ text: '完成', toolCalls: [] })

    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '审一下' }], permission: 'full-access' })

    const names = namesOf(subagentCallIndex('quality-reviewer'))
    expect(names).toContain('read_file')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('edit')
  })

  it('★ 未声明 tools 的子代理拿**内核默认集**，而不是"主代理那一份"（旧口径只会给主代理的收窄结果）', async () => {
    const ctx = makeCtx()
    // 主会话故意窄：只声明读 + 派发口。旧口径下子代理也只能拿到 read_file；
    // 新口径下它按**自己**的（空）声明走默认集 —— 这才区分得出两种装配。
    mkdirSync(ctx.builtinAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.builtinAgentsDir, 'narrow-main.md'),
      '---\nname: narrow-main\ndescription: 只给读与派发\ntools: [read_file, spawn_agents]\n---\n只管派活。',
      'utf8'
    )
    writeFileSync(
      join(ctx.builtinAgentsDir, 'no-decl.md'),
      '---\nname: no-decl\ndescription: 不声明工具的子代理\n---\n按默认集办事。',
      'utf8'
    )
    spawnOnce('no-decl')

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '干活' }],
      agentName: 'narrow-main',
      permission: 'full-access'
    })

    const main = namesOf(0)
    expect(main).not.toContain('edit') // 主会话确实窄（否则本用例判据不成立）
    const sub = namesOf(subagentCallIndex('no-decl'))
    expect(sub).toContain('edit') // 子代理按自己的声明装配，不受主会话宽窄影响
    expect(sub).not.toContain('spawn_agents')
    expect(sub).not.toContain('run_command') // 默认集不含高危，这一半仍然成立
  })

  it('★ 一次派两个不同 def：各拿各的（证明不是"共用一份"）', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'run_command'])
    addAgent(ctx, 'quality-reviewer', ['read_file'])
    spy.mockResolvedValueOnce({
      text: '两个都派',
      // @ts-expect-error 测试替身
      toolCalls: [
        {
          id: 'j1',
          name: 'spawn_agents',
          arguments: JSON.stringify({
            jobs: [
              { agent: 'code-executor', task: '干活' },
              { agent: 'quality-reviewer', task: '审阅' }
            ]
          })
        }
      ]
    })

    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干活' }], permission: 'full-access' })

    expect(namesOf(subagentCallIndex('code-executor'))).toContain('run_command')
    expect(namesOf(subagentCallIndex('quality-reviewer'))).not.toContain('run_command')
  })

  it('★ 可写档：子代理执行命令**同样过确认桥**（不能借派发绕过授权）', async () => {
    const ctx = makeCtx()
    const asked: string[] = []
    ctx.confirmCommand = async (req) => {
      asked.push(req.detail)
      return false
    }
    addAgent(ctx, 'code-executor', ['read_file', 'run_command'])
    spawnOnce('code-executor')
    spy.mockResolvedValueOnce({
      text: '跑个构建',
      // @ts-expect-error 测试替身
      toolCalls: [{ id: 'r1', name: 'run_command', arguments: JSON.stringify({ command: 'echo JSL_SUB_R5' }) }]
    })
    spy.mockResolvedValueOnce({ text: '好', toolCalls: [] })

    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干活' }] })

    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('JSL_SUB_R5')
  })
})

describe('② 命令组同进同退（plan51 F2，消 check/kill 孤儿）', () => {
  // ⚠️ 必须挂上后台任务存储：`check_command` / `kill_command` 只在有 store 时才进 allTools
  // （system-tools.ts:414）。不挂的话这两条用例测的是"工具压根没造出来"，而不是"该不该下发"。
  it('默认主会话无 run_command ⇒ check_command / kill_command 也不下发', async () => {
    const ctx = makeCtx()
    ctx.background = createBackgroundTaskStore()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }] })

    const names = namesOf(0)
    expect(names).not.toContain('run_command')
    expect(names).not.toContain('check_command')
    expect(names).not.toContain('kill_command')
  })

  it('声明了 run_command ⇒ 自动带上"查"，但**不带**破坏性的"停"（要停得自己声明）', async () => {
    const ctx = makeCtx()
    ctx.background = createBackgroundTaskStore()
    addAgent(ctx, 'bot', ['run_command'])
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'bot',
      permission: 'full-access'
    })

    const names = namesOf(0)
    expect(names).toContain('run_command')
    expect(names).toContain('check_command')
    // 后台任务存储是**应用级单例**（跨会话共享）：白送 kill 等于白送"停别人任务"的能力
    expect(names).not.toContain('kill_command')
  })
})

describe('③ 纪律第 6 条按实收能力给（plan51 F3，消提示词与工具表矛盾）', () => {
  it('无 run_command：不承诺 background=true，但给出可执行出路', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'run_command'])
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }] })

    const system = systemOf(0)
    expect(system).not.toContain('background=true')
    expect(system).toContain('本轮没有命令执行能力')
    expect(system).toContain('spawn_agents')
  })

  it('有 run_command：照旧教它转后台（这条能力在时不该少讲）', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'bot', ['run_command'])
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'bot',
      permission: 'full-access'
    })

    expect(systemOf(0)).toContain('background=true')
  })

  // 编号由位置算出来（取舍后不许断号）—— 断号会让"见第 5 条"这类引用静默失效
  it('★ 编号连续：两条条件规则都在时是 5、6', async () => {
    const ctx = makeCtx()
    // 派发口与命令能力**都要声明**，否则第 5 条整条缺席、命令规则会顶到 5（下面那条用例钉的就是这个）
    addAgent(ctx, 'bot', ['run_command', 'spawn_agents'])
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'bot',
      permission: 'full-access'
    })

    const system = systemOf(0)
    expect(system).toContain('5. **能并行的独立活派给子代理')
    expect(system).toContain('6. **耗时的活转后台')
    expect(system).not.toContain('7. ')
  })

  it('★ 编号连续：只读档没有派发口时，命令规则顶到第 5 条且没有第 6 条', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'run_command'])
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }], permission: 'read-only' })

    const system = systemOf(0)
    expect(system).not.toContain('5. **能并行的独立活派给子代理')
    expect(system).toContain('5. **本轮没有命令执行能力')
    expect(system).not.toContain('6. ')
  })
})

describe('④ 自视段如实报缺口（plan51 F4）', () => {
  it('缺 run_command 且有可派 executor ⇒ 写清"缺什么 + 谁能给"', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'run_command'])
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }] })

    const system = systemOf(0)
    expect(system).toMatch(/缺[^\n]*run_command/)
    expect(system).toContain('code-executor')
  })

  it('★ 无缺口时**零输出**（不许写"规划中"的噪音）', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'bot', ['run_command'])
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'bot',
      permission: 'full-access'
    })

    expect(systemOf(0)).not.toMatch(/缺[^\n]*run_command/)
  })

  it('拿不到派发口（无可派 Agent）时不谎称"派子代理即可"', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }] })

    const system = systemOf(0)
    // 没有出口 ⇒ 自视段不报缺口行（约束②：不许写拿不到的承诺）
    expect(system).not.toMatch(/缺能力/)
    // 而纪律那条走"未能验证"分支，而不是"派给子代理"分支
    expect(system).toContain('也没有可派发的子代理')
    expect(system).not.toContain('用 spawn_agents 派给声明了该工具的子代理')
  })
})

// 纯函数层：硬上限这条**只能在这里测**——只读档下主会话连 spawn_agents 都没有（它不在
// READ_ONLY_TOOLS），整条子代理线不存在，走集成路径测不到"上限"而只测到"没派发口"。
describe('⑤ subagentToolNamesFor：按各自声明装配 + 权限档仍是硬上限', () => {
  const ALL = [
    'read_file',
    'write_file',
    'edit',
    'list_dir',
    'search_files',
    'run_command',
    'check_command',
    'kill_command',
    'update_todos',
    'spawn_agents'
  ]

  it('只读档：声明了 run_command 也进不来', () => {
    expect(subagentToolNamesFor('read-only', ['read_file', 'run_command'], ALL)).not.toContain('run_command')
  })

  it('可写档：声明了就给（与主代理同一口径，差别只在要不要逐次确认）', () => {
    const names = subagentToolNamesFor('write', ['read_file', 'run_command'], ALL)
    expect(names).toContain('run_command')
    // 没声明的照旧没有 —— 证明这条线是"按声明装配"，不是"干脆全给"
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('edit')
  })

  it('★ 永不带 spawn_agents（它拿不到派发口，递归派生会把成本放大）', () => {
    expect(subagentToolNamesFor('full-access', undefined, ALL)).not.toContain('spawn_agents')
    expect(subagentToolNamesFor('full-access', ['spawn_agents', 'read_file'], ALL)).not.toContain('spawn_agents')
  })

  it('未声明 tools 的子代理退回内核默认集（同样不含高危）', () => {
    const names = subagentToolNamesFor('write', undefined, ALL)
    expect(names).toContain('read_file')
    expect(names).not.toContain('run_command')
  })

  it('声明了不存在的工具名被丢掉（与主代理同口径）', () => {
    expect(subagentToolNamesFor('full-access', ['read_file', 'teleport'], ALL)).toEqual(['read_file'])
  })

  it('命令组：声明 run_command ⇒ 只自动补"查"；"停"必须自己声明；单独声明 check ⇒ 丢掉', () => {
    expect(subagentToolNamesFor('full-access', ['run_command'], ALL)).toEqual(['run_command', 'check_command'])
    expect(subagentToolNamesFor('full-access', ['run_command', 'kill_command'], ALL)).toEqual([
      'run_command',
      'kill_command',
      'check_command'
    ])
    expect(subagentToolNamesFor('full-access', ['read_file', 'check_command', 'kill_command'], ALL)).toEqual([
      'read_file'
    ])
  })
})

// 子代理现在"按自己的声明装配"，于是派发口成了一条**能力获取途径**。带计划批准闸的 Agent
// 若还留着派发口，就能在批准卡弹出之前经子代理把写操作落盘 —— plan27 整条保证当场失效。
// 这条不变量必须结构性钉住，不能靠"当前内置 planner 恰好没声明 spawn_agents"（批判复查 P0-2）。
describe('⑥ 带批准闸的 Agent 不许有派发口', () => {
  it('planner 显式声明了 spawn_agents，实收仍拿不到', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.builtinAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.builtinAgentsDir, 't-planner.md'),
      '---\nname: t-planner\ndescription: 规划员\napproval: plan\nexecutor: code-executor\ntools: [read_file, spawn_agents]\n---\n只给方案，不动手。',
      'utf8'
    )
    addAgent(ctx, 'code-executor', ['read_file', 'write_file', 'run_command'])

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '给个方案' }],
      agentName: 't-planner',
      permission: 'full-access'
    })

    expect(namesOf(0)).toContain('read_file')
    expect(namesOf(0)).not.toContain('spawn_agents')
  })
})

// 子代理现在真拿得到 write_file / run_command，而它读的正是构建日志与命令输出。
// 防注入基线原先只在主代理的 guardedSystem 里，子代理那份 system prompt 一个字都没有。
describe('⑦ 子代理同样吃到防注入基线（批判复查 N-1）', () => {
  it('子代理的 system prompt 含"安全基线"', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'write_file', 'run_command'])
    spawnOnce('code-executor')

    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干活' }], permission: 'full-access' })

    expect(systemOf(subagentCallIndex('code-executor'))).toContain('安全基线')
  })
})
