// 供应商公开预设目录（S3-10B · R4 冻结名单唯一数据源实现）。
// 只含公开元数据与纯函数：地址/协议面/必填占位/帮助来源/requestIdentity/authDefault；
// Key、模型偏好、个人规则、本机清单一律无值；模块导入无联网、无配置写入。
// 名单权威=R4 Goal + 阶段状态 frozenProviderScope（plan88 §4.1）；禁用五项只登记不提供任何生成通路。
// 官方端点取证来源=S3-00C official-endpoints.json（EP-1~6）；认证缺省=合同 authentication.presetDefaults。

export type PresetCategory = 'regular-api' | 'subscription' | 'custom' | 'local-gateway'
export type PresetProtocol = 'openai-compatible' | 'anthropic'
export type RequestIdentityMode = 'default' | 'self-ua' | 'opencode-v1'
/** 合同 authentication.enum：auto 依赖 authDefault 非 unknown；unknown 必须用户显式选择 */
export type AuthChoice = 'auto' | 'bearer' | 'x-api-key'
export type AuthDefault = 'unknown' | 'bearer' | 'x-api-key'
export type CatalogPolicy = 'fetch-or-manual' | 'manual-only'

/** 单协议面：baseUrlTemplate 可含 {占位符}（如百炼新域 {WorkspaceId}）；'' = 账号专属需用户自填（如百炼 Token Plan） */
export interface PresetProtocolFace {
  protocol: PresetProtocol
  baseUrlTemplate: string
  /** 目录/模型特殊路径元数据（如 OpenCode Go models 与聊天 base 分列、同 origin 解析） */
  paths?: { models?: string }
  notes?: string[]
}

export interface ProviderPreset {
  id: string
  category: PresetCategory
  displayName: string
  faces: PresetProtocolFace[]
  /** 必填占位字段名（如 bailian-token-plan 的套餐 base；占位未填拒保存） */
  requiredFields: string[]
  /** 窄身份策略建议值（S3-00C closure-proposal 映射；运行态注入归 S3-30T/F，不持久化运行键） */
  requestIdentity: RequestIdentityMode
  /** 合同 authentication.presetDefaults 逐字（unknown=须用户显式选择，禁止静默回退） */
  authDefault: Partial<Record<PresetProtocol, AuthDefault>>
  authDefaultSource: string
  helpUrl: string
  catalogPolicy: CatalogPolicy
  notes?: string[]
}

export interface ForbiddenPreset {
  id: string
  displayName: string
  officialReason: string
  helpUrl: string
}

const AUTH_SOURCE_UNKNOWN = '合同 authentication.presetDefaults：本阶段不把协议名等同认证头证据；新预设未知时需用户显式选择，禁止静默回退'
const AUTH_SOURCE_OFFICIAL = 'official-captured-page（S3-00C EP-1：MiniMax other-tools.md/faq.md 官方页）'
const AUTH_SOURCE_F04 = 'approved-R4-contract（F-04 官方 Bearer 主路径；保留 x-api-key 显式兼容）'

