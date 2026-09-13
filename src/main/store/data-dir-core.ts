import { createHash } from 'node:crypto'
import {
  copyFileSync as _copy,
  existsSync as _exists,
  mkdirSync as _mkdir,
  readdirSync as _readdir,
  statSync as _stat,
  readFileSync as _readBuf,
  writeFileSync as _write,
  renameSync as _rename,
  rmSync as _rm,
  unlinkSync as _unlink,
  openSync as _open,
  closeSync as _close,
  fsyncSync as _fsync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { statfsSync } from 'node:fs'

// 数据目录的**纯逻辑**（plan10 C 批 / §2.4 P0-1～P0-6）。
//
// 职责：location.json 解析 → 迁移计划 → 三段式迁移（暂存 → SHA-256 全量校验 → 原子改名）→
// 数据目录锁（wx 独占创建 + pid 存活检测，与 plan8 R13 的"应用单实例锁"是**两把不同的锁**）。
// fs 全部走 `MigrationFs` 接口注入 —— 架构守卫要求单测链路不得出现 electron/electron-store，
// 本文件连 node:fs 都包进 adapter，测试注入记账版才能数清每一笔盘上动作。
//
// 三条铁律（都有测试钉着）：
// ① **排除法迁移**：只排除 Chromium 已知目录/文件，名单外全搬 —— 自有数据**宁可多搬一个小缓存目录，
//    不可漏搬**（漏一条会话 = 用户数据丢失；多搬 1MB 缓存 = 无感）。新增顶层目录**自动**被搬。
// ② **失败绝不切换**（P0-3）：任何一步失败 → 删暂存 + 源目录原样保留 + 返回人话原因，调用方继续用老目录。
// ③ **指针失效绝不启动失败**（P0-5）：location.json 损坏/指向不可用目录 → 回退默认 + 留痕，不让用户卡在启动页。

// ─────────────────────────────────────────────────────────────
// fs 注入接口
// ─────────────────────────────────────────────────────────────

/** 迁移用到的 fs 能力（收窄成接口，测试注入记账版） */
export interface MigrationFs {
  existsSync(path: string): boolean
  mkdirSync(path: string, opts: { recursive: true }): void
  readdirSync(path: string): string[]
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number }
  readFileSync(path: string): Buffer
  readTextFileSync(path: string): string
  writeFileSync(path: string, data: string | Buffer, enc: 'utf8'): void
  copyFileSync(from: string, to: string): void
  renameSync(from: string, to: string): void
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void
  unlinkSync(path: string): void
  /** 'wx' 独占创建；已存在返回 null（EEXIST），其他错误照常抛出 */
  openExclusiveSync(path: string): number | null
  closeSync(fd: number): void
  /** 把已写文件刷到磁盘（rename 只是"目录项换名"，不 fsync 断电后可能拿到旧内容） */
  fsyncFileSync(path: string): void
  /** 刷目录项（Windows 上打不开目录，实现里吞掉；见 conversations-fs 的同名方法） */
  fsyncDir(path: string): void
  /** 目标路径所在卷的剩余字节数；平台不支持返回 null（跳过空间检查） */
  freeBytes(path: string): number | null
  /** 当前毫秒时间戳（restore-backup 命名 / 迁移标记内容） */
  now(): number
}

