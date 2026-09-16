import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// 白名单门控（plan6 D4）：权限门控的第一道消费者。
// 门控只回答一个问题——"这个工具，这个 Agent 配碰吗"；路径越界是工具自身的责任（见 file-tools）。

export interface GateCheck {
  ok: boolean
  reason?: string
}

export class ToolGate {
  private readonly allowed: ReadonlySet<string>

  constructor(allowed: Iterable<string>) {
    this.allowed = new Set(allowed)
  }

  check(toolName: string): GateCheck {
    if (this.allowed.has(toolName)) return { ok: true }
    return { ok: false, reason: `工具「${toolName}」不在当前 Agent 的白名单内，调用被门控拦截` }
  }
}

/** 解析到"最深的已存在祖先"的真实路径，再拼回未存在的尾部（用于校验待创建文件的目标位置） */
export function realpathDeepest(abs: string): string {
  let cur = abs
  let tail = ''
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail ? join(real, tail) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs // 到根都不存在（异常输入）
      tail = tail ? join(basename(cur), tail) : basename(cur)
      cur = parent
    }
  }
}

/**
 * 路径放行策略（plan29 D-089）。
 *
 * ⚠️ **有两条互不相干的消费线，绝不能一起放开**：
 * - **Agent 线**（`file-tools` / `system-tools` / `workspace-write`）→ 应当受权限档影响；
 * - **界面线**（`ipc` / `workspace-fs` / `office-preview` / `preview-protocol` / `store/git-info`）→ **绝不能**。
 *
 * 理由是这条：档位是 **Agent 的**权限档。用户说「Agent 权限不足」时，
 * 如果顺手把**界面**的文件访问也放开，就把一个「权限不足」的问题换成了「**界面越权**」这个更严重的问题，
 * 而且是用户从没要求过的能力扩张。`workspace-fs.ts:21` 的注释本就写着这条分界是有意为之。
 *
 * 默认（不传）＝ 锁死。**fail-closed 是刻意的默认**：新增调用点忘了传策略时，得到的是"更严"而不是"更松"。
 */
export interface PathAccess {
  /** `true` = 允许越过工作区边界（「完全访问」档在 Agent 线上的语义）。缺省 / false = 锁死 */
  allowOutside?: boolean
}

/** 一次解析的完整结论：绝对路径 + **是否出了界**（出了界要如实告知用户，见 plan29 决议 2） */
export interface ResolvedPath {
  abs: string
  /** 落在工作区之外 —— 调用方据此在结果里**显示绝对路径**。既然选择不拦，就必须让人看得见它出了界。 */
  outside: boolean
}

/**
 * 把目标路径解析到 workspaceRoot 内，并回答"有没有出界"；按策略决定出界时是拒绝还是放行。
 *
 * 防三类逃逸：① 相对路径 ../ ② 绝对路径直指工作区外 ③ **符号链接指向工作区外**（用真实路径比对）
 *
 * ⚠️ `allowOutside` 下**不再做符号链接真实路径比对** —— 那个比对的目的是"揭穿伪装成界内的界外路径"，
 * 而在"界外本来就允许"的前提下它没有意义（用户要的就是碰真实机器）。故这一档下只做解析，不做判定。
 */
export function resolvePathInWorkspace(root: string, target: string, access?: PathAccess): ResolvedPath | null {
  if (typeof target !== 'string' || target.length === 0) return null
  const abs = isAbsolute(target) ? resolve(target) : resolve(join(root, target))
  const normRoot = resolve(root)

  // 「完全访问」档在 **Agent 线** 上的语义：没有边界。仍返回绝对路径，好让上层如实展示落点。
  if (access?.allowOutside === true) return { abs, outside: !isInside(normRoot, abs) }

  // 真实路径对比：符号链接会把"看起来在内"的路径指向外面，必须用 realpath 揭穿
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpathDeepest(normRoot)
    realTarget = realpathDeepest(abs)
  } catch {
    return null
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null
  return { abs, outside: false }
}

/** 绝对路径是否落在 root 内（**纯几何判断**，不解符号链接、不做策略）—— 只用于"要不要提示越界" */
export function isInside(root: string, abs: string): boolean {
  const a = resolve(abs)
  const r = resolve(root)
  return a === r || a.startsWith(r + sep)
}

/**
 * 把目标路径解析到 workspaceRoot 内；越界返回 null。
 *
 * ⚠️ **本函数不含策略**（默认锁死）：**界面线一律用它，且永远不要给它第三参** ——
 * 界面线放开等于界面越权（见 `PathAccess` 的说明）。Agent 线请直接用 `resolvePathInWorkspace`，
 * 因为它还需要知道"出没出界"来如实提示用户。
 */
export function resolveInsideWorkspace(root: string, target: string): string | null {
  return resolvePathInWorkspace(root, target)?.abs ?? null
}
