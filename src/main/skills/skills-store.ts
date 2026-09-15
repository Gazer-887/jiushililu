// 技能的**装配层**（plan22 S3）：两级目录 → loader → 快照视图。
// ⚠️ 目录**由组合根注入**，本文件不解析路径也不碰 electron ——
//    skills 层因此物理上没有通路能碰到 `store/settings.ts`（权限档唯一真相源），
//    与 `playbook-store.ts` / `memory-store.ts` 同一条架构不变量（architecture.test.ts 守卫）。
// 本期技能是**只读资产**（无任何写路径、无 fs.watch）：reload 保留接口，
// 由 IPC 层在需要时手动触发（如后续加导入功能）；changed 回调服务于将来的界面刷新。

import { loadSkillEntries, type SkillEntry, type SkillLayer, type SkillLoadResult } from '../skills/loader'

export interface SkillsView {
  /** 全量条目（含被覆盖的 overridden=true 条目，设置页覆盖标记靠它） */
  entries: SkillEntry[]
  /** 加载告警（fail-soft 但绝不静默） */
  warnings: string[]
}

export interface SkillsStore {
  /** 全量视图快照（含 overridden 标记与 warnings） */
  view(): SkillsView
  /** 按 name 取**生效集合**里的单个技能（overridden 的取不到 —— 它不在生效集合里）；use_skill 用 */
  read(name: string): SkillEntry | null
  /** 是否存在**生效**技能（D-059：「有消费者才注册」的判定口） */
  hasActive(): boolean
  /** 重新扫盘。本期无写路径，此接口为后续导入功能预留 */
  reload(): void
  /** reload / 未来写路径变更时通知；返回退订函数 */
  onChange(cb: () => void): () => void
}

export function createSkillsStore(deps: {
  builtinDir: string | null
  userDir: string | null
  onWarn?: (w: string) => void
}): SkillsStore {
  const listeners = new Set<() => void>()
  const layers: SkillLayer[] = [
    { dir: deps.builtinDir, source: 'builtin' },
    { dir: deps.userDir, source: 'user' }
  ]
  let snapshot: SkillLoadResult = { entries: [], warnings: [] }

  const load = () => {
    snapshot = loadSkillEntries(layers)
    for (const w of snapshot.warnings) deps.onWarn?.(w)
  }
  load()

  return {
    view: () => ({ entries: [...snapshot.entries], warnings: [...snapshot.warnings] }),
    read: (name) => snapshot.entries.find((e) => e.name === name && !e.overridden) ?? null,
    hasActive: () => snapshot.entries.some((e) => !e.overridden),
    reload: () => {
      load()
      for (const cb of listeners) cb()
    },
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
