// token 估算的**单一真相源**（主进程裁剪与渲染端用量显示共用，防两处算法漂移）。
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

/** 单条消息的估算（含 role 与工具调用的固定开销，故在正文之外 +4） */
export function estimateMessageTokens(content: string, extraJson = ''): number {
  return estimateTokens(content) + estimateTokens(extraJson) + 4
}

/**
 * 单张图的 token **上界**。⚠️ 未直读厂商官方原文：业界两处独立实现取 1568 / 1600，
 * 按 `(w×h)/750` 公式一屏截图可到 ~1.8k ⇒ 这里取宽上界，**宁可高估也不低估**。
 */
export const IMAGE_TOKEN_CEIL = 2000

export type TokenPayloadPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; width?: number; height?: number }

/**
 * 图片块按**几何**估，绝不按 base64 长度估。
 * ⚠️ 回归防线：base64 全是非 CJK，走 `estimateTokens` 会被放大两个数量级
 * （1568×882 的截图 ≈190 万字符 → 475,000 token，真实约 1.8k），一张就超裁剪触发线。见 plan57 片⓪ / K50。
 */
export function estimateImageTokens(width?: number, height?: number): number {
  if (!width || !height || width < 1 || height < 1) return IMAGE_TOKEN_CEIL
  const scale = Math.min(1, 1568 / Math.max(width, height))
  const w = width * scale
  const h = height * scale
  return Math.max(1, Math.min(IMAGE_TOKEN_CEIL, Math.ceil((w * h) / 750)))
}

/** 多模态 payload 的估算（片③ 出境形状扩到 block 后接这里；固定开销与 `estimateMessageTokens` 同口径） */
export function estimatePayloadTokens(parts: TokenPayloadPart[], extraJson = ''): number {
  let sum = 0
  for (const p of parts) {
    sum += p.type === 'text' ? estimateTokens(p.text) : estimateImageTokens(p.width, p.height)
  }
  return sum + estimateTokens(extraJson) + 4
}

/** `ContentPart` / `WirePart` 都能进来的最小形状（共享层两侧都不许再各写一份映射） */
type EstparablePart = { type: 'text'; text: string } | { type: 'image' }

/**
 * 一轮的估算：带 `parts` 就按块算（图按几何/上界），否则与改造前同一条公式。
 * ⚠️ 判据 K50 的落点：**有图的一轮绝不许走 base64 字符数**，否则一张截图被估成几十万 token，
 * 下一轮 `trimMessages` 就把整段历史折进摘要。
 */
export function estimatePartsTokens(parts: EstparablePart[], extraJson = ''): number {
  return estimatePayloadTokens(
    parts.map((p): TokenPayloadPart => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image' })),
    extraJson
  )
}
