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
/**
 * 取出「做事纪律」的编号序列。判的是**连续性**（不许断号），不是"某条必须落在第几"——
 * 后者会在每加一条固定纪律时红一次，而那条改动本身没错。
 */
function conductNumbers(system: string): number[] {
  const at = system.indexOf('**做事纪律（必须遵守）**：')
  if (at < 0) return []
  // 纪律块内部只用换行分行，段与段之间才是空行（见 runner 的 guardedSystem 拼装）
  const block = system.slice(at).split('\n\n')[0]
  return [...block.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
}
const isContiguous = (ns: number[]): boolean => ns.length > 0 && ns.every((n, i) => n === i + 1)

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

beforeEach(() => {
  // ⚠️ 必须 mockReset 再设默认实现：只 mockClear 会**留下上一个用例的 mockImplementation**，
  // 于是那条实现被后面每个用例继承（本文件踩过：⑧ 的实现漏进 ⑨，报 messages undefined）。
  spy.mockReset()
  spy.mockImplementation(async () => ({ text: '完成', toolCalls: [] }))
})

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

describe('③ 命令规则按实收能力给（plan51 F3，消提示词与工具表矛盾）', () => {
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

  // 编号由位置算出来 ⇒ 判"连续"，不判"某条必须在第几"（加一条固定纪律就该红是假红）
  it('★ 编号连续：派发规则与命令规则都在时，纪律一条不缺、号不跳', async () => {
    const ctx = makeCtx()
    // 派发口与命令能力**都要声明**，否则派发规则整条缺席、命令规则会往前顶
    addAgent(ctx, 'bot', ['run_command', 'spawn_agents'])
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'bot',
      permission: 'full-access'
    })

    const system = systemOf(0)
    expect(isContiguous(conductNumbers(system))).toBe(true)
    expect(conductNumbers(system)).toHaveLength(7)
    expect(system).toContain('**能并行的独立活派给子代理')
    expect(system).toContain('**耗时的活转后台')
  })

  it('★ 编号连续：只读档没有派发口时，命令规则顶上来了且不留空洞', async () => {
    const ctx = makeCtx()
    addAgent(ctx, 'code-executor', ['read_file', 'run_command'])
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }], permission: 'read-only' })

    const system = systemOf(0)
    expect(isContiguous(conductNumbers(system))).toBe(true)
    expect(conductNumbers(system)).toHaveLength(6)
    expect(system).not.toContain('**能并行的独立活派给子代理')
    expect(system).toContain('**本轮没有命令执行能力')
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

// 确认卡上那行「发起：xxx」是用户点"允许这一次"时唯一的判断依据。
// 旧实现里 `agentLabel` 在建工具实例时定格为主代理的名字，子代理复用同一批实例
// ⇒ 并发派发时几张卡都写着主代理，用户在**错信息**下放行（K5）。
describe('⑧ 确认卡必须说清是谁要跑这条命令', () => {
  it('两个子代理各自要跑命令 ⇒ 两张卡的「发起」分别是它们自己的名字', async () => {
    const ctx = makeCtx()
    const asked: Array<{ agent?: string; detail: string }> = []
    ctx.confirmCommand = async (req) => {
      asked.push({ agent: req.agent, detail: req.detail })
      return false
    }
    addAgent(ctx, 'k5-a', ['read_file', 'run_command'])
    addAgent(ctx, 'k5-b', ['read_file', 'run_command'])
    const turns = new Map<string, number>()
    spy.mockImplementation(async (_m: unknown, _k: unknown, messages: Array<{ role: string; content?: string }>) => {
      const sys = messages.find((x) => x.role === 'system')?.content ?? ''
      const who = /你是子代理「([^」]+)」/.exec(sys)?.[1] ?? 'main'
      const t = (turns.get(who) ?? 0) + 1
      turns.set(who, t)
      if (t > 1) return { text: '完成', toolCalls: [] }
      if (who === 'main') {
        return {
          text: '两个都派',
          // @ts-expect-error 测试替身
          toolCalls: [
            {
              id: 'j1',
              name: 'spawn_agents',
              arguments: JSON.stringify({
                jobs: [
                  { agent: 'k5-a', task: '干活' },
                  { agent: 'k5-b', task: '干活' }
                ]
              })
            }
          ]
        }
      }
      return {
        text: '跑一条',
        // @ts-expect-error 测试替身
        toolCalls: [{ id: 'r-' + who, name: 'run_command', arguments: JSON.stringify({ command: `echo MARK_${who}` }) }]
      }
    })

    // 可写档：这一档才会注入确认桥（完全访问档不弹卡，是用户明确选的"别拦我"）
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干活' }] })

    // 断**标签 ↔ 命令的配对**，不只断标签集合：串了名（A 的卡写着 B 的名字）也要能红
    const byAgent = Object.fromEntries(asked.map((a) => [a.agent ?? '(空)', (a.detail.match(/MARK_\S+/) ?? [''])[0]]))
    expect(byAgent).toEqual({ 'k5-a': 'MARK_k5-a', 'k5-b': 'MARK_k5-b' })
    // 主代理的名字不许出现在子代理发起的卡上
    expect(asked.some((a) => a.agent === '内核默认')).toBe(false)
  })
})

// K3：自检/验收里"跳过"不得被算进"全部通过"——0.13.77 真机实测里，被测 Agent 生成的自检
// 把一项未验证的能力计入通过并给出 exit=0，任何自动化流程都会把它当绿灯放行。
describe('⑨ 纪律里写明"跳过 ≠ 通过"', () => {
  it('主代理 system prompt 含三态退出码口径', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }] })

    const system = systemOf(0)
    expect(system).toContain('跳过 ≠ 通过')
    expect(system).toContain('全过 0')
  })
})
