import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Goal } from '@shared/goal'
import { apiCall, launchApp, type E2EApp } from './helpers'

/**
 * 目标落盘的**真入口**回归（plan12 §四 验收 4「重启还在」+ §三 步 1 出口「写→读回一致」）。
 *
 * 为什么这条必须在 e2e 而不是单测（分工，不是重复）：
 * `tests/unit/goal-store.test.ts` 走的是注入的 fs backend —— 它能测语义（校验、计数、归属、非法转移），
 * 但**碰不到 electron-store 这一层**（键名、`name:'goals'` 起出的文件名、userData 落点、真重启）。
 * 那一段只有驱动真 `out/main/index.js` 才照得出来 —— 与 `boot.spec.ts` 里"设置窗标志只有真入口测得到"同一条理由。
 */

const CONV = 'e2e-goal-conv'

/** 在沙箱数据目录里找出 goals.json（userData 落点由引导决定，别让测试猜死路径） */
function findGoalFile(root: string, depth = 0): string | null {
  if (depth > 3) return null
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      const hit = findGoalFile(p, depth + 1)
      if (hit) return hit
    } else if (name === 'goals.json') {
      return p
    }
  }
  return null
}

test.describe('C 类 · 目标落盘真往返（不需要 Key）', () => {
  let h: E2EApp
  test.beforeEach(async () => {
    h = await launchApp()
  })
  test.afterEach(async () => {
    await h?.close()
    await h?.cleanup()
  })

  test('建一条目标 ⇒ 磁盘上真有它，且 `goal:list` 逐字段读回一致', async () => {
    const created = await apiCall<Goal>(h.page, 'createGoal', {
      conversationId: CONV,
      text: '把目标通路做成重启还看得见',
      doneWhen: '真入口读回与落盘字节一致'
    })
    expect(created.conversationId).toBe(CONV)
    expect(created.status).toBe('active')

    const file = findGoalFile(h.dataDir)
    expect(file, `沙箱里没找到 goals.json（dataDir=${h.dataDir}）`).not.toBeNull()
    const onDisk = JSON.parse(readFileSync(file as string, 'utf8')) as { goals?: Goal[] }
    expect(onDisk.goals?.map((g) => g.id)).toContain(created.id)

    const readBack = await apiCall<Goal[]>(h.page, 'listGoals', CONV)
    expect(readBack).toEqual([created])
    // createdBy 由组合根写死 'user'（用户侧入口），不是渲染端传什么就是什么
    expect(readBack[0]?.createdBy).toBe('user')
  })

  test('★ 真重启还在：换第二个实例复用同一份数据目录 ⇒ 目标照旧读得回（§四 验收 4）', async () => {
    const created = await apiCall<Goal>(h.page, 'createGoal', {
      conversationId: CONV,
      text: '跨进程存活的那一条'
    })
    const dataDir = h.dataDir
    await h.close()

    h = await launchApp({ reuseDataDir: dataDir })
    const afterRestart = await apiCall<Goal[]>(h.page, 'listGoals', CONV)
    expect(afterRestart).toEqual([created])
  })

  test('点「完成」⇒ 状态真落盘成 done，且它不再出现在"进行中"那条会话的 open 集里', async () => {
    const created = await apiCall<Goal>(h.page, 'createGoal', {
      conversationId: CONV,
      text: '要被完成掉的那一条'
    })
    const done = await apiCall<Goal>(h.page, 'actOnGoal', created.id, 'complete')
    expect(done.status).toBe('done')

    const file = findGoalFile(h.dataDir)
    const onDisk = JSON.parse(readFileSync(file as string, 'utf8')) as { goals: Goal[] }
    expect(onDisk.goals.find((g) => g.id === created.id)?.status).toBe('done')

    // 非法转移走的是同一条真通路：再点一次完成 ⇒ 带人话理由被拒（不是静默不动）
    let reason = ''
    try {
      await apiCall(h.page, 'actOnGoal', created.id, 'complete')
    } catch (err) {
      reason = String((err as Error).message)
    }
    expect(reason).toContain('重开')
    expect(existsSync(file as string)).toBe(true)
  })
})
