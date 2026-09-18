// 主进程事件循环看门狗（plan37 S0）：把「主进程被同步任务占死」变成带时长+阶段归属的证据
// （app.log 平时只记事件，冻结窗口零覆盖）。归属靠阶段变更历史回溯「停滞起点」；
// 检测下限=tick 间隔，故间隔取 250ms（成本：每秒 4 次空回调，可忽略）。
// ⚠️ 本文件不 import electron（架构守卫；单测可直接驱动计时）。

import { createLogger } from './log'

const log = createLogger('watchdog')

const HISTORY_MAX = 16
const CRUMBS_MAX = 48

/** 面包屑：IPC/耗时动作的进出记录。停滞告警时随附最近几条 —— 阻塞发生时"最后一条没出"即元凶。
 *  由 index.ts 的 ipcMain.handle 包装器与各处手动 note() 喂数据；本模块保持零 electron 依赖（架构守卫）。 */
let crumbs: { t: number; text: string }[] = []

export function breadcrumb(text: string): void {
  crumbs.push({ t: performance.now(), text })
  if (crumbs.length > CRUMBS_MAX) crumbs = crumbs.slice(-CRUMBS_MAX / 2)
}

function crumbsSince(stallStart: number): string[] {
  return crumbs
    .filter((c) => c.t >= stallStart - 3000) // 多带 3s 前情，只看停滞窗口会丢"进门前那笔"
    .slice(-8)
    .map((c) => `${Math.round(c.t - stallStart)}ms ${c.text}`)
}

let phase = 'idle'
// 哨兵条目：历史被截断后兜底为 unknown，宁可说"不知道"也不误归给残存阶段
let history: { phase: string; at: number }[] = [{ phase: 'unknown', at: Number.NEGATIVE_INFINITY }]
let timer: NodeJS.Timeout | null = null
let lastTick = 0
let intervalMs = 250
let thresholdMs = 1000

/**
 * 设置阶段并**返回前值** —— 调用方必须在 finally 里回存前值（setWatchdogPhase(prev)）。
 * 阶段是单槽全局量：并发路径（工具执行 vs 会话保存）硬写 'idle' 会互相抹平，
 * 与 finishClose/FLUSH_TIMEOUT_MS 同类的单槽坑，save/restore 是唯一稳的用法。
 */
export function setWatchdogPhase(next: string): string {
  const prev = phase
  if (next !== phase) {
    phase = next
    history.push({ phase: next, at: performance.now() })
    if (history.length > HISTORY_MAX) history = history.slice(-(HISTORY_MAX - 1))
  }
  return prev
}

/** 回溯「停滞起点」时刻生效的阶段（performance.now 单调，不受系统时钟回跳影响） */
function phaseAt(stallStart: number): string {
  let hit = history[0]!.phase
  for (const h of history) {
    if (h.at <= stallStart) hit = h.phase
    else break
  }
  return hit
}

export function startWatchdog(opts?: { intervalMs?: number; thresholdMs?: number }): void {
  if (timer) return
  intervalMs = opts?.intervalMs ?? 250
  thresholdMs = opts?.thresholdMs ?? 1000
  lastTick = performance.now()
  history = [{ phase: 'unknown', at: Number.NEGATIVE_INFINITY }, { phase, at: lastTick }]
  timer = setInterval(() => {
    const now = performance.now()
    const stall = now - lastTick - intervalMs
    lastTick = now
    if (stall > thresholdMs) {
      const stallStart = now - stall
      log.warn('事件循环停滞（主进程被同步任务占死）', {
        stallMs: Math.round(stall),
        phase: phaseAt(stallStart),
        crumbs: crumbsSince(stallStart)
      })
    }
  }, intervalMs)
  // 看门狗不许成为进程不退出理由
  timer.unref?.()
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
