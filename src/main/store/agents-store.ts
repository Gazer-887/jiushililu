import { isAbsolute, join, resolve, sep } from 'node:path'
import type { AgentSaveInput, AgentSaveResult } from '@shared/agents'
import { parseAgentDefinition, validateAgentFields, type AgentDefinition, type AgentSource } from '../agent/loader'
import { atomicWrite, type FsAdapter } from './conversations-fs'

// Agent 定义的 CRUD 后端（plan17）：MD 文件是唯一真相源，本模块只负责"表单 ↔ 文件"的往返。
// ⚠️ 读写定位一律用来源路径（file），**禁止按 name 反推文件名**——文件可手改，name 与文件名可脱钩。

/** 序列化为定义文件。description/model 是单行字段，换行会破坏 frontmatter 结构，替换为空格 */
export function serializeAgentDefinition(input: AgentSaveInput): string {
  const lines = ['---', `name: ${input.name}`, `description: ${input.description.replace(/\r?\n/g, ' ')}`]
  if (input.tools.length > 0) lines.push(`tools: [${input.tools.join(', ')}]`)
  if (input.model) lines.push(`model: ${input.model.replace(/\r?\n/g, ' ')}`)
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
  /** 内置 / 项目层已占用的 name 集合——撞名分级（D3）：撞用户层拒、撞这两层放行但提示覆盖关系 */
  builtinNames: string[]
  projectNames: string[]
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
      : ctx.projectNames.includes(input.name)
        ? '当前工作区已有同名项目层定义：项目层定义将优先于本定义生效'
        : undefined

  const raw = serializeAgentDefinition(input)
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
