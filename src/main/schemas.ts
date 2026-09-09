import { z } from 'zod'

// 入参 schema 独立成文件：不 import electron，纯 zod，可脱离主进程做单元测试。
// 所有来自渲染进程的入参一律过这里——坏数据挡在主进程门外。

export const settingsSchema = z.object({
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
  // 采样三兄弟可留空：null = 不发送，跟随厂商默认
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  topK: z.number().int().min(1).max(200).nullable(),
  // 防手误闸门，不替厂商定上限（2026-09 查证：DeepSeek V4 最大输出 384K，未来模型可能更大）
  maxTokens: z.number().int().min(1).max(1_000_000),
  timeoutMs: z.number().int().min(1000).max(600000),
  stream: z.boolean(),
  // 上下文窗口是客户端元数据（不发给模型），封顶 1000 万同样只防手误
  contextWindow: z.number().int().min(1024).max(10_000_000),
  reasoningEffort: z.enum(['default', 'low', 'medium', 'high', 'max']),
  maxToolRounds: z.number().int().min(1).max(10000),
  supportsImages: z.boolean(),
  apiKey: z.string().max(400).optional()
})

export const chatMessagesSchema = z
  .array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().min(1).max(200000)
    })
  )
  .min(1)
  .max(200)
