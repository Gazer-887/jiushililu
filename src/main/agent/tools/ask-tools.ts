import { z } from 'zod'
import type { AgentTool } from '@shared/agent'
import {
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  type AskAnswer,
  type AskOption,
  type AskRequest
} from '@shared/ask'

// 向用户提问工具（带选项）—— 补的缺口：Agent 遇到"需要用户拿主意"的地方只能猜着往下做，
// 或把选项写进正文让用户打字回（多轮，还容易答歪）。与危险操作确认分开：那个是安全闸，这个是信息通道。

/** 问句上限：模型爱把整段分析塞进 question，界面会被撑爆 */
const MAX_QUESTION = 500
/** 单个选项文案/说明上限 */
const MAX_LABEL = 80
const MAX_DESC = 200

/** 提问口（依赖倒置，同 TodoReporter / SubagentDispatcher）：工具层不碰窗口与 IPC，conversationId 由注入方补 */
export interface AskReporter {
  ask(req: Omit<AskRequest, 'id'>): Promise<AskAnswer>
}

// 工具 schema 给模型看，执行时还要再校一遍：模型可以无视 schema 乱传（尤其 hand-written 客户端）。
const argsSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(MAX_LABEL),
        description: z.string().trim().max(MAX_DESC).optional()
      })
    )
    .min(ASK_MIN_OPTIONS)
    .max(ASK_MAX_OPTIONS),
  multiSelect: z.boolean().optional()
})

/** 未作答原因的措辞：中英并列，模型与界面都读得懂。
 *  ⚠️ `skipped` **不在这张表里**：它是用户**主动**给的答复（"这条路我不要"），措辞必须与"没人理"分开写 ——
 *  混进同一句「用户没有回答（…）」里，模型会把"明确拒绝"读成"用户没看见"，然后照样往下走。 */
const NO_ANSWER_TEXT: Record<
  Exclude<Extract<AskAnswer, { answered: false }>['reason'], 'skipped'>,
  string
> = {
  timeout: '超时未答复 timeout',
  aborted: '提问被中断 aborted',
  'no-window': '界面不可用 no-window'
}

const UNANSWERED_TAIL = '—— 不要把这当成同意或默认选项，可以换个问法或继续下一步'

function formatAnswer(answer: AskAnswer): string {
  if (!answer.answered) {
    if (answer.reason === 'skipped') return `用户跳过了这个问题 skipped${UNANSWERED_TAIL}`
    return `用户没有回答（${NO_ANSWER_TEXT[answer.reason]}）${UNANSWERED_TAIL}`
  }
  // 自填的文字是**答案本身**（可以不在选项里）：只在它时回它，与选项并存时并列回——两条都不能吞
  if (answer.text && answer.labels.length === 0) return `用户回答：${answer.text}`
  if (answer.text) return `用户选择：${answer.labels.join('、')}；用户补充：${answer.text}`
  // 桥保证作答必带 label；上游换了实现时兜一句，免得回出「用户选择：」这种空话
  if (answer.labels.length === 0) return `用户没有回答（回执无效）${UNANSWERED_TAIL}`
  return `用户选择：${answer.labels.join('、')}`
}

export function createAskTools(reporter: AskReporter): AgentTool[] {
  const ask_user: AgentTool = {
    schema: {
      name: 'ask_user',
      description:
        '向用户提问并给出选项，用户点一下即作答。遇到**需要用户拿主意**的地方（方向取舍、偏好、选哪个方案）' +
        '不要自己猜，用本工具问清楚再动手。' +
        `选项给 ${ASK_MIN_OPTIONS}–${ASK_MAX_OPTIONS} 个，每个选项是一句话的选择（label），可用 description 补充说明；` +
        'multiSelect=true 表示可多选（默认单选）。' +
        '开放问题（答案不是有限的几个选项）请**直接用文字问用户，不要调本工具**。' +
        '用户没回答时结果会写明"没有回答"——那不等于同意，也不是默认选项，可以换个问法或继续下一步。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: `要问用户的问题（${MAX_QUESTION} 字以内，把必要的上下文写进去，别只丢一个词）`
          },
          options: {
            type: 'array',
            description: `选项列表（${ASK_MIN_OPTIONS}–${ASK_MAX_OPTIONS} 个；少于 ${ASK_MIN_OPTIONS} 个就不是选择题，改用文字问）`,
            minItems: ASK_MIN_OPTIONS,
            maxItems: ASK_MAX_OPTIONS,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: `选项文案（${MAX_LABEL} 字以内，短句）` },
                description: {
                  type: 'string',
                  description: `选项补充说明（${MAX_DESC} 字以内，可省）`
                }
              },
              required: ['label']
            }
          },
          multiSelect: { type: 'boolean', description: '是否允许多选（默认 false）' }
        },
        required: ['question', 'options']
      }
    },
    async execute(args) {
      const parsed = argsSchema.safeParse(args)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        const where = first && first.path.length > 0 ? first.path.join('.') : '入参'
        return (
          `错误：${where} 不合要求（${first?.message ?? '校验失败'}）；本工具需要 ${ASK_MIN_OPTIONS}–${ASK_MAX_OPTIONS} 个选项，` +
          '开放问题请直接用文字问用户，不要调本工具'
        )
      }

      const options: AskOption[] = parsed.data.options.map((o, i) => ({
        // 值由工具层生成：模型只给文案，值与文案解耦后，界面回传值、桥再按值还原 label
        value: `opt-${i + 1}`,
        label: o.label,
        description: o.description
      }))

      const answer = await reporter.ask({
        question: parsed.data.question,
        options,
        multiSelect: parsed.data.multiSelect,
        tool: 'ask_user'
      })
      return formatAnswer(answer)
    }
  }

  return [ask_user]
}
