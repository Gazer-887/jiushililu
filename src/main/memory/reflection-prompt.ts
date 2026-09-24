// 反思 system prompt（plan19 批 2 装配层 → plan25 拆出独立模块）。
// 单独成文件的唯一理由：**单测要断言它的内容**（plan25 判据 7）—— 组合根 index.ts 挂着
// electron 全家桶，测试 import 它会连带启动副作用。prompt 本身是纯常量，住这里零依赖。

import { PROFILE_NAME } from '../../shared/memory'
import { MEMORY_LIMITS, type MemoryEntry } from '../../shared/memory'
import { indexLine } from './memory-core'

/**
 * 反思用的「已知记忆」数据块（plan55 片② / K35 扩法）。
 *
 * **为什么候选也要带**：候选区刻意不进 `buildIndex`（未批准不得生效），
 * 所以只喂已生效索引时，模型看不见待批队列 —— 同一件事会被反复提案（09-25 实测 71 条候选、
 * 40+ 条落在 8 个同义簇，正是这个形状）。带上候选**不等于承认它已生效**：块里明确写了它是待批。
 *
 * 三条硬约束：① **只带 name + description，正文一律不出境**（候选正文出境 = 绕过审批门）；
 * ② **静态**（同一批数据逐字节相同，否则前缀缓存每轮失效）；③ 超预算的 `omitted` **如实写进块里**。
 * 两段的字节尺子都复用 `MEMORY_LIMITS.maxIndexBytes`，不另造一个没量过的数。
 */
export function composeReflectionContext(
  entries: ReadonlyArray<Pick<MemoryEntry, 'name' | 'description' | 'class' | 'updatedAt'>>,
  candidates: ReadonlyArray<Pick<MemoryEntry, 'name' | 'description' | 'class' | 'updatedAt'>>,
  /**
   * 已存但**因注入预算没进 `entries`** 的条数（`MemoryIndex.omitted`）。
   * ⚠️ 必须显式传：`list().entries` 是**已注入的子集**（8 KB 预算裁过），
   * 只靠本函数自己再裁一遍永远算不出 omitted —— 那会让"库里其实还有"这件事静默消失。
   */
  liveOmitted = 0
): string | null {
  if (entries.length === 0 && candidates.length === 0 && liveOmitted === 0) return null

  const render = (
    list: ReadonlyArray<Pick<MemoryEntry, 'name' | 'description' | 'class' | 'updatedAt'>>,
    budget: number
  ): { lines: string[]; omitted: number } => {
    const sorted = [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const lines: string[] = []
    let bytes = 0
    for (const e of sorted) {
      const line = indexLine(e as MemoryEntry)
      const cost = Buffer.byteLength(line, 'utf8')
      if (bytes + cost > budget) break
      lines.push(line)
      bytes += cost
    }
    return { lines, omitted: sorted.length - lines.length }
  }

  const live = render(entries, MEMORY_LIMITS.maxIndexBytes)
  const pending = render(candidates, MEMORY_LIMITS.maxIndexBytes)
  const parts = [
    '<known-memories>',
    '下面是**已存在的记忆**。与其中任何一条说同一件事（换了措辞也算）的，**不要再提出**；',
    '确实要补充旧条目的，沿用它的名字，不要另起一个近义名。',
    '',
    '<already-effective>',
    ...live.lines,
    ...(live.omitted + liveOmitted > 0
      ? [`（另有 ${live.omitted + liveOmitted} 条未列出：超出注入预算，仍需在库中，别重复提出）`]
      : []),
    '</already-effective>',
    '',
    '<pending-approval>（这些是待用户批准的提案，**尚未生效**，但同样不要重复提出）',
    ...pending.lines,
    ...(pending.omitted > 0 ? [`（另有 ${pending.omitted} 条因超出上限未列出）`] : []),
    '</pending-approval>',
    '</known-memories>'
  ]
  return parts.join('\n')
}

// plan25 D-073：追加画像维护指令 —— 反思是画像唯一的自动来源（模型直写被 save 层拒绝）。
// 「完整画像非增量补丁」：画像批准后整体覆盖旧画像，增量碎片会互相堆叠成失真档案。
const PROFILE_INSTRUCTION = [
  `用户画像：若对话揭示了**跨场景**的用户特征（身份角色、长期偏好、常用技术栈、进行中的项目），`,
  `输出一条 name="${PROFILE_NAME}"、class="profile" 的候选，body 是**完整画像**（markdown 分节：`,
  `## 身份 / ## 偏好 / ## 技术栈 / ## 进行中项目 等），不是增量补丁 —— 画像批准后会整体覆盖旧画像。`
].join('')

export const REFLECTION_SYSTEM_PROMPT = [
  '你是一个记忆反思助手。分析以下对话，提取值得长期记住的事实。',
  '只提取**稳定**的事实（用户偏好、项目约定、反复出现的模式），不提取一次性问题或临时上下文。',
  '输出一个 JSON 数组，每个元素代表一条记忆候选，字段如下：',
  '- name: 唯一标识，简短（如 "prefers-tabs-over-spaces"）',
  '- description: 一句话概括这条记忆说的是什么',
  '- class: 分类，只能是 "style"（风格偏好）、"default"（通用习惯）、"knowledge"（领域知识）、"profile"（用户画像）',
  '- body: 记忆正文，客观陈述事实',
  PROFILE_INSTRUCTION,
  '如果没有值得记住的事实，返回空数组 []。',
  '只输出 JSON，不要解释。'
].join('\n')
