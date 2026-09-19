/**
 * 运行环境注入（plan43 S3）—— 纯函数层，**不碰 spawn、不碰文件系统**。
 *
 * ## 为什么需要这一层
 *
 * 设置页存的是「语言 → 可执行文件**绝对路径**」（`devEnvSelected`），
 * 而 PATH 是**目录级**语义。直接把 `dirname` 插进 PATH 会有两个真实问题：
 *
 * ① **目录级连带**：conda 环境里 `python.exe` 与 `conda.exe`、`Scripts\` 同在树下，
 *    选 python 会把整个 conda 生态一起顶到 PATH 最前 —— intent 之外的东西跟着变了。
 * ② **布局不可假设**：node 与 npm 同目录（nvm/volta），但 python 与 pip 未必；
 *    按「见过的那个布局」写就是**值判断冒充类判断**（与本项目 `url.ts` 的 `/v1` 缺陷同源）。
 *
 * 故本层采用 **shim 目录**语义：不注入用户选中的目录，而是注入一个**只放被选中可执行文件**
 * 的中转目录 —— 文件级隔离，不连带、不假设布局。
 *
 * ## 三条「钉死」（稳定性来源）
 *
 * 1. **钉死基准**：一律以**应用启动时快照**的 PATH 为底重建，不用 `process.env` ——
 *    否则每次注入都在上一次结果上叠加（`选中;选中;原始`）。
 * 2. **钉死范围**：文件级 shim，不碰目录级连带（见上）。
 * 3. **钉死时机**：agent run 开始时定一次，run 内不变 —— 漂移由调用方的环境指纹负责（见 S3c）。
 *
 * ⚠️ 本文件是纯逻辑：所有 IO（写 shim 文件、读真实 PATH）都在调用方。**故可单测。**
 */
import { LANGUAGE_SPECS, type LanguageSpec } from './dev-env'

/** 中转目录在 userData 下的相对名（调用方负责拼绝对路径） */
export const RUNTIME_BIN_DIRNAME = 'runtime-bin'

/** 一个「用户选中的可执行文件」到 shim 条目的映射结果 */
export interface ShimEntry {
  /** 语言 id（node / python / uv） */
  language: string
  /** 用户选中的原件绝对路径 */
  target: string
  /** shim 文件所在的中转目录（绝对路径，全语言共用一个） */
  shimDir: string
  /** shim 文件名，如 `python.cmd` / `node.cmd`（Windows）或 `python`（POSIX） */
  shimName: string
  /** shim 完整路径 */
  shimPath: string
}

/**
 * 由可执行文件路径取文件名（去扩展名）。
 *
 * ⚠️ 这是**兜底**用，不是主要判据 —— shim 该叫什么名字由**语言**决定（见 `primaryCommandName`）。
 */
export function commandNameFromExecutable(exePath: string): string {
  const base = exePath.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '')
}

/**
 * **语言的主命令名** —— shim 文件该叫什么，由它决定。
 *
 * ⚠️ 为什么不能按可执行文件名定（这是实测抓出来的坑）：
 * 用户从 `python.exe` 换成 `python3.exe`，若 shim 名跟着变成 `python3.cmd`，
 * 那么 `python` 这个命令就**消失了** —— 而用户只是换了版本，没想换命令。
 * 且 `python` 是绝大多数工具链实际调用的名字。
 *
 * 判据来源 = `LANGUAGE_SPECS[].probeBins[0]`（探测层已定义的"每种语言叫什么"），
 * **不另立一套** —— 否则探测与注入会漂移。
 */
export function primaryCommandName(language: string, specs: LanguageSpec[] = LANGUAGE_SPECS): string {
  const spec = specs.find((s) => s.id === language)
  return spec?.probeBins[0] ?? language
}