/** 普通 API/聚合 12 家（冻结名单顺序） */
const REGULAR_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    category: 'regular-api',
    displayName: 'OpenAI',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'https://api.openai.com/v1' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://platform.openai.com/docs',
    catalogPolicy: 'fetch-or-manual',
    notes: ['官方文档页本阶段 403 未取证（星瞳 G01），地址/认证保持 unverified 披露，不冒充已验']
  },
  {
    id: 'anthropic',
    category: 'regular-api',
    displayName: 'Anthropic',
    faces: [{ protocol: 'anthropic', baseUrlTemplate: 'https://api.anthropic.com' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { anthropic: 'bearer' },
    authDefaultSource: AUTH_SOURCE_F04,
    helpUrl: 'https://docs.claude.com/en/api/overview',
    catalogPolicy: 'fetch-or-manual',
    notes: ['Bearer 主路径 + x-api-key 显式兼容；不双发互斥头']
  },
  {
    id: 'google-gemini',
    category: 'regular-api',
    displayName: 'Google Gemini',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    catalogPolicy: 'fetch-or-manual',
    notes: ['兼容面已含版本段 /v1beta/——resolveApiUrl 不再补 /v1（F-01 修复断言）']
  },
  {
    id: 'xai',
    category: 'regular-api',
    displayName: 'xAI',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'https://api.x.ai/v1' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://docs.x.ai/docs/overview',
    catalogPolicy: 'fetch-or-manual'
  },
  {
    id: 'mistral',
    category: 'regular-api',
    displayName: 'Mistral',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'https://api.mistral.ai/v1' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://docs.mistral.ai/api/',
    catalogPolicy: 'fetch-or-manual'
  },
  {
    id: 'openrouter',
    category: 'regular-api',
    displayName: 'OpenRouter',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'https://openrouter.ai/api/v1' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://openrouter.ai/docs/quickstart',
    catalogPolicy: 'fetch-or-manual',
    notes: ['聚合入口；聚合平台自身价格不套底层厂商价']
  },
  {
    id: 'deepseek',
    category: 'regular-api',
    displayName: 'DeepSeek',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://api.deepseek.com' },
      { protocol: 'anthropic', baseUrlTemplate: 'https://api.deepseek.com/anthropic' }
    ],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://api-docs.deepseek.com/',
    catalogPolicy: 'fetch-or-manual',
    notes: ['官方双协议面；预设选用哪条面是产品选择']
  },
  {
    id: 'kimi-moonshot',
    category: 'regular-api',
    displayName: 'Kimi/Moonshot（按量开放平台）',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://api.moonshot.cn/v1' },
      { protocol: 'anthropic', baseUrlTemplate: 'https://api.moonshot.cn/anthropic' }
    ],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://platform.moonshot.cn/docs/api/chat',
    catalogPolicy: 'fetch-or-manual',
    notes: ['与 Kimi Code 订阅（api.kimi.com/coding）是两套产品，严格分开']
  },
  {
    id: 'zhipu-glm',
    category: 'regular-api',
    displayName: '智谱/GLM',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'https://open.bigmodel.cn/api/paas/v4' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    catalogPolicy: 'fetch-or-manual',
    notes: ['按量开放平台；GLM Coding Plan 为白名单订阅且列于禁用清单']
  },
  {
    id: 'bailian',
    category: 'regular-api',
    displayName: '阿里百炼（按量）',
    faces: [
      {
        protocol: 'openai-compatible',
        baseUrlTemplate: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        notes: ['官方现推荐新域 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1（占位须填）；旧域仍可用但为兼容说明', 'API Key 按地域绑定，跨地域 401 invalid_api_key——UI 需提示']
      }
    ],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    catalogPolicy: 'fetch-or-manual'
  },
  {
    id: 'ark',
    category: 'regular-api',
    displayName: '火山方舟（按量平台）',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://ark.cn-beijing.volces.com/api/v3' },
      { protocol: 'anthropic', baseUrlTemplate: 'https://ark.cn-beijing.volces.com/api/compatible', notes: ['Anthropic 面最终 /v1/messages 路径为机械规则推导，官方逐字待补证（S3-00C）'] }
    ],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://ark.volcengine.com/docs',
    catalogPolicy: 'fetch-or-manual',
    notes: ['平台按量面 /api/v3、/api/compatible；套餐面 /api/coding、/api/plan 属禁用清单不得混用']
  },
  {
    id: 'minimax',
    category: 'regular-api',
    displayName: 'MiniMax（按量）',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://api.minimax.cn/v1', notes: ['国际站 api.minimax.io/v1'] },
      { protocol: 'anthropic', baseUrlTemplate: 'https://api.minimax.cn/anthropic', notes: ['国际站 api.minimax.io/anthropic；不带 /v1，由 URL 规则补 /v1/messages'] }
    ],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'bearer', anthropic: 'bearer' },
    authDefaultSource: AUTH_SOURCE_OFFICIAL,
    helpUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    catalogPolicy: 'fetch-or-manual',
    notes: ['同一 base 承载两类 Key：标准 API Key 扣余额、Subscription Key 走 M Plan 额度，官方明文不可互换——订阅用途走 M Plan 预设']
  }
]

