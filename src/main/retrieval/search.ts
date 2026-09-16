// L0 检索执行器：**优先 ripgrep，不可用时降级到内置扫描器**（plan3/plan4 的 L0 是 ripgrep）。
//
// ⚠️ 本文件**不 import electron**：`resourcesPath` 由装配层（`main/agent/tools/system-tools.ts` 的调用方）
// 注入。这样它能进单测链路（架构守卫禁止单测图里出现 electron，CI 无 Electron 二进制），
// 也让"没有 rg 会怎样"能被单测直接构造出来 —— 而那条路径正是最容易静默坏掉的。

import { execFile } from 'node:child_process'
import { promises as fsp, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import { specToRegExp, type SearchSpec } from '@shared/search-query'
import { resolveRipgrepPath, buildRipgrepArgs, type RipgrepLocation } from '@shared/ripgrep-locate'

/** 命中一条 */
export interface SearchHit {
  /** 相对工作区根的路径 */
  file: string
  /** 1 起算 */
  line: number
  /** 该行内容（已截断） */
  text: string
}

/** 执行结果 —— **必须如实报告"哪些东西被跳过了"**，否则"搜不到"与"没搜"长得一样 */
export interface SearchOutcome {
  hits: SearchHit[]
  /** 用的哪个后端（进返回值，让模型知道口径） */
  engine: 'ripgrep' | 'builtin'
  /** 降级原因（engine === 'builtin' 时有值） */
  fallbackReason?: string
  /** 是否因为到了结果上限而**提前停下**（不是"只有这么多"） */
  truncated: boolean
  /** 跳过的文件：超过大小上限 / 读不出来。**不静默** */
  skipped: { tooLarge: number; unreadable: number }
  /** 实际跳过的目录名（去重、限量） */
  skippedDirs: string[]
  /** 扫描过多少文件（仅内置引擎能准确给出） */
  scannedFiles?: number
}

export interface SearchOptions {
  /** 工作区根（用于把绝对路径转相对） */
  workspaceRoot: string
  /** 搜索起点的**绝对路径** */
  basePath: string
  spec: SearchSpec
  maxResults: number
  /** 单文件字节上限（内置扫描器用；超限**计入 skipped 而不是静默跳过**） */
  maxFileBytes?: number
  /** 跳过的目录名（内置扫描器用；`.git` 等） */
  skipDirs?: Set<string>
  /** 打包态资源根（找随包的 rg） */
  resourcesPath?: string | null
  /** 定位结果注入（测试用；默认按 `resourcesPath` 解析） */
  location?: RipgrepLocation | null
  /** 执行 rg 的函数（测试注入；默认 `execFile`） */
  runRg?: (bin: string, args: string[]) => Promise<{ stdout: string; failed: boolean; stderr: string }>
  /** 超时（默认 20s —— 大仓库首搜可能慢，但不能无限等） */
  timeoutMs?: number
  /** 内置扫描器每处理多少个文件让出一次事件循环（测试注入；默认见常量） */
  yieldEveryFiles?: number
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.workbuddy'])
const MAX_LINE_LEN = 300
const MAX_REPORTED_SKIPPED_DIRS = 8

/** 默认的 rg 执行器（`execFile` 不走 shell —— 参数里有用户输入，走 shell 就是注入面） */
export function execRipgrep(bin: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; failed: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // ⚠️ rg 的退出码：**1 = 没有匹配**（不是失败），2 = 真出错。这里只区分"能不能用"。
        // 不过 `--json` 模式下即便有匹配也可能非零退出？实测不会；稳妥起见把 stdout 非空即视为可用。
        const failed = Boolean(error) && stdout.length === 0
        resolve({ stdout: stdout.toString(), failed, stderr: stderr.toString() })
      }
    )
  })
}

