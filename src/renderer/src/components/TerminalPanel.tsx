import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon as XFitAddon } from '@xterm/addon-fit'
import type { TerminalDataPayload, TerminalSessionSnapshot } from '@shared/terminal'

// 内置终端面板（plan7 批 C）。
//
// ## 三件事值得先说明白
//
// ① **xterm 按需加载**：与 Monaco 同一套做法（`let promise` 单例 + `import()`），
//    别让它进主 chunk —— 那是**每次启动**都要付的代价，而多数会话根本不看终端。
//
// ② **视图是可丢弃的，会话不是**：本项目「切换页签 = 卸载」是定死的语义（plan9 §W3），
//    所以 shell 与输出缓冲都活在**主进程**；这里重挂时做的第一件事是
//    `terminalSnapshot()` → **按序号重放** → 再续接增量。
//    序号（`nextSeq`）是"不重不漏"的唯一依据：只收 `seq >= nextSeq` 的帧，
//    既不会因为"先重放后订阅"漏一段，也不会因为"先订阅后重放"重一段。
//
// ③ **`convertEol` 不能开**：那是给"伪终端"用的（子进程吐裸 `\n`）。
//    真 PTY 的输出本来就是 `\r\n`，再开它会把换行转两次。

type XtermModule = typeof import('@xterm/xterm')
type FitModule = typeof import('@xterm/addon-fit')

/** 单例：整个应用只加载一次 xterm（Vite 也会把它切成独立 chunk） */
let xtermPromise: Promise<[XtermModule, FitModule]> | null = null

function loadXterm(): Promise<[XtermModule, FitModule]> {
  if (!xtermPromise) {
    xtermPromise = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  }
  return xtermPromise
}

/**
 * 终端配色 —— **跟着应用主题走**。
 *
 * ⚠️ 为什么不是写死一套墨色（第一版就是写死的，被用户指出来了）：本项目默认是**纸白浅色**，
 *    于是终端成了浅色界面正中嵌着的一块黑板 —— 突兀、且和"水墨"这套体系不搭。
 *    浅色对应：**纸白底 + 墨字 + 朱砂光标**（与 ink 那套是同一套语义，只是纸墨对调）。
 */
const THEME_LIGHT = {
  background: '#fbfaf7',
  foreground: '#2b2b28',
  cursor: '#a8342c',
  cursorAccent: '#fbfaf7',
  selectionBackground: '#dcd7cd'
}

const THEME_INK = {
  background: '#1c1c1a',
  foreground: '#e8e6e3',
  cursor: '#a8342c',
  cursorAccent: '#1c1c1a',
  selectionBackground: '#3a3a36'
}

/** 当前该用哪套：`html[data-theme="ink"]` 才是墨色，其余（含未设置）一律纸白 */
function themeFor(theme: string | undefined): typeof THEME_LIGHT {
  return theme === 'ink' ? THEME_INK : THEME_LIGHT
}

/**
 * 重放协议的状态（跨渲染存活 —— 「重启终端」要在事件回调里改它）。
 *
 * ⚠️ 为什么必须是**对象**而不是几个 `let`：`boot()` 与订阅回调都要读写同一份，
 *    而它们分别活在 effect 与事件里 —— 用对象引用才不会有"各改各的副本"。
 */
interface Proto {
  /** 屏幕当前对应的会话 id（`null` = 还没对齐过） */
  id: string | null
  /** 下一个**该写**的序号（判据：`seq >= nextSeq` 才写） */
  nextSeq: number
  /** 正在取快照 + 重放：这期间到达的帧**只入队**，等重放完按序号补上 */
  replaying: boolean
  pending: TerminalDataPayload[]
  /** 重放代次：并发的 `boot` 里只有最后一次能落地（旧的那次在每个 await 之后自检退出） */
  gen: number
}

/**
 * 写一段输出，并在 xterm **真正解析完**之后回执（背压的关键一环）。
 *
 * `term.write(data, cb)` 的 `cb` 是"这一段已经解析进缓冲了"的时机，
 * 主进程按"未回执字符数"决定 `pause()` / `resume()` —— 没有它，
 * 洪泛输出会把 xterm 的 `_pendingData` 顶到 50MB 然后**抛异常丢数据**。
 */
function writeChunk(term: XTerm, p: TerminalDataPayload): void {
  term.write(p.data, () => {
    void window.api.terminalAck(p.sessionId, p.data.length)
  })
}

/**
 * 把"重放期间排队"的帧按序号补上 —— **只写 `seq >= nextSeq` 的**（重放里已经写过的不重写）。
 *
 * ⚠️ 调用前必须是"关闸状态"，且**函数内不许有 await**：
 * 关闸 → 取队列 → 开闸这条序列要在同一个同步块里走完，否则会漏掉新到的帧。
 */