/** 真实 fs 实现（node:fs 全包在 adapter 里，core 的其余部分可被记账版整体替换） */
export const nodeFsMigrationFs: MigrationFs = {
  existsSync: (p) => _exists(p),
  mkdirSync: (p, o) => void _mkdir(p, o),
  readdirSync: (p) => _readdir(p),
  statSync: (p) => {
    const s = _stat(p)
    return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), size: s.size }
  },
  readFileSync: (p) => _readBuf(p),
  readTextFileSync: (p) => _readBuf(p, 'utf8'),
  writeFileSync: (p, d, e) => void _write(p, d, e),
  copyFileSync: (a, b) => void _copy(a, b),
  renameSync: (a, b) => void _rename(a, b),
  rmSync: (p, o) => void _rm(p, o),
  unlinkSync: (p) => void _unlink(p),
  openExclusiveSync: (p) => {
    try {
      return _open(p, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw err
    }
  },
  closeSync: (fd) => void _close(fd),
  fsyncFileSync: (p) => {
    const fd = _open(p, 'r+')
    try {
      _fsync(fd)
    } finally {
      _close(fd)
    }
  },
  fsyncDir: (p) => {
    // Windows 不允许对目录取句柄 —— POSIX 靠目录 fsync，Windows 靠 NTFS 日志，静默跳过
    let fd: number | null = null
    try {
      fd = _open(p, 'r')
      _fsync(fd)
    } catch {
      /* 平台不支持目录 fsync */
    } finally {
      if (fd !== null) {
        try {
          _close(fd)
        } catch {
          /* 已经关了 */
        }
      }
    }
  },
  freeBytes: (p) => {
    try {
      const s = statfsSync(p)
      return s.bsize * s.bavail
    } catch {
      return null
    }
  },
  now: () => Date.now()
}

// ─────────────────────────────────────────────────────────────
// 排除名单（P0-1 排除法的全部知识都在这里）
// ─────────────────────────────────────────────────────────────

/** location.json 的固定文件名（放在引导锚点目录，永不随迁移走） */
export const LOCATION_FILE = 'location.json'
/** 数据目录锁文件名 */
export const DIR_LOCK_FILE = 'data.lock'
/** 迁移完成标记（审计留痕 + 幂等判据） */
export const MIGRATED_MARKER = '.migrated-from'
const RESTORE_BACKUP_PREFIX = 'restore-backup-'

/**
 * Chromium 侧顶层目录（不搬，留在原处重建）。
 * ⚠️ 倾向性：这里漏列一个 Chromium 缓存目录只是"多搬一点"，**自有目录一个都不能列错** ——
 * 拿不准的目录不要加进来。
 */
const EXCLUDED_TOP_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'Dictionaries',
  'Network',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'blob_storage',
  'WebStorage',
  'Shared Dictionary',
  'SharedStorage',
  'Crashpad',
  'VideoDecodeStats'
])

/** Chromium 侧顶层文件 + 本模块自己的元文件（都不搬） */
const EXCLUDED_TOP_FILES = new Set([
  // Chromium profile 顶层文件
  'Preferences',
  'Secure Preferences',
  'Local State',
  'DevToolsActivePort',
  'Cookies',
  'Cookies-journal',
  'TransportSecurity',
  'Network Persistent State',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'SingletonPid',
  'SharedStorage-wal',
  'lockfile',
  // 引导/锁/审计元文件
  LOCATION_FILE,
  DIR_LOCK_FILE,
  MIGRATED_MARKER
])

function isExcludedTopEntry(name: string, isDir: boolean): boolean {
  if (name.startsWith(RESTORE_BACKUP_PREFIX)) return true // 历史回退备份不搬（留在默认目录）
  return isDir ? EXCLUDED_TOP_DIRS.has(name) : EXCLUDED_TOP_FILES.has(name)
}

// ─────────────────────────────────────────────────────────────
// location.json（P0-5 配置自举）
// ─────────────────────────────────────────────────────────────

export interface LocationConfig {
  /** 已生效的自定义数据目录（缺省 = 用默认） */
  dataDir?: string
  /** 已保存、下次启动迁移生效的目标目录；等于默认目录 = 回退 */
  pendingDataDir?: string
  /** 最近一次迁移/回退/回退保护事件（设置页显示用；'ok' 成功通知 / 'error' 失败原因） */
  lastEvent?: { kind: 'ok' | 'error'; text: string; at: string }
}

/** 解析 location.json 内容；任何损坏/形状不对都返回 {}（P0-5：绝不抛、绝不启动失败） */
export function parseLocationConfig(raw: string | null | undefined): LocationConfig {
  if (!raw) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof obj !== 'object' || obj === null) return {}
  const rec = obj as Record<string, unknown>
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v : undefined
  const cfg: LocationConfig = {}
  const dataDir = pick(rec['dataDir'])
  const pending = pick(rec['pendingDataDir'])
  if (dataDir) cfg.dataDir = dataDir
  if (pending) cfg.pendingDataDir = pending
  const ev = rec['lastEvent']
  if (typeof ev === 'object' && ev !== null) {
    const e = ev as Record<string, unknown>
    const kind = e['kind']
    const text = e['text']
    const at = e['at']
    if ((kind === 'ok' || kind === 'error') && typeof text === 'string') {
      cfg.lastEvent = { kind, text, at: typeof at === 'string' ? at : '' }
    }
  }
  return cfg
}

