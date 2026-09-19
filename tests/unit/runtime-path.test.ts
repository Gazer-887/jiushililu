// plan43 S3a 判据单测：PATH 注入的纯函数层（基准快照 / shim 条目 / 幂等 / 指纹）。
// 本层刻意不碰 IO —— 写盘与接线归 S3b/S3c，那些由真渲染门禁与本机实测兜。
// 这里钉的是**语义本身**，尤其是三条「钉死」：钉死基准、钉死范围、钉死时机。
import { describe, expect, it } from 'vitest'
import {
  buildShimEntries,
  cmdShimContent,
  commandNameFromExecutable,
  injectRuntimePath,
  isOurShimContent,
  isShimDirPresent,
  primaryCommandName,
  RUNTIME_BIN_DIRNAME,
  runtimeFingerprint,
  shimFileName
} from '@shared/runtime-path'

const SHIM = 'C:/Users/Gazer/AppData/Roaming/jiushililu/runtime-bin'

describe('commandNameFromExecutable（去掉扩展名，不制造用户没选的命令）', () => {
  it('Windows 的 .exe 去后缀', () => {
    expect(commandNameFromExecutable('D:\\MiniConda3\\envs\\ai_env\\python.exe')).toBe('python')
  })

  it('反斜杠与正斜杠都能取到文件名', () => {
    expect(commandNameFromExecutable('/usr/bin/python3')).toBe('python3')
    expect(commandNameFromExecutable('C:\\Program Files\\nodejs\\node.exe')).toBe('node')
  })

  it('.cmd / .bat / .ps1 也去后缀', () => {
    expect(commandNameFromExecutable('C:\\x\\npm.cmd')).toBe('npm')
    expect(commandNameFromExecutable('C:\\x\\run.bat')).toBe('run')
  })

  it('⚠️ 保留 python3 原名 —— 不把 python3 折叠成 python（那是用户没选的命令）', () => {
    expect(commandNameFromExecutable('C:\\x\\python3.exe')).toBe('python3')
  })

  it('空路径不崩，返回空串', () => {
    expect(commandNameFromExecutable('')).toBe('')
  })
})

describe('shimFileName（Windows 用 .cmd，POSIX 用裸名）', () => {
  it('win32 → .cmd（免管理员权限，软链需开发者模式）', () => {
    expect(shimFileName('python', 'win32')).toBe('python.cmd')
  })

  it('linux / darwin → 裸名', () => {
    expect(shimFileName('python', 'linux')).toBe('python')
    expect(shimFileName('python', 'darwin')).toBe('python')
  })
})

describe('primaryCommandName（★ shim 叫什么由**语言**决定，不由文件名决定）', () => {
  it('python → python（取自 probeBins[0]）', () => {
    expect(primaryCommandName('python')).toBe('python')
  })

  it('node → node', () => {
    expect(primaryCommandName('node')).toBe('node')
  })

  it('未知语言 → 退回语言 id 本身（不崩、不产出空名）', () => {
    expect(primaryCommandName('ruby')).toBe('ruby')
  })

  it('可注入 specs（单测可钉死，不依赖真实表）', () => {
    expect(primaryCommandName('python', [{ id: 'python', label: 'P', probeBins: ['py'] }])).toBe('py')
  })

  it('probeBins 为空 → 退回语言 id', () => {
    expect(primaryCommandName('python', [{ id: 'python', label: 'P', probeBins: [] }])).toBe('python')
  })
})

