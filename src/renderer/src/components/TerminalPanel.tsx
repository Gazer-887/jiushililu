import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon as XFitAddon } from '@xterm/addon-fit'
import type { TerminalDataPayload, TerminalSessionSnapshot } from '@shared/terminal'
import type { ActiveRuntimeSnapshot } from '@shared/dev-env'

// 内置终端面板（plan7 批 C）。三条约束：① **xterm 按需加载**（单例 + `import()`，别让它进主 chunk —— 那是每次启动都要付的代价）；
// ② **视图可丢弃，会话不可**：本项目"切页签 = 卸载"是定死的语义（plan9 §W3），故 shell 与输出缓冲在主进程，重挂时先 `terminalSnapshot()` **按序号重放**再续接增量（只收 `seq >= nextSeq` 的帧）。
// ③ **`convertEol` 不能开**：那是给伪终端用的（子进程吐裸 `\n`），真 PTY 本来就是 `\r\n`，再转会转两次。

type XtermModule = typeof import('@xterm/xterm')
type FitModule = typeof import('@xterm/addon-fit')

let xtermPromise: Promise<[XtermModule, FitModule]> | null = null

function loadXterm(): Promise<[XtermModule, FitModule]> {
  if (!xtermPromise) {
    xtermPromise = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  }
  return xtermPromise
}

/** 终端配色 —— **跟着应用主题走**（2026-09-14 用户重新定调，六主题规则）：
 *  · **夜梦（yemeng）→ 黑色终端**（深底浅字，六主题里唯一暗色终端）
 *  · **其余五套 → 纯白终端**：白底（#ffffff）+ 深字 —— 用户强调是**纯白**，
 *    不是旧版那种"名为浅色实为黑底白盖"的配色
 *  ⚠️ 光标沿用朱砂（#a8342c）点睛（纯白上朱砂对比足够；夜梦沿旧黑底的朱砂光标）。
 *  ⚠️ 别把这里改成"跟随系统深浅色"：终端配色跟的是**应用主题**，两者是两个独立的选择。 */
const THEME_DARK = {
  background: '#1c1c1a',
  foreground: '#e8e6e3',
  cursor: '#a8342c',
  cursorAccent: '#1c1c1a',
  selectionBackground: '#3a3a36'
}

const THEME_PURE_WHITE = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#a8342c',
  cursorAccent: '#ffffff',
  selectionBackground: '#cfe0f5'
}

/** 主题 → 终端配色映射（用户规则：夜梦黑终端，其余全纯白）；未知主题回纯白（多数派安全侧） */
const TERMINAL_THEMES: Record<string, typeof THEME_DARK> = {
  qingkong: THEME_PURE_WHITE,
  xinzh: THEME_PURE_WHITE,
  taohua: THEME_PURE_WHITE,
  yemeng: THEME_DARK,
  chunhe: THEME_PURE_WHITE,
  jiguang: THEME_PURE_WHITE
}

function themeFor(theme: string | undefined): typeof THEME_DARK {
  return (theme && TERMINAL_THEMES[theme]) || THEME_PURE_WHITE
}

/** 重放协议状态（跨渲染存活 —— 「重启终端」要在事件回调里改它）。⚠️ 必须是**对象**而不是几个 `let`：`boot()` 活在 effect 里、订阅回调活在事件里，用对象引用才不会有"各改各的副本"。 */
interface Proto {
  id: string | null
  /** 下一个**该写**的序号（判据：`seq >= nextSeq` 才写） */
  nextSeq: number
  /** 正在取快照 + 重放：这期间到达的帧**只入队**，等重放完按序号补上 */
  replaying: boolean
  pending: TerminalDataPayload[]
  /** 重放代次：并发的 `boot` 里只有最后一次能落地（旧的那次在每个 await 之后自检退出） */
  gen: number
}

/** 写一段输出，并在 xterm **真正解析完**之后回执（背压的关键一环）：主进程按"未回执字符数"决定 `pause()` / `resume()` —— 没有回执，洪泛输出会把 xterm 的待解析缓冲顶爆，然后抛异常丢数据。 */
function writeChunk(term: XTerm, p: TerminalDataPayload): void {
  term.write(p.data, () => {
    void window.api.terminalAck(p.sessionId, p.data.length)
  })
}

