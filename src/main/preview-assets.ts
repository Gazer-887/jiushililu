// 对话内预览的资产库与预算事务（plan74 执行补充 4.2 / 6.1，主进程侧）。
//
// 职责：把明确导入的文件安全地落成不可变副本，并全程守住共用预算。
// 输入区与历史快照经它取得assetId；Agent产物读原工作区当前文件，不制造第二份历史副本。
//
// 三条铁律（执行补充第六节命名断言钉住）：
//  ① stat 先于复制，复制期间长大也拒 —— 不能只信首个 stat。
//  ② 并发先预留预算，成功核结算，失败释放 —— 超额不能"两边都写进去"。
//  ③ 任何失败都不产生成功引用，也不泄漏预留。
//
// ⚠️ 与 attachments-store 的图片/视频引用制**并存不混**：那条线管模型出站（parts），
// 本模块管本地预览（localFiles）。图片/视频两个身份都登记，指向同一份字节，不复制两份内容。

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, isSafeAssetId } from '@shared/conversation-preview'

// ── 预算账本（进程内）─────────────────────────────────────────────────────

export interface AssetBudgetOptions {
  /** 单文件上限，默认 MAX_ASSET_BYTES（50MiB）。仅测试可缩小，不修改生产默认。 */
  maxAssetBytes?: number
  /** 总预算，默认 MAX_TOTAL_ASSET_BYTES（1GiB）。仅测试可缩小。 */
  maxTotalBytes?: number
}

/** 预留以对象身份归属一个账本；数值相同不代表同一笔占用。 */
export interface AssetReservation {
  readonly id: symbol
}

export class AssetBudget {
  private unavailable = false
  private reservedBytes = 0
  private readonly reservations = new Map<AssetReservation, number>()
  private readonly maxAsset: number
  private readonly maxTotal: number

  constructor(opts: AssetBudgetOptions = {}) {
    this.maxAsset = opts.maxAssetBytes ?? MAX_ASSET_BYTES
    this.maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_ASSET_BYTES
  }

  get maxAssetBytes(): number {
    return this.maxAsset
  }

  get maxTotalBytes(): number {
    return this.maxTotal
  }

  /** 当前占用（已提交 + 在途预留）。 */
  get usedBytes(): number {
    return this.reservedBytes
  }

  /** 在途预留计数。 */
  get pendingReservations(): number {
    return this.reservations.size
  }

  /**
   * 预留 n 字节并返回该笔身份。并发安全（单线程 JS，无 await 间隙）。
   * 已存占用与未提交预留同算 —— 不能并发分别检查"都没满"却共同超额。
   */
  reserve(bytes: number): AssetReservation | null {
    if (this.unavailable) return null
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxAsset) return null
    if (this.reservedBytes + bytes > this.maxTotal) return null
    const reservation: AssetReservation = Object.freeze({ id: Symbol('asset-reservation') })
    this.reservedBytes += bytes
    this.reservations.set(reservation, bytes)
    return reservation
  }

  /**
   * 将在途量调整到实际字节。超总预算时不改账；未结算前故障可整笔释放。
   */
  resize(reservation: AssetReservation, actualBytes: number): boolean {
    const reserved = this.reservations.get(reservation)
    if (reserved === undefined || !Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > this.maxAsset) return false
    if (this.reservedBytes - reserved + actualBytes > this.maxTotal) return false
    this.reservedBytes += actualBytes - reserved
    this.reservations.set(reservation, actualBytes)
    return true
  }

  /** 正式文件与登记均成功后才结算；失败时仍保留可释放的预留身份。 */
  commit(reservation: AssetReservation, actualBytes: number): boolean {
    if (!this.resize(reservation, actualBytes)) return false
    this.reservations.delete(reservation)
    return true
  }

  /** 只释放本账本仍在途的那一笔；重复、跨账本、已提交的释放都是无操作。 */
  release(reservation: AssetReservation): void {
    const bytes = this.reservations.get(reservation)
    if (bytes === undefined) return
    this.reservedBytes -= bytes
    this.reservations.delete(reservation)
  }

  /** 把已落盘资产的占用计入（启动恢复 / 未知旧资产保守保留）。 */
  addCommitted(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(this.reservedBytes + bytes)) {
      throw new Error('资产占用必须是有限的非负整数字节')
    }
    this.reservedBytes += bytes
  }

  /** 不能核实未知存量时只拒绝新增，不删数据、不把未知读成0。 */
  blockAppends(): void { this.unavailable = true }
}

