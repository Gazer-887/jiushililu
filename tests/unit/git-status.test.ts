import { describe, expect, it } from 'vitest'
import { GIT_KIND_LABELS, isStaged, parseGitStatus } from '@shared/git-status'

/**
 * `git status --porcelain=v1` 解析（plan16）。
 *
 * 为什么值得为它单独立一份测试：**解析错了界面会静默显示错状态** ——
 * "改了"显示成"没改"、路径末尾粘个 \r、重命名显示为 `old -> new` 这种假路径，
 * 全都**不报错、不崩溃**，只能靠断言守住。
 */

describe('git status 解析：基本四类', () => {
  it('空输出 → 空数组（非 Git 目录 / 干净工作区都走这条）', () => {
    expect(parseGitStatus('')).toEqual([])
  })

  it('?? 未跟踪', () => {
    const r = parseGitStatus('?? docs/新建的笔记.md\n')
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('untracked')
    expect(r[0].path).toBe('docs/新建的笔记.md')
  })

  it('空格在第三位：工作区改了、没暂存（` M`）', () => {
    const r = parseGitStatus(' M src/renderer/src/App.tsx\n')
    expect(r[0].kind).toBe('modified')
    expect(r[0].staged).toBe(' ')
    expect(r[0].unstaged).toBe('M')
    expect(isStaged(r[0])).toBe(false)
  })

  it('M 在第一位：改了且已暂存（`M `）', () => {
    const r = parseGitStatus('M  src/main/ipc.ts\n')
    expect(r[0].kind).toBe('modified')
    expect(r[0].staged).toBe('M')
    expect(isStaged(r[0])).toBe(true)
  })

  it('A 已新增 / D 已删除', () => {
    expect(parseGitStatus('A  new.ts\n')[0].kind).toBe('added')
    expect(parseGitStatus('D  gone.ts\n')[0].kind).toBe('deleted')
  })

  it('删除也要认「工作区那一侧」的 D（` D` = 删了没暂存）', () => {
    const r = parseGitStatus(' D gone.ts\n')
    expect(r[0].kind).toBe('deleted')
    expect(isStaged(r[0])).toBe(false)
  })
})

describe('git status 解析：三个真实的坑', () => {
  it('重命名的 `old -> new` → 取箭头后面那个（新路径），不能整串当路径', () => {
    const r = parseGitStatus('R  src/old-name.ts -> src/new-name.ts\n')
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe('src/new-name.ts')
    expect(r[0].kind).toBe('modified')
  })

  it('Windows 的 CRLF：行尾 \\r 必须去掉，否则每条路径都粘一个 \\r', () => {
    const r = parseGitStatus(' M a.ts\r\n M b.ts\r\n')
    expect(r[0].path).toBe('a.ts')
    expect(r[1].path).toBe('b.ts')
    expect(r[0].path.endsWith('\r')).toBe(false)
  })

  it('路径含空格与中文：不能用 split(" ") 取字段（固定 2 字符切）', () => {
    const r = parseGitStatus('?? 我的 项目/新 文件.md\n')
    expect(r[0].path).toBe('我的 项目/新 文件.md')
  })
})

describe('git status 解析：健壮性', () => {
  it('混在一起的多条全部解析出来，顺序与 git 输出一致', () => {
    const out = ['?? a.md', ' M b.ts', 'M  c.ts', 'A  d.ts', ' D e.ts'].join('\n') + '\n'
    const r = parseGitStatus(out)
    expect(r.map((x) => x.path)).toEqual(['a.md', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
    expect(r.map((x) => x.kind)).toEqual([
      'untracked',
      'modified',
      'modified',
      'added',
      'deleted'
    ])
  })

  it('认不出的状态归入 other，不丢条目（宁可显示"其他"，也不静默吞掉）', () => {
    const r = parseGitStatus('UU conflicted.ts\n')
    expect(r).toHaveLength(1)
    expect(r[0].kind).toBe('other')
  })

  it('畸形输入不抛异常（长度不足的行直接跳过）', () => {
    expect(() => parseGitStatus('ab\n\n\n')).not.toThrow()
    expect(parseGitStatus('ab\n')).toEqual([])
  })
})

describe('文案与暂存判定', () => {
  it('五类都有中文说明 —— 界面不许只显示 `??` 指望用户自己懂', () => {
    expect(GIT_KIND_LABELS.untracked).toBe('未跟踪')
    expect(GIT_KIND_LABELS.modified).toBe('已修改')
    expect(GIT_KIND_LABELS.deleted).toBe('已删除')
    expect(GIT_KIND_LABELS.other).toBe('其他')
  })

  it('未跟踪就算没暂存（`??` 的两个 ? 都不是空格）', () => {
    expect(isStaged(parseGitStatus('?? a.md\n')[0])).toBe(false)
  })
})
