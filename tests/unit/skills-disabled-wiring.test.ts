// plan54 断链 #6：技能「禁用」只过滤了注入清单，没过滤**工具层**。
//
// 症状：`runner.ts` 注册 `use_skill` 的门槛是 `store.hasActive()`，而它只排 `overridden`、不排禁用名单
// ⇒ 全禁用时模型仍拿到一个对着空清单的 `use_skill`；`store.read(name)` 同样不查名单
// ⇒ 按精确名仍能读到被禁技能的正文。这与 `ipc.ts` 注入段注释里立的边界并不冲突：
// **view() 必须留全量**（设置页要能看到被禁项才能重新开启），要收口的是**生效集合**那一侧。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createAllTools } from '@main/agent/runner'
import { createSkillsStore } from '@main/skills/skills-store'

const ROOT = process.cwd()
const dirs: string[] = []

function storeWith(names: string[], disabled: () => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'jsll-skdis-'))
  dirs.push(dir)
  for (const n of names) {
    writeFileSync(join(dir, `${n}.md`), `---\ndescription: ${n} 的说明\n---\n${n} 的正文\n`, 'utf8')
  }
  // ⚠️ 契约是 `(name) => boolean`：直接把 `() => string[]` 传进去会恒真（数组是 truthy），
  //    于是"所有技能都被禁用"—— 而**测试文件不在 `npm run typecheck` 覆盖范围内**，
  //    这种类型错只有断言撞得出来（本行就是这么发现的）。
  return createSkillsStore({ builtinDir: null, userDir: dir, isDisabled: (name) => disabled().includes(name) })
}

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('技能禁用要收到生效集合（#6）', () => {
  it('★ 全部禁用 ⇒ `hasActive()` 为假 ⇒ `use_skill` 不下发（模型不该拿到对着空清单的工具）', () => {
    const store = storeWith(['alpha', 'beta'], () => ['alpha', 'beta'])
    expect(store.hasActive()).toBe(false)
    const names = createAllTools(ROOT, { skills: { store } }).map((t) => t.schema.name)
    expect(names).not.toContain('use_skill')
  })

  it('只禁一部分 ⇒ 仍下发，且生效清单里只有没被禁的那些', () => {
    const store = storeWith(['alpha', 'beta'], () => ['beta'])
    expect(store.hasActive()).toBe(true)
    expect(store.activeEntries().map((e) => e.name)).toEqual(['alpha'])
  })

  it('★ `read()` 不许返回被禁技能的正文（按精确名绕过禁用 = 假禁用）', () => {
    let disabled = ['beta']
    const store = storeWith(['alpha', 'beta'], () => disabled)
    expect(store.read('beta')).toBeNull()
    expect(store.read('alpha')).not.toBeNull()
    // 开关是**活的**：解禁后同一实例立刻可读（每轮装配都重读名单，不靠重启）
    disabled = []
    expect(store.read('beta')).not.toBeNull()
    expect(store.activeEntries().length).toBe(2)
  })

  it('阳性对照：`view()` 必须仍是全量 —— 设置页看不到被禁项就没法再打开', () => {
    const store = storeWith(['alpha', 'beta'], () => ['beta'])
    expect(store.view().entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta'])
  })
})
