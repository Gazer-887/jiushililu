import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModelSettings } from '@shared/ipc'
import { createExecEventRecorder, type ExecEvent } from '@main/agent/exec-events'
import { runAgent } from '@main/agent/runner'
import { createCheckpointStore } from '@main/store/checkpoints'
import { buildTitlePrompt, sanitizeGeneratedTitle } from '@main/store/conversations-core'
import { createProvider } from '@main/providers'

/**
 * plan26 真机冒烟（判据 4 的「真机冒烟兜底」实体；S3 端到端边界欠账的清偿工具）。
 *
 * **为什么放单测目录而不是脚本**：vitest 给了路径别名、临时目录与断言器；
 * `JSL_SMOKE` 未设时整组 skip（CI 无 Key ⇒ 零计费、不破坏闸门），与 ledger-anchors 的 skip 惯例同款。
 *
 * ⚠️ 环境变量必须在**模块顶层**读：`it.skipIf` 的条件在收集阶段求值（ledger-anchors 现场教训）。
 *
 * ⚠️ 真跑请**单独执行**（JSL_SMOKE=1 + 三个 KEY 环境变量）：五用例连发真模型会撞限流
 * （Agnes 免费档 ≥75s 间隔；全量套件并跑时红先单独复跑再定性）。
 * 「真实用户路径」口径：走 `runAgent` 真实主循环（非 curl 直连、非 mock provider），
 * settings 用**用户真实档案**（`%APPDATA%/jiushililu/models.json`）的端点形状，
 * Key 经环境变量注入（不落任何文件）。真调用一律最低参数（max_tokens=128）。
 */

const SMOKE = process.env.JSL_SMOKE === '1'
const KEY_DEEPSEEK = process.env.JSL_SMOKE_KEY_DEEPSEEK ?? ''
const KEY_AGNES = process.env.JSL_SMOKE_KEY_AGNES ?? ''
const KEY_MIMO = process.env.JSL_SMOKE_KEY_MIMO ?? ''

/** 用户真实档案的端点形状（Key 永不在档案里，档案只是路径的一部分） */
function realProfile(baseURL: string, model: string, overrides?: Partial<ModelSettings>): ModelSettings {
  const base: ModelSettings = {
    providerType: 'openai-compatible',
    baseURL,
    model,
    temperature: 0.7,
    topP: null,
    topK: null,
    maxTokens: 128,
    timeoutMs: 120000,
    stream: true,
    contextWindow: 1048576,
    reasoningEffort: 'default',
    maxToolRounds: 2,
    inputModalities: ['text']
  }
  return { ...base, ...(overrides ?? {}) }
}

function makeCtx(): Parameters<typeof runAgent>[0] {
  const base = mkdtempSync(join(tmpdir(), 'jsl-smoke-'))
  return {
    getWorkspaceRoot: () => join(base, 'ws'),
    builtinAgentsDir: join(base, 'builtin'),
    userAgentsDir: join(base, 'user'),
    checkpoints: createCheckpointStore(join(base, 'checkpoints'))
  }
}

const QUESTION: AgentMessageish[] = [{ role: 'user', content: '用不超过十个字回答：一加一等于几？' }]
type AgentMessageish = ChatMessage

/** 真实一轮：runAgent 主循环 + exec-events 数据链路断言（plan26 判据 4 的「验数据链路」半） */
async function smokeRun(name: string, settings: ModelSettings, apiKey: string): Promise<void> {
  const events: ExecEvent[] = []
  const recorder = createExecEventRecorder({
    sink: { append: (evt) => events.push(evt) },
    conversationId: 'smoke-plan26',
    agentScope: 'main'
  })
  const result = await runAgent(makeCtx(), {
    settings,
    apiKey,
    history: QUESTION as never,
    conversationId: 'smoke-plan26',
    permission: 'read-only',
    execEvents: recorder
  })
  expect(result.output.trim().length, `${name} 回复为空`).toBeGreaterThan(0)
  const kinds = events.map((e) => e.kind)
  expect(kinds, `${name} 缺 run_start`).toContain('run_start')
  expect(kinds, `${name} 缺 run_end（finally 补发）`).toContain('run_end')
}