/** location.json 序列化（空字段不写） */
export function serializeLocationConfig(cfg: LocationConfig): string {
  const out: Record<string, unknown> = {}
  if (cfg.dataDir) out['dataDir'] = cfg.dataDir
  if (cfg.pendingDataDir) out['pendingDataDir'] = cfg.pendingDataDir
  if (cfg.lastEvent) out['lastEvent'] = cfg.lastEvent
  return JSON.stringify(out, null, 2)
}

/** location.json 原子写（临时文件 + rename，读者永远看不到半截；同 conversations-fs 纪律） */
export function writeLocationConfig(anchorDir: string, cfg: LocationConfig, fs: MigrationFs): void {
  fs.mkdirSync(anchorDir, { recursive: true })
  const final = join(anchorDir, LOCATION_FILE)
  const tmp = `${final}.tmp`
  fs.writeFileSync(tmp, serializeLocationConfig(cfg), 'utf8')
  fs.fsyncFileSync(tmp)
  fs.renameSync(tmp, final)
  fs.fsyncDir(anchorDir)
}

// ─────────────────────────────────────────────────────────────
// 目标路径校验（P0-2 自检的路径部分）
// ─────────────────────────────────────────────────────────────

export type TargetCheck = { ok: true } | { ok: false; reason: string }

/**
 * 校验迁移目标：
 * - 必须是绝对路径、不能等于源、不能与源互为嵌套（目标选在源内部/把源包进去都会自引用）
 * - 不能是盘根、不能超长（Windows MAX_PATH 保守值）、不能含 Windows 非法字符
 * `caseInsensitive`：Windows 上传 true（大小写不敏感比较）
 */
