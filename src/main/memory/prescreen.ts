// 候选区预筛（plan55 片④-a）：把"同一件事被提了 6 遍"归成一簇，并给一份合并稿。
//
// 分工说清楚，免得后来人以为这里有智能：
// - **分组与合并稿的文字是模型产的**（`parsePrescreenResult` 不调模型，只验形状）；
// - **这一层只负责"模型说的话能不能信"**：每条候选必须恰好属于一簇、来源指针必须指向真存在的候选、
//   style/profile 不许被合并、合并稿必须带原文附录。不满足就整份退回，不做"尽力而为的采信"。
// - ⚠️ **判据只能测形状，测不了"分得对不对"**（plan55 §六）。别拿本文件的用例全绿当"筛得准"。

import { MEMORY_LIMITS, type MemoryEntry } from '@shared/memory'

/** 预筛的 system prompt —— 独立常量，单测断言内容（防悄悄改坏，同 `reflection-prompt.ts` 的理由）*/
export const PRESCREEN_SYSTEM_PROMPT = [
  '你在整理一个"待批准的记忆提案"队列。同一个要求常被换个措辞提很多遍，你的任务是归并。',
  '规则：',
  '1. 把说**同一件事**的提案归成一簇（换措辞也算同一件事）；没有同伴的单独成一簇；',
  '2. 每簇给一份合并稿：保留每一条里的**限定条件与禁止项**，一条都不许丢 —— 宁可长一点，不许概括；',
  '3. 不许新增输入里没有的事实；不确定就照原文写；',
  '4. `class` 为 style 或 profile 的提案**不要合并**，各自单独成一簇；',
  '5. 只输出 JSON 数组，元素形如 {"sources":["c1","c3"],"name":"…","description":"…",' +
    '"class":"style|default|knowledge|profile","body":"合并正文"}；',
  '6. `sources` 里只许用输入给你的**编号**（c1、c2…），不许自创、也不许写文件名。'
].join('\n')

/**
 * 给每条候选一个**短句柄**（c1、c2…）。
 * ⚠️ 不用文件路径当句柄，两个理由缺一不可：
 * ① 路径含用户名（`%APPDATA%\jiushililu\...` 里就是登录名）—— 发给第三方 API 是泄露面，
 *    与 `memory/events.ts` 里"`conflict` 只记 name 不记 file"同一条判断；
 * ② 让模型逐字回吐 Windows 绝对路径（反斜杠 + 长串）本来就脆，错一个字符整簇作废。
 */
export function prescreenHandle(index: number): string {
  return `c${index + 1}`
}

/** 输入给模型的候选行（只给 句柄 / class / name / description —— 正文与路径都不出境，同片② 的口径）*/
export function buildPrescreenPrompt(candidates: ReadonlyArray<MemoryEntry>): string {
  const lines = candidates.map(
    (c, i) => `${prescreenHandle(i)}\t[${c.class}]\t${c.name}\t${c.description}`
  )
  return [
    `待归并的提案（制表符分隔：编号 / 分类 / 名字 / 摘要；编号共 ${candidates.length} 个）：`,
    ...lines
  ].join('\n')
}

export interface PrescreenCluster {
  /** 真实文件路径（由句柄解出，**不是**模型给的原样串） */
  sources: string[]
  name: string
  description: string
  class: MemoryEntry['class']
  body: string
}

export interface PrescreenResult {
  clusters: PrescreenCluster[]
  /** 没被任何簇覆盖到的候选 —— 原样留在队列里，**不许悄悄消失** */
  uncovered: MemoryEntry[]
  /** 模型输出里被本层判为不可信而丢弃的元素 + 原因（进日志与界面，不静默） */
  rejected: Array<{ name: string; reason: string }>
}

const VALID_CLASSES = new Set(['style', 'default', 'knowledge', 'profile'])

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 校验模型给的归并结果。**任何一条不合格就整簇退回**，不做部分采信 ——
 * 半采信一份合并稿的后果是：用户批准的是一条没人验过的文字。
 */
