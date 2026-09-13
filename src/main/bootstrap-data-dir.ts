import { app } from 'electron'
import { join } from 'node:path'
import {
  bootstrapDataDir,
  nodeFsMigrationFs,
  releaseDirLock,
  type BootstrapOutcome
} from './store/data-dir-core'

// ⚠️⚠️ 数据目录引导 —— **必须是 src/main/index.ts 的第一个 import**（plan10 §2.4 P0-6）。
//
// 五个 electron-store 在各自模块**顶层**构造（构造函数里就锁死 userData 路径），`index.ts` 又是静态
// import —— 把 setPath 写进 `whenReady` 一定太晚，表现为"迁移成功了但读写的还是旧目录"。所以
// setPath + 迁移必须发生在**所有其他 import 求值之前**：本文件的模块体在 index.ts 的任何其他
// import 之前同步执行完，后续五个 store 构造与 `index.ts` 里 `app.getPath('userData')` 的派生点
// （logs/agents/checkpoints/agent-workspace）自然落在新目录。
//
// 本文件是**薄壳**：所有判断/迁移/锁的纯逻辑在 `store/data-dir-core.ts`（fs 可注入、可单测）。

/** 引导结果（index.ts 在单实例锁判定后要读它来处置 lockFailed；will-quit 释放锁） */
let outcome: BootstrapOutcome

// Electron 的 `--user-data-dir` 命令行开关（Chromium 继承）显式指定时**完全尊重它**：
// 跳过 location.json 逻辑（否则验证脚本会被自定义目录带偏）。`app.getPath('userData')` 已是开关值。
const hasCmdlineUserData = app.commandLine.hasSwitch('user-data-dir')

if (hasCmdlineUserData) {
  outcome = {
    activeDir: app.getPath('userData'),
    custom: false,
    envOverride: false,
    migrated: null,
    movedAside: [],
    warnings: [],
    lock: null,
    lockFailed: null
  }
} else {
  // 锚点：appData/<name>/location.json —— 不随迁移走（P0-5 配置自举）。
  // ⚠️ 与默认 userData 是**同一个目录**：location.json 在迁移排除名单里，永不被搬走。
  const anchorDir = join(app.getPath('appData'), app.getName())
  outcome = bootstrapDataDir({
    anchorDir,
    defaultUserData: anchorDir,
    envDataDir: process.env['JSL_DATA_DIR'],
    pid: process.pid,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        // EPERM = 进程存在但无权限 —— 也算活着；ESRCH 才是没了
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    fs: nodeFsMigrationFs,
    caseInsensitive: process.platform === 'win32',
    warn: (message, extra) => console.warn(`[data-dir] ${message}`, extra ?? '')
  })
  app.setPath('userData', outcome.activeDir)
}

// 早期留痕（此时日志系统尚未初始化；进界面后由设置页的 lastEvent 提示条补一份"人话"）
if (outcome.migrated?.ok) {
  console.info(
    `[data-dir] 迁移完成：${outcome.migrated.filesCopied} 个文件 / ${outcome.migrated.bytesCopied} 字节 → ${outcome.activeDir}`
  )
}
if (outcome.migrated && !outcome.migrated.ok) {
  console.error(`[data-dir] 迁移失败（继续用原目录）：${outcome.migrated.reason}`)
}
for (const w of outcome.warnings) {
  console.warn(`[data-dir] ${w}`)
}
if (outcome.lockFailed) {
  console.error(`[data-dir] ${outcome.lockFailed}`)
}

/** 当前生效的数据目录（bootstrap 已算好；后续 import 的 store 都落在它下面） */
export function getBootstrappedDataDir(): string {
  return outcome.activeDir
}

/** 引导结果（lockFailed 的处置权在 index.ts：让位还是退出） */
export function getBootstrapOutcome(): BootstrapOutcome {
  return outcome
}

/** 释放数据目录锁（will-quit 调；崩溃留下的陈锁靠 pid 存活检测自愈） */
export function releaseBootstrapLock(): void {
  if (outcome.lock) {
    releaseDirLock(outcome.lock, nodeFsMigrationFs)
    outcome = { ...outcome, lock: null }
  }
}
