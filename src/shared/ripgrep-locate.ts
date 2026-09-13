// 定位 ripgrep 可执行文件 + 把规格翻译成命令行参数（**纯逻辑，不碰 electron**）。
//
// 为什么单独一层：`resolveRipgrepPath` 要按"打包态 / 开发态"给出不同候选，而"打包路径"依赖
// `process.resourcesPath`（那是 electron 的全局量）。把它做成**注入式**，这里就只剩纯函数 ——
// 于是它能进单测链路（架构守卫禁止单测 import electron，CI 没有 Electron 二进制）。
// 装配（往 `process.resourcesPath` 传值）留在 `main/retrieval/ripgrep.ts`。
//
// ⚠️ 没有 ripgrep 时**不是错误**：调用方会降级到内置扫描器。但降级必须**在结果里说出来** ——
// 否则"搜不到"与"没装 rg"在界面上长得一模一样。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { specToRegexSource, type SearchSpec } from '@shared/search-query'

/** 候选路径的来源标记（进日志与工具返回值，便于排查"用的是哪一个 rg"） */
export type RipgrepSource = 'bundled' | 'env' | 'path'

export interface RipgrepLocation {
  path: string
  source: RipgrepSource
}

export interface ResolveRipgrepOptions {
  /** 打包态资源根（生产传入 `process.resourcesPath`；开发态传 null） */
  resourcesPath?: string | null
  /** 环境变量覆盖（`JSL_RIPGREP`），排查与测试用 */
  envPath?: string | null
  /** 平台，决定二进制文件名 */
  platform?: NodeJS.Platform
  /** 可注入的存在性判断（测试用；默认 `existsSync`） */
  exists?: (path: string) => boolean
}

/** 打包时随 `extraResources` 落在 `resources/ripgrep/` 下 */
export const BUNDLE_DIR_NAME = 'ripgrep'
export const ENV_VAR = 'JSL_RIPGREP'

export function ripgrepBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'rg.exe' : 'rg'
}

function firstExisting(candidates: RipgrepLocation[], exists: (p: string) => boolean): RipgrepLocation | null {
  for (const c of candidates) {
    if (c.path.length > 0 && exists(c.path)) return c
  }
  return null
}

/**
 * 找一个能用的 ripgrep。优先级：**随包分发 > 环境变量 > 系统 PATH**。
 *
 * 为什么随包优先：用户机器上有没有 rg 是**不可控**的，而"同一个查询在两台机器上给出不同结果"
 * 比"慢一点"糟糕得多。随包那份是唯一能保证版本一致的做法。
 */
export function resolveRipgrepPath(opts: ResolveRipgrepOptions = {}): RipgrepLocation | null {
  const exists = opts.exists ?? existsSync
  const platform = opts.platform ?? process.platform
  const name = ripgrepBinaryName(platform)

  const candidates: RipgrepLocation[] = []
  if (opts.resourcesPath) {
    candidates.push({ path: join(opts.resourcesPath, BUNDLE_DIR_NAME, name), source: 'bundled' })
  }
  if (opts.envPath) {
    candidates.push({ path: opts.envPath, source: 'env' })
  }
  // 开发态兜底：本机 PATH 上的 rg（`which` 的结果不在这里解析 —— 交给 shell 的 PATH 查找，
  // 即直接把裸命令名交给 spawn，成功与否由执行期判定）
  candidates.push({ path: name, source: 'path' })

  return firstExisting(candidates, exists)
}

/**
 * 规格 → ripgrep 参数（**不含**可执行文件路径，也不含搜索起点）。
 *
 * 三个刻意的选择：
 * ① `--no-config` —— 用户家目录若有 `RIPGREP_CONFIG_PATH`，里面的 `--smart-case` / `--glob` 会
 *    悄悄改变我们的行为；工具的输出必须是**可复现**的，不掺入用户全局配置。
 * ② `--fixed-strings` —— 字面量模式下**由 rg 自己转义**，不靠我们拼正则（拼错的表现为"搜不到"）。
 * ③ `--json` —— 直接拿结构化字段（path/行号/行内容），不解析它的彩色文本输出
 *    （`--vimgrep` 那类的格式在行内容含冒号时是有歧义的）。
 */
export function buildRipgrepArgs(spec: SearchSpec, basePath: string, opts: { maxResults: number } = { maxResults: 200 }): string[] {
  const args = ['--json', '--no-config', '--max-count', String(opts.maxResults)]
  // 默认 rg 尊重 .gitignore，这正是我们要的（跳过 node_modules 等），但**显式写出**以免默认值变化
  args.push('--hidden', '--glob', '!**/.git/**')
  if (spec.caseSensitive) args.push('--case-sensitive')
  else args.push('--ignore-case')
  if (spec.escapeForRegex) args.push('--fixed-strings')
  // `-e` 显式标出模式，免得 `pattern` 以 `-` 开头时被当成开关
  args.push('-e', specToRegexSource(spec))
  args.push('--', basePath)
  return args
}
