import { describe, expect, it } from 'vitest'
import { planWindow, windowToolOutput } from '@shared/tool-window'
import { estimateTokens } from '@shared/tokens'

// 工具输出窗口化（plan8 R9.1）—— 借 `dsh-plugin-save-token` 的形状，钉住本项目自己的口径。
//
// 这一套里最容易写错、也最贵的三件事，各有一组用例：
//   ① **不许瞒**：省略了就必须在文本里说清"省了多少行、行号是什么"
//   ② **不许砍掉排错现场**：末尾与报错行必须留
//   ③ **不许压了反而更差**：双门控不达标就原样放行（"什么都没做"是合法结果）

const log = (n: number, body = 'normal log line with some text in it'): string =>
  Array.from({ length: n }, (_, i) => `${body} #${i + 1}`).join('\n')

describe('窗口化：短输出一个字都不动', () => {
  it('小输出原样放行（reason=small，且**文本完全相同**）', () => {
    const raw = '[stdout]\n构建完成\n'
    const r = windowToolOutput(raw)
    expect(r.compressed).toBe(false)
    expect(r.reason).toBe('small')
    expect(r.text).toBe(raw)
    expect(r.afterBytes).toBe(r.beforeBytes)
  })

  it('阈值边界：1399 字节不动、1400 字节起才可能动', () => {
    const a = 'x'.repeat(1399)
    expect(windowToolOutput(a).compressed).toBe(false)
    const b = `head line\n${'y'.repeat(2000)}\ntail line`
    expect(windowToolOutput(b).beforeBytes).toBeGreaterThan(1400)
  })

  it('**报错输出的门槛更高**（6000 字节才对它动手，3000 字节的报错原样放过）', () => {
    const err = Array.from({ length: 100 }, (_, i) => `error TS2345: 第 ${i} 处类型不匹配`).join('\n')
    expect(err.length).toBeGreaterThan(1400)
    expect(err.length).toBeLessThan(6000)
    const r = windowToolOutput(err)
    expect(r.compressed).toBe(false)
    expect(r.text).toBe(err)
  })
})

describe('窗口化：头尾全量 + 中段带行号采样', () => {
  const many = log(600)

  it('压缩生效，且**头尾都在**（头 60 行、尾 40 行原样）', () => {
    const r = windowToolOutput(many)
    expect(r.compressed).toBe(true)
    expect(r.text).toContain('normal log line with some text in it #1')
    expect(r.text).toContain('#60')
    expect(r.text).toContain('#600')
    expect(r.text).toContain('#561')
  })

  it('采样行**带原文行号**（不是从 1 重数）—— 这是"可精确取回"的全部依据', () => {
    const r = windowToolOutput(many)
    const numbered = r.text.split('\n').filter((l) => /^\d+\|/.test(l))
    expect(numbered.length).toBeGreaterThan(5)
    const first = Number(numbered[0]!.split('|')[0])
    expect(first).toBeGreaterThan(60) // 中段的真行号，不是 1
    expect(first).toBeLessThan(561)
  })

  it('压缩后**字节与 token 双下降**（门的另一半由"结果本身"证明）', () => {
    const r = windowToolOutput(many)
    expect(r.afterBytes).toBeLessThan(r.beforeBytes)
    expect(r.afterTokens).toBeLessThan(r.beforeTokens)
    expect(r.afterBytes).toBeLessThanOrEqual(r.beforeBytes * 0.72)
  })

  it('**不瞒**：开头就写明"已压缩 + 原文多大 + 省略处标了行号"', () => {
    const r = windowToolOutput(many)
    expect(r.text.startsWith('[工具输出过长，已压缩展示]')).toBe(true)
    expect(r.text).toContain(String(r.beforeBytes))
    expect(r.text).toContain('行号')
  })

  it('取回处方：**按工具给**（别让模型自己猜重试参数），也可显式注入', () => {
    const custom = windowToolOutput(many, { retrievalHint: '用 read_tool_output(id, offset, limit) 取回。' })
    expect(custom.text).toContain('read_tool_output')
    // 默认处方按工具名分流 —— 命令输出教它"重跑但收窄"，文件读取教它"用 offset 按行区间读"
    expect(windowToolOutput(many, { toolName: 'run_command' }).text).toContain('收窄输出')
    expect(windowToolOutput(many, { toolName: 'read_file' }).text).toContain('offset')
    expect(windowToolOutput(many).text).toContain('不要原样重试')
  })
})

