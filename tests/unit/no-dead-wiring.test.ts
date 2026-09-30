// plan54 #3 / #4 / #5：三处"看着有、其实不成立"的防线，一律用守卫钉住不许回来。
//
// 强度声明（`AGENTS.md` §八）：这些是**结构守卫**，挡的是"改着改着又加回去 / 又漏掉"，
// 不替代行为测试。每条都配了**阳性对照**，防止有人为了过判据把东西删干净 —— 那等于换了个坏法。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (rel: string): string => readFileSync(join(__dirname, '../../src', rel), 'utf8')

/**
 * 剥掉注释再扫（多处守卫共用）。
 *
 * ⚠️ 本仓是项目里注释最密的地方，而本文件好几条判据恰恰要靠**注释里写着"为什么不用 X"**
 * 才能读懂 —— 不剥注释会把这些解释判成违规（09-27 变异还原时在 `clipboard` 那组当场撞到，
 * 与"反向哨兵正则写太宽把注释判成违规"同一条病）。反过来，**阳性对照也在这里**：
 * 剥注释器不许把代码一起剥掉。
 */
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(String.fromCharCode(10))
    .map((l) => {
      const i = l.indexOf('//')
      // ⚠️ 判据必须是 `i >= 0` 而不是 `i > 0`：**列 0 的 `//` 注释同样要剥**。
      //   写成 `i > 0` 时，列 0 注释剥不掉 ⇒ 一条"不许出现 X"的守卫会把**注释里那句
      //   "为什么不能这么写"**判成违规（`anthropic.ts` 里就有：注释中写着
      //   `Math.min(EFFORT_BUDGET[effort], ceiling)`，不剥就红）。09-28 独立审查实测：
      //   把那些注释整体顶到列 0（代码一个 token 不动）守卫立刻红 —— 与本仓 09-27 在
      //   clipboard 那组犯过的病同一条，此处是它的潜伏版。
      //   `l[-1]` 在 i=0 时是 undefined，`!== ':'` 成立 ⇒ 列 0 会被正确剥掉。
      return i >= 0 && l[i - 1] !== ':' ? l.slice(0, i) : l
    })
    .join(String.fromCharCode(10))

describe('#3 死开关：能力位（片③ 接上消费点 → 片⑤ 改成模态集合，判据第三次重定）', () => {
  // 演变三站：① 只有字段没消费点 ⇒ 撤格子（plan54 #3）；② 接上图通路 ⇒ 格子必须回来（plan57 §四）；
  // ③ 布尔装不下「收图不收视频」⇒ 换成模态集合（K55）。**每次都两条一起翻** ——
  // 只翻第一条会让第二条的阳性对照失去意义，那是本项目最恨的「改一半」。
  it('设置页必须有「输入模态」勾选组，且真的回写 inputModalities', () => {
    const editor = src('renderer/src/components/ModelCatalogEditor.tsx')
    expect(editor).toContain('inputModalities')
    expect(editor).toContain('输入模态')
    // ★ 铁律：只列已接通的模态 —— 未接通的（音频 / PDF / mov）连格子都不许出现
    expect(editor).toContain('MODALITY_UI')
    expect(editor).not.toContain("'audio'")
    expect(editor).not.toContain("'pdf'")
  })

  it('★ 阳性对照：主进程按模态拦（纯函数 + chat:send 调用 + 协议维度），旧布尔字段已退场', () => {
    expect(src('shared/content-parts.ts')).toContain('export function modalityGateError')
    expect(src('main/ipc.ts')).toContain('modalityGateError(')
    // 协议维度不许漏：Anthropic 没有视频块，漏了就是静默丢块
    expect(src('main/ipc.ts')).toContain('settings.providerType')
    expect(src('main/schemas.ts')).toContain('inputModalities')
    expect(src('main/store/models.ts')).toContain('inputModalities')
    // 反向哨兵：`supportsImages` 只许留在**读盘迁移**那一处，别处再出现就是两份真相回来了
    // 只钉「字段声明」这一种形状（行首缩进 + 字段名 + 冒号/问号）—— 注释里提旧字段名是合法的
    // （它解释迁移来由）。第一版用宽正则把注释也判成违规，那是判据自己的假阳性。
    const fieldDecl = /^\s+supportsImages[?:]/m
    for (const f of ['shared/ipc.ts', 'main/schemas.ts', 'renderer/src/components/ModelCatalogEditor.tsx']) {
      expect(fieldDecl.test(src(f)), f + ' 里不该再有 supportsImages 字段').toBe(false)
    }
    // 迁移口只此一处（`normalizeEntry` 读老档案）：多一处就是两份真相同时可写
    expect(src('shared/models.ts')).toContain('supportsImages')
  })
})

describe('#4 通道名单一真相源', () => {
  it('主进程不许发裸字面量 `browser:changed`（改名即静默断，没有一道闸会红）', () => {
    expect(src('main/index.ts')).not.toContain("'browser:changed'")
  })

  it('阳性对照：走的是 `IPC` 常量，且通道仍在共享层定义', () => {
    expect(src('main/index.ts')).toContain('IPC.browserChanged')
    expect(src('shared/ipc.ts')).toContain("browserChanged: 'browser:changed'")
  })
})

describe('#7 单一写口与假注释', () => {
  it('活跃会话只能有一个写口（`setActiveConversationId`），不许再有直接赋值', () => {
    const ipc = src('main/ipc.ts')
    // 全文件只许有**一处**赋值 —— 就是 setter 自己那一行；多一处就说明又开了第二个写口
    const assignments = ipc.split('\n').filter((l) => /^[ \t]+activeConversationId = /.test(l))
    expect(ipc).toContain('setActiveConversationId(input.nextId)')
    expect(assignments.length).toBe(1)
  })

  it('`blockBytes` 那个"写进 inject 事件"的假注释不许回来（inject 事件只记 names）', () => {
    expect(src('main/memory/events.ts')).not.toContain('blockBytes')
    expect(src('main/memory/events.ts')).toContain("kind: 'inject'; conversationId: string | null; names: string[]")
  })
})

describe('#5 假防线：hasAnyWindow', () => {
  it('登记表不许留一个没人调的"有没有窗口"判断（2026-09-13 已把判据改成"主窗口在不在"）', () => {
    expect(src('main/window-registry.ts')).not.toContain('hasAnyWindow')
  })

  it('★ 阳性对照：`activate` 的判据必须仍是 `getMainWindow()` —— 退回"任何窗口"就是那个 macOS 假死 bug', () => {
    const index = src('main/index.ts')
    const at = index.indexOf("app.on('activate'")
    expect(at).toBeGreaterThan(-1)
    expect(index.slice(at, at + 700)).toContain('getMainWindow()')
  })
})

describe('K27：工作区分组只许有一份实现', () => {
  const sidebar = src('renderer/src/components/Sidebar.tsx')
  const shared = src('shared/conversation-group.ts')

  it('侧栏不许再自己数分组 / 自己推展示名（两份规则会漂，漂了没有任何一道闸会红）', () => {
    expect(sidebar).not.toContain('function groupConversations')
    expect(sidebar).not.toContain('new Map<string, ConversationMeta[]>')
    // 展示名推导也只许在 shared 那一处：侧栏自己 split 一次，就又是一份真相
    expect(sidebar).not.toContain('.split(')
  })

  it('阳性对照：撤的是副本不是规则 —— shared 里那份仍在，且侧栏真的 import 它', () => {
    expect(shared).toContain('export function groupByWorkspace')
    expect(shared).toContain('export function workspaceLabel')
    expect(sidebar).toContain("import { groupByWorkspace } from '@shared/conversation-group'")
  })
})

