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

/** 媒体类引用的公共形状（图片与视频在存档侧同构：都只放"去哪儿拿"，不放字节本体） */
interface MediaRef {
  /** 如 image/png 或 video/mp4；出站时直接当 media_type / data URL 的 MIME 用 */
  mime: string
  /** userData/attachments 下的受限文件名（读它才拿得到字节） */
  ref: string
  /** 原始文件字节数（呈现与预检用，≠ base64 长度） */
  bytes: number
}

/** 图片的落盘引用（不是数据本体） */
export interface ImageRef extends MediaRef {
  type: 'image'
}

/** 视频的落盘引用（plan57 片⑤）。形状与图片同构，只有 `type` 与 MIME 不同 */
export interface VideoRef extends MediaRef {
  type: 'video'
}

export type ContentPart = { type: 'text'; text: string } | ImageRef | VideoRef

/** 出站形态：base64 已就位，provider 只认这个，不再碰文件系统 */
export type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; base64: string; ref: string }
  | { type: 'video'; mime: string; base64: string; ref: string }

/** 读引用 → 字节。注入而非直接读盘：让本模块保持可单测，且测试能数清"同一张图被读了几次" */
export type LoadImage = (ref: string) => Promise<Buffer>

/** 一轮里读不到媒体时的替代文本。必须让模型看出"这里本来有媒体但没送到"，不许当成什么都没发生 */
export function missingImageNote(ref: string): string {
  return `[图片未能送达，文件已不可读：${ref}]`
}
export function missingVideoNote(ref: string): string {
  return `[视频未能送达，文件已不可读：${ref}]`
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
  onError?: (ref: string, kind: 'image' | 'video') => WirePart
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
        out.push(onError(p.ref, p.type))
        continue
      }
      cache.set(p.ref, b64)
    }
    out.push({ type: p.type, mime: p.mime, base64: b64, ref: p.ref })
  }
  return out
}

/** 这条 parts 里有没有媒体块（图片或视频） */
function hasMedia(parts: ContentPart[]): boolean {
  return parts.some((p) => p.type === 'image' || p.type === 'video')
}

/** `materializeHistory` 的输入：只要求这三个形状，`ChatMessage` 与 `AgentMessage` 都落在里面 */
export interface PartBearing {
  content?: string | null
  parts?: ContentPart[]
}

export interface MaterializeOptions {
  /**
   * 最近**几轮**带媒体的消息保留原文件，更早的折回正文里那条 `<file kind="…" …>` marker
   * （D-146 C 裁定：默认 1）。没查到厂商推荐轮数，这是工程判断。
   */
  keepRecentImageTurns?: number
}

/**
 * 整段历史 → 出境历史：按 ref 物化 base64，并把**超出配额的旧媒体**从 parts 里摘掉。
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
    if (!parts || !hasMedia(parts)) {
      out[i] = parts ? { ...rest, parts: await materializeParts(parts, load) } : rest
      continue
    }
    // 配额只按"带媒体的轮"数：中间夹几轮纯文本，不该把上一轮的媒体提前折掉
    if (kept >= keep) {
      out[i] = rest
      continue
    }
    kept++
    out[i] = {
      ...rest,
      parts: await materializeParts(parts, load, (ref, kind) => ({
        type: 'text',
        text: kind === 'video' ? missingVideoNote(ref) : missingImageNote(ref)
      }))
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

/** 这条消息里有几张图、几段视频（发送前拦、用量牌、模态判据都用这一份，别在多处重新数） */
export function mediaCountOf(parts?: ContentPart[]): { image: number; video: number } {
  const n = { image: 0, video: 0 }
  if (!parts) return n
  for (const p of parts) {
    if (p.type === 'image') n.image++
    else if (p.type === 'video') n.video++
  }
  return n
}

/** 兼容旧调用点：只数图片 */
export function imageCountOf(parts?: ContentPart[]): number {
  return mediaCountOf(parts).image
}

/**
 * 出境支持的图片类型 = Anthropic 与 OpenAI 两份清单的交集。
 * ⚠️ 不含 SVG：`fs-tree.imageMimeOf` 那份表收 SVG（它能内嵌脚本，预览侧另说），
 * 而两家模型都不收 —— 放出去只会在厂商侧变成一个解读不了的错误。
 */
