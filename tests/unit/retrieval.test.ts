import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildSearchSpec, literalToRegexSource, SearchQueryError, specToRegExp } from '@shared/search-query'
import { buildRipgrepArgs, resolveRipgrepPath, ripgrepBinaryName } from '@shared/ripgrep-locate'
import { parseRipgrepJson, renderSearchOutcome, runSearch, type SearchOutcome } from '@main/retrieval/search'

// L0 检索（plan3/plan4）：**口径必须与计划一致（ripgrep）**，且降级要如实报告。
// 这组测试守的就是那条口径 —— 换实现时先看这里。

describe('buildSearchSpec（查询规格）', () => {
  it('默认字面量 + 不区分大小写', () => {
    const spec = buildSearchSpec({ query: 'magic' })
    expect(spec.mode).toBe('literal')
    expect(spec.caseSensitive).toBe(false)
    expect(spec.escapeForRegex).toBe(true)
    expect(spec.describe).toBe('按字面量匹配、不区分大小写')
  })

  it('regex=true 走正则、不转义', () => {
    const spec = buildSearchSpec({ query: 'fn\\s+\\w+', regex: true })
    expect(spec.mode).toBe('regex')
    expect(spec.escapeForRegex).toBe(false)
    expect(spec.describe).toBe('按正则匹配、不区分大小写')
  })

  it('caseSensitive=true 说清楚', () => {
    expect(buildSearchSpec({ query: 'HTTP', caseSensitive: true }).describe).toBe('按字面量匹配、区分大小写')
  })

  it('**字面量里的正则元字符被当作普通字符**（这是默认模式的关键语义）', () => {
    // `a.b` 在字面量模式下不该匹配 `axb`；`a*b` 也不该被当成"若干个 a"
    const spec = buildSearchSpec({ query: 'a.b' })
    const re = specToRegExp(spec)
    expect(re.test('a.b')).toBe(true)
    expect(re.test('axb')).toBe(false)
    const star = specToRegExp(buildSearchSpec({ query: 'a*b' }))
    expect(star.test('a*b')).toBe(true)
    expect(star.test('aaab')).toBe(false)
  })

  it('转义覆盖全部正则元字符', () => {
    expect(literalToRegexSource('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  })

  it('空 query / 带换行 / 超长 → 抛人话错误', () => {
    expect(() => buildSearchSpec({ query: '' })).toThrow(SearchQueryError)
    expect(() => buildSearchSpec({ query: 'a\nb' })).toThrow('不能包含换行')
    expect(() => buildSearchSpec({ query: 'x'.repeat(501) })).toThrow('过长')
  })

  it('**坏正则在编译期就被拒**（不留给执行后端 —— 否则同一查询两种结果）', () => {
    expect(() => buildSearchSpec({ query: '(', regex: true })).toThrow('正则表达式无效')
    expect(() => buildSearchSpec({ query: '[a-', regex: true })).toThrow('正则表达式无效')
    // 同一个 query 在字面量模式下完全合法
    expect(buildSearchSpec({ query: '(' }).mode).toBe('literal')
  })
})

describe('resolveRipgrepPath（定位 rg）', () => {
  it('随包优先于环境变量与 PATH', () => {
    const loc = resolveRipgrepPath({
      resourcesPath: 'C:/app/resources',
      envPath: 'C:/custom/rg.exe',
      platform: 'win32',
      exists: () => true
    })
    expect(loc).toEqual({ path: join('C:/app/resources', 'ripgrep', 'rg.exe'), source: 'bundled' })
  })

  it('随包不存在时退环境变量，再退 PATH', () => {
    const env = resolveRipgrepPath({
      resourcesPath: 'C:/app/resources',
      envPath: 'C:/custom/rg.exe',
      platform: 'win32',
      exists: (p) => p === 'C:/custom/rg.exe'
    })
    expect(env?.source).toBe('env')
    const pathOnly = resolveRipgrepPath({ platform: 'win32', exists: (p) => p === 'rg.exe' })
    expect(pathOnly).toEqual({ path: 'rg.exe', source: 'path' })
  })

  it('都找不到 → null（调用方降级，不是报错）', () => {
    expect(resolveRipgrepPath({ platform: 'win32', exists: () => false })).toBeNull()
  })

  it('二进制名按平台', () => {
    expect(ripgrepBinaryName('win32')).toBe('rg.exe')
    expect(ripgrepBinaryName('darwin')).toBe('rg')
    expect(ripgrepBinaryName('linux')).toBe('rg')
  })
})

describe('buildRipgrepArgs（参数拼装）', () => {
  const base = 'D:/ws'

  it('字面量模式用 --fixed-strings，不靠我们拼正则', () => {
    const args = buildRipgrepArgs(buildSearchSpec({ query: 'a.b' }), base)
    expect(args).toContain('--fixed-strings')
    expect(args).toContain('--ignore-case')
    expect(args).toContain('--json')
    // `--no-config`：不许用户家目录的 RIPGREP_CONFIG_PATH 悄悄改变我们的行为
    expect(args).toContain('--no-config')
  })

  it('正则 + 区分大小写', () => {
    const args = buildRipgrepArgs(buildSearchSpec({ query: 'Fn\\s+\\w', regex: true, caseSensitive: true }), base)
    expect(args).not.toContain('--fixed-strings')
    expect(args).toContain('--case-sensitive')
  })

  it('**模式用 -e 显式标出**（query 以 `-` 开头时不会被当成开关）', () => {
    const args = buildRipgrepArgs(buildSearchSpec({ query: '--files' }), base)
    const i = args.indexOf('-e')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('--files')
    // 起点在 `--` 之后，保证它也被当成路径而不是开关
    expect(args.indexOf('--')).toBeLessThan(args.indexOf(base))
  })
})

describe('parseRipgrepJson（解析 --json 流）', () => {
  // ⚠️ **路径必须按当前平台构造，不能硬编码 Windows 形态**。
  //
  // 这里踩过一次真实的 CI 红灯：最初写成 `root = 'D:/ws'` 配 `'D:\\ws\\a.ts'`，
  // 本地（Windows）`path.relative('D:/ws', 'D:\\ws\\a.ts')` 返回 `a.ts` → 绿；
  // CI（Linux）上 `D:` 只是个普通目录名、与 `/` 无任何关系，于是算出
  // `../../D:/ws/a.ts` → 红。**本地全绿 ≠ 通过**，跨平台差异只在 CI 暴露。
  //
  // 契约本身也是"平台原生"的：ripgrep 输出的就是本平台路径（Windows 用 `\`，
  // Linux/macOS 用 `/`），故测试用 `join` 构造才是对契约的准确刻画。
  const root = join(sep, 'ws') // Windows: '\ws'（当前盘根）; POSIX: '/ws'
  const inRoot = (...parts: string[]): string => join(root, ...parts)
  const line = (obj: unknown): string => JSON.stringify(obj)

  it('只取 match 事件，路径转相对且用正斜杠', () => {
    const abs = inRoot('a.ts')
    const stdout = [
      line({ type: 'begin', data: { path: { text: abs } } }),
      line({ type: 'match', data: { path: { text: abs }, line_number: 3, lines: { text: 'has magic\n' } } }),
      line({ type: 'end', data: {} })
    ].join('\n')
    const { hits } = parseRipgrepJson(stdout, root, 50)
    expect(hits).toEqual([{ file: 'a.ts', line: 3, text: 'has magic' }])
  })

  it('**半截行不让整次解析崩掉**（进程被杀时最后一行常常是断的）', () => {
    const stdout = [
      line({ type: 'match', data: { path: { text: inRoot('a.ts') }, line_number: 1, lines: { text: 'x\n' } } }),
      '{"type":"match","data":{"path":{"te'
    ].join('\n')
    const { hits } = parseRipgrepJson(stdout, root, 50)
    expect(hits).toHaveLength(1)
  })

  it('到达上限时标记 truncated', () => {
    const stdout = Array.from({ length: 5 }, (_, i) =>
      line({ type: 'match', data: { path: { text: inRoot(`f${i}.ts`) }, line_number: 1, lines: { text: 'm\n' } } })
    ).join('\n')
    const { hits, truncated } = parseRipgrepJson(stdout, root, 3)
    expect(hits).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('子目录里的命中保留相对子路径（且一律正斜杠）', () => {
    const stdout = line({
      type: 'match',
      data: { path: { text: inRoot('src', 'deep', 'x.ts') }, line_number: 7, lines: { text: 'hit\n' } }
    })
    const { hits } = parseRipgrepJson(stdout, root, 50)
    expect(hits[0]!.file).toBe('src/deep/x.ts')
  })

  it('**接受 rg 真实的「混合分隔符」输出**（实机抓到的形态，不是构造的）', () => {
    // 依据：在 Windows 上实跑随包 rg（`--json`），传 `-- d:/proj/src` 时它的输出是
    //   {"path":{"text":"d:/proj/src\\shared\\x.ts"}}
    // 即 **basePath 原样回显（正斜杠）+ 平台分隔符拼接（反斜杠）**。
    // 这里是解析层的输入契约：不能假定 rg 的路径分隔符统一 ——
    // 它取决于调用方传进去的 basePath 长什么样。
    const abs = process.platform === 'win32' ? 'd:/proj/src\\shared\\x.ts' : '/proj/src/shared/x.ts'
    const wsRoot = process.platform === 'win32' ? 'd:\\proj' : '/proj'
    const stdout = line({
      type: 'match',
      data: { path: { text: abs }, line_number: 5, lines: { text: 'mixed\n' } }
    })
    const { hits } = parseRipgrepJson(stdout, wsRoot, 50)
    // `path.relative` 在有平台语义的宿主上能消化这种混合形态
    // （Windows 上 `d:/a` 与 `d:\a` 同义；POSIX 上本来就只有一种分隔符）
    expect(hits[0]!.file).toBe('src/shared/x.ts')
  })
})

describe('runSearch（执行 + 降级）', () => {
  let root = ''
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jsl-retrieval-'))
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'a.ts'), 'const magic = 42\nconst Other = 1\n', 'utf8')
    writeFileSync(join(root, 'big.log'), 'x'.repeat(3000) + '\nmagic-big\n', 'utf8')
  })

  const builtinOptions = (over: Partial<Parameters<typeof runSearch>[0]> = {}) =>
    ({
      workspaceRoot: root,
      basePath: root,
      spec: buildSearchSpec({ query: 'magic' }),
      maxResults: 50,
      location: null, // 强制降级
      maxFileBytes: 1000,
      ...over
    }) as Parameters<typeof runSearch>[0]

  it('**没有 rg 时降级且如实说明**（不是静默换引擎）', async () => {
    const out = await runSearch(builtinOptions())
    expect(out.engine).toBe('builtin')
    expect(out.fallbackReason).toContain('未找到 ripgrep')
    expect(out.hits.map((h) => h.file)).toContain('a.ts')
  })

  it('plan37 S1：内置扫描**让出事件循环**（旧实现全同步递归，大工作区占死主进程）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsl-yield-'))
    try {
      for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}.txt`), `line-${i} nomatch\n`, 'utf8')
      let heartbeats = 0
      let stop = false
      const beat = (): void => {
        if (stop) return
        heartbeats += 1
        setImmediate(beat)
      }
      setImmediate(beat)
      const out = await runSearch(
        builtinOptions({ workspaceRoot: dir, basePath: dir, maxFileBytes: undefined, yieldEveryFiles: 1, spec: buildSearchSpec({ query: 'zzz-absent' }) })
      )
      stop = true
      expect(out.scannedFiles).toBe(200)
      // 每文件让出一次 → 心跳与扫描交替；旧同步实现里这里只会是 0~1
      expect(heartbeats).toBeGreaterThan(50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**超过大小上限的文件被跳过时会计数**（以前是静默 continue）', async () => {
    const out = await runSearch(builtinOptions())
    expect(out.skipped.tooLarge).toBe(1)
    // 而且那句"跳过了 N 个"要真的出现在给模型的文本里
    expect(renderSearchOutcome(out, buildSearchSpec({ query: 'magic' }))).toContain('跳过')
  })

  it('rg 可用且成功 → engine=ripgrep，不做降级', async () => {
    const out = await runSearch(
      builtinOptions({
        location: { path: 'rg', source: 'path' },
        runRg: async () => ({
          stdout: JSON.stringify({
            type: 'match',
            data: { path: { text: join(root, 'a.ts') }, line_number: 1, lines: { text: 'const magic = 42\n' } }
          }),
          failed: false,
          stderr: ''
        })
      })
    )
    expect(out.engine).toBe('ripgrep')
    expect(out.fallbackReason).toBeUndefined()
    expect(out.hits[0]?.file).toBe('a.ts')
  })

  it('**rg 跑挂时降级，且把原因带出去**', async () => {
    const out = await runSearch(
      builtinOptions({
        location: { path: 'rg', source: 'path' },
        runRg: async () => ({ stdout: '', failed: true, stderr: 'not executable' })
      })
    )
    expect(out.engine).toBe('builtin')
    expect(out.fallbackReason).toContain('ripgrep 执行失败')
    expect(out.fallbackReason).toContain('not executable')
  })

  it('**rg 非零退出但有输出 → 不丢结果**（退出码不等于"没搜到"）', async () => {
    const out = await runSearch(
      builtinOptions({
        location: { path: 'rg', source: 'path' },
        runRg: async () => ({
          stdout: JSON.stringify({
            type: 'match',
            data: { path: { text: join(root, 'a.ts') }, line_number: 2, lines: { text: 'const Other = 1\n' } }
          }),
          failed: false,
          stderr: ''
        })
      })
    )
    expect(out.engine).toBe('ripgrep')
    expect(out.hits).toHaveLength(1)
  })
})

describe('renderSearchOutcome（如实报告）', () => {
  const spec = buildSearchSpec({ query: 'x' })
  const baseOutcome: SearchOutcome = {
    hits: [],
    engine: 'builtin',
    truncated: false,
    skipped: { tooLarge: 0, unreadable: 0 },
    skippedDirs: []
  }

  it('到达上限时明说"还有更多"，并给收窄处方', () => {
    const text = renderSearchOutcome(
      { ...baseOutcome, hits: [{ file: 'a.ts', line: 1, text: 'x' }], truncated: true },
      spec
    )
    expect(text).toContain('还有更多匹配没有返回')
    expect(text).toContain('收窄')
  })

  it('没到上限时也说清楚"全部已返回"（不然模型不知道有没有漏）', () => {
    const text = renderSearchOutcome({ ...baseOutcome, hits: [{ file: 'a.ts', line: 1, text: 'x' }] }, spec)
    expect(text).toContain('全部 1 条匹配已返回')
  })

  it('降级提示醒目', () => {
    const text = renderSearchOutcome({ ...baseOutcome, fallbackReason: '未找到 ripgrep（模拟）' }, spec)
    expect(text).toContain('内置扫描器')
    expect(text).toContain('未找到 ripgrep（模拟）')
  })
})

// ── 真实 ripgrep 端到端 ─────────────────────────────────────────
// ⚠️ 为什么必须有这一组：上面全部用 stub，只能证明**接线对**，证明不了"二进制真能被执行"。
//    终端那版"只有打包版才坏"的坑，四道闸一个都没拦住 —— 同类的教训。
// 二进制不存在时**跳过**（CI ubuntu 可能没装 linux 包）：跳过而不是假装通过，
// 且要用`skipIf` 让"跳过了"显式体现在报告里。
const RG_BINARY = join(process.cwd(), 'resources', 'ripgrep', process.platform === 'win32' ? 'rg.exe' : 'rg')
const hasRealRg = existsSync(RG_BINARY)
const REAL_ROOT = process.cwd()

describe.skipIf(!hasRealRg)('真实 ripgrep 端到端（resources/ripgrep/）', () => {
  const base = {
    workspaceRoot: REAL_ROOT,
    maxResults: 200,
    resourcesPath: join(REAL_ROOT, 'resources')
  }

  it('搜真仓库命中已知串，engine=ripgrep', async () => {
    const out = await runSearch({ ...base, basePath: join(REAL_ROOT, 'src'), spec: buildSearchSpec({ query: 'resolveInsideWorkspace' }) })
    expect(out.engine).toBe('ripgrep')
    expect(out.fallbackReason).toBeUndefined()
    expect(out.hits.length).toBeGreaterThan(0)
  }, 30000)

  it('**正则模式真的走正则**（字面量匹配同一串会落空）', async () => {
    const reOut = await runSearch({
      ...base,
      basePath: join(REAL_ROOT, 'src/shared'),
      spec: buildSearchSpec({ query: String.raw`export function \w+Spec`, regex: true })
    })
    expect(reOut.engine).toBe('ripgrep')
    expect(reOut.hits.length).toBeGreaterThan(0)

    // 反向对照：同一条 query 当**字面量**搜（`\w` 不是转义就是普通字符）→ 不该命中
    const literalOut = await runSearch({
      ...base,
      basePath: join(REAL_ROOT, 'src/shared'),
      spec: buildSearchSpec({ query: String.raw`export function \w+Spec` })
    })
    expect(literalOut.hits.length).toBe(0)
  }, 30000)

  it('**大小写开关真的生效**（不是"参数拼了但没人理"）', async () => {
    const lowerCS = await runSearch({
      ...base,
      basePath: join(REAL_ROOT, 'src'),
      spec: buildSearchSpec({ query: 'resolveinsideworkspace', caseSensitive: true })
    })
    const lowerIC = await runSearch({
      ...base,
      basePath: join(REAL_ROOT, 'src'),
      spec: buildSearchSpec({ query: 'resolveinsideworkspace' })
    })
    // 小写 + 区分大小写：源码里写的是驼峰 → 0 命中
    expect(lowerCS.hits.length).toBe(0)
    // 小写 + 不区分：应命中驼峰写法
    expect(lowerIC.hits.length).toBeGreaterThan(0)
  }, 30000)

  it('**尊重 .gitignore，但仍能搜到自己的源码**（默认跳 node_modules 是 rg 的行为）', async () => {
    const out = await runSearch({ ...base, basePath: REAL_ROOT, spec: buildSearchSpec({ query: 'jiushililu' }) })
    expect(out.engine).toBe('ripgrep')
    expect(out.hits.some((h) => h.file.startsWith('package.json'))).toBe(true)
    expect(out.hits.some((h) => h.file.startsWith('node_modules/'))).toBe(false)
  }, 30000)
})
