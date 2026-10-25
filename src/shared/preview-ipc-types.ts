// 对话内预览的 IPC 边界合同（plan74，shared 层，主/渲染共用）。
//
// 与 preview-gateway 的内部类型分开：这里是「过 IPC 线」的形状 —— 可序列化、渲染层只拿该拿的。
// 出站结果 = Gateway 裁定（能力/来源/文本）+ 协议层给的预览 URL + 句柄 id（释放用）。

import type { PreviewCapabilities, PreviewSourceKind } from './conversation-preview'

/** 打开预览的入参（renderer 提供引用，主进程裁定，不信任意路径）。 */
export interface PreviewOpenInput {
  source: PreviewSourceKind
  conversationId?: string
  messageId?: string
  /** draft：宿主登记的草稿身份（Gateway 据此核该草稿已登记）。 */
  draftId?: string
  assetId?: string
  workspaceRel?: string
  name: string
  mime: string
  bytes?: number
}

/** 打开预览的出参。ok=false 时带 errorCode/reason；ok=true 带句柄与预览 URL。 */
export interface PreviewOpenOutput {
  ok: boolean
  /** 宿主补探事实，不能把渲染端占位mime/0字节当成真实产物信息。 */
  mime?: string
  bytes?: number
  name?: string
  errorCode?: string
  reason?: string
  /** 会话绑定句柄（释放用；不暴露给任意 DOM 猜测之外的地方）。 */
  handleId?: string
  /** 预览 URL（jsl-preview://asset/<handleId>），渲染层直接给 <img>/<video>/<iframe>。 */
  url?: string
  capabilities?: PreviewCapabilities
  sourceLabel?: 'history' | 'current' | 'draft'
  sourceVersion?: string
  /** 文本类就地渲染的有界内容（HTML/文本/MD 用；不落协议）。 */
  boundedText?: string
  truncated?: boolean
  /** plan74 R5：明确降级标记（如 PDF 解析失败）—— 渲染层据此显示降级提示 + 系统打开出口，不假装成功。 */
  degraded?: string
  /** 宿主解析出的工作表，静态沙箱URL，不执行Office脚本或公式。 */
  officeSheets?: { name: string; url: string }[]
  officeClipped?: boolean
}

/** 发送前摄取外部文件的入参（工作区外显式导入）。 */
export interface PreviewIngestInput {
  /** 源文件绝对路径（宿主已校验是用户显式选择/拖入的文件）。 */
  sourceAbs: string
  /** 展示名。 */
  name: string
  /** 宿主探测的 MIME。 */
  mime: string
  /** 草稿身份：宿主登记的发送前草稿 id（摄取成功后登记，供 previewOpen 核）。 */
  draftId: string
}

/** 摄取结果：成功带 assetId（随后即可 previewOpen 预览）；失败带人话原因。 */
export interface PreviewIngestOutput {
  ok: boolean
  assetId?: string
  bytes?: number
  digest?: string
  /** 宿主实际签发的草稿身份，不采用调用端自报的id。 */
  draftId?: string
  reason?: string
}
