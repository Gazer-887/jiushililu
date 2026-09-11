import { readFile } from 'node:fs/promises'
import type { AgentTool } from '@shared/agent'
import { resolveInsideWorkspace } from '../guard'
import type { WorkspaceWriter } from '../../workspace-write'

// 内置工具第一批（plan6）：文件读写。
// 两条硬边界：① 路径必须落在 workspaceRoot 内（防逃逸）② 读取上限 1MB（防撑爆上下文）。
//
// plan7 批 A2：**写操作改走统一写入服务** ——
// 快照与落盘都收在服务层，界面与 Agent 共用同一条路径。
// 此前快照挂在工具上，界面若自己写文件就绕过检查点，删掉的东西退不回来。

const MAX_READ_BYTES = 1024 * 1024

export function createFileTools(writer: WorkspaceWriter): AgentTool[] {
  const read_file: AgentTool = {
    schema: {
      name: 'read_file',
      description: '读取工作区内一个文本文件的内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的文件路径' }
        },
        required: ['path']
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : ''
      const abs = resolveInsideWorkspace(writer.root, rel)
      if (!abs) return `错误：路径「${rel}」越出工作区边界，拒绝读取`
      try {
        const buf = await readFile(abs)
        if (buf.byteLength > MAX_READ_BYTES) return '错误：文件超过 1MB，读取被拒绝'
        return buf.toString('utf8')
      } catch (err) {
        return `错误：读取失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const write_file: AgentTool = {
    schema: {
      name: 'write_file',
      description: '把文本内容写入工作区内的一个文件（覆盖式写入，路径不存在会自动创建）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的文件路径' },
          content: { type: 'string', description: '要写入的完整文本内容' }
        },
        required: ['path', 'content']
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : ''
      const content = typeof args['content'] === 'string' ? args['content'] : null
      if (content === null) return '错误：缺少 content 参数'
      try {
        return await writer.write(rel, content)
      } catch (err) {
        return `错误：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return [read_file, write_file]
}