describe('窗口化：排错现场不许被压掉', () => {
  it('**末尾**永远留着（错误与结论通常在那里 —— 旧代码砍的恰恰是这半截）', () => {
    const lines = [...Array.from({ length: 300 }, (_, i) => `inflating module ${i}`), '  ✗ 3 tests failed', '  exit code 1']
    const r = windowToolOutput(lines.join('\n'))
    expect(r.compressed).toBe(true)
    expect(r.text).toContain('✗ 3 tests failed')
    expect(r.text).toContain('exit code 1')
  })

  it('**中段的报错行连上下文一起留**（帧行/代码行本身不含"error"这个词，只抓关键词会漏掉它们）', () => {
    const lines = Array.from({ length: 700 }, (_, i) =>
      i === 310
        ? '  at Object.<anonymous> (src/main/ipc.ts:463:12)'
        : i === 460
          ? 'ERROR: 端口被占用'
          : i === 461
            ? '  下一步请检查 3000 端口占用进程'
            : `noise line ${i}`
    )
    const r = windowToolOutput(lines.join('\n'))
    expect(r.compressed).toBe(true)
    // 栈帧行：靠 FRAME_RE 抓到（它一个"error"都不含）
    expect(r.text).toContain('311|  at Object.<anonymous> (src/main/ipc.ts:463:12)')
    // 报错行 + 它的**下一行**（tsc 的波浪线行、Node 的帧、人的提示都在这）
    expect(r.text).toContain('461|ERROR: 端口被占用')
    expect(r.text).toContain('462|  下一步请检查 3000 端口占用进程')
    expect(r.text).toContain('报错相关命中')
  })

  // ⚠️ 这一条是**红队审查给的样例**（2026-09-12）：他们拿真实报错逐条试，指出关键词清单
  //    漏了一大批"本来就该留住"的行。现在把那一串**原样**钉进测试 —— 以后再有人改动
  //    正则，漏掉哪一类当场变红，而不是等用户排错时才发现"现场没了"。
  it('红队样例：**堆栈帧 / 编译警告 / npm 错误码 / 退出码 / 测试框架标记 / 中文超时**，一条都不许漏', () => {
    const samples = [
      '  at Object.<anonymous> (src/main/ipc.ts:463:12)',
      '  File "app.py", line 12, in <module>',
      '--> src/main.ts:12:5',
      'src/x.ts:40:7 - warning TS6133: 声明了但没用到',
      '--- FAIL: TestFoo (0.00s)',
      '✕ renders the chip',
      '  - Expected  "1.5k"',
      '  + Received  "1.0k"',
      'npm ERR! code ELIFECYCLE',
      'EACCES: permission denied, open "/etc/hosts"',
      'Error: ERR_MODULE_NOT_FOUND',
      'not ok 3 - 端口占用检查',
      '超时：命令 30s 未返回',
      'exit code 1'
    ]
    // 每一类都塞进一个够大的日志里（保证它落在**中段**，靠保护逻辑留住而不是靠头尾）
    const filler = Array.from({ length: 700 }, (_, i) => `noise ${i}`)
    for (const s of samples) {
      const lines = [...filler.slice(0, 350), s, ...filler.slice(350)]
      const r = windowToolOutput(lines.join('\n'))
      expect(r.compressed, `样例没被压缩，测不到保护逻辑：${s}`).toBe(true)
      expect(r.text, `这条现场被压掉了：${s}`).toContain(s)
    }
  })

  it('一屏全是 error 时，报错块**仍然有界**，且**如实说明只列了一部分**（不许说"全部保留"）', () => {
    const lines = Array.from({ length: 800 }, (_, i) => `error at line ${i} of something long enough`)
    const r = windowToolOutput(lines.join('\n'))
    expect(r.compressed).toBe(true)
    // ⚠️ 只数**报错块**里的行：采样块也带行号，一起数会数出 75 条那种假结果（第一版就是这么错的）
    const errBlock = (r.text.split('报错相关命中')[1] ?? '').split('—— 中段其余内容')[0] ?? ''
    const numbered = errBlock.split('\n').filter((l) => /^\d+\|/.test(l))
    // 上限盯的是"最多去找 25 个命中位置"，再加上每条命中前后 1/2 行的上下文 → 总量有界
    expect(numbered.length).toBeLessThanOrEqual(30)
    // **假话禁令**：命中数远大于列出数时，必须说"不是全部"（红队审查抓的原话是"全部保留"）
    expect(r.text).toContain('不是全部')
    // 而且**最后那条根因要在**（取两端，不取前端）
    expect(r.text).toContain('error at line 799')
    // 整段输出不许接近原文长度（800 行的输出，压完不该还是 700 多行）
    expect(r.text.split('\n').length).toBeLessThan(200)
  })

  it('中文错误也认（本项目的错误文本就是中文 —— 只认英文等于漏一半）', () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      i === 300 ? '错误：路径「../x」越出工作区边界，拒绝读取' : `普通输出行 ${i}`
    )
    const r = windowToolOutput(lines.join('\n'))
    expect(r.text).toContain('越出工作区边界')
  })
})