export function validateTargetPath(
  target: string,
  sourceDir: string,
  caseInsensitive: boolean
): TargetCheck {
  const t = target.trim()
  if (t.length === 0) return { ok: false, reason: '路径为空' }
  if (!isAbsolute(t)) return { ok: false, reason: '必须是绝对路径' }

  const norm = (p: string): string => {
    const r = resolve(p)
    return caseInsensitive ? r.toLowerCase() : r
  }
  const a = norm(t)
  const b = norm(sourceDir)
  const sep = a.includes('/') && !a.includes('\\') ? '/' : '\\'

  if (a === b) return { ok: false, reason: '目标与当前数据目录相同' }
  if (a.startsWith(b + sep) || b.startsWith(a + sep)) {
    return { ok: false, reason: '目标不能在当前数据目录内部，也不能包含它' }
  }
  if (dirname(a) === a) return { ok: false, reason: '不能选择盘根目录' }
  if (a.length >= 240) return { ok: false, reason: '路径过长（需少于 240 字符）' }
  const withoutDrive = a.replace(/^[a-zA-Z]:/, '')
  if (/[<>:"|?*]/.test(withoutDrive)) return { ok: false, reason: '路径含非法字符' }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────
// 迁移计划（P0-1 排除法）
// ─────────────────────────────────────────────────────────────

export interface PlannedFile {
  /** 相对源目录的路径（'/' 分隔），如 'conversations/abc.json' */
  rel: string
  size: number
}

export interface MigrationPlan {
  files: PlannedFile[]
  totalBytes: number
  /** 被排除名单挡下的顶层条目（日志留痕用） */
  skipped: string[]
}

const MAX_WALK_DEPTH = 32

function walk(sourceDir: string, rel: string, depth: number, plan: MigrationPlan, fs: MigrationFs): void {
  if (depth > MAX_WALK_DEPTH) {
    plan.skipped.push(`${rel}（嵌套过深，跳过）`)
    return
  }
  let names: string[]
  try {
    names = fs.readdirSync(join(sourceDir, rel))
  } catch {
    plan.skipped.push(`${rel}（无法读取，跳过）`)
    return
  }
  for (const name of names) {
    const childRel = rel.length === 0 ? name : `${rel}/${name}`
    const abs = join(sourceDir, childRel)
    let isDir = false
    let isFile = false
    let size = 0
    try {
      const st = fs.statSync(abs)
      isDir = st.isDirectory()
      isFile = st.isFile()
      size = st.size
    } catch {
      plan.skipped.push(`${childRel}（无法读取，跳过）`)
      continue
    }
    if (rel.length === 0 && isExcludedTopEntry(name, isDir)) {
      plan.skipped.push(name)
      continue
    }
    if (isFile) {
      plan.files.push({ rel: childRel, size })
      plan.totalBytes += size
    } else if (isDir) {
      walk(sourceDir, childRel, depth + 1, plan, fs)
    } else {
      plan.skipped.push(`${childRel}（非常规文件，跳过）`)
    }
  }
}

/** 生成迁移计划：排除名单外的全部文件（递归平铺 + 字节数） */
export function planMigration(sourceDir: string, fs: MigrationFs): MigrationPlan {
  const plan: MigrationPlan = { files: [], totalBytes: 0, skipped: [] }
  if (!fs.existsSync(sourceDir)) return plan
  walk(sourceDir, '', 0, plan, fs)
  return plan
}

// ─────────────────────────────────────────────────────────────
// 三段式迁移（P0-1 / P0-2 / P0-3）
// ─────────────────────────────────────────────────────────────

export interface MigrationReport {
  ok: boolean
  /** 人话失败原因（P0-3：界面提示用）；成功时 undefined */
  reason?: string
  filesCopied: number
  bytesCopied: number
  /** 源侧无可搬数据（全新安装首次选目录）：直接切换也算成功 */
  empty: boolean
  skipped: string[]
}

function fail(reason: string, plan: MigrationPlan, staging: string, fs: MigrationFs): MigrationReport {
  try {
    fs.rmSync(staging, { recursive: true, force: true })
  } catch {
    /* 删暂存失败也只能留痕，不掩盖主原因 */
  }
  return { ok: false, reason, filesCopied: 0, bytesCopied: 0, empty: plan.files.length === 0, skipped: plan.skipped }
}

function sha256(fs: MigrationFs, path: string): string {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex')
}

/**
 * 三段式迁移：复制到暂存 → 逐文件 SHA-256 校验 + 计数/字节断言 → 原子改名切换。
 * 源目录**只读不写**（P0-1：保留源目录作天然回退点，禁止边用边搬）。
 * 目标要求：不存在或为空目录；已在目标放置过完成标记 → 幂等直接成功。
 */
export function runMigration(
  sourceDir: string,
  targetDir: string,
  fs: MigrationFs,
  opts: { caseInsensitive: boolean }
): MigrationReport {
  const plan = planMigration(sourceDir, fs)
  const staging = `${targetDir}.migrating`

  // 目标幂等：上次迁移已完成（有标记）→ 不再动
  const marker = join(targetDir, MIGRATED_MARKER)
  if (fs.existsSync(marker)) {
    return { ok: true, filesCopied: plan.files.length, bytesCopied: plan.totalBytes, empty: plan.files.length === 0, skipped: plan.skipped }
  }

  const check = validateTargetPath(targetDir, sourceDir, opts.caseInsensitive)
  if (!check.ok) return fail(check.reason, plan, staging, fs)

  // P0-2：目标必须不存在，或只含 Chromium 侧残留（排除条目）。
  // ⚠️ 回退默认 = 反向迁移时，目标（默认目录）里天然留着 Cache/Preferences 等 Chromium 条目 ——
  // 它们不算"非空"；真正的自有数据/未知文件才挡迁移（保护用户已有文件）。
  let mergeMode = false
  if (fs.existsSync(targetDir)) {
    if (!fs.statSync(targetDir).isDirectory()) {
      return fail('目标路径是一个文件，不是目录', plan, staging, fs)
    }
    const own = fs
      .readdirSync(targetDir)
      .filter((n) => !isExcludedTopEntry(n, fs.statSync(join(targetDir, n)).isDirectory()))
    if (own.length > 0) {
      return fail('目标目录已有应用数据（为保护已有文件，拒绝迁入）', plan, staging, fs)
    }
    mergeMode = true
  }
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })

  // P0-2：源数据可解析 —— 计划内所有 .json 全量 parse，坏的先拦下（半迁移比不迁移更糟）
  for (const f of plan.files) {
    if (!f.rel.endsWith('.json')) continue
    try {
      JSON.parse(fs.readTextFileSync(join(sourceDir, f.rel)))
    } catch (err) {
      return fail(`源数据损坏，拒绝迁移：${f.rel}（${err instanceof Error ? err.message : String(err)}）`, plan, staging, fs)
    }
  }

  // P0-2：目标盘剩余空间 ≥ 源大小×2
  const free = fs.freeBytes(targetDir)
  if (free !== null && free < plan.totalBytes * 2) {
    return fail('目标磁盘剩余空间不足', plan, staging, fs)
  }

  // 建暂存（建立成功本身 = 目标可写探针通过）
  try {
    fs.mkdirSync(staging, { recursive: true })
  } catch (err) {
    return fail(`目标目录不可写（${err instanceof Error ? err.message : String(err)}）`, plan, staging, fs)
  }

  // 第一段：复制（fsync 每文件 + 逐文件 SHA-256 双端比对）
  let copied = 0
  let bytes = 0
  try {
    for (const f of plan.files) {
      const from = join(sourceDir, f.rel)
      const to = join(staging, ...f.rel.split('/'))
      const parent = dirname(to)
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true })
      fs.copyFileSync(from, to)
      fs.fsyncFileSync(to)
      if (sha256(fs, from) !== sha256(fs, to)) {
        return fail(`复制校验失败：${f.rel}`, plan, staging, fs)
      }
      copied += 1
      bytes += f.size
    }
  } catch (err) {
    return fail(`复制失败（${err instanceof Error ? err.message : String(err)}）`, plan, staging, fs)
  }

  // 独立清点暂存结果（AGENTS 红线：**不复用**复制循环的计数器自证 —— 另一套数字互证，
  // 防"循环漏了整个子目录""两边都空还报成功"的空 diff）。
  let verified = 0
  let verifiedBytes = 0
  const recount = (absDir: string): void => {
    for (const name of fs.readdirSync(absDir)) {
      const abs = join(absDir, name)
      const st = fs.statSync(abs)
      if (st.isDirectory()) recount(abs)
      else {
        verified += 1
        verifiedBytes += st.size
      }
    }
  }
  recount(staging)
  if (plan.files.length > 0 && (verified === 0 || verifiedBytes === 0)) {
    return fail('迁移内容为空（计划非空但复制结果为空），拒绝切换', plan, staging, fs)
  }
  if (verified !== plan.files.length || verifiedBytes !== plan.totalBytes) {
    return fail(
      `复制不完整（计划 ${plan.files.length} 个文件 / 清点 ${verified} 个），拒绝切换`,
      plan,
      staging,
      fs
    )
  }

  // 第三段：原子改名切换 + 完成标记。
  // merge 模式（目标只含 Chromium 排除条目，如回退默认）：无法整体 rename 到已存在目录，
  // 退化为逐条移入 —— 计划里没有排除条目 → 无同名冲突；此时尚未 setPath、无并发写者，窗口安全。
  try {
    fs.fsyncDir(staging)
    if (mergeMode) {
      for (const name of fs.readdirSync(staging)) {
        fs.renameSync(join(staging, name), join(targetDir, name))
      }
      fs.rmSync(staging, { recursive: true, force: true })
    } else {
      fs.renameSync(staging, targetDir)
    }
    fs.fsyncDir(dirname(targetDir))
  } catch (err) {
    return fail(`切换失败（${err instanceof Error ? err.message : String(err)}）`, plan, staging, fs)
  }
  try {
    const markerBody = JSON.stringify(
      { from: sourceDir, at: new Date(fs.now()).toISOString(), files: copied, bytes },
      null,
      2
    )
    const tmp = `${marker}.tmp`
    fs.writeFileSync(tmp, markerBody, 'utf8')
    fs.fsyncFileSync(tmp)
    fs.renameSync(tmp, marker)
  } catch {
    /* 标记写失败不影响迁移本身（幂等判据退化为"目标非空即拒绝重迁"） */
  }
  return { ok: true, filesCopied: copied, bytesCopied: bytes, empty: plan.files.length === 0, skipped: plan.skipped }
}

