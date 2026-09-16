// L1 场景回归的 vitest 入口（plan25 判据 8）：每个场景注册成一个用例，
// 收尾打印**分层通过率汇总**（simple / medium / complex）。回归口径：必须 ~100%，
// 掉分 = 新改动破坏了既有故事，先修再合。

import { afterAll, describe, expect, it } from 'vitest'
import { runScenario, type Level } from './harness'
import { scenarios } from './scenarios'

const LEVELS: Level[] = ['simple', 'medium', 'complex']
const tally = new Map<Level, { pass: number; fail: number }>()
for (const l of LEVELS) tally.set(l, { pass: 0, fail: 0 })

describe('L1 场景回归（plan25 S2）', () => {
  for (const s of scenarios) {
    it(`${s.id} [${s.level}] ${s.desc}`, async () => {
      const w = await runScenario(s)
      try {
        s.expect(w)
        const t = tally.get(s.level)!
        t.pass += 1
      } catch (err) {
        const t = tally.get(s.level)!
        t.fail += 1
        throw err
      }
    })
  }

  afterAll(() => {
    const total = { pass: 0, fail: 0 }
    const lines = LEVELS.map((l) => {
      const t = tally.get(l)!
      total.pass += t.pass
      total.fail += t.fail
      const n = t.pass + t.fail
      return `    ${l.padEnd(7)} ${t.pass}/${n}${n > 0 ? ` (${Math.round((t.pass / n) * 100)}%)` : ''}`
    })
    const rate = total.pass + total.fail > 0 ? Math.round((total.pass / (total.pass + total.fail)) * 100) : 0
    console.log(
      [``, `  ┌─ L1 场景回归通过率 ─────────────`, ...lines, `    ─────────────────────────────`, `    总计     ${total.pass}/${total.pass + total.fail} (${rate}%)`, `  └─ 回归口径：必须 ~100%，掉分 = 破坏既有故事`].join('\n')
    )
    // 回归口径的机器闸：任何场景失败vitest 自然红；这里的汇总只是给人看的读数
    expect(total.fail).toBe(0)
  })
})
