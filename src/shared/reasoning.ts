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

// ── 缺口 C 的出境形状（plan58 片② R15 / R16）────────────────────────────────
//
// `effortToSend` 之外的两条通道此前是空壳：`toggle` 的开关与 `budget_tokens` 的预算
// 存得进、发不出。下面两个函数补上出境判定 —— 与 `effortToSend` 同一条纪律：
// **主进程发不发、界面披露什么，读同一份判定**，两份判定会漂的症状是
// "界面说生效、实际没发"（R5 同族）。

/** 出境判定需要的输入形状（`ReasoningConfig` 的最小子集，便于单测构造） */
export interface ReasoningOutboundInput {
  reasoningEffort: string
  reasoning?: {
    kind: string
    enabled?: boolean
    budget?: number
    budgetEncoding?: string
    offEncoding?: string
  }
}

/**
 * openai-compatible 通路上 `toggle` / `budget_tokens` 的请求体字段（R15 / R16）。
 * `effort` 形态走 `effortToSend` 既有通道（`reasoning_effort`），本函数**不碰它** ——
 * kind 非 effort 时 `effortToSend` 已返回 null，两边相加不会双发。
 *
 * 一切"未声明"都落在**不发**（与 `omit` 同一口径），由界面照实披露 ——
 * 替用户猜一个厂商方言字段，就是拿猜测冒充承诺（R9）。
 */
export function openaiReasoningFields(settings: ReasoningOutboundInput): Record<string, unknown> {
  const cfg = settings.reasoning
  if (!cfg) return {}
  const fields: Record<string, unknown> = {}

  if (cfg.kind === 'toggle') {
    // 没设过开关 = 维持厂商默认，什么都不发
    if (typeof cfg.enabled !== 'boolean') return {}
    switch (cfg.offEncoding) {
      case 'enable_thinking_false':
        fields['enable_thinking'] = cfg.enabled
        break
      case 'chat_template_kwargs':
        fields['chat_template_kwargs'] = { enable_thinking: cfg.enabled }
        break
      case 'reasoning_enabled_false':
        fields['reasoning'] = { enabled: cfg.enabled }
        break
      case 'effort_minimal':
        // 开的一侧没有对称线形（不存在 `reasoning_effort:'最强'`）⇒ 只有关的一侧发
        if (!cfg.enabled) fields['reasoning_effort'] = 'minimal'
        break
      default:
        // omit（或未声明）：不发。对默认开思考的端点这等于"关不掉"，界面必须披露。
        break
    }
    return fields
  }

  if (cfg.kind === 'budget_tokens') {
    const budget = cfg.budget ?? 0
    if (budget <= 0) return {} // 预算 0 不是合法出境值，视同未设
    switch (cfg.budgetEncoding) {
      case 'thinking_budget':
        fields['thinking_budget'] = budget
        break
      case 'reasoning_max_tokens':
        fields['reasoning'] = { max_tokens: budget }
        break
      default:
        // 未声明预算字段：预算留在档案里，但不出境（否则发出去的字段是猜的）
        break
    }
  }
  return fields
}

/**
 * anthropic 通路的思考预算（kind 感知版，片② 修的**暗病**在此）：
 * `thinkingBudgetFor` 只看 `reasoningEffort` 不看 `kind` —— `kind:'none'`（不支持思考）或
 * `kind:'toggle'` 的模型在 openai 侧发不出档位（R11′ 保证），到 anthropic 侧却会照发思考。
 * 「inert 数据永不出境」这条不变量必须在两条通路上同时成立。
 *
 * - `kind:'budget_tokens'`：用**声明的预算**（协议原生吃 `thinking.budget_tokens`，无需编码声明）；
 * - `kind:'none'` / `kind:'toggle'`：不发。toggle 的"关"在 anthropic 上恰好就是不发 thinking 块；
 *   "开"的一侧没有"强制开思考"的线形 ⇒ 同样不发（协议限制，界面披露）。
 * - `kind:'effort'` 或未声明 `reasoning`：走原 `thinkingBudgetFor`（存量行为逐字节不变）。
 */
export function anthropicThinkingBudget(
  settings: ReasoningOutboundInput,
  maxTokens: number,
  effortBudgetFor: (effort: string, maxTokens: number) => number | null
): number | null {
  const cfg = settings.reasoning
  if (cfg) {
    if (cfg.kind === 'none' || cfg.kind === 'toggle') return null
    if (cfg.kind === 'budget_tokens') {
      const budget = cfg.budget ?? 0
      if (budget <= 0) return null
      const ceiling = maxTokens - 1024
      if (ceiling < 1024) return null
      return Math.min(budget, ceiling)
    }
  }
  return effortBudgetFor(settings.reasoningEffort, maxTokens)
}

/**
 * 两个编码的**界面文案**（设置页声明下拉与输入框 chip 的披露共用这一份 ——
 * 文案写两份迟早漂，漂了的症状是"声明页与 chip 说的不是同一个字段"）。
 */
export const BUDGET_ENCODING_LABELS: Readonly<Record<string, string>> = {
  thinking_budget: 'thinking_budget（百炼）',
  reasoning_max_tokens: 'reasoning.max_tokens（OpenRouter）'
}

export const OFF_ENCODING_LABELS: Readonly<Record<string, string>> = {
  omit: '不发信号（部分端点将无法关闭）',
  enable_thinking_false: 'enable_thinking: false',
  chat_template_kwargs: 'chat_template_kwargs.enable_thinking',
  reasoning_enabled_false: 'reasoning: { enabled: false }',
  effort_minimal: 'reasoning_effort: minimal（压到最低档）'
}
