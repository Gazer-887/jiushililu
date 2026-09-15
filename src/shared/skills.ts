// 技能系统的共享契约与注入块组装（plan22）。
// 技能 = 人写的流程知识包（单文件 Markdown + frontmatter），注入**当前对话**；
// 与 agents（角色，spawn 独立上下文）、playbook（项目自沉淀经验册）三者互补（plan22 D-055）。
// 渐进式披露三层中的前两层：清单常驻 system prompt（D-057 预算硬上限），
// 正文经 use_skill 按需回灌；第三层（附加文件）后续版本。
// ⚠️ validateSkillFields 是 loader 与 UI 的**单一真相源**（同 @shared/agents 的做法），两处不许各写一份。

export type SkillSource = 'builtin' | 'user'

/** frontmatter 校验，对齐 Claude Code Agent Skills 开放标准：name ≤64（小写/数字/连字符），description ≤1024 */
export function validateSkillFields(input: {
  name: string
  description: string
  body: string
}): { ok: true } | { ok: false; reason: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) {
    return { ok: false, reason: 'name 需小写字母/数字/- 组成，1~64 字符，以字母或数字开头' }
  }
  if (input.description.trim().length === 0) return { ok: false, reason: 'description 缺失' }
  if (input.description.length > 1024) {
    return { ok: false, reason: `description 超 1024 字符（当前 ${input.description.length}，对齐 Agent Skills 标准）` }
  }
  if (input.body.trim().length === 0) return { ok: false, reason: '技能正文不能为空' }
  return { ok: true }
}

/** 注入清单条目（composeSkillBlock 的输入） */
export interface SkillListItem {
  name: string
  description: string
  source: SkillSource
}

/** skillBlock 组装结果：block 为 null = 没有可注入技能（调用方据此跳过注入与工具注册；D-059） */
export interface SkillBlockResult {
  block: string | null
  /** 因超字节上限被丢弃的条数 */
  droppedByBytes: number
  /** 因超条数上限被丢弃的条数 */
  droppedByCount: number
}

export const SKILL_BLOCK_MAX_BYTES = 4 * 1024
export const SKILL_BLOCK_MAX_ITEMS = 24

/** 尾注「另有 N 条技能未列出，受注入预算所限\n」的预算预留（utf8；N 三位数内此值足够） */
const SKILL_TAIL_RESERVE = 96

const SKILL_BLOCK_HEAD = '### 可用技能\n用 use_skill 工具按名加载技能的完整指令：\n'

/**
 * 组装 system prompt 的技能清单段（plan22 D-057）：**纯函数**。
 * - 预算硬上限：4KB（**utf8 字节口径**，`Buffer.byteLength` —— description 含中文，按字符数算会失真）/ 24 条
 * - 超限**按条原子丢弃**（不切断半行），两类丢弃数分开计，块尾分别注明 —— **截断不许静默**
 * - 字节累加时为尾注预留 `SKILL_TAIL_RESERVE`，保证成品块恒 ≤ 上限
 * - 排序：**用户层条目优先于内置层**（用户自装的更可能相关），同层按 name 字典序
 */
export function composeSkillBlock(items: SkillListItem[]): SkillBlockResult {
  const sorted = [...items].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'user' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const kept: string[] = []
  let droppedByBytes = 0
  let droppedByCount = 0
  let bytes = Buffer.byteLength(SKILL_BLOCK_HEAD, 'utf8')

  for (const it of sorted) {
    if (kept.length >= SKILL_BLOCK_MAX_ITEMS) {
      droppedByCount += 1
      continue
    }
    const line = `- ${it.name} — ${it.description}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (bytes + lineBytes + SKILL_TAIL_RESERVE > SKILL_BLOCK_MAX_BYTES) {
      droppedByBytes += 1
      continue
    }
    kept.push(line)
    bytes += lineBytes
  }

  if (kept.length === 0) return { block: null, droppedByBytes, droppedByCount }

  const droppedTotal = droppedByBytes + droppedByCount
  const tail =
    droppedTotal > 0 ? `（另有 ${droppedTotal} 条技能未列出，受注入预算所限）\n` : '\n'
  return { block: `${SKILL_BLOCK_HEAD}${kept.join('')}${tail}`, droppedByBytes, droppedByCount }
}
