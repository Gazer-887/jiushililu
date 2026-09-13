import { readFile } from 'node:fs/promises'
import type { AgentTool } from '@shared/agent'
import { estimateTokens } from '@shared/tokens'
import { resolveInsideWorkspace } from '../guard'
import type { WorkspaceWriter } from '../../workspace-write'
import type { TokenPolicy } from '@shared/token-tier'

// 内置工具第一批（plan6）：文件读写。两条硬边界：① 路径必须落在 workspaceRoot 内（防逃逸）
// ② 读取按**行窗口**给而非全文（防撑爆上下文）。
//
// plan7 批 A2：写操作走统一写入服务 —— 快照收在服务层；快照若挂在工具上，界面自己写文件就绕过检查点，删了退不回来。
// plan8 R9.1：read_file 改成"可寻址的窗口读取"（缘起：本工作区 `package-lock.json` 全文 92.5k token，旧上限形同虚设）。
// 现在的形状（借 Claude Code / dsh-plugin-save-token 经验）：默认前 200 行 + 行号前缀、末尾如实告知给到哪一段怎么续读、
// 单行超长单独掐断、二进制文件直接说清。
// ⚠️ 行号是**定位用的前缀**，不是文件内容 —— 工具说明与输出末尾都要讲明，否则模型会把行号一起写回文件（本类工具的经典翻车）。

const MAX_READ_BYTES = 8 * 1024 * 1024
/** 单次最多给多少行（模型可以显式要更多，但有硬顶，免得"多要一点"变成"全都要"） */
const MAX_LIMIT_LINES = 2000
const DEFAULT_LIMIT_LINES = 200
/** 单行超过这个长度就掐断（压缩产物一行可达数万字符） */
const MAX_LINE_CHARS = 2000
/**
 * **单次读取的绝对预算**（估算 token）。光有"行数上限"不够（2026-09-12 红队审查抓出来的洞）：
 * 2000 行 × 2000 字符 = 400 万字符，一次 read_file 就能撑爆 65536 的窗口、**整轮作废**，
 * 而 trimMessages 只折中段、这种形状下什么都不做。所以按预算给：够了就停，并在末尾如实说续读方式。
 */
const MAX_WINDOW_TOKENS = 12_000

/** 参数是模型给的，什么形状都可能：缺、字符串、0、负数、小数 —— 一律归到一个合法正整数 */
function toPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
}

/**
 * @param policy 省 token 档位（plan8 R9.1 §七②）：**只管"没人指定时默认读多少行"**，
 *   模型显式给了 `limit` 就按它的来 —— 档位不是硬上限，否则就成了替模型做决定；不传 = 平衡档（200 行）
 */
export function createFileTools(writer: WorkspaceWriter, policy?: TokenPolicy): AgentTool[] {
  /** 默认读多少行（平衡档 = 200，与改造前一致） */
  const defaultLines = policy?.readLines ?? DEFAULT_LIMIT_LINES
  const read_file: AgentTool = {
    schema: {
      name: 'read_file',
      description:
        `读取工作区内一个文本文件的一段内容（默认第 1 行起、最多 ${defaultLines} 行）。` +
        '返回的每一行前面都有「行号|」前缀，那是**定位用的，不属于文件内容**。' +
        '要读后面的内容：把 offset 设成上一段末尾行号加一。文件很长时不要一次全要 —— 先看结构再按需取段。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的文件路径' },
          offset: { type: 'number', description: '从第几行开始读（从 1 数起，默认 1）' },
          limit: { type: 'number', description: `最多读多少行（默认 ${defaultLines}，上限 ${MAX_LIMIT_LINES}）` }
        },
        required: ['path']
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : ''
      const abs = resolveInsideWorkspace(writer.root, rel)
      if (!abs) return `错误：路径「${rel}」越出工作区边界，拒绝读取`
      try {
        const buf = await readFile(abs)
        if (buf.byteLength > MAX_READ_BYTES) {
          return `错误：文件超过 ${Math.round(MAX_READ_BYTES / 1024 / 1024)}MB，读取被拒绝`
        }
        // 只看前 8KB 里有没有 NUL：二进制读成 utf8 会灌进满屏替换字符，烧 token 还让模型满口胡话
        const probe = buf.subarray(0, 8192)
        if (probe.includes(0)) return `错误：「${rel}」看起来是二进制文件（含 NUL 字节），read_file 只读文本`

        const text = buf.toString('utf8')
        const all = text.split(/\r?\n/)
        const total = all.length
        const offset = toPositiveInt(args['offset'], 1)
        const limit = Math.min(toPositiveInt(args['limit'], defaultLines), MAX_LIMIT_LINES)
        const start = Math.min(offset, total + 1)
        const end = Math.min(start + limit - 1, total)

        if (start > total) {
          return `错误：起始行 ${offset} 超出文件范围（该文件共 ${total} 行）。要看末尾请用 offset=${Math.max(1, total - defaultLines + 1)}`
        }

        const window = all.slice(start - 1, end)
        // 按**预算**逐行收，而不是按行数收（见 MAX_WINDOW_TOKENS 的注释）
        const rows: string[] = []
        const clipped: number[] = []
        let used = 0
        let lastGiven = start - 1
        for (let i = 0; i < window.length; i++) {
          const no = start + i
          const line = window[i]!
          const long = line.length > MAX_LINE_CHARS
          const text = long
            ? `${no}|${line.slice(0, MAX_LINE_CHARS)}…（本行共 ${line.length} 字符，已掐断）`
            : `${no}|${line}`
          const cost = estimateTokens(text) + 1
          if (rows.length > 0 && used + cost > MAX_WINDOW_TOKENS) break
          rows.push(text)
          used += cost
          lastGiven = no
          if (long) clipped.push(no)
        }

        const body = rows.join('\n')
        // footer 是硬要求（"截断必须告诉模型"）：不说清它就会把"我看到的"当成"文件就是这样"，然后给出错结论
        const moreLines = lastGiven < total
        const budgetHit = moreLines && lastGiven < end
        const footer = moreLines
          ? `\n（文件共 ${total} 行；本次给了第 ${start}–${lastGiven} 行${budgetHit ? `，**已达单次上限约 ${MAX_WINDOW_TOKENS} token**` : ''}，后面还有 ${total - lastGiven} 行。继续读用 offset=${lastGiven + 1}）`
          : `\n（文件共 ${total} 行；本次已给到末尾）`
        const clipNote =
          clipped.length > 0 ? `\n（其中第 ${clipped.join('、')} 行**超长已掐断**，如需完整内容请针对性读取）` : ''

        return `${body}${footer}${clipNote}`
      } catch (err) {
        return `错误：读取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const write_file: AgentTool = {
    schema: {
      name: 'write_file',
      description: '把文本内容写入工作区内的一个文件（覆盖式写入，路径不存在会自动创建）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的文件路径' },
          content: { type: 'string', description: '要写入的完整文本内容' }
        },
        required: ['path', 'content']
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : ''
      const content = typeof args['content'] === 'string' ? args['content'] : null
      if (content === null) return '错误：缺少 content 参数'
      try {
        return await writer.write(rel, content)
      } catch (err) {
        return `错误：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return [read_file, write_file]
}
