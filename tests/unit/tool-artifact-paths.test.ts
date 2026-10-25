// 工具产物路径提取的命名断言（plan74 Agent 产物入口）：只信真实入参的 path，不信文本猜的。
// 直接 import 真实 toolArtifactPaths，喂 JSON 字符串 —— 不复制规则。
import { describe, it, expect } from 'vitest'
import { toolArtifactPaths } from '@shared/tool-detail'

describe('toolArtifactPaths：可信产物路径提取', () => {
  it('真实edit工具路径可提取，反斜杠按段检查，不放过Windows越界', () => {
    expect(toolArtifactPaths('edit', JSON.stringify({ path: 'src/app.ts' }))).toEqual(['src/app.ts'])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 'src\\app.ts' }))).toEqual(['src/app.ts'])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: '..\\outside.ts' }))).toEqual([])
  })
  it('write_file 的 path 入参被提取', () => {
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 'src/main/index.ts', content: 'x' }))).toEqual([
      'src/main/index.ts'
    ])
  })

  it('只认写/建类工具：read_file 不产文件', () => {
    expect(toolArtifactPaths('read_file', JSON.stringify({ path: 'a.ts' }))).toEqual([])
    expect(toolArtifactPaths('search_files', JSON.stringify({ query: 'x' }))).toEqual([])
  })

  it('绝对路径 / 盘符 / UNC 一律拒（那是系统文件，不是工作区产物）', () => {
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: '/etc/passwd' }))).toEqual([])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 'C:/Windows/x.txt' }))).toEqual([])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: '\\\\server\\share\\x' }))).toEqual([])
  })

  it('越界段（.. / . / 空段）拒 —— 与预览协议同口径', () => {
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: '../escape.ts' }))).toEqual([])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 'a/./b.ts' }))).toEqual([])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 'a//b.ts' }))).toEqual([])
  })

  it('入参解析失败 / 无 path / 非字符串 → 空（宁可少显示，不猜）', () => {
    expect(toolArtifactPaths('write_file', 'not json')).toEqual([])
    expect(toolArtifactPaths('write_file', JSON.stringify({ content: 'x' }))).toEqual([])
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 123 }))).toEqual([])
    expect(toolArtifactPaths('write_file', '')).toEqual([])
  })

  it('嵌套相对路径（合法产物）收下', () => {
    expect(toolArtifactPaths('write_file', JSON.stringify({ path: 'docs/guide/setup.md' }))).toEqual([
      'docs/guide/setup.md'
    ])
  })
})
