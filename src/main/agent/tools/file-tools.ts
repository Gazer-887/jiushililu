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

/** edit 单次能改的最大文件（与 read_file 同口径 —— 改一个读不动的文件没有意义） */
const MAX_EDIT_BYTES = 8 * 1024 * 1024

/** 一处替换：`oldText` 必须与文件内容逐字符一致；`newText` 为空串 = 删除这一段 */
export interface EditSpec {
  oldText: string
  newText: string
}

export interface EditApplied {
  index: number
  /** 命中原样的第几行（1 起，给人看的定位提示） */
  line: number
  /** exact = 逐字符命中；normalized = 只差换行符口径（见 `applyExactEdits` 的说明） */
  matchedBy: 'exact' | 'normalized'
  /** 这一处替换的字节增量（可正可负） */
  deltaBytes: number
}

export type EditOutcome =
  | { ok: true; text: string; applied: EditApplied[] }
  | { ok: false; reason: string; /** 第几处出的问题（0 起）；非"某一处"的问题（如 edits 为空）为 -1 */ index: number }

/** 把字符串按 `\r\n` → `\n` 归一，同时记下「归一后的每个下标来自原文哪个下标」，供命中原位回溯 */
function normalizeWithMap(src: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '\r' && src[i + 1] === '\n') continue // 丢掉 \r，保留后面的 \n
    text += ch
    map.push(i)
  }
  return { text, map }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return n
    n++
    from = at + needle.length
  }
}

const lineOf = (text: string, index: number): number => countOccurrences(text.slice(0, index), '\n') + 1

