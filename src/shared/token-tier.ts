/**
 * **省 token 档位**（plan8 R9.1 §七②）—— 纯逻辑：不 import electron、不碰 IO、不认识网络。
 *
 * ## 为什么做成"档位"而不是几个散开关
 *
 * 用户 2026-09-12 定调（**红线级**）：**省 token 不许让模型降智**。
 * 于是"能力 vs 省钱"这个取舍不替用户默认，而是**摆出来让他挑**：
 *
 * | 档位 | 一句话 |
 * |---|---|
 * | **土豪** `rich` | 不做任何省 token 的配置（用户原话："照顾一下冤大头的选择权"） |
 * | **极致** `ultimate` | 只做**零代价**的省：塞不下才压、尽量少动 |
 * | **平衡** `balanced`（默认） | 兼顾模型能力与省 token |
 * | **轻量** `light` | 最省；允许质量略降 |
 *
 * ## 三条红线**与档位无关**（它们是正确性，不是省钱开关，**不许做成可关**）
 *
 * 1. **不静默截断** —— 每一次成形都要留痕（界面 + 日志），模型也要被告知"这不是全部"
 * 2. **不压报错现场** —— 命中报错的行连同上下文强制保留
 * 3. **不伪造缺失数据** —— 厂商没报就说没报（这一条在 `@shared/usage` 里守着）
 *
 * 并且：轻量档的"掉质量"**只允许来自"更常压缩、给更少上下文"**，
 * **不许来自"骗模型"**（偷偷换掉它的工具输出、却告诉它这是全文）。
 * 把这段写在这里，是给以后的自己看的：**加第 5 档时不许拿这三条做交换**。
 *
 * ## 一条接口纪律
 *
 * **调用方只认 `policy`，不认档位名。** 于是"改某档的取值""加第 5 档"都只动这一个文件，
 * 调用点一行都不用改 —— 这也是为什么 `resolvePolicy` 是唯一的出口。
 */

/** 四档（顺序即设置页的显示顺序：从最不省到最省） */
export type TokenSaverTier = 'rich' | 'ultimate' | 'balanced' | 'light'

/** 默认档位：**平衡**（用户定调） */
export const DEFAULT_TOKEN_TIER: TokenSaverTier = 'balanced'

/**
 * 一份档位解析出来的**全部开关取值**。
 *
 * ⚠️ 这里只放**真的已经接线**的开关。`reasoningEffort`、"输出纪律提示"、
 * 历史压缩阈值那些属于 §七③，**不写进来假装有** —— 那种"配置里看着有、实际没人读"的字段
 * 比没有更坏（用户以为调了，其实没生效）。
 */
export interface TokenPolicy {
  tier: TokenSaverTier
  /** 工具输出窗口化**总开关**（土豪档 = false：完全不动工具输出，原样进上下文） */
  windowEnabled: boolean
  /** 小于这个字节数**不进判断**（小输出压了也不省，还白冒"消息被改"的风险） */
  minBytes: number
  /** 字节门：压完不得超过原始的这个比例 */
  keepRatioMax: number
  /** 绝对预算（估算 token）：压完不许超过它 —— 超了厂商直接报"超出上下文"，**整轮作废** */
  maxTokens: number
  /** `read_file` 没显式给 `limit` 时默认读多少行 */
  readLines: number
}

/**
 * 四档取值表（依据 `plan8` R9.1 的档位表；改这里 = 改档位行为，**必须同时想一遍三条红线**）。
 *
 * 土豪档的几个数看着"很大"，是有意的：它是**双保险**。
 * `windowEnabled: false` 已经把它关掉了，但万一哪天有人只看数值不看开关，
 * 这几个值也保证"压不动"—— 而不是误压成别档的行为。
 */
const POLICIES: Record<TokenSaverTier, TokenPolicy> = {
  rich: {
    tier: 'rich',
    windowEnabled: false,
    minBytes: Number.MAX_SAFE_INTEGER,
    keepRatioMax: 1,
    maxTokens: Number.MAX_SAFE_INTEGER,
    readLines: 2000
  },
  ultimate: {
    tier: 'ultimate',
    windowEnabled: true,
    minBytes: 6000,
    keepRatioMax: 0.85,
    maxTokens: 16000,
    readLines: 800
  },
  balanced: {
    tier: 'balanced',
    windowEnabled: true,
    minBytes: 1400,
    keepRatioMax: 0.72,
    maxTokens: 8000,
    readLines: 200
  },
  light: {
    tier: 'light',
    windowEnabled: true,
    minBytes: 600,
    keepRatioMax: 0.5,
    maxTokens: 4000,
    readLines: 100
  }
}

export function isTokenSaverTier(value: unknown): value is TokenSaverTier {
  return value === 'rich' || value === 'ultimate' || value === 'balanced' || value === 'light'
}

/**
 * 档位 → 开关取值。**唯一出口**。
 *
 * 认不出来的值（老配置、手改坏的 json、undefined）一律**回落到默认档**，
 * 不抛错也不静默当成"最省"—— 后者会让一次配置事故变成"模型突然变笨"。
 */
export function resolvePolicy(tier: unknown): TokenPolicy {
  return isTokenSaverTier(tier) ? POLICIES[tier] : POLICIES[DEFAULT_TOKEN_TIER]
}

/** 设置页要用的档位元信息（中文名 + 一句话说明） */
export interface TokenTierInfo {
  tier: TokenSaverTier
  label: string
  note: string
}

/** 设置页的档位清单（顺序 = 从"最不省"到"最省"） */
export const TOKEN_TIER_LIST: readonly TokenTierInfo[] = [
  { tier: 'rich', label: '土豪', note: '不做任何省 token 的配置：工具输出原样进上下文（最贵，但模型看到的最全）' },
  { tier: 'ultimate', label: '极致', note: '只做零代价的省：塞不下时才压，尽量少动' },
  { tier: 'balanced', label: '平衡', note: '兼顾模型能力与节省（默认）' },
  { tier: 'light', label: '轻量', note: '最省：更常压缩、给更少上下文；允许质量略降，但不骗模型' }
]

/** 档位的中文名（没认出来就报"平衡"—— 跟 `resolvePolicy` 的回落保持一致） */
export function tierLabel(tier: unknown): string {
  const hit = TOKEN_TIER_LIST.find((t) => t.tier === tier)
  return hit ? hit.label : '平衡'
}
