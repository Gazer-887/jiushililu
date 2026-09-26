/**
 * 多模态内容块（plan57 片③）。
 *
 * 一条铁律贯穿本文件：**历史与存档里只放引用，base64 只在出站那一刻出现**。
 * 把 base64 塞进会话正文会同时撞三处墙：存档预算（`MAX_STORED_CHARS`）、
 * 每轮重放时反复重写同一张图、以及 token 估算被字符数放大两个数量级（K50，见 tokens.ts）。
 *
 * ⚠️ 与 `ChatMessage.segments` / `createdAt` 的区别要分清：那两个是**本地渲染资产、不发给模型**；
 *    `parts` 是**要发给模型**的出境内容。混为一谈就会做出"界面有图、模型没图"的假成功。
 */

/** 图片的落盘引用（不是数据本体） */
export interface ImageRef {
  type: 'image'
  /** 如 image/png；出站时直接当 media_type 用 */
  mime: string
  /** userData 下的相对文件名（附件目录内唯一）；读它才拿得到字节 */
  ref: string
  /** 原图字节数（呈现与预检用，≠ base64 长度） */
  bytes: number
}

export type ContentPart = { type: 'text'; text: string } | ImageRef

/** 出站形态：base64 已就位，provider 只认这个，不再碰文件系统 */
export type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; base64: string; ref: string }

/** 读引用 → 字节。注入而非直接读盘：让本模块保持可单测，且测试能数清"同一张图被读了几次" */
export type LoadImage = (ref: string) => Promise<Buffer>

/** 一轮里读不到图时的替代文本。必须让模型看出"这里本来有张图但没送到"，不许当成什么都没发生 */
export function missingImageNote(ref: string): string {
  return `[图片未能送达，文件已不可读：${ref}]`
}

/**
 * 把引用物化成出站块。**同一轮内按 ref 去重**：一条消息里重复贴同一张图，不该编两遍。
 *
 * 为什么按 ref 而不是按内容哈希：ref 指向的是**落盘副本**，写进去就不再变；
 * 哈希要先把字节读出来才算了得，而"不重复读"正是这里想省的东西。
 *
 * 默认读不到就抛（让调用方看见）；给了 `onError` 才降级 —— 历史每轮重放时一张被清掉的图
 * 不该把整段会话卡死（D-146 C 裁定引的 Kiro 反例）。
 */
export async function materializeParts(
  parts: ContentPart[],
  load: LoadImage,
  onError?: (ref: string) => WirePart
): Promise<WirePart[]> {
  const cache = new Map<string, string>()
  const out: WirePart[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text })
      continue
    }
    let b64 = cache.get(p.ref)
    if (b64 === undefined) {
      try {
        b64 = (await load(p.ref)).toString('base64')
      } catch (err) {
        if (!onError) throw err
        out.push(onError(p.ref))
        continue
      }
      cache.set(p.ref, b64)
    }
    out.push({ type: 'image', mime: p.mime, base64: b64, ref: p.ref })
  }
  return out
}

/** `materializeHistory` 的输入：只要求这三个形状，`ChatMessage` 与 `AgentMessage` 都落在里面 */
export interface PartBearing {
  content?: string | null
  parts?: ContentPart[]
}

export interface MaterializeOptions {
  /**
   * 最近**几轮**带图的消息保留原图，更早的折回正文里那条 `<file kind="image" …>` marker
   * （D-146 C 裁定：默认 1）。没查到厂商推荐轮数，这是工程判断。
   */
  keepRecentImageTurns?: number
}

/**
 * 整段历史 → 出境历史：按 ref 物化 base64，并把**超出配额的旧图**从 parts 里摘掉。
 *
 * 摘掉不等于丢图：正文里那条 marker 带着文件名，存档中的 `parts` 也还在（引用制，见文件头），
 * 下一轮用户"再看这张图"时仍能还原。反过来若旧图也原样重放，一张截图就能把后面每轮的输入都抬起来。
 */
