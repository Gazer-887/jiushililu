/**
 * **工具输出窗口化的校准 harness**（plan8 R9.1）。
 *
 * ## 为什么要有它
 *
 * 8k / 12k / 0.72 这三个数是**保守起点，不是校准结果** —— 业界调研明确说
 * "查不到公开的保留比例实验"。所以只能自己量：**同一段任务，开/关窗口化各跑一遍**，
 * 比 ① 厂商真报的 token ② 答得对不对。没有这个 harness，"省了多少"就只能靠信仰。
 *
 * ## 怎么跑
 *
 * ```bash
 * npm run build                                              # 先构建（harness 驱动的是构建产物）
 * node scripts/bench-tool-window.cjs --tasks=2 --arms=both --repeat=3   # 12 次真实调用（2 任务 × 2 臂 × 3 次）
 * ```
 *
 * - `--tasks=1|2`  跑几个任务（默认 2）
 * - `--arms=both|on|off`  跑哪几臂（默认 both）
 * - `--repeat=N`  每臂重复几次（**默认 1；要下结论必须 ≥3**，取中位数）
 * - `--probe`  只跑**一句最小任务**，把厂商原始 usage 形状从日志里捞出来（plan8 R9.1 §七① 的核对手段）
 * - `--keep`  保留夹具（默认跑完删掉）
 *
 * ## 结论状态（**读数字之前先看这里**）
 *
 * - **2026-09-12 首轮（旧夹具：命令输出 700 行 ≈ 3k token）→ 结论是"还没量出结论"**：
 *   同一个「关」臂两轮差 **3.3 倍** —— **对照组自身的方差大于要测的效应**（n=1 的 A/B 不是 A/B）；
 *   而且夹具**太小**（一轮就塞得下），窗口化根本没有用武之地。
 * - **2026-09-13 改版**（按上面那两条教训改的）：
 *   ① 夹具换成**塞不下**型（`HUGE_LINES` = 15000 行 ≈ 7 万 token）；
 *   ② 去掉与命令输出**重复**的 `noisy.log`（它会把模型引去再读一遍文件，污染对比）；
 *   ③ `--repeat` 默认 1、**下结论要 ≥3**，取中位数并把原始值一起打印；
 *   ④ 报告带**工具调用次数** —— 解释 token 差异的分母是"轮数 × 上下文规模"，不是单轮文本大小。
 *   **结论见 `PLAN/plan8` 的 §七⑤ 与 `bench/tool-window-*.json`。**
 *
 * ### 2026-09-13 第一轮改版后实测（3 次/臂取中位数）
 *
 * | 任务 | 开 | 关 | 差 |
 * |---|---:|---:|---:|
 * | **命令输出找结论**（15000 行 ≈ 7 万 token） | **27,932** | **486,619** | **−94%** |
 * | 大文件找针（`read_file`，走工具自带窗口） | 31,420 | 8,240 | +281%（**全是模型方差**，见下） |
 *
 * - 第一行是**决定性**结论：大输出下不压根本跑不动（关臂单次已在 40–50 万 token 量级）。
 * - 第二行**不可用于比较**：`read_file` 在 `SELF_MANAGED_TOOLS` 里，主循环窗口化不参与
 *   （"省 = 0"就是证据）→ 两臂差别纯属模型行为方差（`[32048, 8230, 31420]`，差 3.8 倍）。
 *   它留着是为了当"**关臂也不该崩**"的对照组。
 *
 * ### 2026-09-13 第二轮：**按档位跑**（`--arms=tier:light,tier:balanced,tier:ultimate`）
 *
 * | 任务 | 轻量 4k/0.5 | 平衡 8k/0.72 | 极致 16k/0.85 |
 * |---|---:|---:|---:|
 * | `tail-command`（≈7 万 token 输出） | 40,355 | 55,034 | 59,257 |
 * | `mid-command`（≈2.5 万 token 输出） | 12,585 | 59,634 | 21,120 |
 *
 * **三档调不出可测差别**：顺序在两行之间都不一致，而每臂的内部跨度远大于档间差
 * （极致档 `mid` 三次为 `12811 / 165665 / 21120`，13 倍）。
 * → **8k / 12k / 0.72 保持现状**（它们落在"调了也测不出"的区间里）。
 *
 * 另跑一组 `tier:rich` vs `tier:balanced`（`mid-command`）：**212,991 vs 75,235（−65%）**
 * → **「够小就别压」在 19% 窗口这个量级不成立** —— 该压。
 *
 * ## ★ 这套 harness 量出来的最重要的一件事
 *
 * **token 的主导变量是"工具调用次数"，不是压缩档位。**
 * 把两轮共 30 次运行放一起：调用 **3~4 次**的落在 **1~2 万** token，
 * 调用 **13~28 次**的落在 **4.5~16.5 万** —— **差 13 倍**。
 * 档位带来的几千 token 差异在这个量级面前是**零头**。
 * → **下一步该做的是"别让模型多跑几轮"，不是继续调 8k / 12k / 0.72。**
 *
 * ## 两条铁律（写在这里免得后人踩）
 *
 * 1. **绝不打印凭据**。模型端点/密钥沿用用户**已配置**的那份；本脚本只报告"密钥在不在"这种布尔事实。
 * 2. **每臂一个独立进程**。窗口化开关在进程的环境变量上（`JSL_TOOL_WINDOW`），
 *    同一个进程里切臂会互相污染（缓存/会话/模型侧状态），所以**一次启动只跑一臂**。
 *
 * ## ⚠️ 为什么必须用**用户真实的 userData**（2026-09-12 实测定论）
 *
 * 第一版 harness 把 `settings.json` / `models.json` **拷贝**到临时 userData 再启动 —— 结果拿到了
 * 厂商的 **401**。查下来根因不是"钥匙不对"，而是**保险箱不跟人走**：
 *
 * - `safeStorage`（Windows 上走 DPAPI 的 app-bound encryption）把密钥**绑在"应用身份 + userData 路径"**上；
 * - 实测：同一个 Electron 进程，读**真实** userData 里那两个档案 → 解密 `ok: true`；
 *   读**拷贝**出来的同一份密文 → `throw: Error while decrypting the ciphertext`。
 * - 于是一条链全对（真机 → 真 IPC → 真厂商 HTTP），只有最后一步 401 ——
 *   **密文搬了家就解不开，密钥为空，请求等于没带钥匙。**
 *
 * 所以现在的做法是：**用真实 userData 启动，什么都不搬**；夹具写进**已被授权的工作区**里的一个
 * `.jsl-bench/` 子目录（跑完删），每轮建的会话**当场用 `deleteConversation` 删掉**。
 * 这也是本项目的一条通用教训：**"加密落盘的钥匙"永远不能靠复制文件来迁移。**
 */
