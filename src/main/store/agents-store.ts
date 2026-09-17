import { isAbsolute, join, resolve, sep } from 'node:path'
import type { AgentSaveInput, AgentSaveResult } from '@shared/agents'
import { parseAgentDefinition, validateAgentFields, type AgentDefinition, type AgentSource } from '../agent/loader'
import { atomicWrite, type FsAdapter } from './conversations-fs'

// Agent 定义的 CRUD 后端（plan17）：MD 文件是唯一真相源，本模块只负责"表单 ↔ 文件"的往返。
// ⚠️ 读写定位一律用来源路径（file），**禁止按 name 反推文件名**——文件可手改，name 与文件名可脱钩。

/**
 * 表单**管理**的 frontmatter 键：这些一律以表单为准（否则用户改了却存不上，那才是更糟的坑）。
 *
 * ⚠️ `approval` / `executor`（plan27）在 S4 落地表单控件后**转入本集合** —— 它们从"只能手写"
 * 变成了"表单可配"，此时若仍留在保留集里，会和 serialize 的输出**重复写两行**。
 * 判断标准很简单：**表单上有控件的字段 = 管理；没有控件 = 保留**。
 */
const MANAGED_KEYS = new Set(['name', 'description', 'tools', 'model', 'approval', 'executor'])

/**
 * 从既有定义文件里取出「表单不管的 frontmatter 行」，保存时原样带回。
 *
 * 起因（plan27）：若保存时按表单字段全量重写，用户从界面随便改一行 description 再保存，
 * 就会把**表单不认识的其他 frontmatter 字段静默抹掉**，而且他不会有任何察觉。
 * 这与「MD 是唯一真相源」的约定冲突：**界面改一个字段，不该顺手删掉它不认识的其他字段**。
 *
 * 当前受益对象是**表单没有控件的字段** —— 本机用户手写的自定义键，或者将来新增、尚未接表单的键。
 * （`approval` / `executor` 曾有赖于此，S4 接了表单控件后转入 `MANAGED_KEYS`，不再走这条路。）
 * 好处是**新增 frontmatter 字段自动受这条保护**，不用再来改一次。
 */
export function extractUnmanagedFrontmatter(raw: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!m) return []
  const out: string[] = []
  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.trim()
    const kv = /^([\w-]+):/.exec(trimmed)
    if (!kv) continue
    if (!MANAGED_KEYS.has(kv[1])) out.push(trimmed)
  }
  return out
}

/** 读既有文件里「表单不管的 frontmatter 行」。读不到（新建 / 文件被删 / 权限不足）就当没有 ——
 *  **不因为"保留不上"而拒绝保存**：那是把次要目标（保住未知字段）凌驾于主目标（用户要保存）之上。 */
function readUnmanagedFrontmatter(fs: FsAdapter, file: string | undefined): string[] {
  if (!file) return []
  try {
    return extractUnmanagedFrontmatter(fs.readFileSync(resolve(file), 'utf8'))
  } catch {
    return []
  }
}

/** 序列化为定义文件。description/model 是单行字段，换行会破坏 frontmatter 结构，替换为空格 */
export function serializeAgentDefinition(input: AgentSaveInput, preserved: string[] = []): string {
  const lines = ['---', `name: ${input.name}`, `description: ${input.description.replace(/\r?\n/g, ' ')}`]
  if (input.tools.length > 0) lines.push(`tools: [${input.tools.join(', ')}]`)
  if (input.model) lines.push(`model: ${input.model.replace(/\r?\n/g, ' ')}`)
  // plan27：只有 `'plan'` 一个合法取值，别的（含空串）一律不写 —— 写个取不到效的字面量比不写更坏，
  // 它会让人以为"配好了"。同理 executor 留空即"用兜底"，不写 `executor:` 这种空行。
  if (input.approval === 'plan') lines.push('approval: plan')
  if (input.executor) lines.push(`executor: ${input.executor.replace(/\r?\n/g, ' ')}`)
  // 表单不管理的键原样带回（见 extractUnmanagedFrontmatter 的注释）
  lines.push(...preserved)
  lines.push('---', '', input.systemPrompt, '')
  return lines.join('\n')
}

/** file 必须落在允许目录之一内且是 .md——file 来自渲染进程，等同任意路径（plan17 D6 安全收口） */
export function isAllowedAgentFile(file: string, allowedDirs: string[]): boolean {
  if (!isAbsolute(file) || !file.toLowerCase().endsWith('.md')) return false
  const abs = resolve(file)
  return allowedDirs.some((dir) => {
    const base = resolve(dir)
    return abs === base || abs.startsWith(base + sep)
  })
}

export interface SaveContext {
  /** 内置层已占用的 name 集合 —— 撞名分级（D3）：撞用户层拒、撞内置层放行但提示覆盖关系。
   *  ⚠️ projectNames 已随 D-103（项目级取消）移除 */
  builtinNames: string[]
}

/** 保存（创建/编辑）一个用户层定义。编辑时 input.file 必须仍指向用户层内 */
export function saveAgentDefinition(
  fs: FsAdapter,
  userDir: string,
  input: AgentSaveInput,
  ctx: SaveContext
): AgentSaveResult {
  const check = validateAgentFields(input)
  if (!check.ok) return { ok: false, reason: check.reason }

  const target = input.file ? resolve(input.file) : join(userDir, `${input.name}.md`)

  if (input.file) {
    // 编辑既有文件：仍须在用户层内（表单不会产生越界 file，这里挡的是被篡改的 IPC 载荷）
    if (!isAllowedAgentFile(input.file, [userDir])) {
      return { ok: false, reason: '目标文件不在用户定义目录内，已拒绝写入' }
    }
  } else {
    // 新建：撞用户层同名 = 静默覆盖别人的自定义 Agent，拒绝并指路
    if (fs.existsSync(target)) {
      return { ok: false, reason: '已存在同名定义，请在列表中编辑它，或换一个名字' }
    }
  }

  const notice = input.file
    ? undefined
    : ctx.builtinNames.includes(input.name)
      ? '已存在同名内置定义：此定义生效后将覆盖内置版本'
      : undefined

  const raw = serializeAgentDefinition(input, readUnmanagedFrontmatter(fs, input.file))
  try {
    atomicWrite(fs, target, raw)
    return { ok: true, file: target, ...(notice ? { notice } : {}) }
  } catch (err) {
    return { ok: false, reason: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 删除用户层定义。文件不存在 = 幂等成功（删已删过的东西不该报错） */
export function deleteAgentFile(fs: FsAdapter, file: string, userDir: string): { ok: true } | { ok: false; reason: string } {
  if (!isAllowedAgentFile(file, [userDir])) return { ok: false, reason: '目标文件不在用户定义目录内，已拒绝删除' }
  try {
    fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `删除失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 读单个定义文件（编辑表单回填）。file 越界时返回 null，由调用方给"未找到"语义 */
export function readAgentDefinition(
  fs: FsAdapter,
  file: string,
  allowedDirs: string[],
  source: AgentSource
): AgentDefinition | null {
  if (!isAllowedAgentFile(file, allowedDirs)) return null
  try {
    return parseAgentDefinition(fs.readFileSync(file, 'utf8'), source, file, file)
  } catch {
    return null
  }
}
