import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'
import type { AgentRuntimeContext } from '@main/agent/runner'
import type { PlanApprovalBridge } from '@main/agent/plan-approval'
import { createPlanApprovalBridge } from '@main/agent/plan-approval'
import { createCheckpointStore } from '@main/store/checkpoints'

// runner 集成测试：唯一断言"工具 schema 真下发给模型"这条链路的地方。
// ⚠️ loop 测试注入 mock chat 会绕过 runner —— 只在那儿断言，这条链路静默回归无人发现。

const openaiSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))
const anthropicSpy = vi.fn(async () => ({ text: '完成', toolCalls: [] }))

// D-032 后 runner 走**流式**通道：mock 指向 stream*（chat* 保留给降级路径）
vi.mock('@main/providers/openai-agent', () => ({
  streamWithToolsOpenAI: (...args: unknown[]) => openaiSpy(...(args as [])),
  chatWithToolsOpenAI: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))
vi.mock('@main/providers/anthropic-agent', () => ({
  streamWithToolsAnthropic: (...args: unknown[]) => anthropicSpy(...(args as [])),
  chatWithToolsAnthropic: vi.fn(async () => ({ text: '完成', toolCalls: [] }))
}))

const { runAgent } = await import('@main/agent/runner')

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
  const base = mkdtempSync(join(tmpdir(), 'jsl-runner-'))
  const ws = join(base, 'ws')
  return {
    getWorkspaceRoot: () => ws,
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    // 检查点仓库（plan8 R4）：给一个独立临时目录，让本组测试真正走一遍快照链路
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
}

/** 取第 4 个参数（tools）的名字集合 */
function toolNamesOf(spy: typeof openaiSpy, callIndex = 0): string[] {
  const call = spy.mock.calls[callIndex] as unknown[] | undefined
  const tools = (call?.[3] ?? []) as Array<{ name: string }>
  return tools.map((t) => t.name)
}

describe('runAgent（工具链路集成）', () => {
  beforeEach(() => {
    openaiSpy.mockClear()
    anthropicSpy.mockClear()
  })

  it('【回归】工具 schema 确实下发给模型，且缺省排除高危 run_command', async () => {
    const ctx = makeCtx()
    const res = await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '干个活' }] })

    expect(openaiSpy).toHaveBeenCalledTimes(1)
    const names = toolNamesOf(openaiSpy)
    expect(names.length).toBeGreaterThan(0) // ← 上一轮 bug 就是这里为空
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('fetch_url')
    // 高危工具缺省不下发（plan6 D4 追记）
    expect(names).not.toContain('run_command')
    expect(res.agent).toBe('内核默认')
  })

  it('【回归】提示词必须带「做事纪律」——禁止不查就答（真机实测后补）', async () => {
    // ⚠️ 真机实测：问「有哪些文件」时模型会**不调工具直接编**一个假列表，且语气笃定。
    // 纪律靠提示词兜住 —— 后续重构删掉它，不会有别的测试变红。
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '看看有哪些文件' }] })

    const messages = openaiSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')?.content ?? ''

    expect(system).toContain('能查就查')
    expect(system).toContain('必须先调用工具核实')
    // 防注入的既有规则不能被顶掉
    expect(system).toContain('安全基线')
  })

  it('主循环用自定义 Agent：定义的 systemPrompt 生效、措辞不自称"子代理"（plan17 判据 4）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'word-smith.md'),
      '---\nname: word-smith\ndescription: 文案专家\n---\n你只写文案，绝不写代码。',
      'utf8'
    )
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '写句标语' }],
      agentName: 'word-smith'
    })

    const messages = openaiSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('你只写文案，绝不写代码。') // def.systemPrompt 真的进了主循环提示
    expect(system).toContain('你是「word-smith」') // 主对话不自称"子代理"（措辞修正的守卫）
    expect(system).not.toContain('你是子代理「word-smith」')
  })

  it('不带 agentName = 内核默认提示（plan17 判据 5：老会话零回归）', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }] })
    const messages = openaiSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('内核 Agent')
  })

  it('【回归】做事纪律对自定义子代理同样生效（不是只给内核默认加）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-discipline.md'),
      '---\nname: runner-discipline\ndescription: 测纪律\n---\n只读审查',
      'utf8'
    )
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'runner-discipline'
    })

    const messages = openaiSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('能查就查')
  })

  it('自定义 Agent 显式声明才下发声明内工具（白名单生效）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )

    const res = await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: '跑个命令' }], agentName: 'runner-bot' })
    const names = toolNamesOf(openaiSpy)
    expect(names).not.toContain('write_file') // 白名单外的工具不下发
    expect(res.agent).toBe('runner-bot')
    // plan8 R5（2026-09-13 改正）：可写档下**声明了就下发** —— 每次执行前由确认桥把关
    // （此前这条断言写成 not.toContain，等于让 R5 永远触发不了，与界面文案"执行命令仍需逐次授权"矛盾）
    expect(names).toContain('run_command')
  })

  it('⚠️ 可写档 + 声明了 run_command：执行前**真的会问用户**，拒绝则该命令不执行（plan8 R5 的接线证明）', async () => {
    const ctx = makeCtx()
    const asked: Array<{ tool: string; detail: string }> = []
    // 确认桥：注入式（工具层不知道确认从哪来），这里用一个记录答案的替身
    ctx.confirmCommand = async (req) => {
      asked.push({ tool: req.tool, detail: req.detail })
      return false // 用户拒绝
    }
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )
    // 第 1 次模型回复要求执行一条命令；第 2 次收尾
    openaiSpy.mockResolvedValueOnce({
      text: '先跑个命令',
      // @ts-expect-error 测试替身：只填本用例断言用到的字段
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'echo JSL_R5' }) }]
    })
    openaiSpy.mockResolvedValueOnce({ text: '好', toolCalls: [] })

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '跑一下' }],
      agentName: 'runner-bot',
      conversationId: 'conv-r5'
    })

    expect(asked).toHaveLength(1)
    expect(asked[0]?.tool).toBe('run_command')
    expect(asked[0]?.detail).toContain('JSL_R5')
    // 拒绝后工具如实返回"用户拒绝"，而不是静默执行
    const secondCall = openaiSpy.mock.calls[1] as unknown[] | undefined
    const messages = (secondCall?.[2] ?? []) as Array<{ content?: string }>
    expect(messages.some((m) => (m.content ?? '').includes('用户拒绝'))).toBe(true)
  })

  it('完全访问档：高危工具不弹确认（那是用户明确选的"别拦我"）', async () => {
    const ctx = makeCtx()
    const asked: string[] = []
    ctx.confirmCommand = async (req) => {
      asked.push(req.detail)
      return true
    }
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )
    openaiSpy.mockResolvedValueOnce({
      text: '跑',
      // @ts-expect-error 测试替身：只填本用例断言用到的字段
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'echo JSL_NOASK' }) }]
    })
    openaiSpy.mockResolvedValueOnce({ text: '好', toolCalls: [] })

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '跑一下' }],
      agentName: 'runner-bot',
      permission: 'full-access',
      conversationId: 'conv-full'
    })

    expect(asked).toHaveLength(0)
  })

  it('权限档是硬上限：完整访问档下，声明了 run_command 才下发', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.userAgentsDir, { recursive: true })
    writeFileSync(
      join(ctx.userAgentsDir, 'runner-bot.md'),
      '---\nname: runner-bot\ndescription: 会跑命令的机器人\ntools: [read_file, run_command]\n---\n按需执行命令。',
      'utf8'
    )
    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 'runner-bot',
      permission: 'full-access'
    })
    expect(toolNamesOf(openaiSpy)).toContain('run_command')
  })

  it('只读档：只给读类工具，写入类被挡', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }], permission: 'read-only' })
    const names = toolNamesOf(openaiSpy)
    expect(names).toContain('read_file')
    expect(names).toContain('list_dir')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_command')
  })

  it('未知 agentName 抛人话错误', async () => {
    const ctx = makeCtx()
    await expect(runAgent(ctx, { settings, apiKey: 'k', history: [{ role: 'user', content: 'x' }], agentName: '不存在' })).rejects.toThrow(
      '找不到名为「不存在」的 Agent 定义'
    )
  })

  it('anthropic 类型走 anthropic 通道且同样下发工具', async () => {
    const ctx = makeCtx()
    await runAgent(ctx, {
      settings: { ...settings, providerType: 'anthropic' },
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }]
    })
    expect(anthropicSpy).toHaveBeenCalledTimes(1)
    expect(openaiSpy).not.toHaveBeenCalled()
    expect(toolNamesOf(anthropicSpy).length).toBeGreaterThan(0)
  })
})

