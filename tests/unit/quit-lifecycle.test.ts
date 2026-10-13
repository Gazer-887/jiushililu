import { expect, it, vi } from 'vitest'
import { createQuitBarrier } from '@main/quit-lifecycle'

it('退出等待释放，重复请求不重复释放，超时仍可结束', async () => {
  const dispose = vi.fn(() => new Promise<void>(() => {}))
  const quit = vi.fn()
  const barrier = createQuitBarrier(dispose, quit, 10)
  const preventDefault = vi.fn()
  barrier({ preventDefault }); barrier({ preventDefault })
  await new Promise((r) => setTimeout(r, 30))
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(quit).toHaveBeenCalledTimes(1)
  barrier({ preventDefault })
  expect(preventDefault).toHaveBeenCalledTimes(2)
})
