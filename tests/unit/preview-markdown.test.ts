import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MessageMarkdown from '../../src/renderer/src/components/MessageMarkdown'
afterEach(() => vi.unstubAllGlobals())
describe('本地Markdown复用格式化但不自动取外部资源', () => {
  it('真实标题/表格可见，远程图片/链接不变成自动网络入口，HTML不执行', () => {
    // 本仓主进程Vitest使用classic JSX；真实React外设补上，不替换Markdown解析规则。
    vi.stubGlobal('React', React)
    const content = '# LOCAL_HEADING\n\n| Key | Value |\n|---|---|\n| x | y |\n\n![REMOTE_ALT](https://example.invalid/secret.png)\n\n[Link](https://example.invalid/)\n\n<script>SECRET_SCRIPT</script>'
    const html = renderToStaticMarkup(createElement(MessageMarkdown, { content, readonlyPreview: true }))
    expect(html).toContain('<h1>LOCAL_HEADING</h1>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="https://')
    expect(html).not.toContain('<script>')
    const regular = renderToStaticMarkup(createElement(MessageMarkdown, { content }))
    expect(regular).toContain('<img')
    expect(regular).toContain('href="https://')
  })
})
