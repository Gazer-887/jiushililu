// 模型元数据合同（S3-10C1 · R4 冻结）—— 每字段独立保留 official/catalog/user 三类来源，
// 优先级固定 user > official > catalog；无任何已知来源时解析为 undefined，**不把未知补 0**。
// 应用默认只走 withAppDefault 且来源只能标 app-default，不得伪装成三类来源之一。
// 原生扩展输入（audio/pdf/file）与附件解析是**两个独立字段**，不得互相推导；
// INPUT_MODALITIES（['text','image','video']）保持不变，本模块不扩产品出境枚举。
// normalizeModelMetadata 为读盘容错（白名单重建：未知键/非法来源/非法时间/非法值明确丢弃），
// modelMetadataSchema 为保存门（.strict() fail-closed）—— 两条路径同一合同。
import { z } from 'zod'
import { INPUT_MODALITIES, type InputModality } from './content-parts'

export type ModelMetadataSource = 'official' | 'catalog' | 'user'
export const METADATA_SOURCES = ['official', 'catalog', 'user'] as const

export interface MetadataObservation<T> {
  value: T
  observedAt: number
  limitations?: string[]
}

export interface MetadataValue<T> {
  official?: MetadataObservation<T>
  catalog?: MetadataObservation<T>
  user?: MetadataObservation<T>
}

export interface ResolvedMetadata<T> {
  value: T
  source: ModelMetadataSource
  observedAt: number
  limitations?: string[]
}

/** 原生扩展文件输入（独立于 InputModality 的产品出境枚举；audio/pdf/file 等原生文件输入） */
export const NATIVE_EXTENDED_INPUTS = ['audio', 'pdf', 'file'] as const
export type NativeExtendedInput = (typeof NATIVE_EXTENDED_INPUTS)[number]

/** 附件解析通路（产品侧行为；不得冒充模型原生输入） */
export interface AttachmentParsing {
  supported: boolean
  parsers?: string[]
}

export type PriceCategory = 'public-api' | 'aggregator' | 'subscription-plan' | 'subscription-overage'

export interface PriceEntry {
  category: PriceCategory
  /** 真实已知才存在；0=真实零价（与“未知省略”三态分明）；负值/NaN/Infinity 被拒 */
  amount: number
  currency: string
  unit: string
  scope?: 'input' | 'output' | 'request'
  region?: string
  serviceTier?: string
  cache?: boolean
  batch?: boolean
}

export interface SubscriptionPlan {
  quotaUnit: string
  quotaAmount: number
  resetWindow?: string
  /** 套餐外价格；不把订阅额度换算成公开 API 单价 */
  overagePricing?: PriceEntry[]
}

/** 目录能力（取值与 provider-presets 的 CatalogPolicy 口径一致，避免跨模块运行时依赖） */
export const CATALOG_POLICIES = ['fetch-or-manual', 'manual-only'] as const
export type CatalogPolicy = (typeof CATALOG_POLICIES)[number]

export interface ModelMetadata {
  contextWindow?: MetadataValue<number>
  maxOutputTokens?: MetadataValue<number>
  reasoningLevels?: MetadataValue<string[]>
  nativeInputModalities?: MetadataValue<InputModality[]>
  nativeExtendedInputs?: MetadataValue<NativeExtendedInput[]>
  attachmentParsing?: MetadataValue<AttachmentParsing>
  pricing?: MetadataValue<PriceEntry[]>
  subscriptionPlan?: MetadataValue<SubscriptionPlan>
  catalogPolicy?: MetadataValue<CatalogPolicy>
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** S3-10C1-R1：limitations 与 schema 同合同——≤32 条、每条 1–500 字符（非字符串/空串/超限即拒该来源） */
const limitationsOk = (l: unknown): l is string[] =>
  Array.isArray(l) && l.length <= 32 && l.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 500)

/** 单条观测合法性：observedAt 必须为正整数时间戳；value 由调用方按字段形状前置校验 */
function isValidObservation<T>(obs: MetadataObservation<T> | undefined): obs is MetadataObservation<T> {
  if (!obs || typeof obs !== 'object') return false
  if (!('value' in obs) || obs.value === undefined) return false
  if (!isPositiveInt(obs.observedAt)) return false
  if (obs.limitations !== undefined && !limitationsOk(obs.limitations)) return false
  return true
}

