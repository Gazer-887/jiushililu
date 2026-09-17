// 技能写路径（plan34 S2b）：创建 / 更新 / 删除 —— **只写用户层**（内置层随包分发，永不可写）。
// 独立成模块：skills-store 是**装配层**（读），写在这 —— 单一职责，"读不碰写、写不碰装配"可被静态审查。
// 删除走**回收站**（项目原则：非硬删，删错可捞）；文件名即技能名（loader D-056），按名定位文件。

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateSkillFields } from '@shared/skills'

export interface SkillWriteInput {
  name: string
  description: string
  /** 双语简介（plan34 §4.4-5）：内置技能用于「›」下拉展示；自定义可填可不填 */
  descriptionZh?: string
  descriptionEn?: string
  version?: string
  body: string
}

export type SkillWriteResult = { ok: true } | { ok: false; reason: string }

/** 组装文件内容：frontmatter（含双语可选字段）+ 正文。格式与 loader 的解析严格互逆 */
export function composeSkillFile(input: SkillWriteInput): string {
  const lines = ['---', `description: ${input.description}`]
  if (input.descriptionZh) lines.push(`description_zh: ${input.descriptionZh}`)
  if (input.descriptionEn) lines.push(`description_en: ${input.descriptionEn}`)
  if (input.version) lines.push(`version: ${input.version}`)
  lines.push('---', '', input.body.trim(), '')
  return lines.join('\n')
}

/** 创建 / 更新（同名覆盖即更新）。**只落用户层** —— 调用方无需判断来源，这里物理上写不到内置层 */
export function saveSkillFile(
  deps: { userDir: string | null },
  input: SkillWriteInput
): SkillWriteResult {
  if (!deps.userDir) return { ok: false, reason: '用户技能目录不可用（无法保存）' }
  const check = validateSkillFields({ name: input.name, description: input.description, body: input.body })
  if (!check.ok) return { ok: false, reason: check.reason }
  try {
    writeFileSync(join(deps.userDir, `${input.name}.md`), composeSkillFile(input), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 删除（走回收站）。**内置技能不可删**（用户 10:25 拍板：随包文件删了升级会回来，
 * 正确动作是开关关闭）—— 表现为"用户层找不到该文件"，统一给出解释而不是含糊的"不存在"。
 */
export async function deleteSkillFile(
  deps: { userDir: string | null; trash: (abs: string) => Promise<void> },
  name: string
): Promise<SkillWriteResult> {
  if (!deps.userDir) return { ok: false, reason: '用户技能目录不可用（无法删除）' }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return { ok: false, reason: '技能名不合法' }
  const abs = join(deps.userDir, `${name}.md`)
  if (!existsSync(abs)) {
    return { ok: false, reason: '用户层没有这个技能（内置技能不可删除 —— 请用开关关闭）' }
  }
  try {
    await deps.trash(abs)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