// ─────────────────────────────────────────────────────────────
// 回退准备（回退默认 = 反向迁移；默认目录里的旧自有数据要先挪开）
// ─────────────────────────────────────────────────────────────

/**
 * 把默认目录顶层的自有数据条目挪进 `restore-backup-<时间戳>/`（同盘 rename 原子、原数据保全）。
 * location.json 与 Chromium 目录不动（location.json 在默认目录里 = 锚点文件，卷走它就自引用了）。
 */
export function prepareRestoreTarget(defaultDir: string, fs: MigrationFs): { moved: string[] } {
  if (!fs.existsSync(defaultDir)) return { moved: [] }
  const stamp = new Date(fs.now()).toISOString().replace(/[:.]/g, '-')
  const backupDir = join(defaultDir, `${RESTORE_BACKUP_PREFIX}${stamp}`)
  const topPlan = planMigration(defaultDir, fs)
  const topLevel = new Set<string>()
  for (const f of topPlan.files) topLevel.add(f.rel.split('/')[0]!)
  const moved: string[] = []
  for (const name of topLevel) {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })
    fs.renameSync(join(defaultDir, name), join(backupDir, name))
    moved.push(name)
  }
  return { moved }
}

// ─────────────────────────────────────────────────────────────
// 数据目录锁（plan8 R13 补记：与"应用单实例锁"是两把不同的锁）
// ─────────────────────────────────────────────────────────────