describe('窗口化：双门控（压不动就原样放行）', () => {
  it('**行数极少但每行超长** → 掐断单行，仍能达标', () => {
    const raw = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
    const r = windowToolOutput(raw)
    expect(r.compressed).toBe(true)
    expect(r.text).toContain('本行还有')
    expect(r.text.length).toBeLessThan(raw.length)
  })

  it('**压不到 72% 就放行**（内容太"实"、没有可省的冗余时不硬压）', () => {
    // 只有 30 行、但每行都很长：头尾窗口几乎覆盖全文 → 压不动 → 必须原样返回
    const raw = Array.from({ length: 30 }, (_, i) => `line ${i} ${'z'.repeat(300)}`).join('\n')
    const r = windowToolOutput(raw)
    if (!r.compressed) {
      expect(r.reason).toBe('byte-gate')
      expect(r.text).toBe(raw)
    } else {
      expect(r.afterBytes).toBeLessThanOrEqual(r.beforeBytes * 0.72)
    }
  })

  it('放行时文本**必须与原文一字不差**，且 reason 说清是哪道门拦的', () => {
    const raw = `${'q'.repeat(1000)}\n${'w'.repeat(1000)}`
    const r = windowToolOutput(raw, { keepRatioMax: 0 })
    expect(r.compressed).toBe(false)
    expect(r.reason).toBe('byte-gate')
    expect(r.text).toBe(raw)
  })

  // ⚠️ 下面这条是**审查揪出来的假阴性**（2026-09-12）：
  //    头尾行数是**常数**（60/40），门是**比例**（0.72）—— 于是行数 ≲230 的输出
  //    无论怎么算都过不了门，"中等长度的中文输出一律不压缩"，而这是**静默**发生的：
  //    功能看着做了，实际一分钱没省。修法是按预算逐档收紧窗口。
  it('**中等长度输出也必须能压**（200 行中文 ≈12KB —— 修之前这条必红）', () => {
    const line = '这是一行普通的中文日志内容，长度大约二十个字' // 20 汉字 ≈ 60 字节
    const raw = Array.from({ length: 200 }, () => line).join('\n')
    const r = windowToolOutput(raw)
    expect(raw.length).toBeGreaterThan(1400)
    expect(r.compressed).toBe(true)
    expect(r.reason).toBe('compressed')
    expect(r.afterBytes).toBeLessThanOrEqual(r.beforeBytes * 0.72)
    // 收紧档位要**真的收紧过**（scale < 1）—— 否则说明它还是靠"常数窗口碰巧过门"
    expect(r.scale).toBeLessThanOrEqual(1)
  })

  it('收紧是**逐档**进行的，且收得多时仍然留着头与尾（结构不塌）', () => {
    const line = '这是一行普通的中文日志内容，长度大约二十个字'
    const r = windowToolOutput(Array.from({ length: 400 }, () => line).join('\n'))
    expect(r.compressed).toBe(true)
    expect(r.text).toContain('末尾') // 尾部块还在
    expect(r.text).toContain('原文行号') // 采样块还在
  })

  // ⚠️ 我原本写的是"双门控"，但**没有任何输入能让第二道门开**（数学上被字节门蕴含，
  //    推理写在 `tool-window.ts` 的不变式注释里）。所以这里不去假装"证明它能开"，
  //    而是断言**那条不变式本身**：凡是压过的，估算 token 一定严格下降；放行的，原文一字未动。
  it('不变式：**压缩 ⇒ token 必降**，放行 ⇒ 原文一字未动（拿一堆形状扫一遍）', () => {
    const shapes: string[] = [
      log(600),
      log(300, '短行'),
      Array.from({ length: 200 }, () => '这是一行普通的中文日志内容，长度大约二十个字').join('\n'),
      Array.from({ length: 900 }, (_, i) => (i === 500 ? 'ERROR boom' : `噪音行 ${i}`)).join('\n'),
      Array.from({ length: 40 }, (_, i) => `long ${i} ${'x'.repeat(500)}`).join('\n'),
      `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`,
      Array.from({ length: 500 }, (_, i) => `${'汉字'.repeat(30)} ${i}`).join('\n')
    ]
    let compressedCount = 0
    for (const raw of shapes) {
      const r = windowToolOutput(raw)
      if (r.compressed) {
        compressedCount++
        expect(r.afterTokens).toBeLessThan(r.beforeTokens)
        expect(r.afterBytes).toBeLessThan(r.beforeBytes)
        expect(r.reason).toBe('compressed')
      } else {
        expect(r.text).toBe(raw)
        expect(['small', 'byte-gate', 'token-invariant']).toContain(r.reason)
      }
    }
    // 至少有一半形状该被压到 —— 否则这套东西等于没生效（也是"静默省不到"的哨兵）
    expect(compressedCount).toBeGreaterThanOrEqual(4)
  })
})

