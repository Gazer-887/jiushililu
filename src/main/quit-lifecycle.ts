/** 退出门：首次阻止退出，释放完或超时再退出；第二轮不再拦截。 */
export function createQuitBarrier(dispose: () => Promise<void>, quit: () => void,
  timeoutMs = 5000, warn: () => void = () => {}): (event: { preventDefault(): void }) => void {
  let pending = false
  let finished = false
  return (event) => {
    if (finished) return
    event.preventDefault()
    if (pending) return
    pending = true
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { warn(); resolve() }, timeoutMs) })
    void Promise.race([Promise.resolve().then(dispose).catch(warn), timeout]).finally(() => {
      clearTimeout(timer)
      finished = true
      quit()
    })
  }
}