export const OUTBOUND_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/**
 * 出境支持的视频类型。⚠️ **只放实测过的那一种**：09-27 一次性探针在 MiMo token-plan 端点上
 * 用 `video/mp4` + base64 答对了画面标记（usage 另报 `video_tokens`）；mov / webm **未实测**，
 * 所以不收进来 —— 猜一个没测过的容器格式，坏了只会以"模型说它没看到视频"的形式暴露。
 */
export const OUTBOUND_VIDEO_MIMES = ['video/mp4'] as const

/** 出境视频按扩展名认（与 `fs-tree.imageMimeOf` 同一思路，但**这张表只收实测过的容器**） */
const VIDEO_EXT_MIME: Record<string, string> = { '.mp4': 'video/mp4' }

export function outboundVideoMimeOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const mime = VIDEO_EXT_MIME[name.slice(dot).toLowerCase()]
  return mime && (OUTBOUND_VIDEO_MIMES as readonly string[]).includes(mime) ? mime : null
}

/**
 * 单图出境预检线。⚠️ 未直读官方原文：Anthropic 侧 5 MB 与 10 MB 两家口径冲突 ⇒ **取最严的 5 MB**。
 * 超了就在本机拦下并报因，好过让请求体带着几十 MB 去撞一个被网关改写过的错误串（D-146 B）。
 */
export const MAX_OUTBOUND_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 单段视频出境预检线。⚠️ **未直读任何官方上限**（MiMo 模型页只写"输入模态含视频"，无时长/体积/编码边界）。
 * 取 20 MB 是**本机工程判断**：base64 会再放大 1.33 倍 ⇒ 请求体约 27 MB，
 * 已经接近多数网关的默认请求体上限。改这个数之前请先拿到实测或官方依据。
 */
export const MAX_OUTBOUND_VIDEO_BYTES = 20 * 1024 * 1024

/** 一条消息最多几张图（防一次拖进整个相册把请求体撑爆；数值是工程判断，未见厂商官方上限） */
export const MAX_IMAGES_PER_TURN = 8
/** 一条消息最多几段视频（同上，且比图片更严：一段抵几十张） */
export const MAX_VIDEOS_PER_TURN = 2

/**
 * 落盘文件名的形状：`YYYYMMDDTHHMMSS-<序号>-<6 位十六进制>.<png|jpg|jpeg|gif|webp|mp4>`。
 * ref 从存档一路传到主进程去读盘，**只认这一种形状** —— 收路径就是给穿越留门（与 `mcp/artifacts.ts` 同口径）。
 */
export const ATTACHMENT_REF_RE =
  /^[0-9]{8}T[0-9]{6}-[0-9]{1,3}-[0-9a-f]{6}\.(png|jpe?g|gif|webp|mp4)$/

export function isSafeAttachmentRef(ref: string): boolean {
  return ATTACHMENT_REF_RE.test(ref)
}

/** 模型可声明的输入模态。`text` 恒在（没有它这条会话根本发不出去） */
export const INPUT_MODALITIES = ['text', 'image', 'video'] as const
export type InputModality = (typeof INPUT_MODALITIES)[number]

const MODALITY_LABEL: Record<InputModality, string> = {
  text: '文本',
  image: '图片',
  video: '视频'
}
/** 中文量词按模态分：「1 个图片」不是中文，拦截文案是要给人读的 */
const MODALITY_QUANTIFIER: Record<InputModality, string> = { text: '条', image: '张', video: '段' }

/** 该模态在设置页里的勾选项名称（界面与拦截文案共用一份，别两处各写一遍） */
export function modalityLabel(m: InputModality): string {
  return MODALITY_LABEL[m]
}

/**
 * 官方探测状态（K51→K53，B3 选 B）：当前模型的官方图片能力位。
 * - `true` = 官方确认支持（但手勾没勾 ⇒ 仍拦，报因升级成"勾选即可"）；
 * - `false` = 官方确认不支持（⇒ 仍拦，报因升级成"换模型"）；
 * - `null`/`undefined` = 未探测或已过期 ⇒ **旧文案逐字保留**（既有单测钉住，一字不改）。
 */
export interface OfficialImageSupport {
  image: boolean | null
}

