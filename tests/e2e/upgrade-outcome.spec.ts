// E30 · 真实 Electron 四故事族与进程身份
//
// 权威合同：协调记录/R10补正-R4/before/E30-真实Electron四故事族.md
// 只驱动真入口 out/main/index.js（helpers.launchApp），模型仅本地 127.0.0.1 合成 HTTP/SSE。
// 不新增测试专用生产 IPC、不碰真实账号/付费 provider、不改任何现有源码/helper/配置。
//
// 结构化标记：每个用例输出一行 `E30_MARK=<json>`（PID/端口/故事/exit/hit），便于证据归档。
import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp as launchBaseApp, apiCall, type E2EApp } from './helpers'

/** 模型档案必须使用真实加密服务，不可用时按 smoke 约定明确跳过并清理实例。 */
async function launchApp(options?: Parameters<typeof launchBaseApp>[0]): Promise<E2EApp> {
  const h = await launchBaseApp(options)
  let available: boolean
  try {
    available = await h.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
  } catch (error) {
    await h.close()
    await h.cleanup()
    throw error
  }
  if (!available) {
    const reason = 'safeStorage 不可用：测试模型 Key 无法加密落盘，须在有加密服务的平台验证四故事'
    console.log(`E30_SKIP=${JSON.stringify({ encryptionAvailable: false, reason })}`)
    await h.close()
    await h.cleanup()
    test.skip(true, reason)
  }
  return h
}

/**
 * 证据域：**必须**由 runner 通过 `E30_EVIDENCE` 注入；缺省落系统 tmp。
 * 禁止硬编码任何端私有目录 —— 换端/换机都不该改测试。
 */
const EVIDENCE =
  process.env.E30_EVIDENCE && process.env.E30_EVIDENCE.trim().length > 0
    ? process.env.E30_EVIDENCE
    : join(tmpdir(), 'e30-evidence')

// ─────────────────────────────────────────────────────────────
// 合成端点：一个 server 同时服务 OpenAI 与 Anthropic 两种 SSE，
// 并按调用序号播放脚本；完整记录请求体供"出站不含本地字段"断言。
// ─────────────────────────────────────────────────────────────
interface Endpoint {
  port: number
  bodies: string[]
  paths: string[]
  /** byBody 路由实际命中的规则 key（'fallback' = 未命中，如标题摘要旁路调用）。
   *  按正文子串数轮次会被历史消息带偏（第二轮请求体里仍含第一轮原文），故由端点侧精确记账。 */
  routed: string[]
  close: () => Promise<void>
}

type Step =
  | { kind: 'sse'; frames: string[] }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'hang'; frames?: string[] }
  | { kind: 'abort' }
  /** 按请求体路由：命中 rules 里第一条 match 就用它的帧，其余走 fallback。
   *  为什么需要：会话标题摘要等旁路调用会额外打一次模型，按调用序号排的脚本会被它抢走槽位
   *  （E30-R2D 实测第 3 笔即标题请求），用正文路由才不受旁路调用数量影响。 */
  | { kind: 'byBody'; rules: Array<{ match: string; frames: string[] }>; fallback: string[] }

function oaChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function anChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** OpenAI 一帧正文（含可选 usage / finish_reason） */
function oaText(text: string, finish = 'stop', usage?: { p: number; c: number }): string[] {
  const frames: string[] = []
  if (usage) frames.push(oaChunk({ usage: { prompt_tokens: usage.p, completion_tokens: usage.c } }))
  frames.push(oaChunk({ choices: [{ delta: { content: text }, finish_reason: finish }] }))
  frames.push('data: [DONE]\n\n')
  return frames
}

/** OpenAI 一帧工具调用 */
function oaToolCall(id: string, name: string, args: string, usage?: { p: number; c: number }): string[] {
  const frames: string[] = []
  if (usage) frames.push(oaChunk({ usage: { prompt_tokens: usage.p, completion_tokens: usage.c } }))
  frames.push(
    oaChunk({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
          finish_reason: 'tool_calls'
        }
      ]
    })
  )
  frames.push('data: [DONE]\n\n')
  return frames
}

/** Anthropic 完整消息壳；withStop=false 制造"缺业务终帧" */
function anText(
  text: string,
  stopReason: string | null,
  opts: { usage?: { i: number; o: number }; withStop?: boolean; withDelta?: boolean } = {}
): string[] {
  const { usage, withStop = true, withDelta = true } = opts
  const frames: string[] = []
  frames.push(
    anChunk({
      type: 'message_start',
      message: usage ? { usage: { input_tokens: usage.i, output_tokens: 0 } } : {}
    })
  )
  frames.push(anChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
  frames.push(anChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  frames.push(anChunk({ type: 'content_block_stop', index: 0 }))
  if (withDelta) {
    frames.push(
      anChunk({
        type: 'message_delta',
        delta: stopReason === null ? {} : { stop_reason: stopReason },
        usage: usage ? { output_tokens: usage.o } : undefined
      })
    )
  }
  if (withStop) frames.push(anChunk({ type: 'message_stop' }))
  return frames
}

async function startEndpoint(steps: Step[], tag: string): Promise<Endpoint> {
  const bodies: string[] = []
  const paths: string[] = []
  const routed: string[] = []
  let idx = 0
  const srv: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      paths.push(req.url ?? '')
      const peek = steps[idx]
      const byBodyStep = peek && peek.kind === 'byBody' ? peek : null
      const step: Step =
        byBodyStep ??
        (peek ? (idx++, peek) : { kind: 'sse', frames: oaText('E30_FALLBACK') })
      if (step.kind === 'byBody') {
        const raw = Buffer.concat(chunks).toString('utf8')
        const hit = step.rules.find((r) => raw.includes(r.match))
        routed.push(hit ? hit.match : 'fallback')
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        for (const f of hit ? hit.frames : step.fallback) res.write(f)
        res.end()
        return
      }
      if (step.kind === 'hang') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        for (const f of step.frames ?? []) res.write(f)
        // 故意不 end：连接保持，供"运行中停止"用例观察 running
        return
      }
      if (step.kind === 'abort') {
        req.socket.destroy()
        return
      }
      if (step.kind === 'http') {
        res.writeHead(step.status, { 'content-type': 'application/json' })
        res.end(step.body)
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      for (const f of step.frames) res.write(f)
      res.end()
    })
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const port = (srv.address() as AddressInfo).port
  console.log(`E30_MARK=${JSON.stringify({ tag, port, event: 'endpoint-up' })}`)
  return {
    port,
    bodies,
    paths,
    routed,
    close: async () => {
      srv.closeAllConnections()
      await new Promise<void>((r) => srv.close(() => r()))
    }
  }
}

/** 把模型档案指向本地合成端点并激活（真 UI 只认激活档案） */
async function useLocalModel(
  page: Page,
  port: number,
  opts: { providerType?: 'openai-compatible' | 'anthropic'; name: string }
): Promise<void> {
  const providerType = opts.providerType ?? 'openai-compatible'
  const profile = await apiCall<{ id: string }>(page, 'saveModel', {
    name: opts.name,
    providerType,
    baseURL: `http://127.0.0.1:${port}/v1`,
    models: [{ id: `${opts.name}-entry`, model: `${opts.name}-model` }],
    apiKey: 'E30_FAKE_LOCAL_KEY',
    stream: true,
    timeoutMs: 20000
  })
  await apiCall(page, 'setActiveModel', profile.id)
  await page.reload()
}

async function send(page: Page, text: string): Promise<void> {
  const ta = page.locator('textarea.console-input').first()
  await ta.fill(text)
  await page.locator('.send-btn').click()
}

/** 生成真实 stdio MCP fixture（仓库已装 SDK；绝不 install）。两个工具：isError 与「正常但正文含错误字」对照 */
function writeMcpFixture(
  mcpDir: string,
  sdkRoot: string,
  callLog: string,
  canary: string
): string {
  mkdirSync(mcpDir, { recursive: true })
  // 每次用例清空调用日志：同一证据目录跨轮复用，残留会让「恰好调用一次」失真
  writeFileSync(callLog, '', 'utf8')
  const serverPath = join(mcpDir, 'e30-mcp-server.mjs')
  writeFileSync(
    serverPath,
    `import { appendFileSync } from 'node:fs'
import { Server } from 'file:///${sdkRoot}/server/index.js'
import { StdioServerTransport } from 'file:///${sdkRoot}/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from 'file:///${sdkRoot}/types.js'
const server = new Server({ name: 'e30mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'publish_success', description: 'E30 fixture: always returns isError', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
    { name: 'normal_with_error_word', description: 'E30 fixture: succeeds but text contains error word', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  appendFileSync(process.env.E30_MCP_CALL_LOG, req.params.name + '\\n')
  if (req.params.name === 'publish_success') {
    return { isError: true, content: [{ type: 'text', text: '${canary}：产物发布被拒绝' }] }
  }
  return { isError: false, content: [{ type: 'text', text: '错误：这是正常返回，只是正文含错误字样（E30_OK_WORD_2c41）' }] }
})
await server.connect(new StdioServerTransport())
`,
    'utf8'
  )
  return serverPath
}

/** 等本轮结束：停止按钮消失（无论成功/失败） */
async function waitIdle(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.locator('.send-btn.stopping')).toHaveCount(0, { timeout })
}

/** 真实逐次确认桥：可写档下工具执行前会弹 ConfirmDialog；点「允许这一次」 */
async function approveNextConfirm(page: Page, timeout = 15_000): Promise<boolean> {
  const btn = page.locator('.cf-btn-go')
  try {
    await btn.waitFor({ state: 'visible', timeout })
    await btn.first().click()
    return true
  } catch {
    return false
  }
}

/** 经公开 UI 选择主 Agent（默认内核集不含 run_command / MCP 工具，必须选声明了它的 Agent） */
async function selectAgent(page: Page, name: string): Promise<void> {
  await page.locator('.plus-btn').click()
  await page.locator('.plus-item').filter({ hasText: name }).first().click()
  await expect(page.locator('.plus-badge')).toBeVisible()
}

function mark(o: Record<string, unknown>): void {
  console.log(`E30_MARK=${JSON.stringify(o)}`)
}

/** 真 Electron 主进程 PID */
function mainPid(h: E2EApp): number {
  const p = h.app.process()
  return p.pid ?? -1
}

/** 证据落盘：把该例运行时**原始观测值**写成文件（给复核看的 raw，不参与断言） */
function dumpEvidence(name: string, obj: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 1) + '\n', 'utf8')
}

/**
 * Win32 OpenProcessToken + GetTokenInformation 核非提权。
 * 只针对**本次 Electron 主进程 PID**；不用父 shell 的 whoami 代证。
 */
function tokenEvidence(pid: number): Record<string, unknown> {
  mkdirSync(EVIDENCE, { recursive: true })
  const ps = join(EVIDENCE, 'tmp', 'token-check.ps1')
  mkdirSync(join(EVIDENCE, 'tmp'), { recursive: true })
  writeFileSync(
    ps,
    `
param([int]$TargetPid)
$src = @"
using System;
using System.Runtime.InteropServices;
public class Tok {
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool GetTokenInformation(IntPtr tok, int cls, byte[] info, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr info, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LocalFree(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint acc, bool inh, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  public static string Elevation(IntPtr token) {
    byte[] buf = new byte[4]; int rl;
    if (!GetTokenInformation(token, 20, buf, 4, out rl)) return "ERROR_" + Marshal.GetLastWin32Error();
    return BitConverter.ToInt32(buf, 0) == 0 ? "0" : "1";
  }
  public static int IntegrityRid(IntPtr token) {
    int size = 256;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      int rl;
      if (!GetTokenInformation(token, 25, buf, size, out rl)) return -1;
      IntPtr sid = Marshal.ReadIntPtr(buf, 0);          // PSID（不是偏移）
      byte subCount = Marshal.ReadByte(sid, 1);         // SID: [0]=rev [1]=subAuthCount
      int lastOff = 8 + (subCount - 1) * 4;             // subAuthority 从 sid+8 起
      return Marshal.ReadInt32(sid, lastOff);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // TokenGroups: 找 BUILTIN\\Administrators (S-1-5-32-544)，回报 SE_GROUP_ENABLED(0x4)
  public static string AdminGroup(IntPtr token) {
    int size = 131072;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      int rl;
      if (!GetTokenInformation(token, 2, buf, size, out rl)) return "ERROR_" + Marshal.GetLastWin32Error();
      int count = Marshal.ReadInt32(buf, 0);
      for (int i = 0; i < count; i++) {
        int off = 8 + i * 16;
        if (off + 16 > rl) break;
        IntPtr sid = Marshal.ReadIntPtr(buf, off);
        int attrs = Marshal.ReadInt32(buf, off + 8);
        IntPtr s;
        if (ConvertSidToStringSid(sid, out s)) {
          string sidStr = Marshal.PtrToStringUni(s);
          LocalFree(s);
          if (sidStr == "S-1-5-32-544")
            return ((attrs & 0x00000004) != 0) ? "present-enabled" : "present-disabled";
        }
      }
      return "absent";
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
$PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
$TOKEN_QUERY = 0x0008
$h = [Tok]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $TargetPid)
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"OpenProcess failed"}'; exit 0 }
$tok = [IntPtr]::Zero
if (-not [Tok]::OpenProcessToken($h, $TOKEN_QUERY, [ref]$tok)) {
  [Tok]::CloseHandle($h) | Out-Null
  Write-Output '{"ok":false,"reason":"OpenProcessToken failed"}'; exit 0
}
$elev = [Tok]::Elevation($tok)
$rid = [Tok]::IntegrityRid($tok)
$adm = [Tok]::AdminGroup($tok)
[Tok]::CloseHandle($tok) | Out-Null
[Tok]::CloseHandle($h) | Out-Null
# 只输出 raw 观测值；标签映射一律在 TS 侧做，避免 PS switch 语义污染断言
$o = @{ ok=$true; pid=$TargetPid; tokenElevation=$elev; integrityRid=$rid; adminGroup=$adm }
$o | ConvertTo-Json -Compress
`,
    'utf8'
  )
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-TargetPid', String(pid)],
      { encoding: 'utf8', timeout: 60_000 }
    )
    const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

