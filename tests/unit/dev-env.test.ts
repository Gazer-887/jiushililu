// plan43 S1 判据单测：筛选排序规则、别名反推、商店占位排除、版本实测解析、选择失效诊断。
// 探测器的真盘行为归真渲染门禁（本机实测），这里钉的是**决策 2b 的规则本身**。
import { describe, expect, it } from 'vitest'
import {
  classifySource,
  compareVersionsDesc,
  condaAliasFromPath,
  isSelectionValid,
  isStorePlaceholder,
  organizeRuntimes,
  runtimeDisplayName,
  versionFromOutput
} from '@shared/dev-env'
import type { DevEnvSnapshot, RuntimeEntry } from '@shared/dev-env'

const e = (over: Partial<RuntimeEntry>): RuntimeEntry => ({
  language: 'python',
  path: 'C:/x/python.exe',
  version: '3.12.0',
  source: 'system',
  onPath: true,
  ...over
})

describe('classifySource（能证明的就分类，证明不了的不硬猜）', () => {
  it('conda-meta > pyvenv.cfg > 专属目录 > PATH > other 的优先级', () => {
    expect(classifySource({ hasCondaMeta: true, hasPyvenvCfg: true, onPath: true })).toBe('conda')
    expect(classifySource({ hasCondaMeta: false, hasPyvenvCfg: true, onPath: true })).toBe('venv')
    expect(classifySource({ hasCondaMeta: false, hasPyvenvCfg: false, onPath: true })).toBe('system')
    expect(classifySource({ hasCondaMeta: false, hasPyvenvCfg: false, onPath: false, fromNvm: true })).toBe('nvm')
    expect(classifySource({ hasCondaMeta: false, hasPyvenvCfg: false, onPath: false, fromUvDir: true })).toBe('uv')
    expect(classifySource({ hasCondaMeta: false, hasPyvenvCfg: false, onPath: false })).toBe('other')
  })
})

describe('isStorePlaceholder（实测抓到的 bug 级坑：执行会弹商店）', () => {
  it('WindowsApps 下的符号链接 / AppInstaller / Redirector → 排除', () => {
    expect(isStorePlaceholder('C:\\x\\WindowsApps\\python.exe', true)).toBe(true)
    expect(isStorePlaceholder('C:\\x\\WindowsApps\\AppInstallerPythonRedirector.exe', false)).toBe(true)
    expect(isStorePlaceholder('D:\\MiniConda3\\python.exe', true)).toBe(false)
  })
})

describe('condaAliasFromPath（解析不出就不显示，不猜）', () => {
  it('envs/<name> 反推别名；base 识别；其他不猜', () => {
    expect(condaAliasFromPath('D:\\MiniConda3\\envs\\ai_env\\python.exe')).toBe('ai_env')
    expect(condaAliasFromPath('D:\\MiniConda3\\python.exe')).toBe('base')
    expect(condaAliasFromPath('D:\\hermes-agent\\venv\\Scripts\\python.exe')).toBeUndefined()
  })
})

describe('versionFromOutput（版本必须实测，禁止路径解析）', () => {
  it('从命令输出取号；取不到给空', () => {
    expect(versionFromOutput('Python 3.12.13')).toBe('3.12.13')
    expect(versionFromOutput('v24.18.0')).toBe('24.18.0')
    expect(versionFromOutput('uv 0.9.17')).toBe('0.9.17')
    expect(versionFromOutput('no numbers here')).toBe('')
  })
})

describe('organizeRuntimes（排序 conda→venv→系统→其他；组内版本降序；去重）', () => {
  it('规则全兑', () => {
    const groups = organizeRuntimes([
      e({ path: 'C:/sys/python.exe', source: 'system' }),
      e({ path: 'D:/conda/envs/ai/python.exe', source: 'conda', version: '3.12.13' }),
      e({ path: 'D:/weird/python.exe', source: 'other', version: '3.9.1' }),
      e({ path: 'D:/venv/Scripts/python.exe', source: 'venv', version: '3.11.2' }),
      // 同路径重复（Windows 大小写不同也算重复）
      e({ path: 'C:/SYS/python.exe', source: 'system' }),
      // 商店占位（路径级双保险）
      e({ path: 'C:/Users/x/AppData/Local/Microsoft/WindowsApps/python.exe', source: 'system' }),
      e({ language: 'node', path: 'C:/n/node.exe', version: '24.1.0', source: 'nvm', onPath: false })
    ])
    const py = groups.find((g) => g.id === 'python')!
    expect(py.main.map((m) => m.source)).toEqual(['conda', 'venv', 'system'])
    expect(py.others).toHaveLength(1)
    expect(py.main.some((m) => /WindowsApps/i.test(m.path))).toBe(false)
    expect(py.main.filter((m) => /sys/i.test(m.path))).toHaveLength(1)
    const node = groups.find((g) => g.id === 'node')!
    expect(node.main.map((m) => m.source)).toEqual(['nvm'])
  })
  it('版本降序', () => {
    expect(organizeRuntimes([
      e({ path: 'a', version: '3.10.1' }),
      e({ path: 'b', version: '3.12.13' }),
      e({ path: 'c', version: '3.9.1' })
    ]).find((g) => g.id === 'python')!.main.map((m) => m.version)).toEqual(['3.12.13', '3.10.1', '3.9.1'])
    // 降序比较器：3.12 < 3.12.1 → a 排后（正）
    expect(compareVersionsDesc('3.12', '3.12.1')).toBeGreaterThan(0)
  })
})

describe('runtimeDisplayName + isSelectionValid', () => {
  it('名称+版本+别名三段式；无版本退名称', () => {
    expect(runtimeDisplayName(e({ version: '3.12.13', alias: 'ai_env' }), 'Python')).toBe("Python 3.12.13 ('ai_env')")
    expect(runtimeDisplayName(e({ version: '' }), 'Python')).toBe('Python')
  })
  it('卸载后选择失效可诊断（返回失效语言清单）', () => {
    const snap: DevEnvSnapshot = {
      detectedAt: '',
      groups: organizeRuntimes([e({ path: 'D:/alive/python.exe' })]),
      selected: {}
    }
    expect(isSelectionValid({ python: 'D:/alive/python.exe' }, snap)).toEqual([])
    expect(isSelectionValid({ python: 'D:/gone/python.exe', node: 'C:/n' }, snap)).toEqual(['python', 'node'])
  })
})
