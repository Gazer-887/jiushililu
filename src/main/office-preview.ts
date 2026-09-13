/**
 * Office 内嵌预览（主进程侧）：读工作区文件 → mammoth / SheetJS 解析 → 注册内存预览。
 *
 * 职责边界（为什么这样切）：
 *  - **解析在主进程**：渲染层「零 HTML 注入原语」是已核实的安全基线 —— HTML 是用户文件内容，
 *    一次 innerHTML 就破功；主进程解析完只给渲染端一个**沙箱 URL**，注入原语继续为零。
 *  - **HTML 不落盘**：落盘就要操心清理、污染工作区、被文件树看见；内存表 + TTL + 上限
 *    三件套够了 —— 预览本来就是短命数据，页签切走就该让它死。
 *  - ⚠️ 本文件**不 import electron**：解析与内存表是纯 Node 逻辑，tests/unit 直接单测；
 *    协议挂载（`jsl-preview://mem/`）在 preview-protocol.ts，IPC 壳在 ipc.ts。
 */
import { readFile, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import {
  MAX_OFFICE_BYTES,
  MEM_TOKEN_BYTES,
  MEM_PREVIEW_MAX_ENTRIES,
  MEM_PREVIEW_TTL_MS,
  SHEET_CLIP_COLS,
  SHEET_CLIP_ROWS,
  SHEET_COUNT_LIMIT,
  clipRange,
  isDocxPreviewable,
  isSheetPreviewable,
  memPreviewUrl
} from '@shared/office-preview'
import type {
  FsOfficeResult,
  OfficeSheetEntry
} from '@shared/office-preview'
import { resolveInsideWorkspace } from './agent/guard'

// ── 内存预览表 ─────────────────────────────────────────────────────────

export interface MemPreviewStore {
  /** 注册一份 HTML，返回不可猜的 token（URL 里暴露的就是它） */
  register: (html: string) => string
  /** 取 HTML；不存在 / 已过期返回 null（调用方一律 404，不区分"没注册过"和"过期了"） */
  get: (token: string) => string | null
}

/** 可注入时间与上限 —— 单测不用睡真时钟 */
export function createMemPreviewStore(
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
): MemPreviewStore {
  const ttl = opts.ttlMs ?? MEM_PREVIEW_TTL_MS
  const max = opts.maxEntries ?? MEM_PREVIEW_MAX_ENTRIES
  const now = opts.now ?? Date.now
  const mem = new Map<string, { html: string; at: number }>()

  const evict = (): void => {
    const t = now()
    for (const [k, v] of mem) if (t - v.at > ttl) mem.delete(k)
    while (mem.size >= max) {
      // 删最旧（Map 保序但 register 后无再排序，直接扫一遍最稳 —— 32 条扫不出开销）
      let oldest: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [k, v] of mem) if (v.at < oldestAt) [oldest, oldestAt] = [k, v.at]
      if (oldest === null) break
      mem.delete(oldest)
    }
  }

  return {
    register(html: string): string {
      evict()
      const token = randomBytes(MEM_TOKEN_BYTES).toString('hex')
      mem.set(token, { html, at: now() })
      return token
    },
    get(token: string): string | null {
      const hit = mem.get(token)
      if (!hit) return null
      if (now() - hit.at > ttl) {
        mem.delete(token)
        return null
      }
      return hit.html
    }
  }
}

/** 进程级单例（ipc.ts 与测试外的一切调用都走它） */
export const memPreviews: MemPreviewStore = createMemPreviewStore()

// ── 解析（纯 Buffer → HTML，不碰文件系统，单测直接喂字节）────────────────

/** docx 正文的排版骨架：mammoth 出的是语义标签（h1/p/table/img），给它一个能看的版面 */
function wrapDocxHtml(bodyHtml: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'margin:24px auto;max-width:760px;line-height:1.7;color:#1f1f1f;background:#fff}',
    'table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}',
    'img{max-width:100%}a{color:#06c}',
    '</style></head><body>',
    bodyHtml,
    '</body></html>'
  ].join('')
}

