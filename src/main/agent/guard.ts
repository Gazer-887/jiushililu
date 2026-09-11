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
 * 把目标路径解析到 workspaceRoot 内；越界返回 null。
 * 防三类逃逸：① 相对路径 ../ ② 绝对路径直指工作区外 ③ **符号链接指向工作区外**（用真实路径比对）
 */
export function resolveInsideWorkspace(root: string, target: string): string | null {
  if (typeof target !== 'string' || target.length === 0) return null
  const abs = isAbsolute(target) ? resolve(target) : resolve(join(root, target))
  const normRoot = resolve(root)

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
  return abs
}
