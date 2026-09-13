import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOKEN_TIER,
  TOKEN_TIER_LIST,
  isTokenSaverTier,
  outputDisciplinePrompt,
  resolvePolicy,
  tierLabel,
  type TokenSaverTier
} from '@shared/token-tier'
import { windowToolOutput } from '@shared/tool-window'

/**
 * 省 token 档位（plan8 R9.1 §七②）。
 * 三层，顺序即优先级：① 三条共同红线（不静默截断 / 不压报错现场 / 不伪造完整性）踩了就是
 * **功能坏了**，不是"这档更省"；② 四档取值（用户定调的档位表）不许顺手漂移；③ 认不出的值回
 * 默认档，且默认方向是"更不激进"那一侧。
 */

/** 四档（顺序 = 从最省到最不省，方便下面按强度比较） */
const TIERS: TokenSaverTier[] = ['light', 'balanced', 'ultimate', 'rich']

/** 一段"够大"的命令输出：3000 行正常日志 + 末尾的失败结论（正是旧代码会砍掉的那半截） */
function bigCommandOutput(): string {
  const lines: string[] = []
  for (let i = 0; i < 3000; i++) lines.push(`[info] 处理第 ${i} 个条目，一切正常（填充用内容）`)
  lines.push('[info] 开始跑检查用例')
  lines.push('✕ 3) 端口占用检查')
  lines.push('   Expected 3000, received 8080')
  lines.push('exit code 1')
  return lines.join('\n')
}

/** 按某个档位调窗口化（**跟 `loop.ts` 传的那三个参数保持一致**） */
function runWithTier(tier: TokenSaverTier, raw: string) {
  const p = resolvePolicy(tier)
  return windowToolOutput(raw, {
    toolName: 'run_command',
    minBytes: p.minBytes,
    keepRatioMax: p.keepRatioMax,
    maxTokens: p.maxTokens
  })
}