/** 表格的排版骨架：sheet_to_html 出的是裸 <table>，加上边框和留白才像一张表 */
function wrapSheetHtml(tableHtml: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'margin:16px;background:#fff}',
    'table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;',
    'font-size:13px;color:#1f1f1f;white-space:pre}',
    '</style></head><body>',
    tableHtml,
    '</body></html>'
  ].join('')
}

/** docx 字节 → 完整 HTML。损坏 / 非法输入**抛异常**（由调用方统一转成友好的失败结果） */
export async function parseDocxBuffer(buf: Buffer): Promise<string> {
  const res = await mammoth.convertToHtml({ buffer: buf })
  return wrapDocxHtml(res.value)
}

export interface ParsedWorkbook {
  sheets: { name: string; html: string }[]
  /** 有 sheet 被截断（行/列/数量超上限）—— 上层要如实转告用户 */
  clipped: boolean
  /** 工作簿里实际的 sheet 数（可能大于返回的 sheets 数） */
  sheetCount: number
}

/** xlsx/xls 字节 → 每个 sheet 一份 HTML。截断规则：行/列裁到上限，sheet 只取前 N 个 */
export function parseSheetBuffer(buf: Buffer): ParsedWorkbook {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const names = wb.SheetNames.slice(0, SHEET_COUNT_LIMIT)
  let clipped = wb.SheetNames.length > SHEET_COUNT_LIMIT
  const sheets = names.map((name) => {
    const raw = wb.Sheets[name] ?? {}
    const ref = raw['!ref']
    const clippedRef = clipRange(ref, SHEET_CLIP_ROWS, SHEET_CLIP_COLS)
    if (clippedRef !== null && clippedRef !== (ref ?? '').toUpperCase()) clipped = true
    // 浅拷贝改 `!ref` 就够：sheet_to_html 按 `!ref` 迭代，范围外的键不会被访问
    const ws = clippedRef !== null && clippedRef !== ref ? { ...raw, '!ref': clippedRef } : raw
    const tableHtml =
      clippedRef === null
        ? '<p>（空工作表）</p>'
        : XLSX.utils.sheet_to_html(ws, { header: '', footer: '' })
    return { name, html: wrapSheetHtml(tableHtml) }
  })
  return { sheets, clipped, sheetCount: wb.SheetNames.length }
}

// ── 组装：工作区文件 → 沙箱 URL（IPC handler 调的就是它）──────────────────

export async function renderOfficePreview(
  root: string,
  rel: string,
  store: MemPreviewStore = memPreviews
): Promise<FsOfficeResult> {
  const docx = isDocxPreviewable(rel)
  if (!docx && !isSheetPreviewable(rel)) {
    return { ok: false, rel, size: 0, error: '不是支持的 Office 格式（docx / xlsx / xls / xlsm）' }
  }
  const abs = resolveInsideWorkspace(root, rel)
  if (!abs) return { ok: false, rel, size: 0, error: `路径「${rel}」越出工作区边界，拒绝访问` }

  let buf: Buffer
  let size: number
  try {
    const st = await stat(abs)
    if (!st.isFile()) return { ok: false, rel, size: 0, error: '该路径不是文件' }
    size = st.size
    if (st.size > MAX_OFFICE_BYTES) {
      return { ok: false, rel, size, error: '文件超过 20 MB 预览上限，请用系统程序打开' }
    }
    buf = await readFile(abs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, rel, size: 0, error: `无法读取该文件：${msg}` }
  }

  try {
    if (docx) {
      const html = await parseDocxBuffer(buf)
      return { ok: true, rel, size, kind: 'docx', url: memPreviewUrl(store.register(html)) }
    }
    const { sheets, clipped, sheetCount } = parseSheetBuffer(buf)
    const entries: OfficeSheetEntry[] = sheets.map((s) => ({
      name: s.name,
      url: memPreviewUrl(store.register(s.html))
    }))
    return { ok: true, rel, size, kind: 'sheet', sheets: entries, clipped, sheetCount }
  } catch {
    return { ok: false, rel, size, error: '解析失败：文件可能已损坏或不是标准 Office 格式' }
  }
}
