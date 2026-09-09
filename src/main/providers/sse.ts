// 极简 SSE（text/event-stream）行解析器。
// 只关心 "data:" 行 —— OpenAI 兼容协议与 Anthropic 协议的业务数据都装在 data 行里。
// 纯实现（零依赖，不 import electron/node 专有模块），可直接单元测试。

export interface SSEParser {
  push: (chunk: string) => void
  end: () => void
}

export function createSSEParser(onData: (data: string) => void): SSEParser {
  let buffer = ''

  const processLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '')
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data.length > 0) onData(data)
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        processLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
      }
    },
    end(): void {
      if (buffer.length > 0) processLine(buffer)
      buffer = ''
    }
  }
}