describe('buildShimEntries（文件级隔离，不是目录级连带）', () => {
  it('每个选中项产出恰好一个 shim 条目', () => {
    const out = buildShimEntries(
      { python: 'D:\\MiniConda3\\envs\\ai_env\\python.exe', node: 'C:\\Program Files\\nodejs\\node.exe' },
      SHIM,
      'win32'
    )
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.shimName)).toEqual(['node.cmd', 'python.cmd'])
  })

  it('★ **换版本不换命令名**：python.exe → python3.exe，shim 仍叫 python.cmd', () => {
    const a = buildShimEntries({ python: 'C:\\py312\\python.exe' }, SHIM, 'win32')
    const b = buildShimEntries({ python: 'C:\\py313\\python3.exe' }, SHIM, 'win32')
    expect(a[0]?.shimName).toBe('python.cmd')
    expect(b[0]?.shimName).toBe('python.cmd')
  })

  it('**语言字典序排序** —— 产物可复现，不依赖对象插入序', () => {
    const a = buildShimEntries({ python: 'C:\\p\\python.exe', node: 'C:\\n\\node.exe' }, SHIM, 'win32')
    const b = buildShimEntries({ node: 'C:\\n\\node.exe', python: 'C:\\p\\python.exe' }, SHIM, 'win32')
    expect(a.map((e) => e.language)).toEqual(b.map((e) => e.language))
  })

  it('空值与空白被跳过（不是产出空 shim）', () => {
    const out = buildShimEntries({ python: '', node: '   ', uv: 'C:\\u\\uv.exe' }, SHIM, 'win32')
    expect(out).toHaveLength(1)
    expect(out[0]?.language).toBe('uv')
  })

  it('shimDir 尾部斜杠不会产生双斜杠', () => {
    const out = buildShimEntries({ python: 'C:\\p\\python.exe' }, SHIM + '/', 'win32')
    expect(out[0]?.shimPath).toBe(`${SHIM}\\python.cmd`)
  })

  it('POSIX 用正斜杠拼路径（名仍按语言取）', () => {
    const out = buildShimEntries({ python: '/usr/bin/python3' }, '/home/u/.jsl/runtime-bin', 'linux')
    expect(out[0]?.shimPath).toBe('/home/u/.jsl/runtime-bin/python')
  })
})

describe('cmdShimContent（转发脚本的内容）', () => {
  it('Windows：@echo off + 引号包原件路径 + %* 透传参数', () => {
    const c = cmdShimContent('C:\\Program Files\\Python\\python.exe', 'win32')
    expect(c).toContain('@echo off')
    expect(c).toContain('"C:\\Program Files\\Python\\python.exe"')
    expect(c).toContain('%*')
  })

  it('CRLF 行尾 —— Windows .cmd 用 LF 在某些 shell 下会出怪问题', () => {
    expect(cmdShimContent('C:\\x\\python.exe', 'win32')).toContain('\r\n')
  })

  it('POSIX：shebang + exec + "$@"', () => {
    const c = cmdShimContent('/usr/bin/python3', 'linux')
    expect(c.startsWith('#!/bin/sh')).toBe(true)
    expect(c).toContain('exec "/usr/bin/python3"')
    expect(c).toContain('"$@"')
  })
})

