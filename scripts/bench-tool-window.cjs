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
 * npm run build                                   # 先构建（harness 驱动的是构建产物）
 * node scripts/bench-tool-window.cjs --tasks=2    # 4 次真实调用（2 任务 × 2 臂）
 * ```
 *
 * - `--tasks=1|2`  跑几个任务（默认 2）
 * - `--arms=both|on|off`  跑哪几臂（默认 both）
 * - `--keep`  保留本次 userData（默认跑完删）
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
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = process.cwd()
const ARG = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const TASKS = Number(ARG('tasks', '2'))
const ARMS = String(ARG('arms', 'both')) === 'both' ? ['on', 'off'] : [String(ARG('arms', 'on'))]
const KEEP = process.argv.includes('--keep')

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
const FIXTURE_FILES = ['jsl-bench-big-report.md', 'jsl-bench-check.js', 'jsl-bench-noisy.log']

/** 夹具与判据：**针**（needle）埋在任务必须"读到/看到"的位置，答不出来就是失败 */
const FIXTURES = () => {
  mkdirSync(WS, { recursive: true })
  // ① 大文件：针在第 380 行 —— 只有"按窗口读 + 能续读"才拿得到（全文倾倒也拿得到，但代价是 9 万 token）
  const big = []
  for (let i = 1; i <= 600; i++) {
    big.push(i === 380 ? '审计编号：JSL-7742' : `第 ${i} 行：这是用来撑大文件体积的普通内容，不含关键信息。`)
  }
  writeFileSync(join(WS, 'jsl-bench-big-report.md'), big.join('\n'), 'utf8')

  // ② 命令输出：**结论在末尾**（这正是旧代码 `slice(0,8000)` 会切掉的那半截）
  const lines = []
  for (let i = 0; i < 700; i++) lines.push(`[info] 处理第 ${i} 个条目，一切正常`)
  lines.push('[info] 开始跑检查用例')
  lines.push('✕ 3) 端口占用检查')
  lines.push('   Expected 3000, received 8080')
  lines.push('exit code 1')
  writeFileSync(join(WS, 'jsl-bench-check.js'), `console.log(${JSON.stringify(lines.join('\n'))})\n`, 'utf8')
  writeFileSync(join(WS, 'jsl-bench-noisy.log'), lines.join('\n'), 'utf8')
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
  const env = { ...process.env, JSL_TOOL_WINDOW: arm === 'off' ? 'off' : 'on' }
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
    return { task: task.id, arm, seconds: secs, hit, usage: res.usage, total, avoided: res.avoided, error: res.error, text: res.text.slice(0, 400), tools: res.tools, cleaned: res.cleaned }
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
  // 夹具住进**当前工作区根目录**（`conv:create` 只认"正好等于当前工作区"或历史授权目录）
  for (const f of FIXTURE_FILES) rmSync(join(WS, f), { force: true })
  FIXTURES()
  console.log(`[fix] 夹具已写入 ${WS}（${FIXTURE_FILES.join('、')}，跑完会删）`)
  const tasks = TASKSET.slice(0, TASKS)
  const rows = []
  let port = 9222
  for (const task of tasks) {
    for (const arm of ARMS) {
      console.log(`\n[run] ${task.id} · 窗口化=${arm} …`)
      const row = await runArm(task, arm, port++)
      rows.push(row)
      console.log(
        `      → 答对=${row.hit} 真值token=${row.total ?? '未报'} 省=${row.avoided ?? 0} 用时=${row.seconds ?? '?'}s` +
          (row.error ? ` 错误=${row.error}` : '')
      )
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(ROOT, 'bench')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `tool-window-${stamp}.json`)
  writeFileSync(file, JSON.stringify({ when: stamp, tasks: tasks.map((t) => ({ id: t.id, why: t.why })), rows }, null, 2), 'utf8')

  console.log('\n===== 汇总 =====')
  for (const task of tasks) {
    const on = rows.find((r) => r.task === task.id && r.arm === 'on')
    const off = rows.find((r) => r.task === task.id && r.arm === 'off')
    const fmt = (r) => (r ? `${r.hit ? '答对' : '答错'} / ${r.total ?? '未报'} token / 省 ${r.avoided ?? 0}` : '—')
    console.log(`${task.id}\n  开：${fmt(on)}\n  关：${fmt(off)}`)
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
