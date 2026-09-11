import Store from 'electron-store'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceInfo } from '@shared/ipc'
import { decideWorkspace } from './workspace-core'

// 工作区（P2）：Agent 可读写的边界目录。默认内置 userData/agent-workspace，
// 用户可用系统目录选择器授权任意真实目录——**这是唯一扩大 Agent 活动范围的入口**。

interface WorkspaceStore {
  workspaceRoot?: string
}

const store = new Store<WorkspaceStore>({ name: 'workspace' })

/** 内置默认工作区 */
export function defaultWorkspaceRoot(userDataDir: string): string {
  return join(userDataDir, 'agent-workspace')
}

function isUsableDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析当前生效的工作区：存了自定义路径且目录仍存在 → 用它；否则回退默认。
 * 目录被删/移动时自动回退（而不是抛错），避免用户手滑后整个 Agent 不可用。
 */
export function resolveWorkspaceRoot(userDataDir: string): { root: string; custom: boolean } {
  return decideWorkspace(store.store.workspaceRoot, isUsableDir, defaultWorkspaceRoot(userDataDir))
}

export function getWorkspaceInfo(userDataDir: string): WorkspaceInfo {
  const { root, custom } = resolveWorkspaceRoot(userDataDir)
  return { path: root, custom }
}

/** 设置工作区（由目录选择器调用）；目录不存在则创建 */
export function setWorkspaceRoot(dir: string): void {
  mkdirSync(dir, { recursive: true })
  store.set('workspaceRoot', dir)
}

/** 重置回内置默认 */
export function resetWorkspaceRoot(): void {
  store.delete('workspaceRoot')
}
