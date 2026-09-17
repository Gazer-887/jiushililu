// 自视段（2026-09-15 用户需求）：把**当前运行配置**拼进 system prompt，让模型对自己"有什么、跑在哪"如实可答。
// ⚠️ 两条硬约束（与 memory/inject.ts 同源）：
// ① **静态**——同一次 runAgent 调用内字节级不变（模型名/工具集/注册表在本轮都是定值），前缀缓存不被打散；
// ② **有什么写什么**——技能（F6）与 MCP（F7）尚未落地就不出现对应行，绝不写"规划中"的 roadmap 噪音，
//    更不许让模型以为存在不存在的能力（那正是这条段要消灭的幻觉）。

/** 平台名 human 一点：模型对答时说"Windows"比说"win32"像人话（其余平台原样，反正没人问它们） */
function platformLabel(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows（九十里路桌面应用）'
  if (platform === 'darwin') return 'macOS（九十里路桌面应用）'
  if (platform === 'linux') return 'Linux（九十里路桌面应用）'
  return platform
}

export interface SelfViewInput {
  /** 生效模型名（`effective.model`——含子代理 def.model 覆盖后的终值） */
  model: string
  /** 连接协议：'openai-compatible' | 'anthropic' */
  providerType: string
  platform: NodeJS.Platform
  /** 本轮**实际下发**的工具名（schema 同批下发，这里只是汇总清单） */
  toolNames: string[]
  /** 可派子代理名（`spawn_agents` 下发时才有；空 = 不出现子代理行） */
  subagentNames: string[]
  /** 电脑控制开关（用户设置；当前版本无对应工具，如实报状态） */
  computerControl: boolean
}

/**
 * 组装自视段。恒非空——配置事实永远存在（哪怕只有模型名），不搞空壳判断。
 * 格式取向**紧凑**：这是每轮都带的固定底座，铺陈一句就是每轮白烧的税。
 */
export function composeSelfView(input: SelfViewInput): string {
  const lines = [
    '<self_view>',
    '以下是当前运行环境的配置事实，供如实回答"你能做什么"一类问题；不得据此声称存在清单之外的能力。'
  ]
  lines.push(`- 当前模型：${input.model}（协议：${input.providerType === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}）`)
  lines.push(`- 运行端：${platformLabel(input.platform)}`)
  lines.push(`- 电脑控制：${input.computerControl ? '已开启（桌面操作工具由用户配置的 MCP server 提供）' : '未开启'}`)
  if (input.toolNames.length > 0) {
    lines.push(`- 可用工具（${input.toolNames.length} 个）：${input.toolNames.join('、')}；每件的参数以工具定义为准`)
  }
  if (input.subagentNames.length > 0) {
    lines.push(
      `- 可派子代理（${input.subagentNames.length} 个）：${input.subagentNames.join('、')}；用 spawn_agents 派发，任务书必须自包含`
    )
  }
  lines.push('</self_view>')
  return lines.join('\n')
}
