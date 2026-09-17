// plan44 S1 门控单测：白名单命中才放行 / 未开关全拦 / 非桌面派直通 / 桌面派识别。
import { describe, expect, it } from 'vitest'
import { gateComputerUseTool, isWindowsMcpServer, COMPUTER_USE_ALLOWLIST } from '@shared/computer-use'

describe('isWindowsMcpServer（配置名或启动命令任一命中）', () => {
  it('名字命中 / uvx windows-mcp 命中 / 都不命中', () => {
    expect(isWindowsMcpServer('windows-mcp', 'uvx windows-mcp')).toBe(true)
    expect(isWindowsMcpServer('my-desktop', 'uvx windows-mcp@1.0')).toBe(true)
    expect(isWindowsMcpServer('playwright', 'npx @playwright/mcp')).toBe(false)
  })
})

describe('gateComputerUseTool（决策 3 + 3b）', () => {
  it('桌面派未开启 → 全拦（含白名单内的 Screenshot）', () => {
    expect(
      gateComputerUseTool({ isComputerUseServer: true, enabled: false, toolName: 'Screenshot' })
    ).toBe('drop-server-off')
  })
  it('开启后：白名单命中放行（含 Process），未知/被屏蔽项（PowerShell/FileSystem/Registry/Scrape）一律拦', () => {
    for (const name of COMPUTER_USE_ALLOWLIST) {
      expect(gateComputerUseTool({ isComputerUseServer: true, enabled: true, toolName: name })).toBe('keep')
    }
    for (const name of ['PowerShell', 'FileSystem', 'Registry', 'Scrape', 'BrandNewTool']) {
      expect(gateComputerUseTool({ isComputerUseServer: true, enabled: true, toolName: name })).toBe('drop-not-allowlisted')
    }
  })
  it('非桌面派 server 不受本闸影响（浏览器派照常）', () => {
    expect(gateComputerUseTool({ isComputerUseServer: false, enabled: false, toolName: 'browser_snapshot' })).toBe('keep')
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