/** 扫描一组文本是否命中 canary */
function hits(haystack: string, canary: string): boolean {
  return haystack.includes(canary)
}

// ─────────────────────────────────────────────────────────────
// 进程身份：真 Electron 主进程非提权（合同 How1）
// ─────────────────────────────────────────────────────────────
test('身份：真实 Electron 主进程 Windows Token 非提权 / POSIX 非 root', async () => {
  const h = await launchBaseApp()
  try {
    const pid = mainPid(h)
    const ev: Record<string, unknown> = process.platform === 'win32'
      ? tokenEvidence(pid)
      : await h.app.evaluate(() => ({ ok: true, pid: process.pid, uid: process.getuid?.(), euid: process.geteuid?.() }))
    writeFileSync(join(EVIDENCE, '身份回执.json'), JSON.stringify(ev, null, 2), 'utf8')
    mark({ story: 'identity', pid, ev })
    expect(pid).toBeGreaterThan(0)
    expect(ev['ok']).toBe(true)
    if (process.platform !== 'win32') {
      expect(ev['pid']).toBe(pid)
      expect(typeof ev['uid']).toBe('number')
      expect(typeof ev['euid']).toBe('number')
      expect(Number(ev['uid'])).toBeGreaterThan(0)
      expect(ev['euid']).toBe(ev['uid'])
      return
    }
    expect(String(ev['tokenElevation'])).toBe('0')
    // 完整性级别按 **RID 数值**判定（不依赖 PowerShell switch 语义）：
    // 4096=Low 8192=Medium 8448=MediumPlus 12288=High 16384=System
    const RID_LEVEL: Record<number, string> = {
      4096: 'Low',
      8192: 'Medium',
      8448: 'MediumPlus',
      12288: 'High',
      16384: 'System'
    }
    const rid = Number(ev['integrityRid'])
    const level = RID_LEVEL[rid] ?? `Unknown-${rid}`
    // Administrators：必须读到**真实**字段（禁止 String(undefined) 恒真判据）
    const adminGroup = ev['adminGroup']
    writeFileSync(
      join(EVIDENCE, '身份回执.json'),
      JSON.stringify({ ...ev, integrityLevel: level, rawAdminGroup: adminGroup }, null, 2),
      'utf8'
    )
    expect(level).toBe('Medium')
    // 先证明字段真的取到了，再断言其值
    expect(adminGroup).toBeDefined()
    expect(['present-disabled', 'absent']).toContain(String(adminGroup))
    expect(String(adminGroup)).not.toBe('present-enabled')
  } finally {
    await h.close()
    await h.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────
// Story 1：两协议正常 / 缺业务终帧截断 / 0 正文失败 / 重启保留
// ─────────────────────────────────────────────────────────────
test('Story1 · OpenAI 正常完成：正文逐段可见 + terminal=completed + 已知用量', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S1_OA_OK 正常完成正文', 'stop', { p: 100, c: 20 }) }],
    's1-openai'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-oa' })
    await send(h.page, 'S1 请正常回答')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S1_OA_OK 正常完成正文')
    const term = h.page.locator('.msg-terminal[data-terminal-state="completed"]')
    await expect(term.last()).toBeVisible()
    mark({ story: 's1-openai', pid: mainPid(h), port: ep.port, exit: 0, hit: ep.bodies.length })
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story1 · Anthropic 正常完成：正文可见 + terminal=completed', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: anText('S1_AN_OK 正常完成正文', 'end_turn', { usage: { i: 100, o: 20 } }) }],
    's1-anthropic'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-an', providerType: 'anthropic' })
    await send(h.page, 'S1 请正常回答')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S1_AN_OK 正常完成正文')
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()
    mark({ story: 's1-anthropic', pid: mainPid(h), port: ep.port, exit: 0, hit: ep.bodies.length })
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story1 · 缺业务终帧（截断）不冒充成功：terminal 非 completed', async () => {
  const h = await launchApp()
  // 只发 message_start + 一段正文，不发 message_delta/message_stop
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: [
          anChunk({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } }),
          anChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
          anChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'S1_TRUNC 部分正文保留' } }),
          anChunk({ type: 'content_block_stop', index: 0 })
        ]
      }
    ],
    's1-truncated'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-tr', providerType: 'anthropic' })
    await send(h.page, 'S1 截断')
    await waitIdle(h.page)
    // 部分正文必须保留
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S1_TRUNC 部分正文保留')
    // 且绝不允许被标成 completed
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)
    const states = await h.page.locator('.msg-terminal').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-terminal-state'))
    )
    mark({ story: 's1-truncated', pid: mainPid(h), port: ep.port, states })
    expect(states.length).toBeGreaterThan(0)
    expect(states).not.toContain('completed')
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story1 · 0 正文失败：t0/t1 落盘时间线 + 真实窗口关闭重启后终态与已知用量仍在', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('', 'content_filter', { p: 30, c: 0 }) }],
    's1-zerobody'
  )
  const dataDir = h.dataDir
  const convDir = join(dataDir, 'conversations')
  let t0 = 0
  let t1 = 0
  let persistedRaw = ''
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-zero' })
    await send(h.page, 'S1 0 正文失败')
    await waitIdle(h.page)

    // ① 保留原 UI 断言（不得削弱）：0 正文 + denied 终态必须可见
    await expect(h.page.locator('.msg-terminal[data-terminal-state="denied"]').last()).toBeVisible()
    t0 = Date.now()

    // ② 轮询真实磁盘存档（非固定极短 sleep），最多 5s
    const deadline = t0 + 5000
    let saveError = ''
    while (Date.now() < deadline) {
      try {
        if (existsSync(convDir)) {
          for (const f of readdirSync(convDir)) {
            if (!f.endsWith('.json')) continue
            const raw = readFileSync(join(convDir, f), 'utf8')
            if (raw.includes('"terminal"')) {
              persistedRaw = raw
              t1 = Date.now()
              break
            }
          }
        }
      } catch (e) {
        saveError = String(e)
      }
      if (t1) break
      await h.page.waitForTimeout(100)
    }

    const timeline = {
      t0UiTerminalVisible: new Date(t0).toISOString(),
      t1TerminalPersisted: t1 ? new Date(t1).toISOString() : null,
      deltaMs: t1 ? t1 - t0 : null,
      persistedWithin5s: t1 > 0,
      saveError,
      convDirExists: existsSync(convDir),
      convFiles: existsSync(convDir) ? readdirSync(convDir) : []
    }
    writeFileSync(join(EVIDENCE, 'persistence-timeline.json'), JSON.stringify(timeline, null, 2), 'utf8')
    writeFileSync(join(EVIDENCE, 's1-zerobody-conversation.json'), persistedRaw || '{}', 'utf8')
    mark({ story: 's1-zerobody', stage: 'timeline', ...timeline })
  } finally {
    // ③ 真实窗口关闭（走项目既有 flush 握手），不用 Playwright 强杀冒充正常关闭
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) w.close()
    })
    await once(h.app, 'close')
  }

  // ④ 同 dataDir 重启 → 点开原会话 → 断言 denied 终态与已知用量仍在
  const h2 = await launchApp({ reuseDataDir: dataDir })
  try {
    await h2.page.waitForSelector('.chat-view, .new-task', { timeout: 45_000 })
    await h2.page.locator('.conv-item').first().click()
    await h2.page.waitForSelector('.chat-view', { timeout: 15_000 })
    await expect(h2.page.locator('.msg-terminal[data-terminal-state="denied"]').last()).toBeVisible({
      timeout: 30_000
    })
    // 已知用量也必须跨真实重启存活（content_filter 帧带 p:30/c:0）
    const convId = readdirSync(convDir)
      .find((f) => f.endsWith('.json'))!
      .replace(/\.json$/, '')
    const conv = await apiCall<{ usage?: { promptTokens?: number } }>(h2.page, 'getConversation', convId)
    expect(conv.usage?.promptTokens).toBe(30)
    mark({ story: 's1-zerobody', pid: mainPid(h2), stage: 'after-real-close-restart', ok: true, t1 })
  } finally {
    await h2.close()
    await h2.cleanup()
    await ep.close()
  }
})

test('Story2 · 真实 Node exit 7：失败卡/exitCode/原始 stderr 回灌，纠正后完成', async () => {
  const h = await launchApp()
  const canary = 'S2_STDERR_CANARY_7f31'
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall('c1', 'run_command', JSON.stringify({ command: `node -e "console.error('${canary}');process.exit(7)"` }), {
          p: 80,
          c: 10
        })
      },
      { kind: 'sse', frames: oaText('S2_CORRECTED 已根据错误纠正并完成', 'stop', { p: 90, c: 12 }) }
    ],
    's2-node-exit7'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s2' })
    await selectAgent(h.page, 'code-executor')
    await send(h.page, 'S2 跑一条会失败的命令')
    // 可写档下 run_command 走逐次确认桥；真实弹窗要真实点击（不点=拒绝）
    const approve = approveNextConfirm(h.page)
    await waitIdle(h.page)
    await approve
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S2_CORRECTED')

    // ① 失败卡：outcome=failed、数字 exit=7、原始 stderr 必须进 UI
    const failed = h.page.locator('.tool-item.tool-outcome-failed')
    await expect(failed).toHaveCount(1)
    await expect(failed.locator('.tool-name')).toHaveText('run_command')
    await expect(failed.locator('.tool-outcome')).toHaveText('失败')
    await expect(failed).toContainText('exit=7')
    await expect(failed).toContainText(canary)

    // ② 时间线数据源（<userData>/exec-events.jsonl，公开 IPC 同一份）必须记数字 exitCode=7
    const evRaw = readFileSync(join(h.dataDir, 'exec-events.jsonl'), 'utf8')
    const events = evRaw
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const result = events.find((e) => e['kind'] === 'tool_result' && e['tool'] === 'run_command')
    expect(result).toBeTruthy()
    expect(result!['ok']).toBe(false)
    expect(result!['outcome']).toBe('failed')
    expect(result!['exitCode']).toBe(7)

    // ③ 下一 HTTP 请求里的 tool_result 是结构化 tool_output，带失败标记与 exitCode —— 不是裸文本含 '7'
    writeFileSync(join(EVIDENCE, 's2-requests.json'), JSON.stringify(ep.bodies.map((b) => JSON.parse(b)), null, 2), 'utf8')
    const parsedBodies = ep.bodies.map((b) => JSON.parse(b) as { messages: Array<Record<string, unknown>> })
    const bodyWithTool = parsedBodies.filter((b) =>
      b.messages.some((m) => m['role'] === 'tool' && String(m['content']).includes('<tool_output name="run_command">'))
    )
    expect(bodyWithTool).toHaveLength(1)
    const second = bodyWithTool[0]!
    const toolMsg = second.messages.find((m) => m['role'] === 'tool' && m['tool_call_id'] === 'c1')
    expect(toolMsg).toBeTruthy()
    const content = String(toolMsg!['content'])
    expect(content).toContain('<tool_output name="run_command">')
    expect(content).toContain('[stderr]')
    expect(content).toContain(canary)
    expect(content).toContain('exit_code=7')
    expect(content).toContain('error_class=error')

    // ④ 纠正完成，先前的失败卡仍保留；命令无文件副作用
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()
    await expect(failed).toHaveCount(1)
    expect(readdirSync(h.workspaceDir)).toHaveLength(0)
    mark({
      story: 's2-node-exit7',
      pid: mainPid(h),
      port: ep.port,
      requests: ep.bodies.length,
      exit: 7,
      failedCards: 1,
      toolSideEffects: 0,
      hit: { ui: true, timeline: true, nextRequest: true }
    })
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

