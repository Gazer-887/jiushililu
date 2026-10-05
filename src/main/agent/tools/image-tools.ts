// 旧图重看（plan57 K52 · B2）：把历史 marker 指的那张落盘图取回来给模型看。
// D-146 C 的工具通路：marker 必须可还原 —— 路径在 marker 里，字节在落盘里，
// 本工具是连两者的那条路。纯读（读落盘 + 不写盘），故进 READ_ONLY_TOOLS。

import { imageMimeOf } from '@shared/fs-tree'
import type { AgentTool } from '@shared/agent'
import { readAttachmentMedia } from '../../attachments-store'

export function createImageTools(deps: { root: string }): AgentTool[] {
  const viewImage: AgentTool = {
    schema: {
      name: 'view_image',
      description:
        '取回历史里某张旧图再看一次。入参是历史正文里 `<file kind="image" …>` marker 的 `ref` 字段；' +
        '旧轮的图只留 marker（字节早被配额折掉），想再看必须调本工具。取回的图随下轮请求出示给模型。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'marker 里的 ref（落盘文件名，如 xxx.png）' }
        },
        required: ['ref']
      }
    },
    async execute(args) {
      const ref = typeof args['ref'] === 'string' ? args['ref'].trim() : ''
      if (!ref) return '请提供 marker 里的 ref。'
      let buf: Buffer
      try {
        buf = readAttachmentMedia(deps.root, ref)
      } catch (err) {
        // D-146 C：读不到降级成人话，不卡死会话（失败轮也落盘是另一条，不归这里管）
        const why = err instanceof Error ? err.message : String(err)
        return `那张图找不回来了（${why}）。继续用文字描述也行。`
      }
      const mime = imageMimeOf(ref)
      // B2 边界内只有图片（视频另案）：扩展名认不出图片 MIME 的一律按"不是图"处理，不猜
      if (!mime) return `那张图找不回来了（${ref} 不是受支持的图片格式）。继续用文字描述也行。`
      const kb = Math.max(1, Math.round(buf.length / 1024))
      return {
        text: `已取回 ${ref}（${kb}KB，随下轮请求出示）。`,
        images: [{ name: ref, mime, bytes: buf.length }],
        forwardImagesToModel: [{ mime, ref, base64: buf.toString('base64') }]
      }
    }
  }
  return [viewImage]
}