export interface DirLock {
  path: string
  fd: number
}

export type LockResult = { ok: true; lock: DirLock } | { ok: false; reason: string }

/**
 * 在数据目录内 `wx` 独占创建锁文件（写 pid + 时间）。
 * 已存在 → 读 pid 做存活检测：持有者活着 = 拒绝；持有者已死 = 陈锁自愈（删掉重建）。
 */
export function acquireDirLock(
  dir: string,
  pid: number,
  fs: MigrationFs,
  isPidAlive: (pid: number) => boolean
): LockResult {
  const lockPath = join(dir, DIR_LOCK_FILE)
  const attempt = (): LockResult => {
    const fd = fs.openExclusiveSync(lockPath)
    if (fd === null) return { ok: false, reason: 'locked' }
    return { ok: true, lock: { path: lockPath, fd } }
  }
  let result = attempt()
  if (result.ok) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid, at: new Date(fs.now()).toISOString() }), 'utf8')
      fs.fsyncFileSync(lockPath)
    } catch {
      /* 锁内容写失败不影响互斥（占坑本身就是锁） */
    }
    return result
  }
  // 已有锁：判断是不是陈锁
  let holderPid: number | null = null
  try {
    const raw = JSON.parse(fs.readTextFileSync(lockPath)) as { pid?: unknown }
    if (typeof raw.pid === 'number') holderPid = raw.pid
  } catch {
    /* 读不出/解析不了 → 当陈锁处理 */
  }
  if (holderPid !== null && isPidAlive(holderPid)) {
    return { ok: false, reason: `数据目录正被另一个实例使用（进程 ${holderPid}）` }
  }
  // 陈锁自愈：删掉重抢一次
  try {
    fs.unlinkSync(lockPath)
  } catch (err) {
    return { ok: false, reason: `数据目录被锁定且无法清理（${err instanceof Error ? err.message : String(err)}）` }
  }
  result = attempt()
  if (result.ok) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid, at: new Date(fs.now()).toISOString() }), 'utf8')
    } catch {
      /* 同上 */
    }
    return result
  }
  return { ok: false, reason: '数据目录锁竞争失败（另一个实例几乎同时启动）' }
}

/** 释放锁（正常退出时调用；崩溃留下的陈锁靠 pid 存活检测自愈） */
export function releaseDirLock(lock: DirLock, fs: MigrationFs): void {
  try {
    fs.closeSync(lock.fd)
  } catch {
    /* 已关 */
  }
  try {
    fs.unlinkSync(lock.path)
  } catch {
    /* 已删 */
  }
}

