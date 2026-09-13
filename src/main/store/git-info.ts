import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { realpathDeepest, resolveInsideWorkspace } from '../agent/guard'
import type { GitInfo, GitStatusView } from '@shared/ipc'
import { parseGitStatus } from '@shared/git-status'

// Git 服务（plan16 · 源代码管理）。
//
// 分两层：
//   **只读**（分支 / 状态 / diff）—— 随便跑，失败静默或给空结果。
//   **写操作**（暂存 / 取消暂存 / 提交）—— 走 `runGitWrite`，**路径必须校验在工作区内**。
//
// ⚠️ 三条硬约束（计划里已定，这里是可执行的那一版）：
//   1. **不装 simple-git**：全用 `execFile`，且只用 `--porcelain` 这类**稳定机器格式**。
//      绝不解析给人看的默认输出（裸 `git status` 带颜色、措辞随版本变）。
//   2. **提交消息绝不拼进命令行**：走 `git commit -F -` 从 **stdin** 喂进去 ——
//      消息里一个分号、反引号、引号就可能变成命令注入，拼字符串是事故。
//   3. **路径必须过 `resolveInsideWorkspace`**：界面传来的路径不可信，
//      不过这道闸就能 `git add ../../别的目录/文件`。
//
// 本模块**不 import electron**（CI 上要能跑）。

const run = promisify(execFile)

/** 只读命令的公共选项：3s 限时 + 不弹窗口（Windows 上 git 会闪控制台） */
const readOpts = (cwd: string) => ({ cwd, timeout: 3000, windowsHide: true }) as const
/** 写操作放宽到 10s —— commit 可能触发 hook（pre-commit 跑 lint 之类），3s 不够 */
const writeOpts = (cwd: string) => ({ cwd, timeout: 10_000, windowsHide: true }) as const

/** 不是 Git 仓库 / 未装 git / 超时 —— 都归到这一类，由调用方决定怎么变人话 */
export class NotARepoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotARepoError'
  }
}

/**
 * 把界面传来的路径**校验并解析**成 git 能用的工作区相对路径。
 * 越界一律抛错 —— 这是 `git add ../../xxx` 那类问题的唯一闸口。
 */
function safeRel(workspaceRoot: string, rel: string): string {
  const abs = resolveInsideWorkspace(workspaceRoot, rel)
  // 越界 / 路径非法（`/` 开头的绝对路径会被 `join` 吃掉盘符变成"盘内相对"，catch 由 null 分支兜住）
  if (abs === null) throw new Error(`路径越出工作区，已拒绝：「${rel}」`)

  const normRoot = resolve(workspaceRoot)
  // ⚠️ 不能无脑 `abs.slice(normRoot.length)`：传入**绝对路径**且途经符号链接时，
  //    `abs` 的**字面量**并不以 `normRoot` 开头（真实路径在区内、字面量在外），
  //    切片会切出一条"看着像相对路径、其实指向别处"的鬼路径 —— 那时退回真实根再比。
  const base = abs.startsWith(normRoot) ? normRoot : realpathDeepest(normRoot)
  const out = abs.startsWith(base + sep) ? abs.slice(base.length + 1) : null
  if (out === null || out.length === 0) throw new Error(`路径越出工作区，已拒绝：「${rel}」`)

  // 统一成正斜杠：git 在 Windows 上也认 `/`，但反斜杠在某些子命令里会被当转义
  return out.replace(/\\/g, '/')
}

// ── 只读 ────────────────────────────────────────────────────────────────

/** 分支名 + 是否脏（输入框那个显示用）。非 Git 目录返回 null —— 属正常情况，不该报错打扰 */
export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const opts = readOpts(cwd)
    const { stdout: branchOut } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts)
    const branch = branchOut.trim()
    if (branch.length === 0) return null

    let dirty = false
    try {
      const { stdout: statusOut } = await run('git', ['status', '--porcelain'], opts)
      dirty = statusOut.trim().length > 0
    } catch {
      // 状态查询失败不影响分支显示
    }
    return { branch, dirty }
  } catch {
    // 不是 Git 仓库 / 未装 git / 超时 —— 都按"无信息"处理
    return null
  }
}

