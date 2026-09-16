/**
 * L2 在线 eval 的 **electron 子进程**（plan25 S3 · D-074）。
 *
 * 为什么是 electron：apiKeysEncrypted 走 safeStorage（Windows = DPAPI app-bound），
 * 只有 electron + **真实 userData** 解得开 —— bench-tool-window.cjs 的同款先例。
 * 父进程 scripts/run-evals.cjs 负责 esbuild bundle 真源码 + spawn 本文件 + 收报告。
 *
 * 数据目录引导（与真应用同构）：裸 electron 跑脚本时 app.name 默认 "Electron"，
 * 锚点会落错目录 —— 先 setName 钉成真应用名，再 require 薄壳产物（模块体自执行
 * location.json / JSL_DATA_DIR 引导 + setPath，plan10 同款），自定义数据目录也能覆盖。
 *
 * ⚠️ 四条纪律（沿 bench 先例）：
 *   1. 绝不打印 key（只报「解密成功/失败」布尔）；结果 JSON 打 stdout 由父进程落盘。
 *   2. 每个场景独立内存 backend（干净起点，Anthropic trial 口径）。
 *   3. 判分器**全部代码判分**（判据 9）：LLM-as-judge 不用（批 4 n=1 教训）。
 *   4. 退出前 releaseBootstrapLock（薄壳会建 data.lock，不释放会留陈锁）。
 *
 * 输出约定：最后一行 `EVALS_RESULT:<json>` —— 父进程按行扫描。
 * 退出码：0 = 跑完（场景内 fail 也算跑完，结果看报告）；2 = 环境/凭据问题（判据 9 的无 key 路径）。
 */

const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = process.cwd()
const evalsTmp = join(ROOT, '.evals-tmp')

// ── 数据目录引导：必须在读任何 userData 文件之前 ──
app.setName('jiushililu')
const bootstrap = require(join(evalsTmp, 'bootstrap-data-dir.js'))
// ── 真源码产物（esbuild bundle，见 run-evals.cjs；多入口按公共祖先 src/main 保留子目录结构）──
const { createMemoryRepo } = require(join(evalsTmp, 'memory', 'memory-core.js'))
const { createReflectionRunner } = require(join(evalsTmp, 'memory', 'reflection.js'))
const { REFLECTION_SYSTEM_PROMPT } = require(join(evalsTmp, 'memory', 'reflection-prompt.js'))
const { resolveApiUrl } = require(join(evalsTmp, 'providers', 'url.js'))

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

