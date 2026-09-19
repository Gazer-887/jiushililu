/**
 * 复现：渲染层"内联回调 → effect 每渲染重跑 → 高频 IPC → 重渲染"自持闭环
 *
 * 来源：2026-09-19 真机卡顿复发的根因取证脚本（当时临时写在 /tmp）。
 * 证据（`%APPDATA%/jiushililu/logs/app.log`）：12 分钟内 166 条停滞告警，
 * 累计 635 秒，每分钟被占死 55–60 秒，单次最长 9792ms；
 * 面包屑里唯一出现的通道是 `agents:list`（664 对进出，每次 1ms）。
 *
 * 跑法：
 *   node tests/bench/render-callback-loop.mjs
 *
 * 期望输出：
 *   - unstable：effectRuns 撞到熔断上限（证明闭环自持）
 *   - stable  ：effectRuns === 1（证明修法有效，差 200 倍）
 *
 * ⚠️ 这是**原理性复现**，不是端到端测试：它模拟 zustand 的"set → 通知订阅者"
 * 与 React "渲染 → 异步 flush passive effect" 两段时序，不加载真实组件
 * （渲染层没有 DOM 测试环境，见 config/vitest.config.ts 的 environment: 'node'）。
 * 它的价值是**把因果链钉死成可执行的东西** —— 结论可复跑、可反驳，不靠嘴上说。
 */

const MAX_EFFECT_RUNS = 200 // 熔断：证明"它会一直转"，又不至于把机器跑满

/**
 * @param {boolean} stableCallback true = 回调引用跨渲染稳定（修好后）；false = 每次渲染新建（病态）
 * @param {'microtask'|'macrotask'} latency 异步延迟模型：微任务（无真实延迟）/ 宏任务（模拟 IPC 往返）
 */
async function simulate(stableCallback, latency) {
  let renders = 0
  let effectRuns = 0
  let ipcCalls = 0

  // 稳定的那份"同一个函数实例"（模拟 useCallback 的产物）
  const STABLE = () => {}

  // 迷你 store：setState 同步通知所有订阅者（对齐 zustand vanilla 的实现）
  function makeStore(init) {
    let state = init
    const listeners = new Set()
    return {
      getState: () => state,
      setState: (patch) => {
        const next = typeof patch === 'function' ? patch(state) : patch
        if (!Object.is(next, state)) {
          state = Object.assign({}, state, next)
          listeners.forEach((l) => l())
        }
      },
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      }
    }
  }
  const store = makeStore({ agentsView: null })

  // 渲染：每次渲染把"当前的回调实例"交给 effect 调度
  function render() {
    renders++
    const cb = stableCallback ? STABLE : () => {} // ← 内联箭头 = 新实例
    queueMicrotask(() => runEffect(cb))
  }

  let prevDep = null
  function runEffect(dep) {
    if (dep === prevDep) return // React 的依赖比较：同一个引用就不重跑
    prevDep = dep
    effectRuns++
    if (effectRuns > MAX_EFFECT_RUNS) return

    // effect 内的 await：refreshAgents() → set({ agentsView: await listAgents() })
    const fire = () => {
      ipcCalls++
      store.setState({ agentsView: { entries: [] } }) // 全新对象 ⇒ 订阅者必定判定"变了"
    }
    if (latency === 'microtask') Promise.resolve().then(fire)
    else new Promise((r) => setImmediate(r)).then(fire)
  }

  // useSyncExternalStore 的订阅者：快照变了就重渲染
  let lastSnap = null
  store.subscribe(() => {
    const snap = store.getState().agentsView
    if (!Object.is(snap, lastSnap)) {
      lastSnap = snap
      render()
    }
  })

  render() // 首次挂载
  await new Promise((r) => setTimeout(r, 300))
  return { renders, effectRuns, ipcCalls }
}

const unstableMicro = await simulate(false, 'microtask')
const unstableMacro = await simulate(false, 'macrotask')
const stable = await simulate(true, 'microtask')

console.log('【病态】内联回调 + 微任务延迟（无真实 IPC 耗时）')
console.log('  ', JSON.stringify(unstableMicro))
console.log('【病态】内联回调 + 宏任务延迟（模拟 IPC 往返）')
console.log('  ', JSON.stringify(unstableMacro))
console.log('【修好】稳定回调')
console.log('  ', JSON.stringify(stable))

const ok =
  unstableMicro.effectRuns > MAX_EFFECT_RUNS &&
  unstableMacro.effectRuns > MAX_EFFECT_RUNS &&
  stable.effectRuns === 1

console.log(ok ? '\n结论：闭环自持已复现，且修法（稳定引用）有效。' : '\n结论：与预期不符，请重新检查模型。')
process.exit(ok ? 0 : 1)
