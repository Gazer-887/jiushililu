// plan60 单测：真输入落点 / 开关发行 / 只读改正 / 截图形状 / 取证缓冲。
// electron 碰不到的（browser.ts 本体）走结构守卫 + 门禁 UI 断言 + 装机点验，三层见各自位置。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { centerOfRect, setBrowserAdapter, type BrowserAdapter } from '@main/agent/browser-bridge'
import { DIALOG_AUTO_DISMISS_MS, RingBuffer, TRACE_CAP } from '@main/agent/browser-utils'
import { createBrowserTools } from '@main/agent/tools/browser-tools'
import { allowedToolsFor } from '@main/agent/runner'

const ALL15 = [
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
].sort()

describe('落点数学（点错比没点到更坏）', () => {
  it('矩形中心四舍五入到整数像素', () => {
    expect(centerOfRect({ x: 10, y: 20, width: 101, height: 51 })).toEqual({ x: 61, y: 46 })
    expect(centerOfRect({ x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 1, y: 1 })
  })
})

describe('K22 结构守卫：点击路径里不许出现合成 click', () => {
  it('browser.ts 的 browserClick 函数体内无 `.click(`（注释行先剥掉）', () => {
    const src = readFileSync('src/main/browser.ts', 'utf-8')
    const body = src.slice(src.indexOf('export async function browserClick'))
    const code = body
      .slice(0, body.indexOf('\n}\n'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('.click(')
    // 但真鼠标三件必须在（守卫不是"删空了也绿"：删实现同样要红）
    expect(code).toContain('mouseDown')
    expect(code).toContain('mouseUp')
  })
  it('dialog 兜底在：javascriptDialogOpening 处理器里引用了自动关闭宽限（删了页面会被卡死）', () => {
    const src = readFileSync('src/main/browser.ts', 'utf-8')
    const at = src.indexOf('Page.javascriptDialogOpening')
    expect(at).toBeGreaterThan(-1)
    const window = src.slice(at, at + 1200)
    expect(window).toContain('DIALOG_AUTO_DISMISS_MS')
    expect(window).toContain('handleJavaScriptDialog')
  })
  it('console/network 监听在（删了取证双件变空记录；CDP 挂不上走"未就绪"人话，不静默）', () => {
    const src = readFileSync('src/main/browser.ts', 'utf-8')
    expect(src).toContain("wc.on('console-message'")
    expect(src).toContain("'Network.enable'")
    expect(src).toContain('CDP 未就绪')
  })
})

describe('开关发行（plan60 §三.5：关 = 整批不下发）', () => {
  it('关 → 空表；开 → 15 个全在（含 eval_script 的风险注记）', () => {
    expect(createBrowserTools({ browserControlEnabled: false })).toEqual([])
    const names = createBrowserTools({ browserControlEnabled: true }).map((t) => t.schema.name).sort()
    expect(names).toEqual(ALL15)
    const evalTool = createBrowserTools({ browserControlEnabled: true }).find(
      (t) => t.schema.name === 'browser_eval_script'
    )!
    expect(evalTool.schema.description).toContain('高危')
  })
})

describe('只读改正（plan60 §三.6：只读档只能看不能摸）', () => {
  it('只读档：navigate/read_page 在，click/type/hover/drag/press_key/upload/eval_script 不在', () => {
    const got = allowedToolsFor('read-only', undefined, [...ALL15, 'read_file'])
    expect(got).toContain('browser_navigate')
    expect(got).toContain('browser_read_page')
    for (const n of [
      'browser_click',
      'browser_type',
      'browser_hover',
      'browser_press_key',
      'browser_drag',
      'browser_eval_script',
      'browser_upload'
    ]) {
      expect(got).not.toContain(n)
    }
  })
  it('可写档：15 个全在（上限只收窄不扩大，开关另管）', () => {
    const got = allowedToolsFor('write', undefined, [...ALL15])
    expect(got.sort()).toEqual(ALL15)
  })
})

describe('截图形状（与 B2 view_image 同族：images + forward 对得上）', () => {
  it('saver 回 ref → images/forward 的 mime/ref/字节三对', async () => {
    const PNG64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const adapter: BrowserAdapter = {
      currentUrl: () => '',
      navigate: async (url) => ({ url, title: '' }),
      readPage: async () => '',
      click: async () => '',
      type: async () => '',
      hover: async () => '',
      pressKey: async () => '',
      drag: async () => '',
      screenshot: async () => ({ base64: PNG64, mime: 'image/png' }),
      snapshot: async () => '[]',
      evalScript: async () => '',
      consoleMessages: async () => '',
      networkRequests: async () => '',
      handleDialog: async () => '',
      listTabs: () => [],
      newTab: async () => ({ id: 't1', url: '', title: '' }),
      selectTab: () => null,
      closeTab: () => false,
      uploadFile: async () => '',
      waitFor: async () => ''
    }
    setBrowserAdapter(adapter)
    const [shot] = createBrowserTools({
      browserControlEnabled: true,
      saveScreenshot: () => 'shot-ref.png'
    }).filter((t) => t.schema.name === 'browser_screenshot')
    const out = (await shot!.execute({})) as {
      images: { name: string; mime: string; bytes: number }[]
      forwardImagesToModel: { mime: string; ref: string; base64: string }[]
    }
    expect(out.images).toEqual([{ name: 'shot-ref.png', mime: 'image/png', bytes: 4 }])
    expect(out.forwardImagesToModel).toEqual([{ mime: 'image/png', ref: 'shot-ref.png', base64: PNG64 }])
  })
  it('无 saver → 报"暂存未配置"人话，不静默吞图', async () => {
    setBrowserAdapter({
      currentUrl: () => '',
      navigate: async (url) => ({ url, title: '' }),
      readPage: async () => '',
      click: async () => '',
      type: async () => '',
      hover: async () => '',
      pressKey: async () => '',
      drag: async () => '',
      screenshot: async () => ({ base64: 'AAA=', mime: 'image/png' }),
      snapshot: async () => '[]',
      evalScript: async () => '',
      consoleMessages: async () => '',
      networkRequests: async () => '',
      handleDialog: async () => '',
      listTabs: () => [],
      newTab: async () => ({ id: 't1', url: '', title: '' }),
      selectTab: () => null,
      closeTab: () => false,
      uploadFile: async () => '',
      waitFor: async () => ''
    })
    const [shot] = createBrowserTools({ browserControlEnabled: true }).filter(
      (t) => t.schema.name === 'browser_screenshot'
    )
    expect(String(await shot!.execute({}))).toContain('暂存未配置')
  })
})

describe('取证缓冲（满了丢最旧，不抛）', () => {
  it('RingBuffer 到 cap 封顶，list 返回拷贝', () => {
    const b = new RingBuffer<string>(TRACE_CAP)
    for (let i = 0; i < TRACE_CAP + 5; i++) b.push(`m${i}`)
    expect(b.length).toBe(TRACE_CAP)
    expect(b.list()[0]).toBe('m5')
  })
  it('dialog 兜底宽限为正数（0 = 页面会被卡死，守卫值本身）', () => {
    expect(DIALOG_AUTO_DISMISS_MS).toBeGreaterThan(0)
  })
})