/** Windows 需要 `.cmd` 转发（软链要管理员或开发者模式）；POSIX 直接可执行文件名 */
export function shimFileName(commandName: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${commandName}.cmd` : commandName
}

/**
 * 计算 shim 条目清单。
 *
 * @param selected 语言 → 可执行文件绝对路径（来自 `devEnvSelected`）
 * @param shimDir  中转目录绝对路径（调用方给出；本层不解析 userData）
 * @param specs    语言规格（默认 `LANGUAGE_SPECS`；可注入以便单测）
 */
export function buildShimEntries(
  selected: Record<string, string>,
  shimDir: string,
  platform: NodeJS.Platform = process.platform,
  specs: LanguageSpec[] = LANGUAGE_SPECS
): ShimEntry[] {
  const sep = platform === 'win32' ? '\\' : '/'
  const dir = shimDir.replace(/[\\/]+$/, '')
  const out: ShimEntry[] = []
  for (const [language, target] of Object.entries(selected)) {
    if (typeof target !== 'string' || target.trim().length === 0) continue
    // ⚠️ 名字取自**语言**（`probeBins[0]`），不是取自文件名 ——
    //    否则用户把 python.exe 换成 python3.exe，`python` 命令就凭空消失了。
    const name = primaryCommandName(language, specs)
    if (name.length === 0) continue
    const shimName = shimFileName(name, platform)
    out.push({
      language,
      target,
      shimDir: dir,
      shimName,
      shimPath: `${dir}${sep}${shimName}`
    })
  }
  // 稳定排序：语言字典序 —— 让 shim 产物与测试断言可复现（不依赖 Object.entries 的插入序）
  return out.sort((a, b) => a.language.localeCompare(b.language))
}

/** Windows `.cmd` 转发脚本内容（`%*` 透传全部参数；`@` 抑制自身回显） */
export function cmdShimContent(target: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // ⚠️ 用引号包住原件路径：路径含空格（`C:\Program Files\…`）时不加引号会拆成两个 token
    return `@echo off\r\n"${target}" %*\r\n`
  }
  return `#!/bin/sh\nexec "${target}" "$@"\n`
}

/**
 * 这段内容**是不是我们生成的 shim**（清理时的判据）。
 *
 * ## 为什么用"内容签名"而不是"文件名白名单"
 *
 * 曾经用文件名白名单（枚举 `LANGUAGE_SPECS` + `selected` 的 key），2026-09-19 交叉复查
 * 实测抓出它**有洞**：清理那一刻 `selected` 已经是新的（可能为空），于是"上一轮用过的、
 * 但不在本轮 selected 里的 id"推导不出来 —— 例如选中 `python3`（规格表里没有的 id）
 * 后取消，`python3.cmd` **永久残留**，"删除即撤销"失效。
 *
 * 根因是**判据依赖了会变的外部状态**。内容签名不依赖任何外部状态：
 * **我们写的文件长什么样，是确定的** —— 用它认自己，永远准。
 *
 * ## 三条同时满足才算（宁可漏放，不可误杀）
 *
 * 1. 行结构与 `cmdShimContent` 逐字一致（注释行 + 转发行），**且**至少有一条转发行；
 * 2. 全部转发行都形如「引号包住的绝对路径 + 参数占位」——即真的是个转发脚本；
 * 3. **没有**任何不属于该结构的额外内容（用户往里写自己的东西不会被误认）。
 *
 * ⚠️ 保守取向：认不出来就**不删**。删是不可逆动作，误杀用户文件比留个孤儿 shim 严重得多。
 */
export function isOurShimContent(text: string, platform: NodeJS.Platform = process.platform): boolean {
  if (text.length === 0) return false
  const lines = text.split(/\r?\n/)
  // 去掉末尾空行（`cmdShimContent` 末尾有换行）
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return false

  if (platform === 'win32') {
    // 期望形如：`@echo off` + 若干 `"<abs>" %*`
    if (lines[0] !== '@echo off') return false
    const rest = lines.slice(1)
    if (rest.length === 0) return false
    return rest.every((l) => /^"[^"]+" %\*$/.test(l))
  }
  // POSIX：`#!/bin/sh` + 若干 `exec "<abs>" "$@"`
  if (lines[0] !== '#!/bin/sh') return false
  const rest = lines.slice(1)
  if (rest.length === 0) return false
  return rest.every((l) => /^exec "[^"]+" "\$@"$/.test(l))
}

