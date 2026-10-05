// B1-a 门控单测（D-155）：能力分类四类＋优先级＋门控新口径。旧决策 3/3b 口径已随实现删除。
import { describe, expect, it } from 'vitest'
import {
  classifyCapability,
  classifyServer,
  gateComputerUseTool,
  COMPUTER_USE_ALLOWLIST
} from '@shared/computer-use'

describe('classifyCapability（四类 + 优先级）', () => {
  it('windows-mcp 专名 → desktop（含推荐卡写入的命名）', () => {
    expect(classifyCapability('windows-mcp', 'uvx windows-mcp serve', 'Screenshot')).toBe('desktop')
    expect(classifyCapability('my-desktop', 'uvx windows-mcp@1.0', 'Anything')).toBe('desktop')
  })
  it('浏览器信号 → browser（server 名 / 启动命令 / 工具名三处任一）', () => {
    expect(classifyCapability('playwright', 'npx @playwright/mcp', 'browser_snapshot')).toBe('browser')
    expect(classifyCapability('my-auto', 'node server.js', 'navigate_page')).toBe('browser')
    expect(classifyCapability('my-auto', 'node server.js', 'browser_take_screenshot')).toBe('browser')
  })
  it('桌面动词 → desktop（server 名或工具名）', () => {
    expect(classifyCapability('my-tools', '', 'Click')).toBe('desktop')
    expect(classifyCapability('screen-helper', '', 'capture')).toBe('desktop')
  })
  it('普通 server → other（context7 / chromadb 都不许误判成能力类）', () => {
    expect(classifyCapability('context7', '', 'query-docs')).toBe('other')
    expect(classifyCapability('chromadb', '', 'query')).toBe('other')
  })
  it('优先级：windows-mcp > 浏览器特征 > 桌面动词，不靠实现顺序', () => {
    expect(classifyCapability('windows-mcp', '', 'navigate_page')).toBe('desktop')
    expect(classifyCapability('click-helper', '', 'navigate_page')).toBe('browser')
  })
})

describe('classifyServer（整 server 取最强一档）', () => {
  it('工具里有一条 browser 即整 server 判 browser', () => {
    expect(classifyServer('my-auto', '', ['query', 'navigate_page'])).toBe('browser')
  })
  it('server 无信号但工具有桌面动词 → desktop；全无 → other', () => {
    expect(classifyServer('my-tools', '', ['Click'])).toBe('desktop')
    expect(classifyServer('context7', '', ['query-docs'])).toBe('other')
  })
})

describe('gateComputerUseTool（D-155：开关开 = 完整授权）', () => {
  it('other 类直通（开关状态无关）', () => {
    expect(gateComputerUseTool({ capability: 'other', enabled: false })).toBe('keep')
  })
  it('桌面类：关全拦、开全放（含白名单外的 PowerShell —— 名单不再参与放行）', () => {
    expect(gateComputerUseTool({ capability: 'desktop', enabled: false })).toBe('drop-server-off')
    expect(gateComputerUseTool({ capability: 'desktop', enabled: true })).toBe('keep')
  })
  it('浏览器类与桌面类同口径', () => {
    expect(gateComputerUseTool({ capability: 'browser', enabled: false })).toBe('drop-server-off')
    expect(gateComputerUseTool({ capability: 'browser', enabled: true })).toBe('keep')
  })
  it('注记表还在（删了它会连 Process 类风险注记一起丢，D-155 连带）', () => {
    expect(COMPUTER_USE_ALLOWLIST).toContain('Process')
  })
})

describe('forceMainDisplay（O2：display 是工具参数，按 schema 覆写）', () => {
  it('array→[0]、integer→0、无 display 参数不动', async () => {
    const { forceMainDisplay } = await import('@shared/computer-use')
    expect(
      forceMainDisplay({ properties: { display: { type: 'array' }, x: { type: 'string' } } }, { x: 'a' })
    ).toEqual({ x: 'a', display: [0] })
    expect(forceMainDisplay({ properties: { display: { type: 'integer' } } }, { display: 2 })).toEqual({ display: 0 })
    expect(forceMainDisplay({ properties: { x: {} } }, { x: 1 })).toEqual({ x: 1 })
    expect(forceMainDisplay(undefined, { x: 1 })).toEqual({ x: 1 })
  })
})
