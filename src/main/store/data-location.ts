import { app } from 'electron'
import { join } from 'node:path'
import {
  LOCATION_FILE,
  nodeFsMigrationFs,
  parseLocationConfig,
  validateTargetPath,
  writeLocationConfig,
  type LocationConfig
} from './data-dir-core'
import type { StorageLocationInfo } from '@shared/ipc'

// 存储位置的**装配层**（plan10 C 批）：读改写锚点 location.json，供设置页 IPC 调用。
// 纯判断在 `data-dir-core.ts`（validateTargetPath 等，可单测）；这里只补 electron 侧的路径来源。
// ⚠️ 锚点 = appData/<name>/（与 bootstrap-data-dir.ts 同一个）：location.json 不随迁移走（P0-5）。

function anchorDir(): string {
  return join(app.getPath('appData'), app.getName())
}

function readConfig(): LocationConfig {
  try {
    return parseLocationConfig(nodeFsMigrationFs.readTextFileSync(join(anchorDir(), LOCATION_FILE)))
  } catch {
    return {}
  }
}

export function getStorageLocationInfo(): StorageLocationInfo {
  const cfg = readConfig()
  return {
    current: app.getPath('userData'),
    custom: app.getPath('userData') !== join(app.getPath('appData'), app.getName()),
    pendingDir: cfg.pendingDataDir ?? null,
    pendingKind: cfg.pendingDataDir
      ? cfg.pendingDataDir === join(app.getPath('appData'), app.getName())
        ? 'restore'
        : 'migrate'
      : null,
    lastEvent: cfg.lastEvent ?? null
  }
}

export type StorageWriteResult = { ok: true; info: StorageLocationInfo } | { ok: false; reason: string }

/**
 * 保存「下次启动迁移生效」的目标目录（前向：换新目录）。
 * 立即校验：绝对路径/不自嵌套/盘根/超长 + 目录可创建（当场 mkdir 探针，不让用户等到下次启动才发现错）。
 */
export function setPendingDataDir(dir: string): StorageWriteResult {
  const defaultUserData = join(app.getPath('appData'), app.getName())
  const check = validateTargetPath(dir, defaultUserData, process.platform === 'win32')
  if (!check.ok) return { ok: false, reason: check.reason }
  try {
    nodeFsMigrationFs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, reason: `目录无法创建（${err instanceof Error ? err.message : String(err)}）` }
  }
  const cfg = readConfig()
  cfg.pendingDataDir = dir
  writeLocationConfig(anchorDir(), cfg, nodeFsMigrationFs)
  return { ok: true, info: getStorageLocationInfo() }
}

/** 回退默认位置（pendingDataDir = 默认目录 → 下次启动反向迁移；旧数据挪进 restore-backup-* 保全） */
export function requestRestoreToDefault(): StorageWriteResult {
  const cfg = readConfig()
  if (!cfg.dataDir) {
    // 本来就在默认目录：清掉任何 pending，直说"无需回退"
    delete cfg.pendingDataDir
    writeLocationConfig(anchorDir(), cfg, nodeFsMigrationFs)
    return { ok: true, info: getStorageLocationInfo() }
  }
  cfg.pendingDataDir = join(app.getPath('appData'), app.getName())
  writeLocationConfig(anchorDir(), cfg, nodeFsMigrationFs)
  return { ok: true, info: getStorageLocationInfo() }
}

/** 撤销未生效的迁移计划（用户改主意；已生效的迁移不受影响） */
export function clearPendingDataDir(): StorageWriteResult {
  const cfg = readConfig()
  delete cfg.pendingDataDir
  writeLocationConfig(anchorDir(), cfg, nodeFsMigrationFs)
  return { ok: true, info: getStorageLocationInfo() }
}
