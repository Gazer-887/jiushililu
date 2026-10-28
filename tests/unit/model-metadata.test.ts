import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { modelPatchEntrySchema, modelSaveSchema, settingsSchema } from '@main/schemas'
import {
  createProfile,
  makeEntry,
  mergeEntrySettings,
  normalizeProfiles,
  settingsOf
} from '@shared/models'

/** 构造一份最小合法档案（S3-10C0 测试夹具；字段与 modelSaveSchema 对齐） */
function fixtureProfile(entrySettings: Record<string, unknown>) {
  return {
    name: '端点A',
    providerType: 'openai-compatible' as const,
    baseURL: 'https://api.example.com/v1',
    models: [{ id: 'm1', model: 'test-model', settings: entrySettings }],
    apiKey: 'sk-test'
  }
}

describe('S3-10C0 身份与认证持久字段 · schema 接受与拒绝', () => {
  it('合法 requestIdentity/authentication 过 modelSaveSchema 并保留在输出', () => {
    const parsed = modelSaveSchema.parse(
      fixtureProfile({ requestIdentity: 'self-ua', authentication: 'bearer' })
    )
    const settings = parsed.models[0].settings as Record<string, unknown>
    expect(settings.requestIdentity).toBe('self-ua')
    expect(settings.authentication).toBe('bearer')
  })

  it('settingsSchema 接受两个可选字段（settings:save 旧路径）', () => {
    const parsed = settingsSchema.parse({
      providerType: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      model: 'm',
      temperature: null,
      topP: null,
      topK: null,
      maxTokens: 1024,
      timeoutMs: 60000,
      stream: true,
      contextWindow: 131072,
      reasoningEffort: 'default',
      maxToolRounds: 200,
      inputModalities: ['text'],
      requestIdentity: 'default',
      authentication: 'auto'
    })
    expect(parsed.requestIdentity).toBe('default')
    expect(parsed.authentication).toBe('auto')
  })

  it('非法身份策略与非法认证值被 modelSaveSchema 拒绝', () => {
    expect(
      modelSaveSchema.safeParse(fixtureProfile({ requestIdentity: 'magic' })).success
    ).toBe(false)
    expect(
      modelSaveSchema.safeParse(fixtureProfile({ authentication: 'ntlm' })).success
    ).toBe(false)
  })

  it('运行态键 sessionId/operationId/runId/headers 被 schema 拒绝（不静默保存）', () => {
    for (const key of ['sessionId', 'operationId', 'runId', 'headers']) {
      const r = modelSaveSchema.safeParse(fixtureProfile({ [key]: 'should-not-persist' }))
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain(key)
      }
    }
  })

  it('modelPatchEntrySchema 接受两个新字段；空补丁仍被拒绝', () => {
    expect(
      modelPatchEntrySchema.safeParse({ profileId: 'p1', entryId: 'm1', patch: { requestIdentity: 'default' } })
        .success
    ).toBe(true)
    expect(
      modelPatchEntrySchema.safeParse({ profileId: 'p1', entryId: 'm1', patch: { authentication: 'bearer' } })
        .success
    ).toBe(true)
    expect(modelPatchEntrySchema.safeParse({ profileId: 'p1', entryId: 'm1', patch: {} }).success).toBe(false)
  })

  it('patch 里的运行态键同样被拒绝', () => {
    expect(
      modelPatchEntrySchema.safeParse({ profileId: 'p1', entryId: 'm1', patch: { runId: 'r-1' } }).success
    ).toBe(false)
  })
})

describe('S3-10C0 读盘容错与回读不丢字段', () => {
  it('normalizeProfiles 读回后两个字段保留；非法值被 normalizeEntry 丢弃', () => {
    const good = normalizeProfiles([
      {
        id: 'p1',
        name: '端点A',
        providerType: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        models: [{ id: 'm1', model: 'test-model', settings: { requestIdentity: 'self-ua', authentication: 'bearer' } }]
      }
    ])
    expect(good.profiles[0].models[0].settings?.requestIdentity).toBe('self-ua')
    expect(good.profiles[0].models[0].settings?.authentication).toBe('bearer')

    const bad = normalizeProfiles([
      {
        id: 'p2',
        name: '端点B',
        providerType: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        models: [{ id: 'm2', model: 'test-model', settings: { requestIdentity: 'bogus', authentication: 42 } }]
      }
    ])
    const s = bad.profiles[0].models[0].settings ?? {}
    expect('requestIdentity' in s).toBe(false)
    expect('authentication' in s).toBe(false)
  })

  it('旧档案缺字段：settingsOf 不新增键，既有字段不变', () => {
    const profile = createProfile({
      id: 'p1',
      providerType: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: [makeEntry({ id: 'm1', model: 'test-model', settings: { temperature: 0.5 } })],
      now: 1
    })
    const entry = profile.models[0]
    const effective = settingsOf(profile, entry)
    expect('requestIdentity' in effective).toBe(false)
    expect('authentication' in effective).toBe(false)
    expect(effective.temperature).toBe(0.5)
    // 键集合与“加字段前”的语义一致：不含两个新键
    expect(Object.keys(effective)).not.toContain('requestIdentity')
    expect(Object.keys(effective)).not.toContain('authentication')
  })

  it('带字段的条目：settingsOf 原样透传两字段', () => {
    const profile = createProfile({
      id: 'p1',
      providerType: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: [
        makeEntry({
          id: 'm1',
          model: 'test-model',
          settings: { requestIdentity: 'opencode-v1', authentication: 'bearer' }
        })
      ],
      now: 1
    })
    const effective = settingsOf(profile, profile.models[0])
    expect(effective.requestIdentity).toBe('opencode-v1')
    expect(effective.authentication).toBe('bearer')
  })
})

