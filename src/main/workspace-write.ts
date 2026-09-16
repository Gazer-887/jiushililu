import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename as renameFs, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { isInside, resolvePathInWorkspace, type PathAccess } from './agent/guard'

// 工作区统一写入服务（plan7 批 A2 的前置 —— 全功能资源管理器的地基）。
//
// 为什么非要有这一层：**界面与 Agent 必须走同一条写入路径**。检查点快照原先只挂在 file-tools
// 那个工具上，界面若自己 writeFile 就**绕过检查点** —— 用户用文件树删掉一个文件，回滚面板里
// 什么都没记、**退不回来**（那正是 plan1 补上的承诺）。收进服务后：谁写都留痕，谁都退得回。
// 本模块**不 import electron**：回收站能力从外面注入（否则 CI 上跑不了单测）。

export interface WorkspaceWriteHooks {
  /**
   * 写前快照（检查点）。**必须在真正落盘之前**调用 —— 先记下原样，改坏了才有得退。
   * 不传 = 不记（单测 / 无检查点场景）。
   */
  beforeChange?: (rel: string, abs: string) => void
  /** 删除到回收站（生产注入 `shell.trashItem`，测试注入假实现） */
  trash: (abs: string) => Promise<void>
  /**
   * 路径放行策略（plan29 D-089）。**只有 Agent 线该传它**：
   * 界面线（`ipc` / `workspace-fs` / 预览协议 / git-info）各自直接调 `resolveInsideWorkspace`，
   * 不经本服务，也就天然拿不到这个策略 —— 这正是我们要的分界。
   * 不传 = 锁死（fail-closed）。
   */
  pathAccess?: PathAccess
}

export interface WorkspaceWriter {
  /** 工作区根（工具层也要用，一并带上，省得两处各传一份） */
  root: string
  /**
   * 是否允许越过工作区边界（plan29 D-089）。
   * 暴露出来的唯一用途：工具层据此在结果里**提示"这是界外路径"并给出绝对路径** ——
   * 既然选择不拦，就必须让人**看得见它出了界**。工具层不该自己去重算一遍策略。
   */
  allowsOutside: boolean
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
    const resolved = resolvePathInWorkspace(workspaceRoot, rel, hooks.pathAccess)
    if (!resolved) throw new Error(`路径「${rel}」越出工作区边界，已拒绝`)
    return resolved.abs
  }

  /**
   * 界外改动的**免责说明**，追加到写入结果里（plan29 D-089 决议 2 的延伸）。
   *
   * 为什么非要说这一句：检查点（`store/checkpoints.ts`）**自己保留着工作区边界** ——
   * 界外的目标它一条都不记（这是有意的：回滚由界面触发，让界面能写工作区外就等于界面越权）。
   * 于是 full-access 下出现一个**不对称**：能改，但**退不回来**。
   *
   * 不对称本身可以接受（"无边界"是用户选的），**但沉默不行** ——
   * 用户看到"已写入"却以为这本回滚里躺得回来，等真改坏了才发现没有那条记录，那才是真坑。
   * 所以：能改就如实说能改，退不回来也如实说退不回来。
   */
  const outsideNote = (abs: string): string =>
    hooks.pathAccess?.allowOutside === true && !isInside(workspaceRoot, abs)
      ? ' ※ 该文件在工作区外，**不在本轮回滚覆盖范围内**'
      : ''

  return {
    root: workspaceRoot,
    allowsOutside: hooks.pathAccess?.allowOutside === true,

    async write(rel, content) {
      const abs = absOf(rel)
      hooks.beforeChange?.(rel, abs)
      // 父目录不存在则自动创建（调用方不该为 mkdir 单独跑一趟）
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return `已写入 ${rel}（${Buffer.byteLength(content, 'utf8')} 字节）${outsideNote(abs)}`
    },

    async mkdir(rel) {
      const abs = absOf(rel)
      hooks.beforeChange?.(rel, abs)
      await mkdir(abs, { recursive: true })
      return `已创建目录 ${rel}${outsideNote(abs)}`
    },

    async rename(rel, nextRel) {
      const from = absOf(rel)
      const to = absOf(nextRel)
      // ⚠️ 目标已存在 → **拒绝**，不静默覆盖。
      //    `fs.rename` 在 POSIX 与 Windows 上都会**直接替换**已存在的目标（Windows 走
      //    MoveFileEx + REPLACE_EXISTING）—— 用户只是改个名，就把另一个文件悄悄冲掉了：
      //    不报错、不进回收站、退不回来。与 `write` 的"外部冲突"同一条原则：**不许静默覆盖**。
      if (existsSync(to)) throw new Error(`目标「${nextRel}」已存在，未做改动（不会覆盖已有文件）`)
      // 源与目标**都要**快照：源会消失（记 modified → 回滚写回原位），目标可能被覆盖
      // （原本不存在则记 created → 回滚删掉它）。两条合起来，回滚后正好回到 rename 之前。
      hooks.beforeChange?.(rel, from)
      hooks.beforeChange?.(nextRel, to)
      await mkdir(dirname(to), { recursive: true })
      await renameFs(from, to)
      return `已重命名 ${rel} → ${nextRel}${outsideNote(from) || outsideNote(to)}`
    },

    async remove(rel) {
      const abs = absOf(rel)
      hooks.beforeChange?.(rel, abs)
      await hooks.trash(abs)
      return `已删除 ${rel}（已移入回收站）${outsideNote(abs)}`
    },

    async copyIn(sourceAbs, rel) {
      const wanted = absOf(rel)
      const info = await stat(sourceAbs)
      if (!info.isFile()) throw new Error('目前只支持拖入文件（文件夹请逐个拖入）')
      // **不覆盖**已有文件：同名时自动加序号 —— 拖同一个文件两次很常见，静默覆盖会白白丢内容
      const to = await uniquePath(wanted)
      const finalRel = to === wanted ? rel : relative(workspaceRoot, to).replace(/\\/g, '/')
      hooks.beforeChange?.(finalRel, to)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(sourceAbs, to)
      const renamed = to === wanted ? '' : `（同名文件已存在，另存为 ${finalRel}）`
      return `已导入 ${finalRel}（${info.size} 字节）${renamed}${outsideNote(to)}`
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
  throw new Error('同名文件过多（已有 1000 个），请先清理目标目录')
}
