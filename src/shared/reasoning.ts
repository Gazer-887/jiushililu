/**
 * 思考档位的**出境判定 + 档位序**（plan58 R6 / R11′，主进程与渲染层共用）。
 *
 * ⚠️ **为什么放 `shared/` 而不是 `main/providers/`**（09-28 定）：两处都要用同一份判定 ——
 * 主进程出境时按它决定发不发（`providers/openai.ts · buildOpenAIChatBody` 等），
 * 渲染层按它显示"设了但没生效"（`ModelCatalogEditor` 的 trouble 行）。
 * 放一份在 main、界面另算一份 ⇒ **两份判定会漂**，而漂了的症状是
 * "界面说生效、实际没发"——正是 R5「不披露就加控件 = 把协议限制伪装成用户的选择」要防的。
 * 且这条文件**不 import electron**：渲染层要 import 它（见 `AGENTS.md` §八那条红线）。
 */

/**
 * **规范强度序**（跨厂商通用的一档）。抄自 Zcode 的 `Effort` 枚举
 * （`zerx-lab/zcode` · `packages/catalog/src/effort.ts`：`minimal/low/medium/high/xhigh/max`），
 * 它的 `ThinkingConfig.efforts` 就是"supported levels **in canonical order**"。
 *
 * ⚠️ **它与 R6 不冲突，别混**：R6 说「**可用集合**按模型存」（`reasoning.levels`），
 * 而这张表说的是「这些档名之间**谁比谁强**」——后者是跨厂商的共同语义。
 * 没有它，界面就只能按用户输入的顺序显示，而用户是先加 `max` 再加 `low` 的。
 * ⚠️ **不在表内的档名**（厂商自造词）排在**末尾**，保持输入序 —— 猜测一个强度可能排错档。
 */
export const EFFORT_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 档位排序（弱 → 强）。**不在强度表内的排末尾、彼此保持原相对顺序**（`sort` 稳定）。 */
export function sortEffortLevels(levels: readonly string[]): string[] {
  return [...levels].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a)
    const ib = EFFORT_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return 0
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

/**
 * 我们**已登记**的档名。⚠️ 它**不是**"支持哪些厂商"的清单 —— 那按模型存
 * （`ModelSettings.reasoning.levels`），这里是"不认识的一律不发"的兜底词表。
 * 取值取自 `EFFORT_ORDER` 去掉 `minimal`/`xhigh`（这两档我们**没有实测过**任何端点支持，
 * 见 plan58 §丁「三家一格都没实测过」）—— 登记它们会让"未实测"变成"我们认为支持"。
 */
const KNOWN_EFFORTS = new Set(['low', 'medium', 'high', 'max'])

/** 判定"该不该发"所需的最小输入（不收整个 `ModelSettings`：出处层比它全） */
export interface EffortOutboundInput {
  reasoningEffort: string
  reasoning?: { kind: string; levels?: string[] }
}

/** 该不该把 `reasoning_effort` 发出去；不发则 `null`。**主进程与界面共用这一份判定。** */
export function effortToSend(settings: EffortOutboundInput): string | null {
  const effort = settings.reasoningEffort
  if (effort === 'default') return null
  const reasoning = settings.reasoning
  if (reasoning) {
    // `none` 是"不支持思考"、`toggle` 只有开关没有强度、`budget_tokens` 收整数预算
    // ⇒ 这三种形态**没有"档位"这条通道**，此刻的档位是 inert 数据（存着无害、永不出境）
    if (reasoning.kind !== 'effort') return null
    const levels = reasoning.levels
    if (levels) return levels.includes(effort) ? effort : null
  }
  return KNOWN_EFFORTS.has(effort) ? effort : null
}

/**
 * 已知词表（界面上"没填 levels 时列哪几档"要用）。
 * ⚠️ **它不是建议清单** —— 真实档位必须由用户在模型上自己声明（`levels`），
 * 因为我们三家端点的实际支持情况**一格都没实测过**（plan58 R9）。
 */
export const KNOWN_EFFORT_LEVELS: readonly string[] = [...KNOWN_EFFORTS]

/**
 * `+` 按钮的候选池：已知词表 + 强度表里我们没登记的档（`minimal` / `xhigh`）——
 * 官方确有这两个值（plan58 09-27 查证：Azure 文档 + Anthropic SDK），只是我们没实测过。
 * 界面标「未实测」即可，**不许因为没测过就不让用户选**（那等于替厂商下结论，违反 R9）。
 */
export const ADDABLE_EFFORT_LEVELS: readonly string[] = [...EFFORT_ORDER]
