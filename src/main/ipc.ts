import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC, type ChatMessage, type SettingsSaveInput, type TestResult, type AgentRunResult } from '@shared/ipc'
import { getDecryptedApiKey, getSettingsView, hasApiKey, saveSettings } from './store/settings'
import { createProvider } from './providers'
import { chatMessagesSchema, settingsSchema } from './schemas'
import { runAgent, type AgentRuntimeContext } from './agent/runner'

// 所有来自渲染进程的入参一律过 zod 校验——坏数据挡在主进程门外。
// schema 定义在 ./schemas（不 import electron，可独立单测）；本文件只做翻译与分发。

const activeChats = new Map<number, AbortController>()
/** Agent 循环并发闸（按窗口）：同时只允许一个 Agent 任务 */
const activeAgents = new Set<number>()

// 把 zod 的英文校验错误翻译成人话（设置页直接展示，不再甩原始 JSON）
const fieldLabels: Record<string, string> = {
  providerType: '协议类型',
  baseURL: '接口地址',
  model: '模型名',
  apiKey: 'API Key',
  temperature: 'temperature（随机性，0~2）',
  topP: 'Top P（核采样，0~1）',
  topK: 'Top K（候选词数，1~200）',
  maxToolRounds: '工具调用轮数',
  supportsImages: '图片输入支持',
  maxTokens: 'max_tokens（单次回答上限）',
  timeoutMs: '超时（毫秒）',
  stream: '流式开关',
  contextWindow: '上下文窗口（客户端元数据）',
  reasoningEffort: '思考强度',
  messages: '消息列表'
}

function friendlyParse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue.path.join('.')
  const label = fieldLabels[path] ?? (path || '参数')
  const bounds = issue as { maximum?: number; minimum?: number }
  let detail = issue.message
  if (issue.code === 'too_big' && bounds.maximum !== undefined) detail = `不能大于 ${bounds.maximum}`
  else if (issue.code === 'too_small' && bounds.minimum !== undefined) detail = `不能小于 ${bounds.minimum}`
  throw new Error(`参数不合法：${label} —— ${detail}`)
}

function friendlyChatError(err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `请求超时（${timeoutMs}ms）：可在设置页调大超时时间，或检查网络 / 代理`
  if (err instanceof Error && err.name === 'AbortError') return '已停止生成'
  return err instanceof Error ? err.message : String(err)
}

export function registerIpcHandlers(deps: { agent: AgentRuntimeContext }): void {
  ipcMain.handle(IPC.settingsGet, () => getSettingsView())

  ipcMain.handle(IPC.settingsSave, (_e, raw: unknown) => {
    const input = friendlyParse(settingsSchema, raw) as SettingsSaveInput
    return saveSettings(input)
  })

  ipcMain.handle(IPC.settingsTest, async (_e, raw: unknown): Promise<TestResult> => {
    const input = friendlyParse(settingsSchema, raw) as SettingsSaveInput
    const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : getDecryptedApiKey()
    if (!apiKey) {
      return { ok: false, message: '还没有 API Key：请先在下方填写并保存，或填好后直接点「测试连接」' }
    }
    const provider = createProvider(input.providerType)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    try {
      return await provider.testConnection({
        settings: input,
        apiKey,
        messages: [],
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle(IPC.chatSend, async (e, raw: unknown) => {
    const messages = friendlyParse(chatMessagesSchema, raw) as ChatMessage[]
    const settings = getSettingsView()

    // IPC 层并发防护：渲染层的 streaming 标志只是软约束，这里才是硬闸
    if (activeChats.has(e.sender.id)) {
      e.sender.send(IPC.chatError, '已有任务在进行：请先点「停止」或等待完成')
      return
    }

    if (!settings.baseURL || !settings.model) {
      e.sender.send(IPC.chatError, '还没有配置模型：请先到「设置」页填好接口地址、模型名和 API Key')
      return
    }
    if (!hasApiKey()) {
      e.sender.send(IPC.chatError, '还没有保存 API Key：请先到「设置」页填写并保存')
      return
    }

    const apiKey = getDecryptedApiKey()
    const provider = createProvider(settings.providerType)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, settings.timeoutMs)
    activeChats.set(e.sender.id, controller)

    try {
      await provider.streamChat(
        { settings, apiKey, messages, signal: controller.signal },
        {
          onChunk: (text) => {
            if (!e.sender.isDestroyed()) e.sender.send(IPC.chatChunk, text)
          }
        }
      )
      if (!e.sender.isDestroyed()) e.sender.send(IPC.chatDone)
    } catch (err) {
      if (!e.sender.isDestroyed()) {
        e.sender.send(IPC.chatError, friendlyChatError(err, timedOut, settings.timeoutMs))
      }
    } finally {
      clearTimeout(timer)
      activeChats.delete(e.sender.id)
    }
  })

  ipcMain.handle(IPC.chatAbort, (e) => {
    activeChats.get(e.sender.id)?.abort()
  })

  // Agent 模式（plan6 D3/D4）：独立上下文 + 单次报告，不走流式
  const agentRunInput = z.object({
    task: z.string().min(1).max(200000),
    agentName: z.string().max(64).optional()
  })
  const failResult = (agent: string, error: string): AgentRunResult => ({
    ok: false, output: '', rounds: 0, stopReason: 'error', agent, error
  })

  ipcMain.handle(IPC.agentRun, async (e, raw: unknown): Promise<AgentRunResult> => {
    // 入参校验走 friendlyParse（人话错误），且失败也返回 AgentRunResult 而非抛裸 ZodError
    let req: { task: string; agentName?: string }
    try {
      req = friendlyParse(agentRunInput, raw) as { task: string; agentName?: string }
    } catch (err) {
      return failResult('内核默认', err instanceof Error ? err.message : String(err))
    }
    // 并发闸（交叉验证提出）：Agent 循环成本高（可跑满轮数 + 命令执行），同时只允许一个
    if (activeAgents.has(e.sender.id)) {
      return failResult(req.agentName ?? '内核默认', '已有 Agent 任务在执行：请等待当前任务结束')
    }
    activeAgents.add(e.sender.id)
    try {
      const settings = getSettingsView()
      if (!settings.baseURL || !settings.model) {
        return failResult(req.agentName ?? '内核默认', '还没有配置模型：请先到「设置」页填好接口地址、模型名和 API Key')
      }
      const apiKey = getDecryptedApiKey()
      if (!apiKey) {
        return failResult(req.agentName ?? '内核默认', '还没有保存 API Key：请先到「设置」页填写并保存')
      }
      const result = await runAgent(deps.agent, {
        settings,
        apiKey,
        task: req.task,
        agentName: req.agentName
      })
      return {
        ok: result.stopReason === 'completed',
        output: result.output,
        rounds: result.rounds,
        stopReason: result.stopReason,
        agent: result.agent,
        ...(result.stopReason === 'max-rounds'
          ? { error: `已达轮数预算上限（${result.rounds} 轮）被强制停止，以下为部分产出` }
          : {})
      }
    } catch (err) {
      return failResult(req.agentName ?? '内核默认', err instanceof Error ? err.message : String(err))
    } finally {
      activeAgents.delete(e.sender.id)
    }
  })
}
