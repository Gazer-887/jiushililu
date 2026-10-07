import type { AgentTool } from '@shared/agent'
import { getBrowserAdapter } from '../browser-bridge'
import { traceSpan } from '../../watchdog'

// 浏览器工具（P2）：让 Agent **直接操控内置浏览器** —— 与用户在右抽屉里看到的是同一个页面。
// 与 fetch_url 的分工：fetch_url 一次性抓静态 HTML（快，但拿不到 JS 渲染结果）；
// browser_* 走真实浏览器（拿得到渲染结果、能点击输入、能带上登录态）。
// 依赖倒置：本模块**不 import electron**，适配器经 browser-bridge 注入（实现在 src/main/browser.ts）。

// 与 fetch_url 的 MAX_BODY_BYTES（512KB）同口径（2026-09-16 用户实测 2 万字不够读网页）：
// 工具层不再自设小阈值，正文交给内核窗口化统一兜底（省 token 档位决定压多少，报错现场有保护）。
const MAX_READ = 512 * 1024

function noBrowser(): string {
  return '错误：内置浏览器未初始化（适配器随主窗口创建注入；主窗口不存在时不会自动就绪，重试无效）。可改用 fetch_url 抓取静态页面，或重启应用恢复主窗口'
}

/** 入参取字符串（缺省/非字符串一律空串，由各工具报"不能为空"人话） */
function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : ''
}

export interface BrowserToolDeps {
  /**
   * 浏览器操作开关本轮值（D-155 B1-a / plan60 §三.5：关 = 整批不下发）。
   * run 层必传显式值；工厂默认开**只为兼容历史单测**（D-119 ① 的"缺省=关"落在 run 入参层，
   * 见 runner.ts composition 注释 —— 工厂默认值不参与安全判定）。
   */
  browserControlEnabled?: boolean
  /**
   * 截图落盘（run 层由 attachmentsRoot 装配；不传 = 截图工具报"暂存未配置"人话，不静默吞图）。
   * 返回落盘 ref 文本（供 images/forward 组装），null = 存失败（工具转人话）。
   */
  saveScreenshot?: (pngBase64: string) => string | null
}

export function createBrowserTools(deps: BrowserToolDeps = {}): AgentTool[] {
  // 开关关 = 整批不下发（B1-a 语义；WARN 由装配层发，这里只负责"没有"）。
  if (deps.browserControlEnabled === false) return []
  const saveScreenshot = deps.saveScreenshot
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

  // plan49 A 档：给浏览器往返补进出面包屑。它们是 plan49 §9.1 列的三类嫌疑里唯一
  // 既不走 IPC 通道、也不是同步 fs 的那类 —— 原先一条记录都不产生。
  // 一处包全部工具，不逐个改 execute（自觉打点必漏，与 index.ts 的 IPC 包装器同理）。
  // ⚠️ 异步跨度只进面包屑，不进停滞归属 —— 见 watchdog.ts traceSpan。
  const tools: AgentTool[] = [
    browser_navigate,
    browser_read_page,
    browser_click,
    browser_type,
    defineHover(),
    definePressKey(),
    defineDrag(),
    defineScreenshot(saveScreenshot),
    defineSnapshot(),
    defineEvalScript(),
    defineConsole(),
    defineNetwork(),
    defineDialog(),
    defineTabs(),
    defineUpload(),
    defineWait()
  ]
  return tools.map((t) => {
    const raw = t.execute.bind(t)
    return {
      ...t,
      execute: (args: Record<string, unknown>) =>
        traceSpan(`browser:${t.schema.name}`, () => raw(args))
    }
  })
}

