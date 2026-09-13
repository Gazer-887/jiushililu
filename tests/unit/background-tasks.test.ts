import { describe, expect, it } from 'vitest'
import { createBackgroundTaskStore, MAX_OUTPUT, MAX_TASKS } from '@main/agent/background-tasks'

// 后台任务注册表（plan7 批 D）：用 node 自身当"被执行的命令"，跨平台、不依赖 shell 内建。

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等某个条件成立 —— 别用 sleep 猜时间，那种测试在 CI 上会时好时坏 */
async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await wait(50)
  }
}

const LONG = 'node -e "setTimeout(()=>{},30000)"'

describe('background-tasks（后台任务注册表）', () => {
  it('启动 → 输出累积 → 结束为 done（exit 0）', async () => {
    const store = createBackgroundTaskStore()
    const t = store.start({ command: 'node -e "console.log(\'hi\')"', cwd: process.cwd(), agent: 'test' })
    expect(t.status).toBe('running')
    expect(store.list()).toHaveLength(1)

    await until(() => store.get(t.id)?.status === 'done')
    const done = store.get(t.id)!
    expect(done.output).toContain('hi')
    expect(done.exitCode).toBe(0)
  })

  it('退出码非 0 → failed，并记下退出码', async () => {
    const store = createBackgroundTaskStore()
    const t = store.start({ command: 'node -e "process.exit(3)"', cwd: process.cwd(), agent: 'test' })
    await until(() => store.get(t.id)?.status === 'failed')
    expect(store.get(t.id)?.exitCode).toBe(3)
  })

  it('kill 能停掉还在跑的任务；重复 kill 返回 false', async () => {
    const store = createBackgroundTaskStore()
    const t = store.start({ command: LONG, cwd: process.cwd(), agent: 'test' })
    expect(store.kill(t.id)).toBe(true)
    await until(() => store.get(t.id)?.status === 'killed')
    expect(store.kill(t.id)).toBe(false)
  })

  it('killAll 一次停掉全部（窗口关闭时的边界①）', async () => {
    const store = createBackgroundTaskStore()
    const a = store.start({ command: LONG, cwd: process.cwd(), agent: 'test' })
    const b = store.start({ command: LONG, cwd: process.cwd(), agent: 'test' })
    store.killAll()
    await until(() => store.get(a.id)?.status === 'killed' && store.get(b.id)?.status === 'killed')
  })

  it('超过上限时拒绝启动（防手滑起一百个）', () => {
    const store = createBackgroundTaskStore()
    for (let i = 0; i < MAX_TASKS; i++) {
      store.start({ command: LONG, cwd: process.cwd(), agent: 'test' })
    }
    expect(() => store.start({ command: LONG, cwd: process.cwd(), agent: 'test' })).toThrow(/上限/)
    store.killAll()
  })

  it('输出超限时只保留末尾，并标记 truncated', async () => {
    const store = createBackgroundTaskStore()
    const t = store.start({
      command: 'node -e "process.stdout.write(\'x\'.repeat(100000))"',
      cwd: process.cwd(),
      agent: 'test'
    })
    await until(() => store.get(t.id)?.status === 'done')
    const task = store.get(t.id)!
    expect(task.truncated).toBe(true)
    expect(task.output.length).toBeLessThanOrEqual(MAX_OUTPUT)
  })

  it('onChange 会在启动与结束时被通知（界面据此刷新）', async () => {
    const store = createBackgroundTaskStore()
    let calls = 0
    const off = store.onChange(() => {
      calls++
    })
    const t = store.start({ command: 'node -e "1"', cwd: process.cwd(), agent: 'test' })
    await until(() => store.get(t.id)?.status === 'done')
    await wait(250) // 等节流窗口过去
    expect(calls).toBeGreaterThanOrEqual(2)
    off()
  })
})
