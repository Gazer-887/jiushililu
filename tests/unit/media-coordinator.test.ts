// 媒体播放协调的命名断言（plan74 故事3）：单播放 / 卸载即停 / 进度按稳定键续接。
// 直接 import 真实 MediaCoordinator，注入假元素（只记 pause/seek/currentTime 调用）—— 不复制规则。
import { describe, it, expect } from 'vitest'
import { MediaCoordinator, type MediaElement, type MediaPositionKey } from '../../src/renderer/src/media-coordinator'

/** 假媒体元素：记录 pause 次数、当前秒、被 seek 到的秒。 */
function fakeEl(startAt = 0): MediaElement & { pauses: number; seeks: number; at: number } {
  const el = {
    pauses: 0,
    seeks: 0,
    at: startAt,
    pause() {
      this.pauses++
    },
    currentTime() {
      return this.at
    },
    seek(sec: number) {
      this.seeks++
      this.at = sec
    }
  }
  return el
}

const kA: MediaPositionKey = { conversationId: 'c1', assetId: 'asset-a' }
const kB: MediaPositionKey = { conversationId: 'c1', assetId: 'asset-b' }

describe('media-coordinator 单播放与生命周期', () => {
  it('同一资产在两处展开仍互斥，注销旧实例不暂停新实例', () => {
    const c = new MediaCoordinator()
    const a = fakeEl(12); const b = fakeEl()
    c.register(kA, a); c.register(kA, b)
    c.onPlay(kA, a)
    c.onPlay(kA, b)
    expect(a.pauses).toBe(1)
    expect(b.pauses).toBe(0)
    c.unregister(kA, a)
    expect(c.active).toContain('asset-a')
    expect(b.pauses).toBe(0)
  })
  it('单播放：激活 B 时 A 被暂停（互斥）', () => {
    const c = new MediaCoordinator()
    const a = fakeEl()
    const b = fakeEl()
    c.register(kA, a)
    c.register(kB, b)
    c.onPlay(kA)
    expect(c.active).toContain('asset-a')
    c.onPlay(kB) // 播 B → A 必须停
    expect(a.pauses).toBe(1)
    expect(b.pauses).toBe(0)
    expect(c.active).toContain('asset-b')
  })

  it('同一元素重复 onPlay 不重复暂停其他', () => {
    const c = new MediaCoordinator()
    const a = fakeEl()
    const b = fakeEl()
    c.register(kA, a)
    c.register(kB, b)
    c.onPlay(kA)
    c.onPlay(kA) // 同一个再触发一次
    expect(b.pauses).toBe(0) // B 本就没播，不受影响
    expect(c.active).toContain('asset-a')
  })

  it('卸载即停：unregister 正在播的元素会停并清活跃位', () => {
    const c = new MediaCoordinator()
    const a = fakeEl()
    c.register(kA, a)
    c.onPlay(kA)
    c.unregister(kA)
    expect(a.pauses).toBe(1)
    expect(c.active).toBeNull()
  })

  it('进度按稳定键续接：重开（重新 register）只 seek 不自动播', () => {
    const c = new MediaCoordinator()
    const a1 = fakeEl()
    c.register(kA, a1)
    a1.at = 42
    c.onTimeUpdate(kA) // 记录到 42 秒
    c.onPause(kA)
    c.unregister(kA)
    // 重开：新元素，同键
    const a2 = fakeEl(0)
    c.register(kA, a2)
    expect(a2.seeks).toBe(1) // 被 seek 到上次进度
    expect(a2.at).toBe(42) // 续上了
  })

  it('进度不串键：不同资产各记各的', () => {
    const c = new MediaCoordinator()
    const a = fakeEl()
    const b = fakeEl()
    c.register(kA, a)
    c.register(kB, b)
    a.at = 10
    b.at = 99
    c.onTimeUpdate(kA)
    c.onTimeUpdate(kB)
    expect(c.positionOf(kA)).toBe(10)
    expect(c.positionOf(kB)).toBe(99)
  })

  it('进度含版本：artifact 内容变了是不同键，不续旧进度', () => {
    const c = new MediaCoordinator()
    const v1: MediaPositionKey = { conversationId: 'c1', assetId: 'x', sourceVersion: 'v1' }
    const v2: MediaPositionKey = { conversationId: 'c1', assetId: 'x', sourceVersion: 'v2' }
    const e1 = fakeEl()
    c.register(v1, e1)
    e1.at = 30
    c.onTimeUpdate(v1)
    expect(c.positionOf(v1)).toBe(30)
    expect(c.positionOf(v2)).toBe(0) // 版本不同，进度不继承
  })
})
