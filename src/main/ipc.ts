import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC, type ChatMessage, type SettingsSaveInput, type TestResult } from '@shared/ipc'
import { getDecryptedApiKey, getSettingsView, hasApiKey, saveSettings } from './store/settings'
import { createProvider } from './providers'

// 所有来自渲染进程的入参一律过 zod 校验——坏数据挡在主进程门外（zod 词条见 DIARY 术语词典）。

const settingsSchema = z.object({
  providerType: z.enum(['openai-compatible', 'anthropic']),
  baseURL: z
    .string()
    .min(1)
    .max(500)
    // 用户可能懒得写协议头，自动补 https://（教材级体验）
    .transform((v) => (v.startsWith('http://') || v.startsWith('https://') ? v : `https://${v}`))
    .refine((v) => {
      try {
        new URL(v)
        return true
      } catch {
        return false
      }
    }, '接口地址不是合法 URL'),
  model: z.string().min(1).max(200),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(200000),
  timeoutMs: z.number().int().min(1000).max(600000),
  stream: z.boolean(),
  apiKey: z.string().max(400).optional()
})

const chatMessagesSchema = z
  .array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().min(1).max(200000)
    })
  )
  .min(1)
  .max(200)

const activeChats = new Map<number, AbortController>()

// 把 zod 的英文校验错误翻译成人话（设置页直接展示，不再甩原始 JSON）
const fieldLabels: Record<string, string> = {
  providerType: '协议类型',
  baseURL: '接口地址',
  model: '模型名',
  apiKey: 'API Key',
  temperature: 'temperature（随机性，0~2）',
  maxTokens: 'max_tokens（单次回答上限）',
  timeoutMs: '超时（毫秒）',
  stream: '流式开关',
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

export function registerIpcHandlers(): void {
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
}
