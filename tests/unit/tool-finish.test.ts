import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSystemTools } from '@main/agent/tools/system-tools'
import { parseDuckResults, parseFirecrawlResults, unwrapDuckHref } from '@main/agent/tools/web-tools'
import { disposeAllShellSessions } from '@main/agent/tools/shell-session'
import type { AgentTool } from '@shared/agent'

// plan31 D-095/D-096：run_command 机器可判尾标（exit_code / error_class / elapsed_ms）
// 与 web_search 的离线解析。

const cmd = (root: string): AgentTool => createSystemTools(root).find((t) => t.schema.name === 'run_command')!
const root = mkdtempSync(join(tmpdir(), 'jsl-p31-'))

// run_command 现在走持久 shell 会话（plan28 S2）：不清的话，父进程持有的
// 子进程管道是活动句柄，vitest 收不了尾（全量跑时实测挂死 13 分钟的根因）
afterAll(() => {
  disposeAllShellSessions()
})

describe('run_command · 机器可判尾标（D-095）', () => {
  it('成功 → 末行 exit_code=0 error_class=ok（机器可正则）', async () => {
    const out = await cmd(root).execute({ command: 'node -e "console.log(12345)"' })
    expect(out).toContain('12345')
    expect(out).toMatch(/exit_code=0 error_class=ok elapsed_ms=\d+\s*$/)
  })

  it('真出错 → 末行 exit_code=<数字> error_class=error', async () => {
    const out = await cmd(root).execute({ command: 'node -e "process.exit(3)"' })
    expect(out).toContain('命令执行出错')
    expect(out).toMatch(/exit_code=3 error_class=error elapsed_ms=\d+\s*$/)
  })

  it('超时 → exit_code=null error_class=timeout（被杀没有退出码，如实给 null）', async () => {
    const out = await cmd(root).execute({ command: 'node -e "setInterval(function(){},1000)"', timeoutMs: 2000 })
    expect(out).toContain('命令超时')
    expect(out).toMatch(/exit_code=null error_class=timeout elapsed_ms=\d+\s*$/)
  })
})

// ── web_search 离线解析（D-096）─────────────────────────────────

const fakeDuckHtml = `
<div class="results">
  <div class="result">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fintro&amp;rut=abc">Example Docs &amp; Guides</a>
    <a class="result__snippet" href="/l/?uddg=x">The <b>intro</b> page explains &lt;how&gt; it works.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://direct.example.org/page">Direct Link Result</a>
    <a class="result__snippet" href="#">second snippet</a>
  </div>
  <div class="result">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fthird.io%2Fa">Third</a>
  </div>
</div>`

describe('web_search · DDG 结果解析（D-096，离线纯函数）', () => {
  it('抽标题/URL/摘要，跳转包装解成真实 URL，实体解码', () => {
    const r = parseDuckResults(fakeDuckHtml)
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ title: 'Example Docs & Guides', url: 'https://example.com/docs/intro' })
    expect(r[0].snippet).toContain('The intro page explains <how> it works.')
    expect(r[1]).toMatchObject({ title: 'Direct Link Result', url: 'https://direct.example.org/page' })
    expect(r[2].snippet).toBe('')
  })

  it('max 截断', () => {
    expect(parseDuckResults(fakeDuckHtml, 2)).toHaveLength(2)
  })

  it('无结果 HTML → 空数组（由工具层渲染成"无搜索结果"人话）', () => {
    expect(parseDuckResults('<html><body>anomaly detected, verify you are human</body></html>')).toEqual([])
  })

  it('unwrapDuckHref：非包装链接原样返回', () => {
    expect(unwrapDuckHref('https://a.io/b')).toBe('https://a.io/b')
    expect(unwrapDuckHref('not a url at all')).toBe('not a url at all')
  })
})

// ── web_search · Firecrawl 结果解析（plan32，离线纯函数）──
// v1/search 响应形状：{ data: [{ title?, url, description? }] }。字段可缺，只信 url。

const fakeFirecrawlJson = {
  data: [
    { title: 'Firecrawl Docs', url: 'https://docs.firecrawl.dev/intro', description: 'How to use the API.' },
    { url: 'https://example.org/no-title' },
    { title: 'No URL —— 应被跳过' },
    { title: 'Fourth', url: 'https://fourth.io/', description: 'keep' }
  ]
}

describe('web_search · Firecrawl 结果解析（plan32，离线纯函数）', () => {
  it('抽 title/url/description；缺 title 回落 url，缺 description 给空串', () => {
    const r = parseFirecrawlResults(fakeFirecrawlJson)
    expect(r).toHaveLength(3) // 无 url 的那条被跳过
    expect(r[0]).toMatchObject({ title: 'Firecrawl Docs', url: 'https://docs.firecrawl.dev/intro' })
    expect(r[0].snippet).toBe('How to use the API.')
    expect(r[1]).toMatchObject({ title: 'https://example.org/no-title', url: 'https://example.org/no-title' })
    expect(r[1].snippet).toBe('')
    expect(r[2]).toMatchObject({ title: 'Fourth', url: 'https://fourth.io/' })
  })

  it('max 截断', () => {
    expect(parseFirecrawlResults(fakeFirecrawlJson, 2)).toHaveLength(2)
  })

  it('data 缺失 / 非数组 → 空数组（由工具层渲染成"无搜索结果"）', () => {
    expect(parseFirecrawlResults({})).toEqual([])
    expect(parseFirecrawlResults({ data: 'nope' })).toEqual([])
    expect(parseFirecrawlResults(null)).toEqual([])
  })
})
