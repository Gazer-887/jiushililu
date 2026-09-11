import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger, initLogger, listLogFiles, scrub } from '@main/log'

const dirs: string[] = []

/** 轮转测试要写 >1MB 内容，会把控制台刷屏 —— 静音 console，保持测试输出可读 */
function fillLog(log: ReturnType<typeof createLogger>, times = 300): void {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const chunk = 'x'.repeat(4000)
    for (let i = 0; i < times; i++) log.info(chunk)
  } finally {
    spy.mockRestore()
  }
}

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'jsl-log-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
})

describe('scrub（敏感信息脱敏——Key 绝不能进日志）', () => {
  it('sk- 形态的 Key 被脱敏', () => {
    expect(scrub('key=sk-abcdef1234567890')).not.toContain('abcdef1234567890')
    expect(scrub('key=sk-abcdef1234567890')).toContain('REDACTED')
  })

  it('Bearer token 被脱敏', () => {
    const out = scrub('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6')
    expect(out).toContain('Bearer ***REDACTED***')
  })

  it('apiKey / api_key / token / secret 等键名后的值被脱敏', () => {
    for (const raw of [
      '{"apiKey":"abcdefgh12345678"}',
      'api_key=abcdefgh12345678',
      "token: 'abcdefgh12345678'",
      'secret=abcdefgh12345678',
      'password=abcdefgh12345678'
    ]) {
      const out = scrub(raw)
      expect(out, raw).not.toContain('abcdefgh12345678')
      expect(out, raw).toContain('REDACTED')
    }
  })

  it('普通文本不受影响（不误伤）', () => {
    const text = '已读取 notes/todo.md，共 12 行'
    expect(scrub(text)).toBe(text)
  })

  it('短字符串不误判（避免把普通词当成 Key）', () => {
    expect(scrub('token=abc')).toBe('token=abc') // 少于 8 位不脱敏，避免误伤
  })
})

describe('日志写入与轮转', () => {
  it('写入后可读回，含级别与 scope', () => {
    const dir = freshDir()
    initLogger(dir, 'debug')
    const log = createLogger('test')
    log.info('一条测试日志', { n: 1 })

    const files = readdirSync(dir)
    expect(files).toContain('app.log')
    const content = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(content).toContain('[INFO]')
    expect(content).toContain('[test]')
    expect(content).toContain('一条测试日志')
  })

  it('低于最小级别的日志被过滤', () => {
    const dir = freshDir()
    initLogger(dir, 'warn')
    const log = createLogger('test')
    log.debug('不该出现')
    log.info('也不该出现')
    log.error('应该出现')

    const content = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(content).not.toContain('不该出现')
    expect(content).not.toContain('也不该出现')
    expect(content).toContain('应该出现')
  })

  it('日志里的敏感信息也被脱敏（最后一道防线）', () => {
    const dir = freshDir()
    initLogger(dir, 'debug')
    const log = createLogger('test')
    log.info('apiKey=sk-leaked1234567890 被写入了')

    const content = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(content).not.toContain('sk-leaked1234567890')
  })

  it('写入不影响主流程（目录不可用时降级为仅控制台，不抛错）', () => {
    // 指向一个非法路径：不应抛异常
    expect(() => initLogger('\0invalid\0path', 'debug')).not.toThrow()
    const log = createLogger('test')
    expect(() => log.info('仍然可以记录')).not.toThrow()
  })

  it('运行期也会轮转（长时间不重启不会让日志无限增长）', () => {
    const dir = freshDir()
    initLogger(dir, 'info')
    const log = createLogger('test')
    // 单文件上限 1MB：写 300 条 × 4KB ≈ 1.2MB，必然触发一次运行期轮转
    fillLog(log)

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'))
    // 轮转后应出现档案文件（app.1.log），说明超过上限后被切走
    expect(files).toContain('app.1.log')
    // 当前文件应重新变小（不会继续累加到 1.2MB）
    const currentSize = readFileSync(join(dir, 'app.log'), 'utf8').length
    expect(currentSize).toBeLessThan(1_200_000)
  })

  it('listLogFiles 按「新→旧」返回（app.log 在最前）', () => {
    const dir = freshDir()
    initLogger(dir, 'info')
    const log = createLogger('test')
    fillLog(log) // 制造出 app.1.log

    const list = listLogFiles()
    expect(list[0]).toBe('app.log')
    expect(list).toContain('app.1.log')
  })
})
