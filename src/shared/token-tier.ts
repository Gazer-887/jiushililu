/**
 * **省 token 档位**（plan8 R9.1 §七②）—— 纯逻辑：不 import electron、不碰 IO、不认识网络。
 *
 * 为什么是"档位"而非几个散开关：用户定调（**红线级**）**省 token 不许让模型降智**，
 * 于是"能力 vs 省钱"不替用户默认，摆出来让他挑（四档见 `TOKEN_TIER_LIST`）。
 * 三条红线**与档位无关**（是正确性，不许做成可关）：不静默截断、不压报错现场、不伪造缺失数据；
 * 轻量档掉质量只许来自"更常压缩、给更少上下文"，**不许来自骗模型** —— 加第 5 档不许拿这些做交换。
 * 调用方**只认 `policy`、不认档位名**，故改某档取值、加档都只动这一个文件。
 */

import type { ReasoningEffort } from './ipc'

/** 四档（顺序即设置页的显示顺序：从最不省到最省） */
export type TokenSaverTier = 'rich' | 'ultimate' | 'balanced' | 'light'

/** 默认档位：**平衡**（用户定调） */
export const DEFAULT_TOKEN_TIER: TokenSaverTier = 'balanced'

/**
 * 一份档位解析出来的**全部开关取值**。
 * ⚠️ 只放**真的已经接线**的开关 —— "配置里看着有、实际没人读"的字段比没有更坏（用户以为调了）。
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
  /**
   * **思考强度覆盖**（§七③）。`null` = 不动用户档案里的设置 —— 默认也是保守方向：
   * 用户在模型档案里精心配的 `reasoningEffort` 是他自己的判断，全局档位不该无端改它；
   * 只有轻量档压到 `'low'`（那一档用户已明确说了"允许质量略降"）。
   * 这条最值钱：DSH 面板实测输出里 52% 是推理（输出 3.08M / 推理 1.60M），而思考链按输出 token 计费。
   */
  reasoningEffortOverride: ReasoningEffort | null
  /**
   * **输出纪律提示**的强度（§七③）：0 = 不加、1 = 标准（先结论 / 不复述）、2 = 再加限长。
   * 为什么也算"省"：输出的钱花在**字数**上，而模型的习惯是"把想过的再说一遍"。
   * 但必须**明说** —— 轻量档掉质量不许来自"骗模型"（偷偷改掉它的工具输出却说是全文）。
   */
  outputDiscipline: 0 | 1 | 2
}

/**
 * 四档取值表（依据 `plan8` R9.1 的档位表；改这里 = 改档位行为，**必须同时想一遍三条红线**）。
 * 土豪档那几个数看着"很大"是有意的（**双保险**）：`windowEnabled: false` 已经把它关掉了，
 * 但万一有人只看数值不看开关，这些值也保证"压不动"，而不是误压成别档的行为。
 */
const POLICIES: Record<TokenSaverTier, TokenPolicy> = {
  rich: {
    tier: 'rich',
    windowEnabled: false,
    minBytes: Number.MAX_SAFE_INTEGER,
    keepRatioMax: 1,
    maxTokens: Number.MAX_SAFE_INTEGER,
    readLines: 2000,
    reasoningEffortOverride: null,
    outputDiscipline: 0
  },
  ultimate: {
    tier: 'ultimate',
    windowEnabled: true,
    minBytes: 6000,
    keepRatioMax: 0.85,
    maxTokens: 16000,
    readLines: 800,
    reasoningEffortOverride: null,
    outputDiscipline: 0
  },
  balanced: {
    tier: 'balanced',
    windowEnabled: true,
    minBytes: 1400,
    keepRatioMax: 0.72,
    maxTokens: 8000,
    readLines: 200,
    reasoningEffortOverride: null,
    outputDiscipline: 1
  },
  light: {
    tier: 'light',
    windowEnabled: true,
    minBytes: 600,
    keepRatioMax: 0.5,
    maxTokens: 4000,
    readLines: 100,
    reasoningEffortOverride: 'low',
    outputDiscipline: 2
  }
}

export function isTokenSaverTier(value: unknown): value is TokenSaverTier {
  return value === 'rich' || value === 'ultimate' || value === 'balanced' || value === 'light'
}

/**
 * 档位 → 开关取值。**唯一出口**。
 * 认不出来的值（老配置、手改坏的 json、undefined）一律**回落到默认档**，不抛错也不静默当成
 * "最省" —— 后者会让一次配置事故变成"模型突然变笨"。
 */
export function resolvePolicy(tier: unknown): TokenPolicy {
  return isTokenSaverTier(tier) ? POLICIES[tier] : POLICIES[DEFAULT_TOKEN_TIER]
}

/** 设置页要用的档位元信息 */
export interface TokenTierInfo {
  tier: TokenSaverTier
  label: string
  note: string
}

export const TOKEN_TIER_LIST: readonly TokenTierInfo[] = [
  {
    tier: 'rich',
    label: '土豪',
    note: '不做任何省 token 的配置：工具输出原样进上下文，也不加输出要求（最贵，但模型看到的最全、最放得开）'
  },
  {
    tier: 'ultimate',
    label: '极致',
    note: '只做零代价的省：塞不下时才压，尽量少动；不加输出纪律'
  },
  {
    tier: 'balanced',
    label: '平衡',
    note: '兼顾模型能力与节省（默认）：压得克制，并要求回答先给结论、不复述工具原文'
  },
  {
    tier: 'light',
    label: '轻量',
    note: '最省：更常压缩、给更少上下文，思考强度降到低，回答要求更简短；允许质量略降，但不骗模型'
  }
]

/** 档位的中文名（没认出来就报"平衡"—— 跟 `resolvePolicy` 的回落保持一致） */
export function tierLabel(tier: unknown): string {
  const hit = TOKEN_TIER_LIST.find((t) => t.tier === tier)
  return hit ? hit.label : '平衡'
}

/**
 * 按档位给出**输出纪律提示**（§七③）；`null` = 这一档不加。
 * 为什么能省：输出的钱花在**字数**上，而模型默认习惯里三块纯浪费 —— 复述推理过程、
 * 复述工具返回的原文、重述用户的问题；这三条**不损害正确性**（少说冗余、不少依据），故归"平衡"档。
 * ⚠️ 必须**静态**（§七④ 前缀稳定）：同一档位每次拼出来完全一样 —— 换档让前缀缓存失效一次可接受，
 * **绝不许**把时间戳 / 轮数 / 会话 id 这类每轮都变的东西塞进来。
 */
export function outputDisciplinePrompt(level: 0 | 1 | 2): string | null {
  if (level <= 0) return null
  const lines = [
    '**输出纪律（省 token，但不省准确性）**：',
    '1. **先给结论，再给必要依据。** 不要把推理过程当正文复述一遍 ——',
    '   你想过什么是你的事，用户要的是答案。',
    '2. **不要复述工具返回的原文。** 要引用就只引关键那几行，其余写"详见工具输出"。',
    '3. **不要复述用户的问题。** 直接回答，不要先"你问的是……"再答。'
  ]
  if (level >= 2) {
    lines.push(
      '4. **篇幅克制**：常规回答控制在 400 字以内（代码、清单、必要引用除外）；',
      '   能一句话说清就别写三段。'
    )
  }
  return lines.join('\n')
}