/** user > official > catalog；无合法来源 → undefined（不补 0、不猜值） */
export function resolveMetadata<T>(value: MetadataValue<T> | undefined): ResolvedMetadata<T> | undefined {
  if (!value || typeof value !== 'object') return undefined
  for (const source of ['user', 'official', 'catalog'] as const) {
    const obs: MetadataObservation<T> | undefined = value[source]
    if (isValidObservation(obs)) {
      return {
        value: obs.value,
        source,
        observedAt: obs.observedAt,
        ...(obs.limitations ? { limitations: obs.limitations } : {})
      }
    }
  }
  return undefined
}

export type AppDefaultResolution<T> = { value: T; source: 'app-default' }
export type WithAppDefaultResult<T> = ResolvedMetadata<T> | AppDefaultResolution<T>

/** 应用默认解析：仅在无已知来源时生效；回退值来源只能标 app-default（不得伪装三类来源） */
export function withAppDefault<T>(resolved: ResolvedMetadata<T> | undefined, appDefault: T): WithAppDefaultResult<T> {
  if (resolved) return resolved
  return { value: appDefault, source: 'app-default' }
}

/** 非负有限数（0=真实零价合法；负/NaN/Infinity 拒）——价格值（可为小数） */
const nonNegativeFinite = z.number().refine((v) => Number.isFinite(v) && v >= 0, { message: '价格/数值必须为非负有限数' })
/** 资源上限：正整数（C1 检查点①：0 与未知不同——未知只能省略，不能存 0） */
const positiveIntValue = z.number().int().positive()

/** S3-10C1-R1：字符串数组上限（每条 1–maxLen 字符，最多 maxItems 条） */
const limitedStrings = (maxItems: number, maxLen: number) =>
  z.array(z.string().min(1).max(maxLen)).min(1).max(maxItems)

/** S3-10C1-R1：枚举/字符串数组重复值拒绝（不静默去重） */
const uniqueOf = <T extends z.ZodArray<z.ZodTypeAny, 'many'>>(
  arraySchema: T
): z.ZodEffects<T, T['_output']> =>
  arraySchema.refine((arr) => new Set(arr as unknown[]).size === arr.length, { message: '数组含重复值' })

const observationSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z
    .object({
      value: valueSchema,
      observedAt: z.number().int().positive(),
      // S3-10C1-R1：limitations 与 resolveMetadata 同合同——≤32 条、每条 1–500 字符
      limitations: z.array(z.string().min(1).max(500)).max(32).optional()
    })
    .strict()

const metadataValueSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z
    .object({
      official: observationSchema(valueSchema).optional(),
      catalog: observationSchema(valueSchema).optional(),
      user: observationSchema(valueSchema).optional()
    })
    .strict()
    // C1 检查点③：至少包含一个来源；空对象无效
    .refine((v) => v.official !== undefined || v.catalog !== undefined || v.user !== undefined, {
      message: 'MetadataValue 至少要包含 official/catalog/user 中一个来源'
    })

const priceEntrySchema = z
  .object({
    category: z.enum(['public-api', 'aggregator', 'subscription-plan', 'subscription-overage']),
    amount: nonNegativeFinite,
    currency: z.string().min(1).max(16),
    unit: z.string().min(1).max(64),
    scope: z.enum(['input', 'output', 'request']).optional(),
    region: z.string().min(1).max(64).optional(),
    serviceTier: z.string().min(1).max(64).optional(),
    cache: z.boolean().optional(),
    batch: z.boolean().optional()
  })
  .strict()

const subscriptionPlanSchema = z
  .object({
    quotaUnit: z.string().min(1).max(64),
    quotaAmount: nonNegativeFinite,
    resetWindow: z.string().min(1).max(64).optional(),
    overagePricing: z.array(priceEntrySchema).optional()
  })
  .strict()

/** 字段级 schema（保存门与读盘容错共用同一合同） */
// 字段值 schema（MetadataValue 包装层与 user-set 输入层共用同一份，避免两套白名单漂移）
const contextWindowValue = positiveIntValue
const maxOutputTokensValue = positiveIntValue
const reasoningLevelsValue = uniqueOf(limitedStrings(64, 64))
const nativeInputModalitiesValue = uniqueOf(z.array(z.enum(INPUT_MODALITIES)).min(1).max(3))
const nativeExtendedInputsValue = uniqueOf(z.array(z.enum(NATIVE_EXTENDED_INPUTS)).min(1).max(3))
const attachmentParsingValue = z
  .object({ supported: z.boolean(), parsers: uniqueOf(z.array(z.string().min(1).max(100)).max(32)).optional() })
  .strict()
  .refine((v) => (v.supported === false ? (v.parsers ?? []).length === 0 : true), {
    message: 'supported=false 时 parsers 必须为空'
  })
