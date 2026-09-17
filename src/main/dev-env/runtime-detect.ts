/**
 * 运行时探测（plan43 S1）—— 主进程：发现本机已装的 Node / Python / uv。
 *
 * 照 `system-fonts.ts` 模式：**只读系统、失败不抛、结果缓存**。六类探测源各一个函数，
 * 互不影响；新增探测源 = 加一个函数，不改调用方（决策 2）。
 * 硬约束：`execFile` 直调**绝不开 shell**；版本 `--version` 实测、单发 2s 超时；
 * 商店占位符（符号链接 → AppInstaller）排除。探测结果不落盘（派生数据），只存用户选择。
 */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifySource,
  condaAliasFromPath,
  organizeRuntimes,
  versionFromOutput,
  isStorePlaceholder,
  LANGUAGE_SPECS
} from '@shared/dev-env'
import type { DevEnvSnapshot, RuntimeEntry } from '@shared/dev-env'
import { getDevEnvSelected } from '../store/settings'

const VERSION_TIMEOUT_MS = 2000
const IS_WIN = process.platform === 'win32'

function exe(name: string): string {
  return IS_WIN ? `${name}.exe` : name
}

/** 版本实测：execFile 直调、无 shell、2s 超时；失败给 ''（跳过，不猜） */
async function probeVersion(bin: string): Promise<string> {
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        bin,
        ['--version'],
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
        (err, out) => (err ? reject(err) : resolve({ stdout: String(out) }))
      )
    })
    return versionFromOutput(stdout)
  } catch {
    return ''
  }
}