// ─────────────────────────────────────────────────────────────
// 启动编排（bootstrap 薄壳调这一个函数）
// ─────────────────────────────────────────────────────────────

export interface BootstrapInput {
  /** 引导锚点目录：location.json 所在（appData/<name>，不随迁移走） */
  anchorDir: string
  /** Electron 默认 userData（未 setPath 前的 app.getPath('userData')） */
  defaultUserData: string
  /** JSL_DATA_DIR 环境变量（测试后门，最高优先，不读不写 location.json） */
  envDataDir?: string
  pid: number
  isPidAlive(pid: number): boolean
  fs: MigrationFs
  caseInsensitive: boolean
  /** 早期日志（此时日志系统未初始化，用 console） */
  warn(message: string, extra?: Record<string, unknown>): void
}

export interface BootstrapOutcome {
  /** 本次启动应生效的数据目录（薄壳拿去 setPath） */
  activeDir: string
  custom: boolean
  /** JSL_DATA_DIR 覆盖生效 */
  envOverride: boolean
  /** 本次启动执行的迁移结果（成功或失败；没跑迁移为 null） */
  migrated: MigrationReport | null
  /** 回退时被挪进 restore-backup 的旧数据条目 */
  movedAside: string[]
  /** 界面提示（P0-3/P0-5：迁移失败原因、指针失效回退等），同时写入 location.json.lastError */
  warnings: string[]
  /** 数据目录锁；failed 非空时为 null —— 由入口决定"让位还是退出"（不破坏 R13 语义） */
  lock: DirLock | null
  lockFailed: string | null
}

/**
 * 解析「当前生效目录」：dataDir 合法且可用就用它；否则本次回退默认（P0-5 绝不启动失败）。
 * ⚠️ 回退**不清除指针**：用户修复（重建/找回）目录后，下次启动自动恢复自定义档。
 */
function resolveActiveDir(
  cfg: LocationConfig,
  input: BootstrapInput
): { dir: string; custom: boolean; keepPointer: boolean; warning?: string } {
  if (!cfg.dataDir) return { dir: input.defaultUserData, custom: false, keepPointer: true }
  const check = validateTargetPath(cfg.dataDir, input.defaultUserData, input.caseInsensitive)
  if (!check.ok) {
    return {
      dir: input.defaultUserData,
      custom: false,
      keepPointer: true,
      warning: `自定义数据目录配置非法，本次已回退默认：${check.reason}`
    }
  }
  if (!input.fs.existsSync(cfg.dataDir)) {
    try {
      input.fs.mkdirSync(cfg.dataDir, { recursive: true })
    } catch {
      return {
        dir: input.defaultUserData,
        custom: false,
        keepPointer: true,
        warning: `自定义数据目录不存在且无法创建，本次已回退默认：${cfg.dataDir}`
      }
    }
  }
  return { dir: cfg.dataDir, custom: true, keepPointer: true }
}