// ── 计划批准闸（plan27）────────────────────────────────────────────────────
// 这组用例盯的是**一条此前完全缺失的接线**：planner 给出方案后**停下来等人点头**，
// 点头才由 executor 接手。核心风险不是"批准了不执行"，而是**"没批准也执行"** ——
// 所以每条"该等"的路径都要有一条"没点头 ⇒ 一个写操作都没发生"的断言。
//
// 位置说明（为什么在 runner 测）：闸在 `runAgent` 内部，**子代理走 scheduler 的 `runAgentLoop`，
// 根本不进这个函数** —— 子代理天然不会被卡住等批准，这条属性也在这里顺手被间接证明
// （子代理那侧的测试见 scheduler 相关用例，这里不重复）。

/** 批准桥替身：记录「问了什么」，答案由用例给定 */
function stubPlanBridge(answer: boolean | (() => Promise<boolean>)): {
  called: Array<{ agent: string; plan: string; conversationId: string }>
  signals: Array<AbortSignal | undefined>
  bridge: PlanApprovalBridge
} {
  const called: Array<{ agent: string; plan: string; conversationId: string }> = []
  const signals: Array<AbortSignal | undefined> = []
  return {
    called,
    signals,
    bridge: {
      request: async (req, opts) => {
        called.push({ agent: req.agent, plan: req.plan, conversationId: req.conversationId })
        signals.push(opts?.signal)
        return typeof answer === 'function' ? await answer() : answer
      },
      respond: () => false,
      abortAll: () => {}
    }
  }
}

