/**
 * **工具输出窗口化的校准 harness**（plan8 R9.1）：同段任务开 / 关窗口化各跑一遍，比厂商真报的 token 与答对率。
 * 8k / 12k / 0.72 只是**保守起点**（业界查不到公开的保留比例实验），要下结论只能自己量。
 *
 * ⚠️ 必须用**用户真实的 userData**：safeStorage（Windows 上走 DPAPI 的 app-bound encryption）把密钥
 * 绑在"应用身份 + userData 路径"上 —— 密文搬去临时 userData 就解不开（实测：同一进程读真实档案解密
 * ok，读拷贝件 throw "Error while decrypting the ciphertext"），症状是整条链都对、只有厂商回 401。
 * ⚠️ 绝不打印凭据（只报"密钥在不在"这类布尔）；**一次启动只跑一臂** —— 开关在进程环境变量
 * （JSL_TOOL_WINDOW）上，同进程切臂会互相污染。
 * 历次实测结论（方差 / 档位 / "token 主导变量是工具调用次数"）见 PLAN/plan8 §七⑤ 与 bench/tool-window-*.json。
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

/** 跑法：先 npm run build，再 `node scripts/bench-tool-window.cjs --tasks=2 --arms=both --repeat=3`
 *  （2 任务 × 2 臂 × 3 次 = 12 次真实调用）；各参数见下方同名常量的注释。 */
const ROOT = process.cwd()
const ARG = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const TASKS = Number(ARG('tasks', '2'))
/** 臂名（逗号分隔）：`both` = `on,off`；`tier:<档>` = 按档位跑 —— 档位本身就是 8k/12k/0.72 的一组取值 */
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
 * 每臂重复几次（**默认 1；要下结论必须 ≥3**，取中位数并把每次原始值一起打印）。
 * ⚠️ 首轮实测的同一「关」臂两轮差 3.3 倍 —— **对照组自身的方差大于要测的效应**，
 * 所以 n=1 的 A/B 不算 A/B，方差本身就是结论的一部分。
 */
const REPEAT = Math.max(1, Number(ARG('repeat', '1')))
/** `--only=tail-in-command,mid-command`：只跑指定 id 的任务（免得为了两条任务跑全部） */
const ONLY = String(ARG('only', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const BENCH = join(ROOT, '.bench-tool-window')
const USER_UD = join(process.env.APPDATA || '', 'jiushililu')

/** 真实工作区（夹具住进它的**根目录**，跑完删 —— 不去动用户其它文件） */
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
 * 夹具文件（带统一前缀，跑完全部删掉）。
 * ⚠️ 只能放**工作区根目录**、不能放子目录：`conv:create` 要求会话工作区正好等于当前工作区
 * 或历史授权过的目录（放 `.jsl-bench/` 子目录会得到"工作区未被授权"）；带前缀则不撞用户已有文件。
 * ⚠️ 量级必须**塞不下**（见下方 `HUGE_LINES`）：一轮就塞得下的夹具测不出开 / 关的差别。
 */
const FIXTURE_FILES = ['jsl-bench-big-report.md', 'jsl-bench-check.js', 'jsl-bench-mid.js']

/**
 * 命令输出的行数 —— **这套校准的主变量**：15000 行约 300KB ≈ 7 万估算 token。
 * 取这个量级是为了**塞得进、但代价明显**（contextWindow 默认 131072）：两臂都跑得完，
 * 差别体现在真值 token 上，而不是"关臂直接超窗失败"。
 */
const HUGE_LINES = 15000

/**
 * **中等**输出的行数 —— 「够小就别压」那条候选设计的验区：5000 行 ≈ 100KB ≈ 2.5 万估算 token，
 * **远大于** minBytes（平衡档 1400 字节，一定会压），却只占 131072 窗口的约 19%，
 * 于是"整段 ≤ 窗口某比例就原样放行"那条设计会放过它 —— 差别恰好只在这个区间测得到。
 */
const MID_LINES = 5000

const FIXTURES = () => {
  mkdirSync(WS, { recursive: true })
  // ① 大文件：针在第 380 行 —— 考"按窗口读 + 能续读"（`read_file` 自带行窗口与绝对预算，
  //    这条不依赖主循环窗口化，是"关臂也不该崩"的对照组）
  const big = []
  for (let i = 1; i <= 600; i++) {
    big.push(i === 380 ? '审计编号：JSL-7742' : `第 ${i} 行：这是用来撑大文件体积的普通内容，不含关键信息。`)
  }
  writeFileSync(join(WS, 'jsl-bench-big-report.md'), big.join('\n'), 'utf8')

  // ② 命令输出：**结论在末尾**（旧代码 `slice(0,8000)` 恰好切掉的那半截）。
  //    ⚠️ 别再加一份内容重复的 `noisy.log`：那会把模型引去再读一遍文件，省下的 token 就不算窗口化的功劳
  const lines = []
  for (let i = 0; i < HUGE_LINES; i++) lines.push(`[info] 处理第 ${i} 个条目，一切正常`)
  lines.push('[info] 开始跑检查用例')
  lines.push('✕ 3) 端口占用检查')
  lines.push('   Expected 3000, received 8080')
  lines.push('exit code 1')
  writeFileSync(join(WS, 'jsl-bench-check.js'), `console.log(${JSON.stringify(lines.join('\n'))})\n`, 'utf8')

  // ③ 中等输出：考"够小就别压"（判据见 MID_LINES），结论一样埋在末尾
  const mid = []
  for (let i = 0; i < MID_LINES; i++) mid.push(`[info] 检查第 ${i} 项，一切正常`)
  mid.push('[info] 汇总：共检查完毕')
  mid.push('✕ 7) 校验和比对')
  mid.push('   Expected c0ffee, received deadbeef')
  mid.push('exit code 1')
  writeFileSync(join(WS, 'jsl-bench-mid.js'), `console.log(${JSON.stringify(mid.join('\n'))})\n`, 'utf8')
}

/**
 * `--probe` 用的**最小任务**：不调工具、只求一轮模型调用 —— 要核对的只是"厂商报了哪些字段"，
 * 用校准任务去拿等于为看一个字段多烧几万 token。
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

/** 检查真机配置**在不在**（只读、只报布尔）。⚠️ 只在原地查、不搬文件 —— 密文搬了家就解不开（见文件头） */
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
      //    取第一个 page 会连到空白页（那里 `window.api` 是 undefined，症状是"每个任务都报 getSettings 不是函数"）
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
      const offTool = api.onChatTool((e) => { if (e.conversationId === id) tools.push({ name: e.payload.name, phase: e.payload.phase, saved: e.payload.savedTokens || 0, detail: e.payload.detail || '' }) })
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
   * 臂名 → 环境变量：`on` / `off` 是窗口化开关（`JSL_TOOL_WINDOW`）；`tier:<档>` 是按档位跑。
   * ⚠️ tier 臂下 `JSL_TOOL_WINDOW` 必须保持 `on` —— `off` 会**压过**档位（那是校准用的强关），
   * 而这里要测的正是档位自己的 `windowEnabled`。
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
    /** 工具调用次数 —— 报告里必须带它：解释 token 差异的分母是"轮数 × 上下文规模"，
     *  不是单轮文本大小（上一轮实测正是被"多出来的回合"主导的） */
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
 * `--probe`：只求一件事 —— **厂商到底报了哪些 usage 字段**：跑一句最小任务，再从日志里捞
 * provider 探针打出的形状行。探针只在**开发态落盘**（打包版日志级别是 info，debug 直接丢弃 ——
 * 见 `src/main/index.ts`），所以这个模式顺带也是"探针还活着吗"的检查。
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