describe('injectRuntimePath ★ 核心：钉死基准 + 幂等（不层层叠加）', () => {
  const BASE = 'C:\\Windows\\system32;C:\\Program Files\\nodejs;D:\\MiniConda3'

  it('★ **基准为空 → 拒绝注入**（不许产出"只有 shim 的 PATH"）', () => {
    // 2026-09-19 交叉复查实测抓出：`injectRuntimePath('', SHIM)` 原返回 `SHIM` 单条，
    // 即**整个系统 PATH 丢失** —— git / npm / rg 全找不到，比"不注入"更糟。
    // 这是"防御性代码自身有缺陷"：`?? ''` 只让类型安全，没让语义安全。
    // 语义：不注入 = **基准原样返回**（空就是空，空白就是空白，不崩、不加工）。
    expect(injectRuntimePath('', SHIM, 'win32')).toBe('')
    expect(injectRuntimePath('   ', SHIM, 'win32')).toBe('   ')
    expect(injectRuntimePath(undefined, SHIM, 'win32')).toBe('')
    // POSIX 同判据（分隔符不同但语义一致）
    expect(injectRuntimePath('', '/shim', 'linux')).toBe('')
  })

  it('shim 目录插到**头部**', () => {
    const out = injectRuntimePath(BASE, SHIM, 'win32')
    expect(out.split(';')[0]).toBe(SHIM)
  })

  it('**不替换** —— 原始 PATH 的每一段都还在（git / npm / rg 仍找得到）', () => {
    const out = injectRuntimePath(BASE, SHIM, 'win32')
    for (const seg of BASE.split(';')) expect(out).toContain(seg)
  })

  it('★ 幂等：同一基准反复注入结果恒等（这是"不用 process.env"的原因）', () => {
    const once = injectRuntimePath(BASE, SHIM, 'win32')
    const twice = injectRuntimePath(once, SHIM, 'win32')
    const thrice = injectRuntimePath(twice, SHIM, 'win32')
    expect(twice).toBe(once)
    expect(thrice).toBe(once)
  })

  it('★ 脏输入也不叠加：传上一次的结果进来，仍只有**一个** shim 段', () => {
    const dirty = `${SHIM};${SHIM};${BASE}`
    const out = injectRuntimePath(dirty, SHIM, 'win32')
    const count = out.split(';').filter((p) => p === SHIM).length
    expect(count).toBe(1)
  })

  it('用户自己也在 PATH 里加过同名目录 → 一并收拢（消除歧义）', () => {
    const dirty = `C:\\a;${SHIM};C:\\b`
    const out = injectRuntimePath(dirty, SHIM, 'win32')
    expect(out.split(';').filter((p) => p === SHIM)).toHaveLength(1)
  })

  it('**不注入**：shimDir 为空串 → 基准原样返回', () => {
    expect(injectRuntimePath(BASE, '', 'win32')).toBe(BASE)
    expect(injectRuntimePath(BASE, '   ', 'win32')).toBe(BASE)
  })

  it('★ 基准为空 → 不注入（原样返回）—— 钉死"不产出只有 shim 的 PATH"', () => {
    // 语义 2026-09-19 修正：旧断言期望空基准也注入出 `SHIM` 单条，
    // 而那等于**整个系统 PATH 丢失**（git/npm/rg 全找不到），比不注入更糟。
    expect(injectRuntimePath(undefined, SHIM, 'win32')).toBe('')
    expect(injectRuntimePath('', SHIM, 'win32')).toBe('')
  })

  it('基准里的空段被清掉（`a;;b` 不是合法 PATH）', () => {
    const out = injectRuntimePath('C:\\a;;C:\\b;', SHIM, 'win32')
    expect(out.split(';').some((p) => p === '')).toBe(false)
  })

  it('POSIX 用冒号分隔，且**大小写敏感**', () => {
    const base = '/usr/bin:/usr/local/bin'
    const out = injectRuntimePath(base, '/home/u/bin', 'linux')
    expect(out).toBe('/home/u/bin:/usr/bin:/usr/local/bin')
  })

  it('Windows **大小写不敏感** —— 同目录不同大小写不会留两份', () => {
    const out = injectRuntimePath(`c:\\users\\gazer\\RUNTIME-BIN;${BASE}`, SHIM, 'win32')
    const lower = out.toLowerCase().split(';')
    expect(lower.filter((p) => p.replace(/[\\/]+$/, '') === SHIM.toLowerCase())).toHaveLength(1)
  })

  it('shimDir 尾部斜杠不影响判定', () => {
    const a = injectRuntimePath(BASE, SHIM, 'win32')
    const b = injectRuntimePath(BASE, SHIM + '\\', 'win32')
    expect(a).toBe(b)
  })
})

describe('isShimDirPresent（状态栏要读的是"真实生效值"）', () => {
  it('注入过了 → true', () => {
    expect(isShimDirPresent(injectRuntimePath('C:\\a', SHIM, 'win32'), SHIM, 'win32')).toBe(true)
  })

  it('没注入 → false', () => {
    expect(isShimDirPresent('C:\\a;C:\\b', SHIM, 'win32')).toBe(false)
  })

  it('undefined / 空 shimDir → false（不误报"已生效"）', () => {
    expect(isShimDirPresent(undefined, SHIM, 'win32')).toBe(false)
    expect(isShimDirPresent('C:\\a', '', 'win32')).toBe(false)
  })

  it('Windows 大小写不敏感（同目录换大小写照旧命中）', () => {
    expect(isShimDirPresent(SHIM.toUpperCase(), SHIM, 'win32')).toBe(true)
    expect(isShimDirPresent(SHIM.toLowerCase(), SHIM, 'win32')).toBe(true)
  })

  it('POSIX 大小写**敏感** —— 不同目录不误判为同一个', () => {
    expect(isShimDirPresent('/home/u/RUNTIME-BIN', '/home/u/runtime-bin', 'linux')).toBe(false)
  })
})