/** 解析 rg 的 `--json` 流（每行一个 JSON 对象）。**只取 match 事件**，其余（begin/end/summary）忽略。 */
export function parseRipgrepJson(stdout: string, workspaceRoot: string, maxResults: number): { hits: SearchHit[]; truncated: boolean } {
  const hits: SearchHit[] = []
  let truncated = false
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    if (hits.length >= maxResults) {
      truncated = true
      break
    }
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue // 半截行（进程被杀）—— 跳过，不让一行坏数据打穿整次搜索
    }
    const rec = obj as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
    if (rec.type !== 'match') continue
    const abs = rec.data?.path?.text
    if (typeof abs !== 'string') continue
    hits.push({
      file: relative(workspaceRoot, abs).replace(/\\/g, '/'),
      line: typeof rec.data?.line_number === 'number' ? rec.data.line_number : 0,
      text: (rec.data?.lines?.text ?? '').replace(/\r?\n$/, '').trim().slice(0, MAX_LINE_LEN)
    })
  }
  if (hits.length >= maxResults) truncated = true
  return { hits, truncated }
}

/** 内置扫描器让出间隔：太小会把一次全树扫成毫秒级碎任务（拖慢搜索），太大失去意义 */
const DEFAULT_YIELD_EVERY_FILES = 64

/**
 * 内置降级扫描器 —— 全程异步，每 `yieldEveryFiles` 个条目让出事件循环（plan37 S1，背景见 PLAN/plan37_卡顿治理.md）。
 * 旧实现全同步递归，大工作区占死主进程；语义不变（跳过/如实上报/截断），readdir(withFileTypes) 一次拿齐类型。
 */
async function searchBuiltin(opts: SearchOptions): Promise<SearchOutcome> {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const yieldEvery = opts.yieldEveryFiles ?? DEFAULT_YIELD_EVERY_FILES
  const re = specToRegExp(opts.spec)
  const hits: SearchHit[] = []
  const skippedDirs = new Set<string>()
  let tooLarge = 0
  let unreadable = 0
  let scannedFiles = 0
  let sinceYield = 0
  let truncated = false

  const yieldIfDue = async (): Promise<void> => {
    if (++sinceYield < yieldEvery) return
    sinceYield = 0
    await new Promise<void>((r) => setImmediate(r))
  }

  /** 符号链接要单独 stat 定身 —— lstat 不报 directory，junction 也走这条路（不解析会静默丢） */
  const resolveType = async (full: string, ent: Dirent): Promise<'dir' | 'file' | 'skip'> => {
    if (ent.isDirectory()) return 'dir'
    if (ent.isFile()) return 'file'
    if (ent.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full)
        if (st.isDirectory()) return 'dir'
        if (st.isFile()) return 'file'
      } catch {
        unreadable += 1
        return 'skip'
      }
    }
    // 既非文件也非目录（fifo/socket/断链）—— 旧实现会经 readFile 失败计入 unreadable，这里同口径
    unreadable += 1
    return 'skip'
  }

  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= opts.maxResults) {
      truncated = true
      return
    }
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      unreadable += 1
      return
    }
    for (const ent of entries) {
      if (hits.length >= opts.maxResults) {
        truncated = true
        return
      }
      // 让出放在循环体首 —— 放末尾会让 continue 分支（空文件/超限/跳过）永远不计入让出
      await yieldIfDue()
      const full = join(dir, ent.name)
      const kind = await resolveType(full, ent)
      if (kind === 'dir') {
        // 跳过判定放在类型解析之后 —— 符号链接目录（lstat 不报 directory）也要能命中规则
        if (skipDirs.has(ent.name) || ent.name.startsWith('.')) {
          if (skipDirs.has(ent.name)) skippedDirs.add(ent.name)
          continue
        }
        await walk(full)
        continue
      }
      if (kind === 'skip') continue
      let size = 0
      try {
        size = (await fsp.stat(full)).size
      } catch {
        unreadable += 1
        continue
      }
      if (size === 0) continue
      if (size > maxFileBytes) {
        // ⚠️ 不能静默跳过 —— 用户搜大文件里的内容会得到"（无匹配）"，必须计入 skipped。
        tooLarge += 1
        continue
      }
      scannedFiles += 1
      let text: string
      try {
        text = await fsp.readFile(full, 'utf8')
      } catch {
        unreadable += 1
        continue
      }
      const lines = text.split(/\r?\n/)
      const rel = relative(opts.workspaceRoot, full).replace(/\\/g, '/')
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (re.test(lines[i]!)) {
          hits.push({ file: rel, line: i + 1, text: lines[i]!.trim().slice(0, MAX_LINE_LEN) })
          if (hits.length >= opts.maxResults) {
            truncated = true
            return
          }
        }
      }
    }
  }

  await walk(opts.basePath)
  return {
    hits,
    engine: 'builtin',
    truncated,
    skipped: { tooLarge, unreadable },
    skippedDirs: [...skippedDirs].slice(0, MAX_REPORTED_SKIPPED_DIRS),
    scannedFiles
  }
}

