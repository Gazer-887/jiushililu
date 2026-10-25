// 工具调用的「一句人话」（plan7 交互层）：让界面显示「read_file · src/main/index.ts」而不是干巴巴的「执行中…」。
// 放 shared 是因为渲染进程要用同一份，而它**不许** import electron / node（CI 无二进制会炸）。

/** 各工具「最能说明在干什么」的那个入参字段 */
const KEY_OF: Record<string, string> = {
  read_file: 'path',
  write_file: 'path',
  list_dir: 'path',
  search_files: 'query',
  run_command: 'command',
  check_command: 'id',
  kill_command: 'id',
  fetch_url: 'url',
  browser_navigate: 'url',
  browser_click: 'selector',
  browser_type: 'text',
  update_todos: 'todos',
  ask_user: 'question',
  spawn_agents: 'jobs'
}

const MAX_DETAIL = 80

/**
 * 模型给的 JSON **不可靠**（可能被截断、可能不是对象），故全程兜底：拿不到就返回空串，
 * 界面退回"执行中…"—— 宁可少显示，也不能因为解析失败把工具卡片搞崩。
 */
export function toolCallDetail(name: string, argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const rec = parsed as Record<string, unknown>
    const key = KEY_OF[name]
    const value = key !== undefined && key in rec ? rec[key] : firstString(rec)
    const briefValue = brief(value)
    // plan44 决策 5（动作回显）：**未知工具**（含 mcp__）参数多是数字（x/y）——
    // 字符串兜不住时拼至多三个标量 k=v；具名工具维持旧判据（拿不到就空串，界面退"执行中…"）
    if (briefValue.length > 0) return briefValue
    return key === undefined ? scalarSummary(rec) : ''
  } catch {
    return ''
  }
}

function scalarSummary(rec: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
    if (parts.length >= 3) break
  }
  return clip(parts.join(' '))
}

/** 未知工具兜底：取第一个非空字符串值 */
function firstString(rec: Record<string, unknown>): unknown {
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/** 数组/对象只说"几项"，别把 JSON 摊到界面上 */
function brief(value: unknown): string {
  if (typeof value === 'string') return clip(value)
  if (Array.isArray(value)) {
    const first = value.find((v) => v !== null && typeof v === 'object') as
      | Record<string, unknown>
      | undefined
    if (first) {
      const label = first['agent'] ?? first['text'] ?? ''
      return clip(label ? `${String(label)} 等 ${value.length} 项` : `${value.length} 项`)
    }
    return `${value.length} 项`
  }
  if (value !== null && typeof value === 'object') return '（对象参数）'
  return ''
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL)}…` : one
}

/** 会产出/改写工作区文件的工具（plan74 Agent 产物入口用）：其 path 入参是可信的产物路径来源。 */
const ARTIFACT_TOOLS = new Set(['write_file', 'edit'])

/**
 * 从工具**真实入参**提取产物文件路径（工作区相对路径）。**不是**从 detail 文本猜 ——
 * 模型随口写的字符串不算可读路径（计划红线"不信模型宣称路径"）。仅写/建类工具有；
 * 入参解析失败 / 无 path / 不是字符串一律返回空数组（宁可少显示，不猜）。
 */
export function toolArtifactPaths(name: string, argsJson: string): string[] {
  if (!ARTIFACT_TOOLS.has(name)) return []
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const rec = parsed as Record<string, unknown>
    const rawPath = rec['path']
    if (typeof rawPath !== 'string' || !rawPath.trim()) return []
    const p = rawPath.replace(/\\/g, '/')
    // 只收工作区相对路径：绝对路径 / 盘符 / UNC 不是产物（那是系统文件，交给附件通路）
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')) return []
    // 逐段校验：不许含 .. / . 越界段（与预览协议同口径）
    if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return []
    return [p]
  } catch {
    return []
  }
}
