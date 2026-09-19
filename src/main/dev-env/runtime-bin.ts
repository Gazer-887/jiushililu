/**
 * 运行环境 shim 目录（plan43 S3b）—— 主进程：把「用户选中的可执行文件」变成 PATH 可用的中转目录。
 *
 * ## 为什么不直接注入 dirname
 *
 * PATH 是**目录级**语义，而用户选的是**一个文件**。直接注入 `dirname(选中)` 会连带影响
 * 同目录下所有可执行文件 —— conda 环境里选 python 会顺带把 `conda.exe` / `Scripts\` 一起顶上 PATH。
 * 故本模块造一个**只放被选中文件**的中转目录，实现**文件级隔离**。
 *
 * ## 为什么用 .cmd 转发而不是软链
 *
 * Windows 创建符号链接需要管理员权限或开发者模式 —— **不能要求用户开这个**。
 * `.cmd` 转发脚本免权限、内容可读（用户能自己打开看指向哪）、删除即撤销。
 * （这正是 npm 自己 shim 的做法：能借就借。）
 *
 * ## 清理责任
 *
 * 中转目录**只放我们写的文件**，故启动/更新时可以安全地"先清后建"——
 * 但**只删我们认识的名字**（`.cmd` / 裸名），不整目录递归删（那是危险动作，
 * 且用户理论上可能手动往里面放过东西）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LANGUAGE_SPECS,
  condaAliasFromPath,
  type ActiveRuntime,
  type ActiveRuntimeSnapshot,
  type LanguageSpec
} from '@shared/dev-env'
import {
  buildShimEntries,
  cmdShimContent,
  isOurShimContent,
  RUNTIME_BIN_DIRNAME,
  runtimeFingerprint,
  type ShimEntry
} from '@shared/runtime-path'

/** 中转目录绝对路径（调用方给出 userData；本模块不碰 electron） */
export function runtimeBinDir(userDataDir: string): string {
  return join(userDataDir, RUNTIME_BIN_DIRNAME)
}

export interface SyncResult {
  dir: string
  entries: ShimEntry[]
  /** 本次实际写入/覆盖的 shim 数 */
  written: number
  /** 本次删除的过期 shim 名 */
  removed: string[]
  /** 原件已不存在的语言（**不静默失效**：调用方据此给用户提示） */
  missing: { language: string; target: string }[]
}

/**
 * 让中转目录与当前选择**一致**（幂等）：写入缺失/内容过期的 shim，删掉不再需要的。
 *
 * 每步的取舍：
 * - **内容比对后才写**：避免每次 run 都改文件 mtime（无谓的磁盘写 + 可能触发文件监视）。
 * - **原件不存在 → 不写该 shim，并记进 `missing`**：写一个指向不存在目标的 shim，
 *   用户执行时会得到 shell 自己的「找不到路径」错误 —— 不如我们提前如实报告。
 * - **只删我们认识的文件名**：不 `rm -rf` 整个目录（那是不可逆动作，且用户可能放了自己的东西）。
 */
export function syncRuntimeBin(
  userDataDir: string,
  selected: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): SyncResult {
  const dir = runtimeBinDir(userDataDir)
  const entries = buildShimEntries(selected, dir, platform)
  const missing: { language: string; target: string }[] = []

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  let written = 0
  const wanted = new Set<string>()
  for (const e of entries) {
    // 原件不在盘上 → 不写 shim，如实记下（不猜、不静默）
    if (!existsSync(e.target)) {
      missing.push({ language: e.language, target: e.target })
      continue
    }
    wanted.add(e.shimName)
    const content = cmdShimContent(e.target, platform)
    let current: string | null = null
    try {
      current = existsSync(e.shimPath) ? readFileSync(e.shimPath, 'utf8') : null
    } catch {
      current = null
    }
    if (current !== content) {
      writeFileSync(e.shimPath, content, { encoding: 'utf8', mode: platform === 'win32' ? undefined : 0o755 })
      written += 1
    }
  }

  const removed: string[] = []
  try {
    for (const name of readdirSync(dir)) {
      if (wanted.has(name)) continue
      const full = join(dir, name)
      // 只删文件 —— 目录（无论谁建的）一律不动，避免误删用户自建结构
      try {
        if (!statSync(full).isFile()) continue
      } catch {
        continue
      }
      // ★ **按内容签名认自己**，不按文件名白名单。
      //   文件名白名单被判为有洞（见 `isOurShimContent` 文档）：清理那一刻 `selected`
      //   已是新一轮的值，推导不出"上一轮用过但本轮不在 selected 里"的 id ⇒ 孤儿 shim 永留。
      //   内容签名不依赖任何会变的外部状态 —— **我们写的文件长什么样是确定的**。
      //   认不出来就不删（删不可逆；留个孤儿 shim 远好过误杀用户文件）。
      let text: string | null = null
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (!isOurShimContent(text, platform)) continue
      rmSync(full, { force: true })
      removed.push(name)
    }
  } catch {
    // 目录读不了不算致命：下次 run 会再试
  }

  removed.sort()
  return { dir, entries: entries.filter((e) => wanted.has(e.shimName)), written, removed, missing }
}