const pricingValue = z.array(priceEntrySchema).min(1).max(64)
const subscriptionPlanValue = subscriptionPlanSchema.extend({
  overagePricing: z.array(priceEntrySchema).max(64).optional()
})
const catalogPolicyValue = z.enum(CATALOG_POLICIES)

const metadataFieldSchemas = {
  contextWindow: metadataValueSchema(contextWindowValue),
  maxOutputTokens: metadataValueSchema(maxOutputTokensValue),
  reasoningLevels: metadataValueSchema(reasoningLevelsValue),
  nativeInputModalities: metadataValueSchema(nativeInputModalitiesValue),
  nativeExtendedInputs: metadataValueSchema(nativeExtendedInputsValue),
  attachmentParsing: metadataValueSchema(attachmentParsingValue),
  pricing: metadataValueSchema(pricingValue),
  subscriptionPlan: metadataValueSchema(subscriptionPlanValue),
  catalogPolicy: metadataValueSchema(catalogPolicyValue)
} satisfies Record<keyof ModelMetadata, z.ZodTypeAny>

/**
 * 保存门：strict = 未知键/非法来源/非法时间/非法值一律拒绝（fail-closed）；字段均可选。
 * 唯一例外是历史残留的 `serviceTiers`：接受但**在解析结果中丢弃**，旧配置不因该键报错。
 */
export const modelMetadataSchema = z
  .object({
    contextWindow: metadataFieldSchemas.contextWindow.optional(),
    maxOutputTokens: metadataFieldSchemas.maxOutputTokens.optional(),
    reasoningLevels: metadataFieldSchemas.reasoningLevels.optional(),
    nativeInputModalities: metadataFieldSchemas.nativeInputModalities.optional(),
    nativeExtendedInputs: metadataFieldSchemas.nativeExtendedInputs.optional(),
    attachmentParsing: metadataFieldSchemas.attachmentParsing.optional(),
    pricing: metadataFieldSchemas.pricing.optional(),
    subscriptionPlan: metadataFieldSchemas.subscriptionPlan.optional(),
    serviceTiers: z.unknown().optional(),
    catalogPolicy: metadataFieldSchemas.catalogPolicy.optional()
  })
  .strict()
  .transform(({ serviceTiers: _legacy, ...rest }) => rest)

/**
 * 读盘容错（normalizeEntry 用）：与保存门同一合同的**逐字段**白名单重建——
 * 坏字段明确丢弃、好字段保留（严格整门会把含一个坏字段的存量元数据全丢，违反容错分层）；
 * 未知顶层键丢弃；全部字段无效时返回 undefined（= 当没有 metadata）。
 */
export function normalizeModelMetadata(raw: unknown): ModelMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rawRec = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  let kept = 0
  for (const [field, schema] of Object.entries(metadataFieldSchemas)) {
    const r = (schema as z.ZodTypeAny).safeParse(rawRec[field])
    if (r.success) {
      out[field] = r.data
      kept += 1
    }
  }
  return kept > 0 ? (out as ModelMetadata) : undefined
}

// ── S3-10C2A：元数据读取与用户补丁合同 ──────────────────────────────────────

/** 九个元数据字段名（补丁 clear / set 键的唯一合法集合） */
export const MODEL_METADATA_FIELDS = [
  'contextWindow',
  'maxOutputTokens',
  'reasoningLevels',
  'nativeInputModalities',
  'nativeExtendedInputs',
  'attachmentParsing',
  'pricing',
  'subscriptionPlan',
  'catalogPolicy'
] as const
export type ModelMetadataField = (typeof MODEL_METADATA_FIELDS)[number]

/** 读取入参（profileId/entryId 均必填） */
export const modelMetadataLookupSchema = z
  .object({
    profileId: z.string().min(1).max(64),
    entryId: z.string().min(1).max(64)
  })
  .strict()

/**
 * user-set 输入：只收 user 来源（strict 拒绝 official/catalog 夹带）；
 * 不收 observedAt——主进程以一次 Date.now() 盖章，不信任 renderer 提供的值。
 * 值 schema 与 metadataFieldSchemas 共用同一份白名单（不复制第二套）。
 */