const { spawn } = require('node:child_process')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = process.cwd()
const ARG = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const TASKS = Number(ARG('tasks', '2'))
/**
 * 臂名（逗号分隔）：`on` / `off` / `tier:light` / `tier:balanced` / `tier:ultimate` / `tier:rich`
 *
 * - `both` = `on,off`（旧的窗口化开关对照）
 * - `tier:xxx` = **按档位跑**（§七⑤ 的正题）：档位本身就是 8k/12k/0.72 的一组取值，
 *   所以"该不该调"最直接的证据就是**换档比一遍**。
 */
const ARMS = (() => {
  const raw = String(ARG('arms', 'both'))
  if (raw === 'both') return ['on', 'off']
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
})()
const KEEP = process.argv.includes('--keep')
const PROBE = process.argv.includes('--probe')
/**
 * 每臂重复几次（**默认 1；要下结论必须 ≥3**）。
 *
 * 为什么非重复不可：这套 harness 的第一次实测里，同一个「关」臂两轮差了 **3.3 倍** ——
 * **对照组自身的方差大于要测的效应**，于是"开 vs 关谁更省"根本没法下结论
 * （n=1 的 A/B 不是 A/B，是两次孤例）。
 * 现在取**中位数**，并且把每次的原始值一起打印 —— 方差本身就是结论的一部分。
 */