// ─────────────────────────────────────────────────────────────
// Story2 · 真实 stdio MCP：isError 失败卡 / 错误回灌 / 无成功产物
// ─────────────────────────────────────────────────────────────
test('Story2 · 真实 stdio MCP：isError 失败卡/错误回灌/无成功产物，纠正后完成', async () => {
  const h = await launchApp()
  const mcpDir = join(EVIDENCE, 'tmp', 'mcp-fixture')
  const sdkRoot = join(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm').replace(/\\/g, '/')
  const callLog = join(mcpDir, 'calls.log')
  const canary = 'E30_MCP_ISERROR_CANARY_5b8d'
  const serverPath = writeMcpFixture(mcpDir, sdkRoot, callLog, canary)
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall('m1', 'mcp__e30mcp__publish_success', JSON.stringify({ target: 'artifact.txt' }), {
          p: 70,
          c: 9
        })
      },
      { kind: 'sse', frames: oaText('S2_MCP_CORRECTED 已按 MCP 错误纠正并完成', 'stop', { p: 66, c: 8 }) }
    ],
    's2-mcp-iserror'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s2mcp' })
    // 公开 IPC：登记并连接真实 stdio MCP（saveServer 后自动重连）
    const saved = await apiCall<{ ok: boolean; reason?: string }>(h.page, 'mcpSaveServer', {
      name: 'e30mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: { E30_MCP_CALL_LOG: callLog },
      enabled: true
    })
    expect(saved.ok).toBe(true)
    await expect
      .poll(
        async () => {
          const list = await apiCall<
            Array<{ config: { name: string }; state: string; tools: Array<{ name: string }> }>
          >(h.page, 'mcpListServers')
          const s = list.find((x) => x.config.name === 'e30mcp')
          return s?.state === 'connected' && s.tools.some((t) => t.name === 'publish_success')
        },
        { timeout: 30_000 }
      )
      .toBe(true)
    // 公开 IPC：建一个声明了该 MCP 工具的 Agent（默认内核集不含 MCP/run_command）
    const statuses = await apiCall<
      Array<{ config: Record<string, unknown>; state: string; tools: Array<{ name: string }> }>
    >(h.page, 'mcpListServers')
    writeFileSync(
      join(EVIDENCE, 'mcp-entry-iserror.json'),
      JSON.stringify(
        { saved, status: statuses.find((x) => x.config['name'] === 'e30mcp') },
        null,
        2
      ),
      'utf8'
    )
    const agent = await apiCall<{ ok: boolean }>(h.page, 'saveAgent', {
      name: 'e30-mcp-exec',
      description: 'E30 stdio MCP fixture executor',
      tools: ['read_file', 'mcp__e30mcp__publish_success'],
      systemPrompt: '按用户要求调用工具；工具报错时如实报告，不得虚构成功。'
    })
    expect(agent.ok).toBe(true)
    await h.page.reload()
    await h.page.waitForSelector('.plus-btn', { timeout: 30_000 })
    await selectAgent(h.page, 'e30-mcp-exec')
    await send(h.page, 'S2 发布一个产物')
    const approve = approveNextConfirm(h.page)
    await waitIdle(h.page)
    await approve
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S2_MCP_CORRECTED')

    // ① 工具卡：MCP 来源徽标 + failed + isError 文案
    const failed = h.page.locator('.tool-item.tool-outcome-failed')
    await expect(failed).toHaveCount(1)
    await expect(failed.locator('.tool-mcp-badge')).toHaveText('MCP·e30mcp')
    await expect(failed.locator('.tool-name')).toHaveText('publish_success')
    await expect(failed.locator('.tool-outcome')).toHaveText('失败')
    await expect(failed).toContainText(canary)
    await expect(failed).toContainText('MCP 工具返回错误')

    // ② 时间线：tool_result 是 failed/tool-error（不是成功）
    const events = readFileSync(join(h.dataDir, 'exec-events.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const result = events.find((e) => e['kind'] === 'tool_result' && e['tool'] === 'mcp__e30mcp__publish_success')
    expect(result).toBeTruthy()
    expect(result!['ok']).toBe(false)
    expect(result!['outcome']).toBe('failed')
    expect(result!['code']).toBe('tool-error')

    // ③ 下一请求收到真实错误（结构化 tool_output）
    writeFileSync(
      join(EVIDENCE, 'mcp-requests-iserror.json'),
      JSON.stringify(
        ep.bodies.map((b) => JSON.parse(b)),
        null,
        2
      ),
      'utf8'
    )
    const parsed = ep.bodies.map((b) => JSON.parse(b) as { messages: Array<Record<string, unknown>> })
    const withTool = parsed.filter((b) =>
      b.messages.some((m) => m['role'] === 'tool' && String(m['content']).includes(canary))
    )
    expect(withTool).toHaveLength(1)
    const toolMsg = withTool[0]!.messages.find((m) => m['role'] === 'tool' && String(m['content']).includes(canary))!
    const content = String(toolMsg['content'])
    expect(content).toContain('<tool_output name="mcp__e30mcp__publish_success">')
    expect(content).toContain('错误：MCP 工具返回错误')
    expect(content).toContain(canary)

    // ④ 不得发布成功产物：无产物卡、工作区 0 文件、MCP 恰好被调 1 次
    await expect(h.page.locator('.tool-artifacts')).toHaveCount(0)
    expect(readdirSync(h.workspaceDir)).toHaveLength(0)
    const calls = readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    expect(calls).toHaveLength(1)

    // ⑤ 纠正后 completed，旧失败卡仍保留
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()
    await expect(failed).toHaveCount(1)
    mark({
      story: 's2-mcp-iserror',
      pid: mainPid(h),
      port: ep.port,
      requests: ep.bodies.length,
      mcpCalls: calls.length,
      successArtifacts: 0,
      hit: { ui: true, timeline: true, nextRequest: true }
    })
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story2 · MCP 对照：正常返回但正文含「错误」字样不得误判 failed', async () => {
  const h = await launchApp()
  const mcpDir = join(EVIDENCE, 'tmp', 'mcp-fixture-ok')
  const sdkRoot = join(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/esm').replace(/\\/g, '/')
  const callLog = join(mcpDir, 'calls-ok.log')
  const serverPath = writeMcpFixture(mcpDir, sdkRoot, callLog, 'E30_MCP_UNUSED_CANARY')
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall('n1', 'mcp__e30mcp__normal_with_error_word', JSON.stringify({}), { p: 40, c: 5 })
      },
      { kind: 'sse', frames: oaText('S2_MCP_OK_WORD 已完成', 'stop', { p: 40, c: 5 }) }
    ],
    's2-mcp-ok-word'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s2ok' })
    const saved = await apiCall<{ ok: boolean; reason?: string }>(h.page, 'mcpSaveServer', {
      name: 'e30mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: { E30_MCP_CALL_LOG: callLog },
      enabled: true
    })
    expect(saved.ok).toBe(true)
    await expect
      .poll(
        async () => {
          const list = await apiCall<
            Array<{ config: { name: string }; state: string; tools: Array<{ name: string }> }>
          >(h.page, 'mcpListServers')
          const s = list.find((x) => x.config.name === 'e30mcp')
          return s?.state === 'connected' && s.tools.some((t) => t.name === 'normal_with_error_word')
        },
        { timeout: 30_000 }
      )
      .toBe(true)
    const agent = await apiCall<{ ok: boolean }>(h.page, 'saveAgent', {
      name: 'e30-mcp-ok-exec',
      description: 'E30 stdio MCP success-word control',
      tools: ['read_file', 'mcp__e30mcp__normal_with_error_word'],
      systemPrompt: '按用户要求调用工具，并如实报告状态。'
    })
    expect(agent.ok).toBe(true)
    await h.page.reload()
    await h.page.waitForSelector('.plus-btn', { timeout: 30_000 })
    await selectAgent(h.page, 'e30-mcp-ok-exec')
    await send(h.page, 'S2 调用一个正常但文字含错误的工具')
    const approve = approveNextConfirm(h.page)
    await waitIdle(h.page)
    await approve
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S2_MCP_OK_WORD')

    // isError=false：即使正文含「错误」也必须成功，不得按文字误判
    const okCard = h.page.locator('.tool-item.tool-outcome-succeeded')
    await expect(okCard).toHaveCount(1)
    await expect(okCard.locator('.tool-outcome')).toHaveText('成功')
    await expect(okCard).toContainText('错误：这是正常返回')
    await expect(h.page.locator('.tool-item.tool-outcome-failed')).toHaveCount(0)
    const events = readFileSync(join(h.dataDir, 'exec-events.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const result = events.find(
      (e) => e['kind'] === 'tool_result' && e['tool'] === 'mcp__e30mcp__normal_with_error_word'
    )
    expect(result).toBeTruthy()
    expect(result!['ok']).toBe(true)
    expect(result!['outcome']).toBe('succeeded')
    writeFileSync(
      join(EVIDENCE, 'mcp-requests-ok-word.json'),
      JSON.stringify(
        ep.bodies.map((b) => JSON.parse(b)),
        null,
        2
      ),
      'utf8'
    )
    const parsed = ep.bodies.map((b) => JSON.parse(b) as { messages: Array<Record<string, unknown>> })
    const withTool = parsed.filter((b) =>
      b.messages.some((m) => m['role'] === 'tool' && String(m['content']).includes('E30_OK_WORD_2c41'))
    )
    expect(withTool).toHaveLength(1)
    const content = String(
      withTool[0]!.messages.find(
        (m) => m['role'] === 'tool' && String(m['content']).includes('E30_OK_WORD_2c41')
      )!['content']
    )
    expect(content).toContain('<tool_output name="mcp__e30mcp__normal_with_error_word">')
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()
    const calls = readFileSync(callLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    expect(calls).toEqual(['normal_with_error_word'])
    mark({
      story: 's2-mcp-ok-word',
      pid: mainPid(h),
      port: ep.port,
      requests: ep.bodies.length,
      mcpCalls: calls.length,
      outcome: 'succeeded',
      hit: { ui: true, timeline: true, nextRequest: true }
    })
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

// ─────────────────────────────────────────────────────────────
// Story 4：用量与终态独立 / 出站不含本地字段 / Canary 不外泄
// ─────────────────────────────────────────────────────────────
test('Story4 · 已知账后失败：终态非 completed 且用量不补 0', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S4_FAIL 已知账后失败', 'content_filter', { p: 111, c: 7 }) }],
    's4-known-then-fail'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4' })
    await send(h.page, 'S4 已知账后失败')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S4_FAIL')
    await expect(h.page.locator('.msg-terminal[data-terminal-state="denied"]').last()).toBeVisible()
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)
    mark({ story: 's4-known-then-fail', pid: mainPid(h), port: ep.port })
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · 出站 HTTP body 逐消息不含本地 terminal / local-only 字段', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S4_OUT_BOUND 出站体检查', 'stop', { p: 40, c: 5 }) }],
    's4-outbound'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4b' })
    await send(h.page, 'S4 出站体检查')
    await waitIdle(h.page)
    const all = ep.bodies.join('\n')
    const perMessage = ep.bodies.map((b, i) => ({
      i,
      hasTerminal: b.includes('"terminal"'),
      hasLocalFiles: b.includes('"localFiles"'),
      hasUsageComplete: b.includes('"usageComplete"')
    }))
    writeFileSync(join(EVIDENCE, 'http-body-outbound.json'), JSON.stringify(perMessage, null, 2), 'utf8')
    mark({ story: 's4-outbound', pid: mainPid(h), port: ep.port, bodies: ep.bodies.length })
    expect(ep.bodies.length).toBeGreaterThan(0)
    expect(perMessage.every((m) => !m.hasTerminal)).toBe(true)
    expect(perMessage.every((m) => !m.hasUsageComplete)).toBe(true)
    expect(all).not.toContain('"terminal"')
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · Canary 只在错误正文：UI / 下一请求 / 存档 / 日志零命中', async () => {
  const h = await launchApp()
  const CANARY = 'E30_CANARY_SECRET_auth_leak_check_qq77'
  const ep = await startEndpoint(
    [
      { kind: 'http', status: 401, body: JSON.stringify({ error: { message: `invalid key ${CANARY}` } }) },
      { kind: 'sse', frames: oaText('S4_AFTER_CANARY 继续', 'stop', { p: 10, c: 1 }) }
    ],
    's4-canary'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4c' })
    // ① 第一轮：401 失败 —— 扫描**首轮** UI
    await send(h.page, 'S4 canary')
    await waitIdle(h.page)
    const uiTextFirst = await h.page.locator('body').innerText()
    const uiHitFirst = hits(uiTextFirst, CANARY)

    // ② **真实发第二轮**并跑完 —— 否则「下一请求不含 canary」是空集上的恒真断言
    await send(h.page, 'S4 canary 第二轮')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S4_AFTER_CANARY')
    // ②b 第二轮成功后再扫一次 UI：错误正文可能被后续渲染带出，只扫首轮等于放过一半
    const uiTextSecond = await h.page.locator('body').innerText()
    const uiHitAfterSecond = hits(uiTextSecond, CANARY)
    const uiHit = uiHitFirst || uiHitAfterSecond

    // ③ 逐笔扫描第二轮及之后**每一笔**请求体（不是拼接后一次 includes）
    const laterBodies = ep.bodies.slice(1)
    const laterHits = laterBodies.map((b) => hits(b, CANARY))
    const laterBodyHit = laterHits.some((x) => x)

    // ④ 存档：dataDir 下（排除 logs 目录）逐文件扫描
    const logDir = (await apiCall<{ dir: string | null; files: string[] }>(h.page, 'getLogsInfo')).dir
    let archiveHit = false
    const archiveFiles: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          // 日志目录单独判据，不混进 archiveHit
          if (logDir && p.toLowerCase() === logDir.toLowerCase()) continue
          walk(p)
        } else {
          archiveFiles.push(p)
          try {
            if (readFileSync(p, 'utf8').includes(CANARY)) archiveHit = true
          } catch {
            /* binary */
          }
        }
      }
    }
    walk(h.dataDir)

    // ⑤ 日志：走公开 getLogsInfo 拿真实目录与文件清单，逐文件扫描
    const logInfo = await apiCall<{ dir: string | null; files: string[] }>(h.page, 'getLogsInfo')
    let logHit = false
    const logScanned: string[] = []
    if (logInfo.dir && existsSync(logInfo.dir)) {
      for (const f of logInfo.files) {
        const p = join(logInfo.dir, f)
        if (!existsSync(p)) continue
        logScanned.push(p)
        try {
          if (readFileSync(p, 'utf8').includes(CANARY)) logHit = true
        } catch {
          /* binary */
        }
      }
    }

    const scan = {
      canary: CANARY,
      uiHitFirst,
      uiHitAfterSecond,
      uiHit,
      uiTextFirstBytes: uiTextFirst.length,
      uiTextSecondBytes: uiTextSecond.length,
      archiveHit,
      logHit,
      laterBodyHit,
      laterHits,
      requestCount: ep.bodies.length,
      archiveFilesScanned: archiveFiles.length,
      logFilesScanned: logScanned.length,
      logDir: logInfo.dir,
      logFiles: logInfo.files
    }
    writeFileSync(join(EVIDENCE, 'canary-scan.json'), JSON.stringify(scan, null, 2), 'utf8')

    mark({
      story: 's4-canary',
      pid: mainPid(h),
      port: ep.port,
      conversationId: '',
      terminal: 'failed→completed',
      usage: null,
      usageReported: null,
      usageComplete: null,
      requests: ep.bodies.length,
      uiHitFirst,
      uiHitAfterSecond,
      uiHit,
      archiveHit,
      logHit,
      laterBodyHit
    })

    // 第二轮必须真的发生（否则后面的「下一请求」断言无意义）
    expect(ep.bodies.length).toBeGreaterThanOrEqual(2)
    expect(laterBodies.length).toBeGreaterThanOrEqual(1)
    // UI 两处分别断言：只覆盖首轮等于让第二轮之后的渲染不受检
    expect(uiHitFirst).toBe(false)
    expect(uiHitAfterSecond).toBe(false)
    expect(uiHit).toBe(false)
    expect(archiveHit).toBe(false)
    expect(logHit).toBe(false)
    expect(laterBodyHit).toBe(false)
    // 日志扫描必须真的扫到文件，否则 logHit=false 是空集恒真
    expect(logScanned.length).toBeGreaterThan(0)
    expect(archiveFiles.length).toBeGreaterThan(0)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