describe('S3-10C0 mergeEntrySettings 只合并 patch 携带的键', () => {
  it('仅覆盖 patch 键；其余设置（含另一新字段）保持不变', () => {
    const merged = mergeEntrySettings(
      { temperature: 0.5, requestIdentity: 'self-ua' },
      { authentication: 'bearer' }
    )
    expect(merged.authentication).toBe('bearer')
    expect(merged.requestIdentity).toBe('self-ua')
    expect(merged.temperature).toBe(0.5)
  })

  it('patch 携带 requestIdentity 时覆盖旧值，不携带时不抹掉', () => {
    const merged = mergeEntrySettings({ requestIdentity: 'self-ua' }, { requestIdentity: 'default' })
    expect(merged.requestIdentity).toBe('default')
    const untouched = mergeEntrySettings({ requestIdentity: 'self-ua' }, {})
    expect(untouched.requestIdentity).toBe('self-ua')
  })
})

describe('S3-10C0 不进 API Key、不建第二存储', () => {
  it('schema 输出里 apiKey 仍是档案级单字段；两新字段只出现在 entry.settings', () => {
    const parsed = modelSaveSchema.parse(
      fixtureProfile({ requestIdentity: 'self-ua', authentication: 'bearer' })
    )
    expect(typeof parsed.apiKey).toBe('string')
    const topKeys = Object.keys(parsed)
    expect(topKeys.filter((k) => k.toLowerCase().includes('identity'))).toEqual([])
    expect(topKeys.filter((k) => k.toLowerCase().includes('authentication'))).toEqual([])
    expect('metadataByEntry' in parsed).toBe(false)
  })
})

describe('S3-10C0-R1 settingsSchema 运行态键拒绝（主脑复核 C0-M1）', () => {
  const legalBase = {
    providerType: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    model: 'm',
    temperature: null,
    topP: null,
    topK: null,
    maxTokens: 1024,
    timeoutMs: 60000,
    stream: true,
    contextWindow: 131072,
    reasoningEffort: 'default',
    maxToolRounds: 200,
    inputModalities: ['text']
  }

  it('sessionId/operationId/runId/headers 分别被 settingsSchema 拒绝且 issue 定位到键', () => {
    for (const key of ['sessionId', 'operationId', 'runId', 'headers']) {
      const r = settingsSchema.safeParse({ ...legalBase, [key]: 'should-not-persist' })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain(key)
      }
    }
  })

  it('合法 requestIdentity/authentication 继续通过 settingsSchema（R1 不回归）', () => {
    const r = settingsSchema.safeParse({ ...legalBase, requestIdentity: 'self-ua', authentication: 'bearer' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.requestIdentity).toBe('self-ua')
      expect(r.data.authentication).toBe('bearer')
    }
  })

  it('严格拒绝回归保持：modelSaveSchema 与补丁 schema 对运行态键仍拒绝', () => {
    const profile = {
      name: '端点A',
      providerType: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: [{ id: 'm1', model: 'test-model', settings: { runId: 'r-1' } }],
      apiKey: 'sk-test'
    }
    expect(modelSaveSchema.safeParse(profile).success).toBe(false)
    expect(
      modelPatchEntrySchema.safeParse({ profileId: 'p1', entryId: 'm1', patch: { headers: {} } }).success
    ).toBe(false)
  })
})

// ── S3-10C1 模型元数据合同与持久化 ──────────────────────────────────────────
import {
  resolveMetadata,
  withAppDefault,
  normalizeModelMetadata,
  modelMetadataSchema,
  type MetadataValue,
  type ModelMetadata
} from '@shared/model-metadata'

const obs = <T>(value: T, observedAt = 1700000000000): { value: T; observedAt: number } => ({ value, observedAt })

describe('S3-10C1 resolveMetadata 优先级与未知态', () => {
  it('三类来源并存时 user > official > catalog', () => {
    const value: MetadataValue<number> = {
      official: obs(131072),
      catalog: obs(999999),
      user: obs(262144)
    }
    const r = resolveMetadata(value)
    expect(r).toEqual({ value: 262144, source: 'user', observedAt: 1700000000000, limitations: undefined })
  })

  it('无 user 时回落 official；再回落 catalog；低优先来源保留不被解析删除', () => {
    const v: MetadataValue<number> = { official: obs(131072), catalog: obs(999999) }
    expect(resolveMetadata(v)?.source).toBe('official')
    const v2: MetadataValue<number> = { catalog: obs(999999) }
    expect(resolveMetadata(v2)?.source).toBe('catalog')
    expect(v2.official).toBeUndefined()
    expect(v2.catalog).toBeDefined()
  })

  it('三类来源均缺失/为空 → undefined，不补 0', () => {
    expect(resolveMetadata(undefined)).toBeUndefined()
    expect(resolveMetadata({})).toBeUndefined()
    const zeroContext: MetadataValue<number> | undefined = undefined
    const r = resolveMetadata(zeroContext)
    expect(r).toBeUndefined()
    expect(r?.value).not.toBe(0)
  })

  it('observedAt 非法（0/负数/NaN/Infinity/非数字）的来源被拒，回落下一优先级', () => {
    const v: MetadataValue<number> = {
      user: obs(262144, Number.NaN),
      official: obs(131072, -5),
      catalog: obs(999999, 1700000000000)
    }
    const r = resolveMetadata(v)
    expect(r?.source).toBe('catalog')
    expect(r?.value).toBe(999999)
  })
})

describe('S3-10C1 应用默认（只标 app-default）', () => {
  it('无已知来源时回退应用默认且来源只标 app-default，不伪装 official/catalog/user', () => {
    const r = withAppDefault(resolveMetadata(undefined), 131072)
    expect(r).toEqual({ value: 131072, source: 'app-default' })
    expect(r.source).not.toBe('official')
    expect(r.source).not.toBe('catalog')
    expect(r.source).not.toBe('user')
  })
  it('有已知来源时应用默认不覆盖解析结果', () => {
    const r = withAppDefault(resolveMetadata({ user: obs(262144) }), 131072)
    expect(r.source).toBe('user')
    expect(r.value).toBe(262144)
  })
})

