/**
 * 思考档位的**出境判定**（plan58 片⓪，openai 侧与 Anthropic 侧同一条降级路径）。
 *
 * 为什么单独一个文件：`anthropic.ts` / `openai.ts` / `openai-agent.ts` 都要问同一个问题
 * （"这个档名该不该发出去"），而 `ReasoningEffort` 改成开放字符串之后，**答案不再等于
 * "不是 default"**。三处各写一遍就会漂 —— 与其让人记得在第四处补上，不如把判定收成一处。
 */
import type { ModelSettings } from '@shared/ipc'

/**
 * 我们**已登记**的档名。⚠️ 它**不是**"支持哪些厂商"的清单 —— 那按模型存
 * （`ModelSettings.reasoning.levels`，plan58 R6），这里是"不认识的一律不发"的兜底词表。
 * 取 `anthropic.ts · EFFORT_BUDGET` 的键，两边不会各认一批。
 */
const KNOWN_EFFORTS = new Set(['low', 'medium', 'high', 'max'])

/**
 * 该不该把 `reasoning_effort` 发出去；不发则返回 `null`。
 *
 * 两条判定，缺一不可：
 * 1. `default` 是哨兵 = **不发字段**（plan58 R8），不是厂商值。
 * 2. **该模型自己声明了 `levels` 就以它为准** —— 含 `xhigh` / `minimal` 这类我们没登记的
 *    官方值，用户既然明确声明了支持，就该发。没声明才退回我们的兜底词表
 *    （存量档案的值全在词表内 ⇒ 这一步不改变任何现有行为）。
 *
 * ⚠️ **为什么不能原样直发**：`ReasoningEffort` 改开放字符串后，用户手改存档填一个打错的
 * 档名（`hihg`）会被原样塞进 `reasoning_effort`，严格端点回 400 且**每一次请求都失败**
 * （含 Agent 主循环多轮），报错是厂商原话，用户无从知道是自己那个档名。
 * 这与 `thinkingBudgetFor` 查不到预算就不开思考是同一条降级路径。
 *
 * ⚠️ **诚实性缺口（片① 必须补）**：降级是静默的 —— 用户填了 `xhigh` 而端点实际不吃，
 * 界面上必须如实说"该档未实测/该端点可能不支持"，否则就是"调了不生效"的假开关。
 */
export function effortToSend(settings: Pick<ModelSettings, 'reasoningEffort' | 'reasoning'>): string | null {
  const effort = settings.reasoningEffort
  if (effort === 'default') return null
  const levels = settings.reasoning?.kind === 'effort' ? settings.reasoning.levels : undefined
  if (levels) return levels.includes(effort) ? effort : null
  return KNOWN_EFFORTS.has(effort) ? effort : null
}