export function bootstrapDataDir(input: BootstrapInput): BootstrapOutcome {
  const warnings: string[] = []
  let lastEvent: LocationConfig['lastEvent'] | undefined

  // ① JSL_DATA_DIR（测试后门，plan10 §6.2 前置改动）：最高优先，完全绕过 location.json
  if (input.envDataDir && input.envDataDir.trim().length > 0) {
    const dir = resolve(input.envDataDir.trim())
    input.fs.mkdirSync(dir, { recursive: true })
    const lock = acquireDirLock(dir, input.pid, input.fs, input.isPidAlive)
    return {
      activeDir: dir,
      custom: true,
      envOverride: true,
      migrated: null,
      movedAside: [],
      warnings,
      lock: lock.ok ? lock.lock : null,
      lockFailed: lock.ok ? null : lock.reason
    }
  }

  // ② 读锚点 location.json（损坏 → {} → 全部走默认，绝不启动失败）
  let raw: string | null = null
  try {
    raw = input.fs.readTextFileSync(join(input.anchorDir, LOCATION_FILE))
  } catch {
    raw = null
  }
  const cfg = parseLocationConfig(raw)
  const active = resolveActiveDir(cfg, input)
  if (active.warning) {
    warnings.push(active.warning)
    lastEvent = { kind: 'error', text: active.warning, at: new Date(input.fs.now()).toISOString() }
  }

  // 迁移后要写回的指针：正常 = 当前生效目录；⚠️ 配置非法回退时**保留原指针**（修复目录后自动恢复）
  let nextDataDir: string | undefined = active.warning ? cfg.dataDir : active.custom ? active.dir : undefined
  let migrated: MigrationReport | null = null
  let movedAside: string[] = []
  let finalDir = active.dir

  // ③ pending 迁移（前向 = 换新目录；pending === 默认 = 回退，同一台机器两个方向）
  if (cfg.pendingDataDir) {
    const pending = cfg.pendingDataDir
    const at = new Date(input.fs.now()).toISOString()
    if (pending === input.defaultUserData) {
      // 回退：先把默认目录里的旧自有数据挪开（三段式要求目标为空），再反向迁移
      try {
        movedAside = prepareRestoreTarget(input.defaultUserData, input.fs).moved
      } catch (err) {
        const text = `回退准备失败：${err instanceof Error ? err.message : String(err)}`
        warnings.push(text)
        lastEvent = { kind: 'error', text, at }
      }
      if (!lastEvent) {
        migrated = runMigration(active.dir, input.defaultUserData, input.fs, {
          caseInsensitive: input.caseInsensitive
        })
        if (migrated.ok) {
          nextDataDir = undefined
          finalDir = input.defaultUserData
          lastEvent = {
            kind: 'ok',
            text: `已回退到默认数据目录（迁回 ${migrated.filesCopied} 个文件；迁移前的旧数据保存在 restore-backup-* 目录）`,
            at
          }
        } else {
          const text = `回退迁移失败，继续使用原目录：${migrated.reason ?? '未知原因'}`
          warnings.push(text)
          lastEvent = { kind: 'error', text, at }
        }
      }
    } else {
      // 前向：迁到新目录
      migrated = runMigration(active.dir, pending, input.fs, { caseInsensitive: input.caseInsensitive })
      if (migrated.ok) {
        nextDataDir = pending
        finalDir = pending
        lastEvent = {
          kind: 'ok',
          text: `数据已迁移到 ${pending}（${migrated.filesCopied} 个文件；原目录原样保留）`,
          at
        }
      } else {
        // P0-3：不切换 + 删暂存（runMigration 内部已删）+ 老目录继续 + 留痕；pending 清掉防止每次启动重试
        const text = `数据迁移失败，继续使用原目录：${migrated.reason ?? '未知原因'}`
        warnings.push(text)
        lastEvent = { kind: 'error', text, at }
      }
    }
  }

  // ④ 写回 location.json（内容有变化才写；lastEvent 供设置页显示最近一次迁移/回退结果）。
  // ⚠️ 本轮没有新事件时**保留**上次的 lastEvent —— 「最近一次」的语义，不能被平静的启动抹掉。
  const cfgToWrite: LocationConfig = {}
  if (nextDataDir) cfgToWrite.dataDir = nextDataDir
  const eventToKeep = lastEvent ?? cfg.lastEvent
  if (eventToKeep) cfgToWrite.lastEvent = eventToKeep
  if (serializeLocationConfig(cfgToWrite) !== serializeLocationConfig(cfg)) {
    try {
      writeLocationConfig(input.anchorDir, cfgToWrite, input.fs)
    } catch (err) {
      warnings.push(`location.json 写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ⑤ 数据目录锁：失败**不在这里退出** —— 返回 lockFailed，由入口区分"同 userData 第二实例（让位）"与"真冲突（退出）"
  const lock = acquireDirLock(finalDir, input.pid, input.fs, input.isPidAlive)

  return {
    activeDir: finalDir,
    custom: finalDir !== input.defaultUserData,
    envOverride: false,
    migrated,
    movedAside,
    warnings,
    lock: lock.ok ? lock.lock : null,
    lockFailed: lock.ok ? null : lock.reason
  }
}