describe('S3-10C1 normalizeModelMetadata fail-closed 容错', () => {
  it('合法 metadata 全字段读回；未知顶层键被丢弃', () => {
    const raw: ModelMetadata & Record<string, unknown> = {
      contextWindow: { user: { value: 262144, observedAt: 1700000000000 } },
      maxOutputTokens: { official: { value: 65536, observedAt: 1700000000000 } },
      reasoningLevels: { catalog: { value: ['low', 'high'], observedAt: 1700000000000 } },
      nativeInputModalities: { official: { value: ['text', 'image'], observedAt: 1700000000000 } },
      nativeExtendedInputs: { official: { value: ['audio', 'pdf'], observedAt: 1700000000000 } },
      attachmentParsing: { user: { value: { supported: true, parsers: ['markitdown'] }, observedAt: 1700000000000 } },
      pricing: { official: { value: [{ category: 'public-api', amount: 0.5, currency: 'USD', unit: '1M-input-tokens', scope: 'input' }], observedAt: 1700000000000 } },
      subscriptionPlan: { official: { value: { quotaUnit: 'Credits', quotaAmount: 11500, resetWindow: 'monthly' }, observedAt: 1700000000000 } },
      catalogPolicy: { official: { value: 'fetch-or-manual', observedAt: 1700000000000 } },
      rogueTopLevel: 'must-be-dropped'
    }
    const m = normalizeModelMetadata(raw)
    expect(m).toBeDefined()
    expect(m!.contextWindow?.user?.value).toBe(262144)
    expect(m!.pricing?.official?.value[0].amount).toBe(0.5)
    expect('rogueTopLevel' in m!).toBe(false)
    expect('serviceTiers' in m!).toBe(false)
  })

  it('非法来源/非法时间/负价格/非有限数字被明确丢弃', () => {
    const m = normalizeModelMetadata({
      contextWindow: { user: { value: -5, observedAt: 1700000000000 } },
      maxOutputTokens: { official: { value: Number.POSITIVE_INFINITY, observedAt: 1700000000000 } },
      pricing: { user: { value: [{ category: 'public-api', amount: -1, currency: 'USD', unit: '1M' }], observedAt: 1700000000000 } },
      reasoningLevels: { catalog: { value: ['high'], observedAt: 'yesterday' } }
    })
    expect(m?.contextWindow).toBeUndefined()
    expect(m?.maxOutputTokens).toBeUndefined()
    expect(m?.pricing?.user?.value[0].amount).toBeUndefined()
    expect(m?.reasoningLevels).toBeUndefined()
  })

  it('旧档案无 metadata → normalizeEntry 结果不含该键（不凭空出现）', () => {
    const p = normalizeProfiles([
      { id: 'p1', name: 'A', providerType: 'openai-compatible', baseURL: 'https://a.example.com/v1', models: [{ id: 'm1', model: 'm' }] }
    ])
    const entry = p.profiles[0].models[0]
    expect('metadata' in entry).toBe(false)
  })
})

