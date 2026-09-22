// 技能的**装配层**（plan22 S3）：两级目录 → loader → 快照视图。
// ⚠️ 目录**由组合根注入**，本文件不解析路径也不碰 electron ——
//    skills 层因此物理上没有通路能碰到 `store/settings.ts`（权限档唯一真相源），
//    与 `playbook-store.ts` / `memory-store.ts` 同一条架构不变量（architecture.test.ts 守卫）。
// 本期技能是**只读资产**（无任何写路径、无 fs.watch）：reload 保留接口，
// 由 IPC 层在需要时手动触发（如后续加导入功能）；changed 回调服务于将来的界面刷新。

import { loadSkillEntries, type SkillEntry, type SkillLayer, type SkillLoadResult } from '../skills/loader'
import { filterDisabledEntries } from '@shared/skills'

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
  /** 生效集合（既没被覆盖、也不在禁用名单里）—— 注入清单与工具注册都以它为准 */
  activeEntries(): SkillEntry[]
  /** 是否存在**生效**技能（D-059：「有消费者才注册」的判定口。⚠️ 禁用也算没有 —— 否则全禁用时模型仍拿到一个对着空清单的 `use_skill`） */
  hasActive(): boolean
  /** 重新扫盘。本期无写路径，此接口为后续导入功能预留 */
  reload(): void
  /** reload / 未来写路径变更时通知；返回退订函数 */
  onChange(cb: () => void): () => void
  /** 用户层目录（plan34 S2b 写路径的落点；null = 不可写）。内置层随包**永不可写** */
  getUserDir(): string | null
}

export function createSkillsStore(deps: {
  builtinDir: string | null
  userDir: string | null
  onWarn?: (w: string) => void
  /**
   * 禁用名单由**组合根注入**（skills 层物理上不碰 `store/settings.ts`，那条不变量由 architecture.test.ts 守卫）。
   * 传函数而不是数组：名单是用户随时可改的活状态，每次查询重读，不靠 reload 同步。
   */
  isDisabled?: (name: string) => boolean
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

  /** 生效集合 = 未被覆盖 ∩ 未被禁用。**口径只写在这一处**：注入清单与工具注册都从这里取，
   *  免得 ipc 与 store 各滤一遍、将来漂成两种"禁用"。名单按调用现读（用户随时可改，不靠 reload 同步）。*/
  const active = (): SkillEntry[] =>
    filterDisabledEntries(
      snapshot.entries.filter((e) => !e.overridden),
      snapshot.entries.filter((e) => deps.isDisabled?.(e.name) ?? false).map((e) => e.name)
    )
  load()

  return {
    view: () => ({ entries: [...snapshot.entries], warnings: [...snapshot.warnings] }),
    // 生效集合 = 未被覆盖 ∩ 未被禁用。**口径只写在这一处**：注入段与工具注册都从这里取，
    // 免得 ipc 与 store 各滤一遍、将来漂成两种"禁用"。
    activeEntries: active,
    read: (name) => active().find((e) => e.name === name) ?? null,
    hasActive: () => active().length > 0,
    reload: () => {
      load()
      for (const cb of listeners) cb()
    },
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getUserDir: () => deps.userDir
  }
}