export async function materializeHistory<T extends PartBearing>(
  messages: T[],
  load: LoadImage,
  opts: MaterializeOptions = {}
): Promise<Array<Omit<T, 'parts'> & { parts?: WirePart[] }>> {
  const keep = Math.max(0, opts.keepRecentImageTurns ?? 1)
  const out: Array<Omit<T, 'parts'> & { parts?: WirePart[] }> = new Array(messages.length)
  let kept = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const { parts, ...rest } = messages[i]
    if (!parts || parts.every((p) => p.type !== 'image')) {
      out[i] = parts ? { ...rest, parts: await materializeParts(parts, load) } : rest
      continue
    }
    // 配额只按"带图的轮"数：中间夹几轮纯文本，不该把上一轮的图提前折掉
    if (kept >= keep) {
      out[i] = rest
      continue
    }
    kept++
    out[i] = {
      ...rest,
      parts: await materializeParts(parts, load, (ref) => ({ type: 'text', text: missingImageNote(ref) }))
    }
  }
  return out
}

/** 纯文本部分拼回一条字符串（给只看 text 的旧代码用，如日志与摘要） */
export function textOfParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** 这条消息里有几张图（发送前拦与用量牌都用它，别在多处重新数） */
export function imageCountOf(parts?: ContentPart[]): number {
  if (!parts) return 0
  return parts.filter((p) => p.type === 'image').length
}

/**
 * 出境支持的图片类型 = Anthropic 与 OpenAI 两份清单的交集。
 * ⚠️ 不含 SVG：`fs-tree.imageMimeOf` 那份表收 SVG（它能内嵌脚本，预览侧另说），
 * 而两家模型都不收 —— 放出去只会在厂商侧变成一个解读不了的错误。
 */
export const OUTBOUND_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/**
 * 单图出境预检线。⚠️ 未直读官方原文：Anthropic 侧 5 MB 与 10 MB 两家口径冲突 ⇒ **取最严的 5 MB**。
 * 超了就在本机拦下并报因，好过让请求体带着几十 MB 去撞一个被网关改写过的错误串（D-146 B）。
 */
export const MAX_OUTBOUND_IMAGE_BYTES = 5 * 1024 * 1024

/** 一条消息最多几张图（防一次拖进整个相册把请求体撑爆；数值是工程判断，未见厂商官方上限） */
export const MAX_IMAGES_PER_TURN = 8

/**
 * 落盘文件名的形状：`YYYYMMDDTHHMMSS-<序号>-<6 位十六进制>.<png|jpg|jpeg|gif|webp>`。
 * ref 从存档一路传到主进程去读盘，**只认这一种形状** —— 收路径就是给穿越留门（与 `mcp/artifacts.ts` 同口径）。
 */
export const ATTACHMENT_REF_RE =
  /^[0-9]{8}T[0-9]{6}-[0-9]{1,3}-[0-9a-f]{6}\.(png|jpe?g|gif|webp)$/

export function isSafeAttachmentRef(ref: string): boolean {
  return ATTACHMENT_REF_RE.test(ref)
}

/**
 * 能力位闸（D-146 B）：模型未标记支持图片时**发送前拦**，报清楚是多少张、去哪儿改。
 * 独立成纯函数不是为了好看：`chat:send` 那条链在门禁的隔离进程里跑不到，
 * 而"死开关"这一族（字段存在、没人消费）必须有能被单测钉住的判定点。
 *
 * @returns null = 放行；否则是可直接显示给用户的原因
 */
export function imageGateError(supportsImages: boolean, imageCount: number): string | null {
  if (imageCount === 0) return null
  if (imageCount > MAX_IMAGES_PER_TURN) {
    return `一条消息最多 ${MAX_IMAGES_PER_TURN} 张图片，本轮有 ${imageCount} 张：请分几条消息发送`
  }
  if (supportsImages) return null
  return (
    `本轮含 ${imageCount} 张图片，当前模型未标记支持图片输入：` +
    `请在「设置 → 模型」勾选「图片输入支持」，或改用支持图片输入的模型`
  )
}
