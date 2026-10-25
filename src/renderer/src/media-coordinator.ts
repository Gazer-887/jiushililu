// 媒体播放协调（plan74 故事3）：一个会话里同时只播一个，折叠/切会话/释放即停，重开只恢复进度。
//
// 为什么独立成模块而不塞进 zustand store：store.ts 是 1100+ 行的大文件，
// 直接改风险高；而播放协调是一块边界清晰、可完整单测的逻辑（谁在播、播到哪、暂停没）。
// 这里只维护**状态与决策**，真正的 pause()/currentTime 由渲染层经 setActiveElement 桥接。
//
// 三条不变式（故事3 命名断言钉住）：
//  ① 单播放：激活一个就暂停其余（互斥）。
//  ② 生命周期：释放句柄 / 卸载即停，不隐藏着继续出声。
//  ③ 进度：按「会话 + 稳定资产身份」记进度，不用临时句柄当 key —— 重开还能续上，但不自动播。

/** 一个已注册的播放元素（渲染层媒体元素的薄封装）。 */
export interface MediaElement {
  /** 真正暂停这个元素（HTMLMediaElement.pause）。 */
  pause: () => void
  /** 读取当前播放秒数（进度记录用）。 */
  currentTime: () => number
  /** 恢复到某秒（重开时续播用；不自动 play）。 */
  seek: (sec: number) => void
}

/** 进度键：会话 + 稳定资产身份。⚠️ 不用 handleId（它会变），用这个才能跨重开续上。 */
export interface MediaPositionKey {
  conversationId: string
  assetId: string
  /** 产物内容版本（artifact 用；history 恒空）。变了就是不同文件。 */
  sourceVersion?: string
}

function keyOf(k: MediaPositionKey): string {
  return `${k.conversationId}\u0000${k.assetId}\u0000${k.sourceVersion ?? ''}`
}

export class MediaCoordinator {
  /** 当前唯一在播的键（null = 没有在播的）。 */
  private playing: { key: string; element: MediaElement } | null = null
  /** 已注册元素：key → 元素。 */
  private readonly elements = new Map<string, Set<MediaElement>>()
  /** 进度表：key → 秒。 */
  private readonly positions = new Map<string, number>()

  /** 注册一个播放元素。重复注册同一键 = 更新元素（重开时续用进度）。 */
  register(key: MediaPositionKey, el: MediaElement): void {
    const k = keyOf(key)
    const instances = this.elements.get(k) ?? new Set<MediaElement>()
    instances.add(el)
    this.elements.set(k, instances)
    // 重开：恢复到上次进度（只 seek，不自动 play —— 由用户点播放）
    const saved = this.positions.get(k)
    if (saved !== undefined && saved > 0) {
      try {
        el.seek(saved)
      } catch {
        /* seek 失败不阻塞注册 */
      }
    }
  }

  /** 注销一个元素（卸载/释放）。若它正在播，先停再摘。 */
  unregister(key: MediaPositionKey, element?: MediaElement): void {
    const k = keyOf(key)
    const instances = this.elements.get(k)
    const el = element ?? instances?.values().next().value
    if (el) {
      // 走最终进度保存再停
      this.saveProgress(k, el)
      try {
        el.pause()
      } catch {
        /* 已卸载元素 pause 可能抛，忽略 */
      }
      instances?.delete(el)
      if (!instances?.size) this.elements.delete(k)
    }
    if (this.playing?.element === el) this.playing = null
  }

  /** 某个元素开始播放：暂停当前正在播的那个（互斥），把它设为唯一活跃。 */
  onPlay(key: MediaPositionKey, element?: MediaElement): void {
    const k = keyOf(key)
    const el = element ?? this.elements.get(k)?.values().next().value
    if (!el || !this.elements.get(k)?.has(el) || this.playing?.element === el) return
    // 互斥：只暂停**当前正在播的**那一个（activeKey），不是所有注册元素 ——
    // 从没播过的元素 pause 是无意义调用（实测：无脑全停会让"没播的 B"也被记一次 pause）。
    const prev = this.playing
    if (prev) {
      this.saveProgress(prev.key, prev.element)
      this.playing = null
      try {
        prev.element.pause()
      } catch {
        /* 忽略单个暂停失败，不让互斥整体失效 */
      }
    }
    this.playing = { key: k, element: el }
  }

  /** 某个元素暂停了：记录进度，清活跃位。 */
  onPause(key: MediaPositionKey, element?: MediaElement): void {
    const k = keyOf(key)
    const el = element ?? this.elements.get(k)?.values().next().value
    if (el) this.saveProgress(k, el)
    if (this.playing?.element === el) this.playing = null
  }

  /** 播放中定期调用：记录进度（不改变活跃位）。 */
  onTimeUpdate(key: MediaPositionKey, element?: MediaElement): void {
    const k = keyOf(key)
    const el = element ?? this.elements.get(k)?.values().next().value
    if (el) this.saveProgress(k, el)
  }

  /** 当前唯一在播的键（供 UI 显示「正在播放」）。 */
  get active(): string | null {
    return this.playing?.key ?? null
  }

  /** 取某键的记录进度（秒）。没有返回 0。 */
  positionOf(key: MediaPositionKey): number {
    return this.positions.get(keyOf(key)) ?? 0
  }

  private saveProgress(k: string, el: MediaElement): void {
    try {
      const t = el.currentTime()
      if (Number.isFinite(t) && t >= 0) this.positions.set(k, t)
    } catch {
      /* 读不到 currentTime 就保留旧进度 */
    }
  }
}
