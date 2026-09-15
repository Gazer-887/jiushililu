// Playbook 共享契约（plan19 批 3）：会做线（程序记忆）的类型与校验。
// ⚠️ 不 import electron —— 渲染进程要引用它；architecture.test.ts 的守卫甲会沿 import 图抓。
// 分层照项目惯例：共享类型住这里，纯逻辑住 `memory/playbook-core.ts`，装配住 `store/playbook-store.ts`。

import { findCredentialShape, utf8Bytes, type MemoryGuardVerdict, type MemoryValidation } from './memory'

/** Playbook 条目 origin。`model` = 模型直接写入；`playbook-reflection` = 反思产出（后续迭代） */
export const PLAYBOOK_ORIGINS = ['model', 'playbook-reflection'] as const
export type PlaybookOrigin = (typeof PLAYBOOK_ORIGINS)[number]

/**
 * 预算常量。⚠️ 全部是 plan19 §五 声明的无实验支撑初值。
 * `maxEntries` 比 memory 的 100 少（Playbook 是精炼的步骤，不是泛记忆）。
 */
export const PLAYBOOK_LIMITS = {
  /** 条目总数上限 */
  maxEntries: 50,
  /** 单条正文字节上限 */
  maxBodyBytes: 4 * 1024,
  /** description 字符上限 */
  maxDescriptionChars: 120,
  /** name 字符上限 */
  maxNameChars: 64,
  /** 每条最多标签数 */
  maxTags: 10,
  /** 单个标签字符上限 */
  maxTagChars: 32,
  /** 注入段字节上限（独立于 memory 的 maxIndexBytes） */
  maxInjectBytes: 4 * 1024
} as const

/** 一条 Playbook 条目。`file` 是来源绝对路径 */
export interface PlaybookEntry {
  name: string
  description: string
  tags: string[]
  origin: PlaybookOrigin
  createdAt: string
  updatedAt: string
  body: string
  file: string
}

/** 注入用的索引视图 */
export interface PlaybookIndex {
  entries: PlaybookEntry[]
  total: number
  omitted: number
  warnings: string[]
}

/** 保存入参 */
export interface PlaybookSaveInput {
  name: string
  description: string
  tags: string[]
  body: string
  origin?: PlaybookOrigin
  file?: string
}

/** 保存结果 */
export type PlaybookSaveResult =
  | { ok: true; file: string }
  | { ok: false; reason: string }

/**
 * 撞名比较的唯一口径（与 memoryNameKey 同语义）。
 */
export function playbookNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** 合法标签字符：字母、数字、连字符、下划线、中文 */
const TAG_CHAR = /^[\w\u4e00-\u9fff-]+$/

/** 标签规范化：trim + 小写（与 playbookNameKey 同口径） */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase()
}

const NAME_FORBIDDEN = /[\\/:*?"<>|\r\n\t]/
const FM_BOUNDARY = '---'

function hasControlChars(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(text)
}

/**
 * Playbook 条目校验（与 validateMemoryFields 同口径，复用凭据检测）。
 */
export function validatePlaybookFields(input: {
  name: string
  description: string
  body: string
  tags: string[]
}): MemoryValidation {
  const name = input.name
  if (name.length === 0) return { ok: false, reason: 'name 缺失' }
  if (name.length > PLAYBOOK_LIMITS.maxNameChars) {
    return { ok: false, reason: `name 超出上限（${PLAYBOOK_LIMITS.maxNameChars} 字符）` }
  }
  if (NAME_FORBIDDEN.test(name)) {
    return { ok: false, reason: 'name 含非法字符' }
  }
  if (name.startsWith(FM_BOUNDARY)) {
    return { ok: false, reason: 'name 不能以 --- 开头' }
  }

  const desc = input.description
  if (desc.length === 0) return { ok: false, reason: 'description 缺失' }
  if (desc.length > PLAYBOOK_LIMITS.maxDescriptionChars) {
    return { ok: false, reason: `description 超出上限（${PLAYBOOK_LIMITS.maxDescriptionChars} 字符）` }
  }
  if (hasControlChars(desc)) return { ok: false, reason: 'description 必须是单行' }
  if (desc.includes(FM_BOUNDARY)) return { ok: false, reason: 'description 不能含 ---' }

  const body = input.body
  if (body.trim().length === 0) return { ok: false, reason: '正文不能为空' }
  if (utf8Bytes(body) > PLAYBOOK_LIMITS.maxBodyBytes) {
    return { ok: false, reason: `正文超出上限（${PLAYBOOK_LIMITS.maxBodyBytes / 1024} KB）` }
  }
  if (body.split(/\r?\n/).some((line) => line.trimStart() === FM_BOUNDARY)) {
    return { ok: false, reason: '正文不能有一行只写 ---' }
  }

  const tags = input.tags
  if (tags.length === 0) return { ok: false, reason: '至少需要一个标签' }
  if (tags.length > PLAYBOOK_LIMITS.maxTags) {
    return { ok: false, reason: `标签数超出上限（${PLAYBOOK_LIMITS.maxTags} 个）` }
  }
  for (const tag of tags) {
    if (tag.length === 0) return { ok: false, reason: '标签不能为空' }
    if (tag.length > PLAYBOOK_LIMITS.maxTagChars) {
      return { ok: false, reason: `标签 "${tag}" 超出上限（${PLAYBOOK_LIMITS.maxTagChars} 字符）` }
    }
    if (!TAG_CHAR.test(tag)) {
      return { ok: false, reason: `标签 "${tag}" 含非法字符（只允许字母、数字、连字符、下划线、中文）` }
    }
  }

  // 凭据检测（复用 memory 的 findCredentialShape）
  let guard: MemoryGuardVerdict = { action: 'allow' }
  for (const text of [name, desc, body]) {
    const cred = findCredentialShape(text)
    if (cred && cred.kind === 'known-prefix') {
      return { ok: false, reason: '文本含疑似凭据（密钥/token）。请在密钥管理中保存，不要写进 Playbook' }
    }
    if (cred) {
      guard = { action: 'confirm', reason: '文本含疑似长凭据串' }
    }
  }

  return { ok: true, guard }
}