/**
 * 面板的完整视图：分支 + 变更列表 + 待推送计数。
 * 不是 Git 仓库时抛 `NotARepoError`（与"干净但没改动"区分开 —— 那要显示空列表，不是错误）。
 */
export async function readGitStatus(workspaceRoot: string): Promise<GitStatusView> {
  const branch = await branchName(workspaceRoot)
  const opts = readOpts(workspaceRoot)

  const { stdout: statusOut } = await run('git', ['status', '--porcelain=v1'], opts)
  const changes = parseGitStatus(statusOut)

  // 待推送计数：本批不做远程，但"提交堆积了"是真实信息，顶部那行要显示
  // （`@{upstream}` 不存在时 git 会报错 → 静默按 0 处理，刚建的本地分支本来就没上游）
  let ahead = 0
  try {
    const { stdout } = await run('git', ['rev-list', '--count', '@{upstream}..HEAD'], opts)
    const n = Number.parseInt(stdout.trim(), 10)
    if (Number.isFinite(n) && n > 0) ahead = n
  } catch {
    // 没有上游分支 / 不是 Git 仓库 —— 都算 0，不打扰
  }

  return { branch, changes, ahead }
}

async function branchName(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], readOpts(cwd))
    const b = stdout.trim()
    if (b.length > 0) return b
  } catch {
    // 落到下面的抛错
  }
  throw new NotARepoError('当前工作区不是 Git 仓库（或没有提交过）')
}

/**
 * 某个文件在工作区的差异（**工作区 vs HEAD**，已由计划定案 —— 用户看到的是"我改了什么"）。
 * 未跟踪文件没有 HEAD 版本可比，回退成"整个文件都是新增"（`--no-index` 对空文件）。
 */
export async function readGitDiff(workspaceRoot: string, rel: string): Promise<string> {
  const target = safeRel(workspaceRoot, rel)
  const opts = readOpts(workspaceRoot)
  // `--` 分隔符：路径以 `-` 开头时不会被当成选项（安全习惯，成本为零）
  const { stdout } = await run('git', ['diff', '--', target], opts)
  if (stdout.length > 0) return stdout
  // 已暂存的改动在裸 `git diff` 里看不见，补一次 `--cached`
  const { stdout: cached } = await run('git', ['diff', '--cached', '--', target], opts)
  return cached
}

// ── 写操作 ──────────────────────────────────────────────────────────────

/** 暂存（`git add`）。路径先过 `safeRel`，越界抛错 */
export async function gitStage(workspaceRoot: string, rels: string[]): Promise<void> {
  if (rels.length === 0) return
  const targets = rels.map((r) => safeRel(workspaceRoot, r))
  await run('git', ['add', '--', ...targets], writeOpts(workspaceRoot))
}

/** 取消暂存（`git restore --staged`）。**只动暂存区，不动工作区文件** —— 用户的改动还在 */
export async function gitUnstage(workspaceRoot: string, rels: string[]): Promise<void> {
  if (rels.length === 0) return
  const targets = rels.map((r) => safeRel(workspaceRoot, r))
  await run('git', ['restore', '--staged', '--', ...targets], writeOpts(workspaceRoot))
}

/**
 * 提交。**消息走 stdin**（`-F -`），绝不拼进命令行。
 * 空消息由调用方拦（界面按钮禁用），这里再兜一道 —— 两层，不靠单点。
 */
export async function gitCommit(workspaceRoot: string, message: string): Promise<string> {
  const msg = message.trim()
  if (msg.length === 0) throw new Error('提交消息不能为空')

  // ⚠️ 消息里可能含引号、反引号、分号 —— 拼进 shell 就是命令注入。
  //    `execFile` 的数组参数形式本身不经过 shell，再配 `-F -` 从 stdin 喂内容，双保险。
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['commit', '-F', '-'],
      { ...writeOpts(workspaceRoot), maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // git 的失败原因很有用（"nothing to commit" / hook 失败 / 用户没配 user.email），
          // 原样往上抛，让界面**把原因说出来**（项目一贯做法）
          reject(new Error(stderr.trim() || stdout.trim() || err.message))
          return
        }
        resolve(stdout.trim())
      }
    )
    child.on('error', reject)
    child.stdin?.end(msg)
  })
}
