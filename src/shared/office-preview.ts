/**
 * Office 内嵌预览（docx / xlsx）—— 判定、上限与内存预览 URL 的**纯逻辑层**（可单测）。
 *
 * ⚠️ 为什么渲染走 `jsl-preview:` 沙箱 iframe，而不是把解析出的 HTML 灌进主文档：
 *    docx/xlsx 解析产物是**用户文件里的不可信内容**，而渲染层「零 HTML 注入原语」是
 *    已 grep 核实并写进 CSP 注释的安全基线（见 config/electron.vite.config.ts）——
 *    破了它，任何消毒库都只是把"执行用户内容"从"必然"降为"大概率不会"。
 *    所以复用 HTML 预览那套**真实 scheme 沙箱**：主进程解析 → 注册进内存表 →
 *    渲染端 `<iframe sandbox="">` 加载 `jsl-preview://mem/<token>`，
 *    两道锁与 HTML 预览完全一致（iframe sandbox + 响应头 CSP 断脚本断网）。
 */

import { PREVIEW_SCHEME } from './html-preview'

/** Office 预览的体积上限：解析在主进程做，但几十 MB 的文档转出的 HTML 会把内存表和 iframe 一起拖死 */
export const MAX_OFFICE_BYTES = 20 * 1024 * 1024

/** docx 内嵌预览只认 `.docx`（`.doc` 是老二进制格式，mammoth 不支持 → 走「用系统程序打开」） */
const DOCX_EXT = new Set(['.docx'])

/** 表格内嵌预觘认的格式（SheetJS 都支持；`.csv` 是文本，走已有的文本通道） */
const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.xls'])

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

export function isDocxPreviewable(name: string): boolean {
  return DOCX_EXT.has(extOf(name))
}

export function isSheetPreviewable(name: string): boolean {
  return SHEET_EXT.has(extOf(name))
}

/** 内存预览的固定主机名（与文档预览的 `doc` 并列；标准 scheme 必须有 host） */
export const MEM_PREVIEW_HOST = 'mem'

/** 内存条目存活时长：预览是短命数据（用户切走页签就该让它走），不是缓存 */
export const MEM_PREVIEW_TTL_MS = 10 * 60 * 1000

/** 内存条目上限：防"狂点 100 个文档"把主进程内存吃穿（超限淘汰最旧） */
export const MEM_PREVIEW_MAX_ENTRIES = 32

/** token 长度（字节）——128 bit 随机，不可猜：预览 URL 谁都可能看见（DOM 里），能猜到才能读到。
 *  ⚠️ 单一真源：主进程用 `randomBytes(MEM_TOKEN_BYTES)` 生成，下面的校验正则也由它拼出 —— 改一边必红另一边。 */
export const MEM_TOKEN_BYTES = 16

/** 生成内存预览 URL（token 由主进程 `crypto.randomBytes` 产出） */
export function memPreviewUrl(token: string): string {
  return `${PREVIEW_SCHEME}://${MEM_PREVIEW_HOST}/${token}`
}

/** token 形状校验（MEM_TOKEN_BYTES × 2 位十六进制）：协议 handler 的第一道门，不是这个形状直接 404 */
export function isMemPreviewToken(s: string): boolean {
  return typeof s === 'string' && new RegExp(`^[0-9a-f]{${MEM_TOKEN_BYTES * 2}}$`).test(s)
}

// ── xlsx 截断上限：巨型工作簿整表转 HTML 会卡死 iframe，宁可明说"只显示前一段" ──

export const SHEET_CLIP_ROWS = 500
export const SHEET_CLIP_COLS = 50
/** sheet 数量上限（再多只给前 12 个，界面提示"其余未显示"） */
export const SHEET_COUNT_LIMIT = 12

/** 列字母 → 序号（A=1, Z=26, AA=27）；非法输入返回 0 */
export function colToNum(col: string): number {
  let n = 0
  for (const ch of col) {
    const v = ch.charCodeAt(0) - 64 // 'A' = 65
    if (v < 1 || v > 26) return 0
    n = n * 26 + v
  }
  return n
}

/** 序号 → 列字母（1=A）；非正数返回空串 */
export function numToCol(n: number): string {
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * 把 A1 引用（如 `BC100:XA900`）按上限截断，返回**新的** A1 引用；空 / 畸形返回 null。
 * 只算"左上角不动、右下角往回收"，不碰单元格数据 —— 截断本身由调用方在 SheetJS 对象上完成。
 */
export function clipRange(ref: unknown, maxRows: number, maxCols: number): string | null {
  if (typeof ref !== 'string') return null
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref.toUpperCase())
  if (!m) return null
  const c1 = colToNum(m[1])
  const r1 = Number(m[2])
  const c2 = colToNum(m[3])
  const r2 = Number(m[4])
  if (c1 === 0 || c2 === 0 || !Number.isFinite(r1) || !Number.isFinite(r2)) return null
  if (r1 < 1 || r2 < r1 || c2 < c1) return null
  const rEnd = Math.min(r2, r1 + maxRows - 1)
  const cEnd = Math.min(c2, c1 + maxCols - 1)
  return `${numToCol(c1)}${r1}:${numToCol(cEnd)}${rEnd}`
}

// ── 结果类型（跨 IPC：主进程解析 → 渲染端只拿 URL，不拿 HTML 本体）──

export interface OfficeSheetEntry {
  name: string
  /** 该 sheet 的内存预览 URL（`jsl-preview://mem/<token>`） */
  url: string
}

export type FsOfficeResult =
  | { ok: true; rel: string; size: number; kind: 'docx'; url: string }
  | {
      ok: true
      rel: string
      size: number
      kind: 'sheet'
      sheets: OfficeSheetEntry[]
      /** 有 sheet 被截断（行/列/数量超上限）—— 渲染端要明说，不假装显示全了 */
      clipped: boolean
      sheetCount: number
    }
  | { ok: false; rel: string; size: number; error: string }