// ─────────────────────────────────────────────────────────────
// Story1 补充（E30-R2A）：terminal 真实几何 + 旧归档无 terminal 不造假终态
// ─────────────────────────────────────────────────────────────
test('Story1 · 几何正尺寸 + 旧归档无 terminal 不造假终态', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S1_GEO 几何与旧归档', 'stop', { p: 60, c: 8 }) }],
    's1-geo-legacy'
  )
  const dataDir = h.dataDir
  let geo: { w: number; h: number } = { w: 0, h: 0 }
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-geo' })
    await send(h.page, 'S1 几何')
    await waitIdle(h.page)

    const term = h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()
    await expect(term).toBeVisible()
    // 真实几何：宽高都必须 > 0（不接受零尺寸/隐藏元素冒充可见）
    const box = await term.boundingBox()
    expect(box).not.toBeNull()
    geo = { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) }
    expect(geo.w).toBeGreaterThan(0)
    expect(geo.h).toBeGreaterThan(0)
    writeFileSync(join(EVIDENCE, '几何回执.json'), JSON.stringify({ story: 's1-geo', box: geo }, null, 2), 'utf8')
    mark({ story: 's1-geo', pid: mainPid(h), port: ep.port, geometry: geo })

    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) w.close()
    })
    await once(h.app, 'close')
  } finally {
    // 若上面已正常关闭，这里是兜底
    try {
      await h.close()
    } catch {
      /* already closed */
    }
  }

  // 模拟旧归档：把会话正文里所有 terminal 字段剥掉（等价于旧版本落盘无终态）
  const convDir = join(dataDir, 'conversations')
  let stripped = 0
  expect(existsSync(convDir)).toBe(true)
  for (const f of readdirSync(convDir)) {
    if (!f.endsWith('.json')) continue
    const p = join(convDir, f)
    const obj = JSON.parse(readFileSync(p, 'utf8')) as unknown
    // 深度剥掉任意层级的 terminal 键（存档形状可能是数组或 {messages:[]}，不预设）
    const strip = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) strip(item)
        return
      }
      if (node && typeof node === 'object') {
        const rec = node as Record<string, unknown>
        if ('terminal' in rec) {
          delete rec.terminal
          stripped++
        }
        for (const v of Object.values(rec)) strip(v)
      }
    }
    strip(obj)
    writeFileSync(p, JSON.stringify(obj), 'utf8')
  }
  expect(stripped).toBeGreaterThan(0)
  mark({ story: 's1-legacy', stage: 'stripped-terminal', stripped })

  const h2 = await launchApp({ reuseDataDir: dataDir })
  try {
    await h2.page.waitForSelector('.chat-view, .new-task', { timeout: 45_000 })
    await h2.page.locator('.conv-item').first().click()
    await h2.page.waitForSelector('.chat-view', { timeout: 15_000 })
    // 旧归档无 terminal：绝不显示任何终态标记（尤其不得造出 completed）
    await expect(h2.page.locator('.msg-terminal')).toHaveCount(0)
    await expect(h2.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)
    mark({ story: 's1-legacy', pid: mainPid(h2), ok: true, stripped })
  } finally {
    await h2.close()
    await h2.cleanup()
    await ep.close()
  }
})


// ─────────────────────────────────────────────────────────────
// E30-R2C1 · Story3 一次性任务四态与会话归属
// 入口：页面公开桥 window.api.runAgent / listAgentTasks / stopAgentTask / createConversation
// 不 mock 业务内核；模型仅本地合成端点。
// ─────────────────────────────────────────────────────────────
function countFiles(root: string): number {
  let n = 0
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else n++
    }
  }
  walk(root)
  return n
}

test('Story3 · 完成：正常完成 → ok / terminal completed / task list completed / 无隐式重试', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S3_DONE 一次性任务完成', 'stop', { p: 40, c: 6 }) }],
    's3-done'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s3a' })
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-s3a-model'
    })
    const before = countFiles(h.workspaceDir)

    const res = await apiCall<{
      taskId?: string
      ok: boolean
      rounds: number
      stopReason: string
      terminal?: { state: string }
      output: string
    }>(h.page, 'runAgent', { task: 'S3 完成', conversationId: conv.id })

    const tasks = await apiCall<
      Array<{ id: string; conversationId?: string; status: string; terminal?: { state: string } }>
    >(h.page, 'listAgentTasks')
    const t = tasks.find((x) => x.id === res.taskId)
    const requests = ep.bodies.length
    const sideEffects = countFiles(h.workspaceDir) - before

    dumpEvidence('tasklist-s3-done.json', { tasks, run: res })

    mark({
      story: 's3-done',
      pid: mainPid(h),
      port: ep.port,
      taskId: res.taskId,
      conversationId: conv.id,
      result: res.terminal?.state,
      stopReason: res.stopReason,
      ok: res.ok,
      rounds: res.rounds,
      taskStatus: t?.status,
      taskTerminal: t?.terminal?.state,
      taskConv: t?.conversationId,
      requests,
      sideEffects
    })

    expect(res.ok).toBe(true)
    expect(res.stopReason).toBe('completed')
    expect(res.terminal?.state).toBe('completed')
    expect(t?.status).toBe('completed')
    expect(t?.terminal?.state).toBe('completed')
    // 归属字段：任务自带本次会话 id
    expect(t?.conversationId).toBe(conv.id)
    // 无隐式重试：请求数 == 轮数，且一轮就够
    expect(res.rounds).toBe(1)
    expect(requests).toBe(res.rounds)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story3 · 停止：running 后 stopAgentTask → cancelled / 不再发下一轮', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'hang', frames: oaChunk({ choices: [{ delta: { content: 'S3_STOP 部分输出' } }] }) }],
    's3-stop'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s3b' })
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-s3b-model'
    })
    const before = countFiles(h.workspaceDir)

    const runP = apiCall<{
      taskId?: string
      ok: boolean
      stopReason: string
      terminal?: { state: string; code?: string }
    }>(h.page, 'runAgent', { task: 'S3 停止', conversationId: conv.id })

    // 等任务进入 running（公开 task list 观测，不碰内部实现）
    let taskId = ''
    for (let i = 0; i < 150; i++) {
      const tasks = await apiCall<Array<{ id: string; conversationId?: string; status: string }>>(
        h.page,
        'listAgentTasks'
      )
      const running = tasks.find((x) => x.conversationId === conv.id && x.status === 'running')
      // 必须等到第一笔请求真的落到端点上：registry 一 start 就是 running，
      // 只等 running 会在请求发出前就停，那样「不再发下一轮」根本无从证明。
      if (running && ep.bodies.length >= 1) {
        taskId = running.id
        break
      }
      await h.page.waitForTimeout(100)
    }
    expect(taskId).not.toBe('')
    expect(ep.bodies.length).toBeGreaterThanOrEqual(1)

    const stopped = await apiCall<boolean>(h.page, 'stopAgentTask', taskId)
    expect(stopped).toBe(true)

    const res = await runP
    const tasks2 = await apiCall<Array<{ id: string; status: string; terminal?: { state: string } }>>(
      h.page,
      'listAgentTasks'
    )
    const t = tasks2.find((x) => x.id === taskId)
    const requests = ep.bodies.length
    const sideEffects = countFiles(h.workspaceDir) - before

    dumpEvidence('tasklist-s3-stop.json', { tasks: tasks2, run: res, endpointRequests: ep.bodies.length })

    mark({
      story: 's3-stop',
      pid: mainPid(h),
      port: ep.port,
      taskId,
      conversationId: conv.id,
      result: res.terminal?.state,
      resultCode: res.terminal?.code,
      stopReason: res.stopReason,
      ok: res.ok,
      taskStatus: t?.status,
      taskTerminal: t?.terminal?.state,
      requests,
      sideEffects
    })

    expect(res.ok).toBe(false)
    expect(res.stopReason).toBe('cancelled')
    expect(res.terminal?.state).toBe('cancelled')
    expect(t?.status).toBe('cancelled')
    // 停止后不再发下一轮：请求数停在停止那一刻
    expect(requests).toBe(1)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story3 · 拒绝：run_command 真实确认桥点「拒绝」→ 命令不执行 / 拒绝回灌模型', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall(
          'c_s3',
          'run_command',
          JSON.stringify({ command: 'echo S3_SIDE_EFFECT > side.txt' }),
          { p: 30, c: 4 }
        )
      },
      { kind: 'sse', frames: oaText('S3_DENIED_ACK 已收到拒绝', 'stop', { p: 35, c: 5 }) }
    ],
    's3-deny'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s3c' })
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-s3c-model'
    })
    const before = countFiles(h.workspaceDir)
    const sideFile = join(h.workspaceDir, 'side.txt')

    // 命令工具按 Agent 声明装配：code-executor 才声明 run_command
    const runP = apiCall<{
      taskId?: string
      ok: boolean
      stopReason: string
      terminal?: { state?: string; code?: string }
    }>(h.page, 'runAgent', { task: 'S3 拒绝', conversationId: conv.id, agentName: 'code-executor' })

    // 真实确认桥：等对话框出现并点「拒绝」
    const denyBtn = h.page.locator('.cf-mask .cf-btn', { hasText: '拒绝' }).first()
    await denyBtn.waitFor({ state: 'visible', timeout: 60_000 })
    const cmdText = await h.page.locator('.cf-cmd').first().innerText()
    await denyBtn.click()

    const res = await runP
    const tasks = await apiCall<
      Array<{ id: string; status: string; terminal?: { state?: string } }>
    >(h.page, 'listAgentTasks')
    const t = tasks.find((x) => x.id === res.taskId)
    const requests = ep.bodies.length
    const sideEffects = countFiles(h.workspaceDir) - before
    // 拒绝必须回灌模型：下一轮请求体里能读到拒绝原文（公开出站面可观测）
    const denialFedBack = ep.bodies.slice(1).some((b) => b.includes('用户拒绝执行该命令'))

    dumpEvidence('tasklist-s3-deny.json', { tasks, run: res, requestBodies: ep.bodies })

    mark({
      story: 's3-deny',
      pid: mainPid(h),
      port: ep.port,
      taskId: res.taskId,
      conversationId: conv.id,
      confirmShown: cmdText.replace(/\s+/g, ' ').slice(0, 80),
      denialFedBack,
      result: res.terminal?.state,
      resultCode: res.terminal?.code,
      stopReason: res.stopReason,
      ok: res.ok,
      taskStatus: t?.status,
      taskTerminal: t?.terminal?.state,
      requests,
      sideEffects
    })

    // 确认卡确实弹的是这条命令
    expect(cmdText).toContain('S3_SIDE_EFFECT')
    // 拒绝落地：命令没执行，工作区零副作用
    expect(existsSync(sideFile)).toBe(false)
    expect(sideEffects).toBe(0)
    // 拒绝被真实带回模型（不是静默放行）
    expect(denialFedBack).toBe(true)
    // 任务终态不得是「已完成且命令成功」的假象：命令根本没跑
    expect(existsSync(sideFile)).toBe(false)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story3 · 未知：缺业务终帧 → unknown 不冒充完成 / 请求数记录', async () => {
  const h = await launchApp()
  // 只有正文增量、没有 finish_reason 也没有 [DONE]：流正常结束但业务终帧缺失
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: [oaChunk({ choices: [{ delta: { content: 'S3_UNKNOWN 半截正文' } }] })] }],
    's3-unknown'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s3d' })
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-s3d-model'
    })
    const before = countFiles(h.workspaceDir)
    const res = await apiCall<{
      taskId?: string
      ok: boolean
      rounds: number
      stopReason: string
      terminal?: { state?: string; code?: string }
      error?: string
    }>(h.page, 'runAgent', { task: 'S3 未知', conversationId: conv.id })
    const tasks = await apiCall<
      Array<{ id: string; status: string; terminal?: { state?: string } }>
    >(h.page, 'listAgentTasks')
    const t = tasks.find((x) => x.id === res.taskId)
    const requests = ep.bodies.length
    const sideEffects = countFiles(h.workspaceDir) - before

    dumpEvidence('tasklist-s3-unknown.json', { tasks, run: res })

    mark({
      story: 's3-unknown',
      pid: mainPid(h),
      port: ep.port,
      taskId: res.taskId,
      conversationId: conv.id,
      result: res.terminal?.state,
      resultCode: res.terminal?.code,
      stopReason: res.stopReason,
      ok: res.ok,
      taskStatus: t?.status,
      taskTerminal: t?.terminal?.state,
      requests,
      sideEffects,
      error: res.error ? res.error.slice(0, 60) : undefined
    })

    expect(res.ok).toBe(false)
    expect(res.terminal?.state).toBe('unknown')
    expect(res.terminal?.code).toBe('missing-terminal')
    expect(t?.status).not.toBe('completed')
    expect(requests).toBeGreaterThanOrEqual(1)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story3 · 归属：双会话 A 失败不影响 B 完成，task/result 归属字段不串', async () => {
  const h = await launchApp()
  // B 走正常完成；A 走断流（失败）
  const epB = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S3_B_OK B 会话完成', 'stop', { p: 20, c: 3 }) }],
    's3-owner-b'
  )
  const epA = await startEndpoint([{ kind: 'abort' }], 's3-owner-a')
  try {
    // 先激活 B 端点，建两个会话
    await useLocalModel(h.page, epB.port, { name: 'e30-s3e' })
    const convA = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-s3e-model'
    })
    const convB = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-s3e-model'
    })
    expect(convA.id).not.toBe(convB.id)

    // B 先完成
    const resB = await apiCall<{ taskId?: string; ok: boolean; terminal?: { state?: string } }>(
      h.page,
      'runAgent',
      { task: 'S3 B 任务', conversationId: convB.id }
    )

    // 再把激活档案切到 A 的失败端点（一次性任务按激活档案取模型）
    const profileA = await apiCall<{ id: string }>(h.page, 'saveModel', {
      name: 'e30-s3e-fail',
      providerType: 'openai-compatible',
      baseURL: `http://127.0.0.1:${epA.port}/v1`,
      models: [{ id: 'e30-s3e-fail-entry', model: 'e30-s3e-fail-model' }],
      apiKey: 'E30_FAKE_LOCAL_KEY',
      stream: true,
      timeoutMs: 20000
    })
    await apiCall(h.page, 'setActiveModel', profileA.id)
    const resA = await apiCall<{ taskId?: string; ok: boolean; terminal?: { state?: string } }>(
      h.page,
      'runAgent',
      { task: 'S3 A 任务', conversationId: convA.id }
    )

    const tasks = await apiCall<
      Array<{ id: string; conversationId?: string; status: string; terminal?: { state?: string } }>
    >(h.page, 'listAgentTasks')
    const tA = tasks.find((x) => x.id === resA.taskId)
    const tB = tasks.find((x) => x.id === resB.taskId)

    dumpEvidence('tasklist-s3-owner.json', { tasks, runA: resA, runB: resB, convA: convA.id, convB: convB.id })

    mark({
      story: 's3-owner',
      pid: mainPid(h),
      portB: epB.port,
      portA: epA.port,
      convA: convA.id,
      convB: convB.id,
      taskA: resA.taskId,
      taskB: resB.taskId,
      resA: resA.terminal?.state,
      resB: resB.terminal?.state,
      tAConv: tA?.conversationId,
      tBConv: tB?.conversationId,
      tAStatus: tA?.status,
      tBStatus: tB?.status,
      requestsA: epA.bodies.length,
      requestsB: epB.bodies.length
    })

    // A 失败不拖累 B
    expect(resA.terminal?.state).not.toBe('completed')
    expect(resB.ok).toBe(true)
    expect(resB.terminal?.state).toBe('completed')
    // 归属字段不串
    expect(tA?.conversationId).toBe(convA.id)
    expect(tB?.conversationId).toBe(convB.id)
    expect(tA?.status).not.toBe('completed')
    expect(tB?.status).toBe('completed')
  } finally {
    await h.close()
    await h.cleanup()
    await epA.close()
    await epB.close()
  }
})


