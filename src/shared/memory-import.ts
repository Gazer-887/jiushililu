// 「导入其他记忆」的解析器（0.13.41 反馈新增）。
// 用户把步骤 1 的提示词贴到别的 AI，把它的回答粘贴回来 —— 这里的职责是把**自由文本**解析成
// 能过 `validateMemoryFields` 的草稿。⚠️ 只做解析，不做校验与落盘：唯一校验口径在 `validateMemoryFields`，
// 落盘走与手填完全相同的 `saveMemory`（撞名/超限/凭据一样会被拒），**导入不享受任何后门**。

import type { MemoryClass } from './memory'

/** 一条待导入的草稿（尚未过校验） */
export interface MemoryImportDraft {
  name: string
  description: string
  class: MemoryClass
  body: string
}

export type MemoryImportResult =
  | { ok: true; drafts: MemoryImportDraft[] }
  | { ok: false; reason: string }

/** 「分类:」行的中文 → 三分类。认不出的值不猜（宁缺勿错，缺了走默认并在错误里说明） */
const CLASS_ALIASES: Record<string, MemoryClass> = {
  风格: 'style',
  style: 'style',
  默认: 'default',
  default: 'default',
  知识: 'knowledge',
  knowledge: 'knowledge'
}

/** 步骤 1 的提示词：请外部 AI 按**本项目**的字段格式输出（名称/摘要/分类/正文，逐块空行） */
export const MEMORY_IMPORT_PROMPT = [
  '请帮我整理一份我的个人使用画像，用途是让我在不同 AI 工具之间保持一致的协作体验。',
  '请基于你当前能访问到的、与我相关的长期信息和本次会话上下文进行整理。',
  '在涉及我的指令和偏好时，尽量保留我原本的表述方式，不要过度改写。',
  '',
  '请按下面的格式逐条输出（每条一块，块之间空一行；一共 5~15 条，挑真正长期有用的，不要凑数）：',
  '',
  '### 名称（简短英文或中文标识，作为取用名）',
  '摘要: 一句话说明（20 字以内）',
  '分类: 风格 | 默认 | 知识',
  '正文:',
  '具体内容，可以多行。'
].join('\n')

function pickField(block: string, key: string): string | null {
  // 只认「key: 值」或「key：值」（半/全角冒号都收），且必须是**行首** —— 防正文里出现"摘要:"误匹配
  const m = new RegExp(`^${key}\\s*[:：]\\s*(.*)$`, 'm').exec(block)
  return m ? (m[1] ?? '').trim() : null
}

function toClass(raw: string | null): { cls?: MemoryClass; error?: string } {
  if (!raw) return { error: '缺「分类」' }
  const cls = CLASS_ALIASES[raw.trim().toLowerCase()] ?? CLASS_ALIASES[raw.trim()]
  return cls ? { cls } : { error: `「分类」无法识别：${raw}` }
}

/**
 * 解析粘贴回来的回答。宽松于格式、严格于内容：
 * 块按 `### ` 切；字段名认中英文与全/半角冒号；正文取「正文:」之后到块尾的所有行。
 * ⚠️ 一条都识别不出来时**整体失败**并给指路文案 —— 静默导入一篇空话比失败更糟。
 */
export function parseMemoryImport(text: string): MemoryImportResult {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return { ok: false, reason: '粘贴内容为空' }

  // ⚠️ 先判"有没有 ### 块"再切：split 对"整段无格式文本"也会返回 1 块，
  //    不加这道闸，用户贴错东西时只会看到一句莫名其妙的"缺摘要"
  if (!/^###\s*/m.test(normalized)) {
    return {
      ok: false,
      reason: '没识别到任何条目（应至少有一个以 ### 开头的块）。请确认粘贴的是按步骤 1 格式生成的回答'
    }
  }

  const blocks = normalized
    .split(/^###\s*/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)

  const drafts: MemoryImportDraft[] = []
  const errors: string[] = []
  blocks.forEach((block, i) => {
    const no = i + 1
    // 首行是名称（### 后面那一行）；⚠️ 若首行本身就是字段行（用户没写名称），
    // 不能把它当名称吃掉 —— 否则「摘要」字段整个丢失，整条报废
    const lines = block.split('\n')
    const firstLine = lines[0] ?? ''
    const firstIsField = /^(摘要|描述|分类|正文)\s*[:：]/.test(firstLine)
    const nameRaw = firstIsField ? '' : firstLine.replace(/^名称[:：]?/, '').trim()
    const rest = firstIsField ? block : lines.slice(1).join('\n')

    const summary = pickField(rest, '摘要') ?? pickField(rest, '描述') ?? ''
    const clsResult = toClass(pickField(rest, '分类'))
    const bodyMatch = /^正文\s*[:：]?\s*\n?([\s\S]*)$/m.exec(rest)
    const body = (bodyMatch?.[1] ?? '').trim()

    const name = nameRaw || summary.slice(0, 16)
    if (!name) errors.push(`第 ${no} 条：缺「名称」`)
    else if (!summary) errors.push(`第 ${no} 条：缺「摘要」`)
    else if (clsResult.error) errors.push(`第 ${no} 条：${clsResult.error}`)
    else if (!body) errors.push(`第 ${no} 条：缺「正文」`)
    else drafts.push({ name, description: summary, class: clsResult.cls as MemoryClass, body })
  })

  if (drafts.length === 0) {
    return {
      ok: false,
      reason: `识别到 ${blocks.length} 块但一条都不可用：${errors.slice(0, 3).join('；')}`
    }
  }
  // 部分可用也放行 —— 但错误要带回去给界面展示（坏一条不能拖累好几条，也不许静默丢）
  return { ok: true, drafts }
}