describe('#8 新增 IPC 通道必须四处齐（plan53 片 1 立的规矩）', () => {
  // 少一处 = 那条链在某一端根本没通：界面上按了没反应，且不报错、门禁也抓不到（plan54 同族断链）。
  // `memory:delete` 是**阳性对照** —— 它在本批之前就已经接全，若连它都判不过，那是判据坏了不是代码坏了。
  const gate = readFileSync(join(__dirname, '../../scripts/verify-shot.cjs'), 'utf8')
  for (const { key, literal } of [
    { key: 'memoryDelete', literal: 'memory:delete' },
    { key: 'memoryRestore', literal: 'memory:restore' },
    { key: 'memoryClearArchive', literal: 'memory:clear-archive' },
    // plan53 片 2：审批门的逃生开关。这两个通道一旦少一处，设置页那个格子就是装饰品（点了没反应、不报错）
    // plan44 S2b：截图按引用读，缺任何一处都是"图在盘上、界面永远转圈"
    { key: 'mcpArtifactRead', literal: 'mcp:artifact-read' },
    { key: 'memoryGetApprovalGate', literal: 'memory:get-approval-gate' },
    { key: 'memorySetApprovalGate', literal: 'memory:set-approval-gate' }
  ]) {
    it(`${literal}：常量 / 主进程 handler / preload 桥 / 门禁桩 四处齐`, () => {
      expect(src('shared/ipc.ts')).toContain(`${key}: '${literal}'`)
      expect(src('main/ipc.ts')).toContain(`ipcMain.handle(IPC.${key}`)
      expect(src('preload/index.ts')).toContain(`IPC.${key}`)
      expect(gate).toContain(`'${literal}':`)
    })
  }

  // 通道接全 ≠ 界面上有人按 —— 两个动作各钉一条，少一个就是又一根静默断链
  it('渲染层真的调用过恢复（`restoreMemory`）', () => {
    expect(src('renderer/src/components/MemoryManager.tsx')).toContain('window.api.restoreMemory(')
  })

  it('渲染层真的调用过清空归档（`clearArchivedMemory`，K28）', () => {
    expect(src('renderer/src/components/MemoryManager.tsx')).toContain('window.api.clearArchivedMemory(')
  })

  it('渲染层真的调用过截图读取（`MessageSegments.tsx`，S2b）', () => {
    expect(src('renderer/src/components/MessageSegments.tsx')).toContain('window.api.readMcpArtifact(')
  })

  it('渲染层真的调用过审批门读写（`MemorySettings.tsx`，片 2）', () => {
    const settings = src('renderer/src/components/MemorySettings.tsx')
    expect(settings).toContain('window.api.getMemoryApprovalGate()')
    expect(settings).toContain('window.api.setMemoryApprovalGate(')
  })
})
// —— K13（plan54 #7 同族）：门禁桩表必须罩住 preload 真会 invoke 的每一个通道 ——————————————————
// 为什么不是"把缺的那两个桩补上就完事"：本文件其余各条守的是**某一跳**，
// 而门禁是**第三跳**（隔离验证进程自建 `ipcMain.handle`，不加载 `src/main`）。
// 缺一个桩的现场形态是：该调用拿到 undefined、组件靠自己的兜底继续渲染、409 项判定一条不红 ——
// 于是"通道明明断了，只有 stderr 知道"。09-24 实测：`firecrawl:get` / `memory:get-auto` 就这样静默了三天，
// 且**本文件当时一条都不会红**（它只核 main 有 handler + preload 有引用）。
// ⇒ 补这两个桩只是治标；这一条把判据改成**从 `IPC` 表全枚举**，让"以后再加通道忘了配桩"结构上不可能再发生。
//    与 D-134 / D-136「闸装在咽喉点、不靠每个调用点记得判」同口径，只是落在测试层。
describe('K13 门禁桩覆盖率：preload 能 invoke 到的通道，门禁必须都有桩', () => {
  const repo = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8')

  /** `IPC` 常量表：key → 通道串。真源在共享层，别处一律不许写裸字面量（#4 已钉）。 */
  const channelByKey = new Map<string, string>()
  for (const m of repo('src/shared/ipc.ts').matchAll(/^ {2}([A-Za-z]\w*): '([^']+)'/gm)) {
    channelByKey.set(m[1], m[2])
  }

  /** 渲染层可达面 = preload 真发出去的那些 invoke（`on(...)` 是主→渲推送，不需要 handle 桩） */
  const invokedChannels = new Set<string>()
  /** IPC 表里解析不到的键必须**单独收集并断言为空**：否则"表换了缩进/改成双引号/条目跨行"
   *  会让那些通道**从判据里静默蒸发** —— 前提判据拦不住这种退化（键数掉几十条仍然 >50）。 */
  const unresolvedInvokeKeys: string[] = []
  for (const m of repo('src/preload/index.ts').matchAll(/invoke\(\s*IPC\.([A-Za-z]\w*)/g)) {
    const ch = channelByKey.get(m[1])
    if (ch === undefined) unresolvedInvokeKeys.push(m[1])
    else invokedChannels.add(ch)
  }

  /** 门禁侧：STUBS 表（按花括号配平截块，避免误抓同文件其它对象字面量）+ 少量直接 handle 的裸通道 */
  const gateStubChannels = new Set<string>()
  {
    const gate = repo('scripts/verify-shot.cjs')
    const start = gate.indexOf('const STUBS = {')
    if (start < 0) throw new Error('找不到 `const STUBS = {` —— 门禁桩表改名了？这条判据要先跟上')
    let depth = 0
    let end = -1
    for (let i = gate.indexOf('{', start); i < gate.length; i++) {
      if (gate[i] === '{') depth++
      else if (gate[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) throw new Error('STUBS 块花括号不配平 —— 门禁脚本坏了')
    const block = gate.slice(start, end)
    // 不按行首匹配：实测有 `'a:1': fn, 'a:2': fn` 挤在同一行的写法（terminal:write / :resize），
    // 按行首会把它读成"缺桩"—— 那是判据自己的假阳性，不是缺陷。改按"通道名形状"整块扫。
    // ★ 但必须先**逐行剥掉注释**再扫：本文件是项目里注释最密的地方，
    //   `// 'skill:save': () => ...` 这种"被注释掉的桩"若算成有桩，就是**当场假绿**
    //   （09-24 独立复核现场复现过：把桩注释掉，未剥注释的旧写法仍判它"有桩"）。
    const code = block
      .split('\n')
      .map((l) => (l.includes('//') ? l.slice(0, l.indexOf('//')) : l))
      .join('\n')
    for (const m of code.matchAll(/'([a-z][\w-]*:[\w:-]+)':/g)) gateStubChannels.add(m[1])
    for (const m of gate.matchAll(/^\s*ipcMain\.handle\(\s*'([^']+)'/gm)) gateStubChannels.add(m[1])
  }

  it('前提成立：三张表都真读到了东西（任一为空 ⇒ 下面那条会假绿）', () => {
    expect(channelByKey.size).toBeGreaterThan(50)
    expect(invokedChannels.size).toBeGreaterThan(50)
    expect(gateStubChannels.size).toBeGreaterThan(50)
    // 第四个前提：一个 invoke 都没"因为解析不到而被静默放过"。
    expect(unresolvedInvokeKeys).toEqual([])
  })

  it('preload 能 invoke 的通道，门禁一个都不许缺桩（缺了就是"通道断了但没人知道"）', () => {
    const missing = [...invokedChannels].filter((ch) => !gateStubChannels.has(ch)).sort()
    expect(missing).toEqual([])
  })

  it('阳性对照：门禁里确实存在"只服务门禁"的桩，且被抽样的真通道两边都在', () => {
    // 反向钉住"为了让判据绿而把 preload 掏空"这种坏法：
    // 抽三条已知通道，要求它们在**两侧都**出现 —— 少了任何一侧，上面那条就成了空转。
    for (const ch of ['mcp:artifact-read', 'memory:get-approval-gate', 'settings:get']) {
      expect(invokedChannels.has(ch), `preload 侧缺 ${ch}`).toBe(true)
      expect(gateStubChannels.has(ch), `门禁侧缺 ${ch}`).toBe(true)
    }
  })
})

// —— 复制的唯一入口（2026-09-27 用户实机报"点复制没反应、对勾不亮"）——————————————————
// 根因不是没接上，而是**用错了 API**：`navigator.clipboard.writeText` 要求文档有焦点，
// 窗口不在前台 / 焦点在别的窗口时直接抛 `NotAllowedError`；而当时 `.catch()` 什么都不做
// ⇒ 用户看到的是"点了没反应"，日志里也查不到（渲染进程的 JS 错误没有任何上报通路，实测 `app.log` 零命中）。
// 修法是走主进程 `clipboard`（无焦点要求）。本组守卫钉的是**别再长回去**，以及**失败必须看得见**。
describe('复制：渲染层只许走主进程那一条路', () => {
  const helper = src('renderer/src/clipboard.ts')

  it('★ 渲染层**整棵树**都不许再出现 navigator.clipboard（不是只盯那三处调用点）', () => {
    // 09-27 变异时自露的洞：这一条原本只列三个文件名，把 navigator.clipboard 写回
    // `clipboard.ts` 自己**照样绿**。不变量是"渲染层没有第二把剪贴板通路"，
    // 那就得按目录扫 —— 点名清单永远追不上人写的新文件。
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const e of readdirSync(join(__dirname, '../../src', dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...walk(rel))
        else if (/\.tsx?$/.test(e.name)) out.push(rel)
      }
      return out
    }
    // `stripComments` 已提到文件顶层（本文件另两组守卫也要用同一份，避免"每组各剥一次、剥法还不一样"）。
    // ★ 阳性对照：剥注释**不许把代码也剥掉** —— 带行尾注释的那一行，代码部分必须还在
    expect(
      stripComments('  await navigator.clipboard.writeText(t) // 这里是不许出现的调用'),
      '剥注释器自己坏了：它连代码行一起清了 ⇒ 这条判据会永远绿'
    ).toContain('navigator.clipboard')
    // 反向：纯注释里的那一句要被剥干净（否则上面那条正向断言毫无意义）
    expect(stripComments('/* 为什么不用 navigator.clipboard：它要焦点 */')).not.toContain(
      'navigator.clipboard'
    )

    const files = walk('renderer/src')
    expect(files.length, '扫描器一个文件都没找到 = 判据空转').toBeGreaterThan(20)
    for (const f of files) expect(stripComments(src(f)), f).not.toContain('navigator.clipboard')
  })

  it('主进程 handler / preload 桥 / 门禁桩 三处齐（常量与被 src() 读的文件同文件，天然在场）', () => {
    expect(src('main/ipc.ts')).toContain('ipcMain.handle(IPC.clipboardWrite')
    expect(src('preload/index.ts')).toContain('IPC.clipboardWrite')
    expect(readFileSync(join(__dirname, '../../scripts/verify-shot.cjs'), 'utf8')).toContain(
      "'clipboard:write':"
    )
  })

  it('helper 真的调桥，且失败回 false 而不是抛（抛出去就没人接得住）', () => {
    expect(helper).toContain('window.api.copyToClipboard')
    expect(helper).toContain('catch')
    expect(helper).toContain('return false')
  })

  it('复制失败在界面上看得见（当年就是被 .catch() 吞成"没反应"的）', () => {
    const chat = src('renderer/src/views/ChatView.tsx')
    expect(chat).toContain('copyFailedIndex')
    expect(chat).toContain('msg-copy-fail')
    expect(src('renderer/src/styles.css')).toContain('.msg-copy-fail')
  })

  it('★ 阳性对照：判据读的是**主进程回读**，不是页面自报（否则等于叫它给自己作证）', () => {
    const gate = readFileSync(join(__dirname, '../../scripts/verify-shot.cjs'), 'utf8')
    expect(gate).toContain('clipboard.readText()')
    // 桩必须真写：只 return true 不落地，那条判据就退化成自报
    expect(gate).toContain('clipboard.writeText(text)')
  })
})

// —— 滚动条：全局隐藏与终端例外必须同时在场（2026-09-27 用户裁决「完全隐藏，只留滚轮」）————
// 为什么单独一条守卫而不只是"改完看一眼"：Electron 33 = Chromium 130，`scrollbar-width` 只要
// 不是 auto 就**压过** `::-webkit-scrollbar` 那组规则。全局那条写在 `*` 上 ⇒ 终端视口本来靠
// 更高特异性的伪元素规则保住的滚动条，会被 `*` 的 `scrollbar-width: none` 直接抹掉，
// **不报错、不红、门禁也看不见**（门禁里没有开终端的那一屏时更是零反应）。
describe('滚动条：全局隐藏 + 终端有意例外', () => {
  // 样式表是 CRLF：先归一化行尾。不归一化时，按换行符找的锚点 indexOf 会返回 -1，
  // slice 就从文件末尾开始 ⇒ 判据恒红（09-27 实测踩到）。
  const css = src('renderer/src/styles.css').replace(/\r\n/g, '\n')

  it('全局那条在场：`*` 上 scrollbar-width: none + 伪元素 display: none 两条都写', () => {
    const global = css.slice(css.indexOf('* {\n  box-sizing'), css.indexOf('::-webkit-scrollbar {'))
    expect(global).toContain('scrollbar-width: none')
    expect(global).toContain('-ms-overflow-style: none')
    expect(css.slice(css.indexOf('::-webkit-scrollbar {'))).toMatch(
      /::-webkit-scrollbar \{\s*width: 0;\s*height: 0;\s*display: none;/
    )
  })

  it('★ 终端例外必须**同时**有标准属性与伪元素两份（只留一份就会在某个引擎上静默失效）', () => {
    const tm = css.slice(css.indexOf('.tm-host .xterm-viewport {'))
    expect(tm, '缺 scrollbar-width：会被全局 none 抹掉').toContain('scrollbar-width: thin')
    expect(tm, '缺 scrollbar-color：细条会是默认白，深底上抢戏').toContain('scrollbar-color:')
    expect(tm, '缺伪元素回退：不支持 scrollbar-width 的引擎会退回全局隐藏').toContain(
      '.tm-host .xterm-viewport::-webkit-scrollbar'
    )
  })

  it('★ 阳性对照：全局规则确实比终端那条"更晚命中"，靠的是特异性而不是书写顺序', () => {
    // 反向钉住一种坏修法：有人为了"让终端还有滚动条"把全局那条删掉 ⇒ 满屏粗条回来了
    const starNone = /\*\s*\{[^}]*scrollbar-width:\s*none/.test(css)
    expect(starNone, '全局 `*` 上的 none 不见了 = 这条守卫被绕开').toBe(true)
    // 而终端那条的选择器含两个类，特异性 (0,2,0) > `*` 的 (0,0,0)：顺序无关，删全局才有效
    expect(css).toContain('.tm-host .xterm-viewport {')
  })
})

// —— 剥注释器自身的自检（独立成条，**不许挂在任何会先失败的 it 里面**）—————————————————
// 09-28 现场：这些断言最初写在"渲染层不许出现 navigator.clipboard"那条 `it` 的末尾。
// 而那条 `it` 的前半段（整棵树扫描）一旦失败就先抛异常，**后面的断言根本不执行** ⇒
// 变异时"改回 `i > 0` ⇒ 39 条全绿"就是这么骗过去的。
// ⇒ 判据的**执行顺序**也是判据强度的一部分：自检必须能在任何路径上独立跑到。
describe('剥注释器自检（三条，缺一条就有守卫开始默默失效）', () => {
  // ★ 列 0 的注释也必须被剥 —— 这是 `i >= 0` 而不是 `i > 0` 的唯一理由。
  // 写 `i > 0` 时列 0 注释剥不掉，于是一条"不许出现 X"的守卫会把**注释里那句
  // "为什么不能这么写"**判成违规（`anthropic.ts` 的注释里正写着
  // `Math.min(EFFORT_BUDGET[effort], ceiling)`）。这是本仓 09-27 在 clipboard 那组
  // 犯过的病的潜伏版：注释解释"为什么不用"却被判成违规。
  it('列 0 注释被剥干净，行尾注释保留代码', () => {
    expect(stripComments('// 整行都在列 0 的注释'), '列 0 注释没被剥 ⇒ i >= 0 退回了 i > 0').toBe('')
    expect(stripComments('const a = 1 // 行尾注释').trim()).toBe('const a = 1')
  })

  it('不许把 `https://` 这类字符串里的 `//` 当注释剥掉', () => {
    expect(stripComments('const u = "https://x"')).toContain('https://x')
  })

  it('块注释也剥，且剥注释器不许把代码一起清掉', () => {
    expect(stripComments('/* 为什么不这么写 */\nconst a = 1')).toBe('\nconst a = 1')
  })
})

// —— 思考档名：按模型存，不许退回"应用级词表"（plan58 片⓪ / R6）———————————————————
// 为什么值得单独立一组守卫：R6 是一句**改判** —— 09-26 原判是"三头补齐 `max`"，
// 09-27 查了三路官方文档后推翻为"取消应用级档名表，档名按模型档案存"（R4/R6）。
// 推翻性决策最典型的失效形态不是被改回去，而是**残片**：另一个文件里按旧写法加了一行，
// 全库没有一道闸会红（AGENTS.md §四 规律 4：残片常长在最像"现行有效内容"的位置）。
// ⇒ 所以这一组扫的是**旧写法的所有同义形状**，不是只盯我改过的那两行。
describe('思考档名：档名按模型存，不许退回应用级词表（plan58 R6）', () => {
  it('读盘不许再按词表洗档（旧写法的两种形状：条目容错 / 扁平老形状升级）', () => {
    const code = stripComments(src('shared/models.ts'))
    // 旧形状 ①：新条目的 `settings.reasoningEffort === 'low' || …` 比较链
    // 旧形状 ②：扁平老形状的 `p.reasoningEffort === 'low' || …` 同一条链
    // 两条都被这一条正则罩住（差别只在 `s.` / `p.` 前缀，链本身一模一样）
    expect(code, 'shared/models.ts 里又出现了按词表比较洗档的链').not.toMatch(
      /reasoningEffort\s*===\s*'low'\s*\|\|/
    )
    // 旧形状 ③：三元兜底 `? x : 'default'`（万一有人换种写法再写一遍）。
    // ⚠️ consequent 必须允许**属性访问**：`\w+` 罩不住 `m.reasoningEffort`，
    //   而那是最自然的写法（09-28 独立审查实测四种写法，两道守卫都漏掉了属性三元那一支）。
    //   窗口也从 160 字缩到**同一个表达式内**（`[^;\n]*`）—— 跨 160 字既漏又可能误伤
    //   一段合法的 `??` 手写展开。
    expect(code, '又出现了"不认识的档一律洗成 default"的三元').not.toMatch(
      /reasoningEffort\s*=\s*[^;\n]*\?\s*[\w.]{1,60}\s*:\s*'default'/
    )
  })

  it('★ 阳性对照：上两条扫的文件里确实有这段逻辑（否则是判据空转，不是代码干净）', () => {
    // 洗档的**新**写法必须是"只做形状容错、原值保留" —— 认它而不是认"没有这段逻辑"
    const code = stripComments(src('shared/models.ts'))
    expect(code).toContain('reasoningEffort')
    expect(code).toMatch(/typeof\s+\w+\.reasoningEffort\s*===\s*'string'/)
  })

  it('`reasoning` 声明必须过读盘容错与合成透传**两跳**（缺一跳就是"填了等于没写"）', () => {
    const code = stripComments(src('shared/models.ts'))
    expect(code, 'normalizeReasoning 不见了 ⇒ 用户填的 reasoning 每次读盘都会被丢掉').toContain(
      'function normalizeReasoning'
    )
    expect(code, '读盘容错没有把 reasoning 接进 settings').toMatch(/settings\.reasoning\s*=\s*reasoning/)
    // 09-27 变异自检露的洞：第一版只钉了读盘那一跳，删掉 `settingsOf` 里的透传**照样全绿**。
    // 两跳都在守卫里，缺一条就有一半的洞重新打开。
    expect(code, 'settingsOf 没有透传 reasoning ⇒ 声明存得进、合成时没人读').toMatch(
      /over\.reasoning\s*\?\s*\{\s*reasoning:\s*over\.reasoning\s*\}/
    )
  })

  it('未知档名不许被送进 Math.min（那是 NaN 出境，编译与门禁都不报）', () => {
    const code = stripComments(src('main/providers/anthropic.ts'))
    // 危险形状：查表结果直接进 Math.min —— `EFFORT_BUDGET` 现在是 `Record<string, number>`，
    // 未登记的官方档（xhigh / minimal）取到 undefined，Math.min(undefined, n) 是 NaN。
    expect(code, '查表结果又直接进了 Math.min ⇒ 未知档会算出 NaN').not.toMatch(
      /Math\.min\(\s*EFFORT_BUDGET\[/
    )
    // 兜底必须显式判 undefined 并降级成"不开思考"
    expect(code, '未知档名没有显式降级').toMatch(/budget\s*===\s*undefined\s*\)\s*return null/)
  })

  it('`REASONING_KINDS` 只有一份真相：形状校验读常量，不许写字面量数组', () => {
    expect(src('shared/ipc.ts')).toContain("export const REASONING_KINDS = ['effort', 'toggle', 'budget_tokens', 'none']")
    expect(src('main/schemas.ts')).toContain('z.enum(REASONING_KINDS)')
    // 抄一份字面量就是两份真相：加一种形态时只改了一处，另一处静默过期
    expect(stripComments(src('main/schemas.ts'))).not.toMatch(
      /z\.enum\(\s*\[\s*'effort'\s*,\s*'toggle'/
    )
  })

  it('★ 阳性对照：逐模型白名单校验确实落在保存那道闸门上（校验层与出境层各有一半，缺一不可）', () => {
    const schemas = src('main/schemas.ts')
    expect(schemas).toContain('superRefine(reasoningLevelsGuard)')
    // 且它在**模型条目**那一层逐条判，不是整表一票否决（`schemas.test.ts` 有行为级对应用例，
    // 断言渲染后的 path 是 `models.1.settings.reasoningEffort` 且不含 `models.0.` ——
    // 这里只钉"逐条判这件事写在闸门上"，path 字面量留给行为测试，结构层不跟它抢）
    expect(schemas).toMatch(/path:\s*\[\s*'models',\s*i,/)
    // `ReasoningEffort` 必须还是**开放**的：退回封闭枚举 = 这次改判等于没做
    expect(src('shared/ipc.ts')).toContain("export type ReasoningEffort = 'default' | (string & {})")
  })

  it('★ 请求体构造器不许把 settings 整体展开（`reasoning` / `contextWindow` 是客户端元数据）', () => {
    // 为什么盯整棵 provider 树而不是点名四个构造器：点名的清单追不上人新写的构造器
    // （与"navigator.clipboard 按目录扫"那条同一条理由）。现状四个构造器全是**显式挑字段**。
    // 一旦有人图省事写 `...settings`，`reasoning` 与 `contextWindow` 会一起漏进请求体。
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const e of readdirSync(join(__dirname, '../../src', dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...walk(rel))
        else if (/\.tsx?$/.test(e.name)) out.push(rel)
      }
      return out
    }
    const files = walk('main/providers')
    expect(files.length, '扫描器一个文件都没找到 = 判据空转').toBeGreaterThan(5)
    for (const f of files) {
      const code = stripComments(src(f))
      expect(code, `${f} 把 settings 整个展开进请求体了`).not.toMatch(/\.\.\.\s*settings\b/)
      expect(code, `${f} 把 settings 序列化进请求体了`).not.toMatch(/JSON\.stringify\(\s*settings\b/)
    }
    // 阳性对照：请求体里**确实**有 reasoning 的正确归宿（显式赋给 reasoning_effort）
    expect(stripComments(src('main/providers/openai.ts'))).toContain("body['reasoning_effort']")
  })

  it('★ openai 侧不许再无条件直发开放字符串（那条 400 打到底的路径，09-28 独立审查抓到的口）', () => {
    for (const f of ['main/providers/openai.ts', 'main/providers/openai-agent.ts']) {
      const code = stripComments(src(f))
      expect(code, `${f} 还在用"不是 default 就发"这条旧判定`).not.toMatch(
        /reasoningEffort\s*!==\s*'default'\s*\)\s*body\[[^\]]*reasoning_effort/
      )
      expect(code, `${f} 没走 effortToSend`).toContain('effortToSend')
    }
  })
})

// —— K58：渲染层错误上报通路（plan8 R18 的"可排查性那一半"）——————————————————————
// 为什么值得立一组守卫：这条通路的**每一条链路上少一环，症状都是同一个** ——
// "界面没反应 + 日志里什么都没有"，而 09-27 那次就是这样查了三轮。
// ⇒ 少一环不会让任何现有测试红，只会**回到出故障前的那个状态**。
describe('K58 渲染层错误上报：每一环都在场', () => {
  it('★ 两个监听必须装在**页面入口**（不是 preload）—— 实测装在 preload 收不到事件', () => {
    // **这条判据的来源是一次失败**（09-28 真机 e2e）：原实现把监听装在 preload，
    // 跑出来 K1/K2 全红而 K3/K4（console 那半）全绿。诊断用两枚标记分辨：
    // preload **安装监听时**打的标记进了 app.log（说明 preload 的 console 确实被转发，
    // 不是"转发不到"造成的假象），而监听器**触发时**打的标记**零命中**。
    // ⇒ 结论：`contextIsolation:true` + `sandbox:true` 下，sandboxed preload 在隔离世界
    // 注册的 `window.addEventListener('error'/'unhandledrejection')` **收不到主世界的事件**。
    //    监听必须装在页面（`renderer/src/main.tsx`）。
    // 为什么值得立判据：下一个人看到"preload 更早、更难被绕过"很可能想搬回去 ——
    // 而搬回去的后果是**症状与没做一模一样**（那条通路静默失灵，没有任何闸会响）。
    const main = src('renderer/src/main.tsx')
    expect(main, '页面入口没装 error 监听 ⇒ 未捕获异常只剩 console 那半（没有堆栈）').toContain(
      "addEventListener('error'"
    )
    expect(main, '页面入口没装 unhandledrejection 监听').toContain("addEventListener('unhandledrejection'")
    // 入口是唯一合适的位置：两个窗口都经过它，且它在 React 挂载**之前**（否则首屏就崩的异常会漏）
    // ⚠️ 找的是 `createRoot(root).render` 这个**调用**形态 —— 裸 `indexOf('createRoot')`
    //   会撞上第 2 行的 `import { createRoot }`，判据自己先翻车（09-28 现场）。
    const at = main.indexOf("addEventListener('error'")
    const mount = main.indexOf('createRoot(root).render')
    expect(at, '监听必须在 React 挂载之前装（否则首屏就崩的异常会漏）').toBeGreaterThan(-1)
    expect(mount, '判据坏了：找不到 createRoot(root).render 的调用').toBeGreaterThan(-1)
    expect(at, '监听必须在 React 挂载之前装（否则首屏就崩的异常会漏）').toBeLessThan(mount)
    // 反向哨兵：preload 里**不许**再装这两个监听（那是实测不工作的那一版）
    const preload = stripComments(src('preload/index.ts'))
    expect(preload, 'preload 里的监听实测收不到事件，别搬回来').not.toMatch(
      /addEventListener\(\s*'(error|unhandledrejection)'/
    )
    // ⚠️ **强度声明（09-28 变异实测出来的边界，别夸大）**：本条是**文本层**判据，只认字面。
    //   变异证据：把监听包成 `if (false) window.addEventListener('unhandledrejection', …)` ——
    //   字面还在，**本组 50 条全绿**。⇒ 它防的是"整体删掉 / 换地方挂 / 挂到 preload"，
    //   **防不住"包在一个永不成立的分支里"**。那一档由 `tests/e2e/renderer-error.spec.ts`
    //   的 K2 承担（真起进程触发 → 撤掉监听即红，本批已实测）。
    //   ⇒ 两层分工：结构层管"挪位"，行为层管"失效"。缺 e2e 那一层就有真漏洞。
  })

  it('上报桥在 preload 上（页面零直连 ipcRenderer）且真的发出去了', () => {
    // 本项目口径：渲染进程不碰 ipcRenderer，系统能力一律经 preload 暴露的 `window.api`
    const preload = src('preload/index.ts')
    expect(preload).toContain('ipcRenderer.send(IPC.rendererError')
    expect(preload).toContain('reportRendererError: (report) => sendErrorReport(report)')
    expect(src('shared/ipc.ts')).toContain('reportRendererError(report: RendererErrorReport): void')
    // 页面只能调桥
    expect(src('renderer/src/main.tsx')).toContain('window.api.reportRendererError')
  })

  it('★ 挂载点必须是 web-contents-created，不许去每个 createWindow 里加一行', () => {
    // 逐个 createWindow 加 = "多接一处必然漏"（D-134/D-136 的原话）；
    // 而漏掉的那一处症状与没做一模一样：那个窗口的日志永远是空的。
    // ⚠️ 判的是**调用形态**（`app.on('web-contents-created'`）而不是字样 ——
    //   `index.ts` 的注释里就会提到这个名字（说明为什么这么挂），按字样判会假红。
    const index = src('main/index.ts')
    expect(index, '钩子被写进 index.ts 了 ⇒ 将来新开的窗口不在覆盖范围内').not.toMatch(
      /app\.on\(\s*'web-contents-created'/
    )
    expect(src('main/renderer-errors.ts')).toMatch(/app\.on\(\s*'web-contents-created'/)
    expect(index, 'index.ts 没有装它').toContain('installRendererErrorReporting()')
  })

  it('主进程侧两半都要在：console-message（抓 console.error/warn）+ ipcMain.on（抓真异常）', () => {
    const re = src('main/renderer-errors.ts')
    expect(re, '渲染层 console.error/warn 没有通路').toContain("contents.on('console-message'")
    expect(re, 'preload 上报的真异常没有 handler').toContain('ipcMain.on(IPC.rendererError')
  })

  it('★ 取舍必须钉住：不收 info 档（用户正文最可能出现在 console.log 里）', () => {
    // 这条是**取舍的判据**。有人为了"排障方便"把收档放宽成全收，
    // 于是用户消息正文被写进日志文件、app.log 被刷爆 —— 两个后果都不可逆。
    //
    // ⚠️ **09-28 改判**：原来这里断言的是**源码文本** `/if \(level !== 2 && level !== 3\) return/`，
    //   连带一条 `not.toMatch(/if \(level >= 2 && level <= 3\)/)`。两处都是坏判据：
    //   ① 逐字锚定（含空格与括号）—— 语义等价的 `level < 2` / `[2,3].includes(level)` /
    //      提成常量 `RECORDED_LEVELS` 全部**假红**（取舍没变，CI 却红了）；
    //   ② 那条反向断言**零安全收益、纯假红地雷** —— `level >= 2 && level <= 3` 精确等价于
    //      `{2,3}` 且并不收 0/1，它是一个完全正确的实现，却被明文禁止。
    // ⇒ 改成：判定**必须**是一个可单测的纯函数（isRecordedConsoleLevel），
    //   语义由 `tests/unit/renderer-errors.test.ts` 的 3 条单测守（含 Electron ≥35 的字符串形态）。
    // ⚠️ 09-28 又改了一次指向：那个纯函数搬到了 `renderer-errors-core.ts`
    //   （本模块 import electron，而 CI 的 `quality` job 没有二进制 ⇒ 单测不能从这儿 import）。
    const core = src('main/renderer-errors-core.ts')
    expect(core, '收档判定必须是导出的纯函数（否则"只收两档"这条取舍没法单测）').toContain(
      'export function isRecordedConsoleLevel'
    )
    // 且 console 半边真的用了它（而不是自己另写一份判定 —— 两份判定就会漂）
    expect(stripComments(src('main/renderer-errors.ts')), 'console 半边没用 isRecordedConsoleLevel').toContain(
      'isRecordedConsoleLevel(level)'
    )
    // 反向锚点：档位常数**只此一处**（散落两处 = 改了一处忘了另一处）
    expect(stripComments(core).match(/level === 2 \|\| level === 3/g)?.length).toBe(1)
  })
  it('★ 覆盖范围：非自家窗口**不挂**监听（第三方页面内容不进日志）', () => {
    // 内置浏览器装的是任意外部网址，远程页面爱用 console.error 打印 URL 与 ?token=…
    // ⇒ 用户在一个站点上看到个报错，那个站点的 token 就进了用户正在教开发者发出去的文件里。
    // 判据钉的是**结构化判据**（`getType() === 'window'`）：`WebContentsView` 的 type 是
    // `'browserView'`（查证 Electron 文档 `contents.getType()`），而 URL 猜法对它是失效的 ——
    // 独立审查实测过 `about:blank` 与 `https://github.com/…` 都不含 'browser' 子串。
    const re = stripComments(src('main/renderer-errors.ts'))
    expect(re, '来源过滤不见了').toContain("contents.getType() === 'window'")
    // 排除的那次必须**留痕**（否则下一个人会以为是漏挂了）
    expect(re, '排除非自家窗口要留一行日志（否则取舍不可见）').toContain('非自家窗口不挂渲染层错误监听')
    // 且 IPC 侧也要过同一道（第三方网页拿不到 preload 的桥，但校验零成本）
    expect(src('main/renderer-errors.ts')).toMatch(/ipcMain\.on\([\s\S]*?isAppWindow\(sender\)/)
  })

  it('★ 身份按 registry 登记的角色比，不靠 URL 子串猜（多窗口铁律）', () => {
    // 旧写法用 `url.includes('browser')` 认内置浏览器 —— 那是 `window-registry.ts`
    // 文件头写着要消灭的那类做法，且对 WebContentsView 事实上不可达。
    const re = stripComments(src('main/renderer-errors.ts'))
    expect(re, '窗口身份没有走 registry').toContain("getWindow('main')?.webContents === contents")
    expect(re, '窗口身份没有走 registry').toContain("getWindow('settings')?.webContents === contents")
    expect(re, '不该再用 URL 子串猜角色').not.toMatch(/url\.includes\('browser'\)/)
  })

  it('★ 丢弃也必须留痕（静默丢弃 = 这条通路立项要消灭的形态原样复现）', () => {
    const re = src('main/renderer-errors.ts')
    expect(re, '解析不出来的上报被静默丢掉了').toContain('丢弃了一条无法解析的渲染层上报')
    expect(re, '来源不明的上报被静默丢掉了').toContain('丢弃一条来源不明窗口的渲染层上报')
  })

  it('★ 两条来源共用一条记法（拆开写就会漂：改了一处忘了另一处）', () => {
    const re = stripComments(src('main/renderer-errors.ts'))
    // ⚠️ **09-28 改判**：原来这里断言 `record(` 出现**恰好 3 次** —— 双向都错：
    //   加第三个来源（`did-fail-load` 之类）走 record ⇒ 计数 4 ⇒ **假红**，而那正是这条守卫
    //   鼓励的行为；反过来在 handler 里**绕过** record 直接内联 `log.error` 而两条 record
    //   都留着 ⇒ 计数仍是 3 ⇒ **假绿**，"共用一条记法"的承诺破了它看不见。
    // ⇒ 改成"**渲染层错误**只经 record"这个可判的命题：两个 handler 里都不许出现裸 `log.error`。
    //   判据只禁 `log.error`、**放行 `log.warn`**：后者是**通路自身的诊断**
    //   （"丢弃了一条无法解析的上报" / "非自家窗口不挂"）—— 它们不是渲染层错误，
    //   没有 message/stack 可节流，走 record 反而会拿空键去占去重表。
    //   （09-28：这两条守卫第一版把 `log.warn` 也禁了，与"丢弃也必须留痕"那条直接打架。）
    const handlerRegion = re.slice(re.indexOf('ipcMain.on(IPC.rendererError'), re.indexOf('function attach'))
    expect(handlerRegion, 'IPC handler 绕过了 record（节流与字段定型都会失效）').not.toMatch(/log\.error\(/)
    const consoleRegion = re.slice(re.indexOf('function attach'), re.indexOf('log.info('))
    expect(consoleRegion, 'console handler 绕过了 record').not.toMatch(/log\.error\(/)
    // 且 record 真的存在（正向）
    expect(re).toMatch(/function record\(/)
  })

  it('★ 时钟必须由调用方注入（否则"60 秒内不重复"这条判据测不了）', () => {
    // 直接 `Date.now()` 的实现，单测只能真等一分钟 —— 等一分钟的测试等于没有测试。
    const core = src('main/renderer-errors-core.ts')
    expect(core).toMatch(/export function throttle\([\s\S]*?now: number/)
    // 取时钟的那一处在 electron 那半（core 里不许有 `Date.now()` 的直接调用）
    expect(stripComments(core), '纯逻辑里直接读时钟 ⇒ 节流判据又测不了了').not.toMatch(/Date\.now\(\)/)
    expect(src('main/renderer-errors.ts')).toMatch(/const now = \(\): number => Date\.now\(\)/)
  })

  it('★ 渲染层不许有**空 catch 回调**（R18 真根因那一类：抛了不报、也不留痕）', () => {
    // 2026-09-27 的根因是 `.catch(() => {})`：不复制、不提示、不记日志，三件坏事同时成立。
    // 它**抓不到也测不到**（没抛错就没有 onerror 可抓）⇒ 只能靠静态闸在它长出来时就拦。
    // 实测当前渲染层**零命中**，所以这条一加就是绿的 —— 它是预防闸不是返工闸。
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const e of readdirSync(join(__dirname, '../../src', dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...walk(rel))
        else if (/\.tsx?$/.test(e.name)) out.push(rel)
      }
      return out
    }
    const files = walk('renderer/src')
    expect(files.length, '扫描器一个文件都没找到 = 判据空转').toBeGreaterThan(20)
    for (const f of files) {
      // ⚠️ 必须先剥注释：解释"为什么这里 catch 了"的注释里可能写着例子
      expect(stripComments(src(f)), `${f} 里有空的 catch 回调`).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\)/)
    }
  })
})

// —— 「本地全绿 ≠ 通过」的第六次兑现：可单测的模块不许 import electron ———————————————————
// 现场（2026-09-28）：新写的 `tests/unit/renderer-errors.test.ts` 从 `@main/renderer-errors`
// import 纯逻辑，而那个模块 `import { app, ipcMain } from 'electron'`。
// **本机有 electron 二进制 ⇒ 127 个文件全绿**；CI 的 `quality` job 跳过二进制下载
// （它只要 typecheck / lint / 单测）⇒ 那个文件直接 `Electron failed to install correctly`，
// CI `quality` ❌ 而 `e2e` / `gate-render` ✅ —— 一个**只有单测文件挑食**的红。
//
// `AGENTS.md` §八那条红线原文只说了"渲染进程不得 import electron"，主进程没点名 ——
// 而这里的真实规则是：**凡是被 `tests/unit` 直接 import 的模块，一律不许 import electron**。
// 本项目既有先例本来就符合（`main/log.ts` 只 import node:fs/node:path、
// `main/watchdog.ts` 被三个单测 import 且同样不碰 electron），是我新写文件时没沿用。
describe('可单测的模块不许 import electron（CI 的 quality job 没有二进制）', () => {
  const repo = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8')

  /** 被 `tests/unit` 直接 import 的 `src/main/*` 模块（`@main/x` 与相对路径都算） */
  const unitImportsMain = (): string[] => {
    const out = new Set<string>()
    for (const f of readdirSync(__dirname)) {
      if (!f.endsWith('.test.ts')) continue
      for (const m of repo(`tests/unit/${f}`).matchAll(/from '@main\/([\w./-]+)'/g)) out.add(m[1])
    }
    return [...out].map((p) => `src/main/${p}.ts`)
  }

  it('前提成立：真的扫到了一批模块（扫不到 = 这条判据空转）', () => {
    expect(unitImportsMain().length, '一个 @main 模块都没扫到 ⇒ 扫描范围错了').toBeGreaterThan(3)
  })

  it('★ 被单测 import 的模块一律不许 import electron', () => {
    for (const p of unitImportsMain()) {
      // 逐行剥掉注释再查：解释"为什么这里不能 import electron"的注释里可能就写着这个词
      const code = stripComments(repo(p))
      expect(code, `${p} 被 tests/unit import，却 import 了 electron`).not.toMatch(/from\s*'electron'/)
    }
  })

  it('★ 阳性对照：electron 那半**确实**在另一个文件里（拆开不是把功能拆没了）', () => {
    // 反向钉住"干脆什么都不 import"这种坏修法：纯逻辑模块要与 electron 那半**同源**，
    // 否则两份判定会漂（K58 就是被这么抓出过一个"两份收档规则"的隐患）。
    const core = stripComments(repo('src/main/renderer-errors-core.ts'))
    const impl = stripComments(repo('src/main/renderer-errors.ts'))
    expect(core).not.toMatch(/from\s*'electron'/)
    expect(impl, 'electron 那半不见了').toMatch(/from\s*'electron'/)
    expect(impl, '没有从 core 取纯逻辑（那会变成两份实现）').toContain("from './renderer-errors-core'")
  })
})

// —— plan58 片①：档位控件的三条形态纪律 + 缺陷 4 已收口 ————————————————————————————
// 为什么立组：片① 的三条纪律全是**"做错了不会崩、只会变成骗人的东西"**那一类 ——
// 档位控件摆错了形状，用户看到的是一个"能点但不按他说的生效"的界面。
describe('推理等级控件：形态纪律（plan58 R7 / R13 / R14）', () => {
  const ed = src('renderer/src/components/ModelCatalogEditor.tsx')

  it('★ `kind` 决定**控件形状**：`none` ⇒ 档位块不出现；非 `effort` 分流到各自的控制项（片② 起已接通）', () => {
    // `none` 时摆个下拉 = 骗人的格子（plan54 #3 同族）。
    // ⚠️ 片② 改判：片① 时"非 effort 只给说明"是因为出境形状未接通（缺口 C）；片② 接通后
    // 非 effort 分支里是**真控件**（开关 / 预算框 + 编码声明），故正向锚点随之一并钉住。
    expect(ed, '推理等级那块没有按 kind 分流').toContain("rc?.kind !== 'none'")
    expect(ed, '非 effort 形态必须分流').toContain("if (kind !== 'effort')")
    // 片② 正向：三型的控制项与形态选择器都在场（逃出口 —— 选了 none 还能改回来）
    expect(ed, 'toggle 没有开关').toContain('aria-label="思考开关"')
    expect(ed, 'budget_tokens 没有预算框').toContain('aria-label="思考预算"')
    expect(ed, '没有形态选择器 ⇒ none 是死界面').toContain('aria-label="思考形态"')
  })

  it('★ 档位集合只认模型自己声明的 `levels`（R6），没声明时**如实标未实测**而不是替厂商下结论', () => {
    // 我们三家端点的档位支持情况一格都没实测过（plan58 §丁 / R9）。
    expect(ed).toContain('sortEffortLevels(reasoning?.levels ?? [])')
    expect(ed, '未实测这件事必须说在界面上').toContain('未实测')
  })

  it('★ 「设了不等于生效」当场说：生效与否走**主进程同一份判定**（`effortToSend`）', () => {
    // ⚠️ 这条是"单一真相"的可判形态：界面自己另算一套 ⇒ 漂了的症状是
    // "界面说生效、实际没发"（R5 要防的正是这个）。
    expect(ed, '界面没有用共享判定').toContain('effortToSend({ reasoningEffort: effort, reasoning })')
    expect(ed, '界面不许自己判断 level 是否被包含').not.toMatch(/levels\.includes\((s\.)?reasoningEffort/)
  })

  it('★ 档位控件复用设置页既有形态（`.choice-list` + `.choice-item`），不新造 chip 类名', () => {
    // `.chip` 这个类名**已被模型切换器占用**（styles.css 1791 行），新造同名样式会两边打架。
    // 权限档 / Token Saver 档位用的是 `choice-list` + `choice-item`，门禁也认那一套。
    expect(ed, '推理等级没用既有档位按钮形态').toContain('className="choice-list"')
    expect(ed).toContain('choice-item')
    expect(ed, '不许新造 .chip-row 之类').not.toContain('chip-row')
  })

  it('★ 缺陷 4 已收口：档位选择的两个同义入口不许回来', () => {
    // 原形状：思考强度那支 `<select value={s.reasoningEffort ?? ''}>` 里有
    // `<option value="">跟随端点默认</option>` 与 `<option value="default">default</option>`，
    // 两者走**同一个出境动作**（都存成"不发字段"）⇒ 同一个动作两个入口。
    //
    // ⚠️ 两次判据自己先翻车（09-28 现场），两次都是**扫得太宽**：
    //   ① 按字样扫 `跟随端点默认` → 那是输出上限 / 上下文窗口 / 工具轮数三个输入框的
    //      placeholder，**当场假红**；
    //   ② 扫 `<option value="">` → 撞上「+」那个 select 的**占位项**（HTML select 靠它显示
    //      `＋`，没有它下拉第一项会直接变成第一个候选档名）。
    // ⇒ 判据改成**认位置不认字面**：档位选择已经不用 select 了（用 `.choice-item`），
    //   那个带 `reasoningEffort` 的 select 不许回来；`＋` 那个 select 用 aria-label 区分。
    const code = stripComments(ed)
    expect(code, '档位选择退回下拉了（两个同义入口就跟着回来）').not.toMatch(
      /value=\{s\.reasoningEffort\s*\?\?\s*''\}/
    )
    expect(code, '"default" 那一项又回来了（与"跟随端点默认"同义）').not.toMatch(/<option\s+value="default"/)
    // 正向锚点：`＋` 那个 select 必须在，且带自己的 aria-label（否则与档位选择分不开）
    expect(code).toContain('aria-label="添加推理等级"')
    // 收口后的唯一入口是「恢复默认」
    expect(code).toContain('恢复默认（不发送思考字段）')
  })

  it('★ 强度序与 `+` 候选池来自共享层（界面不许自己写一份档名表）', () => {
    // 两份档名表会漂 —— 而漂了的症状是"`+` 里能选一个下拉里没有的档"。
    expect(ed).toContain('ADDABLE_EFFORT_LEVELS')
    expect(ed).not.toMatch(/const (EFFORT|KNOWN)\w* = \[/)
  })
})

// —— plan58 片②：缺口 C 的出境接线 + patch 单字段 IPC 全链 ——————————————————————————
// 为什么立组：这一批的病根形状还是"字段存在但没人接"—— `enabled` / `budget` 在片⓪ 就进了
// 契约层，出境层却是空的（缺口 C），控件上线而这里断一环，用户看到的是只会开的开关。
// 每一环断了都不会让现有测试红，只会回到"调了不生效"。
describe('片② 缺口 C：出境接线 + patch 全链每一环都在场', () => {
  it('★ toggle / budget_tokens 的出境判定在 shared，且两个 openai 构造器都接了', () => {
    const shared = stripComments(src('shared/reasoning.ts'))
    expect(shared, '出境判定不在 shared ⇒ 界面披露与主进程发不发会漂（R5 同族）').toContain(
      'export function openaiReasoningFields'
    )
    expect(shared).toContain('export function anthropicThinkingBudget')
    for (const f of ['main/providers/openai.ts', 'main/providers/openai-agent.ts']) {
      const code = stripComments(src(f))
      expect(code, `${f} 没接 toggle/budget 出境字段`).toContain('openaiReasoningFields(settings)')
    }
  })

  it('★ anthropic 通路走 kind 感知出口（thinkingBudgetFor 只看档名不看 kind 的暗病不许回来）', () => {
    const anth = stripComments(src('main/providers/anthropic.ts'))
    expect(anth, 'body 构造器没有换 kind 感知出口').toContain('thinkingBudgetForSettings(settings)')
    const agent = stripComments(src('main/providers/anthropic-agent.ts'))
    // 两处（非流式 + 流式/带工具构造）都不许直呼 thinkingBudgetFor
    const hits = agent.match(/thinkingBudgetForSettings\(settings\)/g) ?? []
    expect(hits.length, 'anthropic-agent 只接了一处').toBeGreaterThanOrEqual(2)
    expect(agent, '还留着直呼旧函数的调用点').not.toMatch(/thinkingBudgetFor\(settings\.reasoningEffort/)
  })

  it('★ 两个出境编码必须在读盘容错里活下来（否则用户声明过一次、重读就没了）', () => {
    const models = stripComments(src('shared/models.ts'))
    expect(models, 'budgetEncoding 读盘被丢').toContain('out.budgetEncoding')
    expect(models, 'offEncoding 读盘被丢').toContain('out.offEncoding')
  })

  it('★ patch 单字段全链：通道 → schema → handler（合成过闸）→ store → 广播 → preload', () => {
    expect(src('shared/ipc.ts')).toContain("modelsPatchEntry: 'models:patch-entry'")
    const schemas = src('main/schemas.ts')
    expect(schemas, 'patch 的形状闸不在').toContain('modelPatchEntrySchema')
    expect(schemas, 'patch schema 没接编码字段').toContain('budgetEncoding')
    const ipc = stripComments(src('main/ipc.ts'))
    expect(ipc, 'handler 没挂').toContain('IPC.modelsPatchEntry')
    expect(ipc, '补丁没有合成整表过 modelSaveSchema ⇒ 白名单守卫对 patch 失效（Q13 漂口径）').toMatch(
      /friendlyParse\(\s*modelSaveSchema/
    )
    expect(ipc, '合并没走 shared 那份 ⇒ Q2 两份真相').toContain('mergeEntrySettings(entry.settings')
    expect(ipc, 'patch 后不广播 ⇒ 另一个窗口永远拿旧值').toContain("onSettingsChanged?.('models')")
    expect(stripComments(src('main/store/models.ts'))).toContain('patchEntrySettings')
    expect(src('preload/index.ts')).toContain('patchModelEntry:')
  })

  it('★ chip 的回显纪律：读主进程真值（patch 返回值），广播来了重读', () => {
    const chip = stripComments(src('renderer/src/components/InputTools.tsx'))
    expect(chip, 'chip 没调 patchModelEntry').toContain('patchModelEntry(')
    expect(chip, 'patch 结果没有回写视图（本地自说自话）').toContain('setModels(view)')
    expect(chip, '没有订阅广播 ⇒ 设置窗改了这边不跟').toContain('onSettingsChanged')
    // Q12：存量档案与 none 都不出现
    expect(chip, '未声明/none 的判断不见了').toContain("rs.kind === 'none'")
  })

  it('★ 编码的界面文案只有一份（设置页声明与 chip 披露读同一张表）', () => {
    const shared = stripComments(src('shared/reasoning.ts'))
    expect(shared).toContain('BUDGET_ENCODING_LABELS')
    expect(shared).toContain('OFF_ENCODING_LABELS')
    const ed = src('renderer/src/components/ModelCatalogEditor.tsx')
    expect(ed, '设置页声明下拉没用共享文案').toContain('OFF_ENCODING_LABELS')
    expect(ed).toContain('BUDGET_ENCODING_LABELS')
  })

  it('★ 片③：上下文窗口 chip 同走 patch 通道（Q8 两处读同一真值的链路在场）', () => {
    // patch schema 收 contextWindow（边界与整表保存同一档，行为级在 schemas.test.ts）
    const schemas = stripComments(src('main/schemas.ts'))
    expect(schemas, 'patch 形状闸没收 contextWindow').toMatch(
      /contextWindow:\s*z\.number\(\)\.int\(\)\.min\(1000\)/
    )
    const chip = stripComments(src('renderer/src/components/InputTools.tsx'))
    expect(chip, '窗口 chip 不存在（R3 的就近入口没落地）').toContain('aria-label="上下文窗口"')
    expect(chip, '窗口 chip 没走 patch 通道').toContain('patch: { contextWindow: value }')
    // 指路口径同步（§四 连带清单）：入口搬进输入框后，圆环的指路不许再只指向设置页
    expect(chip, 'ContextRing 的指路句还在把人往设置页指（入口已在输入框）').toContain(
      '可在输入框「窗口」芯片或设置页调整'
    )
  })
})