// ── 资产身份 ──────────────────────────────────────────────────────────────

export interface AssetIdentity {
  assetId: string
  bytes: number
  digest: string
}

/** 正式发布前的宿主登记；返回撤销动作，结算失败时撤回本次登记。 */
export type AssetPublisher = (asset: AssetIdentity) => (() => void) | void

/** 生成受限资产名：日期时间-序号-随机hex.扩展名。与 attachments 库命名同族，只认这一种形状。 */
function genAssetId(ext: string, index: number): string {
  const now = new Date()
  const ts =
    `${now.getFullYear()}`.padStart(4, '0') +
    `${now.getMonth() + 1}`.padStart(2, '0') +
    `${now.getDate()}`.padStart(2, '0') +
    'T' +
    `${now.getHours()}`.padStart(2, '0') +
    `${now.getMinutes()}`.padStart(2, '0') +
    `${now.getSeconds()}`.padStart(2, '0')
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  const cleanExt = ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'bin'
  return `${ts}-${index}-${rand}.${cleanExt}`
}

/** 取扩展名（不含点），无扩展名返回空串。 */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

// ── 摄取事务 ──────────────────────────────────────────────────────────────

export type IngestResult =
  | { ok: true; asset: AssetIdentity }
  | { ok: false; reason: string }

/** 资产库根目录：独立 `assets/` 子目录，与出站引用（attachments）分线。 */
export function assetsDir(userDataRoot: string): string {
  return join(userDataRoot, 'assets')
}

/** 旧媒体仍留在原目录，新预览与模型物化共用它的字节，不做迁移复制。 */
export function mediaAssetsDir(userDataRoot: string): string { return join(userDataRoot, 'attachments') }

const budgets = new Map<string, AssetBudget>()
export function assetBudgetForRoot(userDataRoot: string, options: AssetBudgetOptions = {}): AssetBudget {
  const root = resolve(userDataRoot)
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const existing = budgets.get(key)
  if (existing) return existing
  const budget = new AssetBudget(options)
  for (const dir of [assetsDir(root), mediaAssetsDir(root)]) {
    let scannedRoot = false
    try {
      trustedAssetRoot(dir)
      scannedRoot = true
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const real = realpathSync(path)
        const actualRoot = realpathSync(dir)
        if (!real.startsWith(actualRoot + sep)) throw new Error('资产存量越界')
        const st = statSync(real)
        if (!st.isFile()) throw new Error('无法核实嵌套资产存量')
        // 计入未知旧名和遗留临时件，不能靠名字过滤掉实际占用。
        budget.addCommitted(st.size)
      }
    } catch (error) {
      // 仅整个根确实尚不存在才当空库；扫描中任一项消失意味着剩余存量未知。
      if (scannedRoot || (error as NodeJS.ErrnoException).code !== 'ENOENT') budget.blockAppends()
    }
  }
  budgets.set(key, budget)
  return budget
}

/** 拒绝库目录本身被换成联接，允许宿主明确选定数据根的正常祖先路径。 */
function trustedAssetRoot(dir: string): string {
  const real = realpathSync(dir)
  const expected = join(realpathSync(dirname(dir)), basename(dir))
  const equal = process.platform === 'win32' ? real.toLowerCase() === expected.toLowerCase() : real === expected
  if (!equal) throw new Error('资产根目录被联接替换，已拒绝')
  return real
}

function storeRoots(assetsRoot: string): string[] {
  return basename(assetsRoot) === 'assets' ? [assetsRoot, mediaAssetsDir(dirname(assetsRoot))] : [assetsRoot]
}

