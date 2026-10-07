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
  },
  hover: async (target) => {
    calls.push(`hover:${target}`)
    return `已悬停 ${target}`
  },
  pressKey: async (key) => {
    calls.push(`key:${key}`)
    return `已按键 ${key}`
  },
  drag: async (from, to) => {
    calls.push(`drag:${from}>${to}`)
    return `已拖拽`
  },
  screenshot: async () => {
    calls.push('screenshot')
    return { base64: 'AAA=', mime: 'image/png' as const }
  },
  snapshot: async () => {
    calls.push('snapshot')
    return '[]'
  },
  evalScript: async (js) => {
    calls.push(`eval:${js.length}`)
    return 'undefined'
  },
  consoleMessages: async () => {
    calls.push('console')
    return '暂无 console 记录'
  },
  networkRequests: async () => {
    calls.push('network')
    return '暂无网络请求记录'
  },
  handleDialog: async (action) => {
    calls.push(`dialog:${action}`)
    return '当前无挂起 dialog'
  },
  listTabs: () => {
    calls.push('tabs:list')
    return []
  },
  newTab: async (url) => {
    calls.push(`tabs:new:${url ?? ''}`)
    return { id: 't9', url: url ?? '', title: '' }
  },
  selectTab: (id) => {
    calls.push(`tabs:select:${id}`)
    return null
  },
  closeTab: (id) => {
    calls.push(`tabs:close:${id}`)
    return false
  },
  uploadFile: async (target, filePath) => {
    calls.push(`upload:${target}=${filePath}`)
    return '已设置文件'
  },
  waitFor: async (target) => {
    calls.push(`wait:${target}`)
    return `条件已出现：${target}`
  }
}

const dir = mkdtempSync(join(tmpdir(), 'jsl-btools-'))
initLogger(dir, 'info')
setBrowserAdapter(adapter)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const byName = new Map(createBrowserTools().map((t) => [t.schema.name, t]))

describe('浏览器工具的异步跨度包装', () => {
  it('十五个工具齐全且 schema 未被重建过程丢掉（plan60：4→15，旧断言按§三.6 重定，不删）', () => {
    expect([...byName.keys()].sort()).toEqual([
      'browser_click',
      'browser_console',
      'browser_dialog',
      'browser_drag',
      'browser_eval_script',
      'browser_hover',
      'browser_navigate',
      'browser_network',
      'browser_press_key',
      'browser_read_page',
      'browser_screenshot',
      'browser_snapshot',
      'browser_tabs',
      'browser_type',
      'browser_upload',
      'browser_wait'
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