export function parsePrescreenResult(
  raw: string,
  candidates: ReadonlyArray<MemoryEntry>
): PrescreenResult {
  const byFile = new Map(candidates.map((c) => [c.file, c]))
  /** 句柄 → 文件。模型只能从这里取，取不到就是它编的 */
  const byHandle = new Map(candidates.map((c, i) => [prescreenHandle(i), c.file]))
  const rejected: Array<{ name: string; reason: string }> = []
  const clusters: PrescreenCluster[] = []
  const covered = new Set<string>()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(raw))
  } catch {
    return { clusters: [], uncovered: [...candidates], rejected: [{ name: '(整份)', reason: '输出不是合法 JSON' }] }
  }
  if (!Array.isArray(parsed)) {
    return { clusters: [], uncovered: [...candidates], rejected: [{ name: '(整份)', reason: '输出不是数组' }] }
  }

  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      rejected.push({ name: '(非对象)', reason: '元素不是对象' })
      continue
    }
    const o = item as Record<string, unknown>
    const name = str(o['name'])
    const description = str(o['description'])
    const body = str(o['body'])
    const cls = str(o['class'])
    const sourcesRaw = Array.isArray(o['sources']) ? o['sources'] : []
    const handles = sourcesRaw.map((s) => str(s)).filter((s) => s.length > 0)
    /** 句柄解成真路径；解不开的记下来（模型编了一个不存在的编号）*/
    const sources = handles.map((h) => byHandle.get(h)).filter((f): f is string => f !== undefined)
    const bogus = handles.filter((h) => !byHandle.has(h))

    const fail = (reason: string): void => {
      rejected.push({ name: name || '(无名)', reason })
    }

    if (!name || !description || !body) fail('name / description / body 有缺')
    else if (!VALID_CLASSES.has(cls)) fail(`class 不合法：${cls}`)
    else if (handles.length === 0) fail('没有来源编号 —— 合并稿必须说清并了哪几条')
    else if (bogus.length > 0) fail(`来源编号不存在：${bogus.join(' , ')}`)
    else if (sources.length !== new Set(sources).size) fail('来源编号有重复')
    else {
      const srcs = sources.map((f) => byFile.get(f)!)
      // 硬约束 ②：style 与 profile 不许被合并（与 isExemptFromForget 同批理由）
      if (sources.length > 1 && srcs.some((s) => s.class === 'style' || s.class === 'profile')) {
        fail('style / profile 提案不许参与合并')
      } else if (sources.length === 1 && srcs[0]!.class !== cls) {
        fail('单条簇的 class 与原提案不一致')
      } else {
        clusters.push({ sources, name, description, class: cls as MemoryEntry['class'], body })
        for (const f of sources) covered.add(f)
      }
    }
  }

  return {
    clusters,
    uncovered: candidates.filter((c) => !covered.has(c.file)),
    rejected
  }
}

/** 剥 ```json … ``` 围栏（模型常加，JSON.parse 不认）—— 与 reflection.ts 同一处理 */
function stripFence(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  const end = t.lastIndexOf('```')
  if (end <= 3) return t
  const inner = t.slice(3, end)
  const nl = inner.indexOf('\n')
  return nl >= 0 ? inner.slice(nl + 1) : inner
}

/**
 * 合并稿的候选正文：模型给的 body **原样保留**，另附一节来源摘要。
 * ⚠️ 分隔行**不能是裸 `---`** —— 那会被 `validateMemoryFields` 的"正文不许有一行只写 `---`"
 *    直接拒掉（那条规则防的是 frontmatter 注入，不是针对这里；第一版就撞在这上面，
 *    表现是"预筛报告一切正常、合并稿一条都没落盘"）。
 * ⚠️ 来源只附 name + description（不附正文）—— 候选正文进 prompt 是片② 就划下的线；
 * 用户要看原文，界面上按 `sources` 展开读原候选（批准前那些候选一直还在）。
 */
export function composeMergedBody(cluster: PrescreenCluster, byFile: Map<string, MemoryEntry>): string {
  const lines = [cluster.body, '', '【并自以下提案】']
  for (const f of cluster.sources) {
    const e = byFile.get(f)
    if (e) lines.push(`- ${e.name}：${e.description}`)
  }
  return lines.join('\n').slice(0, MEMORY_LIMITS.maxBodyBytes * 2)
}
