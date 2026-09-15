// 规则系统（plan24 S1）：**无条件注入的约束**——与技能（按需）、记忆（偏好）互补（plan24 §一）。
// 纯函数：目录由调用方传入，本文件不碰 electron。
// 预算 8KB（D-068）：规则是每轮都在的约束，预算优先级最高（高于技能的 4KB）；
// 超限**按文件原子丢弃**（不切断文件中部），被丢文件名在块尾列出 —— 双侧不静默。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const RULES_BLOCK_MAX_BYTES = 8 * 1024

export interface RuleFile {
  /** 来源标注（进注入块，可追溯）：工作区/AGENTS.md · 工作区/rules/xxx.md · 用户/rules/xxx.md */
  label: string
  content: string
}

export interface RulesBlockResult {
  block: string | null
  /** 因预算被丢弃的规则文件（label 列表） */
  droppedFiles: string[]
}

const BLOCK_HEAD = '### 项目规则（本轮对话必须遵守）\n以下规则来自规则文件，来源已标注：\n'

/**
 * 三层收集规则文件（D-067），优先级**高 → 低**：
 * 1. 工作区根 `AGENTS.md`（项目自己的约定，单文件最高优先）
 * 2. 工作区 `rules/*.md`（按文件名排序）
 * 3. 用户层 `<userData>/rules/*.md`（跨项目个人规则）
 * 同名场景：工作区层优先于用户层（同名 label 工作区先入列即可——此处不同层 label 天然不同，
 * 优先级体现在**排序**：工作区条目排前，预算截断时先保工作区）。
 */
export function collectRuleFiles(workspaceRoot: string | null, userDataDir: string | null): RuleFile[] {
  const files: RuleFile[] = []

  if (workspaceRoot) {
    const agents = join(workspaceRoot, 'AGENTS.md')
    if (existsSync(agents)) {
      try {
        files.push({ label: '工作区/AGENTS.md', content: readFileSync(agents, 'utf8') })
      } catch {
        // 不可读 = 无该规则，不阻塞
      }
    }
    const wsRules = join(workspaceRoot, 'rules')
    if (existsSync(wsRules)) {
      try {
        for (const f of readdirSync(wsRules).filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
          files.push({ label: `工作区/rules/${f}`, content: readFileSync(join(wsRules, f), 'utf8') })
        }
      } catch {
        // 目录不可读 = 无该层规则
      }
    }
  }

  if (userDataDir) {
    const userRules = join(userDataDir, 'rules')
    if (existsSync(userRules)) {
      try {
        for (const f of readdirSync(userRules).filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
          files.push({ label: `用户/rules/${f}`, content: readFileSync(join(userRules, f), 'utf8') })
        }
      } catch {
        // 同上
      }
    }
  }

  return files
}

/** 组装规则注入段（D-068）：null = 无规则（调用方跳过注入）。被丢文件名在块尾列出。 */
export function composeRulesBlock(workspaceRoot: string | null, userDataDir: string | null): RulesBlockResult {
  const files = collectRuleFiles(workspaceRoot, userDataDir)
  if (files.length === 0) return { block: null, droppedFiles: [] }

  const kept: string[] = []
  const droppedFiles: string[] = []
  let bytes = Buffer.byteLength(BLOCK_HEAD, 'utf8')

  for (const f of files) {
    const section = `\n[规则 ${f.label}]\n${f.content}\n`
    const sectionBytes = Buffer.byteLength(section, 'utf8')
    if (bytes + sectionBytes > RULES_BLOCK_MAX_BYTES) {
      droppedFiles.push(f.label)
      continue
    }
    kept.push(section)
    bytes += sectionBytes
  }

  if (kept.length === 0) return { block: null, droppedFiles: files.map((f) => f.label) }

  const tail =
    droppedFiles.length > 0
      ? `\n（另有 ${droppedFiles.length} 个规则文件未注入，受预算所限：${droppedFiles.join('、')}）\n`
      : '\n'
  return { block: `${BLOCK_HEAD}${kept.join('')}${tail}`, droppedFiles }
}
