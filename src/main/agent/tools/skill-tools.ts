// 技能工具（plan22 S5）：`use_skill` 按名加载技能正文，回灌进当前对话。
// D-058：**读操作**（只读权限档可用，不新增权限面）——技能引导的危险操作仍走既有工具门控；
// D-059：技能清单为空时本工具根本不会被注册（见 runner 的条件装配），不存在"空转工具"。
// 来源标注（builtin / user）让会话历史可追溯 —— 用户能看出这段指令出自哪个技能。

import type { AgentTool } from '@shared/agent'
import type { SkillsStore } from '../../skills/skills-store'

export function createSkillTools(deps: { store: SkillsStore }): AgentTool[] {
  const useSkill: AgentTool = {
    schema: {
      name: 'use_skill',
      description:
        '加载指定**技能**的完整指令。可用技能清单见 system prompt 的「可用技能」段；' +
        '当当前任务正是某条技能覆盖的场景时调用，加载后**按其指令执行**。' +
        '同一技能的正文已在对话里时不要重复调用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（「可用技能」清单中的 name）' }
        },
        required: ['name']
      }
    },
    async execute(args) {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
      if (!name) return '请提供技能名。'
      const skill = deps.store.read(name)
      if (!skill) {
        return `找不到技能「${name}」。可用技能见 system prompt 的「可用技能」清单（注意大小写与连字符）。`
      }
      // D-058：来源标注（builtin / user）—— 会话历史可追溯，出问题能定位到具体技能文件
      return `[技能 ${skill.source}/${skill.name}]${skill.version ? `（v${skill.version}）` : ''}\n\n${skill.body}`
    }
  }
  return [useSkill]
}
