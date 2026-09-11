// 工作区判定的**纯逻辑**（与 electron-store / fs 解耦，便于单测）。
// 规则：存了自定义路径且目录可用 → 用它；否则回退内置默认。

export interface WorkspaceDecision {
  root: string
  custom: boolean
}

export function decideWorkspace(
  saved: string | undefined | null,
  isUsableDir: (path: string) => boolean,
  fallback: string
): WorkspaceDecision {
  if (typeof saved === 'string' && saved.length > 0 && isUsableDir(saved)) {
    return { root: saved, custom: true }
  }
  return { root: fallback, custom: false }
}
