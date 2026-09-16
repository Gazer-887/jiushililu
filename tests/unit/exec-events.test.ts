// 执行事件流单测（plan26 S1 · D-077）：判据 1（六 kind 落盘/轮转/失败不阻塞/子代理可见）
// 与判据 2（payload 字段白名单 —— key 集合断言，不用正文 grep：转义/截断会击穿）。
// 用**内存 fs 适配器**（不碰真盘）—— FsAdapter 注入就是为这个存在的。

import { describe, expect, it } from 'vitest'
import type { FsAdapter } from '@main/store/conversations-fs'
import { MAX_FILE_BYTES } from '@main/log'
import {
  EXEC_EVENT_KINDS,
  EXEC_PAYLOAD_WHITELIST,
  createExecEventRecorder,
  createFsExecEventSink,
  execEventsPath,
  readExecEvents,
  withAgentScope,
  type ExecEvent,
  type ExecEventKind
} from '@main/agent/exec-events'

const norm = (p: string): string => p.replace(/\\/g, '/')

function mapFs(seed: Record<string, string> = {}): FsAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed).map(([k, v]) => [norm(k), v]))
  const dirs = new Set<string>()
  return {
    files,
    existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    mkdirSync: (p) => void dirs.add(norm(p)),
    readFileSync: (p) => {
      const v = files.get(norm(p))
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p, d) => void files.set(norm(p), d),
    renameSync: (a, b) => {
      const v = files.get(norm(a))
      if (v === undefined) throw new Error('ENOENT')
      files.set(norm(b), v)
      files.delete(norm(a))
    },
    rmSync: (p) => void files.delete(norm(p)),
    appendFileSync: (p, d) => {
      const key = norm(p)
      files.set(key, (files.get(key) ?? '') + d)
    },
    sizeBytes: (p) => new TextEncoder().encode(files.get(norm(p)) ?? '').length,
    readdirSync: () => [],
    fsyncFile: () => {},
    fsyncDir: () => {}
  }
}

/** 内存 sink：收集事件对象 */
function memSink(): { events: ExecEvent[]; append: (e: ExecEvent) => void } {
  const events: ExecEvent[] = []
  return { events, append: (e) => void events.push(e) }
}

const USER_DATA = 'C:/tmp/userdata'

describe('执行事件流 —— recorder 与白名单（判据 1/2）', () => {
  it('六种 kind 都能落 sink，且带 at/kind/conversationId/agentScope 四个固定头', () => {
    const sink = memSink()
    const rec = createExecEventRecorder({
      sink,
      conversationId: 'c1',
      agentScope: 'main',
      now: () => new Date('2026-09-16T03:00:00.000Z')
    })
    for (const kind of EXEC_EVENT_KINDS) rec.record(kind)
    expect(sink.events).toHaveLength(EXEC_EVENT_KINDS.length)
    for (const e of sink.events) {
      expect(e.at).toBe('2026-09-16T03:00:00.000Z')
      expect(e.kind).toBeTruthy()
      expect(e.conversationId).toBe('c1')
      expect(e.agentScope).toBe('main')
    }
  })

  it('白名单过滤：未列名 key 被丢弃并留痕（onDropped），入参/正文类字段进不去', () => {
    const sink = memSink()
    const dropped: Array<{ kind: ExecEventKind; keys: string[] }> = []
    const rec = createExecEventRecorder({
      sink,
      conversationId: 'c1',
      agentScope: 'main',
      onDropped: (kind, keys) => dropped.push({ kind, keys })
    })
    // 恶意/未来字段：arguments（含文件正文）、content（工具输出正文）、summary（摘要文本）
    rec.record('tool_call', {
      tool: 'write_file',
      arguments: { path: 'a.txt', content: 'SECRET_FILE_BODY' },
      content: 'SECRET_OUTPUT',
      summary: 'SECRET_SUMMARY'
    })
    expect(sink.events).toHaveLength(1)
    const e = sink.events[0]!
    // 判据 2 的口径：key 集合 ⊆ {固定头} ∪ 白名单 —— 不 grep 正文（转义/截断会击穿）
    const allowed = new Set(['at', 'kind', 'conversationId', 'agentScope', ...EXEC_PAYLOAD_WHITELIST.tool_call])
    for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true)
    expect(e.tool).toBe('write_file')
    expect(JSON.stringify(e)).not.toContain('SECRET')
    expect(dropped).toEqual([{ kind: 'tool_call', keys: ['arguments', 'content', 'summary'] }])
  })

  it('每种 kind 的落盘 key 集合都不超过白名单（全 kind 扫描）', () => {
    const sink = memSink()
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    // 给每种 kind 塞满"全都想要"的字段 + 一个必然越界的诱饵
    const greedy: Record<string, unknown> = {
      agentName: 'x',
      tool: 'x',
      ok: true,
      ms: 1,
      bytes: 2,
      windowed: false,
      allowed: true,
      reason: 'user',
      droppedCount: 3,
      summarized: false,
      rounds: 1,
      durationMs: 5,
      stopReason: 'completed',
      EVIL: 'should-never-appear'
    }
    for (const kind of EXEC_EVENT_KINDS) rec.record(kind, greedy)
    for (const e of sink.events) {
      const allowed = new Set(['at', 'kind', 'conversationId', 'agentScope', ...EXEC_PAYLOAD_WHITELIST[e.kind]])
      for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true)
      expect('EVIL' in e).toBe(false)
    }
  })

  it('trim 事件带 droppedCount/bytes/summarized（判据 6 的字段面）', () => {
    const sink = memSink()
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    rec.record('trim', { droppedCount: 12, bytes: 4096, summarized: true })
    expect(sink.events[0]).toMatchObject({ droppedCount: 12, bytes: 4096, summarized: true })
  })

  it('withAgentScope 派生：同 conversationId、scope=sub —— 子代理活动可区分（盲审 A P0-2）', () => {
    const sink = memSink()
    const main = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    const sub = withAgentScope(main, 'sub')
    main.record('tool_call', { tool: 'a' })
    sub.record('tool_call', { tool: 'b' })
    expect(sink.events[0]).toMatchObject({ agentScope: 'main', tool: 'a' })
    expect(sink.events[1]).toMatchObject({ agentScope: 'sub', tool: 'b' })
    expect(sink.events[1]!.conversationId).toBe('c1')
    // 同 scope 派生 = 原样返回（不重复包装）
    expect(withAgentScope(main, 'main')).toBe(main)
  })
})

