import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename as renameFs, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { resolveInsideWorkspace } from './agent/guard'

// 工作区统一写入服务（plan7 批 A2 的前置 —— 全功能资源管理器的地基）——
//
// 为什么非要有这一层：**界面与 Agent 必须走同一条写入路径**。
// 改版前的检查点快照挂在 file-tools 那个工具上，界面若自己 writeFile 就**绕过检查点**：
// 用户用文件树删掉一个文件，回滚面板里什么都没记，**退不回来** —— 那正是 plan1 补上的承诺。
//
// 现在把「写前快照 + 落盘」收进服务，两边共用：谁写都留痕，谁都退得回。
//
// 本模块**不 import electron**：回收站能力从外面注入（否则不可单测 —— CI 无 Electron 二进制）。

export interface WorkspaceWriteHooks {
  /**
   * 写前快照（检查点）。**必须在真正落盘之前**调用 —— 先记下原样，改坏了才有得退。
   * 不传 = 不记（单测 / 无检查点场景）。
   */
  beforeChange?: (rel: string, abs: string) => void
  /** 删除到回收站（生产注入 `shell.trashItem`，测试注入假实现） */
  trash: (abs: string) => Promise<void>
}

export interface WorkspaceWriter {
  /** 工作区根（工具层也要用，一并带上，省得两处各传一份） */
  root: string
  write(rel: string, content: string): Promise<string>
  mkdir(rel: string): Promise<string>
  rename(rel: string, nextRel: string): Promise<string>
  /** 删除到**回收站**，不是硬删 —— 误删还能自己捞回来 */
  remove(rel: string): Promise<string>
  /** 把工作区**外**的一个文件复制进来（拖拽上传） */
  copyIn(sourceAbs: string, rel: string): Promise<string>
}

export function createWorkspaceWriter(
  workspaceRoot: string,
  hooks: WorkspaceWriteHooks
): WorkspaceWriter {
  /** 解析并**校验边界**：越界一律抛错（调用方各自决定怎么把它变人话） */
  const absOf = (rel: string): string => {
    const abs = resolveInsideWorkspace(workspaceRoot, rel)
    if (!abs) throw new Error(`路径「${rel}」越出工作区边界，已拒绝`)
    return abs
  }

  return {
    root: workspaceRoot,

    async write(rel, content) {
      const abs = absOf(rel)
      hooks.beforeChange?.(rel, abs)
      // 父目录不存在则自动创建（调用方不该为 mkdir 单独跑一趟）
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return `已写入 ${rel}（${Buffer.byteLength(content, 'utf8')} 字节）`
    },

    async mkdir(rel) {
      const abs = absOf(rel)
      hooks.beforeChange?.(rel, abs)
      await mkdir(abs, { recursive: true })
      return `已创建目录 ${rel}`
    },

    async rename(rel, nextRel) {
      const from = absOf(rel)
      const to = absOf(nextRel)
      // 源与目标**都要**快照：
      //   · 源会消失 → 快照记成 modified，回滚时把内容写回原位
      //   · 目标可能被覆盖 → 原本不存在则记成 created，回滚时删掉它
      // 两条合起来，回滚后正好回到 rename 之前的样子。
      hooks.beforeChange?.(rel, from)
      hooks.beforeChange?.(nextRel, to)
      await mkdir(dirname(to), { recursive: true })
      await renameFs(from, to)
      return `已重命名 ${rel} → ${nextRel}`
    },

    async remove(rel) {
      const abs = absOf(rel)
      hooks.beforeChange?.(rel, abs)
      await hooks.trash(abs)
      return `已删除 ${rel}（已移入回收站）`
    },

    async copyIn(sourceAbs, rel) {
      const wanted = absOf(rel)
      const info = await stat(sourceAbs)
      if (!info.isFile()) throw new Error('目前只支持拖入文件（文件夹请逐个拖入）')
      // **不覆盖**已有文件：同名时自动加序号。
      // 拖同一个文件两次是很常见的动作，静默覆盖会让人白白丢掉原有内容。
      const to = await uniquePath(wanted)
      const finalRel = to === wanted ? rel : relative(workspaceRoot, to).replace(/\\/g, '/')
      hooks.beforeChange?.(finalRel, to)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(sourceAbs, to)
      const renamed = to === wanted ? '' : `（同名已存在，另存为 ${finalRel}）`
      return `已导入 ${finalRel}（${info.size} 字节）${renamed}`
    }
  }
}

/** 目标已存在时自动加序号：`a.txt` → `a (2).txt` → `a (3).txt` … */
async function uniquePath(abs: string): Promise<string> {
  if (!existsSync(abs)) return abs
  const dir = dirname(abs)
  const ext = extname(abs)
  const stem = basename(abs, ext)
  for (let i = 2; i < 1000; i++) {
    const next = join(dir, `${stem} (${i})${ext}`)
    if (!existsSync(next)) return next
  }
  throw new Error('同名文件太多（已有 1000 个），请先清理目标目录')
}