/** 订阅 6 组（官方明确允许第三方 Agent/API 客户端接入） */
const SUBSCRIPTION_PRESETS: ProviderPreset[] = [
  {
    id: 'minimax-m-plan',
    category: 'subscription',
    displayName: 'MiniMax M Plan',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://api.minimax.cn/v1', notes: ['国际站 api.minimax.io/v1'] },
      { protocol: 'anthropic', baseUrlTemplate: 'https://api.minimax.cn/anthropic', notes: ['国际站 api.minimax.io/anthropic'] }
    ],
    requiredFields: [],
    requestIdentity: 'self-ua',
    authDefault: { 'openai-compatible': 'bearer', anthropic: 'bearer' },
    authDefaultSource: AUTH_SOURCE_OFFICIAL,
    helpUrl: 'https://platform.minimax.io/docs/m-plan/other-tools.md',
    catalogPolicy: 'fetch-or-manual',
    notes: ['Subscription Key（国际 sk-cp-…）与按量 Key 官方明文不可互换', '国内/国际站条款可能不同，已分别取证']
  },
  {
    id: 'xiaomi-mimo-token-plan',
    category: 'subscription',
    displayName: '小米 MiMo Token Plan',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://token-plan-cn.xiaomimimo.com/v1' },
      { protocol: 'anthropic', baseUrlTemplate: 'https://token-plan-cn.xiaomimimo.com/anthropic' }
    ],
    requiredFields: [],
    requestIdentity: 'self-ua',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://mimo.mi.com/static/docs/tokenplan/integration/tools-overview.md',
    catalogPolicy: 'fetch-or-manual',
    notes: ['专属 Key tp-（个人）/ttp-（团队）', 'Desktop 会员为禁用项，不在本预设']
  },
  {
    id: 'kimi-code',
    category: 'subscription',
    displayName: 'Kimi Code 会员',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://api.kimi.com/coding/v1', notes: ['海外 api.kimi.ai/coding/v1；官方另支持 Responses 协议（本阶段不映射）'] },
      { protocol: 'anthropic', baseUrlTemplate: 'https://api.kimi.com/coding/', notes: ['海外 api.kimi.ai/coding/；endpoint 示例 /coding/v1/messages 与 URL 规则逐字一致'] }
    ],
    requiredFields: [],
    requestIdentity: 'self-ua',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://www.kimi.com/code/docs/',
    catalogPolicy: 'manual-only',
    notes: ['控制台 API Key 最多 5 个；官方固定 6 个模型 ID', '官方：保持工具真实身份标识，篡改 User-Agent 视为违规', '官方未列 /models 目录端点——目录手填']
  },
  {
    id: 'bailian-token-plan',
    category: 'subscription',
    displayName: '阿里百炼 Token Plan',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: '', notes: ['套餐 base 为账号专属，官方公开页未发布字面值——须用户从百炼控制台 Token Plan 页复制'] },
      { protocol: 'anthropic', baseUrlTemplate: '', notes: ['同上；协议面官方明文兼容 OpenAI 与 Anthropic'] }
    ],
    requiredFields: ['baseUrl'],
    requestIdentity: 'self-ua',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-overview',
    catalogPolicy: 'manual-only',
    notes: ['个人/团队 Key 各自独立不可混用', '误用按量 Key、Coding Plan Key 或通用 dashscope base 返回 401（官方报错表）']
  },
  {
    id: 'step-plan',
    category: 'subscription',
    displayName: '阶跃星辰 Step Plan',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://api.stepfun.com/step_plan/v1' },
      { protocol: 'anthropic', baseUrlTemplate: 'https://api.stepfun.com/step_plan', notes: ['messages 全路径 /step_plan/v1/messages 为机械规则推导，官方逐字待补证'] }
    ],
    requiredFields: [],
    requestIdentity: 'self-ua',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://platform.stepfun.com/docs/zh/step-plan/overview',
    catalogPolicy: 'fetch-or-manual',
    notes: ['高峰时段消耗为低谷 2 倍（细则页未核）']
  },
  {
    id: 'opencode-go',
    category: 'subscription',
    displayName: 'OpenCode Go / Go Plus',
    faces: [
      { protocol: 'openai-compatible', baseUrlTemplate: 'https://opencode.ai/inference/go/openai/v1', paths: { models: 'https://opencode.ai/inference/go/v1/models' } },
      { protocol: 'anthropic', baseUrlTemplate: 'https://opencode.ai/inference/go/anthropic' }
    ],
    requiredFields: [],
    requestIdentity: 'opencode-v1',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: 'https://opencode.ai/docs/go/',
    catalogPolicy: 'fetch-or-manual',
    notes: ['订阅后 Console 获取 API Key；要求真实 UA + x-opencode-session（run/operation 稳定随机键）', 'models 目录 URL=https://opencode.ai/inference/go/v1/models，与聊天 base 分列（同 origin 元数据解析）', 'Kimi Code 被官方列入“会话头支持不全”清单（非禁止）']
  }
]