describe('执行事件流 —— fs sink 落盘（判据 1）', () => {
  it('追加写：多次 record 逐行 JSONL 落盘，readExecEvents 可读回', () => {
    const fs = mapFs()
    const sink = createFsExecEventSink(USER_DATA, fs)
    const rec = createExecEventRecorder({
      sink,
      conversationId: 'c1',
      agentScope: 'main',
      now: () => new Date('2026-09-16T03:00:00.000Z')
    })
    rec.record('run_start', { agentName: '内核默认' })
    rec.record('tool_call', { tool: 'read_file' })
    rec.record('run_end', { rounds: 2, durationMs: 1200, stopReason: 'completed' })

    const raw = fs.files.get(norm(execEventsPath(USER_DATA)))!
    expect(raw.split('\n').filter(Boolean)).toHaveLength(3)
    const { events, skipped } = readExecEvents(USER_DATA, fs)
    expect(skipped).toBe(0)
    // 倒序：最新在前
    expect(events.map((e) => e.kind)).toEqual(['run_end', 'tool_call', 'run_start'])
  })

  it('按 conversationId 过滤 + limit 截断', () => {
    const fs = mapFs()
    const sink = createFsExecEventSink(USER_DATA, fs)
    const a = createExecEventRecorder({ sink, conversationId: 'ca', agentScope: 'main' })
    const b = createExecEventRecorder({ sink, conversationId: 'cb', agentScope: 'main' })
    a.record('run_start')
    b.record('run_start')
    a.record('run_end', { rounds: 1, durationMs: 1 })

    const onlyA = readExecEvents(USER_DATA, fs, { conversationId: 'ca' })
    expect(onlyA.events).toHaveLength(2)
    expect(onlyA.events.every((e) => e.conversationId === 'ca')).toBe(true)

    const limited = readExecEvents(USER_DATA, fs, { limit: 1 })
    expect(limited.events).toHaveLength(1)
  })

  it('坏行容忍：半行尾/手改坏行计入 skipped，好行照读', () => {
    const good = JSON.stringify({ at: 'x', kind: 'run_start', conversationId: 'c1', agentScope: 'main' })
    const fs = mapFs({ [execEventsPath(USER_DATA)]: `${good}\n{broken json\n\n${good}\n` })
    const { events, skipped } = readExecEvents(USER_DATA, fs)
    expect(events).toHaveLength(2)
    expect(skipped).toBe(1)
  })

  it('超上限即轮转：exec-events.jsonl → exec-events.1.jsonl（与记忆事件同款三件套）', () => {
    const fs = mapFs()
    const sink = createFsExecEventSink(USER_DATA, fs)
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    const big = 'x'.repeat(1024)
    // 直接预置一个超大文件的下一个状态：用 append 循环太慢，改为先塞大字符串
    fs.files.set(norm(execEventsPath(USER_DATA)), big.repeat(Math.ceil(MAX_FILE_BYTES / 1024)))
    rec.record('run_start') // 这次 append 前会触发轮转
    expect(fs.existsSync(norm(execEventsPath(USER_DATA).replace('exec-events.jsonl', 'exec-events.1.jsonl')))).toBe(true)
    // 轮转后当前文件只剩新事件
    const current = fs.files.get(norm(execEventsPath(USER_DATA)))!
    expect(current.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('写入失败仅告警不阻塞（第一次失败 warn 一次，之后静默，append 不抛）', () => {
    const warnings: string[] = []
    const brokenFs: FsAdapter = {
      ...mapFs(),
      appendFileSync: () => {
        throw new Error('disk full')
      }
    }
    const sink = createFsExecEventSink(USER_DATA, brokenFs, {
      onWarn: (message) => void warnings.push(message)
    })
    const rec = createExecEventRecorder({ sink, conversationId: 'c1', agentScope: 'main' })
    expect(() => {
      rec.record('run_start')
      rec.record('tool_call', { tool: 'x' })
    }).not.toThrow()
    expect(warnings).toHaveLength(1) // 第二次不再刷告警
    expect(warnings[0]).toContain('写入失败')
  })

  it('不存在的文件读回空（不抛）', () => {
    const fs = mapFs()
    const { events, skipped } = readExecEvents(USER_DATA, fs)
    expect(events).toEqual([])
    expect(skipped).toBe(0)
  })
})