/** 最终读取处解析真实路径。两个库同名为歧义，不能以查找顺序选错历史字节。 */
export function assetFilePath(assetsRoot: string, assetId: string): string {
  if (!isSafeAssetId(assetId)) throw new Error('资产身份形状不合法')
  const matches: string[] = []
  for (const dir of storeRoots(assetsRoot)) {
    const path = join(dir, assetId)
    try {
      const st = statSync(path)
      if (!st.isFile()) throw new Error('资产不是文件')
      const root = trustedAssetRoot(dir)
      const real = realpathSync(path)
      if (!real.startsWith(root + sep)) throw new Error('资产越界（解析到资产根之外）')
      matches.push(real)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (matches.length > 1) throw new Error('资产身份冲突，无法确定历史副本')
  if (!matches.length) throw new Error('资产不存在')
  return matches[0]
}

/** 已有媒体Buffer也走预算事务，失败不留下正式文件或占用。 */
export function storeAssetBuffer(buf: Buffer, displayName: string, dir: string, budget: AssetBudget, preferredId?: string, publish?: AssetPublisher): IngestResult {
  const reservation = budget.reserve(buf.length)
  if (!reservation) return { ok: false, reason: '附件总预算不足或旧存量无法核实' }
  const tmp = join(dir, `.ingest-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  let final: string | undefined
  let renamed = false
  let tmpOwned = false
  let rollback: (() => void) | void = undefined
  try {
    mkdirSync(dir, { recursive: true })
    trustedAssetRoot(dir)
    let id = preferredId && isSafeAssetId(preferredId) ? preferredId : genAssetId(extOf(displayName), 0)
    const roots = [assetsDir(dirname(dir)), mediaAssetsDir(dirname(dir))]
    while (roots.some(root => existsSync(join(root, id)))) id = genAssetId(extOf(displayName), 0)
    const fd = openSync(tmp, 'wx')
    tmpOwned = true
    try { writeAll(fd, buf) } finally { closeSync(fd) }
    const asset = { assetId: id, bytes: buf.length, digest: createHash('sha256').update(buf).digest('hex').slice(0, 16) }
    final = join(dir, id)
    renameSync(tmp, final)
    renamed = true
    rollback = publish?.(asset)
    if (!budget.commit(reservation, buf.length)) throw new Error('资产结算失败')
    return { ok: true, asset }
  } catch {
    try { rollback?.() } catch { /* 宿主异常不能跳过磁盘与预留收尾 */ }
    if (!tmpOwned && existsSync(tmp)) budget.blockAppends()
    return failClose(budget, reservation, renamed && final ? final : tmpOwned ? tmp : undefined, '媒体附件存盘失败')
  }
}

/**
 * 摄取一个源文件到资产库，返回 assetId。
 *
 * 顺序（执行补充 6.1 命名断言）：stat 预检 → 并发预留 → 受限流复制 → 核实际字节与指纹 → 登记。
 * 任一步失败：释放预留、删半成品、不产生成功引用。
 *
 * @param sourceAbs 源文件绝对路径（宿主已校验来源可信；本函数只负责字节与预算）。
 * @param displayName 展示名（原文件名，仅取扩展名用）。
 */
export function ingestAsset(
  sourceAbs: string,
  displayName: string,
  assetsRoot: string,
  budget: AssetBudget,
  publish?: AssetPublisher
): IngestResult {
  // ① stat 预检：存在、是文件、先看大小
  let st
  try {
    st = statSync(sourceAbs)
  } catch {
    return { ok: false, reason: '源文件不存在或无法读取' }
  }
  if (!st.isFile()) return { ok: false, reason: '该路径不是文件' }

  // ② 单文件上限（首个 stat 就超直接拒，不必复制）
  if (st.size > budget.maxAssetBytes) {
    return { ok: false, reason: `文件 ${st.size} 字节超过单文件预览上限 ${budget.maxAssetBytes} 字节` }
  }

  // ③ 并发预留（防两个都"没满"却共同超额）
  const reservation = budget.reserve(st.size)
  if (!reservation) {
    return { ok: false, reason: '附件总预算不足，已被拒（请先移除部分附件）' }
  }

  const tmpPath = join(assetsRoot, `.ingest-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const hash = createHash('sha256')
  let actual = 0
  let fdIn = -1
  let fdOut = -1
  let tmpOwned = false
  let failure: string | undefined
  try {
    if (!existsSync(assetsRoot)) mkdirSync(assetsRoot, { recursive: true })
    trustedAssetRoot(assetsRoot)
    fdIn = openSync(sourceAbs, 'r')
    fdOut = openSync(tmpPath, 'wx')
    tmpOwned = true
    // ④ 受限流复制：分块读、计数、指纹。复制期间长大即拒（不静默截断）。
    const CHUNK = 1024 * 1024
    const buf = Buffer.alloc(CHUNK)
    for (;;) {
      const n = readSync(fdIn, buf, 0, CHUNK, actual)
      if (n <= 0) break
      if (actual + n > budget.maxAssetBytes) {
        throw new Error('复制期间文件增长超过上限，已拒绝')
      }
      const slice = buf.subarray(0, n)
      writeAll(fdOut, slice)
      hash.update(slice)
      actual += n
    }
  } catch {
    failure = '附件复制失败或文件增长超过上限，已拒绝'
  } finally {
    // 每个描述符分别收尾；关闭第一个失败也必须尝试第二个。先关闭，再删除临时件。
    for (const fd of [fdIn, fdOut]) {
      if (fd < 0) continue
      try { closeSync(fd) } catch { failure ??= '附件文件关闭失败，已拒绝' }
    }
  }
  if (failure) {
    if (!tmpOwned && existsSync(tmpPath)) budget.blockAppends()
    return failClose(budget, reservation, tmpOwned ? tmpPath : undefined, failure)
  }

  // 实际字节先调整在途预留，rename 后才结算。任一故障都能释放同一笔实际占用。
  if (!budget.resize(reservation, actual)) {
    return failClose(budget, reservation, tmpPath, '附件总预算不足（文件复制期间增长），已拒绝')
  }

  // rename、登记、预算结算位于同一同步段；返回成功之前发生的故障都回收本次文件和预留。
  const digest = hash.digest('hex').slice(0, 16)
  let id = genAssetId(extOf(displayName), 0)
  let idx = 0
  while (storeRoots(assetsRoot).some(root => existsSync(join(root, id)))) id = genAssetId(extOf(displayName), ++idx)
  const finalPath = join(assetsRoot, id)
  let renamed = false
  let rollback: (() => void) | void = undefined
  try {
    renameSync(tmpPath, finalPath)
    renamed = true
    rollback = publish?.({ assetId: id, bytes: actual, digest })
    if (!budget.commit(reservation, actual)) throw new Error('预算结算失败')
  } catch {
    try { rollback?.() } catch { /* 同一事务仍继续释放文件与预留 */ }
    return failClose(budget, reservation, renamed ? finalPath : tmpPath, '附件登记失败，已拒绝')
  }
  return { ok: true, asset: { assetId: id, bytes: actual, digest } }
}

/** 失败收尾：释放预留 + 删半成品 + 不产生成功引用。 */
function failClose(budget: AssetBudget, reservation: AssetReservation, tmpPath: string | undefined, reason: string): IngestResult {
  budget.release(reservation)
  if (!tmpPath) return { ok: false, reason }
  try {
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true })
  } catch {
    // 无法删掉的本次件不能假称占用已消失。保守计入并拒新增，不自动清用户历史。
    try { budget.addCommitted(statSync(tmpPath).size) } catch { /* 存量未知 */ }
    budget.blockAppends()
  }
  return { ok: false, reason }
}

/** 同步写 fd（writeSync 可能写不满，循环补齐）。 */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) {
    const written = writeSync(fd, buf, off, buf.length - off)
    if (written <= 0) throw new Error('资产写入未取得进展')
    off += written
  }
}