/** 场景定义：每条 = 一段对话 + 代码判分器。判分口径见各场景注释 */
const SCENARIOS = [
  {
    id: 'L2-1',
    desc: '记忆提取：明确偏好 → 反思应产出 ≥1 个合法候选',
    /**
     * 判分：candidates.length >= 1，且每条 name 非空、class 合法。
     * 口径 = pass@k（能力 eval：repeat 次中 ≥1 次通过即过 —— Anthropic 辅助工具口径）。
     */
    messages: [
      { role: 'user', content: '从今天开始，所有对比选型类的回答都用 markdown 表格组织，不要用列表，表格要有"方案/优点/代价"三列。' },
      { role: 'assistant', content: '好的，记住了：对比选型类回答用表格，含方案/优点/代价三列。' },
      { role: 'user', content: '另外帮我看看这个依赖要不要升级。' }
    ],
    grade: (candidates) => {
      const legal = ['style', 'default', 'knowledge', 'profile']
      if (candidates.length === 0) return { pass: false, why: '没有产出任何候选' }
      for (const c of candidates) {
        if (!c.name) return { pass: false, why: `候选缺 name：${JSON.stringify(c).slice(0, 120)}` }
        if (!legal.includes(c.class)) return { pass: false, why: `候选 class 非法：${c.class}` }
        if (!c.description || !c.body) return { pass: false, why: `候选缺 description/body：${c.name}` }
      }
      return { pass: true, why: `${candidates.length} 条合法候选` }
    }
  },
  {
    id: 'L2-2',
    desc: '画像识别：跨场景用户特征 → 反思应产出 user-profile 候选（D-073）',
    /**
     * 判分：pass@k —— repeat 次中 ≥1 次产出 name='user-profile' 且 class='profile'，
     * 且 body 是完整画像（含 markdown 分节标题，非一句话增量）。
     */
    messages: [
      { role: 'user', content: '介绍下我自己：我是独立开发者，一个人做项目，主力语言 TypeScript，桌面端用 Electron，最近在做一个叫「九十里路」的自进化 Agent 应用，目标开源到 GitHub。' },
      { role: 'assistant', content: '了解了，你的情况很清晰：独立开发、TS + Electron 技术栈、当前项目是九十里路。有什么需要我帮忙的？' },
      { role: 'user', content: '先帮我审一段这段代码的类型定义。' }
    ],
    grade: (candidates) => {
      const hit = candidates.find((c) => c.name === 'user-profile' && c.class === 'profile')
      if (!hit) {
        return { pass: false, why: `未产出画像候选（产出了 ${candidates.map((c) => c.name).join('、') || 'nothing'}）` }
      }
      if (!/^##\s/m.test(hit.body)) return { pass: false, why: '画像 body 没有 markdown 分节（像增量补丁而非完整画像）' }
      return { pass: true, why: '画像候选结构合法' }
    }
  },
  {
    id: 'L2-3',
    desc: '反面：纯闲聊 → 反思不该产出正式候选（最多允许 1 条且必须合法）',
    /**
     * 判分（宽松反面）：candidates.length <= 1 且（若有）class 合法。
     * 不硬性要求 0 —— 模型把闲聊记成低价值条目是召回/精度权衡问题，
     * L2 只罚「结构性错误」；硬性反面由 L1 的桩场景钉（那里确定性强）。
     */
    messages: [
      { role: 'user', content: '今天天气怎么样？哈哈我刚喝了杯咖啡。' },
      { role: 'assistant', content: '哈哈，咖啡配好天气不错。需要我帮你做点什么吗？' },
      { role: 'user', content: '没什么事，随便聊聊。' }
    ],
    grade: (candidates) => {
      if (candidates.length > 1) return { pass: false, why: `闲聊竟产出 ${candidates.length} 条候选` }
      const legal = ['style', 'default', 'knowledge', 'profile']
      for (const c of candidates) {
        if (!legal.includes(c.class)) return { pass: false, why: `候选 class 非法：${c.class}` }
      }
      return { pass: true, why: `闲聊产出 ${candidates.length} 条（≤1 且合法）` }
    }
  }
]

/** 非流式 chat（OpenAI 兼容）。⚠️ 传输层是脚手架不是被测对象——被测的是反思器与记忆库 */
async function chatOnce({ baseURL, model, apiKey }, messages) {
  const res = await fetch(resolveApiUrl(baseURL, 'chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120000) // 单次调用 2 分钟兜底，防单点挂死拖满全局超时
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const choice = data.choices && data.choices[0]
  const content = choice && choice.message && choice.message.content
  if (typeof content !== 'string') throw new Error('响应缺 message.content')
  return content
}

function makeMemory() {
  const files = new Map()
  const events = []
  return {
    files,
    events,
    listFiles: () => [...files.keys()].sort(),
    candidatePathFor: (slug) => `${ROOT}/.evals-tmp/candidates/${slug}.md`,
    listCandidates: () => [],
    read: (f) => files.get(f) ?? null,
    write: (f, t) => void files.set(f, t),
    remove: (f) => files.delete(f),
    pathFor: (slug) => `${ROOT}/.evals-tmp/notes/${slug}.md`,
    appendEvent: (line) => void events.push(line)
  }
}

/** 跑全部场景，返回退出码（0 = 跑完；2 = 环境/凭据问题）。不自己 app.exit —— 交给 finally 后的统一出口 */
async function runAll() {
  const startedAt = new Date().toISOString()
  const dataDir = bootstrap.getBootstrappedDataDir()
  console.error(`EVALS: 数据目录 = ${dataDir}`)
  const settings = readJson(join(dataDir, 'settings.json'))
  const models = readJson(join(dataDir, 'models.json'))

  const profile = (models.profiles || []).find((p) => p.id === models.activeProfileId) || (models.profiles || [])[0]
  const profileId = profile && profile.id
  const enc = profileId && (settings.apiKeysEncrypted || {})[profileId]
  if (!profile || !enc) {
    console.error('EVALS_SKIP: 找不到激活档案的密文（settings.json/apiKeysEncrypted 或 models.json/profiles 缺失）')
    console.error('EVALS_SKIP: 请确认应用已配置模型并至少保存过一次 API Key')
    return 2
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('EVALS_SKIP: safeStorage 不可用（无头/非本机环境解不了 DPAPI）')
    return 2
  }
  let apiKey = ''
  try {
    apiKey = safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    console.error('EVALS_SKIP: 密文解不开（换了系统用户或密钥环不可用）')
    return 2
  }
  if (!apiKey) {
    console.error('EVALS_SKIP: 解密结果为空')
    return 2
  }
  console.error(`EVALS: 解密成功（profile=${profile.name}，model=${profile.models[0].model}），开始 eval —— key 不打印`)

  const endpoint = {
    baseURL: profile.baseURL,
    model: profile.models[0].model,
    apiKey
  }
  const repeat = Math.max(1, Number(process.env.JSL_EVAL_REPEAT || '1'))
  const results = []

  for (const scenario of SCENARIOS) {
    const trials = []
    for (let i = 0; i < repeat; i++) {
      const t0 = Date.now()
      try {
        const memory = makeMemory()
        const repo = createMemoryRepo(memory, {
          now: () => new Date(),
          onWarn: () => {},
          conversationId: () => 'eval'
        })
        const runner = createReflectionRunner({
          chat: async (messages) => ({
            content: await chatOnce(endpoint, [{ role: 'system', content: REFLECTION_SYSTEM_PROMPT }, ...messages])
          })
        })
        const { candidates } = await runner.reflect({
          id: 'eval',
          messages: scenario.messages,
          bodyBytes: 4096, // 过前置门（MIN_BODY_BYTES=2048）
          memory: repo
        })
        const verdict = scenario.grade(candidates)
        trials.push({
          pass: verdict.pass,
          why: verdict.why,
          ms: Date.now() - t0,
          candidateCount: candidates.length,
          candidateNames: candidates.map((c) => `${c.name}(${c.class})`)
        })
      } catch (err) {
        trials.push({ pass: false, why: `异常：${String(err && err.message ? err.message : err).slice(0, 200)}`, ms: Date.now() - t0 })
      }
    }
    const passCount = trials.filter((t) => t.pass).length
    results.push({
      id: scenario.id,
      desc: scenario.desc,
      repeat,
      passCount,
      passed: passCount > 0, // 能力 eval 的 pass@k 口径：≥1 次通过即过
      trials
    })
    console.error(`EVALS: ${scenario.id} ${passCount}/${repeat} 通过`)
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dataDir, // 只为报告可追溯；不含 key
    endpoint: { baseURL: endpoint.baseURL, model: endpoint.model }, // 不含 key
    repeat,
    results,
    summary: {
      scenarios: results.length,
      passed: results.filter((r) => r.passed).length
    }
  }
  process.stdout.write(`EVALS_RESULT:${JSON.stringify(report)}\n`)
  return 0
}

app
  .whenReady()
  .then(async () => {
    let code
    try {
      code = await runAll()
    } catch (err) {
      console.error(`EVALS_SKIP: worker 崩溃：${err && err.stack ? err.stack : err}`)
      code = 2
    } finally {
      bootstrap.releaseBootstrapLock() // 纪律 4：不释放会留 data.lock 陈锁
    }
    app.exit(code)
  })
  .catch((err) => {
    console.error(`EVALS_SKIP: worker 崩溃：${err && err.stack ? err.stack : err}`)
    app.exit(2)
  })