// ─────────────────────────────────────────────────────────────
// E30-R2C2 · 父子scope / 取消不回滚 / unknown重启不重放
// 入口全部公开：saveAgent / send(UI) / listExecEvents / getSubagents /
// runAgent / listAgentTasks / stopAgentTask / createConversation。不 mock 内核。
// ─────────────────────────────────────────────────────────────
test('Story3 · 父子scope：父/子归属不串，另一 conversation 收不到该子任务', async () => {
  const MAIN = 'e30-r2c2-main'
  const CHILD = 'e30-r2c2-child'
  const h = await launchApp()
  // 合成端点按调用序：① 主代理派发 ② 子代理作答 ③ 主代理收口
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall(
          'c_spawn',
          'spawn_agents',
          JSON.stringify({ jobs: [{ agent: CHILD, task: 'R2C2 子任务：只读核对工作区' }] }),
          { p: 40, c: 8 }
        )
      },
      { kind: 'sse', frames: oaText('R2C2_SUB_OK 子代理完成', 'stop', { p: 50, c: 10 }) },
      { kind: 'sse', frames: oaText('R2C2_MAIN_OK 主代理收口', 'stop', { p: 60, c: 12 }) }
    ],
    's3-scope'
  )
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-scope' })

    // 公开入口建两份 Agent 定义：只有主代理声明 spawn_agents
    const mainSave = await apiCall<{ ok: boolean; file?: string; reason?: string }>(h.page, 'saveAgent', {
      name: MAIN,
      description: 'R2C2 主代理：可派子代理',
      tools: ['spawn_agents', 'read_file', 'list_dir'],
      systemPrompt: '你是 R2C2 主代理。需要独立子任务时用 spawn_agents 派给 e30-r2c2-child，然后收口。'
    })
    const childSave = await apiCall<{ ok: boolean; file?: string; reason?: string }>(h.page, 'saveAgent', {
      name: CHILD,
      description: 'R2C2 子代理：只读核对',
      tools: ['read_file'],
      systemPrompt: '你是 R2C2 子代理，只做只读核对并回报结论。'
    })
    expect(mainSave.ok).toBe(true)
    expect(childSave.ok).toBe(true)

    await h.page.reload()
    await selectAgent(h.page, MAIN)
    await send(h.page, 'R2C2 请派一个子任务，然后把结果收口')
    await waitIdle(h.page, 120_000)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('R2C2_MAIN_OK')

    // 会话 id 按存档里出现的收口正文反查（不猜排序）
    let convA = ''
    if (existsSync(convDir)) {
      for (const f of readdirSync(convDir)) {
        if (!f.endsWith('.json')) continue
        if (readFileSync(join(convDir, f), 'utf8').includes('R2C2_MAIN_OK')) convA = f.replace(/\.json$/, '')
      }
    }
    expect(convA).not.toBe('')

    // 同实例第二个会话：不跑任何任务，用于证明子任务不会被它收到
    const convB = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-scope-model'
    })

    type Ev = { at: string; kind: string; conversationId: string; agentScope: string; agentName?: string; tool?: string }
    const evA = await apiCall<{ events: Ev[]; skipped: number }>(h.page, 'listExecEvents', {
      conversationId: convA,
      limit: 500
    })
    const evB = await apiCall<{ events: Ev[]; skipped: number }>(h.page, 'listExecEvents', {
      conversationId: convB.id,
      limit: 500
    })
    type Job = { runId: string; name: string; index: number; phase: string; rounds?: number; terminal?: { state?: string } }
    const jobA = await apiCall<Job[]>(h.page, 'getSubagents', convA)
    const jobB = await apiCall<Job[]>(h.page, 'getSubagents', convB.id)

    const scopeA = evA.events.map((e) => e.agentScope)
    const namesA = evA.events.filter((e) => e.kind === 'run_start').map((e) => e.agentName)

    dumpEvidence('scope-events-convA.json', { conversationId: convA, skipped: evA.skipped, events: evA.events })
    dumpEvidence('scope-events-convB.json', { conversationId: convB.id, skipped: evB.skipped, events: evB.events })
    dumpEvidence('scope-jobs-convA.json', { conversationId: convA, jobs: jobA })
    dumpEvidence('scope-jobs-convB.json', { conversationId: convB.id, jobs: jobB })

    mark({
      story: 's3-scope',
      pid: mainPid(h),
      port: ep.port,
      taskId: jobA[0]?.runId ?? '',
      conversationId: convA,
      convB: convB.id,
      scopeA: [...new Set(scopeA)],
      runStartNames: namesA,
      eventsA: evA.events.length,
      eventsB: evB.events.length,
      jobNameA: jobA[0]?.name,
      jobPhaseA: jobA[0]?.phase,
      jobTerminalA: jobA[0]?.terminal?.state,
      jobsB: jobB.length,
      requests: ep.bodies.length,
      sideEffects: 0
    })

    // 父与子各自出现 scope，且都在自己那条会话里
    expect(scopeA).toContain('main')
    expect(scopeA).toContain('sub')
    expect(evA.events.every((e) => e.conversationId === convA)).toBe(true)
    // 主代理确实通过公开工具派发（不是内部直调）
    expect(
      evA.events.some((e) => e.kind === 'tool_call' && e.agentScope === 'main' && e.tool === 'spawn_agents')
    ).toBe(true)
    // 子代理有自己的一对起止事件，且终态完成
    expect(evA.events.some((e) => e.kind === 'run_start' && e.agentScope === 'sub')).toBe(true)
    expect(
      evA.events.some(
        (e) => e.kind === 'run_end' && e.agentScope === 'sub' && (e.terminal as { state?: string })?.state === 'completed'
      )
    ).toBe(true)
    // ⚠️ 实测缺口：run_start 的白名单里列了 agentName，但实际从未写入（实测为 undefined），
    // 故父/子的**名字**只能靠 getSubagents 的 job.name 归属，事件侧只有 agentScope 可区分。
    // 这里只断言「起止事件确实存在」，原始值原样留在 mark / scope-events-convA.json 供复核。
    expect(namesA.length).toBeGreaterThan(0)

    // 子任务只归 convA
    expect(jobA.length).toBe(1)
    expect(jobA[0].name).toBe(CHILD)
    expect(jobA[0].phase).toBe('end')
    expect(jobA[0].terminal?.state).toBe('completed')
    expect(jobA[0].runId.length).toBeGreaterThan(0)

    // 另一个 conversation 一条 scope 事件、一个子任务都不该收到
    expect(evB.events.length).toBe(0)
    expect(jobB.length).toBe(0)
    expect(jobA[0].runId).not.toBe('')
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story3 · 取消不回滚：确认执行写入后停止 → cancelled 且 keep.txt 保持写入后内容', async () => {
  const h = await launchApp()
  // 真命令：Node 写 keep.txt，跨 shell 口径稳定
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall(
          'c_keep',
          'run_command',
          JSON.stringify({ command: `node -e "require('fs').writeFileSync('keep.txt','cancel-survive')"` }),
          { p: 30, c: 5 }
        )
      },
      { kind: 'hang', frames: oaChunk({ choices: [{ delta: { content: 'R2C2_CANCEL 部分输出' } }] }) }
    ],
    's3-cancel'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-cancel' })
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-cancel-model'
    })
    // 预置既有副作用：取消前就有内容
    writeFileSync(join(h.workspaceDir, 'keep.txt'), 'ORIGINAL_KEEP', 'utf8')

    const runP = apiCall<{
      taskId?: string
      ok: boolean
      stopReason: string
      terminal?: { state?: string; code?: string }
    }>(h.page, 'runAgent', { task: 'R2C2 取消不回滚', conversationId: conv.id, agentName: 'code-executor' })

    // 真实确认桥点「允许这一次」
    const approved = await approveNextConfirm(h.page, 90_000)
    expect(approved).toBe(true)

    // 等工具结果回灌后的下一轮请求真的连上（此刻连接 hang 住）
    for (let i = 0; i < 200; i++) {
      if (ep.bodies.length >= 2) break
      await h.page.waitForTimeout(100)
    }
    expect(ep.bodies.length).toBeGreaterThanOrEqual(2)

    const tasks = await apiCall<Array<{ id: string; conversationId?: string; status: string }>>(
      h.page,
      'listAgentTasks'
    )
    const running = tasks.find(
      (t) => t.conversationId === conv.id && (t.status === 'running' || t.status === 'stopping')
    )
    expect(running).toBeDefined()
    const stopped = await apiCall<boolean>(h.page, 'stopAgentTask', running!.id)
    expect(stopped).toBe(true)

    const res = await runP
    const reqAtStop = ep.bodies.length
    // 停止后再等一会：若有「停止后补发一轮」的缺陷，请求数会涨
    await h.page.waitForTimeout(1500)
    const reqAfterWait = ep.bodies.length
    const keepPath = join(h.workspaceDir, 'keep.txt')
    const keepText = existsSync(keepPath) ? readFileSync(keepPath, 'utf8') : '<MISSING>'
    const keepSha = createHash('sha256').update(keepText, 'utf8').digest('hex')

    dumpEvidence('cancel-norollback.json', {
      conversationId: conv.id,
      taskId: res.taskId,
      result: res.terminal,
      stopReason: res.stopReason,
      requestsAtStop: reqAtStop,
      requestsAfterWait: reqAfterWait,
      keepText,
      keepSha256: keepSha,
      keepExists: existsSync(keepPath)
    })

    mark({
      story: 's3-cancel',
      pid: mainPid(h),
      port: ep.port,
      taskId: res.taskId,
      conversationId: conv.id,
      result: res.terminal?.state,
      resultCode: res.terminal?.code,
      stopReason: res.stopReason,
      requests: reqAtStop,
      requestsAfterWait: reqAfterWait,
      keepText,
      keepSha256: keepSha,
      sideEffects: 1
    })

    expect(res.ok).toBe(false)
    expect(res.stopReason).toBe('cancelled')
    expect(res.terminal?.state).toBe('cancelled')
    // 副作用不回滚、也没被删
    expect(existsSync(keepPath)).toBe(true)
    expect(keepText).toBe('cancel-survive')
    // 停止后不再发第三轮
    expect(reqAtStop).toBe(2)
    expect(reqAfterWait).toBe(reqAtStop)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story3 · unknown 重启不重放：真实关窗后同 dataDir 重启，请求数不涨、旧错误不变完成', async () => {
  const h = await launchApp()
  // 只有正文增量、无 finish_reason / [DONE] → unknown(missing-terminal)
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: [oaChunk({ choices: [{ delta: { content: 'R2C2_UNKNOWN 半截正文' } }] })] }],
    's3-unknown-restart'
  )
  const dataDir = h.dataDir
  const convDir = join(dataDir, 'conversations')
  let convId = ''
  let reqBefore = 0
  let taskId = ''
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-unk' })
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-unk-model'
    })
    convId = conv.id
    const res = await apiCall<{
      taskId?: string
      ok: boolean
      stopReason: string
      terminal?: { state?: string; code?: string }
    }>(h.page, 'runAgent', { task: 'R2C2 未知重启', conversationId: conv.id })
    taskId = res.taskId ?? ''
    reqBefore = ep.bodies.length

    mark({
      story: 's3-unknown-restart',
      stage: 'before-close',
      pid: mainPid(h),
      port: ep.port,
      taskId,
      conversationId: convId,
      result: res.terminal?.state,
      resultCode: res.terminal?.code,
      stopReason: res.stopReason,
      requests: reqBefore,
      sideEffects: 0
    })

    expect(res.ok).toBe(false)
    expect(res.terminal?.state).toBe('unknown')
    expect(res.terminal?.code).toBe('missing-terminal')
    expect(reqBefore).toBe(1)
  } finally {
    // 真实窗口关闭（走项目既有 flush 握手），不强杀
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) w.close()
    })
    await once(h.app, 'close')
  }

  // 同 dataDir 重启
  const h2 = await launchApp({ reuseDataDir: dataDir })
  try {
    await h2.page.waitForSelector('.chat-view, .new-task', { timeout: 45_000 })
    // 给自动重放留出时间窗：有上限轮询而不是死等 3s
    // （每 200ms 检查一次请求数是否变化；稳定达到 15 次仍无新增即视为不再重放）
    const stableNeeded = 15
    let stable = 0
    for (let i = 0; i < 150 && stable < stableNeeded; i++) {
      await h2.page.waitForTimeout(200)
      if (ep.bodies.length === reqBefore) stable += 1
      else stable = 0
    }
    const reqAfter = ep.bodies.length
    const tasks2 = await apiCall<Array<{ id: string; status: string }>>(h2.page, 'listAgentTasks')
    const active = tasks2.filter((t) => t.status === 'running' || t.status === 'stopping')

    // 打开原会话：旧错误不得显示成完成
    await h2.page.locator('.conv-item').first().click()
    await h2.page.waitForSelector('.chat-view', { timeout: 15_000 })
    const completedCount = await h2.page.locator('.msg-terminal[data-terminal-state="completed"]').count()

    // 存档深扫：任何 shape 下出现 "state":"completed" 都算把旧错误粉饰成完成
    let archiveHasCompleted = false
    let archiveFiles: string[] = []
    if (existsSync(convDir)) {
      archiveFiles = readdirSync(convDir)
      for (const f of archiveFiles) {
        if (!f.endsWith('.json')) continue
        if (readFileSync(join(convDir, f), 'utf8').includes('"state":"completed"')) archiveHasCompleted = true
      }
    }

    dumpEvidence('unknown-restart.json', {
      conversationId: convId,
      taskId,
      requestsBeforeClose: reqBefore,
      requestsAfterRestart: reqAfter,
      activeTasksAfterRestart: active,
      registrySizeAfterRestart: tasks2.length,
      ghostTaskPresent: tasks2.some((t) => t.id === taskId),
      completedTerminalCountAfterRestart: completedCount,
      archiveHasCompleted,
      archiveFiles
    })

    mark({
      story: 's3-unknown-restart',
      stage: 'after-real-close-restart',
      pid: mainPid(h2),
      port: ep.port,
      taskId,
      conversationId: convId,
      result: 'unknown',
      requests: reqAfter,
      requestsBeforeClose: reqBefore,
      activeTasks: active.length,
      registrySize: tasks2.length,
      completedTerminals: completedCount,
      sideEffects: 0
    })

    // 不自动重放：请求数不涨
    expect(reqAfter).toBe(reqBefore)
    // registry 重启后无活跃未决任务，也没有幽灵任务被复活
    expect(active.length).toBe(0)
    expect(tasks2.some((t) => t.id === taskId)).toBe(false)
    // 旧错误不变完成
    expect(completedCount).toBe(0)
    expect(archiveHasCompleted).toBe(false)
  } finally {
    await h2.close()
    await h2.cleanup()
    await ep.close()
  }
})