describe.skipIf(!SMOKE)('plan26 真机冒烟（真实用户路径，JSL_SMOKE=1 才跑）', () => {
  it(
    'deepseek-flash：真实一轮 + exec-events 数据链路',
    { timeout: 180_000 },
    async () => {
      expect(KEY_DEEPSEEK, '缺 JSL_SMOKE_KEY_DEEPSEEK').not.toBe('')
      await smokeRun(
        'deepseek-flash',
        realProfile('https://api.deepseek.com', 'deepseek-flash', { reasoningEffort: 'low' }),
        KEY_DEEPSEEK
      )
    }
  )

  it(
    'agnes-3.0-flash：真实一轮 + exec-events 数据链路',
    { timeout: 180_000 },
    async () => {
      expect(KEY_AGNES, '缺 JSL_SMOKE_KEY_AGNES').not.toBe('')
      await smokeRun(
        'agnes-3.0-flash',
        realProfile('https://apihub.agnes-ai.com/v1', 'agnes-3.0-flash'),
        KEY_AGNES
      )
    }
  )

  it(
    'mimo-v2.6-flash：真实一轮 + exec-events 数据链路',
    { timeout: 180_000 },
    async () => {
      expect(KEY_MIMO, '缺 JSL_SMOKE_KEY_MIMO').not.toBe('')
      await smokeRun(
        'mimo-v2.6-flash',
        realProfile('https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.6-flash', {
          contextWindow: 1000000,
          reasoningEffort: 'low'
        }),
        KEY_MIMO
      )
    }
  )

  it(
    '滚动摘要真调用：小窗口迫使 trim，summaryCache 收到模型生成的摘要（deepseek 代表）',
    { timeout: 180_000 },
    async () => {
      expect(KEY_DEEPSEEK, '缺 JSL_SMOKE_KEY_DEEPSEEK').not.toBe('')
      const events: ExecEvent[] = []
      const recorder = createExecEventRecorder({
        sink: { append: (evt) => events.push(evt) },
        conversationId: 'smoke-plan26-trim',
        agentScope: 'main'
      })
      const summaryCache = new Map<string, string>()
      // 长历史迫使裁剪（contextWindow=1200，阈值 0.75 ⇒ ~900 token 即触发）
      const filler = '这是一段用于撑爆上下文窗口的测试正文。'.repeat(60)
      // ⚠️ trimMessages 的 keepRecent 默认 6 条永不裁 ⇒ history 必须 >6 条，否则 middle 为空、整段不裁
      const history = [
        { role: 'user', content: filler },
        { role: 'assistant', content: filler },
        { role: 'user', content: filler },
        { role: 'assistant', content: filler },
        { role: 'user', content: filler },
        { role: 'assistant', content: filler },
        { role: 'user', content: filler },
        { role: 'assistant', content: filler },
        { role: 'user', content: '用不超过十个字回答：二加二等于几？' }
      ] as never
      const result = await runAgent(makeCtx(), {
        settings: realProfile('https://api.deepseek.com', 'deepseek-flash', {
          contextWindow: 1200,
          reasoningEffort: 'default'
        }),
        apiKey: KEY_DEEPSEEK,
        history,
        conversationId: 'smoke-plan26-trim',
        permission: 'read-only',
        execEvents: recorder,
        summaryCache
      })
      expect(result.output.trim().length).toBeGreaterThan(0)
      const trim = events.find((e) => e.kind === 'trim') as { summarized?: boolean } | undefined
      expect(trim, '未发生 trim（历史没塞满）').toBeTruthy()
      expect(summaryCache.size, '滚动摘要未写入缓存（fail-soft 退占位或未触发）').toBeGreaterThan(0)
    }
  )

  it(
    '智能标题真调用 + 清洗（组合根 createTitleChat 同款形状，deepseek 代表）',
    { timeout: 180_000 },
    async () => {
      expect(KEY_DEEPSEEK, '缺 JSL_SMOKE_KEY_DEEPSEEK').not.toBe('')
      // ⚠️ 最低参数的正确口径（2026-10-01 实测两轮修正）：档位降到实测支持的 low；
      // max_tokens 必须**给足思考+输出的合计**——512 会被思考顶穿（finish_reason=length，
      // content 恒空、端点侧 SSE 正常），真实路径用的是档案 maxTokens=384000 所以从未暴露。
      const settings = realProfile('https://api.deepseek.com', 'deepseek-flash', {
        maxTokens: 2048,
        reasoningEffort: 'low'
      })
      const provider = createProvider(settings.providerType)
      const messages: ChatMessage[] = [
        { role: 'user', content: '帮我看看 Electron 主进程的崩溃守卫为什么没生效' },
        { role: 'assistant', content: '崩溃守卫没生效通常是 uncaughtException 监听注册得太晚，先看 main.tsx 的装配顺序。' }
      ]
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      let content = ''
      try {
        await provider.streamChat(
          { settings, apiKey: KEY_DEEPSEEK, messages, signal: controller.signal },
          { onChunk: (t) => { content += t } }
        )
      } finally {
        clearTimeout(timer)
      }
      const title = sanitizeGeneratedTitle(content)
      expect(title, '标题轻调用产出为空或清洗后无效').toBeTruthy()
      expect(title!.length, '标题超出 40 字清洗上限').toBeLessThanOrEqual(40)
    }
  )
})
