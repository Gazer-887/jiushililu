// token 估算的**单一真相源**（主进程上下文裁剪与渲染进程用量显示共用，避免两处算法漂移）。
// 口径：CJK 按 1 token/字（保守上限），其余按 4 字符/token。

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk++ // CJK 表意文字 / 假名 / 全角标点区
  }
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 4)
}

/** 单条消息的估算（含 role 与工具调用的固定开销） */
export function estimateMessageTokens(content: string, extraJson = ''): number {
  return estimateTokens(content) + estimateTokens(extraJson) + 4
}
