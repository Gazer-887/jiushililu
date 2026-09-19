import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { initLogger } from '@main/log'
import { setBrowserAdapter, type BrowserAdapter } from '@main/agent/browser-bridge'
import { createBrowserTools } from '@main/agent/tools/browser-tools'

// 浏览器工具套上异步跨度（plan49 A 档）后的契约测试。
// 关心的不是"跨度记没记"，而是**包装层有没有把工具改坏**：
// createBrowserTools 用 map 重建了对象，schema 与 execute 的绑定一旦丢，
// 内核那边拿到的就是个形状对、行为错的工具。

const calls: string[] = []
const adapter: BrowserAdapter = {
  currentUrl: () => 'https://example.com',
  navigate: async (url) => {
    calls.push(`navigate:${url}`)
    return { url, title: '示例' }
  },
  readPage: async () => {
    calls.push('readPage')
    return '页面正文'.repeat(5)
  },
  click: async (target) => {
    calls.push(`click:${target}`)
    return `已点击 ${target}`
  },
  type: async (target, text) => {
    calls.push(`type:${target}=${text}`)
    return `已输入 ${text}`
  }
}

const dir = mkdtempSync(join(tmpdir(), 'jsl-btools-'))
initLogger(dir, 'info')
setBrowserAdapter(adapter)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const byName = new Map(createBrowserTools().map((t) => [t.schema.name, t]))

describe('浏览器工具的异步跨度包装', () => {
  it('四个工具齐全且 schema 未被重建过程丢掉', () => {
    expect([...byName.keys()].sort()).toEqual([
      'browser_click',
      'browser_navigate',
      'browser_read_page',
      'browser_type'
    ])
    for (const t of byName.values()) expect(t.schema.parameters).toBeTruthy()
  })

  it('入参原样透传给适配器，返回值原样回给模型', async () => {
    calls.length = 0
    const out = await byName.get('browser_navigate')!.execute({ url: 'https://a.test' })
    expect(calls).toEqual(['navigate:https://a.test'])
    expect(out).toContain('https://a.test')
    expect(await byName.get('browser_type')!.execute({ target: '#q', text: '你好' })).toBe('已输入 你好')
    expect(calls).toContain('type:#q=你好')
  })

  it('参数校验仍在跨度之前生效（空 url 不该惊动浏览器）', async () => {
    calls.length = 0
    const out = await byName.get('browser_navigate')!.execute({ url: '   ' })
    expect(out).toContain('错误')
    expect(calls).toEqual([])
  })

  it('适配器抛错仍走文本回，不由 span 改成 reject', async () => {
    setBrowserAdapter({
      ...adapter,
      click: async () => {
        throw new Error('选择器未命中')
      }
    })
    const out = await byName.get('browser_click')!.execute({ target: '#nope' })
    expect(out).toContain('错误：点击失败')
    expect(out).toContain('选择器未命中')
  })
})