function flushPending(term: XTerm, proto: Proto): void {
  const rest = proto.pending.splice(0).sort((a, b) => a.seq - b.seq)
  for (const p of rest) {
    if (p.seq < proto.nextSeq) continue
    proto.nextSeq = p.seq + 1
    writeChunk(term, p)
  }
}

export default function TerminalPanel(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<XFitAddon | null>(null)
  /** 重放协议状态（见 `Proto`；「重启终端」要在回调里改它，所以放 ref） */
  const protoRef = useRef<Proto | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  /** 会话快照（状态条用它显示"在跑 / 已结束 / 被停止"、shell、cwd） */
  const [snap, setSnap] = useState<TerminalSessionSnapshot | null>(null)
  /** 起不来的原因（只读档 / 工作区没了 / 原生模块没加载成功）—— 要**明说**，不给个黑框 */
  const [refuse, setRefuse] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 对齐屏幕：**取快照 → 整段重放 → 补上重放期间到达的帧**。
   *
   * 三步缺一不可 —— 这就是"切走再切回不重不漏"的全部内容：
   *   ① 进函数就 `replaying = true`：从这一刻起实时帧**只入队、不落屏**；
   *   ② 快照到手后整段重放（屏幕此刻是空的，要不要 `reset` 由调用方定）；
   *   ③ 关闸（`replaying = false`）后把队列里 `seq >= nextSeq` 的帧按序补上 ——
   *      那正是"落在两次 IPC 往返之间"的帧：**写过的不重、没写的不漏**。
   *
   * ⚠️ 老版本是「先订阅（立刻落屏）→ 再重放全量」，于是那段窗口里的帧被写两遍；
   *    而那段窗口恰好是"后台进程正在吐输出"的时刻 —— 也就是终端最需要正确的时刻。
   *    门禁抓不到它（stub 的 IPC 是同步的，没有那个缝），是**审查**把它翻出来的。
   */
  const boot = useCallback(async (opts?: { reset?: boolean }): Promise<void> => {
    const term = termRef.current
    const proto = protoRef.current
    if (!term || !proto) return
    const gen = ++proto.gen
    if (opts?.reset) term.reset()
    proto.replaying = true
    proto.pending.length = 0
    setBusy(true)
    setRefuse(null)
    try {
      // ① 已有会话就**接着用**（切走再切回是常态）；只有真的没有会话才 start ——
      //    否则"用户点了「停止」、切走再回来"会凭空又起一个 shell，"停止"等于没停。
      let snapNow = await window.api.terminalSnapshot()
      if (!snapNow) {
        const started = await window.api.terminalStart({
          cols: term.cols || 80,
          rows: term.rows || 24
        })
        if (!started.ok) {
          // 只读档 / 工作区没了 / pty 起不来 —— 明说原因，且**不留一个黑框**
          setRefuse(started.message)
          setSnap(null)
          proto.id = null
          proto.nextSeq = 1
          proto.replaying = false
          proto.pending.length = 0
          return
        }
        snapNow = started.session
      }
      if (gen !== proto.gen) return // 期间又有人 boot 了：让后来者重写，别写两遍
      setSnap(snapNow)
      proto.id = snapNow.id
      // ② 整段重放（缓冲本身有上限，不会无限大）
      if (snapNow.truncated) {
        term.write('\x1b[2m（更早的输出已超出缓冲上限，被丢弃了）\x1b[0m\r\n')
      }
      for (const c of snapNow.chunks) term.write(c.data)
      if (gen !== proto.gen) return
      proto.nextSeq = snapNow.nextSeq
      // ③ 关闸。这一步与下面补队列之间**没有 await**，所以不会有帧插进来
      proto.replaying = false
      flushPending(term, proto)
      // ④ 背压**重对齐**：面板卸载时只退订阅、不通知主进程，那期间推来的帧没人回执，
      //    未回执计数可能已经把 pty 按住了。重放完必须把水位清零并恢复 ——
      //    否则用户切回来看到的是"活着但永远静止"的终端。
      void window.api.terminalResync(snapNow.id)
    } finally {
      setBusy(false)
      // ⚠️ **异常路径也必须开闸**：`replaying` 卡在 true 的话，之后所有实时帧
      //    只入队不落屏 —— 屏幕静默、状态栏还写"运行中"，而且队列无界增长。
      //    只在"没有更新的 boot 接手"时开闸（gen 变了说明后来者已经重新关过闸了）。
      if (gen === proto.gen && proto.replaying) {
        proto.replaying = false
        flushPending(term, proto)
      }
    }
  }, [])

  // ── 建 xterm 实例（只建一次）──────────────────────────────
  useEffect(() => {
    let alive = true
    let disposers: Array<() => void> = []

    void (async () => {
      try {
        const [xtermMod, fitMod] = await loadXterm()
        if (!alive || !hostRef.current) return

        const term = new xtermMod.Terminal({
          // ⚠️ 别开 convertEol：真 PTY 的输出本来就是 \r\n（见文件头说明）
          scrollback: 5000,
          fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          // 配色跟着应用主题（见 THEME_LIGHT / THEME_INK 的说明）
          theme: themeFor(document.documentElement.dataset.theme)
        })
        const fit = new fitMod.FitAddon()
        term.loadAddon(fit)
        term.open(hostRef.current)
        termRef.current = term
        fitRef.current = fit
        fit.fit()

        // 键盘 → 主进程。**发原始按键**：真 PTY 下 shell 自己管行编辑/回显/补全，
        // 我们**不做**本地回显（做了就会和 shell 的回显打架、一个字出现两遍）
        term.onData((d) => {
          void window.api.terminalWrite(d).then((r) => {
            // 被拒了要说出来（只读档 / 会话已结束）—— 静默吞掉的话，用户会以为键盘坏了
            if (!r.ok && r.message) setRefuse(r.message)
          })
        })
        // 尺寸变化 → 告诉 pty（不告诉的话 vim/进度条会画错，因为程序以为屏幕还是老的尺寸）
        term.onResize(({ cols, rows }) => {
          void window.api.terminalResize(cols, rows)
        })

        // 主题切换要**当场跟**：用户点了「外观」里的主题，终端不该等到重挂才换色。
        // `data-theme` 是应用侧唯一的主题真源（store 里切换即写根元素），所以观察它即可。
        const themeObserver = new MutationObserver(() => {
          term.options.theme = themeFor(document.documentElement.dataset.theme)
        })
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme']
        })

        // 协议状态（对象引用：`boot` 与下面两个回调读写同一份）
        protoRef.current = { id: null, nextSeq: 1, replaying: true, pending: [], gen: 0 }

        // 增量输出 —— 两条规则，缺一条就会"重"或"漏"：
        //   ① **换了会话**（重启成功 / 切了工作区）：整屏重来，序号跟着新会话从 1 重新对齐；
        //   ② 重放期间只入队；非重放期只写 `seq >= nextSeq` 的帧
        //      （旧帧 = 重放里已经写过，再写一遍就是重复）。
        const offData = window.api.onTerminalData((p) => {
          const proto = protoRef.current
          if (!proto) return
          if (proto.id !== null && p.sessionId !== proto.id) {
            // ⚠️ 这一帧**丢掉不写**是有保证的：新会话的缓冲在主进程那边已经收下了它，
            //    紧接着的 boot 会把快照整段重放 —— 丢它不会漏内容，反而避免写两遍。
            proto.id = p.sessionId
            proto.nextSeq = 1
            void boot({ reset: true })
            return
          }
          if (p.seq < proto.nextSeq) return // 重放里已经写过这一段了
          if (proto.replaying) {
            proto.pending.push(p)
            return
          }
          proto.nextSeq = p.seq + 1
          writeChunk(term, p)
        })
        const offState = window.api.onTerminalState(() => {
          void window.api.terminalSnapshot().then((s) => {
            const proto = protoRef.current
            setSnap(s)
            // 会话换了（「重启终端」成功、或切了工作区）→ 重新对齐 + 整屏重放
            if (proto && proto.id !== null && s && s.id !== proto.id) {
              proto.id = s.id
              void boot({ reset: true })
            }
          })
        })
        disposers = [offData, offState, () => themeObserver.disconnect()]

        setPhase('ready')
        await boot()
        fit.fit()
      } catch (err) {
        if (!alive) return
        setPhase('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      alive = false
      for (const d of disposers) d()
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
      // ⚠️ **不在这里杀会话**：卸载 ≠ 结束 —— 切页签就会卸载，
      //    而用户要的正是"切走再切回来它还在跑"。收会话只发生在：
      //    用户点「停止」、点「重启终端」、或窗口全关（主进程那边统一杀）。
    }
    // ⚠️ 依赖为空：终端实例是**重资产**（DOM + 缓冲 + 监听），重建一次的代价是丢屏上内容。
  }, [boot])

  // 面板宽度可拖拽 → 用 ResizeObserver 跟着 fit（与 Monaco 的 automaticLayout 同一个道理）
  useEffect(() => {
    const host = hostRef.current
    if (!host || phase !== 'ready') return
    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // 面板正被卸载 —— 忽略
      }
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [phase])

  const kill = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.terminalKill()
      const s = await window.api.terminalSnapshot()
      setSnap(s)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 重启终端 = **杀掉旧会话、起一个新的**（用户唯一的自救手段：会话卡住时用）。
   *
   * ⚠️ 老版本这里调的是 `boot()`，而 `boot()` 走的是**幂等**的 `terminalStart` ——
   *    会话还活着时它只会把同一个会话原样还回来：屏幕闪一下、内容不变，
   *    等于一个**死按钮**。而"卡住时自救"这个场景里会话**必然是活着的**。
   */
  const restart = async (): Promise<void> => {
    const proto = protoRef.current
    if (!proto) return
    setBusy(true)
    setRefuse(null)
    // 先关闸：从这一刻起到重放结束，实时帧都只入队（免得新会话的头几帧被写两遍）
    proto.replaying = true
    try {
      const r = await window.api.terminalRestart()
      if (!r.ok) {
        setRefuse(r.message)
        return // 拒绝就到此为止 —— 闸门交给 finally 兜底打开
      }
      // 统一走 `boot()` 重放（不管会话 id 变没变）—— reset / 对齐 / 补队列都由它一处负责。
      // ⚠️ **不在这里手动开闸**：早开闸会让"重放还没开始"的实时帧先落屏，
      //    随后被重放再写一遍（同一段显示两次）。
      await boot({ reset: true })
    } finally {
      setBusy(false)
      const t = termRef.current
      if (t && proto.replaying) {
        // boot 抛异常 / 重启被拒时的兜底开闸（同 `boot` 的 finally）
        proto.replaying = false
        flushPending(t, proto)
      }
    }
  }

  /** 回到工作区：直接往 shell 里敲 `cd`（比"我们代它切目录"诚实 —— 用户看得见这条命令） */
  const cdHome = (): void => {
    const root = snap?.workspaceRoot
    if (!root) return
    void window.api.terminalWrite(`cd "${root}"\r`).then((r) => {
      // 与键盘那条路同口径：被拒要说出来（只读档 / 会话已结束），别让按钮变成"点了没反应"
      if (!r.ok && r.message) setRefuse(r.message)
    })
  }

  if (phase === 'error') {
    return <div className="ex-msg ex-err">终端加载失败：{error}</div>
  }

  const statusText =
    snap === null
      ? '还没有会话'
      : snap.status === 'running'
        ? '运行中'
        : snap.status === 'killed'
          ? '已被停止'
          : `已结束（退出码 ${snap.exitCode ?? '未知'}）`

  return (
    <div className="tm-panel">
      <div className="tm-bar">
        <span className={`tm-status tm-status-${snap?.status ?? 'none'}`}>{statusText}</span>
        <span className="tm-shell" title={`${snap?.shell ?? ''}｜初始目录：${snap?.cwd ?? ''}`}>
          {snap?.shell ?? ''}
        </span>
        <span className="tm-cwd" title="终端当前目录（用「回到工作区」可回去）">
          {snap?.cwd ?? ''}
        </span>
        <button className="ck-btn" disabled={busy || snap?.status !== 'running'} onClick={cdHome}>
          回到工作区
        </button>
        <button className="ck-btn" disabled={busy} onClick={() => void restart()}>
          重启终端
        </button>
        <button
          className="ck-btn ck-btn-danger"
          disabled={busy || snap?.status !== 'running'}
          onClick={() => void kill()}
          title="连整棵进程树一起停掉（终端里的子进程也会被终止）"
        >
          停止
        </button>
      </div>

      {refuse && (
        <div className="df-warn">
          {/* ⚠️ 拒绝原因放进**独立节点**：门禁要能只读它。
              以前它和下面那句常驻说明同处一个 `.df-warn`，门禁取 textContent 时会把
              常驻文案里的"只读"一并算进去 —— 那条断言其实是**假阳性**（审查 D 抓出来的）。 */}
          <span className="tm-refuse">{refuse}</span>
          <br />
          <span className="tm-note">
            权限档在「设置」里改：只读档下终端不执行任何命令（人和模型同一把尺）。
          </span>
        </div>
      )}

      <div className="tm-host-wrap">
        <div ref={hostRef} className="tm-host" />
        {phase === 'loading' && <div className="tm-loading">终端加载中…</div>}
      </div>

      <div className="tm-note">
        真终端（PTY）：补全、Ctrl+C、`vim` 一类全屏程序都能用。终端里改/删的文件
        <strong>不进「文件变更记录」、删的也不进回收站</strong> —— 那是你自己的动作，自己负责。
      </div>
    </div>
  )
}