/** 自定义 2 入口 + 可选本地连接模板（不针对具体厂商；magpie 只提供连接模板） */
const CUSTOM_AND_LOCAL_PRESETS: ProviderPreset[] = [
  {
    id: 'custom-openai-compatible',
    category: 'custom',
    displayName: '自定义（OpenAI-compatible）',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: '' }],
    requiredFields: ['baseUrl'],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: '',
    catalogPolicy: 'manual-only'
  },
  {
    id: 'custom-anthropic',
    category: 'custom',
    displayName: '自定义（Anthropic）',
    faces: [{ protocol: 'anthropic', baseUrlTemplate: '' }],
    requiredFields: ['baseUrl'],
    requestIdentity: 'default',
    authDefault: { anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: '',
    catalogPolicy: 'manual-only'
  },
  {
    id: 'local-magpie',
    category: 'local-gateway',
    displayName: '本地网关连接模板（可选）',
    faces: [{ protocol: 'openai-compatible', baseUrlTemplate: 'http://127.0.0.1:3425/v1' }],
    requiredFields: [],
    requestIdentity: 'default',
    authDefault: { 'openai-compatible': 'unknown', anthropic: 'unknown' },
    authDefaultSource: AUTH_SOURCE_UNKNOWN,
    helpUrl: '',
    catalogPolicy: 'manual-only',
    notes: ['只提供连接模板：不安装/不启动网关、不写其设置、不继承开发机模型清单', '默认端点为本机约定 127.0.0.1:3425/v1，用户可改']
  }
]

