import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { validateSkillFields } from '@shared/skills'

// 技能定义加载器（plan22 D-056）：单文件 Markdown + frontmatter，**照 agent/loader.ts 的模式**，
// 但独立成模块 —— 字段语义不同（skill 无 tools/model；name 取自**文件名**而非 frontmatter，
// 对齐 Claude Code「目录名 = 命令名」的口径），校验走 @shared/skills 的 validateSkillFields。
// fail-soft 与 agents 同一铁律：一个坏文件不拖垮全部，但**绝不静默**（warnings 有名有因）。

export type SkillLayerSource = 'builtin' | 'user'

export interface SkillDefinition {
  /** 技能名 = 文件名去掉 .md（对齐 Claude Code：目录名即命令名；frontmatter 不设 name 字段避免双名打架） */
  name: string
  description: string
  /** 可选版本号（frontmatter version），纯展示 */
  version?: string
  /** 技能指令正文（frontmatter 之后的全部内容）—— use_skill 时整体回灌进对话 */
  body: string
  source: SkillLayerSource
  /** 来源文件绝对路径。⚠️ 文件名即技能名，故重命名文件 = 重命名技能（与 agents 的「可脱钩」刻意不同） */
  file: string
}

export interface SkillLayer {
  dir: string | null
  source: SkillLayerSource
}

export interface SkillEntry extends SkillDefinition {
  /** 被高层同名定义覆盖的条目：不在生效集合里，但列表可见（设置页覆盖标记靠它） */
  overridden: boolean
}

export interface SkillLoadResult {
  entries: SkillEntry[]
  warnings: string[]
}

/** 解析单个技能文件。frontmatter 缺 description / 正文为空 → 抛带文件名线索的中文错误。 */
export function parseSkillDefinition(
  raw: string,
  source: SkillLayerSource,
  file: string,
  fileLabel: string
): { def: SkillDefinition; warnings: string[] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`${fileLabel}：缺少 frontmatter（文件应以 --- 开头，内含 description）`)
  const [, fmBlock, body] = match

  const fm: Record<string, string> = {}
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    fm[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
  }

  // 技能名 = 文件名去 .md（D-056：对齐 Claude Code 目录名口径；frontmatter 不设 name）
  const name = basename(file).replace(/\.md$/i, '')
  const description = typeof fm['description'] === 'string' ? fm['description'] : ''
  const check = validateSkillFields({ name, description, body: body.trim() })
  if (!check.ok) throw new Error(`${fileLabel}：${check.reason}`)

  const warnings: string[] = []
  // 文件名派生的名字若与标准不符（如中文文件名）会在这里被拦 —— 提示改名而非静默接受
  if (typeof fm['name'] === 'string' && fm['name'] !== name) {
    warnings.push(`${fileLabel}：frontmatter name（${fm['name']}）与文件名不一致，以文件名（${name}）为准`)
  }

  const def: SkillDefinition = { name, description, body: body.trim(), source, file }
  if (typeof fm['version'] === 'string' && fm['version'].length > 0) def.version = fm['version']
  return { def, warnings }
}

/** 从目录加载全部 *.md 技能；解析失败的文件跳过并记入 warnings（绝不静默消失） */
export function loadSkillsFromDir(dir: string, source: SkillLayerSource): SkillLoadResult {
  const entries: SkillEntry[] = []
  const warnings: string[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return { entries, warnings } // 目录不存在 = 该层无技能，不是错误
  }
  for (const file of files) {
    const abs = join(dir, file)
    const label = `${source}/${file}`
    try {
      const { def, warnings: parseWarnings } = parseSkillDefinition(readFileSync(abs, 'utf8'), source, abs, label)
      entries.push({ ...def, overridden: false })
      warnings.push(...parseWarnings)
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { entries, warnings }
}

/**
 * 两层加载 + 全量视图（plan22 D-056）：数组顺序即优先级（**后者覆盖前者同名**：用户层 > 内置层）。
 * 同层重名进 warnings 并跳过后到者；被覆盖的低层条目保留但标 overridden（设置页覆盖标记靠它）。
 */
export function loadSkillEntries(layers: SkillLayer[]): SkillLoadResult {
  const warnings: string[] = []
  const all: SkillEntry[] = []
  const effective = new Map<string, SkillEntry>()
  for (const layer of layers) {
    if (!layer.dir) continue
    const loaded = loadSkillsFromDir(layer.dir, layer.source)
    warnings.push(...loaded.warnings.map((w) => `[${layer.source} 层] ${w}`))
    for (const entry of loaded.entries) {
      const prev = effective.get(entry.name)
      if (prev) {
        if (prev.source === entry.source) {
          warnings.push(`[${layer.source} 层] ${entry.file}：与同层已有技能重名（${entry.name}），已跳过`)
          continue
        }
        prev.overridden = true
        all.push(prev)
      }
      effective.set(entry.name, entry)
    }
  }
  all.push(...effective.values())
  return { entries: all, warnings }
}
