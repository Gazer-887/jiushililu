import { readdirSync, readFileSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import { join, relative } from 'node:path'
import type { AgentTool } from '@shared/agent'
import { resolveInsideWorkspace } from '../guard'

// 系统类工具（P1 工具层补全）：列目录 / 文本搜索 / 命令执行。
// 边界纪律：
//  - 前三者只在 workspaceRoot 内活动，跳过依赖与构建产物目录
//  - run_command 是高危工具：**内核默认工具集不含它**，自定义 Agent 显式声明才会下发；
//    执行限时 30s、输出截断 1MB、cwd 锁定工作区

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.workbuddy'])
const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_RESULTS = 50
const MAX_SEARCH_FILE_BYTES = 512 * 1024
const MAX_COMMAND_OUTPUT = 1024 * 1024

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.')
}

/**
 * 危险操作确认钩子（plan8 R5）：由调用方注入「是否允许执行这条命令」。
 * 与检查点的 beforeWrite 同样用回调注入 —— 工具层不需要知道确认从哪来
 * （主进程弹窗 / 测试里直接给答案），也让 CI 无 Electron 时照样能测。
 *
 * 不传 = 不确认（保持旧行为，测试与 CLI 场景需要）。
 */
export type CommandConfirm = (command: string) => Promise<boolean>

export function createSystemTools(workspaceRoot: string): AgentTool[] {
  const { list_dir, search_files, run_command } = buildSystemTools(workspaceRoot, undefined)
  return [list_dir, search_files, run_command]
}

export function createSystemToolsWithConfirm(
  workspaceRoot: string,
  confirm: CommandConfirm
): AgentTool[] {
  const { list_dir, search_files, run_command } = buildSystemTools(workspaceRoot, confirm)
  return [list_dir, search_files, run_command]
}

function buildSystemTools(
  workspaceRoot: string,
  confirm: CommandConfirm | undefined
): { list_dir: AgentTool; search_files: AgentTool; run_command: AgentTool } {
  const list_dir: AgentTool = {
    schema: {
      name: 'list_dir',
      description: '列出工作区内某个目录的内容（名称 + 类型）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的目录路径，缺省为根' }
        }
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : '.'
      const abs = resolveInsideWorkspace(workspaceRoot, rel)
      if (!abs) return `错误：路径「${rel}」越出工作区边界，拒绝列出`
      try {
        const entries = readdirSync(abs, { withFileTypes: true })
        if (entries.length === 0) return '（空目录）'
        const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
          const kind = e.isDirectory() ? '[目录]' : '[文件]'
          return `${kind} ${e.name}`
        })
        const more = entries.length > MAX_LIST_ENTRIES ? `\n（其余 ${entries.length - MAX_LIST_ENTRIES} 项省略）` : ''
        return lines.join('\n') + more
      } catch (err) {
        return `错误：列出失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const search_files: AgentTool = {
    schema: {
      name: 'search_files',
      description: '在工作区内做文本搜索（大小写不敏感），返回"文件:行号: 行内容"，跳过依赖与构建产物目录',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的文本' },
          path: { type: 'string', description: '搜索起点，缺省为工作区根' }
        },
        required: ['query']
      }
    },
    async execute(args) {
      const query = typeof args['query'] === 'string' ? args['query'] : ''
      if (query.length === 0) return '错误：query 不能为空'
      const baseRel = typeof args['path'] === 'string' ? args['path'] : '.'
      const base = resolveInsideWorkspace(workspaceRoot, baseRel)
      if (!base) return `错误：路径「${baseRel}」越出工作区边界，拒绝搜索`
      const needle = query.toLowerCase()
      const hits: string[] = []

      const walk = (dir: string): void => {
        if (hits.length >= MAX_SEARCH_RESULTS) return
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const name of entries) {
          if (hits.length >= MAX_SEARCH_RESULTS) return
          const full = join(dir, name)
          let st: ReturnType<typeof statSync>
          try {
            st = statSync(full)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            if (!shouldSkipDir(name)) walk(full)
            continue
          }
          if (st.size === 0 || st.size > MAX_SEARCH_FILE_BYTES) continue
          try {
            const text = readFileSync(full, 'utf8')
            const rel = relative(workspaceRoot, full)
            const lines = text.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.toLowerCase().includes(needle)) {
                hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`)
                if (hits.length >= MAX_SEARCH_RESULTS) return
              }
            }
          } catch {
            continue // 二进制/不可读文件跳过
          }
        }
      }

      walk(base)
      return hits.length === 0 ? '（无匹配）' : hits.join('\n')
    }
  }

  const run_command: AgentTool = {
    schema: {
      name: 'run_command',
      description: '在工作区根执行一条 shell 命令（限时 30s，输出截断 1MB）。高危工具：仅在明确需要时使用。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' }
        },
        required: ['command']
      }
    },
    async execute(args) {
      const command = typeof args['command'] === 'string' ? args['command'] : ''
      if (command.trim().length === 0) return '错误：command 不能为空'

      // 逐次确认（plan8 R5）：命令是任意文本，危险与否无法靠静态规则判全 ——
      // 与其猜，不如把原文摊给用户看一眼。拒绝时返回明确的错误文本（模型能读懂并改道）。
      if (confirm) {
        const allowed = await confirm(command)
        if (!allowed) {
          return '错误：用户拒绝执行该命令。请改用其它方式完成任务，或向用户说明为何需要执行它。'
        }
      }

      return new Promise((resolvePromise) => {
        exec(
          command,
          { cwd: workspaceRoot, timeout: 30000, maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true },
          (error, stdout, stderr) => {
            const out = stdout.toString().slice(0, 8000)
            const errText = stderr.toString().slice(0, 4000)
            if (error) {
              resolvePromise(`命令执行出错（exit=${error.code ?? '?'}）\n[stdout]\n${out}\n[stderr]\n${errText}`)
              return
            }
            resolvePromise(`[stdout]\n${out}${errText ? `\n[stderr]\n${errText}` : ''}`)
          }
        )
      })
    }
  }

  return { list_dir, search_files, run_command }
}