describe('档位取值（用户定调的档位表）', () => {
  it('默认档是**平衡**', () => {
    expect(DEFAULT_TOKEN_TIER).toBe('balanced')
    expect(resolvePolicy(undefined).tier).toBe('balanced')
  })

  it('土豪档 = **不做任何省**（窗口化整个关掉）', () => {
    const rich = resolvePolicy('rich')
    expect(rich.windowEnabled).toBe(false)
    // 双保险：即使有人只看数值不看开关，这几个值也压不动
    expect(rich.keepRatioMax).toBe(1)
    expect(rich.maxTokens).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('三档都开窗口化，且**越省压得越狠**（相对门 / 绝对预算 / 默认行数单调）', () => {
    const light = resolvePolicy('light')
    const balanced = resolvePolicy('balanced')
    const ultimate = resolvePolicy('ultimate')
    expect([light, balanced, ultimate].every((p) => p.windowEnabled)).toBe(true)
    expect(light.keepRatioMax).toBeLessThan(balanced.keepRatioMax)
    expect(balanced.keepRatioMax).toBeLessThan(ultimate.keepRatioMax)
    expect(light.maxTokens).toBeLessThan(balanced.maxTokens)
    expect(balanced.maxTokens).toBeLessThan(ultimate.maxTokens)
    expect(light.readLines).toBeLessThan(balanced.readLines)
    expect(balanced.readLines).toBeLessThan(ultimate.readLines)
  })

  it('`read_file` 默认行数：平衡档仍是改造前的 200（老行为不变）', () => {
    expect(resolvePolicy('balanced').readLines).toBe(200)
  })

  it('设置页的清单覆盖四档，且顺序与说明都在（界面不自己编文案）', () => {
    expect(TOKEN_TIER_LIST.map((t) => t.tier)).toEqual(['rich', 'ultimate', 'balanced', 'light'])
    expect(TOKEN_TIER_LIST.map((t) => t.label)).toEqual(['土豪', '极致', '平衡', '轻量'])
    expect(TOKEN_TIER_LIST.every((t) => t.note.length > 0)).toBe(true)
  })
})

describe('档位回落：认不出来的值一律回默认档', () => {
  it('脏值 / 老配置 / 大小写不对 → 平衡档（**不抛错**：配置坏掉也得能跑）', () => {
    expect(resolvePolicy('nonsense').tier).toBe('balanced')
    expect(resolvePolicy(null).tier).toBe('balanced')
    expect(resolvePolicy('').tier).toBe('balanced')
    expect(resolvePolicy('BALANCED').tier).toBe('balanced')
    expect(resolvePolicy(123).tier).toBe('balanced')
  })

  it('`isTokenSaverTier` 只认四个合法值', () => {
    for (const t of TIERS) expect(isTokenSaverTier(t)).toBe(true)
    expect(isTokenSaverTier('Rich')).toBe(false)
    expect(isTokenSaverTier(undefined)).toBe(false)
  })

  it('档位中文名：认不出来时报"平衡"（与 `resolvePolicy` 的回落保持一致）', () => {
    expect(tierLabel('light')).toBe('轻量')
    expect(tierLabel('rich')).toBe('土豪')
    expect(tierLabel('???')).toBe('平衡')
  })
})

/**
 * 三条共同红线 —— **每个档位都要过**：它们不是"省钱开关"而是**正确性**，
 * 轻量档的"掉质量"只能来自"更常压缩、给更少上下文"，**不许来自"骗模型"**。
 */
describe('四档共同红线（正确性，不许做成可关）', () => {
  it('红线①**不静默**：只要压过，输出里必须留痕（说清"这不是全部"）', () => {
    for (const tier of TIERS) {
      const r = runWithTier(tier, bigCommandOutput())
      if (r.compressed) expect(r.text, `${tier} 压了却没说`).toContain('已压缩展示')
    }
  })

  it('红线②**不压报错现场**：末尾的失败结论在四档下都还在', () => {
    for (const tier of TIERS) {
      const r = runWithTier(tier, bigCommandOutput())
      expect(r.text, `${tier} 把报错现场压掉了`).toContain('received 8080')
      expect(r.text, `${tier} 把退出码压掉了`).toContain('exit code 1')
    }
  })

  it('红线②补充：**报错门槛不随档位放开** —— 一段刚过门槛的报错输出，四档都不动它', () => {
    // 造一段"含报错行、略超默认报错门槛（6000 字节）"的文本：排错现场是红线，不参与档位调节
    const lines: string[] = []
    for (let i = 0; i < 400; i++) lines.push(`[info] 填充 ${i}`)
    lines.push('错误：端口被占用')
    const raw = lines.join('\n')
    for (const tier of TIERS) {
      const r = runWithTier(tier, raw)
      expect(r.text, `${tier} 动了报错现场`).toContain('端口被占用')
    }
  })

  it('红线③**不伪造**：压过的输出必须带**真实的**原始字节数（不夸大、不说"这就是全部"）', () => {
    for (const tier of TIERS) {
      const r = runWithTier(tier, bigCommandOutput())
      if (r.compressed) {
        expect(r.text, `${tier} 没报原文大小`).toContain(String(r.beforeBytes))
        expect(r.text).not.toContain('完整内容如下')
      }
    }
  })

  it('红线③补充：**压不动就原样放行**，绝不返回一个"改过一半"的文本', () => {
    // 极短输入：四档都不该动它（`rich` 连判断都不进）
    const tiny = 'ok'
    for (const tier of TIERS) {
      const r = runWithTier(tier, tiny)
      expect(r.compressed).toBe(false)
      expect(r.text).toBe(tiny)
    }
  })
})

describe('档位真的在起作用（否则就是一堆好看的数字）', () => {
  it('同一段大输出：**越省给得不会更多**（单调不增）', () => {
    const raw = bigCommandOutput()
    const light = runWithTier('light', raw)
    const balanced = runWithTier('balanced', raw)
    const ultimate = runWithTier('ultimate', raw)
    // ⚠️ **只能**断言"不增"：窗口化形状（头+尾+中段采样）一次就把 3000 行压到 2~3%，
    //    任何档位的字节门都过得去 → 三档落在同一收紧档（实测同为 3379 token），不是档位没生效。
    expect(light.afterTokens).toBeLessThanOrEqual(balanced.afterTokens)
    expect(balanced.afterTokens).toBeLessThanOrEqual(ultimate.afterTokens)
  })

  it('档位真正拉开差别的地方是**进判断的门槛**：省档会动它，宽档连看都不看', () => {
    // 约 1.6KB 的正常输出（**不含报错特征** → 走 `minBytes` 那条路；
    // 含报错时会改走 `errorMinBytes`，那条路按红线②不参与档位调节）
    const raw = Array.from(
      { length: 40 },
      (_, i) => `[info] 第 ${i} 行填充内容，用来把体积撑到门槛附近`
    ).join('\n')
    const bytes = new TextEncoder().encode(raw).length
    expect(bytes).toBeGreaterThan(600) // 过轻量档的门槛（600）
    expect(bytes).toBeLessThan(6000) // 但不过极致档的门槛（6000）

    const light = runWithTier('light', raw)
    const ultimate = runWithTier('ultimate', raw)
    // 轻量档：**已经进入判断**（哪怕最后因为压不动而原样放行，reason 也不会是 `small`）
    expect(light.reason).not.toBe('small')
    // 极致档：**连判断都不进** —— 这就是"档位在起作用"的确凿证据
    expect(ultimate.reason).toBe('small')
  })

  it('土豪档：**压根不压**（连"看过一眼"的痕迹都不留）', () => {
    // ⚠️ 必须用**不含报错特征**的文本：含报错时门槛走 `errorMinBytes`（6000），那条路与档位无关
    //    （红线②），会盖过 `minBytes`；真正的拦截在 `loop.ts`——`windowEnabled === false` 时不调窗口化。
    const plain = Array.from({ length: 3000 }, (_, i) => `[info] 处理第 ${i} 个条目`).join('\n')
    const r = runWithTier('rich', plain)
    expect(r.compressed).toBe(false)
    expect(r.reason).toBe('small')
  })
})

/**
 * **接线守卫**：纯函数全绿、调用点没接上，测试一点反应都没有 —— 而"配置项看着有、
 * 实际没人读"恰恰是最难查的一类问题（用户调了档位，行为一点没变）。
 */
describe('接线守卫：档位真的接进了主循环与组合根', () => {
  const loop = readFileSync('src/main/agent/loop.ts', 'utf8')
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  const runner = readFileSync('src/main/agent/runner.ts', 'utf8')
  const fileTools = readFileSync('src/main/agent/tools/file-tools.ts', 'utf8')

  it('主循环把 policy 的三个数**真的传给了**窗口化（不是解析出来摆着）', () => {
    expect(loop).toContain('minBytes: policy.minBytes')
    expect(loop).toContain('keepRatioMax: policy.keepRatioMax')
    expect(loop).toContain('maxTokens: policy.maxTokens')
  })

  it('土豪档的拦截发生在**调用之前**（`windowEnabled`，而不是靠一个大数值）', () => {
    expect(loop).toContain('opts.toolWindow === false ? false : policy.windowEnabled')
    expect(loop).toContain('if (windowEnabled && !SELF_MANAGED_TOOLS.has(tc.name))')
  })

  it('组合根读了用户设置并解析成 policy（runner 不许碰 electron-store，所以只能在这儿）', () => {
    // ⚠️ 用意是"**默认路径必须读用户设置**"：`JSL_TOKEN_TIER` 是校准钩子（与 `JSL_TOOL_WINDOW` 同族），
    //    但它只是 `??` 的前项，读设置那一步还在 —— 改这行时先确认没把默认路径改掉。
    expect(ipc).toContain("resolvePolicy(process.env['JSL_TOKEN_TIER'] ?? getTokenTier())")
  })

  it('`read_file` 的默认行数按档位走（工具工厂真的收下了 policy）', () => {
    expect(runner).toContain('createFileTools(writer, hooks.policy)')
    expect(fileTools).toContain('policy?.readLines')
  })
})

/**
 * 输出侧（plan8 R9.1 §七③）—— 思考链按输出 token 计费，是整套省 token 最大的单点杠杆：
 * DSH 面板实测输出 3.08M 里推理占 1.60M（52%）。
 */
describe('思考强度：只准"最省那一档"动它', () => {
  it('**只有轻量档**覆盖用户的思考强度，其余三档一律 `null` = 不动', () => {
    // 这条守的是一个态度：用户在每个模型档案里配的 reasoningEffort 是他自己的判断，
    // **全局档位不该无端改它**。轻量档可以，是因为用户选它时已经说了"允许质量略降"。
    expect(resolvePolicy('light').reasoningEffortOverride).toBe('low')
    for (const tier of ['rich', 'ultimate', 'balanced'] as const) {
      expect(resolvePolicy(tier).reasoningEffortOverride, `${tier} 不该覆盖用户设置`).toBeNull()
    }
  })
})

describe('输出纪律提示', () => {
  it('档位取值：土豪/极致**不加**（让模型充分展开），平衡加标准，轻量再加限长', () => {
    expect(resolvePolicy('rich').outputDiscipline).toBe(0)
    expect(resolvePolicy('ultimate').outputDiscipline).toBe(0)
    expect(resolvePolicy('balanced').outputDiscipline).toBe(1)
    expect(resolvePolicy('light').outputDiscipline).toBe(2)
  })

  it('0 档返回 `null`（不加就不加，**不塞一段空话**进系统提示）', () => {
    expect(outputDisciplinePrompt(0)).toBeNull()
  })

  it('1 档三条都在：先结论 / 不复述工具原文 / 不复述问题', () => {
    const p = outputDisciplinePrompt(1)
    expect(p).toContain('先给结论')
    expect(p).toContain('不要复述工具返回的原文')
    expect(p).toContain('不要复述用户的问题')
    expect(p).not.toContain('400 字')
  })

  it('2 档再加篇幅克制 —— 而且它是**明说的要求**，不是偷偷改数据', () => {
    const p = outputDisciplinePrompt(2)
    expect(p).toContain('400 字')
    expect(p).toContain('先给结论') // 标准三条仍在，不是替换
  })

  it('提示里**不许出现会变的东西**（日期 / 时间 / 会话 id）—— §七④ 前缀稳定的前提', () => {
    // 同一档位下这段文本必须字节级稳定，否则每轮都会让前缀缓存失效（换档失效一次可以接受，每轮失效不行）
    for (const level of [1, 2] as const) {
      const p = outputDisciplinePrompt(level) ?? ''
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(p).not.toMatch(/\d{2}:\d{2}/)
      expect(p).not.toMatch(/conversationId|runId|session/i)
    }
  })
})

/** **接线守卫（输出侧）**：同上面 —— 纯函数全绿，调用点没接上照样没反应。 */
describe('接线守卫：输出侧真的接进了 runner 与子代理', () => {
  const runner = readFileSync('src/main/agent/runner.ts', 'utf8')
  const scheduler = readFileSync('src/main/agent/scheduler.ts', 'utf8')

  it('思考强度的覆盖**真的用在了生效设置上**（不是解析出来摆着）', () => {
    expect(runner).toContain('policy.reasoningEffortOverride')
    expect(runner).toContain('reasoningEffort: policy.reasoningEffortOverride')
  })

  it('输出纪律**真的拼进了系统提示**', () => {
    expect(runner).toContain('outputDisciplinePrompt(policy.outputDiscipline)')
  })

  it('子代理吃同一份纪律（`systemSuffix` 一路传到子代理的系统提示里）', () => {
    expect(runner).toContain('systemSuffix: discipline')
    expect(scheduler).toContain('opts.systemSuffix')
  })

  it('子代理的模型参数走 `effective`（档位对思考强度的覆盖必须对子代理同样生效）', () => {
    expect(runner).toContain('const model = d.model ? { ...effective, model: d.model } : effective')
  })
})
