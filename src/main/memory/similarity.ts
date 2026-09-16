// 记忆相似度判定（plan33：问题四去重的判定核心）。
//
// 为什么不用向量：代码检索用 grep、记忆召回用 name 精确匹配（见 memory-core）——
// 本项目检索层的一致哲学是**确定性可判定**优先；且这里只判「相似到会挤占同一个心智槽位」，
// 字符 bigram Jaccard + 包含判定已经够用，embedding 是 P5 可选项，不上。
//
// 纯函数、离线可测 —— memory-core 的写入闸门与 loadAll 的存量检测共用这一个口径。

import type { MemoryEntry } from '@shared/memory'

/** 判定为「疑似重复」的 Jaccard 阈值。保守取值：宁可漏放（用户手动清理）也不错杀（去重误伤最伤信任） */
export const MEMORY_SIMILAR_THRESHOLD = 0.7

/** 归一化：小写 + 去空白/标点 —— 中英文混排下减少无关差异 */
export function normalizeSimilarityText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符 bigram 集合（中文无分词器，bigram 是零依赖的最小可靠单元） */
export function charBigrams(s: string): Set<string> {
  const out = new Set<string>()
  if (s.length === 1) {
    out.add(s)
    return out
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Jaccard 相似度（bigram 集合交并比）。两串都空 → 1（视为全同） */
export function similarityScore(a: string, b: string): number {
  const na = normalizeSimilarityText(a)
  const nb = normalizeSimilarityText(b)
  if (na.length === 0 && nb.length === 0) return 1
  if (na.length === 0 || nb.length === 0) return 0
  const ba = charBigrams(na)
  const bb = charBigrams(nb)
  let inter = 0
  for (const g of ba) if (bb.has(g)) inter++
  const union = ba.size + bb.size - inter
  return union === 0 ? 1 : inter / union
}

/** 参与比较的文本：name + description（正文太长且噪声大，只做索引级判断） */
function comparableText(e: { name: string; description: string }): string {
  return `${e.name} ${e.description}`
}

/**
 * 在既有条目里找「与 target 疑似重复」的那条，返回**分数最高的一个**（没有过线的返回 null）。
 * 判定两路：① 一方描述包含另一方（原 includes 判定，保留）② bigram Jaccard 过线。
 * name 精确撞名不在这里 —— 那是 `memoryNameKey` 的职责（memory-core 已拦）。
 */
export function findSimilarEntry(
  target: { name: string; description: string },
  entries: ReadonlyArray<Pick<MemoryEntry, 'name' | 'description' | 'file'>>,
  threshold: number = MEMORY_SIMILAR_THRESHOLD
): { file: string; name: string; description: string; score: number } | null {
  const targetText = comparableText(target)
  const targetDesc = normalizeSimilarityText(target.description)
  let best: { file: string; name: string; description: string; score: number } | null = null
  for (const e of entries) {
    const desc = normalizeSimilarityText(e.description)
    const contained =
      (targetDesc.length > 0 && desc.includes(targetDesc)) ||
      (desc.length > 0 && targetDesc.includes(desc))
    const score = similarityScore(targetText, comparableText(e))
    const similar = contained || score >= threshold
    if (similar && (best === null || score > best.score)) {
      best = { file: e.file, name: e.name, description: e.description, score }
    }
  }
  return best
}

/**
 * 全库两两配对（loadAll 存量检测用）。返回所有过线对，每对保留较 Similar 的方向无所谓 ——
 * 面板展示 + 「合并到较新」按钮按 createdAt 决定方向，这里只负责找出配对。
 */
export function findDuplicatePairs(
  entries: ReadonlyArray<Pick<MemoryEntry, 'name' | 'description' | 'file'>>,
  threshold: number = MEMORY_SIMILAR_THRESHOLD
): Array<{ a: Pick<MemoryEntry, 'file' | 'name' | 'description'>; b: Pick<MemoryEntry, 'file' | 'name' | 'description'> }> {
  const out: Array<{
    a: Pick<MemoryEntry, 'file' | 'name' | 'description'>
    b: Pick<MemoryEntry, 'file' | 'name' | 'description'>
  }> = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!
      const b = entries[j]!
      const da = normalizeSimilarityText(a.description)
      const db = normalizeSimilarityText(b.description)
      const contained =
        (da.length > 0 && db.includes(da)) || (db.length > 0 && da.includes(db))
      if (contained || similarityScore(comparableText(a), comparableText(b)) >= threshold) {
        out.push({ a, b })
      }
    }
  }
  return out
}