const preview = (s: string, max = 72): string => {
  const flat = s.replace(/\r?\n/g, '↵')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 文件 EOL 口径：文件里出现过 CRLF 就按 CRLF 写回，否则 LF。
 * **为什么必须管这件事**：Windows 上文件普遍是 CRLF，而模型产出的 `newText` 多半是 LF；
 * 原样写进去就会在同一文件里**混两种换行**，此后每次 diff 都飘、每次保存都改一整片 —— 这是
 * 混久了才发现、又极难回退的一类脏。文件里没有任何换行时不做转换（无从判断，也不该猜）。
 */
function eolOf(text: string): '\r\n' | '\n' | null {
  if (text.includes('\r\n')) return '\r\n'
  if (text.includes('\n')) return '\n'
  return null
}

const toEol = (s: string, eol: '\r\n' | '\n'): string =>
  eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n')

/**
 * 逐处应用精确替换，**任一处失配则整次不做**（原子性）。
 *
 * 三条判据（都是"改错文件比不改更糟"推出来的）：
 * ① **不唯一即拒绝** —— 命中的是一段没头没尾的短串（如 `}`、`return`）时，替换哪一处全凭猜；
 *    宁可让模型补上下文重来，也不要它悄悄改错地方；
 * ② **一处都不命中就一处都不改** —— 否则"改了一半"的文件既不是旧的也不是新的，比全失败更难收拾；
 * ③ **为空即拒绝** —— 空串在哪儿都能匹配上，是纯粹的破坏性输入。
 *
 * 关于"失败重试"（plan28 D-084 原话「匹配不到 → 先读刷新 → 再试」）：
 * 本函数在**执行时**才读盘，拿到的**已经是最新内容**，"再读一次"不会改变匹配结果 ——
 * 真正会让匹配落空的口径差是**换行符**（Windows 文件是 CRLF、模型给的是 LF）与**行尾空白**。
 * 故把"重试"落在**归一化重匹配**上（第二步），而不是把同样的比较跑两遍装作重试过。
 */
export function applyExactEdits(source: string, edits: EditSpec[]): EditOutcome {
  if (edits.length === 0) return { ok: false, reason: 'edits 为空：至少要给一处替换', index: -1 }

  // 文件级 EOL 口径：命中片段本身不含换行时（改一个单词就是这种），拿它当兜底 ——
  // 用"片段里有没有换行"当唯一判据的话，最常见的单行替换反而永远判不出该用哪种换行。
  const fileEol = eolOf(source)
  let text = source
  const applied: EditApplied[] = []

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!
    const oldText = edit.oldText
    const newText = edit.newText ?? ''
    if (typeof oldText !== 'string' || oldText.length === 0) {
      return { ok: false, reason: `第 ${i + 1} 处：oldText 为空。空串在任何位置都能匹配，已拒绝执行`, index: i }
    }

    let at = -1
    let spanEnd = -1
    let matchedBy: 'exact' | 'normalized' = 'exact'

    const exactHits = countOccurrences(text, oldText)
    if (exactHits === 1) {
      at = text.indexOf(oldText)
      spanEnd = at + oldText.length
    } else if (exactHits > 1) {
      return {
        ok: false,
        reason: `第 ${i + 1} 处：oldText 在文件里匹配到 ${exactHits} 处，无法确定改哪一个。请把上下几行一起写进 oldText 让它唯一`,
        index: i
      }
    } else {
      // 第二步：归一化换行后重匹配（见函数头的说明）
      const norm = normalizeWithMap(text)
      const normOld = normalizeWithMap(oldText).text
      const hits = countOccurrences(norm.text, normOld)
      if (hits === 1) {
        const j = norm.text.indexOf(normOld)
        at = norm.map[j]! // 归一化下标 → 原文下标
        spanEnd = norm.map[j + normOld.length - 1]! + 1
        matchedBy = 'normalized'
      } else if (hits > 1) {
        return {
          ok: false,
          reason: `第 ${i + 1} 处：oldText（忽略换行符差异后）匹配到 ${hits} 处，无法确定改哪一个。请补上更多上下文`,
          index: i
        }
      } else {
        return {
          ok: false,
          reason:
            `第 ${i + 1} 处：oldText 在文件里找不到。` +
            `请用 read_file 重新读一遍再改（内容可能已被别的操作改动过），注意 oldText 必须与文件逐字符一致（含缩进）`,
          index: i
        }
      }
    }

    // 这一段实际在文件里用的换行口径，以它为准写回 newText（防混两种换行）；
    // 片段里没有换行就退回文件级口径（见 fileEol 的注释）。
    const segmentEol = eolOf(text.slice(at, spanEnd)) ?? fileEol
    const nextText = segmentEol ? toEol(newText, segmentEol) : newText
    const line = lineOf(text, at)

    text = text.slice(0, at) + nextText + text.slice(spanEnd)
    applied.push({
      index: i,
      line,
      matchedBy,
      deltaBytes: Buffer.byteLength(nextText, 'utf8') - Buffer.byteLength(oldText, 'utf8')
    })
  }

  return { ok: true, text, applied }
}

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

  const edit: AgentTool = {
    schema: {
      name: 'edit',
      description:
        '在文件里做**精确字符串替换** —— 改几行就用它，不要用 write_file 重写整个文件（重写既费 token，' +
        '还有被输出上限截断、改出残缺文件的风险）。' +
        'oldText 必须与文件内容**逐字符一致**（含缩进与空行），且在文件里**只出现一次**；' +
        '出现多次或一次都没有都会被拒绝（一次都不改，避免改坏一半）。' +
        '一次可以给多处替换，按数组顺序应用；任何一处不成立则整次不做。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的文件路径' },
          edits: {
            type: 'array',
            description: '要做的替换，按顺序应用；任一处不成立则整个调用不做任何改动',
            items: {
              type: 'object',
              properties: {
                oldText: {
                  type: 'string',
                  description: '要被替换掉的原文，逐字符一致且在文件里唯一；建议连上下各带一两行做定位'
                },
                newText: { type: 'string', description: '替换成的新内容；空串表示删除这一段' }
              },
              required: ['oldText', 'newText']
            }
          }
        },
        required: ['path', 'edits']
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : ''
      const rawEdits = args['edits']
      if (!Array.isArray(rawEdits)) return '错误：缺少 edits 参数（应为替换列表）'
      const edits: EditSpec[] = rawEdits.map((e) => {
        const o = (e ?? {}) as Record<string, unknown>
        return {
          oldText: typeof o['oldText'] === 'string' ? o['oldText'] : '',
          newText: typeof o['newText'] === 'string' ? o['newText'] : ''
        }
      })

      const abs = resolveInsideWorkspace(writer.root, rel)
      if (!abs) return `错误：路径「${rel}」越出工作区边界，拒绝修改`
      let source: string
      try {
        const buf = await readFile(abs)
        if (buf.byteLength > MAX_EDIT_BYTES) {
          return `错误：文件超过 ${Math.round(MAX_EDIT_BYTES / 1024 / 1024)}MB，edit 拒绝处理（请改用命令行工具）`
        }
        if (buf.subarray(0, 8192).includes(0)) {
          return `错误：「${rel}」看起来是二进制文件（含 NUL 字节），edit 只处理文本`
        }
        source = buf.toString('utf8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 「文件不存在」与「读不了」要分开说：前者该改用 write_file，后者该查权限/占用
        if (/ENOENT/.test(msg)) return `错误：「${rel}」不存在。新建文件请用 write_file`
        return `错误：读取失败——${msg}`
      }

      const outcome = applyExactEdits(source, edits)
      if (!outcome.ok) {
        const which = outcome.index >= 0 ? `（第 ${outcome.index + 1} 处替换）` : ''
        return `错误：未做任何改动${which}。${outcome.reason}`
      }
      // 内容没变就不写：省下一次无意义的检查点快照（回滚面板里多一条空记录只会让人困惑）
      if (outcome.text === source) return `「${rel}」内容无变化，未写入（替换文本与原文相同）`

      try {
        const wrote = await writer.write(rel, outcome.text)
        const notes = outcome.applied.map((a) => {
          const sign = a.deltaBytes >= 0 ? `+${a.deltaBytes}` : `${a.deltaBytes}`
          const how = a.matchedBy === 'normalized' ? '，按换行符口径归一后命中' : ''
          return `  ${a.index + 1}. 第 ${a.line} 行起（${sign} 字节${how}）`
        })
        const delta = outcome.applied.reduce((n, a) => n + a.deltaBytes, 0)
        return (
          `${wrote}\n共 ${outcome.applied.length} 处替换，净变化 ${delta >= 0 ? '+' : ''}${delta} 字节：\n${notes.join('\n')}\n` +
          `（首处 - ${preview(edits[0]!.oldText)}\n    + ${preview(edits[0]!.newText)}）`
        )
      } catch (err) {
        return `错误：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return [read_file, write_file, edit]
}