describe('runtimeFingerprint（钉死时机：run 内不漂移）', () => {
  it('同一环境 → 指纹相同（不会无意义重建会话）', () => {
    const a = runtimeFingerprint({ python: 'C:\\p\\python.exe' }, SHIM)
    const b = runtimeFingerprint({ python: 'C:\\p\\python.exe' }, SHIM)
    expect(a).toBe(b)
  })

  it('换了选中项 → 指纹不同（下一个 run 换会话）', () => {
    const a = runtimeFingerprint({ python: 'C:\\p\\3.12\\python.exe' }, SHIM)
    const b = runtimeFingerprint({ python: 'C:\\p\\3.13\\python.exe' }, SHIM)
    expect(a).not.toBe(b)
  })

  it('换了 shim 目录 → 指纹不同', () => {
    const a = runtimeFingerprint({ python: 'C:\\p\\python.exe' }, 'C:\\s1')
    const b = runtimeFingerprint({ python: 'C:\\p\\python.exe' }, 'C:\\s2')
    expect(a).not.toBe(b)
  })

  it('键序不影响指纹（对象插入序不是语义）', () => {
    const a = runtimeFingerprint({ python: 'C:\\p', node: 'C:\\n' }, SHIM)
    const b = runtimeFingerprint({ node: 'C:\\n', python: 'C:\\p' }, SHIM)
    expect(a).toBe(b)
  })

  it('空选择也有稳定指纹（= 未配置状态，不是空串）', () => {
    const a = runtimeFingerprint({}, SHIM)
    const b = runtimeFingerprint({ python: '', uv: '  ' }, SHIM)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })
})

describe('isOurShimContent ★ 清理判据：按内容认自己，不依赖会变的外部状态', () => {
  it('我们生成的 → 认得出（win32 / posix 两路）', () => {
    expect(isOurShimContent(cmdShimContent('C:\\Py\\python.exe', 'win32'), 'win32')).toBe(true)
    expect(isOurShimContent(cmdShimContent('/usr/bin/python3', 'linux'), 'linux')).toBe(true)
    // 路径含空格（`C:\Program Files\…`）也必须认得出
    expect(isOurShimContent(cmdShimContent('C:\\Program Files\\nodejs\\node.exe', 'win32'), 'win32')).toBe(true)
  })

  it('★ 认不出的**一律不认**（宁可漏放 —— 删是不可逆动作）', () => {
    const cases = [
      '',
      '   ',
      'hello',
      '@echo off', // 只有注释行、没有转发行
      '@echo off\r\necho hi\r\n', // 长得像但不是转发
      '#!/bin/sh\n',
      '#!/bin/bash\nexec "/usr/bin/x" "$@"\n', // shebang 不同
      '@echo off\r\n"C:\\x.exe" %*\r\necho extra\r\n' // 多了一行不该有的
    ]
    for (const c of cases) {
      expect(isOurShimContent(c, 'win32')).toBe(false)
    }
  })

  it('平台必须对上（win32 的内容在 posix 判据下不认，反之亦然）', () => {
    expect(isOurShimContent(cmdShimContent('C:\\Py\\python.exe', 'win32'), 'linux')).toBe(false)
    expect(isOurShimContent(cmdShimContent('/usr/bin/python3', 'linux'), 'win32')).toBe(false)
  })
})

describe('常量', () => {
  it('中转目录名不叫 bin（避免与用户既有 bin 目录混淆）', () => {
    expect(RUNTIME_BIN_DIRNAME).toBe('runtime-bin')
  })
})