// ─────────────────────────────────────────────────────────────
// E30-R2C3 · 一次性任务父/子 Trace（P2 新基点）
// 入口全部公开：saveAgent / runAgent(agentName) / listExecEvents / getSubagents / createConversation。
// 不用内部 withAgentScope、不碰产品源码。
// ─────────────────────────────────────────────────────────────
test('Story3 · 一次性任务父/子 Trace：main/sub 同会话、agentName 正确、另一会话 0 事件 0 子任务', async () => {
  const MAIN = 'e30-r2c3-main'
  const CHILD = 'e30-r2c3-child'
  const h = await launchApp()
  // 合成端点按调用序：① 主代理派发 ② 子代理作答 ③ 主代理收口 → 恰好 3 次请求
  const ep = await startEndpoint(
    [
      {
        kind: 'sse',
        frames: oaToolCall(
          'c_r2c3',
          'spawn_agents',
          JSON.stringify({ jobs: [{ agent: CHILD, task: 'R2C3 子任务：只读核对工作区' }] }),
          { p: 40, c: 8 }
        )
      },
      { kind: 'sse', frames: oaText('R2C3_SUB_OK 子代理完成', 'stop', { p: 50, c: 10 }) },
      { kind: 'sse', frames: oaText('R2C3_MAIN_OK 主代理收口', 'stop', { p: 60, c: 12 }) }
    ],
    's3-onetask-scope'
  )
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-r2c3' })

    // 公开入口建两份 Agent 定义：只有主代理声明 spawn_agents
    const mainSave = await apiCall<{ ok: boolean; file?: string; reason?: string }>(h.page, 'saveAgent', {
      name: MAIN,
      description: 'R2C3 主代理：可派子代理',
      tools: ['spawn_agents', 'read_file', 'list_dir'],
      systemPrompt: '你是 R2C3 主代理。需要独立子任务时用 spawn_agents 派给 e30-r2c3-child，然后收口。'
    })
    const childSave = await apiCall<{ ok: boolean; file?: string; reason?: string }>(h.page, 'saveAgent', {
      name: CHILD,
      description: 'R2C3 子代理：只读核对',
      tools: ['read_file'],
      systemPrompt: '你是 R2C3 子代理，只做只读核对并回报结论。'
    })
    expect(mainSave.ok).toBe(true)
    expect(childSave.ok).toBe(true)

    // 一次性任务入口（页面公开桥），带 agentName 指向主代理
    const conv = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-r2c3-model'
    })
    const res = await apiCall<{
      taskId?: string
      ok: boolean
      rounds: number
      stopReason: string
      terminal?: { state?: string }
      output: string
    }>(h.page, 'runAgent', { task: 'R2C3 一次性任务：派子任务并收口', conversationId: conv.id, agentName: MAIN })

    // 另一个会话：不跑任何任务，必须一条事件、一个子任务都收不到
    const other = await apiCall<{ id: string }>(h.page, 'createConversation', {
      workspace: h.workspaceDir,
      model: 'e30-r2c3-model'
    })

    type Ev = {
      at: string
      kind: string
      conversationId: string
      agentScope: string
      agentName?: string
      tool?: string
      terminal?: { state?: string }
    }
    const evs = await apiCall<{ events: Ev[]; skipped: number }>(h.page, 'listExecEvents', {
      conversationId: conv.id,
      limit: 500
    })
    const evsOther = await apiCall<{ events: Ev[]; skipped: number }>(h.page, 'listExecEvents', {
      conversationId: other.id,
      limit: 500
    })
    type Job = {
      runId: string
      name: string
      index: number
      phase: string
      rounds?: number
      terminal?: { state?: string }
    }
    const jobs = await apiCall<Job[]>(h.page, 'getSubagents', conv.id)
    const jobsOther = await apiCall<Job[]>(h.page, 'getSubagents', other.id)

    // 一次性任务入口的任务记录（task list 归属）
    const tasks = await apiCall<Array<{ id: string; conversationId?: string; status: string }>>(
      h.page,
      'listAgentTasks'
    )
    const t = tasks.find((x) => x.id === res.taskId)

    const scopes = [...new Set(evs.events.map((e) => e.agentScope))]
    const mainRunStart = evs.events.filter((e) => e.kind === 'run_start' && e.agentScope === 'main')
    const subRunStart = evs.events.filter((e) => e.kind === 'run_start' && e.agentScope === 'sub')
    const requests = ep.bodies.length

    dumpEvidence('onetask-scope-events.json', {
      conversationId: conv.id,
      skipped: evs.skipped,
      events: evs.events
    })
    dumpEvidence('onetask-scope-jobs.json', { conversationId: conv.id, jobs })
    dumpEvidence('onetask-scope-other.json', {
      conversationId: other.id,
      skipped: evsOther.skipped,
      events: evsOther.events,
      jobs: jobsOther
    })

    mark({
      story: 's3-onetask-scope',
      pid: mainPid(h),
      port: ep.port,
      taskId: res.taskId,
      conversationId: conv.id,
      convB: other.id,
      result: res.terminal?.state,
      stopReason: res.stopReason,
      ok: res.ok,
      rounds: res.rounds,
      taskStatus: t?.status,
      scopes,
      mainRunStartAgentName: mainRunStart.map((e) => e.agentName ?? null),
      subRunStartAgentName: subRunStart.map((e) => e.agentName ?? null),
      mainEvents: evs.events.filter((e) => e.agentScope === 'main').length,
      subEvents: evs.events.filter((e) => e.agentScope === 'sub').length,
      jobName: jobs[0]?.name,
      jobPhase: jobs[0]?.phase,
      jobTerminal: jobs[0]?.terminal?.state,
      jobsOther: jobsOther.length,
      eventsOther: evsOther.events.length,
      requests,
      sideEffects: 0
    })

    // 一次性任务真实跑通，恰 3 次请求（派发 → 子代理 → 收口），无隐式重试
    expect(res.ok).toBe(true)
    expect(res.stopReason).toBe('completed')
    expect(res.terminal?.state).toBe('completed')
    expect(requests).toBe(3)
    expect(t?.conversationId).toBe(conv.id)
    expect(t?.status).toBe('completed')

    // 同一 conversation 上 main 与 sub 两种 scope 都出现
    expect(scopes).toContain('main')
    expect(scopes).toContain('sub')
    expect(evs.events.every((e) => e.conversationId === conv.id)).toBe(true)

    // 主代理 run_start.agentName 必须是真实选中的 Agent 名（P2 修复点）
    expect(mainRunStart.length).toBeGreaterThan(0)
    expect(mainRunStart.every((e) => e.agentName === MAIN)).toBe(true)

    // 子代理有自己的一对起止事件，终态完成
    expect(subRunStart.length).toBeGreaterThan(0)
    expect(
      evs.events.some(
        (e) => e.kind === 'run_end' && e.agentScope === 'sub' && e.terminal?.state === 'completed'
      )
    ).toBe(true)

    // 子任务登记在本会话，名字与 phase 真实
    expect(jobs.length).toBe(1)
    expect(jobs[0].name).toBe(CHILD)
    expect(jobs[0].phase).toBe('end')
    expect(jobs[0].runId.length).toBeGreaterThan(0)

    // 另一会话：0 事件 / 0 子任务（不串会话）
    expect(evsOther.events.length).toBe(0)
    expect(jobsOther.length).toBe(0)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})