/** 禁用五项（冻结名单）：只登记官方原因，不提供任何预设/绕过开关 */
const FORBIDDEN_PRESETS: ForbiddenPreset[] = [
  { id: 'zhipu-glm-coding-plan', displayName: '智谱 GLM Coding Plan', officialReason: '仅限指定工具使用；用于非支持工具将被限制权益，3 次以上违规可能封禁账号', helpUrl: 'https://docs.bigmodel.cn/cn/coding-plan/usage-notes' },
  { id: 'bailian-coding-plan', displayName: '阿里百炼 Coding Plan', officialReason: '严禁 API 调用；禁止以 API 形式用于自动化脚本、应用后端或非交互式批量调用', helpUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan' },
  { id: 'xiaomi-mimo-desktop', displayName: '小米 MiMo Desktop 会员', officialReason: '仅限 Xiaomi MiMo Desktop 内使用，无 API Key', helpUrl: 'https://mimo.mi.com/docs/zh-CN/quick-start/faq/token-plan/desktop-guide' },
  { id: 'ark-coding-plan', displayName: '火山方舟 Coding Plan', officialReason: '官方明文“不能用于 API 调用”，允许面锁在具名工具集（阻断性禁用）', helpUrl: 'https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md' },
  { id: 'ark-agent-plan', displayName: '火山方舟 Agent Plan', officialReason: '文本/向量化模型不可用于 API 调用；同条款 2.8/2.11（阻断性禁用）', helpUrl: 'https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md' }
]

/** OpenCode Console：按量网关说明（不新增第13家预设，可走自定义入口） */
export const OPEN_CODE_CONSOLE_NOTE =
  'OpenCode Console/Zen 为充值 credits 后使用 API Key 的按量网关，不属于订阅；如需使用请走自定义入口填写其按量端点与 Key。'

const ALL_PRESETS: readonly ProviderPreset[] = [
  ...REGULAR_PRESETS,
  ...SUBSCRIPTION_PRESETS,
  ...CUSTOM_AND_LOCAL_PRESETS
]

/** 全量可选预设（12 普通 + 6 订阅 + 2 自定义 + 1 本地模板；不含禁用项） */
export function listProviderPresets(): readonly ProviderPreset[] {
  return ALL_PRESETS
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return ALL_PRESETS.find((p) => p.id === id)
}

/** 禁用五项：仅供展示官方原因；不提供生成通路（buildModelConfig 对其抛错） */
export function listForbiddenPresets(): ForbiddenPreset[] {
  return FORBIDDEN_PRESETS
}

export interface BaseValidation {
  ok: boolean
  reason?: string
}

/** 校验某预设某协议面的 base：空值/未填占位/含未替换花括号一律拒绝（旧域/新域规则按 notes 表达） */
export function validatePresetBase(preset: ProviderPreset, protocol: PresetProtocol, baseUrl: string): BaseValidation {
  const face = preset.faces.find((f) => f.protocol === protocol)
  if (!face) return { ok: false, reason: `预设 ${preset.id} 没有 ${protocol} 协议面` }
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    if (!face.baseUrlTemplate) {
      return {
        ok: false,
        reason:
          preset.category === 'subscription'
            ? `该订阅预设为账号专属地址（${preset.displayName}）：请从官方控制台复制套餐 Base URL，不能用按量地址冒充`
            : '接口地址为空：请填写后再保存'
      }
    }
    return { ok: false, reason: '接口地址为空' }
  }
  if (/\{[^}]*\}/.test(trimmed)) {
    return { ok: false, reason: '接口地址仍含未填占位符（{…}）：请替换为真实值后再保存' }
  }
  if (!/^https?:\/\//i.test(trimmed) && !/^http:\/\/127\.0\.0\.1/i.test(trimmed)) {
    return { ok: false, reason: '接口地址必须是 http(s) URL' }
  }
  return { ok: true }
}

export interface AuthResolution {
  ok: boolean
  /** 解析后的唯一认证头（bearer|x-api-key）；ok=false 时为空 */
  auth?: Exclude<AuthChoice, 'auto'>
  reason?: string
}

/**
 * 认证解析（合同 authentication）：auto 只在 authDefault 非 unknown 时解析为该缺省；
 * unknown + auto 拒绝（新预设须显式选择）；openai-compatible + x-api-key 明确拒绝；
 * 不猜 Key 前缀、不双发互斥头、失败不自动换认证重试。旧档缺字段兼容归 S3-10C0（本卡不涉持久化）。
 */
export function resolvePresetAuth(
  preset: ProviderPreset,
  protocol: PresetProtocol,
  choice: AuthChoice
): AuthResolution {
  if (choice === 'x-api-key' && protocol === 'openai-compatible') {
    return { ok: false, reason: 'OpenAI-compatible 协议与 x-api-key 认证不兼容：请显式选择 bearer' }
  }
  if (choice === 'bearer' || choice === 'x-api-key') return { ok: true, auth: choice }
  const known = preset.authDefault[protocol]
  if (!known || known === 'unknown') {
    return {
      ok: false,
      reason: `${preset.displayName} 的 ${protocol} 认证缺省为 unknown：请显式选择 bearer 或 x-api-key（auto 被拒绝）`
    }
  }
  return { ok: true, auth: known }
}

// ── S3-10A：模板选择→保存→读回（纯函数） ────────────────────────────────────

/** 模板连接草稿：只含连接级字段，不含 Key/模型/个人数据（切换预设不清空用户已填内容） */
export interface PresetDraftConnection {
  presetId: string
  presetName: string
  providerType: PresetProtocol
  baseURL: string
  requestIdentity: RequestIdentityMode
  authDefault: AuthDefault
  helpUrl: string
  notes: string[]
}

