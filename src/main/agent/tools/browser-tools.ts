import type { AgentTool } from '@shared/agent'
import { getBrowserAdapter } from '../browser-bridge'

// 浏览器工具（P2）：让 Agent **直接操控内置浏览器** —— 与用户在右抽屉里看到的是同一个页面。
// 与 fetch_url 的分工：fetch_url 一次性抓静态 HTML（快，但拿不到 JS 渲染结果）；
// browser_* 走真实浏览器（拿得到渲染结果、能点击输入、能带上登录态）。
// 依赖倒置：本模块**不 import electron**，适配器经 browser-bridge 注入（实现在 src/main/browser.ts）。

const MAX_READ = 20000

function noBrowser(): string {
  return '错误：内置浏览器尚未就绪（应用启动时初始化）。请稍后重试，或改用 fetch_url 抓取静态页面。'
}

export function createBrowserTools(): AgentTool[] {
  const browser_navigate: AgentTool = {
    schema: {
      name: 'browser_navigate',
      description:
        '在内置浏览器中打开一个网址（真实浏览器，支持 JS 渲染；用户可在右抽屉看到同一页面）',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的网址' } },
        required: ['url']
      }
    },
    async execute(args) {
      const url = typeof args['url'] === 'string' ? args['url'] : ''
      if (!url.trim()) return '错误：url 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        const s = await b.navigate(url)
        return `已打开：${s.title || s.url}（${s.url}）`
      } catch (err) {
        return `错误：打开失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const browser_read_page: AgentTool = {
    schema: {
      name: 'browser_read_page',
      description: '读取内置浏览器当前页面的文本内容（含 JS 渲染后的结果，比 fetch_url 更完整）',
      parameters: { type: 'object', properties: {} }
    },
    async execute() {
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      const url = b.currentUrl()
      if (!url || url === 'about:blank') {
        return '错误：浏览器还没有打开任何页面，请先用 browser_navigate 打开一个网址'
      }
      try {
        const text = await b.readPage()
        return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n（已截断）` : text
      } catch (err) {
        return `错误：读取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const browser_click: AgentTool = {
    schema: {
      name: 'browser_click',
      description: '点击网页元素：传 CSS 选择器（如 "#submit"）或元素上的可见文本（如 "登录"）',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'CSS 选择器或可见文本' } },
        required: ['target']
      }
    },
    async execute(args) {
      const target = typeof args['target'] === 'string' ? args['target'] : ''
      if (!target.trim()) return '错误：target 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.click(target)
      } catch (err) {
        return `错误：点击失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const browser_type: AgentTool = {
    schema: {
      name: 'browser_type',
      description: '在网页输入框中输入文本（选择器缺省时用页面第一个输入框）',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本' },
          target: { type: 'string', description: 'CSS 选择器（可选）' }
        },
        required: ['text']
      }
    },
    async execute(args) {
      const text = typeof args['text'] === 'string' ? args['text'] : ''
      if (!text) return '错误：text 不能为空'
      const target = typeof args['target'] === 'string' && args['target'].trim() ? args['target'] : 'input'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.type(target, text)
      } catch (err) {
        return `错误：输入失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return [browser_navigate, browser_read_page, browser_click, browser_type]
}