const REPEAT = Math.max(1, Number(ARG('repeat', '1')))
/** `--only=tail-in-command,mid-command`：只跑指定的任务（按 id）—— 免得为了两条任务把全部跑一遍 */
const ONLY = String(ARG('only', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const BENCH = join(ROOT, '.bench-tool-window')
const USER_UD = join(process.env.APPDATA || '', 'jiushililu')

/** 真实工作区（夹具住进它下面的 `.jsl-bench/`，跑完删 —— 不去动用户其它文件） */
function realWorkspace() {
  try {
    const w = JSON.parse(readFileSync(join(USER_UD, 'workspace.json'), 'utf8'))
    if (w && typeof w.workspaceRoot === 'string' && w.workspaceRoot) return w.workspaceRoot
  } catch {
    /* 没配就用默认内置工作区 */
  }
  return join(USER_UD, 'agent-workspace')
}
const WS = realWorkspace()
/**
 * 夹具文件名带统一前缀（`jsl-bench-`），跑完全部删掉。
 *
 * 为什么不放进子目录：`conv:create` 要求会话工作区**正好等于当前工作区**或历史授权过的目录，
 * 子目录不在其中（第一版就是把夹具放进 `.jsl-bench/` 子目录 → "工作区未被授权"）。
 * 用带前缀的固定文件名，既不撞用户已有的文件，也好精确删回去。
 */
/**
 * 夹具文件（跑完全部删掉）。
 *
 * ⚠️ **2026-09-13 改版**：上一版夹具**太小了**（命令输出 700 行 ≈ 3k token）——
 * "一轮就塞得下"，窗口化压它省不了多少，于是**量不出开/关的差别**
 * （当时的结论老实写着"没量出结论"）。
 * 现在的取向是**塞不下**：命令输出拉到下面那个 `HUGE_LINES`（约 300KB / 约 7 万估算 token）——
 * 大到"不压就吃掉大半个上下文窗口"，才轮到窗口化证明自己。
 */
const FIXTURE_FILES = ['jsl-bench-big-report.md', 'jsl-bench-check.js', 'jsl-bench-mid.js']

/**
 * 命令输出的行数 —— **这套校准的主变量**。
 *
 * 为什么取 15000：一行约 20 字节 → 约 300KB → 估算 **约 7 万 token**。
 * 这个量级的用意是让它**塞得进、但代价明显**（用户的 contextWindow 默认 131072）——
 * 于是"开 / 关"两臂都能跑完，差别体现在真值 token 上，而不是"关臂直接超窗失败"。
 */
const HUGE_LINES = 15000

/**
 * **中等**输出的行数 —— 「够小就别压」那条候选设计（§七⑤ 第二问）的验区。
 *
 * 5000 行 ≈ 100KB ≈ 2.5 万估算 token：**远大于** `minBytes`（平衡档 1400 字节，一定会压），
 * 但只占 131072 窗口的**约 19%** —— 所以"整段 ≤ 窗口某比例就原样放行"那条设计会**放过**它。
 * 两边的差别恰好落在这个区间，别处测不到。
 */
const MID_LINES = 5000

const FIXTURES = () => {
  mkdirSync(WS, { recursive: true })
  // ① 大文件：针在第 380 行 —— 考"按窗口读 + 能续读"
  //    （`read_file` 自带行窗口与绝对预算，所以这条**不依赖**主循环的窗口化，
  //     它是"关臂也不该崩"的对照组）
  const big = []
  for (let i = 1; i <= 600; i++) {
    big.push(i === 380 ? '审计编号：JSL-7742' : `第 ${i} 行：这是用来撑大文件体积的普通内容，不含关键信息。`)
  }
  writeFileSync(join(WS, 'jsl-bench-big-report.md'), big.join('\n'), 'utf8')

  // ② 命令输出：**结论在末尾**（旧代码 `slice(0,8000)` 恰好会切掉的那半截）
  //    ⚠️ 上一版还额外写了一份 `jsl-bench-noisy.log`，内容与命令输出**重复** ——
  //    那会把模型引去"再读一遍文件"，于是省下来的 token 不一定是窗口化的功劳（污染对比）。
  //    现在**只留一条路径**：让模型跑那条命令。
  const lines = []
  for (let i = 0; i < HUGE_LINES; i++) lines.push(`[info] 处理第 ${i} 个条目，一切正常`)
  lines.push('[info] 开始跑检查用例')
  lines.push('✕ 3) 端口占用检查')
  lines.push('   Expected 3000, received 8080')
  lines.push('exit code 1')
  writeFileSync(join(WS, 'jsl-bench-check.js'), `console.log(${JSON.stringify(lines.join('\n'))})\n`, 'utf8')

  // ③ **中等输出**：考"够小就别压"（§七⑤ 第二问）—— 远大于 minBytes（一定会压），
  //    但只占窗口约 19%（"≤窗口某比例就放行"那条设计会放过它）。结论一样埋在末尾。
  const mid = []
  for (let i = 0; i < MID_LINES; i++) mid.push(`[info] 检查第 ${i} 项，一切正常`)
  mid.push('[info] 汇总：共检查完毕')
  mid.push('✕ 7) 校验和比对')
  mid.push('   Expected c0ffee, received deadbeef')
  mid.push('exit code 1')
  writeFileSync(join(WS, 'jsl-bench-mid.js'), `console.log(${JSON.stringify(mid.join('\n'))})\n`, 'utf8')
}

/**
 * `--probe` 用的**最小任务**：不调工具、只求一轮模型调用。
 *
 * 为什么单独一个：要核对的是**厂商报了什么字段**，那只需要一条真实响应。
 * 用校准任务（读大文件/跑命令）去拿，等于为了看一个字段多烧几万 token。
 */
const PROBE_TASK = {
  id: 'usage-probe',
  prompt: '只回答两个字：收到',
  needle: '收到',
  why: '最小任务：只为拿一条厂商原始 usage'
}

const TASKSET = [
  {
    id: 'needle-in-file',
    prompt: '读工作区里的 jsl-bench-big-report.md，把里面的「审计编号」原样告诉我。只回答编号，不要解释。',
    needle: 'JSL-7742',
    why: '考"大文件里的一条信息"——窗口化之后必须还能按行取回'
  },
  {
    id: 'tail-in-command',
    prompt: '在工作区里执行 `node jsl-bench-check.js`，然后告诉我：哪个用例失败了、期望值是多少、实际值是多少。简短回答。',
    needle: '8080',
    why: '考"结论在末尾"——旧代码只留前 8000 字符，这半截会被切掉'
  },
  {
    id: 'mid-command',
    prompt: '在工作区里执行 `node jsl-bench-mid.js`，然后告诉我：哪个用例失败了、期望值是多少、实际值是多少。简短回答。',
    needle: 'deadbeef',
    why: '考"够小就别压"（§七⑤ 第二问）—— 输出约 100KB / 2.5 万 token：远大于 minBytes（一定会压），但只占窗口约 19%'
  }
]

/**
 * 检查真机配置**在不在**（只读、只报布尔）。
 *
 * ⚠️ 这里**不再搬任何文件**：密文搬了家就解不开（见文件头那段实测）。
 * 所以只在原地检查，缺什么就明说缺什么。
 */
function checkUserData() {
  const settingsPath = join(USER_UD, 'settings.json')
  const modelsPath = join(USER_UD, 'models.json')
  const has = (p) => existsSync(p)
  let vault = 0
  let active = null
  let host = null
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
    vault = Object.keys((s && s.apiKeysEncrypted) || {}).length
  } catch {
    /* 读不到就是没有 */
  }
  try {
    const m = JSON.parse(readFileSync(modelsPath, 'utf8'))
    active = m && m.activeId ? m.activeId : null
    const p = (m.profiles || []).find((x) => x.id === active)
    if (p && typeof p.baseURL === 'string') host = new URL(p.baseURL).host
  } catch {
    /* 同上 */
  }
  console.log(
    `[cfg] userData=${USER_UD}\n      密钥档案：${vault} 个；当前档案=${active ?? '未知'}；端点主机=${host ?? '未知'}`
  )
  return has(settingsPath) && has(modelsPath) && vault > 0 && Boolean(host)
}

/** 等 CDP 端点起来，拿到**渲染页**的 ws 地址 */
async function waitForPage(port, timeoutMs = 45000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      // ⚠️ 必须挑 `file://` 那个页面：Electron 启动时 `/json/list` 里**先出现一个 about:blank**，
      //    直接取第一个 page 会连到空白页上 —— 那里 `window.api` 当然是 undefined
      //    （第一版就是这么错的，症状是"每个任务都在 2 秒内报 getSettings 不是函数"）。
      const page = list.find((t) => t.type === 'page' && String(t.url).startsWith('file://'))
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('等不到应用渲染页（应用没起来？）')
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** 极简 CDP 客户端：只做一件事 —— 在渲染页里求值一个异步表达式 */
function cdpEval(wsUrl, expression, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error('求值超时'))
    }, timeoutMs)
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    }
    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id !== 1) return
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (msg.result?.exceptionDetails) {
        reject(new Error(`页面里抛错：${msg.result.exceptionDetails.text || ''}`))
        return
      }
      resolve(msg.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    }
  })
}

