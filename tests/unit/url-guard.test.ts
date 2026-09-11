import { describe, expect, it } from 'vitest'
import { isExternallyOpenable, isInternalUrl } from '@main/url-guard'

// 导航守卫（plan8 R3）——安全关键逻辑，判定错一个就等于防线失守，故逐条断言。
//
// 背景：这两条守卫此前**完全缺失**，后果是
//   ① target="_blank" 外链弹出无地址栏的 Electron 窗口（钓鱼）
//   ② 主窗口可被导航到任意网站（应用被替换）

const DEV = 'http://localhost:5173'

describe('isInternalUrl（只有自家页面允许主窗口导航过去）', () => {
  it('允许 file:// 产物（生产态）', () => {
    expect(isInternalUrl('file:///D:/jiushililu/out/renderer/index.html')).toBe(true)
  })

  it('允许开发态 vite 地址', () => {
    expect(isInternalUrl(`${DEV}/`, DEV)).toBe(true)
    expect(isInternalUrl(`${DEV}/index.html`, DEV)).toBe(true)
  })

  it('拒绝外部网站', () => {
    for (const u of ['https://evil.com', 'http://evil.com/x', 'https://github.com/a/b']) {
      expect(isInternalUrl(u, DEV), u).toBe(false)
    }
  })

  it('生产态（无 devUrl）不放行任何 http(s)', () => {
    expect(isInternalUrl('http://localhost:5173/', undefined)).toBe(false)
  })

  it('拒绝伪装成 dev 地址的前缀（防前缀混淆）', () => {
    // 前缀匹配（startsWith）会误放行这两类 —— 后者只需攻击者注册同前缀域名即可绕过
    expect(isInternalUrl('http://localhost:51730/', DEV)).toBe(false)
    expect(isInternalUrl('http://localhost:5173.evil.com/', DEV)).toBe(false)
    // 端口不同也不放过
    expect(isInternalUrl('http://localhost:9999/', DEV)).toBe(false)
  })

  it('放行 dev 源下的任意路径（同源导航）', () => {
    expect(isInternalUrl(`${DEV}/index.html`, DEV)).toBe(true)
    expect(isInternalUrl(`${DEV}/@vite/client`, DEV)).toBe(true)
  })

  it('无法解析的 URL 一律视为外部', () => {
    expect(isInternalUrl('not a url', DEV)).toBe(false)
    expect(isInternalUrl('', DEV)).toBe(false)
  })

  it('拒绝 javascript: 与 data: 协议', () => {
    expect(isInternalUrl('javascript:alert(1)', DEV)).toBe(false)
    expect(isInternalUrl('data:text/html,<h1>x</h1>', DEV)).toBe(false)
  })
})

describe('isExternallyOpenable（哪些才配交给系统浏览器）', () => {
  it('放行 http 与 https', () => {
    expect(isExternallyOpenable('http://example.com')).toBe(true)
    expect(isExternallyOpenable('https://example.com/a?b=c')).toBe(true)
    expect(isExternallyOpenable('HTTPS://EXAMPLE.COM')).toBe(true) // 大小写不敏感
  })

  it('拒绝 file: / javascript: / data: —— 交给 openExternal 是危险的', () => {
    for (const u of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'mailto:a@b.com',
      'chrome://settings'
    ]) {
      expect(isExternallyOpenable(u), u).toBe(false)
    }
  })
})
