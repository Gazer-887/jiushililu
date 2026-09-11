import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createSystemTools } from '@main/agent/tools/system-tools'
import { assertHttpUrl, htmlToText } from '@main/agent/tools/web-tools'

const tools = createSystemTools(tmpdir())
const [listDir, searchFiles, runCommand] = tools

describe('list_dir（列目录工具）', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsl-list-'))
  const [listDir] = createSystemTools(root)
  beforeAll(() => {
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'x', 'utf8')
  })

  it('列出文件与目录并标注类型', async () => {
    const msg = await listDir.execute({ path: root })
    expect(msg).toContain('[目录] sub')
    expect(msg).toContain('[文件] a.txt')
  })

  it('越界路径拒绝（跨平台：root 的父目录 tmpdir 即界外）', async () => {
    const msg = await listDir.execute({ path: tmpdir() })
    expect(msg).toContain('越出工作区边界')
  })
})

describe('search_files（文本搜索工具）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsl-search-'))
  beforeAll(() => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'app.ts'), 'const magic = 42\nconst other = 1', 'utf8')
    writeFileSync(join(dir, 'notes.md'), '这里提到 magic 一词', 'utf8')
    writeFileSync(join(dir, 'node_modules', 'lib.js'), 'const magic = 0', 'utf8')
  })

  it('命中多文件并带路径行号，跳过 node_modules', async () => {
    const msg = await searchFiles.execute({ query: 'magic', path: dir })
    expect(msg).toContain('app.ts:1:')
    expect(msg).toContain('notes.md:1:')
    expect(msg).not.toContain('node_modules')
  })

  it('无匹配返回明确提示', async () => {
    const msg = await searchFiles.execute({ query: '不存在的词xyz', path: dir })
    expect(msg).toBe('（无匹配）')
  })

  it('空 query 拒绝', async () => {
    const msg = await searchFiles.execute({ query: '', path: dir })
    expect(msg).toContain('不能为空')
  })
})

describe('run_command（命令执行工具）', () => {
  it('执行并返回 stdout', async () => {
    const msg = await runCommand.execute({ command: 'echo jsl-ok' })
    expect(msg).toContain('jsl-ok')
  }, 15000)

  it('非零退出返回错误信息与输出', async () => {
    const msg = await runCommand.execute({ command: 'node -e "process.exit(3)"' })
    expect(msg).toContain('exit=3')
  }, 15000)

  it('空命令拒绝', async () => {
    const msg = await runCommand.execute({ command: '  ' })
    expect(msg).toContain('不能为空')
  })
})

describe('web-tools 纯函数', () => {
  it('assertHttpUrl 拒绝非 http/https 协议', () => {
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow('仅支持 http/https')
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow('仅支持 http/https')
    expect(assertHttpUrl('https://example.com/x').protocol).toBe('https:')
  })

  it('htmlToText 去标签去脚本', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><script>x()</script><h1>标题</h1><p>正文 &amp; 更多</p></body></html>'
    const text = htmlToText(html)
    expect(text).not.toContain('<')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('x()')
    expect(text).toContain('标题')
    expect(text).toContain('正文 & 更多')
  })
})

describe('SSRF 防护（isBlockedHost）', () => {
  it('回环/私网/链路本地一律拦截', async () => {
    const { isBlockedHost } = await import('@main/agent/tools/web-tools')
    expect(isBlockedHost('127.0.0.1')).toBe(true)
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('10.0.0.5')).toBe(true)
    expect(isBlockedHost('172.16.3.4')).toBe(true)
    expect(isBlockedHost('192.168.1.1')).toBe(true)
    expect(isBlockedHost('169.254.169.254')).toBe(true)
    expect(isBlockedHost('::1')).toBe(true)
    expect(isBlockedHost('example.com')).toBe(false)
    expect(isBlockedHost('172.32.0.1')).toBe(false)
  })

  it('assertHttpUrl 对内网地址抛错', async () => {
    const { assertHttpUrl } = await import('@main/agent/tools/web-tools')
    expect(() => assertHttpUrl('http://127.0.0.1:8080/x')).toThrow('内网/回环')
    expect(() => assertHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow('内网/回环')
  })
})

describe('symlink 逃逸防护（resolveInsideWorkspace）', () => {
  it('工作区内的符号链接指向外部时被拒绝', async () => {
    const { resolveInsideWorkspace } = await import('@main/agent/guard')
    const root = mkdtempSync(join(tmpdir(), 'jsl-sym-'))
    const outside = mkdtempSync(join(tmpdir(), 'jsl-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'top secret', 'utf8')
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      return // 环境不允许建链接（无权限）时跳过，不误报
    }
    // 正常文件仍通过
    expect(resolveInsideWorkspace(root, 'normal.txt')).toBe(join(root, 'normal.txt'))
    // 经符号链接指向外部 → 拒绝
    expect(resolveInsideWorkspace(root, 'link/secret.txt')).toBe(null)
  })
})