/** 在真机里跑一次任务，返回答案与用量 */
function pageScript(prompt, workspace) {
  return `(async () => {
    const api = window.api
    const out = { ok: false, text: '', usage: null, avoided: 0, tools: [], error: null }
    try {
      const settings = await api.getSettings()
      try { await api.setKnownWorkspace(${JSON.stringify(workspace)}) } catch (e) { /* 老版本没有就当没有 */ }
      const conv = await api.createConversation({
        workspace: ${JSON.stringify(workspace)},
        model: settings && settings.model ? settings.model : 'bench',
        skills: []
      })
      const id = conv.id
      let text = ''
      const tools = []
      const offChunk = api.onChatChunk((e) => { if (e.conversationId === id) text += e.payload })
      const offTool = api.onChatTool((e) => { if (e.conversationId === id) tools.push({ name: e.payload.name, phase: e.payload.phase, saved: e.payload.savedTokens || 0 }) })
      const doneP = new Promise((res) => {
        const off = api.onChatDone((e) => { if (e.conversationId === id) { out.usage = e.payload.usage; out.avoided = e.payload.avoided || 0; off(); res() } })
      })
      const errP = new Promise((res) => {
        const off = api.onChatError((e) => { if (e.conversationId === id) { out.error = e.payload; off(); res() } })
      })
      await api.chatSend({ conversationId: id, messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }] })
      await Promise.race([doneP, errP, new Promise((r) => setTimeout(r, 200000))])
      offChunk(); offTool()
      out.text = text
      out.tools = tools
      out.ok = true
      // 用过就删（不往主人的会话列表里留垃圾）：删掉才是"没动过人家的数据"
      try { await api.deleteConversation(id); out.cleaned = true } catch (e) { out.cleaned = false }
    } catch (err) {
      out.error = err && err.message ? err.message : String(err)
    }
    return JSON.stringify(out)
  })()`
}

