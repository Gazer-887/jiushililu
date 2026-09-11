import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitInfo } from '@shared/ipc'

// Git 信息（P2 输入框的分支显示）：读当前工作区的分支名与是否有未提交改动。
// 只用只读命令、限时 3s、失败静默返回 null（非 Git 目录属正常情况，不该报错打扰用户）。
// 注意：更完整的源代码管理（状态/差异/提交）属于右抽屉「源代码管理」页签的后续批次。

const run = promisify(execFile)

export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const opts = { cwd, timeout: 3000, windowsHide: true } as const
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
