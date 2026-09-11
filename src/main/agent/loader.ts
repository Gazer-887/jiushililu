import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 自定义 Agent 定义加载器（plan6 D1/D2）：MD + YAML frontmatter，全局 + 项目两级，项目覆盖全局。
// frontmatter 采用"扁平键值 + 流式数组"的约定子集——零依赖，复杂 YAML 需求留待 P2 引入 yaml 库。

export interface AgentDefinition {
  name: string
  description: string
  /** 工具白名单；缺省 = 继承全量（D4） */
  tools?: string[]
  /** 模型偏好；缺省 = 当前会话模型 */
  model?: string
  /** 职责描述正文（frontmatter 之后的全部内容）——作为子代理的 system prompt */
  systemPrompt: string
  source: 'global' | 'project'
}

export interface LoaderResult {
  definitions: Map<string, AgentDefinition>
  /** 加载失败被跳过的文件与其原因（fail-soft：一个坏文件不拖垮全部，但绝不静默） */
  warnings: string[]
}

/** 解析单个定义文件。校验失败抛出带文件名线索的中文错误。 */
export function parseAgentDefinition(raw: string, source: AgentDefinition['source'], fileLabel: string): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${fileLabel}：缺少 frontmatter（文件应以 --- 开头，内含 name/description）`)
  const [, fmBlock, body] = match

  const fm: Record<string, string | string[]> = {}
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter((s) => s.length > 0)
    } else {
      fm[key] = value.replace(/^['"]|['"]$/g, '')
    }
  }

  const name = typeof fm['name'] === 'string' ? fm['name'] : ''
  const description = typeof fm['description'] === 'string' ? fm['description'] : ''
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`${fileLabel}：name 缺失或非法（需小写字母/数字/- 组成，1~64 字符）`)
  }
  if (description.length === 0) throw new Error(`${fileLabel}：description 缺失`)
  const systemPrompt = body.trim()
  if (systemPrompt.length === 0) throw new Error(`${fileLabel}：frontmatter 之后必须有职责描述正文`)

  const def: AgentDefinition = { name, description, systemPrompt, source }
  if (Array.isArray(fm['tools'])) def.tools = fm['tools']
  if (typeof fm['model'] === 'string' && fm['model'].length > 0) def.model = fm['model']
  return def
}

/** 从目录加载全部 *.md 定义；解析失败的文件跳过并记入 warnings（绝不静默消失） */
export function loadAgentsFromDir(dir: string, source: AgentDefinition['source']): LoaderResult {
  const definitions = new Map<string, AgentDefinition>()
  const warnings: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return { definitions, warnings } // 目录不存在 = 该层无定义，不是错误
  }
  for (const file of entries) {
    const label = `${source}/${file}`
    try {
      const def = parseAgentDefinition(readFileSync(join(dir, file), 'utf8'), source, label)
      if (definitions.has(def.name)) {
        warnings.push(`${label}：与同层已有定义重名（${def.name}），已跳过`)
        continue
      }
      definitions.set(def.name, def)
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { definitions, warnings }
}

/** 两级合并：项目同名覆盖全局（D2） */
export function mergeAgentLayers(
  globalDir: string | null,
  projectDir: string | null
): LoaderResult {
  const warnings: string[] = []
  const merged = new Map<string, AgentDefinition>()
  if (globalDir) {
    const g = loadAgentsFromDir(globalDir, 'global')
    warnings.push(...g.warnings.map((w) => `[全局层] ${w}`))
    for (const [name, def] of g.definitions) merged.set(name, def)
  }
  if (projectDir) {
    const p = loadAgentsFromDir(projectDir, 'project')
    warnings.push(...p.warnings.map((w) => `[项目层] ${w}`))
    for (const [name, def] of p.definitions) merged.set(name, def) // 项目覆盖全局
  }
  return { definitions: merged, warnings }
}