async function runArm(task, arm, port) {
  /**
   * 臂名 → 环境变量。
   *
   * - `on` / `off`：窗口化开关（`JSL_TOOL_WINDOW`，旧的校准钩子）
   * - `tier:light` / `tier:balanced` / `tier:ultimate` / `tier:rich`：**按档位跑**（§七⑤ 的正题）
   *   —— 档位本身就是 8k/12k/0.72 的一组取值，所以"该不该调"最直接的证据是**换档比一遍**。
   *   ⚠️ tier 臂下 `JSL_TOOL_WINDOW` 保持 `on`：`off` 会**压过**档位（那是校准用的强关），
   *   而这里要测的正是档位自己的 `windowEnabled`。
   */
  const tier = arm.startsWith('tier:') ? arm.slice('tier:'.length) : null
  const env = {
    ...process.env,
    ...(tier ? { JSL_TOKEN_TIER: tier } : {}),
    JSL_TOOL_WINDOW: arm === 'off' ? 'off' : 'on'
  }
  const bin = require('electron') // 在**纯 Node** 里，require('electron') 返回可执行文件路径
  // ⚠️ **用真实 userData**（不传 --user-data-dir）—— 密文搬家解不开，见文件头实测
  const child = spawn(bin, ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  const t0 = Date.now()
  try {
    const ws = await waitForPage(port)
    await new Promise((r) => setTimeout(r, 1200)) // 等渲染页把 API 挂好
    const raw = await cdpEval(ws, pageScript(task.prompt, WS))
    const res = JSON.parse(String(raw))
    const secs = Math.round((Date.now() - t0) / 1000)
    const hit = res.text.includes(task.needle)
    const total = res.usage ? res.usage.promptTokens + res.usage.completionTokens : null
    /**
     * 工具调用次数（plan8 R9.1 §七⑤）—— 报告里**必须带它**。
     * 因为解释 token 差异的钥匙是**分母**："轮数 × 上下文规模"，
     * 而不是单轮文本的大小（上一轮实测正是被"多出来的回合"主导的）。
     */
    const toolCalls = Array.isArray(res.tools) ? res.tools.filter((t) => t.phase === 'start').length : null
    return { task: task.id, arm, seconds: secs, hit, usage: res.usage, total, avoided: res.avoided, error: res.error, text: res.text.slice(0, 400), toolCalls, tools: res.tools, cleaned: res.cleaned }
  } catch (err) {
    return { task: task.id, arm, error: err.message || String(err), hit: false, total: null }
  } finally {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/**
 * `--probe`：只求一件事 —— **厂商到底报了哪些 usage 字段**（plan8 R9.1 §七①）。
 *
 * 做法：跑**一句最小任务**（一轮模型调用），再从日志里捞 provider 探针打出的形状行。
 * 探针只在**开发态落盘**（打包版日志级别是 info，debug 直接丢弃 —— 见 `src/main/index.ts`），
 * 所以这个模式顺带也是个"探针还活着吗"的检查。
 */
async function probeUsage() {
  const logPath = join(USER_UD, 'logs', 'app.log')
  const before = existsSync(logPath) ? statSync(logPath).size : 0
  console.log('[probe] 跑一句最小任务（一轮模型调用）…')
  const row = await runArm(PROBE_TASK, 'on', 9222)
  console.log(`      答=${JSON.stringify(String(row.text || '').slice(0, 60))}${row.error ? ` 错误=${row.error}` : ''}`)
  console.log(`      厂商报的用量（解析后）=${row.usage ? JSON.stringify(row.usage) : '未报'}`)

  let fresh = ''
  try {
    // ⚠️ 按**字节**切片：日志里全是中文，用字符下标切会错位（before 是 statSync 给的字节数）
    fresh = readFileSync(logPath).subarray(before).toString('utf8')
  } catch {
    console.log(`      读不到日志：${logPath}`)
  }
  const shapeLines = fresh.split('\n').filter((l) => l.includes('[usage]'))
  console.log('\n===== 厂商原始 usage 形状 =====')
  if (shapeLines.length) for (const l of shapeLines) console.log(l.trim())
  else console.log('（没捞到形状行 —— 先确认 npm run build 跑过、且用的是开发态启动）')

  const outDir = join(ROOT, 'bench')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(outDir, `usage-probe-${stamp}.log`)
  writeFileSync(file, shapeLines.join('\n') + '\n', 'utf8')
  console.log(`\n报告：${file}`)
  // 拿到形状才算这次核对成功（没捞到 = 探针没生效，不能算通过）
  return !row.error && shapeLines.length > 0
}

async function main() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('缺少构建产物：先跑 npm run build')
    process.exit(1)
  }
  const ok = checkUserData()
  if (!ok) {
    console.error('真机配置不完整（缺 settings/models/密钥档案）—— 先在应用里把模型与 Key 配好再跑')
    process.exit(1)
  }
  if (PROBE) {
    process.exit((await probeUsage()) ? 0 : 1)
  }
  // 夹具住进**当前工作区根目录**（`conv:create` 只认"正好等于当前工作区"或历史授权目录）
  for (const f of FIXTURE_FILES) rmSync(join(WS, f), { force: true })
  FIXTURES()
  console.log(`[fix] 夹具已写入 ${WS}（${FIXTURE_FILES.join('、')}，跑完会删）`)
  const tasks = ONLY.length > 0 ? TASKSET.filter((t) => ONLY.includes(t.id)) : TASKSET.slice(0, TASKS)
  const rows = []
  let port = 9222
  for (const task of tasks) {
    for (const arm of ARMS) {
      for (let i = 1; i <= REPEAT; i++) {
        const label = REPEAT > 1 ? ` · 第 ${i}/${REPEAT} 次` : ''
        console.log(`\n[run] ${task.id} · 窗口化=${arm}${label} …`)
        const row = await runArm(task, arm, port++)
        rows.push(row)
        console.log(
          `      → 答对=${row.hit} 真值token=${row.total ?? '未报'} 省=${row.avoided ?? 0} 工具调用=${row.toolCalls ?? '?'} 用时=${row.seconds ?? '?'}s` +
            (row.error ? ` 错误=${row.error}` : '')
        )
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(ROOT, 'bench')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `tool-window-${stamp}.json`)
  writeFileSync(file, JSON.stringify({ when: stamp, tasks: tasks.map((t) => ({ id: t.id, why: t.why })), rows }, null, 2), 'utf8')

  console.log('\n===== 汇总（中位数；方括号里是每次的原始值）=====')
  /** 中位数：排序后取中间；偶数个取中间两个的平均。**判据写死在这里，免得每次手算** */
  const median = (xs) => {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
    if (v.length === 0) return null
    const mid = Math.floor(v.length / 2)
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
  }
  const armRows = (taskId, arm) => rows.filter((r) => r.task === taskId && r.arm === arm)
  for (const task of tasks) {
    console.log(`\n${task.id}`)
    for (const arm of ARMS) {
      const rs = armRows(task.id, arm)
      if (rs.length === 0) continue
      const okCount = rs.filter((r) => r.hit).length
      console.log(
        `  窗口化=${arm}：中位数 ${median(rs.map((r) => r.total)) ?? '未报'} token` +
          ` / 答对 ${okCount}/${rs.length}` +
          ` / 工具调用中位 ${median(rs.map((r) => r.toolCalls)) ?? '?'}` +
          ` / 每次原始值 [${rs.map((r) => `${r.total ?? '未报'}${r.error ? '(错误)' : ''}`).join(', ')}]`
      )
    }
    const on = median(armRows(task.id, 'on').map((r) => r.total))
    const off = median(armRows(task.id, 'off').map((r) => r.total))
    if (on !== null && off !== null && off !== 0) {
      const delta = Math.round(((on - off) / off) * 100)
      console.log(`  → 开 相对 关：${delta > 0 ? '+' : ''}${delta}%（负数 = 开更省）`)
    }
  }
  console.log(`\n报告：${file}`)
  // 收尾：夹具删掉；**会话已在每轮里当场删除**（`out.cleaned`），这里只报有没有漏
  const notCleaned = rows.filter((r) => r.cleaned === false)
  if (notCleaned.length) console.log(`⚠️ 有 ${notCleaned.length} 条自建会话没删掉，请到侧边栏手动删（都是 .jsl-bench 那几条）`)
  if (!KEEP) {
    for (const f of FIXTURE_FILES) {
      try {
        rmSync(join(WS, f), { force: true })
      } catch {
        console.log(`（夹具 ${f} 暂时删不掉，下次跑会被重置）`)
      }
    }
    console.log('[fix] 夹具已清理')
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('校准失败：', err)
  process.exit(1)
})
