// 极简 SSE（text/event-stream）行解析器。
// 只关心 "data:" 行 —— OpenAI 兼容协议与 Anthropic 协议的业务数据都装在 data 行里。
// 纯实现（零依赖，不 import electron/node 专有模块），可直接单元测试。

export interface SSEParser {
  push: (chunk: string) => void
  end: () => void
}

/**
 * 分帧模式。**默认 `line`（旧行为）**，只有显式传入才走 `event`。
 *
 * - `line`：逐条 data 行立即派发。两家现有 provider 都依赖这个语义
 *   （OpenAI 每行一个完整 JSON、Anthropic 每行一个 event），改默认会静默改掉它们的解析。
 * - `event`：按 SSE 规范以**空行为事件边界**，同一事件的多条 data 行用 `\n` 拼接后一次派发。
 *   给需要完整事件语义（多行 data、event 字段分组）的调用方用。
 */
export interface SSEParserOptions {
  mode?: 'line' | 'event'
}

const CR = 13
const LF = 10

export function createSSEParser(
  onData: (data: string) => void,
  options?: SSEParserOptions
): SSEParser {
  const mode = options?.mode ?? 'line'
  let buffer = ''
  /** event 模式下当前事件已累积的 data 行 */
  let pending: string[] = []
  /** 上一个 chunk 以孤立 CR 结尾：下一个 chunk 若以 LF 开头，那是同一个 CRLF 的后半截 */
  let swallowLeadingLF = false

  const handleLine = (line: string): void => {
    if (mode === 'line') {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data.length > 0) onData(data)
      return
    }

    // event 模式：空行 = 事件边界
    if (line.length === 0) {
      if (pending.length > 0) {
        const joined = pending.join('\n')
        pending = []
        if (joined.length > 0) onData(joined)
      }
      return
    }
    if (line.startsWith(':')) return // 注释行不进事件内容
    if (!line.startsWith('data:')) return
    // 规范：`data:` 后紧跟的单个前导空格要去掉；其余原样保留（含行内空格）
    const raw = line.slice(5)
    pending.push(raw.startsWith(' ') ? raw.slice(1) : raw)
  }

  /** 切出完整行。CR / LF / CRLF 三种换行都认；孤立 CR 立即成行，并记下可能要吞的下一个 LF。 */
  const drain = (): void => {
    let start = 0
    let i = 0
    while (i < buffer.length) {
      const ch = buffer.charCodeAt(i)
      if (ch === LF) {
        handleLine(buffer.slice(start, i))
        i += 1
        start = i
      } else if (ch === CR) {
        handleLine(buffer.slice(start, i))
        if (i + 1 < buffer.length) {
          i += buffer.charCodeAt(i + 1) === LF ? 2 : 1
        } else {
          // CR 是缓冲区末尾：已按行尾结算；若下个 chunk 以 LF 开头，那是同一个 CRLF
          i += 1
          swallowLeadingLF = true
        }
        start = i
      } else {
        i += 1
      }
    }
    buffer = buffer.slice(start)
  }

  return {
    push(chunk: string): void {
      if (swallowLeadingLF) {
        swallowLeadingLF = false
        if (chunk.startsWith('\n')) chunk = chunk.slice(1)
      }
      buffer += chunk
      drain()
    },
    end(): void {
      // 缓冲区里还剩没有换行结尾的内容：按行处理一次（与旧 line 行为一致）
      if (buffer.length > 0) {
        const tail = buffer
        buffer = ''
        handleLine(tail)
      }
      // ⚠️ event 模式下**不补发**未闭合事件：缺空行的事件是残片，宁可丢弃也不当成功。
      pending = []
      swallowLeadingLF = false
    }
  }
}
