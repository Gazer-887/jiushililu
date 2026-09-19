import { readdirSync } from 'node:fs'
import { exec } from 'node:child_process'
import type { AgentTool } from '@shared/agent'
import { statusText } from '@shared/background'
import { buildSearchSpec, SearchQueryError } from '@shared/search-query'
import { runSearch, renderSearchOutcome } from '../../retrieval/search'
import type { BackgroundTaskStore } from '../background-tasks'
import { resolvePathInWorkspace, type PathAccess } from '../guard'
import { createShellSession, type AgentShellSession, type RuntimeEnv } from './shell-session'

// 系统类工具（P1 工具层补全）：列目录 / 文本搜索 / 命令执行。
// 前三者默认只在 workspaceRoot 内活动，跳过依赖与构建产物目录。
// ⚠️ 这个「内」是**默认**，不是绝对约束（plan29 D-089）：「完全访问」档在 **Agent 线**上无边界，
//    此时 `pathAccess.allowOutside` 为 true，界外路径**放行但如实回显绝对路径**（决议 2）。
//    界面线的文件访问不受档位影响，分界见 `guard.ts` 的 `PathAccess` 注释。
// ⚠️ run_command 是高危工具：**内核默认工具集不含它**，自定义 Agent 显式声明才下发；
// 而可写档下每次执行前还要**逐次确认**（plan8 R5，确认钩子由组合根注入）。
// 限时与输出上限见 DEFAULT_COMMAND_TIMEOUT_MS / MAX_COMMAND_OUTPUT（plan28 D-086/D-088 起可调、且失败**分型**）；cwd 锁工作区。
//
// ⚠️ `search_files` 是 **L0 检索**（plan3/plan4）：走 `main/retrieval/` —— **优先 ripgrep**，
//    找不到/跑不动才降级到内置扫描器，且**降级这件事会写在返回值里**（不然"搜不到"与"没搜"同形）。

const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_RESULTS = 200
/**
 * 前台命令的输出上限（plan28 D-088）。
 *
 * ⚠️ 这里从 1MB 提到 8MB，是**有意的取舍**：`exec` 一旦超限就会**杀掉子进程**（命令并没有跑完），
 * 所以"打到上限"这件事本身就该罕见 —— 上限太低，`npm install` 之类的正常输出会**频繁**撞上它，
 * 于是"命令被我们掐了"被误读成"命令失败了"。调高上限 + 把超限如实报出来，两件事一起做才成立。
 */
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024
/** 前台命令默认超时（plan28 D-086）。30s 对 `npm install` / `npm test` / `build` 必然不够 —— 这是从 Claude Code 的 `BASH_DEFAULT_TIMEOUT_MS` 借来的口径 */
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** 模型可以传的上限：再长就该走后台（`background: true`），前台干等只会把整轮对话卡住 */
const MAX_COMMAND_TIMEOUT_MS = 600_000
/** 下限：1000ms 以下基本是笔误（想"快速探一下"用不着 200ms，真跑不完的命令也不是靠它救） */
const MIN_COMMAND_TIMEOUT_MS = 1_000

/**
 * 危险操作确认钩子（plan8 R5）：注入式回调 —— 工具层不需要知道确认从哪来（主进程弹窗 / 测试直接给答案），
 * 也让 CI 无 Electron 时照样能测。不传 = 不确认（保持旧行为，测试与 CLI 场景需要）。
 */
export type CommandConfirm = (command: string) => Promise<boolean>

export function createSystemTools(
  workspaceRoot: string,
  background?: BackgroundTaskStore,
  agentLabel = '内核',
  resourcesPath?: string | null,
  pathAccess?: PathAccess,
  resolveRuntimeEnv?: () => RuntimeEnv
): AgentTool[] {
  return buildSystemTools(workspaceRoot, undefined, background, agentLabel, resourcesPath, pathAccess, resolveRuntimeEnv)
}

export function createSystemToolsWithConfirm(
  workspaceRoot: string,
  confirm: CommandConfirm,
  background?: BackgroundTaskStore,
  agentLabel = '内核',
  resourcesPath?: string | null,
  pathAccess?: PathAccess,
  resolveRuntimeEnv?: () => RuntimeEnv
): AgentTool[] {
  return buildSystemTools(workspaceRoot, confirm, background, agentLabel, resourcesPath, pathAccess, resolveRuntimeEnv)
}