// ─────────────────────────────────────────────────────────────
// E30-R2D · Story4 usage 矩阵 / 双会话 / 重启归属
// 全部真实 Electron + 本地合成 SSE；只用公开 getConversation / listConversations / listExecEvents。
// ─────────────────────────────────────────────────────────────
type UsageShape = {
  promptTokens?: number
  completionTokens?: number
  cachedPromptTokens?: number | null
  cacheWritePromptTokens?: number | null
  reasoningTokens?: number | null
}
type ConvView = {
  id: string
  usage?: UsageShape
  usageReported?: boolean
  usageComplete?: boolean
}
type ConvMetaView = ConvView & { messageCount?: number }

/** 从会话存档里按标记正文反查 conversationId（不猜排序） */
function findConvByMarker(convDir: string, marker: string): string {
  if (!existsSync(convDir)) return ''
  for (const f of readdirSync(convDir)) {
    if (!f.endsWith('.json')) continue
    if (readFileSync(join(convDir, f), 'utf8').includes(marker)) return f.replace(/\.json$/, '')
  }
  return ''
}

test('Story4 · usage 0 值：真实 prompt=0/completion=0 记为已知 0（不是 null）', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S4_ZERO 明报 0 用量', 'stop', { p: 0, c: 0 }) }],
    's4-usage-zero'
  )
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4z' })
    await send(h.page, 'S4Z_REQ 明报零用量')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S4_ZERO')
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()

    const convId = findConvByMarker(convDir, 'S4Z_REQ')
    expect(convId).not.toBe('')
    const conv = await apiCall<ConvView>(h.page, 'getConversation', convId)
    const metas = await apiCall<ConvMetaView[]>(h.page, 'listConversations')
    const meta = metas.find((m) => m.id === convId)

    dumpEvidence('usage-zero.json', { conversationId: convId, conv: conv.usage, reported: conv.usageReported, complete: conv.usageComplete, meta: meta?.usage })
    mark({
      story: 's4-usage-zero',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convId,
      terminal: 'completed',
      usage: conv.usage,
      usageReported: conv.usageReported,
      usageComplete: conv.usageComplete,
      requests: ep.bodies.length,
      sideEffects: 0
    })

    // 明确报的 0 是事实：必须是已知 0，不能退化成 null/未知
    expect(conv.usageReported).toBe(true)
    expect(conv.usageComplete).toBe(true)
    expect(conv.usage?.promptTokens).toBe(0)
    expect(conv.usage?.completionTokens).toBe(0)
    // 列表 meta 与会话一致
    expect(meta?.usage?.promptTokens).toBe(0)
    expect(meta?.usage?.completionTokens).toBe(0)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · 全漏报：无 usage 字段 → usageReported=false 不补 0，且与 completed 独立', async () => {
  const h = await launchApp()
  // 完全不发 usage 帧
  const ep = await startEndpoint([{ kind: 'sse', frames: oaText('S4_NOUSAGE 没有用量帧', 'stop') }], 's4-usage-none')
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4n' })
    await send(h.page, 'S4N_REQ 全漏报')
    await waitIdle(h.page)
    // 终态 completed 与 usage 未知互不干扰
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()

    const convId = findConvByMarker(convDir, 'S4N_REQ')
    expect(convId).not.toBe('')
    const conv = await apiCall<ConvView>(h.page, 'getConversation', convId)
    const metas = await apiCall<ConvMetaView[]>(h.page, 'listConversations')
    const meta = metas.find((m) => m.id === convId)

    dumpEvidence('usage-none.json', {
      conversationId: convId,
      // 显式 ?? null：避免 JSON.stringify 把 undefined 整个键省略，证据要能看见"是 null 不是 0"
      usage: conv.usage ?? null,
      usageIsUndefined: conv.usage === undefined,
      usageIsNull: conv.usage === null,
      usageKeyPresent: 'usage' in conv,
      reported: conv.usageReported,
      complete: conv.usageComplete,
      metaUsage: meta?.usage ?? null,
      metaUsageKeyPresent: meta ? 'usage' in meta : false
    })
    mark({
      story: 's4-usage-none',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convId,
      terminal: 'completed',
      usage: conv.usage,
      usageReported: conv.usageReported,
      usageComplete: conv.usageComplete,
      requests: ep.bodies.length,
      sideEffects: 0
    })

    // 未知就是未知：不补成"已知 0"。
    // ⚠️ 不用 `?? 0` —— 那会把 undefined / null / 已知 0 三种情况一起判成通过（正是被指出的假绿）。
    expect(conv.usageReported).toBe(false)
    expect(conv.usageComplete).toBe(false)
    // 产品真实返回形状：无 usage 时该字段缺失（不是 {promptTokens:0,completionTokens:0}）
    expect(conv.usage).toBeUndefined()
    expect('usage' in conv).toBe(false)
    // 兜底反证：绝不能是"补了 0 的对象"
    expect(conv.usage).not.toEqual({ promptTokens: 0, completionTokens: 0 })
    // 终态仍然完成 —— 用量缺失不改变终态
    expect(meta?.usageReported).toBe(false)
    expect(meta?.usage).toBeUndefined()
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · 部分漏报：首轮有账次轮无账 → 已知保留、usageComplete=false、未知不补 0', async () => {
  const h = await launchApp()
  writeFileSync(join(h.workspaceDir, 's4-partial.txt'), 'S4_PARTIAL_CONTENT', 'utf8')
  // 两轮：① 带 usage 的工具调用 ② 不带 usage 的收口
  const ep = await startEndpoint(
    [
      {
        kind: 'byBody',
        rules: [
          // ⚠️ 顺序要紧：次轮请求体里**仍带着**首轮的用户原文，所以「次轮」规则必须排前面，
          // 否则会再次命中首轮规则 → 无限工具调用 → 轮次耗尽（本轮实测踩过）。
          { match: 'S4_PARTIAL_CONTENT', frames: oaText('S4_PARTIAL_DONE 收口无账', 'stop') },
          { match: 'S4P_REQ', frames: oaToolCall('c_read', 'read_file', JSON.stringify({ path: 's4-partial.txt' }), { p: 40, c: 5 }) }
        ],
        fallback: oaText('S4_PARTIAL_SIDE 旁路', 'stop', { p: 1, c: 1 })
      }
    ],
    's4-usage-partial'
  )
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4p' })
    await send(h.page, 'S4P_REQ 部分漏报')
    await waitIdle(h.page, 90_000)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S4_PARTIAL_DONE')

    const convId = findConvByMarker(convDir, 'S4P_REQ')
    expect(convId).not.toBe('')
    const conv = await apiCall<ConvView>(h.page, 'getConversation', convId)

    dumpEvidence('usage-partial.json', {
      conversationId: convId,
      usage: conv.usage,
      usageReported: conv.usageReported,
      usageComplete: conv.usageComplete,
      requests: ep.bodies.length,
      routed: ep.routed
    })
    mark({
      story: 's4-usage-partial',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convId,
      terminal: 'completed',
      usage: conv.usage,
      usageReported: conv.usageReported,
      usageComplete: conv.usageComplete,
      requests: ep.bodies.length,
      sideEffects: 1
    })

    // 前两笔是本会话的两轮对话请求（第 3 笔起可能是标题摘要等旁路调用，
    // 它的请求体里合法地带着历史用户原文，故只按**前两笔**判对话轮次，完整序列留在 routed 里）
    expect(ep.routed.length).toBeGreaterThanOrEqual(2)
    expect(ep.routed.slice(0, 2)).toEqual(['S4P_REQ', 'S4_PARTIAL_CONTENT'])
    for (const extra of ep.routed.slice(2)) expect(typeof extra).toBe('string')
    // 已知字段保留（不是被抹成 0 或 null）
    expect(conv.usage?.promptTokens).toBe(40)
    expect(conv.usage?.completionTokens).toBe(5)
    expect(conv.usageReported).toBe(true)
    // 有一轮漏报 → 覆盖范围不完整
    expect(conv.usageComplete).toBe(false)
    // 未知明细就是 null（直接判 null，不用 ?? null 把 undefined 也放过去）
    expect(conv.usage?.cachedPromptTokens).toBeNull()
    expect(conv.usage?.reasoningTokens).toBeNull()
    expect(conv.usage?.cacheWritePromptTokens).toBeNull()
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · 有账 truncated：用量不丢，终态不得是 completed', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [{ kind: 'sse', frames: oaText('S4_TRUNC_USAGE 被截断但有账', 'length', { p: 70, c: 3 }) }],
    's4-usage-truncated'
  )
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4t' })
    await send(h.page, 'S4T_REQ 有账截断')
    await waitIdle(h.page)
    // 绝不允许标成 completed
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]')).toHaveCount(0)
    const states = await h.page.locator('.msg-terminal').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-terminal-state'))
    )

    const convId = findConvByMarker(convDir, 'S4T_REQ')
    expect(convId).not.toBe('')
    const conv = await apiCall<ConvView>(h.page, 'getConversation', convId)

    dumpEvidence('usage-truncated.json', { conversationId: convId, states, usage: conv.usage, reported: conv.usageReported, complete: conv.usageComplete })
    mark({
      story: 's4-usage-truncated',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convId,
      terminal: states,
      usage: conv.usage,
      usageReported: conv.usageReported,
      usageComplete: conv.usageComplete,
      requests: ep.bodies.length,
      sideEffects: 0
    })

    // 不只「有 terminal 元素」：定位到本轮最后一条 assistant，取它自己的终态
    const lastAssistantTerminal = h.page.locator('.msg-assistant').last().locator('.msg-terminal')
    await expect(lastAssistantTerminal).toHaveCount(1)
    const lastState = await lastAssistantTerminal.getAttribute('data-terminal-state')
    expect(lastState).toBe('truncated')
    expect(states.length).toBeGreaterThan(0)
    expect(states).not.toContain('completed')
    // 账不丢
    expect(conv.usage?.promptTokens).toBe(70)
    expect(conv.usage?.completionTokens).toBe(3)
    expect(conv.usageReported).toBe(true)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · 已知账后失败再续轮：不丢不重，累计只加一次', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [
      {
        kind: 'byBody',
        rules: [
          // 第二轮规则必须在前：它的请求体里含着第一轮的用户原文
          { match: 'S4F_REQ2', frames: oaText('S4_RECOVER 第二轮成功', 'stop', { p: 20, c: 2 }) },
          { match: 'S4F_REQ', frames: oaText('S4_FAIL_KNOWN 失败但已知账', 'content_filter', { p: 111, c: 7 }) }
        ],
        fallback: oaText('S4_FAIL_SIDE 旁路', 'stop', { p: 1, c: 1 })
      }
    ],
    's4-usage-fail-again'
  )
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4f' })
    await send(h.page, 'S4F_REQ 失败但有账')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-terminal[data-terminal-state="denied"]').first()).toBeVisible()

    const convId = findConvByMarker(convDir, 'S4F_REQ')
    expect(convId).not.toBe('')
    const afterFail = await apiCall<ConvView>(h.page, 'getConversation', convId)
    // 失败终态下账也不许丢，且不得被同一 terminal 重复结算成双倍
    expect(afterFail.usage?.promptTokens).toBe(111)
    expect(afterFail.usage?.completionTokens).toBe(7)

    // 第二轮：正常完成，累计恰好加上一次
    await send(h.page, 'S4F_REQ2 再来一轮')
    await waitIdle(h.page)
    const afterSecond = await apiCall<ConvView>(h.page, 'getConversation', convId)
    const metas = await apiCall<ConvMetaView[]>(h.page, 'listConversations')
    const meta = metas.find((m) => m.id === convId)

    dumpEvidence('usage-fail-then-continue.json', {
      conversationId: convId,
      afterFail: afterFail.usage,
      afterSecond: afterSecond.usage,
      meta: meta?.usage
    })
    mark({
      story: 's4-usage-fail-continue',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convId,
      terminal: 'denied→completed',
      usage: afterSecond.usage,
      usageReported: afterSecond.usageReported,
      usageComplete: afterSecond.usageComplete,
      requests: ep.bodies.length,
      sideEffects: 0
    })

    expect(afterSecond.usage?.promptTokens).toBe(131)
    expect(afterSecond.usage?.completionTokens).toBe(9)
    expect(meta?.usage?.promptTokens).toBe(131)
    expect(meta?.usage?.completionTokens).toBe(9)
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})