/**
 * **核心**：把 shim 目录插到 PATH 头部，基准是**启动快照**而非当前值。
 *
 * 关键约束（逐条对应本文件头部的「三条钉死」）：
 * - **幂等**：同一基准 + 同一 shimDir 反复调用，结果恒等。
 *   实现方式是**先移除已有 shimDir**再插到头部 —— 这样即使调用方传了脏 PATH
 *   （上一次注入的结果），也不会出现 `shim;shim;原始`。
 * - **不替换**：`git` / `npm` / `rg` 这些仍从原始 PATH 找得到。
 * - **去重语义**：移除的是**所有**等于 shimDir 的段（不只是头部那一个）——
 *   用户若自己也在 PATH 里加过同名目录，一并收拢，避免歧义。
 *
 * @param basePath 应用**启动时快照**的 PATH（调用方保证是快照，不是实时值）
 * @param shimDir  中转目录绝对路径；**传空串 = 不注入**（返回基准原样）
 */
export function injectRuntimePath(
  basePath: string | undefined,
  shimDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const base = basePath ?? ''
  if (shimDir.trim().length === 0) return base
  // ★ **基准为空 → 拒绝注入**（返回原样），不是"只有 shim 的 PATH"。
  //
  // 为什么这条必须挡住：本函数是"**在基准前面插一项**"，基准为空时插出来的是
  // **只有 shim 一条的 PATH** —— git / npm / rg 全部找不到，比不注入**更糟**。
  // 这是"防御性代码自身有缺陷"：`?? ''` 只让**类型**安全，没让**语义**安全。
  // （2026-09-19 交叉复查实测抓出：`injectRuntimePath('', 'C:\\u\\runtime-bin')`
  //   返回 `"C:\\u\\runtime-bin"`，系统 PATH 整条丢失。）
  if (base.trim().length === 0) return base

  const sep = platform === 'win32' ? ';' : ':'
  const target = shimDir.replace(/[\\/]+$/, '')
  // Windows 大小写不敏感；POSIX 敏感 —— 用同一个键函数避免两套判据
  const key = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p)

  const parts = base
    .split(sep)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => key(p.replace(/[\\/]+$/, '')) !== key(target))

  return [target, ...parts].join(sep)
}

/**
 * 从 PATH 里解析出「当前实际会命中的」可执行文件路径。
 *
 * 用途（plan43 S3d）：状态栏要显示**真实生效值**，而不是设置页里那个字符串 ——
 * 两者可能不一致（会话是旧的、注入失败、用户在外部改了 PATH）。
 *
 * @param env      要检查的 PATH 值
 * @param shimDir  我们注入的中转目录（用于判断「注入是否还在」）
 */
export function isShimDirPresent(pathValue: string | undefined, shimDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!pathValue || shimDir.trim().length === 0) return false
  const sep = platform === 'win32' ? ';' : ':'
  const target = shimDir.replace(/[\\/]+$/, '')
  const key = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p)
  return pathValue
    .split(sep)
    .map((p) => p.trim().replace(/[\\/]+$/, ''))
    .filter((p) => p.length > 0)
    .some((p) => key(p) === key(target))
}

/**
 * **环境指纹**（plan43 S3c）：用来判断「该不该换个 shell 会话」。
 *
 * 为什么需要：`shell-session` 是**常驻复用**的（`cd` / 环境变量跨轮存活，plan28 D-085）。
 * 用户改了设置后，若下一个 run 继续复用旧 shell，就会**用上旧环境**；
 * 若等 10 分钟空闲回收才变，则是「碰运气生效」。
 *
 * → 做法与 VS Code 对齐：**已开的终端不动**（正在跑的活不该被抽凳子），
 *   但**下一个 run** 指纹不同就主动淘汰旧会话、起新的。**确定性，不碰运气。**
 *
 * 指纹内容 = 选中项 + shim 目录。**不含时间戳** —— 指纹必须只反映「环境是否真的不同」，
 * 否则每次调用都变，会话会被无意义地反复重建。
 */
export function runtimeFingerprint(
  selected: Record<string, string>,
  shimDir: string
): string {
  const entries = Object.entries(selected)
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
  return `shim:${shimDir.replace(/[\\/]+$/, '')}|${entries.join('|')}`
}