/** 供 S3c 用的指纹（薄封装，让调用方不必同时 import 两个模块） */
export function currentFingerprint(selected: Record<string, string>, userDataDir: string): string {
  return runtimeFingerprint(selected, runtimeBinDir(userDataDir))
}

/**
 * plan43 S3d：算出「当前生效」的事实快照（状态栏显示用）—— **纯读，不写盘**。
 *
 * 为什么必须纯读：这个函数由**状态栏渲染**驱动（IPC handler 每次调用），而状态栏是高频刷新的。
 * 若它顺带 `syncRuntimeBin`（mkdir + 逐文件 existsSync/readFileSync + readdirSync 全目录扫描），
 * 就变成"每次刷新都同步扫盘"——Electron 主进程的同步 IO 会**阻塞事件循环 = 所有窗口卡顿**。
 * （2026-09-19 子代理复查抓出：原实现是读侧带写副作用。）
 *
 * 写盘只保留在 `syncRuntimeBin`（`Sync` 字样一望而知有写副作用），
 * 唯一生产调用点是 `resolveRuntimeEnv`（run 开始时一次）。
 *
 * 为什么单独一个函数：这是**事实层**，与设置页那层"意向"分开。
 * 调用方（IPC handler）只做转发，判断逻辑在这里 —— 于是这里可单测，
 * 而 IPC 层不需要为了测它去起 Electron。
 */
export function inspectActiveSnapshot(
  userDataDir: string,
  selected: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  specs: LanguageSpec[] = LANGUAGE_SPECS
): ActiveRuntimeSnapshot {
  const dir = runtimeBinDir(userDataDir)
  const entries = buildShimEntries(selected, dir, platform)
  const labelOf = (id: string): string => specs.find((s) => s.id === id)?.label ?? id

  const active: ActiveRuntime[] = []
  const failed: ActiveRuntimeSnapshot['failed'] = []

  for (const e of entries) {
    // 原件不在 ⟺ 跑不了。这是**只读判断**，不需要写任何东西就能知道。
    if (!existsSync(e.target)) {
      failed.push({
        language: e.language,
        label: labelOf(e.language),
        selected: e.target,
        // 原因要具体到"怎么做就对了"，不是笼统的"出错了"
        reason: '所选的可执行文件已不在这个位置（可能被卸载或移动）'
      })
      continue
    }
    active.push({
      language: e.language,
      label: labelOf(e.language),
      selected: e.target,
      display: displayFor(e.language, e.target, labelOf(e.language))
    })
  }

  return { active, failed, injected: active.length > 0 }
}

// 注：曾经还有一个 `computeActiveSnapshot`（"同步并报告"）—— 2026-09-19 交叉复查后删除。
// 理由：它**零生产调用点**（只有测试用），且名字像只读、实际写盘 —— 那是 P1-3 的复现路径：
// 下一个人很容易看名字就把它接到高频的状态栏渲染上，于是同步 IO 又回到主进程事件循环里。
// 需要落盘就显式调 `syncRuntimeBin`（有 `Sync` 字样，写副作用一望而知），
// 需要读事实就调 `inspectActiveSnapshot`（纯读）。**一个函数只干一件能被名字说清的事。**

/** 状态栏那一行的简称：优先 `Python 3.12.13 ('ai_env')` 形态，取不到版本就退回文件名 */
function displayFor(language: string, target: string, langLabel: string): string {
  const name = target.replace(/\\/g, '/').split('/').pop() ?? target
  const alias = condaAliasFromPath(target)
  const base = alias ? `${langLabel} ('${alias}')` : langLabel
  return `${base} · ${name}`
}