/** 把"重放期间排队"的帧按序号补上 —— **只写 `seq >= nextSeq` 的**（重放里已写过的不重写）。
 *  ⚠️ 调用前必须已关闸，且**函数内不许有 await**：关闸 → 取队列 → 开闸要在同一个同步块里走完，否则新到的帧会从缝里漏掉。 */
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
  const protoRef = useRef<Proto | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [snap, setSnap] = useState<TerminalSessionSnapshot | null>(null)
  /** 起不来的原因（只读档 / 工作区没了 / 原生模块没加载成功）—— 要**明说**，不给个黑框 */
  const [refuse, setRefuse] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** E5 开关的当前真值（null = 还没读到 / 读取失败）。状态栏就地开关要按它决定往哪边翻 */
  const [profileOn, setProfileOn] = useState<boolean | null>(null)
  /** plan43 S3：当前**生效**的运行环境（事实，不是设置页里的意向）。null = 还没读到 */
  const [active, setActive] = useState<ActiveRuntimeSnapshot | null>(null)

  // 每次换会话都重读一次：值住在主进程，设置窗口也可能改它，本地不缓存成"一份真相"
  useEffect(() => {
    let alive = true
    window.api
      .getTerminalProfile()
      .then((v) => alive && setProfileOn(v))
      .catch(() => alive && setProfileOn(null))
    // plan43 S3：与 profile 同一口径 —— 每次换会话重读，因为**环境在起壳时定死**（活会话不换）
    window.api
      .getActiveRuntimes()
      .then((v) => alive && setActive(v))
      .catch(() => alive && setActive(null))
    return () => {
      alive = false
    }
  }, [snap?.id])