const userSetObservationFor = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z
    .object({
      user: z
        .object({
          value: valueSchema,
          limitations: z.array(z.string().min(1).max(500)).max(32).optional()
        })
        .strict()
    })
    .strict()

export const modelMetadataSetSchema = z
  .object({
    contextWindow: userSetObservationFor(contextWindowValue).optional(),
    maxOutputTokens: userSetObservationFor(maxOutputTokensValue).optional(),
    reasoningLevels: userSetObservationFor(reasoningLevelsValue).optional(),
    nativeInputModalities: userSetObservationFor(nativeInputModalitiesValue).optional(),
    nativeExtendedInputs: userSetObservationFor(nativeExtendedInputsValue).optional(),
    attachmentParsing: userSetObservationFor(attachmentParsingValue).optional(),
    pricing: userSetObservationFor(pricingValue).optional(),
    subscriptionPlan: userSetObservationFor(subscriptionPlanValue).optional(),
    // 历史残留：接受但丢弃（旧配置不因该键报错）
    serviceTiers: z.unknown().optional(),
    catalogPolicy: userSetObservationFor(catalogPolicyValue).optional()
  })
  .strict()
  .transform(({ serviceTiers: _legacy, ...rest }) => rest)

export const modelMetadataPatchSchema = z
  .object({
    set: modelMetadataSetSchema.optional(),
    // S3-10C2A-R1（C2A-M1）：先限长（=字段总数）再进重复/语义检查，防超大输入预分配
    clear: z.array(z.enum(MODEL_METADATA_FIELDS)).max(MODEL_METADATA_FIELDS.length).optional()
  })
  .strict()
  .superRefine((p, ctx) => {
    const setKeys = p.set ? (Object.keys(p.set) as string[]) : []
    const clear = p.clear ?? []
    if (setKeys.length === 0 && clear.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '空补丁：set 与 clear 至少要有一个' })
    }
    if (new Set(clear).size !== clear.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'clear 含重复字段' })
    }
    for (const field of clear) {
      if (setKeys.includes(field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `同一字段不能同时 set 与 clear：${field}` })
      }
    }
  })

export const modelMetadataPatchInputSchema = modelMetadataLookupSchema.extend({
  patch: modelMetadataPatchSchema
})

export type ModelMetadataPatchSet = z.infer<typeof modelMetadataSetSchema>
export type ModelMetadataPatchInput = z.infer<typeof modelMetadataPatchInputSchema>
export type ModelMetadataPatch = {
  set?: ModelMetadataPatchSet
  clear?: ModelMetadataField[]
}

/**
 * 合成用户补丁（S3-10C2A 合同）：
 * - set 只写 user 来源，observedAt 统一由 now 盖章（不信任 renderer 值）；
 * - clear 只清该字段 user 来源，official/catalog 保留回落；唯一来源清空后字段移除；
 * - 全部字段清空 → undefined（metadata 不存在）。
 * 输入已由 modelMetadataPatchInputSchema 校验；合成结果由调用方再过 modelMetadataSchema 后才落盘。
 */
export function applyUserMetadataPatch(
  existing: ModelMetadata | undefined,
  patch: ModelMetadataPatch,
  now: number
): ModelMetadata | undefined {
  const out: Record<string, unknown> = { ...(existing ?? {}) }
  const set = (patch.set ?? {}) as Record<
    string,
    { user?: { value?: unknown; limitations?: string[] } } | undefined
  >
  for (const field of MODEL_METADATA_FIELDS) {
    const user = set[field]?.user
    if (!user || user.value === undefined) continue
    // set 只替换 user 来源；official/catalog 原样保留（解析时仍可回落）
    const cur = out[field] as MetadataValue<unknown> | undefined
    out[field] = {
      ...(cur && typeof cur === 'object' ? cur : {}),
      user: {
        value: user.value,
        observedAt: now,
        ...(user.limitations ? { limitations: user.limitations } : {})
      }
    }
  }
  for (const field of patch.clear ?? []) {
    const cur = out[field] as MetadataValue<unknown> | undefined
    if (!cur || typeof cur !== 'object') {
      delete out[field]
      continue
    }
    const rest: Record<string, unknown> = {}
    if (cur.official !== undefined) rest.official = cur.official
    if (cur.catalog !== undefined) rest.catalog = cur.catalog
    if (Object.keys(rest).length > 0) out[field] = rest
    else delete out[field]
  }
  if (Object.keys(out).length === 0) return undefined
  return out as ModelMetadata
}