describe('S3-10C1 modelMetadataSchema 持久化门（独立一级字段，不落 settings 白名单）', () => {
  const baseProfile = {
    name: 'A',
    providerType: 'openai-compatible' as const,
    baseURL: 'https://a.example.com/v1',
    models: [{ id: 'm1', model: 'm' }],
    apiKey: 'sk'
  }

  it('modelSaveSchema models[].metadata 独立接受并保留', () => {
    const r = modelSaveSchema.safeParse({
      ...baseProfile,
      models: [
        {
          id: 'm1',
          model: 'm',
          metadata: {
            contextWindow: { user: { value: 262144, observedAt: 1700000000000 } },
            nativeExtendedInputs: { official: { value: ['pdf'], observedAt: 1700000000000 } }
          }
        }
      ]
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.models[0].metadata?.contextWindow?.user?.value).toBe(262144)
    }
  })

  it('metadata 内非法值/未知键/非法时间被 schema 拒绝（fail-closed）', () => {
    const withMeta = (metadata: Record<string, unknown>) => ({
      ...baseProfile,
      models: [{ id: 'm1', model: 'm', metadata }]
    })
    expect(modelSaveSchema.safeParse(withMeta({ contextWindow: { user: { value: -1, observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(withMeta({ rogueKey: { user: { value: 1, observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(withMeta({ contextWindow: { user: { value: 1, observedAt: 'now' } } })).success).toBe(false)
  })

  it('C1 检查点①：资源上限 0 被拒（未知只能省略，不能存 0）', () => {
    const withMeta = (metadata: Record<string, unknown>) => ({
      ...baseProfile,
      models: [{ id: 'm1', model: 'm', metadata }]
    })
    expect(modelSaveSchema.safeParse(withMeta({ contextWindow: { user: { value: 0, observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(withMeta({ maxOutputTokens: { user: { value: 0, observedAt: 1 } } })).success).toBe(false)
  })

  it('C1 检查点③：空 MetadataValue（无任何来源）被 schema 拒绝且容错丢弃', () => {
    const empty = { ...baseProfile, models: [{ id: 'm1', model: 'm', metadata: { contextWindow: {} } }] }
    expect(modelSaveSchema.safeParse(empty).success).toBe(false)
    const m = normalizeModelMetadata({ contextWindow: {} })
    expect(m?.contextWindow).toBeUndefined()
  })

  it('nativeExtendedInputs 拒绝 text/image/video（不扩 INPUT_MODALITIES）', () => {
    expect(
      modelSaveSchema.safeParse({
        ...baseProfile,
        models: [{ id: 'm1', model: 'm', metadata: { nativeExtendedInputs: { official: { value: ['text'], observedAt: 1 } } } }]
      }).success
    ).toBe(false)
  })

  it('pricing：负值/NaN/Infinity 拒绝；零价/正价/未知省略三态分明', () => {
    const mk = (amount: number | undefined) => ({
      ...baseProfile,
      models: [{
        id: 'm1', model: 'm',
        metadata: amount === undefined ? undefined : { pricing: { official: { value: [{ category: 'public-api', amount, currency: 'USD', unit: '1M-input-tokens' }], observedAt: 1 } } }
      }]
    })
    expect(modelSaveSchema.safeParse(mk(-0.5)).success).toBe(false)
    expect(modelSaveSchema.safeParse(mk(Number.NaN)).success).toBe(false)
    expect(modelSaveSchema.safeParse(mk(Number.POSITIVE_INFINITY)).success).toBe(false)
    expect(modelSaveSchema.safeParse(mk(0)).success).toBe(true)
    expect(modelSaveSchema.safeParse(mk(0.5)).success).toBe(true)
    expect(modelSaveSchema.safeParse(mk(undefined)).success).toBe(true)
  })

  it('价格四类目与区域/缓存/批量/服务档字段可表达且互不混淆', () => {
    const r = modelSaveSchema.safeParse({
      ...baseProfile,
      models: [{
        id: 'm1', model: 'm',
        metadata: {
          pricing: {
            official: {
              value: [
                { category: 'public-api', amount: 0.5, currency: 'USD', unit: '1M-input-tokens', scope: 'input' },
                { category: 'aggregator', amount: 0.7, currency: 'USD', unit: '1M-input-tokens', scope: 'input' },
                { category: 'subscription-plan', amount: 0, currency: 'CNY', unit: 'Credits', region: 'cn' },
                { category: 'subscription-overage', amount: 2, currency: 'CNY', unit: '1M-input-tokens', region: 'cn', serviceTier: 'standard', cache: true, batch: false }
              ],
              observedAt: 1
            }
          }
        }
      }],
      apiKey: 'sk'
    })
    expect(r.success).toBe(true)
  })

  it('订阅结构：额度单位/数量/重置窗口/套餐外价格', () => {
    const r = modelSaveSchema.safeParse({
      ...baseProfile,
      models: [{
        id: 'm1', model: 'm',
        metadata: { subscriptionPlan: { official: { value: { quotaUnit: 'Credits', quotaAmount: 45000, resetWindow: '5h', overagePricing: [{ category: 'subscription-overage', amount: 2, currency: 'CNY', unit: '1M' }] }, observedAt: 1 } } }
      }],
      apiKey: 'sk'
    })
    expect(r.success).toBe(true)
  })

  it('C0 链接不回归：requestIdentity/authentication 与 metadata 同 entry 并存', () => {
    const r = modelSaveSchema.safeParse({
      ...baseProfile,
      models: [{
        id: 'm1', model: 'm',
        settings: { requestIdentity: 'self-ua', authentication: 'bearer' },
        metadata: { contextWindow: { user: { value: 262144, observedAt: 1 } } }
      }],
      apiKey: 'sk'
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.models[0].settings?.requestIdentity).toBe('self-ua')
      expect(r.data.models[0].metadata?.contextWindow?.user?.value).toBe(262144)
    }
  })
})

describe('S3-10C1 makeEntry 保留 metadata', () => {
  it('makeEntry 保留 metadata', () => {
    const meta: ModelMetadata = { contextWindow: { user: { value: 262144, observedAt: 1 } } }
    const e1 = makeEntry({ id: 'm1', model: 'm', metadata: meta })
    expect(e1.metadata?.contextWindow?.user?.value).toBe(262144)
  })
  it('makeEntry 无 metadata 入参时不产生该键', () => {
    const e2 = makeEntry({ id: 'm1', model: 'm2', settings: { temperature: 0.5 } })
    expect('metadata' in e2).toBe(false)
  })
})

// ── S3-10C1-R1 元数据边界与同合同校验（主脑复核） ────────────────────────────
describe('S3-10C1-R1 元数据边界与同合同校验', () => {
  const baseProfile = {
    name: 'A',
    providerType: 'openai-compatible' as const,
    baseURL: 'https://a.example.com/v1',
    models: [{ id: 'm1', model: 'm' }],
    apiKey: 'sk'
  }
  const mkSave = (metadata: unknown) => ({ ...baseProfile, models: [{ id: 'm1', model: 'm', metadata }] })
  const levels = (n: number, prefix = 'lvl') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)

  it('10,000 个 reasoning levels 被 schema 拒绝且容错丢弃', () => {
    expect(modelSaveSchema.safeParse(mkSave({ reasoningLevels: { official: { value: levels(10000), observedAt: 1 } } })).success).toBe(false)
    expect(normalizeModelMetadata({ reasoningLevels: { official: { value: levels(10000), observedAt: 1 } } })?.reasoningLevels).toBeUndefined()
  })

  it('10,000 条 limitations 被 schema 拒绝；resolveMetadata 拒该来源并回落 official', () => {
    const many = Array.from({ length: 10000 }, (_, i) => `限制-${i}`)
    expect(
      modelSaveSchema.safeParse(mkSave({ pricing: { official: { value: [{ category: 'public-api', amount: 1, currency: 'USD', unit: '1M' }], observedAt: 1, limitations: many } } })).success
    ).toBe(false)
    const r = resolveMetadata({
      user: { value: 1, observedAt: 1, limitations: many },
      official: { value: 2, observedAt: 1 }
    })
    expect(r?.source).toBe('official')
    expect(r?.value).toBe(2)
  })

  it('pricing 65 条被拒；64 条合法通过', () => {
    const prices = (n: number) => Array.from({ length: n }, (_, i) => ({ category: 'public-api' as const, amount: 0.1 * (i + 1), currency: 'USD', unit: '1M-input-tokens' }))
    expect(modelSaveSchema.safeParse(mkSave({ pricing: { official: { value: prices(65), observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ pricing: { official: { value: prices(64), observedAt: 1 } } })).success).toBe(true)
  })

  it('subscriptionPlan.overagePricing 65 条被拒；64 条通过', () => {
    const prices = (n: number) => Array.from({ length: n }, (_, i) => ({ category: 'subscription-overage' as const, amount: 1 + i * 0.1, currency: 'CNY', unit: '1M' }))
    expect(modelSaveSchema.safeParse(mkSave({ subscriptionPlan: { official: { value: { quotaUnit: 'Credits', quotaAmount: 1000, overagePricing: prices(65) }, observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ subscriptionPlan: { official: { value: { quotaUnit: 'Credits', quotaAmount: 1000, overagePricing: prices(64) }, observedAt: 1 } } })).success).toBe(true)
  })

  it('parsers 33 条被拒；supported=false 且 parsers 非空被拒；32 条唯一通过', () => {
    const parsers = (n: number, prefix = 'parser') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)
    expect(modelSaveSchema.safeParse(mkSave({ attachmentParsing: { user: { value: { supported: true, parsers: parsers(33) }, observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ attachmentParsing: { user: { value: { supported: false, parsers: parsers(1) }, observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ attachmentParsing: { user: { value: { supported: true, parsers: parsers(32) }, observedAt: 1 } } })).success).toBe(true)
  })

  it('reasoningLevels/nativeInputModalities/nativeExtendedInputs 重复值被拒；modality 上限 3', () => {
    expect(modelSaveSchema.safeParse(mkSave({ reasoningLevels: { official: { value: ['high', 'high'], observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ nativeInputModalities: { official: { value: ['text', 'text'], observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ nativeExtendedInputs: { official: { value: ['pdf', 'pdf'], observedAt: 1 } } })).success).toBe(false)
    expect(modelSaveSchema.safeParse(mkSave({ nativeInputModalities: { official: { value: ['text', 'image', 'video'], observedAt: 1 } } })).success).toBe(true)
  })

  it('resolveMetadata：limitations 含非字符串/空字符串 → 该来源拒并回落', () => {
    const r1 = resolveMetadata({
      user: { value: 1, observedAt: 1, limitations: [42 as unknown as string] },
      official: { value: 2, observedAt: 1 }
    })
    expect(r1?.source).toBe('official')
    const r2 = resolveMetadata({
      user: { value: 1, observedAt: 1, limitations: [''] },
      official: { value: 2, observedAt: 1 }
    })
    expect(r2?.source).toBe('official')
  })

  it('合法边界值通过：32 limitations×500 字符、64 reasoningLevels 唯一、32 parsers 唯一', () => {
    const limit32 = Array.from({ length: 32 }, (_, i) => `限-${i}`.padEnd(500, '释'))
    const r = resolveMetadata({ user: { value: 7, observedAt: 1, limitations: limit32 } })
    expect(r?.source).toBe('user')
    expect(r?.limitations).toHaveLength(32)
    expect(modelSaveSchema.safeParse(mkSave({ reasoningLevels: { official: { value: levels(64), observedAt: 1 } } })).success).toBe(true)
    expect(modelSaveSchema.safeParse(mkSave({ attachmentParsing: { user: { value: { supported: true, parsers: levels(32, 'p') }, observedAt: 1 } } })).success).toBe(true)
  })
})

// ── S3-10D 模型元数据 UI 与未知价格态 ────────────────────────────────────────
import { INPUT_MODALITIES } from '@shared/content-parts'

/**
 * 实现前这些导出尚不存在（动态导入失败）⇒ 本组用例逐条红；实现后整体绿。
 * 用动态导入而非常规 import，是为了让红态落在每条用例上，而不是整文件加载失败。
 */
type FactModule = typeof import('../../src/renderer/src/components/ModelCatalogEditor')
let dMod: FactModule | null = null

beforeAll(async () => {
  try {
    dMod = await import('../../src/renderer/src/components/ModelCatalogEditor')
  } catch {
    dMod = null
  }
})

const D = (): FactModule => {
  if (!dMod) throw new Error('S3-10D 契约未实现：ModelCatalogEditor 未导出元数据展示/覆盖函数')
  return dMod
}

/** 主进程返回值夹具：profiles[0] 即当前编辑端点 */
const viewWith = (models: unknown[]): import('@shared/models').ModelsView =>
  ({
    profiles: [
      {
        id: 'p1',
        name: '端点A',
        providerType: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        models,
        hasApiKey: true,
        apiKeyMasked: 'sk-***'
      }
    ],
    activeId: 'p1',
    filePath: '/tmp/models.json'
  }) as unknown as import('@shared/models').ModelsView

const rowOf = (rows: Array<{ key: string; value: string; known: boolean }>, key: string) => {
  const row = rows.find((r) => r.key === key)
  if (!row) throw new Error(`缺少字段行：${key}`)
  return row
}

describe('S3-10D 模型事实区：来源顺序与观测时间', () => {
  it('三类来源并存时显示用户值与用户观测时间（user > official > catalog）', () => {
    const { buildMetadataFacts, SOURCE_LABELS, formatObservedAt } = D()
    const rows = buildMetadataFacts({
      contextWindow: {
        catalog: { value: 111, observedAt: 1600000000000 },
        official: { value: 222, observedAt: 1650000000000 },
        user: { value: 333, observedAt: 1700000000000 }
      }
    })
    const ctx = rows.find((r) => r.key === 'contextWindow')!
    expect(ctx.known).toBe(true)
    expect(ctx.value).toContain('333')
    expect(ctx.source).toBe('user')
    expect(ctx.sourceLabel).toBe(SOURCE_LABELS.user)
    expect(ctx.sourceLabel).toBe('用户')
    expect(ctx.observedAt).toBe(1700000000000)
    expect(ctx.observedAtLabel).toBe(formatObservedAt(1700000000000))
    expect(ctx.observedAtLabel).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('无用户来源时回落官方、再回落目录，来源标签跟着解析结果走', () => {
    const { buildMetadataFacts } = D()
    const officialRows = buildMetadataFacts({
      contextWindow: { official: { value: 222, observedAt: 1650000000000 }, catalog: { value: 111, observedAt: 1600000000000 } }
    })
    const official = officialRows.find((r) => r.key === 'contextWindow')!
    expect(official.source).toBe('official')
    expect(official.sourceLabel).toBe('官方')
    expect(official.observedAt).toBe(1650000000000)

    const catalogRows = buildMetadataFacts({ contextWindow: { catalog: { value: 111, observedAt: 1600000000000 } } })
    const catalog = catalogRows.find((r) => r.key === 'contextWindow')!
    expect(catalog.source).toBe('catalog')
    expect(catalog.sourceLabel).toBe('目录')
  })

  it('应用默认只在无已知来源时出现，来源只标 app-default，且与 settingsOf 兜底值一致', () => {
    const { buildMetadataFacts, APP_DEFAULTS, SOURCE_LABELS } = D()
    const rows = buildMetadataFacts(undefined)
    const ctx = rows.find((r) => r.key === 'contextWindow')!
    expect(ctx.source).toBe('app-default')
    expect(ctx.sourceLabel).toBe(SOURCE_LABELS['app-default'])
    expect(ctx.sourceLabel).toBe('应用默认')
    expect(ctx.observedAt).toBeNull()
    expect(ctx.observedAtLabel).toBeNull()
    expect(ctx.value).toContain('131,072')

    const profile = createProfile({
      id: 'p1',
      providerType: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: [makeEntry({ id: 'm1', model: 'test-model' })],
      now: 1
    })
    const effective = settingsOf(profile, profile.models[0])
    expect(APP_DEFAULTS.contextWindow).toBe(effective.contextWindow)
    expect(APP_DEFAULTS.maxOutputTokens).toBe(effective.maxTokens)
  })

  it('limitations 随该字段显示，且不丢来源与时间（价格与套餐块同样带上）', () => {
    const { buildMetadataFacts } = D()
    const rows = buildMetadataFacts({
      maxOutputTokens: { official: { value: 8192, observedAt: 1700000000000, limitations: ['厂商文档未列出该字段'] } },
      pricing: {
        official: {
          value: [{ category: 'public-api', amount: 1, currency: 'USD', unit: '1M-input-tokens' }],
          observedAt: 1700000000000,
          limitations: ['区域价差未列']
        }
      },
      subscriptionPlan: {
        official: {
          value: { quotaUnit: 'Credits', quotaAmount: 1000 },
          observedAt: 1700000000000,
          limitations: ['重置窗口未公布']
        }
      }
    })
    const out = rows.find((r) => r.key === 'maxOutputTokens')!
    expect(out.limitations).toEqual(['厂商文档未列出该字段'])
    expect(out.source).toBe('official')
    expect(out.observedAt).toBe(1700000000000)
    expect(rows.find((r) => r.key === 'pricing')!.limitations).toEqual(['区域价差未列'])
    expect(rows.find((r) => r.key === 'subscriptionPlan')!.limitations).toEqual(['重置窗口未公布'])
  })
})

describe('S3-10D 未知态', () => {
  const UNKNOWN_KEYS = [
    'reasoningLevels',
    'nativeInputModalities',
    'nativeExtendedInputs',
    'attachmentParsing',
    'pricing',
    'subscriptionPlan',
    'catalogPolicy'
  ]

  it('没有任何已知 metadata 时，七个字段显示“未知”，不显示 0 / 空值 / 伪造默认值', () => {
    const { buildMetadataFacts, UNKNOWN_TEXT } = D()
    expect(UNKNOWN_TEXT).toBe('未知')
    const rows = buildMetadataFacts(undefined)
    for (const key of UNKNOWN_KEYS) {
      const row = rows.find((r) => r.key === key)!
      expect(row.known).toBe(false)
      expect(row.value).toBe('未知')
      expect(row.value).not.toBe('0')
      expect(row.value).not.toBe('')
      expect(row.source).toBeNull()
      expect(row.sourceLabel).toBeNull()
      expect(row.observedAt).toBeNull()
      expect(row.observedAtLabel).toBeNull()
    }
  })

  it('未知不阻断更新链路：无 metadata 的条目仍能提交用户覆盖', async () => {
    const { submitMetadataOverride } = D()
    const view = viewWith([
      { id: 'm1', model: 'a', metadata: { contextWindow: { user: { value: 200000, observedAt: 1700000000123 } } } }
    ])
    const res = await submitMetadataOverride({
      api: { patchModelMetadata: async () => view },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: [{ id: 'm1', model: 'a' }],
      set: { contextWindow: 200000 }
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.models[0].metadata?.contextWindow?.user?.value).toBe(200000)
  })
})

describe('S3-10D 价格：类别分栏与零价/未知分明', () => {
  it('amount=0 是真实零价，显示 0 而不是未知', () => {
    const { buildPriceGroups } = D()
    const groups = buildPriceGroups({
      official: {
        value: [{ category: 'public-api', amount: 0, currency: 'USD', unit: '1M-input-tokens', scope: 'input' }],
        observedAt: 1
      }
    })
    const pub = groups.find((g) => g.category === 'public-api')!
    expect(pub.known).toBe(true)
    expect(pub.lines).toEqual(['0 USD / 1M-input-tokens · 输入'])
  })

  it('无价格 metadata：四个类别全部未知，且没有任何行显示 0', () => {
    const { buildPriceGroups, PRICE_CATEGORIES, UNKNOWN_TEXT } = D()
    const groups = buildPriceGroups(undefined)
    expect(groups.map((g) => g.category)).toEqual([...PRICE_CATEGORIES])
    expect(PRICE_CATEGORIES).toEqual(['public-api', 'aggregator', 'subscription-plan', 'subscription-overage'])
    for (const g of groups) {
      expect(g.known).toBe(false)
      expect(g.entries).toEqual([])
      expect(g.lines).toEqual([])
      expect(g.lines.join('')).not.toContain('0')
    }
    expect(UNKNOWN_TEXT).toBe('未知')
  })

  it('条目显示金额/币种/单位与 scope·region·serviceTier·cache·batch，多币种不混成一行', () => {
    const { buildPriceGroups } = D()
    const groups = buildPriceGroups({
      official: {
        value: [
          { category: 'aggregator', amount: 0.5, currency: 'USD', unit: '1M-input-tokens', region: 'us', serviceTier: 'standard', cache: true, batch: false },
          { category: 'aggregator', amount: 3.5, currency: 'CNY', unit: '1M-output-tokens', scope: 'output' }
        ],
        observedAt: 1
      }
    })
    const agg = groups.find((g) => g.category === 'aggregator')!
    expect(agg.lines).toHaveLength(2)
    expect(agg.lines[0]).toContain('0.5 USD')
    expect(agg.lines[0]).toContain('1M-input-tokens')
    expect(agg.lines[0]).toContain('区域 us')
    expect(agg.lines[0]).toContain('服务档 standard')
    expect(agg.lines[0]).toContain('缓存')
    expect(agg.lines[0]).not.toContain('批量')
    expect(agg.lines[1]).toContain('3.5 CNY')
    expect(agg.lines[1]).toContain('输出')
    // 一行只能有一个币种：美元与人民币不在同一行
    for (const line of agg.lines) {
      expect(line.includes('USD') && line.includes('CNY')).toBe(false)
    }
  })

  it('公开 API 与订阅套餐分栏：类别各成一组，不互相串行', () => {
    const { buildPriceGroups } = D()
    const groups = buildPriceGroups({
      official: {
        value: [
          { category: 'public-api', amount: 1, currency: 'USD', unit: '1M-input-tokens' },
          { category: 'subscription-plan', amount: 0, currency: 'CNY', unit: 'Credits' }
        ],
        observedAt: 1
      }
    })
    const pub = groups.find((g) => g.category === 'public-api')!
    const plan = groups.find((g) => g.category === 'subscription-plan')!
    expect(pub.lines).toEqual(['1 USD / 1M-input-tokens'])
    expect(plan.lines).toEqual(['0 CNY / Credits'])
    expect(pub.label).not.toBe(plan.label)
  })

  it('套餐额度不换算成公开 API 价：只有订阅套餐时价格类别仍为未知', () => {
    const { buildMetadataFacts, buildPriceGroups } = D()
    const metadata: ModelMetadata = {
      subscriptionPlan: {
        official: { value: { quotaUnit: 'Credits', quotaAmount: 11500, resetWindow: 'monthly' }, observedAt: 1 }
      }
    }
    const rows = buildMetadataFacts(metadata)
    expect(rows.find((r) => r.key === 'pricing')!.known).toBe(false)
    const plan = rows.find((r) => r.key === 'subscriptionPlan')!
    expect(plan.known).toBe(true)
    expect(plan.value).toContain('11,500')
    expect(plan.value).toContain('Credits')
    const groups = buildPriceGroups(metadata.pricing)
    expect(groups.every((g) => g.known === false)).toBe(true)
  })
})

describe('S3-10D 原生输入与附件解析分栏', () => {
  it('支持 PDF 附件解析不会凭空产生原生 PDF 输入', () => {
    const { buildMetadataFacts, NATIVE_INPUT_KEYS, ATTACHMENT_KEYS } = D()
    const rows = buildMetadataFacts({
      attachmentParsing: { user: { value: { supported: true, parsers: ['pdf'] }, observedAt: 1 } }
    })
    expect([...ATTACHMENT_KEYS]).toEqual(['attachmentParsing'])
    expect([...NATIVE_INPUT_KEYS]).toEqual(['nativeInputModalities', 'nativeExtendedInputs'])
    const attachment = rows.find((r) => r.key === 'attachmentParsing')!
    expect(attachment.known).toBe(true)
    expect(attachment.value).toContain('支持')
    expect(attachment.value).toContain('pdf')
    for (const key of NATIVE_INPUT_KEYS) {
      const row = rows.find((r) => r.key === key)!
      expect(row.known).toBe(false)
      expect(row.value).toBe('未知')
      expect(row.value).not.toContain('PDF')
      expect(row.value).not.toContain('pdf')
    }
  })

  it('原生扩展输入只来自 nativeExtendedInputs，附件解析不支持也不抹掉原生输入', () => {
    const { buildMetadataFacts } = D()
    const rows = buildMetadataFacts({
      nativeExtendedInputs: { catalog: { value: ['audio', 'pdf'], observedAt: 1 } },
      attachmentParsing: { user: { value: { supported: false }, observedAt: 1 } }
    })
    const ext = rows.find((r) => r.key === 'nativeExtendedInputs')!
    expect(ext.known).toBe(true)
    expect(ext.value).toContain('音频')
    expect(ext.value).toContain('PDF')
    expect(rows.find((r) => r.key === 'attachmentParsing')!.value).toBe('不支持')
  })

  it('INPUT_MODALITIES 与 MODALITY_UI 都不含 audio/pdf/file，且 MODALITY_UI 保持文本/图片/视频', () => {
    const { MODALITY_UI } = D()
    for (const forbidden of ['audio', 'pdf', 'file']) {
      expect(INPUT_MODALITIES as readonly string[]).not.toContain(forbidden)
      expect(MODALITY_UI as readonly string[]).not.toContain(forbidden)
    }
    expect([...MODALITY_UI]).toEqual(['text', 'image', 'video'])
  })
})

describe('S3-10D 用户覆盖只走主进程 IPC', () => {
  it('已保存模型：调用 patchModelMetadata 一次，载荷精确且不含 observedAt', async () => {
    const { submitMetadataOverride } = D()
    const calls: unknown[] = []
    const view = viewWith([{ id: 'm1', model: 'a' }])
    const res = await submitMetadataOverride({
      api: {
        patchModelMetadata: async (input: unknown) => {
          calls.push(input)
          return view
        }
      },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: [{ id: 'm1', model: 'a' }],
      set: { contextWindow: 200000, maxOutputTokens: 8192 }
    })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      profileId: 'p1',
      entryId: 'm1',
      patch: {
        set: {
          contextWindow: { user: { value: 200000 } },
          maxOutputTokens: { user: { value: 8192 } }
        }
      }
    })
    expect(JSON.stringify(calls[0])).not.toContain('observedAt')
  })

  it('未保存条目：不调用 metadata IPC，返回错误且草稿原样', async () => {
    const { submitMetadataOverride, canOverrideMetadata } = D()
    let called = 0
    const draft = [{ id: 'm-new', model: 'a' }]
    expect(canOverrideMetadata('p1', ['m1'], 'm-new')).toBe(false)
    const res = await submitMetadataOverride({
      api: {
        patchModelMetadata: async () => {
          called += 1
          return viewWith([])
        }
      },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm-new',
      draftModels: draft,
      set: { contextWindow: 1000 }
    })
    expect(called).toBe(0)
    expect(res.ok).toBe(false)
    expect(res.models).toEqual(draft)
    if (!res.ok) expect(res.error).toContain('尚未保存')
  })

  it('新增端点（无 profileId）：同样不发 metadata IPC', async () => {
    const { submitMetadataOverride, canOverrideMetadata } = D()
    let called = 0
    expect(canOverrideMetadata(undefined, ['m1'], 'm1')).toBe(false)
    const res = await submitMetadataOverride({
      api: {
        patchModelMetadata: async () => {
          called += 1
          return viewWith([])
        }
      },
      profileId: undefined,
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: [{ id: 'm1', model: 'a' }],
      set: { contextWindow: 1000 }
    })
    expect(called).toBe(0)
    expect(res.ok).toBe(false)
  })

  it('组件源码契约：覆盖只经 submitMetadataOverride 调 window.api，不自盖 observedAt', () => {
    const src = readFileSync(new URL('../../src/renderer/src/components/ModelCatalogEditor.tsx', import.meta.url), 'utf8')
    expect(src).toContain('submitMetadataOverride')
    expect(src).toContain('window.api')
    expect(src).not.toContain('window.api.patchModelMetadata')
    expect(src).not.toMatch(/observedAt\s*:\s*Date\.now\(\)/)
  })
})

describe('S3-10D 覆盖成功后刷新 draftModels', () => {
  it('只把 metadata 换成主进程真值：名称/settings/未保存草稿原样保留', async () => {
    const { submitMetadataOverride } = D()
    const draft = [
      {
        id: 'm1',
        model: 'a',
        name: '草稿名',
        settings: { authentication: 'bearer', requestIdentity: 'self-ua' },
        metadata: { contextWindow: { user: { value: 1, observedAt: 1 } } }
      },
      { id: 'm2', model: 'b', name: '未保存草稿' }
    ]
    const view = viewWith([
      {
        id: 'm1',
        model: 'a',
        metadata: {
          contextWindow: { user: { value: 200000, observedAt: 12345 } },
          maxOutputTokens: { official: { value: 8192, observedAt: 777 } }
        }
      }
    ])
    const res = await submitMetadataOverride({
      api: { patchModelMetadata: async () => view },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: draft,
      set: { contextWindow: 200000 }
    })
    expect(res.ok).toBe(true)
    const m1 = res.models.find((m) => m.id === 'm1')!
    expect(m1.name).toBe('草稿名')
    expect(m1.settings).toEqual({ authentication: 'bearer', requestIdentity: 'self-ua' })
    expect(m1.metadata!.contextWindow!.user!.value).toBe(200000)
    expect(m1.metadata!.contextWindow!.user!.observedAt).toBe(12345)
    expect(m1.metadata!.maxOutputTokens!.official!.value).toBe(8192)
    expect(res.models.find((m) => m.id === 'm2')).toEqual({ id: 'm2', model: 'b', name: '未保存草稿' })
  })

  it('清除用户覆盖：以主进程返回值回落 official，草稿不自行猜测', async () => {
    const { submitMetadataOverride } = D()
    const calls: Array<{ patch?: unknown }> = []
    const view = viewWith([
      { id: 'm1', model: 'a', metadata: { contextWindow: { official: { value: 200000, observedAt: 9 } } } }
    ])
    const res = await submitMetadataOverride({
      api: {
        patchModelMetadata: async (input: { patch?: unknown }) => {
          calls.push(input)
          return view
        }
      },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: [
        {
          id: 'm1',
          model: 'a',
          metadata: { contextWindow: { user: { value: 1, observedAt: 3 }, official: { value: 200000, observedAt: 9 } } }
        }
      ],
      clear: ['contextWindow']
    })
    expect(calls[0].patch).toEqual({ clear: ['contextWindow'] })
    expect(res.ok).toBe(true)
    const m1 = res.models[0]
    expect(m1.metadata!.contextWindow!.user).toBeUndefined()
    expect(m1.metadata!.contextWindow!.official!.value).toBe(200000)
  })

  it('主进程返回值已无 metadata：草稿里的旧 metadata 被清掉，不残留', async () => {
    const { submitMetadataOverride } = D()
    const res = await submitMetadataOverride({
      api: { patchModelMetadata: async () => viewWith([{ id: 'm1', model: 'a' }]) },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: [{ id: 'm1', model: 'a', metadata: { contextWindow: { user: { value: 1, observedAt: 1 } } } }],
      clear: ['contextWindow', 'maxOutputTokens']
    })
    expect(res.ok).toBe(true)
    expect('metadata' in res.models[0]).toBe(false)
  })
})

describe('S3-10D 覆盖失败：草稿与界面值保留', () => {
  it('IPC 抛错时返回可读错误，草稿逐字段不变', async () => {
    const { submitMetadataOverride } = D()
    const draft = [{ id: 'm1', model: 'a', metadata: { contextWindow: { user: { value: 1, observedAt: 1 } } } }]
    const res = await submitMetadataOverride({
      api: {
        patchModelMetadata: async () => {
          throw new Error('该模型不存在（可能已被删除）')
        }
      },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: draft,
      set: { contextWindow: 200000 }
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('该模型不存在')
    expect(res.models).toEqual(draft)
  })

  it('没有任何可提交值时不发 IPC，给出提示', async () => {
    const { submitMetadataOverride } = D()
    let called = 0
    const res = await submitMetadataOverride({
      api: {
        patchModelMetadata: async () => {
          called += 1
          return viewWith([])
        }
      },
      profileId: 'p1',
      savedEntryIds: ['m1'],
      entryId: 'm1',
      draftModels: [{ id: 'm1', model: 'a' }],
      set: {}
    })
    expect(called).toBe(0)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0)
  })
})

describe('S3-10D SettingsView 接线', () => {
  it('把已保存端点 id 与已保存条目 id 传给编辑器（未保存草稿据此不发 IPC）', () => {
    const src = readFileSync(new URL('../../src/renderer/src/views/SettingsView.tsx', import.meta.url), 'utf8')
    expect(src).toContain('profileId={editingModel?.id}')
    expect(src).toContain('savedEntryIds=')
    expect(src).toContain('editingProfile?.models')
  })
})
