import { resolve } from 'node:path'
import {
  isSafeRel,
  selectChanges,
  type RevertHunkInput,
  type RevertHunkResult
} from '@shared/checkpoint'
import { computeHunks, revertHunk } from '@shared/text-diff'
import type { CheckpointStore } from './store/checkpoints'

// 逐处退回（plan13 批 B · B4）—— 把"三道闸"从 IPC handler 里搬出来，让它**可单测**。
//
// 这段逻辑守的是"往用户的文件里写东西"，原先长在 import 了 electron 的 `src/main/ipc.ts` handler 里
// —— CI 上没有 Electron 二进制、跑不了，于是整段逻辑（mtime 安全阀、`created`/截断两道挡、
// 块序号对齐）**一条测试都没有**，而那道 mtime 阀是唯一防"点了第 2 处、改掉第 N 处"的东西
// （审查原话："把它删掉，所有测试仍然全绿"）。抽出来后依赖全部注入，可用**真实临时目录**端到端测。

export interface RevertDeps {
  store: CheckpointStore
  /**
   * ⚠️ 必须和"那一轮自己记下的工作区"一致，否则拒绝 —— 见下面 `other-workspace`。
   * 检查点目录是全局的（`userData/checkpoints`），列表里会有**别的工作区**的轮次；
   * 拿当前工作区去拼那些轮次的 rel，会读到同名的**另一个文件**。
   */
  workspaceRoot: string
  /** 读当前文件内容（生产注入 `readWorkspaceFile`；读不到返回 `null`） */
  readCurrent: (
    rel: string
  ) => Promise<{ content: string; mtimeMs?: number; truncated?: boolean; lossy?: boolean } | null>
  /**
   * 写盘。**必须**是统一写入服务（含写前快照），不许是裸 `writeFile` ——
   * 那样这次退回自己就不留痕迹，用户退错了就再也回不去。
   */
  writeThrough: (rel: string, content: string) => Promise<string>
}

/**
 * 两个路径是不是同一个地方（Windows 大小写不敏感，尾部分隔符也归一）。
 * **导出**是为了让 `checkpoint:sides` 用同一份判据 —— 两套判据迟早分岔。
 */
export function samePath(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * 把「第 N 处」退回。**顺序就是安全顺序，别调换**：
 * ① 入参与路径（越界 / 缺字段先挡住）→ ② 轮次与文件在不在那一轮的记录里 → ③ **工作区一致性**
 * （不一致就拒绝，否则会写进另一个工作区的同名文件）→ ④ 快照侧可用性（`created` 没有改前内容、
 * 备份可能已被清理）→ ⑤ 当前侧可用性 + **mtime 安全阀** → ⑥ 算差异 → 退 → 写盘（走统一写入服务）。
 */
export async function revertOneHunk(
  deps: RevertDeps,
  input: RevertHunkInput
): Promise<RevertHunkResult> {
  const { runId, rel, hunkIndex, expectedMtimeMs } = input

  // ① 路径安全：rel 会被用来拼磁盘路径（与回滚同一道防线）
  if (!isSafeRel(rel)) return { ok: false, reason: 'bad-rel' }

  // ② 这一轮里有没有这个文件
  const run = deps.store.get(runId)
  if (!run) return { ok: false, reason: 'run-missing' }
  const change = selectChanges(run.changes, rel)[0]
  if (!change) return { ok: false, reason: 'not-recorded' }

  // ③ 工作区一致性（这条是"静默改错文件"的唯一拦路者）
  if (!samePath(run.workspace, deps.workspaceRoot)) {
    return { ok: false, reason: 'other-workspace' }
  }

  // ④ 快照侧
  if (change.kind === 'created') return { ok: false, reason: 'created' }
  const snap = deps.store.readBackup(runId, rel)
  if (!snap.ok) {
    return { ok: false, reason: snap.reason === 'created' ? 'created' : 'backup-missing' }
  }
  if (snap.truncated) return { ok: false, reason: 'truncated' }
  // **有损解码**：文件不是合法 UTF-8 → 退回会把整份内容按 UTF-8 重写，没被退的那几行也一起烂掉，
  // 而且**不可逆**（见 RevertFailReason.lossy-encoding）
  if (snap.lossy) return { ok: false, reason: 'lossy-encoding' }

  // ⑤ 当前侧 + mtime 安全阀
  const cur = await deps.readCurrent(rel)
  if (!cur) return { ok: false, reason: 'missing-current' }
  if (cur.truncated === true) return { ok: false, reason: 'truncated' }
  if (cur.lossy === true) return { ok: false, reason: 'lossy-encoding' }
  // ⚠️ **精确比较，不留容差**（审查指出）：两边是**同一个 double**（界面看到的就是这里读出来、
  //    经 JSON 无损往返过的值），所以任何差异都意味着"文件被改过"。留 1ms 容差只换来一个窄窗口
  //    —— 恰好落在那一瞬间的写入会让块序号指向**另一块**，而 `applyPatch` 会在它自己声明的偏移处
  //    找到精确匹配 → **静默退错**。（「保存」那条留容差是另一回事：它比的是编辑器打开时的历史值。）
  if (cur.mtimeMs === undefined || cur.mtimeMs !== expectedMtimeMs) {
    return { ok: false, reason: 'changed-on-disk' }
  }

  // ⑥ 算 → 退 → 写
  const diff = computeHunks(snap.content, cur.content)
  const outcome = revertHunk(cur.content, diff, hunkIndex)
  if (!outcome.ok) return { ok: false, reason: outcome.reason }

  const message = await deps.writeThrough(rel, outcome.text)
  return { ok: true, rel: change.rel, hunkIndex, message }
}