/** 对齐屏幕：**取快照 → 整段重放 → 补上重放期间到达的帧**，三步缺一不可 —— ① 进函数就 `replaying = true`（实时帧从此只入队、不落屏）；② 快照到手整段重放；③ 关闸后把队列里 `seq >= nextSeq` 的帧按序补上（那正是"落在两次 IPC 往返之间"的帧：写过的不重、没写的不漏）。
 *  ⚠️ 不许写成"先订阅（立刻落屏）→ 再重放全量"：那段窗口里的帧会被写两遍，而它恰好是"后台进程正在吐输出"的时刻 —— 也就是终端最需要正确的时刻。 */
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
      // 已有会话就**接着用**（切走再切回是常态），只有真没有才 start —— 否则「用户点了停止、切走再回来」会凭空又起一个 shell，停止等于没停。
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
      if (snapNow.truncated) {
        term.write('\x1b[2m（更早的输出已超出缓冲上限，已丢弃）\x1b[0m\r\n')
      }
      for (const c of snapNow.chunks) term.write(c.data)
      if (gen !== proto.gen) return
      proto.nextSeq = snapNow.nextSeq
      // ③ 关闸。这一步与下面补队列之间**没有 await**，所以不会有帧插进来
      proto.replaying = false
      flushPending(term, proto)
      // ④ 背压**重对齐**：卸载只退订阅、不通知主进程，那期间推来的帧没人回执，未回执计数可能已把 pty 按住 —— 重放完必须清零水位并恢复，否则用户切回来看到的是"活着但永远静止"的终端。
      void window.api.terminalResync(snapNow.id)
    } finally {
      setBusy(false)
      // ⚠️ **异常路径也必须开闸**：`replaying` 卡在 true，之后所有实时帧只入队不落屏 ——
      //    屏幕静默、状态栏还写"运行中"，而且队列无界增长。只在"没有更新的 boot 接手"时开闸。
      if (gen === proto.gen && proto.replaying) {
        proto.replaying = false
        flushPending(term, proto)
      }
    }
  }, [])

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
          theme: themeFor(document.documentElement.dataset.theme)
        })
        const fit = new fitMod.FitAddon()
        term.loadAddon(fit)
        term.open(hostRef.current)
        termRef.current = term
        fitRef.current = fit
        fit.fit()

        // 键盘 → 主进程。**发原始按键**：真 PTY 下 shell 自己管行编辑/回显/补全，我们**不做**本地回显（做了会和 shell 的回显打架、一个字出现两遍）。
        term.onData((d) => {
          void window.api.terminalWrite(d).then((r) => {
            // 被拒了要说出来（只读档 / 会话已结束）—— 静默吞掉的话，用户会以为键盘坏了
            if (!r.ok && r.message) setRefuse(r.message)
          })
        })
        term.onResize(({ cols, rows }) => {
          void window.api.terminalResize(cols, rows)
        })

          // 主题切换要**当场跟**：用户点了「外观」里的主题，终端不该等到重挂才换色（`data-theme` 是唯一真源）
        const themeObserver = new MutationObserver(() => {
          term.options.theme = themeFor(document.documentElement.dataset.theme)
        })
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme']
        })

        protoRef.current = { id: null, nextSeq: 1, replaying: true, pending: [], gen: 0 }

        // 增量输出 —— 两条规则，缺一条就会"重"或"漏"：① **换了会话**（重启成功 / 切了工作区）整屏重来、序号从 1 重新对齐；② 重放期间只入队，非重放期只写 `seq >= nextSeq` 的帧。
        const offData = window.api.onTerminalData((p) => {
          const proto = protoRef.current
          if (!proto) return
          if (proto.id !== null && p.sessionId !== proto.id) {
            // ⚠️ 这一帧**丢掉不写**是有保证的：新会话的缓冲在主进程那边已经收下了它，紧接着的 boot 会整段重放 —— 丢它不漏内容，反而避免写两遍。
            proto.id = p.sessionId
            proto.nextSeq = 1
            void boot({ reset: true })
            return
          }
          if (p.seq < proto.nextSeq) return
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
            if (proto && proto.id !== null && s && s.id !== proto.id) {
              proto.id = s.id
              void boot({ reset: true })
            }
          })
        })
        // plan40 S3：权限档变更（如降到只读）必须即时反映到界面 —— 重取快照并重 boot，
        // 让拒绝横幅按新的 terminal:start 返回说话；不许出现"横幅写只读、屏上还在跑"（主进程 killAll 之后界面是最后一环）
        const offPerm = window.api.onSettingsChanged((kind) => {
          if (kind !== 'permission') return
          void window.api.terminalSnapshot().then((s) => setSnap(s))
          void boot({ reset: true })
        })
        // plan43 S3d：换了运行时 → 状态栏那行「当前生效」立刻跟着走。
        // ⚠️ **不重启终端、不重 boot** —— 与 VS Code 同语义：改解释器不影响已打开的终端
        //   （官方文档：`Changing it does not affect already-open terminal panels`），
        //   新开的终端自然用新环境。这里只刷新"查看到的那个事实"。
        const offDevEnv = window.api.onSettingsChanged((kind) => {
          if (kind !== 'devEnv') return
          void window.api.getActiveRuntimes().then((v) => setActive(v)).catch(() => setActive(null))
        })
        disposers = [offData, offState, offPerm, offDevEnv, () => themeObserver.disconnect()]

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
      // ⚠️ **不在这里杀会话**：卸载 ≠ 结束 —— 切页签就会卸载，而用户要的正是"切走再切回来它还在跑"（收会话只发生在：点「停止」、点「重启终端」、窗口全关）。
    }
    // ⚠️ 依赖为空：终端实例是**重资产**（DOM + 缓冲 + 监听），重建一次的代价是丢屏上内容。
  }, [boot])

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

  /** 重启终端 = **杀掉旧会话、起一个新的**（会话卡住时用户唯一的自救手段）。
   *  ⚠️ 不许改成调 `boot()`：它走的是**幂等**的 `terminalStart`，会话还活着时只会把同一个会话原样还回来 —— 而"卡住时自救"的场景里会话**必然是活着的**，那就等于一个死按钮。 */
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
      // 统一走 `boot()` 重放（reset / 对齐 / 补队列都由它一处负责）。⚠️ **不在这里手动开闸**：早开闸会让"重放还没开始"的实时帧先落屏，随后被重放再写一遍。
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
      if (!r.ok && r.message) setRefuse(r.message)
    })
  }

  if (phase === 'error') {
    return <div className="ex-msg ex-err">终端加载失败：{error}</div>
  }

  /**
   * E5 就地开关：状态栏那行 shell 名点一下就切 profile 并重启终端。
   *
   * 为什么做在这里而不是只留设置页：09-19 实测连项目作者都找不到设置页里那个开关
   * （CHANGELOG 还把它写成了不存在的「系统」区）。**把状态写在终端上却不给动作**，
   * 等于让人看见问题、找不到答案 —— 提示与入口必须在同一个位置。
   *
   * ⚠️ 切换前**重新读一次真值**再取反，不用闭包里的 `profileOn`：设置窗口里可能已经改过了，
   *    两个窗口共用主进程那一份，拿旧值取反会把用户刚设的状态又翻回去。
   */
  const toggleProfile = async (): Promise<void> => {
    setBusy(true)
    try {
      const cur = await window.api.getTerminalProfile()
      setProfileOn(await window.api.setTerminalProfile(!cur))
      await restart()
    } finally {
      setBusy(false)
    }
  }

  /** profile 是 PowerShell 独有的概念：bash 走 `-l`（登录 shell），不给它挂这个开关 */
  const isPwsh = (snap?.shell ?? '').includes('PowerShell')

  /**
   * plan43 S3d：终端状态栏的「运行环境」行。
   *
   * 为什么终端这里要显示：**终端会话只在"新起"时读环境**（与 VS Code 同口径 ——
   * 已开的终端不换壳，正在跑的东西不该被抽凳子）。所以用户改了设置之后，
   * 唯一能判断"这个终端到底用的哪个环境"的办法就是**在终端上如实显示它起壳时用的值**。
   * 不显示 = 用户只能靠猜，等于功能没做（0.13.71 的教训）。
   */
  const envLabel = active?.active.length
    ? active.active.map((a) => a.display).join(' ＋ ')
    : active?.failed.length
      ? '所选运行时已失效'
      : ''

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
        {isPwsh ? (
          <button
            type="button"
            className="tm-shell tm-shell-btn"
            disabled={busy || profileOn === null}
            onClick={() => void toggleProfile()}
            title={
              profileOn
                ? '已加载 profile｜点击停用并重启终端'
                : '点击加载 PowerShell profile 并重启终端｜profile 中的别名与环境初始化随之生效，也可能引入延迟或报错'
            }
          >
            {snap?.shell ?? ''}
          </button>
        ) : (
          <span className="tm-shell" title={`${snap?.shell ?? ''}｜初始目录：${snap?.cwd ?? ''}`}>
            {snap?.shell ?? ''}
          </span>
        )}
        <span className="tm-cwd" title="终端当前目录">
          {snap?.cwd ?? ''}
        </span>
        {envLabel.length > 0 && (
          <span
            className={`tm-env${active?.failed.length ? ' tm-env-bad' : ''}`}
            title={
              active?.failed.length
                ? `所选运行时已失效：${active.failed.map((f) => `${f.label} ${f.selected}——${f.reason}`).join('；')}。请在设置页的开发环境里重新选择。`
                : `本终端起壳时用的运行环境：${active?.active.map((a) => `${a.label} → ${a.selected}`).join('；')}。\n改设置后「新开的终端」才跟随（已开的终端不换壳）。`
            }
          >
            {envLabel}
          </span>
        )}
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
          title="连同整棵进程树一起停止"
        >
          停止
        </button>
      </div>

      {refuse && (
        <div className="df-warn">
          {/* ⚠️ 拒绝原因放进**独立节点**：门禁要能只读它 —— 以前它和常驻说明同处一个 `.df-warn`，门禁取 textContent 会把常驻文案里的"只读"一并算进去、断言假阳性。 */}
          <span className="tm-refuse">{refuse}</span>
          <br />
          <span className="tm-note">
            权限档可在「设置」中修改：只读档下终端不执行任何命令。
          </span>
        </div>
      )}

      <div className="tm-host-wrap">
        <div ref={hostRef} className="tm-host" />
        {phase === 'loading' && <div className="tm-loading">终端加载中…</div>}
      </div>

      <div className="tm-note">
        终端内修改或删除的文件
        <strong>不计入「文件变更记录」，删除的也不进回收站</strong>，该操作由用户自行负责。
      </div>
    </div>
  )
}
