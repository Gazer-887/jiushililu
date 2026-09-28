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
    // 这条是**取舍的判据**。有人为了"排障方便"把 level 判定放宽成全收，
    // 于是用户消息正文被写进日志文件、app.log 被刷爆 —— 两个后果都不可逆。
    const re = src('main/renderer-errors.ts')
    expect(re, 'console 的收档判定不见了').toMatch(/if \(level !== 2 && level !== 3\) return/)
    // 反向锚点：注释里必须留着"为什么不收"，否则下次有人看不懂为什么只有两档
    expect(stripComments(re)).not.toMatch(/if \(level >= 2 && level <= 3\)/) // 不能只写上界
  })

  it('★ 两条来源共用一条记法（拆开写就会漂：改了一处忘了另一处）', () => {
    const re = stripComments(src('main/renderer-errors.ts'))
    // record() 是唯一出口：console-message 与 renderer:error 都调它
    const calls = re.match(/record\(/g) ?? []
    // 定义 1 处 + 两个来源各 1 处
    expect(calls.length).toBe(3)
    expect(re).toMatch(/function record\([\s\S]*?\n\}/)
  })

  it('★ 时钟必须由调用方注入（否则"60 秒内不重复"这条判据测不了）', () => {
    // 直接 `Date.now()` 的实现，单测只能真等一分钟 —— 等一分钟的测试等于没有测试。
    const re = src('main/renderer-errors.ts')
    expect(re).toMatch(/export function throttle\([\s\S]*?now: number/)
    expect(re).toMatch(/const now = \(\): number => Date\.now\(\)/)
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