function buildSystemTools(
  workspaceRoot: string,
  confirm: CommandConfirm | undefined,
  background: BackgroundTaskStore | undefined,
  agentLabel: string,
  resourcesPath?: string | null,
  pathAccess?: PathAccess,
  resolveRuntimeEnvIn?: () => RuntimeEnv
): AgentTool[] {
  /** plan43 S3：默认"无覆盖" —— 未配置开发环境时行为与从前**逐字一致**（不注入、指纹为空） */
  const resolveRuntimeEnv: () => RuntimeEnv =
    resolveRuntimeEnvIn ?? (() => ({ pathOverride: undefined, fingerprint: '' }))
  /**
   * 前台命令的**持久 shell 会话**（plan28 D-085 S2）：工具集实例 = 一个 agent run，
   * 轮与轮之间 `cd` / `set` / 环境激活**跨步存活**；新 run 从工作区根重新开始（可预测性优先）。
   * 空闲 10 分钟自动回收（含进程树清理）、同活上限 4 个（LRU）—— 长驻泄漏由这两道闸兜住。
   *
   * plan43 S3：起壳时带上**当前运行环境**（PATH 覆盖 + 指纹）。指纹的用法见下 `getShell`。
   */
  let shell: AgentShellSession | null = null
  const getShell = (): AgentShellSession => {
    const runtime = resolveRuntimeEnv()
    // ⚠️ 这段比对在当前设计下**不会触发** —— 因为 `runner.ts` 在 **run 开始时**求值一次，
    //    同一个工具集实例内 `runtime` 恒定（而 `shell` 是本实例的局部变量，新 run 必然是 null）。
    //    **它保留是防御，不是功能**：万一将来有人把 `resolveRuntimeEnv` 又改回"每次现读"，
    //    这里会立刻兜住"环境变了却不换壳"的漂移。**不要把它的存在误解成"每命令都会换壳"** ——
    //    那正是 2026-09-19 复查抓到的口径错误（同一 run 内换环境 = 破坏可复现性）。
    if (shell && shell.envFingerprint !== runtime.fingerprint) {
      shell.dispose()
      shell = null
    }
    shell ??= createShellSession(workspaceRoot, undefined, runtime)
    return shell
  }
  /**
   * 解析一次，拿到**绝对路径**与**越界提示**（plan29 D-089 决议 2，与 `file-tools` 同手法）。
   * 界外被放行时用户唯一的保障就是"看得见它出了界"，故提示与解析一起算，不在各工具里各判一遍。
   */
  const locate = (rel: string): { abs: string; note: string; outside: boolean } | null => {
    const r = resolvePathInWorkspace(workspaceRoot, rel, pathAccess)
    if (!r) return null
    return { abs: r.abs, outside: r.outside, note: r.outside ? `【工作区外：${r.abs}】\n` : '' }
  }

  /**
   * 档位说明追加到描述里：反正是"完全访问"，就别让模型还按"我只能看工作区"来猜——
   * 否则这套能力要靠它撞一次错误才发现，等于没做。反之（锁死档）不加，避免暗示它越界是可以试的。
   */
  const scopeHint =
    pathAccess?.allowOutside === true ? '（当前为完全访问档，工作区外的路径也可指定，越界会在结果里标注绝对路径）' : ''

  const list_dir: AgentTool = {    schema: {
      name: 'list_dir',
      description: '列出工作区内某个目录的内容（名称 + 类型）' + scopeHint,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根的目录路径，缺省为根' }
        }
      }
    },
    async execute(args) {
      const rel = typeof args['path'] === 'string' ? args['path'] : '.'
      const located = locate(rel)
      if (!located) return `错误：路径「${rel}」越出工作区边界，拒绝列出`
      try {
        const entries = readdirSync(located.abs, { withFileTypes: true })
        if (entries.length === 0) return `${located.note}（空目录）`
        const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
          const kind = e.isDirectory() ? '[目录]' : '[文件]'
          return `${kind} ${e.name}`
        })
        const more = entries.length > MAX_LIST_ENTRIES ? `\n（其余 ${entries.length - MAX_LIST_ENTRIES} 项省略）` : ''
        return located.note + lines.join('\n') + more
      } catch (err) {
        return `错误：列出失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const search_files: AgentTool = {
    schema: {
      name: 'search_files',
      description:
        '在工作区内做文本搜索，返回"文件:行号: 行内容"（L0 检索，优先 ripgrep）。' +
        '默认按**字面量**匹配、不区分大小写。需要模式匹配时把 regex 设为 true（如 `function\\s+\\w+`）；' +
        '需要精确大小写时把 caseSensitive 设为 true。默认尊重 .gitignore、跳过依赖与构建产物目录。' +
        scopeHint,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的内容（不能含换行；字面量模式就是"要找的那串字符"）' },
          path: { type: 'string', description: '搜索起点（相对工作区根），缺省为根' },
          regex: { type: 'boolean', description: 'true = 把 query 当正则解释；默认 false（字面量）' },
          caseSensitive: { type: 'boolean', description: 'true = 区分大小写；默认 false' }
        },
        required: ['query']
      }
    },
    async execute(args) {
      const baseRel = typeof args['path'] === 'string' ? args['path'] : '.'
      const located = locate(baseRel)
      if (!located) return `错误：路径「${baseRel}」越出工作区边界，拒绝搜索`
      const base = located.abs

      let spec: ReturnType<typeof buildSearchSpec>
      try {
        spec = buildSearchSpec({
          query: typeof args['query'] === 'string' ? args['query'] : '',
          regex: args['regex'] === true,
          caseSensitive: args['caseSensitive'] === true
        })
      } catch (err) {
        // 坏正则/空查询在这里就变成人话 —— 不留到执行期（不同后端报错不同，会变成"同一查询两种结果"）
        if (err instanceof SearchQueryError) return `错误：${err.message}`
        throw err
      }

      try {
        const outcome = await runSearch({
          // 检索起点在界外时，把**它自己**当作展示基准：命中在界外没有"相对工作区"的合理写法
          // （`relative()` 会渲染成一串 `../../`，既不可点也没有信息量）。界内的行为一字未改。
          workspaceRoot: located.outside ? base : workspaceRoot,
          basePath: base,
          spec,
          maxResults: MAX_SEARCH_RESULTS,
          resourcesPath: resourcesPath ?? null
        })
        return located.note + renderSearchOutcome(outcome, spec)
      } catch (err) {
        return `错误：搜索失败——${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  const run_command: AgentTool = {
    schema: {
      name: 'run_command',
      description:
        `在工作区根执行一条 shell 命令。命令跑在**持久会话**里：本轮任务内 cd / 环境变量 / 环境激活（如 activate）跨调用保留，` +
        `要回到工作区根请显式 cd 回去。前台：默认限时 ${DEFAULT_COMMAND_TIMEOUT_MS / 1000}s（可用 timeoutMs 放宽，` +
        `上限 ${MAX_COMMAND_TIMEOUT_MS / 1000}s）、输出超 ${MAX_COMMAND_OUTPUT / 1024 / 1024}MB 会被终止（会话作废重开）；` +
        '设 background=true 则转**后台**执行（立即返回任务 id，用 check_command 查看输出与状态）——' +
        '构建、起服务、下载这类耗时的活该用后台。' +
        '装依赖 / 跑测试 / 构建这类通常超过默认限时的命令，请显式传 timeoutMs。' +
        '高危工具：仅在明确需要时使用。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          background: {
            type: 'boolean',
            description: 'true = 后台执行（适合耗时的活）；默认 false 前台执行'
          },
          timeoutMs: {
            type: 'number',
            description: `前台执行的超时毫秒数（默认 ${DEFAULT_COMMAND_TIMEOUT_MS}，允许 ${MIN_COMMAND_TIMEOUT_MS}~${MAX_COMMAND_TIMEOUT_MS}）；超时后命令会被终止并如实回报`
          }
        },
        required: ['command']
      }
    },
    async execute(args) {
      const command = typeof args['command'] === 'string' ? args['command'] : ''
      if (command.trim().length === 0) return '错误：command 不能为空'

      // 超时口径（plan28 D-086）：越界**拒绝并回报**，不静默夹取 ——
      // 静默夹取会让模型以为"我设了 5 分钟"，实际 30 秒就断了，然后它按"命令失败了"往下推理。
      let timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
      const rawTimeout = args['timeoutMs']
      if (rawTimeout !== undefined && rawTimeout !== null) {
        const n = typeof rawTimeout === 'number' ? rawTimeout : Number(rawTimeout)
        if (!Number.isFinite(n)) {
          return `错误：timeoutMs 必须是数字，收到 ${JSON.stringify(rawTimeout)}`
        }
        if (n < MIN_COMMAND_TIMEOUT_MS || n > MAX_COMMAND_TIMEOUT_MS) {
          return (
            `错误：timeoutMs=${n} 超出允许范围（${MIN_COMMAND_TIMEOUT_MS}~${MAX_COMMAND_TIMEOUT_MS} 毫秒）。` +
            `需要更长时间请用 background=true 转后台执行。`
          )
        }
        timeoutMs = Math.floor(n)
      }

      // 逐次确认（plan8 R5）：命令是任意文本，静态规则判不全危险与否 —— 与其猜，不如把原文摊给用户看一眼。
      // **后台同样确认**（用户 2026-09-12 敲定的边界之一）—— 安全不因为"后台"打折。
      if (confirm) {
        const allowed = await confirm(command)
        if (!allowed) {
          return '错误：用户拒绝执行该命令。请改用其它方式完成任务，或向用户说明为何需要执行它。'
        }
      }

      if (args['background'] === true) {
        if (!background) return '错误：当前环境不支持后台执行，请去掉 background 参数'
        try {
          // plan43 S3：后台与前台**同源**用同一个运行环境（否则会出现"前台用 3.12、后台用系统默认"的分歧）
          const runtime = resolveRuntimeEnv()
          const task = background.start({
            command,
            cwd: workspaceRoot,
            agent: agentLabel,
            ...(runtime.pathOverride !== undefined
              ? { env: { ...process.env, PATH: runtime.pathOverride } }
              : {})
          })
          return `已在后台启动：${task.id}\n命令：${command}\n用 check_command 查看输出与状态。`
        } catch (err) {
          return `错误：${err instanceof Error ? err.message : String(err)}`
        }
      }

      const startedAt = Date.now()
      const r = await getShell().run(command, timeoutMs)
      // 会话起不来（spawn 失败的怪环境）→ 回落一次性 exec，能力不打折
      if (r.spawnError !== null) {
        return await new Promise<string>((resolvePromise) => {
          exec(
            command,
            { cwd: workspaceRoot, timeout: timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true },
            (error, stdout, stderr) => {
              const out = stdout.toString()
              const errText = stderr.toString()
              const elapsed = Date.now() - startedAt
              if (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                  const mb = Math.round(MAX_COMMAND_OUTPUT / 1024 / 1024)
                  resolvePromise(
                    `命令输出超过 ${mb}MB 上限，**已被终止**（这不是命令本身失败——是我们的输出上限掐的）。\n` +
                      `以下是终止前收到的前 ${mb}MB：\n[stdout]\n${out}${errText ? `\n[stderr]\n${errText}` : ''}\n` +
                      `（建议：把输出重定向到文件（如 \`... > build.log 2>&1\`）再分段读取，或改用 background=true）\n` +
                      `exit_code=null error_class=output_exceeded elapsed_ms=${elapsed}`
                  )
                  return
                }
                const errSignal = (error as { signal?: NodeJS.Signals | null }).signal ?? null
                const timedOut =
                  (error as { killed?: boolean }).killed === true &&
                  errSignal !== null &&
                  elapsed >= timeoutMs - 100
                if (timedOut) {
                  resolvePromise(
                    `命令超时（${timeoutMs}ms）已终止，**不代表命令失败**——可能只是没跑完。\n` +
                      `已收到的部分输出：\n[stdout]\n${out}${errText ? `\n[stderr]\n${errText}` : ''}\n` +
                      `（需要更长时间请传更大的 timeoutMs，上限 ${MAX_COMMAND_TIMEOUT_MS}ms；或改用 background=true 转后台）\n` +
                      `exit_code=null error_class=timeout elapsed_ms=${elapsed}`
                  )
                  return
                }
                const exitCode = typeof error.code === 'number' ? error.code : null
                resolvePromise(
                  `命令执行出错（exit=${error.code ?? '?'}）\n[stdout]\n${out}\n[stderr]\n${errText}\n` +
                    `exit_code=${exitCode ?? 'null'} error_class=error elapsed_ms=${elapsed}`
                )
                return
              }
              resolvePromise(
                `[stdout]\n${out}${errText ? `\n[stderr]\n${errText}` : ''}\n` +
                  `exit_code=0 error_class=ok elapsed_ms=${elapsed}`
              )
            }
          )
        })
      }

      const elapsed = r.elapsedMs
      if (r.exceeded) {
        // plan28 D-088：超限不是命令失败，如实分型。会话已被掐掉重开（与旧行为"超限即杀"同语义）
        const mb = Math.round(MAX_COMMAND_OUTPUT / 1024 / 1024)
        return (
          `命令输出超过 ${mb}MB 上限，**已被终止**（这不是命令本身失败——是我们的输出上限掐的）。\n` +
            `以下是终止前收到的前 ${mb}MB：\n[stdout]\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}\n` +
            `（建议：把输出重定向到文件（如 \`... > build.log 2>&1\`）再分段读取，或改用 background=true）\n` +
            `exit_code=null error_class=output_exceeded elapsed_ms=${elapsed}`
        )
      }
      if (r.timedOut) {
        return (
          `命令超时（${timeoutMs}ms）已终止，**不代表命令失败**——可能只是没跑完。\n` +
            `已收到的部分输出：\n[stdout]\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}\n` +
            `（需要更长时间请传更大的 timeoutMs，上限 ${MAX_COMMAND_TIMEOUT_MS}ms；或改用 background=true 转后台）\n` +
            `exit_code=null error_class=timeout elapsed_ms=${elapsed}`
        )
      }
      if (r.exitCode !== 0 && r.exitCode !== null) {
        return (
          `命令执行出错（exit=${r.exitCode}）\n[stdout]\n${r.stdout}\n[stderr]\n${r.stderr}\n` +
            `exit_code=${r.exitCode} error_class=error elapsed_ms=${elapsed}`
        )
      }
      return (
        `[stdout]\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}\n` +
          `exit_code=${r.exitCode ?? 0} error_class=ok elapsed_ms=${elapsed}`
      )
    }
  }

  const check_command: AgentTool = {
    schema: {
      name: 'check_command',
      description: '查看后台任务的输出与状态。不传 id 则列出全部后台任务。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id（如 bg-1）；不传则列出全部' }
        }
      }
    },
    async execute(args) {
      if (!background) return '错误：当前环境不支持后台任务'
      const id = typeof args['id'] === 'string' ? args['id'].trim() : ''
      if (!id) {
        const list = background.list()
        if (list.length === 0) return '（当前没有后台任务）'
        return list.map((t) => `${t.id}  [${statusText(t)}]  ${t.command}`).join('\n')
      }
      const t = background.get(id)
      if (!t) return `错误：没有 id 为 ${id} 的后台任务`
      const tail = t.truncated ? '\n（输出过长，只保留了末尾部分）' : ''
      return `任务 ${t.id} —— ${statusText(t)}\n命令：${t.command}\n[输出]\n${
        t.output || '（暂无输出）'
      }${tail}`
    }
  }

  const kill_command: AgentTool = {
    schema: {
      name: 'kill_command',
      description: '终止一个还在运行的后台任务（会连同它拉起的子进程一起停）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id' } },
        required: ['id']
      }
    },
    async execute(args) {
      if (!background) return '错误：当前环境不支持后台任务'
      const id = typeof args['id'] === 'string' ? args['id'].trim() : ''
      if (!id) return '错误：缺少 id'
      return background.kill(id) ? `已终止 ${id}` : `错误：${id} 不存在或已经结束`
    }
  }

  // check / kill 只在**有后台能力时**下发 —— 没 store 的场景（单测、CLI）多两个空工具没意义
  return background
    ? [list_dir, search_files, run_command, check_command, kill_command]
    : [list_dir, search_files, run_command]
}