function defineHover(): AgentTool {
  return {
    schema: {
      name: 'browser_hover',
      description: '真鼠标悬停到网页元素上（悬停菜单/预览这类，合成事件不可靠）',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'CSS 选择器或可见文本' } },
        required: ['target']
      }
    },
    async execute(args) {
      const target = str(args, 'target')
      if (!target.trim()) return '错误：target 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.hover(target)
      } catch (err) {
        return `错误：悬停失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function definePressKey(): AgentTool {
  return {
    schema: {
      name: 'browser_press_key',
      description: '向当前页面发送一次按键（如 Enter / Escape / Tab / 方向键，单字符直接输入该字符）',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: '键名（如 Enter）或单字符' } },
        required: ['key']
      }
    },
    async execute(args) {
      const key = str(args, 'key')
      if (!key) return '错误：key 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.pressKey(key)
      } catch (err) {
        return `错误：按键失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineDrag(): AgentTool {
  return {
    schema: {
      name: 'browser_drag',
      description: '真鼠标从一处按住拖到另一处（滑块/画布/拖拽排序这类，合成事件拖不动）',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点：CSS 选择器或可见文本' },
          to: { type: 'string', description: '终点：CSS 选择器或可见文本' }
        },
        required: ['from', 'to']
      }
    },
    async execute(args) {
      const from = str(args, 'from')
      const to = str(args, 'to')
      if (!from.trim() || !to.trim()) return '错误：from/to 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.drag(from, to)
      } catch (err) {
        return `错误：拖拽失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineScreenshot(saveScreenshot: BrowserToolDeps['saveScreenshot']): AgentTool {
  return {
    schema: {
      name: 'browser_screenshot',
      description: '截取内置浏览器当前页（落盘后随下轮请求出示给模型，与旧图重看同一通路）',
      parameters: { type: 'object', properties: {} }
    },
    async execute() {
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      if (!saveScreenshot) return '错误：截图暂存未配置（装配层未注入落盘器），请先配置附件落盘根'
      try {
        const shot = await b.screenshot()
        const ref = saveScreenshot(shot.base64)
        if (!ref) return '错误：截图落盘失败（类型不收/超上限），可改用 browser_read_page 读文本'
        const bytes = Buffer.byteLength(shot.base64, 'base64')
        return {
          text: `已截取当前页（${ref}，随下轮请求出示）。`,
          images: [{ name: ref, mime: shot.mime, bytes }],
          forwardImagesToModel: [{ mime: shot.mime, ref, base64: shot.base64 }]
        }
      } catch (err) {
        return `错误：截图失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineSnapshot(): AgentTool {
  return {
    schema: {
      name: 'browser_snapshot',
      description: '取当前页的可访问性快照（元素 role/名称/选择器，供 click/type/hover 定位用）',
      parameters: { type: 'object', properties: {} }
    },
    async execute() {
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.snapshot()
      } catch (err) {
        return `错误：快照失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineEvalScript(): AgentTool {
  return {
    schema: {
      name: 'browser_eval_script',
      // ⚠️ 风险注记必须留（B1-a §三之二）：开关开 = 完整授权，这段描述是用户与模型唯一的知情渠道
      description:
        '在内置浏览器当前页执行任意脚本并返回结果（高危：与在该页控制台粘贴执行等效，只对可信页面使用；返回超 4KB 截断）',
      parameters: {
        type: 'object',
        properties: { js: { type: 'string', description: '要执行的脚本' } },
        required: ['js']
      }
    },
    async execute(args) {
      const js = str(args, 'js')
      if (!js.trim()) return '错误：js 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.evalScript(js)
      } catch (err) {
        return `错误：脚本执行失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineConsole(): AgentTool {
  return {
    schema: {
      name: 'browser_console',
      description: '读内置浏览器当前标签页的 console 记录（页面报错先看这里）',
      parameters: { type: 'object', properties: {} }
    },
    async execute() {
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.consoleMessages()
      } catch (err) {
        return `错误：读取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineNetwork(): AgentTool {
  return {
    schema: {
      name: 'browser_network',
      description: '读内置浏览器当前标签页的网络请求记录（接口不通/资源 404 先看这里）',
      parameters: { type: 'object', properties: {} }
    },
    async execute() {
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.networkRequests()
      } catch (err) {
        return `错误：读取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineDialog(): AgentTool {
  return {
    schema: {
      name: 'browser_dialog',
      description: '处理内置浏览器当前挂起的网页弹窗（无挂起时报最后一条记录；页面有兜底自动关闭，不会卡死）',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'accept 接受 / dismiss 关闭' },
          promptText: { type: 'string', description: 'prompt 弹窗的填入文本（可选）' }
        },
        required: ['action']
      }
    },
    async execute(args) {
      const action = str(args, 'action')
      if (action !== 'accept' && action !== 'dismiss') return '错误：action 只能是 accept 或 dismiss'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        const promptText = str(args, 'promptText')
        return await b.handleDialog(action, promptText ? promptText : undefined)
      } catch (err) {
        return `错误：处理失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineTabs(): AgentTool {
  return {
    schema: {
      // 单工具 + action 枚举（先例：actOnGoal 同形状；四个标签动作拆四个工具是噪音）
      name: 'browser_tabs',
      description: '管理内置浏览器的标签页（列出/新建/切换/关闭；切走的标签不丢状态）',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list 列出 / new 新建 / select 切换 / close 关闭' },
          id: { type: 'string', description: 'select/close 用的标签 id（list/new 不用）' },
          url: { type: 'string', description: 'new 用的初始网址（可选，缺省空白页）' }
        },
        required: ['action']
      }
    },
    async execute(args) {
      const action = str(args, 'action')
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        if (action === 'list') {
          const list = b.listTabs()
          return list.length === 0
            ? '当前没有打开的标签页'
            : list.map((t) => `${t.id}：${t.title || '(无标题)'}（${t.url}）`).join('\n')
        }
        if (action === 'new') {
          const url = str(args, 'url')
          const t = await b.newTab(url ? url : undefined)
          return `已新建标签页 ${t.id}（${t.url}）`
        }
        const id = str(args, 'id')
        if (!id) return '错误：select/close 需要 id（先 browser_tabs list 看一眼）'
        if (action === 'select') {
          const t = b.selectTab(id)
          return t ? `已切换到 ${t.id}（${t.url}）` : `没有这个标签页：${id}`
        }
        if (action === 'close') {
          return b.closeTab(id) ? `已关闭标签页 ${id}` : `没有这个标签页：${id}`
        }
        return '错误：action 只能是 list/new/select/close'
      } catch (err) {
        return `错误：标签操作失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineUpload(): AgentTool {
  return {
    schema: {
      name: 'browser_upload',
      description: '给页面上的文件选择框设置本地文件（只支持 CSS 选择器；Electron 无原生 chooser 拦截，走 CDP）',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '文件选择框的 CSS 选择器' },
          filePath: { type: 'string', description: '本机文件绝对路径' }
        },
        required: ['target', 'filePath']
      }
    },
    async execute(args) {
      const target = str(args, 'target')
      const filePath = str(args, 'filePath')
      if (!target.trim() || !filePath.trim()) return '错误：target/filePath 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        return await b.uploadFile(target, filePath)
      } catch (err) {
        return `错误：上传失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function defineWait(): AgentTool {
  return {
    schema: {
      name: 'browser_wait',
      description: '等页面出现指定文本或选择器（轮询；超时报"未出现"而非卡死，默认 10 秒、上限 60 秒）',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '文本或 CSS 选择器' },
          timeoutMs: { type: 'number', description: '超时毫秒（可选）' }
        },
        required: ['target']
      }
    },
    async execute(args) {
      const target = str(args, 'target')
      if (!target.trim()) return '错误：target 不能为空'
      const b = getBrowserAdapter()
      if (!b) return noBrowser()
      try {
        const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined
        return await b.waitFor(target, timeoutMs)
      } catch (err) {
        return `错误：等待失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}
