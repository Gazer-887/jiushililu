import { describe, expect, it } from 'vitest'
import { resolveFetchApiKey, type FetchAvailableInput } from '@shared/models'
import { mapListModelsError } from '@main/providers/errors'
import { modelFetchAvailableSchema, modelSaveSchema } from '@main/schemas'

// plan47 S1/S2：免保存拉取的入参解析、Key 解析链、失败三档人话。
// 全部纯函数，脱离 electron-store 与网络（架构守卫：被测 import 图不许有 electron）。

const base: FetchAvailableInput = {
  providerType: 'openai-compatible',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4'
}

describe('resolveFetchApiKey（免保存拉取的 Key 解析链）', () => {
  it('表单里填了明文 Key → 用明文的（新端点未保存也能拉）', () => {
    expect(resolveFetchApiKey({ ...base, apiKey: 'sk-draft' }, 'sk-saved')).toBe('sk-draft')
  })

  it('Key 留空但有 id → 回落该端点已存密文', () => {
    expect(resolveFetchApiKey({ ...base, id: 'p-1' }, 'sk-saved')).toBe('sk-saved')
  })

  it('无 Key 且无 id → 空串（调用方报"请先填写 API Key"，绝不静默发请求）', () => {
    expect(resolveFetchApiKey(base, '')).toBe('')
  })

  it('有 id 但该端点没存过 Key → 仍是空串', () => {
    expect(resolveFetchApiKey({ ...base, id: 'p-1' }, '')).toBe('')
  })
})

describe('mapListModelsError（拉列表失败三档人话）', () => {
  it('404/405/501 → 不提供列表，指路手填', () => {
    for (const s of [404, 405, 501]) {
      expect(mapListModelsError(s)).toContain('手动填写模型 ID')
    }
  })

  it('401/403 → 指向 Key，且提醒 Key 类型可能拿错', () => {
    for (const s of [401, 403]) {
      expect(mapListModelsError(s)).toContain('Key')
    }
    expect(mapListModelsError(401)).toContain('类型')
  })

  it('其余状态码有兜底；各档互不相同且非空（绝不"空数组式沉默"）', () => {
    const msgs = [404, 401, 429, 500, 502].map(mapListModelsError)
    for (const m of msgs) expect(m.length).toBeGreaterThan(0)
    expect(new Set(msgs).size).toBe(msgs.length)
  })
})

describe('modelFetchAvailableSchema（IPC 入参闸门）', () => {
  it('新端点：无 id、带明文 Key 即合法', () => {
    const r = modelFetchAvailableSchema.safeParse({
      providerType: 'openai-compatible',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-x'
    })
    expect(r.success).toBe(true)
  })

  it('编辑已存端点：带 id、Key 可省（主进程回落已存密文）', () => {
    const r = modelFetchAvailableSchema.safeParse({
      id: 'p-1',
      providerType: 'anthropic',
      baseURL: 'https://api.anthropic.com'
    })
    expect(r.success).toBe(true)
  })

  it('坏地址仍被挡（复用 settingsSchema 的 URL 归一与校验）', () => {
    const r = modelFetchAvailableSchema.safeParse({
      providerType: 'openai-compatible',
      baseURL: 'https://'
    })
    expect(r.success).toBe(false)
  })

  it('没写协议头自动补 https://（与 settingsTest 同一条体验）', () => {
    const r = modelFetchAvailableSchema.parse({
      providerType: 'openai-compatible',
      baseURL: 'api.deepseek.com'
    })
    expect(r.baseURL).toBe('https://api.deepseek.com')
  })

  it('免保存拉取 ≠ 可存空端点：保存门槛「至少一个模型」未放松', () => {
    const r = modelSaveSchema.safeParse({
      name: '空端点',
      providerType: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      models: [],
      apiKey: 'sk-x'
    })
    expect(r.success).toBe(false)
  })
})
