import { isAbsolute, join, resolve, sep } from 'node:path'

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

/**
 * 把目标路径解析到 workspaceRoot 内；越界（../ 逃逸、绝对路径指到外面）返回 null。
 * 防两类攻击：相对路径 ../ 逃逸、绝对路径直指工作区外。
 */
export function resolveInsideWorkspace(root: string, target: string): string | null {
  if (typeof target !== 'string' || target.length === 0) return null
  const abs = isAbsolute(target) ? resolve(target) : resolve(join(root, target))
  const normRoot = resolve(root)
  if (abs !== normRoot && !abs.startsWith(normRoot + sep)) return null
  return abs
}
