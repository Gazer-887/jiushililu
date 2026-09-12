import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PREVIEW_CSP,
  PREVIEW_FRAME_SRC,
  PREVIEW_HOST,
  PREVIEW_SCHEME,
  isHtmlFile,
  previewContentType,
  previewUrlToWorkspaceRel,
  workspaceRelToPreviewUrl
} from '@shared/html-preview'

/**
 * HTML 沙箱预览（plan7 批 A3 补）——纯逻辑部分。
 *
 * 真渲染与"脚本到底跑没跑"由 `scripts/verify-shot.cjs` 采像素验（那里才看得见结果）；
 * 这里管的是**可判定**的那一半：URL 换算、边界收口、类型白名单、策略字面量。
 */

describe('isHtmlFile', () => {
  it('认 html / htm / xhtml，大小写不敏感', () => {
    expect(isHtmlFile('页面.html')).toBe(true)
    expect(isHtmlFile('A.HTM')).toBe(true)
    expect(isHtmlFile('x.xhtml')).toBe(true)
  })

  it('不把别的当网页（md 走富文本那条线，不是这里）', () => {
    expect(isHtmlFile('README.md')).toBe(false)
    expect(isHtmlFile('a.htmlx')).toBe(false)
    expect(isHtmlFile('html')).toBe(false)
  })
})

describe('workspaceRelToPreviewUrl', () => {
  it('保留目录层级，中文与空格都按段转义', () => {
    expect(workspaceRelToPreviewUrl('页面/首页.html')).toBe(
      `${PREVIEW_SCHEME}://${PREVIEW_HOST}/%E9%A1%B5%E9%9D%A2/%E9%A6%96%E9%A1%B5.html`
    )
    expect(workspaceRelToPreviewUrl('a b/c.html')).toBe(`${PREVIEW_SCHEME}://${PREVIEW_HOST}/a%20b/c.html`)
  })

  it('越界 / 绝对 / 反斜杠 / 空段一律不给 URL（宁可不给开关，也不给白框）', () => {
    for (const bad of [
      '',
      '../出去.html',
      'a/../../出.html',
      '/绝对.html',
      'C:/盘符.html',
      'D:\\反斜杠.html',
      'a//b.html',
      './a.html',
      'a/./b.html'
    ]) {
      expect(workspaceRelToPreviewUrl(bad), bad).toBeNull()
    }
  })

  it('往返一致（含中文与子目录）', () => {
    const rel = '文档/示例 页面.html'
    const url = workspaceRelToPreviewUrl(rel)
    expect(url).not.toBeNull()
    expect(previewUrlToWorkspaceRel(new URL(url as string).pathname)).toBe(rel)
  })
})

describe('previewUrlToWorkspaceRel（这里是**不可信输入**，必须逐项收口）', () => {
  it('正常路径照收', () => {
    expect(previewUrlToWorkspaceRel('/a/b.html')).toBe('a/b.html')
    expect(previewUrlToWorkspaceRel('/%E4%B8%AD/x.html')).toBe('中/x.html')
  })

  it('拒绝遍历、空段、盘符、反斜杠、NUL', () => {
    for (const bad of [
      '/../x.html',
      '/a/../../x.html',
      '/a/./b.html',
      '//x.html',
      '/',
      '',
      'x.html', // 不以 / 开头
      '/C:/x.html',
      '/a%5Cb.html', // 编码后的反斜杠
      '/a%00b.html',
      '/a/%2e%2e/x.html' // 编码后的 ..
    ]) {
      expect(previewUrlToWorkspaceRel(bad), bad).toBeNull()
    }
  })

  it('畸形百分号转义不会抛异常，只会被拒（否则一个坏 URL 就能打崩处理器）', () => {
    expect(previewUrlToWorkspaceRel('/%zz.html')).toBeNull()
    expect(previewUrlToWorkspaceRel('/a%2')).toBeNull()
  })
})

describe('previewContentType：白名单只放"能显示"的，**不放能执行的**', () => {
  it('网页 / 样式 / 图片 / 字体 / 媒体放行', () => {
    expect(previewContentType('a.html')).toContain('text/html')
    expect(previewContentType('a.css')).toContain('text/css')
    expect(previewContentType('a.PNG')).toBe('image/png')
    expect(previewContentType('a.woff2')).toBe('font/woff2')
  })

  it('脚本与其它可执行类型**不在**白名单（预览永不执行工作区代码）', () => {
    for (const bad of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.exe', 'a.ps1', 'a.bat', 'a.env', 'a', 'a.json']) {
      expect(previewContentType(bad), bad).toBeNull()
    }
  })
})

describe('预览策略（响应头，比 meta 更硬）', () => {
  it('断脚本 + 断网 + 自我沙箱，且只放宽内联样式这一项', () => {
    expect(PREVIEW_CSP).toContain('sandbox')
    expect(PREVIEW_CSP).toContain("script-src 'none'")
    expect(PREVIEW_CSP).toContain("default-src 'none'")
    expect(PREVIEW_CSP).toContain("style-src 'unsafe-inline' 'self'")
  })

  it('**不放行任何网络来源**（外链图片/字体/CDN 一律拿不到）', () => {
    expect(PREVIEW_CSP).not.toMatch(/https?:/)
    expect(PREVIEW_CSP).not.toContain('*')
  })
})

/**
 * 防"配置漂移"：`frame-src` 那行在前端构建配置里（不 import 本模块），
 * 于是它就成了**第二份事实**—— 一旦有人改了常量忘了配置，预览会静默变成白框。
 * 这条断言把两份钉在一起（改一处不改另一处 = 红）。
 */
describe('构建配置与常量不许漂移', () => {
  const config = readFileSync(join(process.cwd(), 'config/electron.vite.config.ts'), 'utf8')

  it('开发/生产两套 CSP 都放行了预览协议', () => {
    // 只挑**数组里真写的条目**（注释里也会出现 frame-src 这个词，
    // 拿 includes 去数会数到注释 —— 那种口径会把"改坏了"和"注释里提了一嘴"混在一起）
    const entries = config.split('\n').filter((l) => /^\s*"frame-src /.test(l))
    expect(entries.length).toBe(2)
    for (const line of entries) {
      expect(line).toContain(PREVIEW_SCHEME)
      expect(line).toContain("'self'")
    }
  })

  it('frame-src 的放行范围与共享常量是同一个值', () => {
    expect(PREVIEW_FRAME_SRC).toBe(`'self' ${PREVIEW_SCHEME}:`)
    expect(config).toContain(PREVIEW_FRAME_SRC)
  })
})