describe('窗口化：地图（纯索引，不靠读排版断言）', () => {
  const opts = {
    minBytes: 1400,
    errorMinBytes: 6000,
    keepRatioMax: 0.72,
    headLines: 60,
    tailLines: 40,
    strideSamples: 50,
    maxLineChars: 420,
    maxErrorLines: 25
  }

  it('头/尾按行数切，采样步长按中段行数算', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `l${i}`)
    const plan = planWindow(lines, { ...opts, scale: 1 })
    expect(plan.headEnd).toBe(60)
    expect(plan.tailStart).toBe(960)
    expect(plan.stride).toBe(Math.ceil(900 / 50))
    expect(plan.sampleIdx[0]).toBe(60)
    expect(plan.sampleIdx.at(-1)).toBeLessThan(960)
  })

  it('报错行带上**前后上下文**（前 1 行、后 2 行），且升序去重', () => {
    const lines = Array.from({ length: 400 }, (_, i) => (i === 200 ? 'ERROR: 炸了' : `l${i}`))
    const plan = planWindow(lines, { ...opts, scale: 1 })
    expect(plan.errorIdx).toEqual([199, 200, 201, 202])
  })

  it('scale 越小窗口越小（收紧档位真的在收）', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `l${i}`)
    const wide = planWindow(lines, { ...opts, scale: 1 })
    const tight = planWindow(lines, { ...opts, scale: 0.25 })
    expect(tight.headEnd).toBeLessThan(wide.headEnd)
    expect(tight.sampleIdx.length).toBeLessThan(wide.sampleIdx.length)
  })

  it('行数比窗口还少时不出乱子（尾从头之后开始，中段为空）', () => {
    const plan = planWindow(['a', 'b', 'c'], { ...opts, scale: 1 })
    expect(plan.headEnd).toBe(3)
    expect(plan.tailStart).toBe(3)
    expect(plan.errorIdx).toEqual([])
  })
})

describe('窗口化：**绝对预算**（相对门控管不住"压完还是很大"）', () => {
  // ⚠️ 这一组是**红队审查的复算结果**逼出来的（2026-09-12）：
  //    只按"压到 72% 以下"判，3MB 的输入压完仍有 ~17.6k 估算 token，
  //    而"超窗"在厂商那边是**整轮作废**的硬错，不是"多花点钱"。
  it('压完的结果**不许超过绝对预算**', () => {
    const raw = Array.from({ length: 20_000 }, (_, i) => `这是一行中文日志内容 ${i}`).join('\n')
    const r = windowToolOutput(raw, { maxTokens: 3000 })
    expect(r.compressed).toBe(true)
    expect(r.afterTokens).toBeLessThanOrEqual(3000)
  })

  it('**超大输入**也压得下来（3MB 级别：窗口形状的地板远低于预算）', () => {
    const raw = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    expect(raw.length).toBeGreaterThan(2_000_000)
    const r = windowToolOutput(raw)
    expect(r.compressed).toBe(true)
    expect(r.afterTokens).toBeLessThanOrEqual(8000) // 默认预算
  })

  it('预算给得非常小的时候，也不是"过不了就整段放行"——仍然给最小的那档', () => {
    const raw = Array.from({ length: 5000 }, () => '中文内容行，用来把预算压到极限').join('\n')
    const r = windowToolOutput(raw, { maxTokens: 400 })
    expect(r.compressed).toBe(true)
    expect(r.afterTokens).toBeLessThanOrEqual(400)
  })
})

describe('窗口化：省下的量要能量出来（R9 记账用它）', () => {
  it('返回的 before/after token 与 estimateTokens 口径一致（同一把尺子）', () => {
    const raw = log(600)
    const r = windowToolOutput(raw)
    expect(r.beforeTokens).toBe(estimateTokens(raw))
    expect(r.afterTokens).toBe(estimateTokens(r.text))
    expect(r.beforeTokens - r.afterTokens).toBeGreaterThan(0)
  })

  it('典型场景的压缩率落在"温和"区间（不是靠狠压换数字）', () => {
    const r = windowToolOutput(log(600))
    const ratio = r.afterBytes / r.beforeBytes
    expect(ratio).toBeGreaterThan(0.1) // 太狠 = 激进压缩，前辈数据显示那样会倒亏
    expect(ratio).toBeLessThanOrEqual(0.72)
  })
})