function writeAgent(ctx: AgentRuntimeContext, file: string, body: string): void {
  mkdirSync(ctx.userAgentsDir, { recursive: true })
  writeFileSync(join(ctx.userAgentsDir, file), body, 'utf8')
}

const PLANNER_MD = '---\nname: t-planner\ndescription: 规划员\napproval: plan\nexecutor: t-executor\n---\n你是规划员。'
const EXECUTOR_MD = '---\nname: t-executor\ndescription: 执行员\n---\n你是执行员。'

describe('runAgent · 计划批准闸（plan27）', () => {
  beforeEach(() => {
    openaiSpy.mockClear()
    anthropicSpy.mockClear()
  })

  it('批准 → 交给 executor 执行；账目归到用户启用的那个 agent', async () => {
    const ctx = makeCtx()
    const { called, bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', EXECUTOR_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A\n2. 改 B', toolCalls: [] })
    openaiSpy.mockResolvedValueOnce({ text: '已执行完毕', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '做个方案' }],
      agentName: 't-planner',
      conversationId: 'conv-pa'
    })

    // ① 真的问了，且问的内容对得上（方案全文 + 是谁 + 哪条会话）
    expect(called).toHaveLength(1)
    expect(called[0]?.agent).toBe('t-planner')
    expect(called[0]?.plan).toContain('改 A')
    expect(called[0]?.plan).toContain('改 B')
    expect(called[0]?.conversationId).toBe('conv-pa')
    expect(res.planApproved).toBe(true)

    // ② 真的换人执行了：两轮模型调用，第二轮的 system 是 executor 的
    expect(openaiSpy).toHaveBeenCalledTimes(2)
    const second = openaiSpy.mock.calls[1]?.[2] as Array<{ role: string; content: string }>
    expect(second.find((m) => m.role === 'system')?.content).toContain('你是执行员。')

    // ③ 交接靠**自足的方案全文**：executor 看不到 planner 的思考，只能靠这两条消息
    expect(second.some((m) => m.role === 'assistant' && m.content.includes('改 B'))).toBe(true)
    expect(second.some((m) => m.role === 'user' && m.content.includes('已获用户批准'))).toBe(true)

    // ④ 报给用户的仍是「我选的那个 agent」——不因为内部换了执行者就换名字
    expect(res.agent).toBe('t-planner')
    // ⑤ 最终输出以 **executor 那轮**为准
    expect(res.output).toBe('已执行完毕')
  })

  it('不批准 → 一个写操作都没发生，方案留作本轮输出', async () => {
    const ctx = makeCtx()
    const { called, bridge } = stubPlanBridge(false)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', EXECUTOR_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: '做个方案' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-no'
    })

    expect(called).toHaveLength(1)
    expect(res.planApproved).toBe(false)
    // executor 根本没被叫起来（只跑了一轮 = planner 那轮）
    expect(openaiSpy).toHaveBeenCalledTimes(1)
    // 方案本身要留给用户看，而不是被吞掉
    expect(res.output).toContain('改 A')
    expect(res.agent).toBe('t-planner')
  })

  it('空方案不弹卡（对空气等批准是荒谬交互）', async () => {
    const ctx = makeCtx()
    const { called, bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    openaiSpy.mockResolvedValueOnce({ text: '   \n  ', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-empty'
    })

    expect(called).toHaveLength(0)
    expect(res.planApproved).toBeUndefined() // undefined = 闸门没触发（区别于 false = 被拒）
    expect(openaiSpy).toHaveBeenCalledTimes(1)
  })

  it('不带 approval:plan 的 agent 永不弹卡（普通 Agent 零影响）', async () => {
    const ctx = makeCtx()
    const { called, bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-normal.md', '---\nname: t-normal\ndescription: 普通\n---\n你是普通 agent。')

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-normal',
      conversationId: 'conv-normal'
    })

    expect(called).toHaveLength(0)
    expect(res.planApproved).toBeUndefined()
  })

  it('executor 自身也带 approval:plan 时不二次弹卡（skipPlanApproval 双保险）', async () => {
    // 反面场景：若内层递归漏传 skipPlanApproval，这里会弹**第二张卡**——
    // 用户刚点完"批准"，又被问一遍同一件事，且此时可能继续套娃。这条就是那个防套娃的锁。
    const ctx = makeCtx()
    const { called, bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', '---\nname: t-executor\ndescription: 执行员\napproval: plan\n---\n你是执行员。')
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [] })
    openaiSpy.mockResolvedValueOnce({ text: '执行完毕', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-loop'
    })

    expect(called).toHaveLength(1) // ← 只有 planner 那一次；第二次没有
    expect(res.planApproved).toBe(true)
    expect(res.output).toBe('执行完毕')
  })

  it('声明了不存在的 executor → 兜底到内核默认工具集（写歪名字不该断掉流程）', async () => {
    // 与 `tools` 的宽松口径一致：列表里写错一个名字，是提示词的疏漏，不是致命错误。
    // 注意 makeCtx 的 builtin 目录不存在，故连内置 code-executor 也找不到 → 落到内核默认。
    const ctx = makeCtx()
    const { bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', '---\nname: t-planner\ndescription: 规划员\napproval: plan\nexecutor: 查无此人\n---\n你是规划员。')
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [] })
    openaiSpy.mockResolvedValueOnce({ text: '执行完毕', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-fallback'
    })

    expect(res.planApproved).toBe(true)
    expect(openaiSpy).toHaveBeenCalledTimes(2)
    const second = openaiSpy.mock.calls[1]?.[2] as Array<{ role: string; content: string }>
    expect(second.find((m) => m.role === 'system')?.content).toContain('内核 Agent')
    expect(res.agent).toBe('t-planner') // 名义上仍是用户选的 agent
  })

  it('未注入批准桥 → 闸门不生效，方案直接返回（单测 / CLI 场景零回归）', async () => {
    const ctx = makeCtx()
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-nobridge'
    })

    expect(res.planApproved).toBeUndefined()
    expect(openaiSpy).toHaveBeenCalledTimes(1)
    expect(res.output).toContain('改 A')
  })

  it('本轮 signal 原样透传给批准桥（用户点停止要能立刻收尾，不必等超时）', async () => {
    const ctx = makeCtx()
    const { signals, bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [] })
    openaiSpy.mockResolvedValueOnce({ text: '执行完毕', toolCalls: [] })
    const ac = new AbortController()

    await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-signal',
      signal: ac.signal
    })

    expect(signals[0]).toBe(ac.signal)
  })

  it('等待期间被中止 → 按拒绝收尾，写操作一个没发生', async () => {
    // ⚠️ 这条**刻意用真桥**（而不是替身）：中止语义在桥内部实现（解绑监听器、按拒绝收尾），
    // 用替身等于把「用户点停止会发生什么」这件事测成我自己写的假答案。真桥零 electron 依赖，
    // 本来就该能进单测链路（见 architecture.test.ts 的 TEST_ENTRIES）。
    const ctx = makeCtx()
    const ac = new AbortController()
    let asked = false
    ctx.planApproval = createPlanApprovalBridge({
      send: () => {
        asked = true
        return true
      },
      log: () => {}
    })
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', EXECUTOR_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [] })

    const p = runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-abort',
      signal: ac.signal
    })
    // 等桥真的把请求问出去（planner 那轮跑完了）再中止 —— 早于此时中止就不是"等待期间"了
    await vi.waitFor(() => expect(asked).toBe(true))
    ac.abort()
    const res = await p

    expect(res.planApproved).toBe(false)
    expect(openaiSpy).toHaveBeenCalledTimes(1) // executor 没被叫起来
  })

  it('两轮用量**求和**（账单必须与厂商对得上，不能只记最后一次）', async () => {
    const ctx = makeCtx()
    const { bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', EXECUTOR_MD)
    // @ts-expect-error 测试替身：只填本用例断言用到的字段
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 改 A', toolCalls: [], usage: { promptTokens: 100, completionTokens: 20 } })
    // @ts-expect-error 测试替身：只填本用例断言用到的字段
    openaiSpy.mockResolvedValueOnce({ text: '执行完毕', toolCalls: [], usage: { promptTokens: 300, completionTokens: 50 } })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-usage'
    })

    expect(res.usage).toEqual({ promptTokens: 400, completionTokens: 70 })
  })

  it('改动计入 executor 那轮（planner 没有写工具，账面不该挂到它头上）', async () => {
    // 判据 6 的「changedFiles 取自 executor」只有在**executor 真产生了改动**时才验得出来 ——
    // 两边都是 0 的话，"取自谁"是验不出来的（断言恰好为真 ≠ 属性成立）。
    const ctx = makeCtx()
    mkdirSync(ctx.getWorkspaceRoot(), { recursive: true })
    const { bridge } = stubPlanBridge(true)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', EXECUTOR_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 新建 a.txt', toolCalls: [] })
    openaiSpy.mockResolvedValueOnce({
      text: '写好了',
      // @ts-expect-error 测试替身：只填本用例断言用到的字段
      toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'hi' }) }]
    })
    openaiSpy.mockResolvedValueOnce({ text: '完成', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-changes'
    })

    expect(res.planApproved).toBe(true)
    expect(res.changedFiles).toBe(1) // ← executor 写的那一个文件
    expect(existsSync(join(ctx.getWorkspaceRoot(), 'a.txt'))).toBe(true)
  })

  it('拒绝 → changedFiles 为 0（一个写操作都没发生）', async () => {
    const ctx = makeCtx()
    mkdirSync(ctx.getWorkspaceRoot(), { recursive: true })
    const { bridge } = stubPlanBridge(false)
    ctx.planApproval = bridge
    writeAgent(ctx, 't-planner.md', PLANNER_MD)
    writeAgent(ctx, 't-executor.md', EXECUTOR_MD)
    openaiSpy.mockResolvedValueOnce({ text: '## 方案\n1. 新建 b.txt', toolCalls: [] })

    const res = await runAgent(ctx, {
      settings,
      apiKey: 'k',
      history: [{ role: 'user', content: 'x' }],
      agentName: 't-planner',
      conversationId: 'conv-pa-nochange'
    })

    expect(res.planApproved).toBe(false)
    expect(res.changedFiles).toBe(0)
    expect(existsSync(join(ctx.getWorkspaceRoot(), 'b.txt'))).toBe(false)
  })
})
