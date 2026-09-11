import type { AgentTool } from '@shared/agent'

// 子代理派发工具（plan7 批 D / plan6 V2）—— 让主代理能把**独立子任务并行**派出去。
//
// 为什么要有这个工具：scheduler 早就写好了（并发上限 + 单代理预算 + 独立上下文 + 白名单门控），
// 但**没有任何入口能触发它** —— 于是"子代理"在界面上永远是一片空白。
// 接上这个工具之后，"谁在跑"才有东西可看。

/** 单次派发的作业数上限（并发上限是 3，一次派太多只会在队列里占着） */
export const MAX_JOBS = 6

/** 单份任务书长度上限 */
const MAX_TASK = 4000

export interface SubagentDispatchJob {
  agent: string
  task: string
}

/**
 * 派发口（依赖倒置，同 TodoReporter / WriteRecorder）：
 * 工具层不碰 registry 与模型通道 —— 那些在 runner 里，由它注入实现。
 */
export interface SubagentDispatcher {
  /** 派发并等结果；返回值是给模型看的汇总文本（校验失败也用人话回） */
  dispatch(jobs: SubagentDispatchJob[]): Promise<string>
}

/** 归一化模型给的 jobs（与 normalizeTodos 同一条思路：模型给什么都可能） */
export function normalizeJobs(raw: unknown): SubagentDispatchJob[] {
  if (!Array.isArray(raw)) return []
  const out: SubagentDispatchJob[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const agent = typeof rec['agent'] === 'string' ? rec['agent'].trim() : ''
    const task = typeof rec['task'] === 'string' ? rec['task'].trim() : ''
    if (!agent || !task) continue
    out.push({ agent, task: task.slice(0, MAX_TASK) })
  }
  return out
}

export function createSubagentTools(dispatcher: SubagentDispatcher): AgentTool[] {
  const spawn_agents: AgentTool = {
    schema: {
      name: 'spawn_agents',
      description:
        '把若干**相互独立**的子任务并行派给子代理执行。子代理各有独立上下文、看不到主对话，' +
        '所以任务书必须自包含（它不知道你在跟用户聊什么）。' +
        '适合可并行的独立工作，例如同时审阅几个文件、分别调研几个方向；' +
        '有先后依赖、需要来回确认的活不要派，自己做。返回每个子代理的结果摘要。',
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            description: `要派发的作业（并行执行，一次最多 ${MAX_JOBS} 个）`,
            items: {
              type: 'object',
              properties: {
                agent: { type: 'string', description: '子代理名字（必须是已注册的定义名）' },
                task: { type: 'string', description: '交给它的完整任务书（它看不到主对话）' }
              },
              required: ['agent', 'task']
            }
          }
        },
        required: ['jobs']
      }
    },
    async execute(args) {
      const jobs = normalizeJobs(args['jobs'])
      if (jobs.length === 0) return '错误：jobs 不能为空，且每一项都需要 agent 与 task'
      if (jobs.length > MAX_JOBS) {
        return `错误：一次最多派 ${MAX_JOBS} 个作业（收到 ${jobs.length} 个），请拆成几批`
      }
      return dispatcher.dispatch(jobs)
    }
  }

  return [spawn_agents]
}