// ── 读取（Gateway 之后的 Adapter）─────────────────────────────────────────

/** 按 assetId 读字节。形状不合法抛（有人往 id 里塞路径 = 给穿越留门）。 */
export function readAsset(assetsRoot: string, assetId: string): Buffer {
  const path = assetFilePath(assetsRoot, assetId)
  if (statSync(path).size > MAX_ASSET_BYTES) throw new Error('资产超过50MiB预览上限')
  const bytes = readFileSync(path)
  if (bytes.length > MAX_ASSET_BYTES) throw new Error('资产读取期间增长超过上限')
  return bytes
}

/** 媒体只核真实路径与大小，不为了签发句柄先整份读入内存。 */
export function assetMetadata(assetsRoot: string, assetId: string): { path: string; bytes: number } {
  const path = assetFilePath(assetsRoot, assetId)
  const bytes = statSync(path).size
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ASSET_BYTES) throw new Error('资产超过50MiB预览上限')
  return { path, bytes }
}

/** 只为正文/类型判断读有界前缀，不为64KiB模型内容整读50MiB副本。 */
export function readAssetPrefix(assetsRoot: string, assetId: string, limit: number): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_ASSET_BYTES) throw new Error('前缀读取上限不合法')
  const source = assetMetadata(assetsRoot, assetId)
  const fd = openSync(source.path, 'r')
  try {
    const b = Buffer.alloc(Math.min(source.bytes, limit))
    let at = 0
    while (at < b.length) {
      const count = readSync(fd, b, at, b.length - at, at)
      if (!count) break
      at += count
    }
    return b.subarray(0, at)
  } finally { closeSync(fd) }
}