/**
 * 执行搜索：**先试 ripgrep，失败/缺失则降级**。
 *
 * 降级不是"悄悄换个引擎继续" —— `fallbackReason` 会一路带到工具返回值里，
 * 让模型和用户都知道这次不是 L0 的口径（大小写、忽略规则可能有细微差别）。
 */
export async function runSearch(opts: SearchOptions): Promise<SearchOutcome> {
  const loc = opts.location !== undefined ? opts.location : resolveRipgrepPath({ resourcesPath: opts.resourcesPath })
  if (!loc) {
    const out = await searchBuiltin(opts)
    return { ...out, fallbackReason: '未找到 ripgrep（随包 / 环境变量 / PATH 都没有），已用内置扫描器' }
  }

  const run = opts.runRg ?? ((bin, args) => execRipgrep(bin, args, opts.timeoutMs))
  let stdout = ''
  let failed = false
  let stderr = ''
  try {
    const res = await run(loc.path, buildRipgrepArgs(opts.spec, opts.basePath, { maxResults: opts.maxResults }))
    stdout = res.stdout
    failed = res.failed
    stderr = res.stderr
  } catch (err) {
    failed = true
    stderr = err instanceof Error ? err.message : String(err)
  }

  if (failed) {
    // 失败（二进制不可执行、架构不符、被杀…）→ 降级，并把原因带出去。
    // ⚠️ 只有 stdout 为空才算失败：rg 命中时会以 0 退出，但被 SIGPIPE 之类打断时可能非零，
    //    这时输出是**真的**，不能因为退出码丢掉它。
    const out = await searchBuiltin(opts)
    return { ...out, fallbackReason: `ripgrep 执行失败（${stderr.trim().slice(0, 200) || '未知原因'}），已用内置扫描器` }
  }

  const parsed = parseRipgrepJson(stdout, opts.workspaceRoot, opts.maxResults)
  return {
    hits: parsed.hits,
    engine: 'ripgrep',
    truncated: parsed.truncated,
    skipped: { tooLarge: 0, unreadable: 0 },
    skippedDirs: []
  }
}

/**
 * 把结果渲染成给模型看的文本 —— **必须把"被跳过了什么"和"是不是只有这些"说清楚**。
 * 含 `truncated` 时给"怎么重取"的处方（与 R9.1 的续读措辞同族）。
 */
export function renderSearchOutcome(out: SearchOutcome, spec: SearchSpec): string {
  const lines: string[] = []
  const notes: string[] = []

  if (out.engine === 'builtin') {
    notes.push(`⚠️ 本次用的是**内置扫描器**而非 ripgrep：${out.fallbackReason ?? '未知原因'}（结果口径可能有细微差别）`)
  }
  notes.push(`匹配口径：${spec.describe}`)

  if (out.skipped.tooLarge > 0) {
    notes.push(`跳过了 ${out.skipped.tooLarge} 个**超过大小上限**的文件（其中的内容没有被搜索）`)
  }
  if (out.skipped.unreadable > 0) {
    notes.push(`有 ${out.skipped.unreadable} 个文件/目录读不出来（无权限或不是文本），已跳过`)
  }
  if (out.skippedDirs.length > 0) {
    notes.push(`跳过的目录：${out.skippedDirs.join(' / ')}`)
  }

  if (out.hits.length === 0) {
    lines.push('（无匹配）')
  } else {
    lines.push(out.hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n'))
    if (out.truncated) {
      lines.push(
        `\n（结果已达上限 ${out.hits.length} 条，**还有更多匹配没有返回** ——` +
          ` 这不是"只有这些"。请收窄 query、指定 path 缩小范围，或改用更精确的正则。）`
      )
    } else {
      lines.push(`\n（全部 ${out.hits.length} 条匹配已返回）`)
    }
  }

  return `${lines.join('\n')}\n\n${notes.map((n) => `[注] ${n}`).join('\n')}`
}