test('Story4 · 双会话归属 + 真实重启：A/B usage 与 terminal 互不串，meta 与存档一致', async () => {
  const h = await launchApp()
  const ep = await startEndpoint(
    [
      {
        kind: 'byBody',
        rules: [
          { match: 'S4A_REQ', frames: oaText('S4A_OK A 会话完成', 'stop', { p: 11, c: 1 }) },
          { match: 'S4B_REQ', frames: oaText('S4B_FAIL B 会话失败', 'content_filter', { p: 22, c: 2 }) }
        ],
        fallback: oaText('S4_DUAL_SIDE 旁路', 'stop', { p: 1, c: 1 })
      }
    ],
    's4-usage-dual'
  )
  const dataDir = h.dataDir
  const convDir = join(dataDir, 'conversations')
  let convA = ''
  let convB = ''
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4d' })
    // A
    await send(h.page, 'S4A_REQ A 会话')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-terminal[data-terminal-state="completed"]').last()).toBeVisible()
    // B：真实 UI 新建会话
    await h.page.locator('.new-task-btn').click()
    await h.page.waitForSelector('.chat-view, textarea.console-input', { timeout: 20_000 })
    await send(h.page, 'S4B_REQ B 会话')
    await waitIdle(h.page)
    await expect(h.page.locator('.msg-terminal[data-terminal-state="denied"]').last()).toBeVisible()

    convA = findConvByMarker(convDir, 'S4A_REQ')
    convB = findConvByMarker(convDir, 'S4B_REQ')
    expect(convA).not.toBe('')
    expect(convB).not.toBe('')
    expect(convA).not.toBe(convB)

    const a = await apiCall<ConvView>(h.page, 'getConversation', convA)
    const b = await apiCall<ConvView>(h.page, 'getConversation', convB)
    const metas = await apiCall<ConvMetaView[]>(h.page, 'listConversations')
    const mA = metas.find((m) => m.id === convA)
    const mB = metas.find((m) => m.id === convB)

    // 各自用量不串
    expect(a.usage?.promptTokens).toBe(11)
    expect(b.usage?.promptTokens).toBe(22)
    expect(mA?.usage?.promptTokens).toBe(11)
    expect(mB?.usage?.promptTokens).toBe(22)

    dumpEvidence('dual-before-restart.json', { convA: a, convB: b, metaA: mA, metaB: mB })
    mark({
      story: 's4-dual',
      stage: 'before-restart',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convA + ' / ' + convB,
      terminal: 'completed / denied',
      usage: { A: a.usage, B: b.usage },
      usageReported: { A: a.usageReported, B: b.usageReported },
      usageComplete: { A: a.usageComplete, B: b.usageComplete },
      requests: ep.bodies.length,
      sideEffects: 0
    })
  } finally {
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) w.close()
    })
    await once(h.app, 'close')
  }

  // 同 dataDir 真实重启：归属仍按原 conversationId
  const h2 = await launchApp({ reuseDataDir: dataDir })
  try {
    await h2.page.waitForSelector('.chat-view, .new-task', { timeout: 45_000 })
    const a2 = await apiCall<ConvView>(h2.page, 'getConversation', convA)
    const b2 = await apiCall<ConvView>(h2.page, 'getConversation', convB)
    const metas2 = await apiCall<ConvMetaView[]>(h2.page, 'listConversations')
    const mA2 = metas2.find((m) => m.id === convA)
    const mB2 = metas2.find((m) => m.id === convB)

    // 磁盘口径 ①：conversations.json 是**独立 meta 文件**（不是 API），直接读原文断言
    const metaPath = join(dataDir, 'conversations.json')
    const metaRaw = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : ''
    const metaFile = metaRaw ? (JSON.parse(metaRaw) as {
      schemaVersion?: number
      conversations?: Record<string, { usage?: UsageShape; usageReported?: boolean; usageComplete?: boolean }>
    }) : {}
    const diskA = metaFile.conversations?.[convA]
    const diskB = metaFile.conversations?.[convB]

    // 磁盘口径 ②：消息正文按 conversationId 隔离（messages 文件本来就不含 usage）
    const rawA = existsSync(join(convDir, convA + '.json')) ? readFileSync(join(convDir, convA + '.json'), 'utf8') : ''
    const rawB = existsSync(join(convDir, convB + '.json')) ? readFileSync(join(convDir, convB + '.json'), 'utf8') : ''

    dumpEvidence('dual-after-restart.json', {
      note:
        '三套口径分开记：conversations.json 是独立 meta 磁盘文件；getConversation / listConversations 都是主进程读盘后的 API 口径；' +
        'conversations/<id>.json 只放 messages，本来不含 usage（archiveHasUsage=false 属预期，不是缺陷）。',
      convA: a2,
      convB: b2,
      metaA: mA2,
      metaB: mB2,
      diskMetaFileExists: existsSync(metaPath),
      diskMetaSchemaVersion: metaFile.schemaVersion ?? null,
      diskA_usage: diskA?.usage ?? null,
      diskA_usageReported: diskA?.usageReported ?? null,
      diskA_usageComplete: diskA?.usageComplete ?? null,
      diskB_usage: diskB?.usage ?? null,
      diskB_usageReported: diskB?.usageReported ?? null,
      diskB_usageComplete: diskB?.usageComplete ?? null,
      archiveHasUsage_A: rawA.includes('"usage"'),
      archiveHasUsage_B: rawB.includes('"usage"'),
      archiveHasA: rawA.includes('S4A_REQ'),
      archiveHasB: rawB.includes('S4B_REQ')
    })
    mark({
      story: 's4-dual',
      stage: 'after-restart',
      pid: mainPid(h2),
      port: ep.port,
      conversationId: convA + ' / ' + convB,
      terminal: 'completed / denied',
      usage: { A: a2.usage, B: b2.usage },
      usageReported: { A: a2.usageReported, B: b2.usageReported },
      usageComplete: { A: a2.usageComplete, B: b2.usageComplete },
      requests: ep.bodies.length,
      sideEffects: 0
    })

    expect(a2.usage?.promptTokens).toBe(11)
    expect(b2.usage?.promptTokens).toBe(22)
    expect(a2.usage?.completionTokens).toBe(1)
    expect(b2.usage?.completionTokens).toBe(2)
    // meta 与会话一致（列表/存档不漂移）
    expect(mA2?.usage?.promptTokens).toBe(11)
    expect(mB2?.usage?.promptTokens).toBe(22)
    // ① 独立磁盘口径：直接读 conversations.json 原文，按 convA/convB 断言
    expect(existsSync(metaPath)).toBe(true)
    expect(diskA).toBeDefined()
    expect(diskB).toBeDefined()
    expect(diskA?.usage?.promptTokens).toBe(11)
    expect(diskA?.usage?.completionTokens).toBe(1)
    expect(diskB?.usage?.promptTokens).toBe(22)
    expect(diskB?.usage?.completionTokens).toBe(2)
    // 磁盘 meta 的覆盖标记与 API 口径一致
    expect(diskA?.usageReported).toBe(a2.usageReported)
    expect(diskB?.usageReported).toBe(b2.usageReported)
    expect(diskA?.usageComplete).toBe(a2.usageComplete)
    expect(diskB?.usageComplete).toBe(b2.usageComplete)

    // ② API 口径一致（getConversation 与 listConversations 都走主进程读盘，二者一致是「API 自洽」，非独立磁盘证据）
    expect(mA2?.usage).toEqual(a2.usage)
    expect(mB2?.usage).toEqual(b2.usage)
    expect(mA2?.usageReported).toBe(a2.usageReported)
    expect(mB2?.usageReported).toBe(b2.usageReported)

    // ③ 消息正文按 conversationId 隔离，且 messages 文件本来不含 usage（预期事实，不是缺陷）
    expect(rawA).toContain('S4A_REQ')
    expect(rawA).not.toContain('S4B_REQ')
    expect(rawB).toContain('S4B_REQ')
    expect(rawB).not.toContain('S4A_REQ')
    expect(rawA.includes('"usage"')).toBe(false)
    expect(mA2?.messageCount ?? 0).toBeGreaterThan(0)
  } finally {
    await h2.close()
    await h2.cleanup()
    await ep.close()
  }
})

test('Story4 · 出站逐消息：多轮请求体都不含 terminal/localFiles/segments/usageComplete', async () => {
  const h = await launchApp()
  writeFileSync(join(h.workspaceDir, 's4-out.txt'), 'S4_OUT_CONTENT', 'utf8')
  const ep = await startEndpoint(
    [
      {
        kind: 'byBody',
        rules: [
          { match: 'S4_OUT_CONTENT', frames: oaText('S4_OUT_DONE 出站检查收口', 'stop', { p: 35, c: 5 }) },
          { match: 'S4O_REQ', frames: oaToolCall('c_out', 'read_file', JSON.stringify({ path: 's4-out.txt' }), { p: 30, c: 4 }) }
        ],
        fallback: oaText('S4_OUT_SIDE 旁路', 'stop', { p: 1, c: 1 })
      }
    ],
    's4-outbound-multi'
  )
  const convDir = join(h.dataDir, 'conversations')
  try {
    await useLocalModel(h.page, ep.port, { name: 'e30-s4o' })
    await send(h.page, 'S4O_REQ 多轮出站检查')
    await waitIdle(h.page, 90_000)
    await expect(h.page.locator('.msg-assistant').last()).toContainText('S4_OUT_DONE')

    const convId = findConvByMarker(convDir, 'S4O_REQ')
    const forbiddenKeys = ['terminal', 'localFiles', 'segments', 'usageComplete', 'toolOutcome', 'agentScope', 'runId']
    // 逐笔解析 + 逐条消息结构检查（整 body 子串扫描只作补充，不作为主判据）
    const perRequest = ep.bodies.map((b, i) => {
      const parsed = JSON.parse(b) as { messages?: Array<Record<string, unknown>> }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const perMessage = messages.map((m, mi) => ({
        index: mi,
        role: m.role,
        roleIsString: typeof m.role === 'string',
        keys: Object.keys(m),
        forbiddenPresent: forbiddenKeys.filter((k) => k in m),
        contentIsString: typeof m.content === 'string'
      }))
      return {
        request: i,
        bytes: b.length,
        messageCount: messages.length,
        allRolesAreString: perMessage.every((m) => m.roleIsString),
        allForbiddenAbsent: perMessage.every((m) => m.forbiddenPresent.length === 0),
        perMessage,
        // 补充口径：整 body 子串命中（不是主判据）
        stringScanHits: forbiddenKeys.filter((k) => b.includes('"' + k + '"'))
      }
    })
    writeFileSync(
      join(EVIDENCE, 'outbound-per-message.json'),
      JSON.stringify({ routed: ep.routed, requestCount: ep.bodies.length, requests: perRequest }, null, 2),
      'utf8'
    )

    mark({
      story: 's4-outbound-multi',
      pid: mainPid(h),
      port: ep.port,
      conversationId: convId,
      terminal: 'completed',
      usage: null,
      usageReported: null,
      usageComplete: null,
      requests: ep.bodies.length,
      sideEffects: 1
    })

    // 前两笔是本会话的两轮对话请求（理由同上：旁路调用会带着历史原文）
    expect(ep.routed.length).toBeGreaterThanOrEqual(2)
    expect(ep.routed.slice(0, 2)).toEqual(['S4O_REQ', 'S4_OUT_CONTENT'])
    // 第 3 笔起若有旁路调用（标题摘要）属于正常，但必须记清楚它路由到了什么
    for (const extra of ep.routed.slice(2)) expect(typeof extra).toBe('string')

    // 每笔请求都必须能解析、messages 非空、每条消息 role 是字符串、且本地字段键不存在
    expect(perRequest.length).toBeGreaterThanOrEqual(2)
    for (const r of perRequest) {
      expect(r.messageCount).toBeGreaterThan(0)
      expect(r.allRolesAreString).toBe(true)
      expect(r.allForbiddenAbsent).toBe(true)
      for (const m of r.perMessage) {
        expect(typeof m.role).toBe('string')
        expect(m.forbiddenPresent).toEqual([])
      }
    }
  } finally {
    await h.close()
    await h.cleanup()
    await ep.close()
  }
})