/** 应用预设协议面到连接草稿；无对应协议面返回 undefined */
export function applyPresetFace(
  preset: ProviderPreset,
  protocol: PresetProtocol
): PresetDraftConnection | undefined {
  const face = preset.faces.find((f) => f.protocol === protocol)
  if (!face) return undefined
  return {
    presetId: preset.id,
    presetName: preset.displayName,
    providerType: protocol,
    baseURL: face.baseUrlTemplate,
    requestIdentity: preset.requestIdentity,
    authDefault: (preset.authDefault[protocol] ?? 'unknown') as AuthDefault,
    helpUrl: preset.helpUrl,
    notes: face.notes ?? []
  }
}

export interface PresetSaveBlockers {
  ok: boolean
  blockers: string[]
}

export interface PresetSaveCheck {
  preset: ProviderPreset
  protocol: PresetProtocol
  baseURL: string
  authChoice: AuthChoice
  modelId: string
  apiKey: string
  isNewEndpoint: boolean
}

/** 保存前九条阻断校验；返回全部阻断原因（可一次给用户完整列表） */
export function presetSaveBlockers(opts: PresetSaveCheck): PresetSaveBlockers {
  const blockers: string[] = []
  const base = validatePresetBase(opts.preset, opts.protocol, opts.baseURL)
  if (!base.ok && base.reason) blockers.push(base.reason)
  if (!opts.preset.faces.some((f) => f.protocol === opts.protocol)) {
    blockers.push(`${opts.preset.displayName} 没有 ${opts.protocol} 协议面`)
  }
  const auth = resolvePresetAuth(opts.preset, opts.protocol, opts.authChoice)
  if (!auth.ok && auth.reason) blockers.push(auth.reason)
  if (opts.isNewEndpoint && !opts.modelId.trim()) {
    blockers.push('请填写模型 ID')
  }
  if (opts.isNewEndpoint && !opts.apiKey.trim()) {
    blockers.push('请填写 API Key')
  }
  return { ok: blockers.length === 0, blockers }
}

export interface PresetEntryMerge {
  requestIdentity: RequestIdentityMode
  authentication: Exclude<AuthChoice, 'auto'>
}

/** 把模板身份/认证安全合并进既有模型条目；id/model/name/settings/metadata 原样保留 */
export function mergePresetIntoEntry(
  preset: ProviderPreset,
  entry: { id?: string; model?: string; name?: string; metadata?: unknown; settings?: Record<string, unknown> },
  concreteAuth: Exclude<AuthChoice, 'auto'>
): {
  id?: string
  model?: string
  name?: string
  metadata?: unknown
  settings: Record<string, unknown> & {
    requestIdentity?: RequestIdentityMode
    authentication: Exclude<AuthChoice, 'auto'>
  }
} {
  // S3-10A-R1 / R2A1：两字段持久化位置=entry.settings（非条目顶层）；id/metadata/model/name/settings 原样保留
  const settings = {
    ...(entry.settings ?? {}),
    ...(preset.requestIdentity !== 'default' ? { requestIdentity: preset.requestIdentity } : {}),
    authentication: concreteAuth
  }
  return {
    ...(entry.id ? { id: entry.id } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    settings
  }
}

export interface ProtocolSwitchResult {
  changed: boolean
  protocol: PresetProtocol
  baseURL: string
  authDefault: AuthDefault
  requestIdentity: RequestIdentityMode
}

export function handleProtocolSwitch(
  preset: ProviderPreset | undefined,
  protocol: PresetProtocol,
  currentBaseURL: string
): ProtocolSwitchResult {
  if (!preset) {
    return {
      changed: false,
      protocol,
      baseURL: currentBaseURL,
      authDefault: 'unknown',
      requestIdentity: 'default'
    }
  }
  const face = preset.faces.find((f) => f.protocol === protocol)
  if (!face) {
    return {
      changed: false,
      protocol,
      baseURL: currentBaseURL,
      authDefault: 'unknown',
      requestIdentity: 'default'
    }
  }
  return {
    changed: true,
    protocol,
    baseURL: face.baseUrlTemplate,
    authDefault: (preset.authDefault[protocol] ?? 'unknown') as AuthDefault,
    requestIdentity: preset.requestIdentity
  }
}