/** 候选 = 路径 + 来源事实标记；分类/去重/排序统一交给 shared 纯函数 */
interface Candidate {
  language: string
  path: string
  onPath: boolean
  fromNvm?: boolean
  fromVolta?: boolean
  fromPyenv?: boolean
  fromUvDir?: boolean
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isFile(p: string): boolean {
  try {
    return lstatSync(p).isFile() || lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

/** ① PATH 搜索：逐目录找 bin（fs 直查，不起 `where` 子进程） */
function probePath(): Candidate[] {
  const out: Candidate[] = []
  const dirs = (process.env.PATH ?? '').split(IS_WIN ? ';' : ':').filter((d) => d.length > 0)
  for (const spec of LANGUAGE_SPECS) {
    for (const binName of spec.probeBins) {
      for (const d of dirs) {
        try {
          const full = join(d, IS_WIN ? exe(binName) : binName)
          if (isFile(full)) out.push({ language: spec.id, path: full, onPath: true })
        } catch {
          /* 坏 PATH 段跳过 */
        }
      }
    }
  }
  return out
}

/** ② conda：常见安装根 + CONDA_PREFIX；根 python + envs/* */
function probeConda(): Candidate[] {
  const roots = new Set<string>()
  const cp = process.env.CONDA_PREFIX
  if (cp) roots.add(cp)
  for (const cand of [
    'D:\\MiniConda3',
    'C:\\MiniConda3',
    join(homedir(), 'miniconda3'),
    join(homedir(), 'anaconda3'),
    'C:\\ProgramData\\miniconda3',
    'C:\\ProgramData\\anaconda3'
  ]) {
    if (isDir(cand) && existsSync(join(cand, 'conda-meta'))) roots.add(cand)
  }
  const out: Candidate[] = []
  for (const root of roots) {
    const rootPy = join(root, exe('python'))
    if (isFile(rootPy)) out.push({ language: 'python', path: rootPy, onPath: false })
    for (const env of safeReaddir(join(root, 'envs'))) {
      const py = join(root, 'envs', env, IS_WIN ? 'python.exe' : 'bin/python')
      if (isFile(py)) out.push({ language: 'python', path: py, onPath: false })
    }
  }
  return out
}

/** ③ nvm：Windows %APPDATA%\nvm\v* / POSIX ~/.nvm/versions/node/* */
function probeNvm(): Candidate[] {
  const out: Candidate[] = []
  const roots = IS_WIN
    ? [join(process.env.APPDATA ?? '', 'nvm')]
    : [join(homedir(), '.nvm', 'versions', 'node')]
  for (const root of roots) {
    for (const v of safeReaddir(root)) {
      const node = IS_WIN ? join(root, v, exe('node')) : join(root, v, 'bin', 'node')
      if (isFile(node)) out.push({ language: 'node', path: node, onPath: false, fromNvm: true })
    }
  }
  return out
}

/** ④ volta：%LOCALAPPDATA%\Volta\bin */
function probeVolta(): Candidate[] {
  const out: Candidate[] = []
  const root = join(process.env.LOCALAPPDATA ?? '', 'Volta', 'bin')
  for (const spec of LANGUAGE_SPECS) {
    for (const binName of spec.probeBins) {
      const p = join(root, exe(binName))
      if (isFile(p)) out.push({ language: spec.id, path: p, onPath: false, fromVolta: true })
    }
  }
  return out
}

/** ⑤ pyenv：~/.pyenv/versions/*（POSIX）与 ~/.pyenv/pyenv-win/versions/*（Windows） */
function probePyenv(): Candidate[] {
  const out: Candidate[] = []
  const roots = [
    join(homedir(), '.pyenv', 'versions'),
    join(homedir(), '.pyenv', 'pyenv-win', 'versions')
  ]
  for (const root of roots) {
    for (const v of safeReaddir(root)) {
      const py = IS_WIN ? join(root, v, exe('python')) : join(root, v, 'bin', 'python')
      if (isFile(py)) out.push({ language: 'python', path: py, onPath: false, fromPyenv: true })
    }
  }
  return out
}

/** ⑥ uv：uv 自带的 CPython（~/.local/share/uv/python/*）；uv 二进制本体由 PATH 探测覆盖 */
function probeUv(): Candidate[] {
  const out: Candidate[] = []
  const root = join(homedir(), '.local', 'share', 'uv', 'python')
  for (const v of safeReaddir(root)) {
    const py = IS_WIN ? join(root, v, exe('python')) : join(root, v, 'bin', 'python')
    if (isFile(py)) out.push({ language: 'python', path: py, onPath: false, fromUvDir: true })
  }
  return out
}

const PROBERS: Array<() => Candidate[]> = [
  probePath,
  probeConda,
  probeNvm,
  probeVolta,
  probePyenv,
  probeUv
]

function toEntry(c: Candidate): RuntimeEntry | null {
  const dir = c.path.replace(/[/\\][^/\\]+$/, '')
  // conda env 里的 python3.exe 是 python.exe 的别名入口 —— 不算第二个运行时
  if (/python3(?:\.exe)?$/i.test(c.path) && isFile(join(dir, 'python.exe'))) return null
  const hasCondaMeta = existsSync(join(dir, 'conda-meta')) || existsSync(join(dir, '..', 'conda-meta'))
  const hasPyvenvCfg = existsSync(join(dir, 'pyvenv.cfg')) || existsSync(join(dir, '..', 'pyvenv.cfg'))
  let symlink = false
  let resolved = c.path
  try {
    symlink = lstatSync(c.path).isSymbolicLink()
    resolved = realpathSync(c.path)
  } catch {
    /* 读不了链接信息就当非符号链接（路径级双保险仍在） */
  }
  if (c.language === 'python' && isStorePlaceholder(resolved, symlink)) return null
  const source = classifySource({
    hasCondaMeta,
    hasPyvenvCfg,
    onPath: c.onPath,
    fromNvm: c.fromNvm,
    fromVolta: c.fromVolta,
    fromPyenv: c.fromPyenv,
    fromUvDir: c.fromUvDir
  })
  const alias = source === 'conda' ? condaAliasFromPath(c.path) : undefined
  return { language: c.language, path: c.path, version: '', alias, source, onPath: c.onPath }
}

let cache: DevEnvSnapshot | null = null

/** 探测入口：六类并发 → 分类排除 → 并发实测版本 → 分组排序。失败不抛（该组空 = 未检测到） */
export async function detectRuntimes(force = false): Promise<DevEnvSnapshot> {
  if (cache && !force) return cache
  const candidates: Candidate[] = []
  for (const probe of PROBERS) {
    try {
      candidates.push(...probe())
    } catch {
      /* 单类探测器炸了不影响其他（决策 2） */
    }
  }
  const entries = candidates.map(toEntry).filter((e): e is RuntimeEntry => e !== null)
  await Promise.all(
    entries.map(async (e) => {
      e.version = await probeVersion(e.path)
    })
  )
  cache = {
    detectedAt: new Date().toISOString(),
    groups: organizeRuntimes(entries),
    selected: getDevEnvSelected()
  }
  return cache
}

/** 供单测注入的私有导出面（不对外） */
export const __internalsForTest = { toEntry, exe, safeReaddir }

/** 清理临时目录里探测可能拖进来的噪音：本项目 tmp 与测试目录的 python 不进结果 */
function isNoise(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase()
  return norm.includes('/jiushililu/tmp/') || norm.includes('/appdata/local/temp/jsl-') || norm.startsWith(tmpdir().replace(/\\/g, '/').toLowerCase())
}

/** 供 IPC 层过滤噪音（不塞进探测主链，保持探测器纯粹） */
export function filterNoise(snapshot: DevEnvSnapshot): DevEnvSnapshot {
  return {
    ...snapshot,
    groups: snapshot.groups.map((g) => ({
      ...g,
      main: g.main.filter((e) => !isNoise(e.path)),
      others: g.others.filter((e) => !isNoise(e.path))
    }))
  }
}