/**
 * 能力位闸（D-146 B）：本轮要发的媒体里有模型未声明支持的模态时**发送前拦**，报清楚是几条、去哪儿改。
 * 独立成纯函数不是为了好看：`chat:send` 那条链在门禁的隔离进程里跑不到，
 * 而"死开关"这一族（字段存在、没人消费）必须有能被单测钉住的判定点。
 *
 * 拦的是**整段历史里任意一轮带媒体**：旧轮折成 marker 后模型仍被告知"这里有过一张图/一段视频"，
 * 那正是"界面有、模型没"的假成功，不能因为它不带 base64 就放行。
 * （B3 定案：C 方案驳回，D-146 B 维持 —— K53 只升级报因精度，不改"拦不拦"。）
 *
 * @param providerType 协议类型。⚠️ **视频只有 OpenAI 兼容线有通路**，Anthropic 那边没有 image 之外的
 *   视频块形状 —— 用户在 Anthropic 档案上勾了「视频」也发不出去，所以这里必须按协议再拦一道，
 *   而不是等 provider 静默丢掉那个块（那正是"界面有、模型没"）。
 * @param official K53 新增（可选）：官方探测状态。只影响**图片被拦时**的那一句报因，
 *   视频路径与上限两条一律走旧文案（探测目前只问图片位，不碰视频）。
 * @returns null = 放行；否则是可直接显示给用户的原因
 */
export function modalityGateError(
  available: readonly InputModality[],
  counts: { image: number; video: number },
  providerType: 'openai-compatible' | 'anthropic' = 'openai-compatible',
  official?: OfficialImageSupport
): string | null {
  if (counts.image > MAX_IMAGES_PER_TURN) {
    return `一条消息最多 ${MAX_IMAGES_PER_TURN} 张图片，本轮有 ${counts.image} 张：请分几条消息发送`
  }
  if (counts.video > MAX_VIDEOS_PER_TURN) {
    return `一条消息最多 ${MAX_VIDEOS_PER_TURN} 段视频，本轮有 ${counts.video} 段：请分几条消息发送`
  }
  for (const need of ['image', 'video'] as const) {
    if (counts[need] === 0 || !available.includes(need)) {
      if (counts[need] === 0) continue
      const label = MODALITY_LABEL[need]
      // K53：图片被拦且有新鲜官方位 ⇒ 报因升级（仍拦）。视频/未知一律旧文案。
      if (need === 'image' && official && official.image === true) {
        return (
          `本轮含 ${counts[need]} ${MODALITY_QUANTIFIER[need]}${label}，官方能力位显示该模型支持${label}输入：` +
          `请在「设置 → 模型」的「输入模态」里勾选「${label}」后重发`
        )
      }
      if (need === 'image' && official && official.image === false) {
        return (
          `本轮含 ${counts[need]} ${MODALITY_QUANTIFIER[need]}${label}，官方能力位显示该模型不支持${label}输入：` +
          `请换用支持${label}输入的模型（可在「设置 → 模型」拉模型列表刷新探测）`
        )
      }
      return (
        `本轮含 ${counts[need]} ${MODALITY_QUANTIFIER[need]}${label}，当前模型未声明支持${label}输入：` +
        `请在「设置 → 模型」的「输入模态」里勾选「${label}」，或改用支持${label}输入的模型`
      )
    }
    // 声明了、也勾了，但**这条协议没有通路**：照样拦，绝不静默丢块
    if (need === 'video' && providerType === 'anthropic') {
      return 'Anthropic 协议目前没有视频输入通路：请改用 OpenAI 兼容端点，或把视频先转成关键帧图片'
    }
  }
  return null
}

/** 旧字段 `supportsImages: boolean` → 新形状模态集合（读盘迁移用，见 `normalizeEntry`） */
export function modalitiesFromLegacyFlag(supportsImages: boolean | undefined): InputModality[] {
  return supportsImages === true ? ['text', 'image'] : ['text']
}

/**
 * 读盘容错：只认白名单里的模态、去重、补上 `text`。
 * 全不合法时返回 null（让调用方走旧字段迁移），**不返回 `[]`** —— 空集合意味着"什么都发不出去"，
 * 那是比缺字段更糟的状态，不该由一份坏数据静默造出来。
 */
export function normalizeModalities(raw: unknown): InputModality[] | null {
  if (!Array.isArray(raw)) return null
  const ok = new Set<InputModality>()
  for (const v of raw) {
    if ((INPUT_MODALITIES as readonly string[]).includes(String(v))) ok.add(v as InputModality)
  }
  if (ok.size === 0) return null
  ok.add('text')
  return INPUT_MODALITIES.filter((m) => ok.has(m))
}
