# 工具层与治理

工具层怎么起进程、怎么收输出、谁有权碰什么；治理层怎么在"模型说要执行"与"真的执行"之间插一道人。
这里只写**为什么这么切**与**切错的后果**；参数形状看源码，历史与理由看 `NOTEBOOK/decisions.md`。

## 共享 shell 会话

媒体权限由 [[src/main/media-permissions.ts#installMediaPermissions]] 安装在真实session，request/check共用已登记主窗口对象、主frame、精确renderer入口和当前语音配置/披露资格。远程view即使同session或同URL字符串也不继承资格，未知frame/媒体类型与视频拒绝。关资格只拒绝新申请，不承诺替renderer停止已获的音轨；现有语音组件负责停止track。

[[src/main/providers/errors.ts#mapHttpError]] 和 [[src/main/providers/errors.ts#ProviderError]] 对HTTP错误只公开状态和固定说明，不将截断正文视为脱敏。中心错误边界覆盖聊天和一次性任务catch，两出口必须都验证；原始body/cause不进入HTTP错误message。非HTTP本地错误与状态0的流式超时仍保留原层级解释，不为安全化丢掉可排查性。

一个 agent run 共用一个常驻壳（[[src/main/agent/tools/shell-session.ts#createShellSession]]），因为每条命令冷启一个 shell
会让 `cd` / 环境变量 / 环境激活**全都不跨命令存活** —— 那是这类实现最大的坑。代价是同壳上的命令**必须串行**。

"命令跑完了"由协议判定，不由进程判定：命令与回声标记一起喂进 stdin，标记带单调序号与上一行退出码，
序号在会话内自增，模型写不出这个串也就伪造不出"我跑完了"。Windows 的两处输出噪音都在会话内清洗
（cmd.exe 的版本 banner 在握手阶段丢弃；提示符压不住，就把它设成本会话唯一的串再全局剥除）。

不接用户的交互终端，是因为那是 pty + 流控 + ACK 背压、**会话属于用户**：agent 的命令混进去既污染用户视图，
也没有"这一条跑完了"的边界。故这里是专用非交互会话，边界与后台任务一样硬。

串行落在 [[src/main/agent/tools/shell-session.ts#AgentShellSessionImpl#run]]：它把每条命令挂在上一条之后。
并发调用会往同一个 stdin 写、往同一个 stdout 收 —— A 收到 B 的输出；更糟的是 B 超时时的
[[src/main/agent/tools/shell-session.ts#AgentShellSessionImpl#killShell]] 会把 A 正在跑的壳一起杀掉。
计时起点在 [[src/main/agent/tools/shell-session.ts#AgentShellSessionImpl#runNow]] 而不是排队处：
把排队时间算进超时，长队列后面的每一行都会被误判成超时。

一个 run 一个壳这件事由 [[src/main/agent/tools/system-tools.ts#ShellSlot]] 承载，而不是"一个工具实例一个壳"——
命令工具实例会按确认卡的发起者各造一份（见下文），按实例计就会让同一个 run 里出现 1+N 个常驻壳，
直接撞上同活上限。槽位共享后壳数与实例数解耦，`cd` 跨步存活的语义一字未变。

## 上限淘汰那条闸的真实口径

⚠️ 这条闸的实际口径比它的用途更粗：**按构造顺序 FIFO，不是 LRU**，且淘汰**不看目标是否正在执行命令**。
现口径以 [[src/main/agent/tools/shell-session.ts#enforceCap]] 为准（同文件头注释同一条），改动它属独立决策。

`liveSessions` 是 `Set`，而 `Set.add` 不会把已存在的元素挪到末尾 —— 所以"这条会话刚被用过"根本不影响
它在队列里的位置，取 `values().next()` 拿到的就是**最早构造**的那一个。又因为淘汰走 `dispose()`（连同进程树杀掉），
被挤掉的完全可能是用户刚批准、此刻正在跑的那条命令。症状不是报错，是"命令莫名中断"，事后无从归因。

之所以很少撞到：一个 run 只占一格，触发条件是同时挂着超过上限数目的活壳、且最早那个还在跑。
空闲回收（`IDLE_MS`）与活会话上限（`MAX_LIVE_SESSIONS`）两道闸各防一头：前者防**长驻不退出**
（run 结束不显式收尾，壳与它的管道就一直挂着），后者防**并发无界**。两道闸都不依赖调用方记得收尾。

真要改成"用过即置新"或"不杀在跑的"，缺的是同一处一个"本格正在执行"的状态位，以及并发用例
（现有用例都是单条命令跑完再跑下一条，罩不到这条路径）；注释与实现必须同批改，不许注释先行。

常驻壳的 stdio 全部 `unref()`：未 unref 的子进程管道是活动句柄，会把任何等待自然退出的宿主钉住
（vitest worker 尤其如此）。会话的回收因此只由空闲定时器与活会话上限负责，不靠句柄计数；
生产路径不在 run 结束时显式清理，测试用 [[src/main/agent/tools/shell-session.ts#disposeAllShellSessions]] 做全局收尾。

## 杀进程树

命令是经 shell 起的，直接子进程只是那层壳：只杀壳，它拉起的孙进程原地存活，
占着端口、继续往已经没人读的管道里吐字节。全项目因此只有一份实现，[[src/main/process-tree.ts#killProcessTree]]
被常驻 shell、用户终端、后台任务三处共用 —— 两套"怎么算杀干净"的判据迟早分岔，而且分岔的表现是留孤儿，不是报错。

Windows 走 `taskkill /pid <pid> /T /F`，数组参数、不经 shell，因此不受 Git Bash 把 `/F` 转成 `F:/` 那个坑的影响。
`/T` 省了就等于只杀壳；不许改用 `/IM <进程名>` —— 那是按名字杀，会连用户自己开的同名进程一起杀。
spawn 出去必须挂 `error` 监听器：Node 的语义是"`error` 无监听器就抛出"，而主进程里一个未捕获异常 = 应用没了。

⚠️ **不许解析 taskkill 的文本输出**：`SUCCESS:` / `ERROR:` 随系统语言本地化，中文系统上永远匹配不到，
于是"杀成功了"在中文机器上恒为假。只许看退出码，而退出码也只够用来判幂等（pid 不存在返回 128 = 已经没了 = 成功）。
它本身**不可信**：`taskkill /F` 返回 1、`Stop-Process -Force` 返回 4294967295，都与"命令自己失败"撞车。
所以"这条是被我们杀的"必须由**发起 kill 的一方**置位（shell 会话与后台任务各自记自己的 `timedOut` / `killed`），不许事后反推。

POSIX 用 `process.kill(-pid)`（负号 = 整个进程组），而这条路要求子进程是组长 —— 见
[[src/main/process-tree.ts#spawnOptsForGroupKill]]。少了 `detached: true` 的后果是"以为杀了整棵树、其实只杀了自己"，
且只在 Linux/CI 上暴露，Windows 开发机上验不到（这也是该函数把 `killFn` 留成可注入的理由）。

## 命令超时与失败分型

超时口径落在**一条命令**这一层（[[src/main/agent/tools/system-tools.ts#buildSystemTools]] 里那条命令工具的 `timeoutMs`），
整轮对话没有墙钟——本项目**刻意删掉了**那一层（`src/main/ipc.ts` 的会话发送路径与 `runner.ts` 的 `chat` 都留有删除理由）。

理由是整轮墙钟会把五种性质完全不同的情况压成同一个数字：请求发不出去 / 首包迟迟不来 / 吐了一半断流 /
工具跑得久 / 子代理在并行。任何一种慢都报成同一句话，用户按那句话去把数字调大，
代价是把本来正常的情况也一起等更久。拆开后各有归属且各自说清自己是哪一层：
模型侧由 [[src/main/providers/stream-guard.ts#createStreamGuard]] 的两层守卫（首包 / 分片间隔）负责，
其中**分片间隔是唯一能把"慢"与"真卡死"分开的指标**（还在来数据就是慢）；工具侧由命令自己的超时负责。
于是 `args.signal` 只剩一个语义：**用户点了停止** —— 该不该停整轮是人判断的，不该由代码替他猜一个数字。
被删掉的那两处里，一处是死代码（生产必给 signal，`??` 右侧永不执行），另一处即使生效也是错口径。

限时参数越界**拒绝并回报**，不静默夹取：夹取会让模型以为自己写的那个数生效了，实际按别的数断，
然后它按"命令失败了"往下推理 —— 一个被我们掐掉的命令就此变成一次真实失败。
同理，超时、输出超限、非零退出三态在返回文本里**分别定型**（`error_class` 一栏）。
默认限时（`DEFAULT_COMMAND_TIMEOUT_MS`）、允许区间（`MIN_COMMAND_TIMEOUT_MS` ~ `MAX_COMMAND_TIMEOUT_MS`）
与输出上限（`MAX_COMMAND_OUTPUT`）都写进工具描述，模型据此决定是传更大值还是转后台
（超出区间上限就该转，前台干等只会把整轮卡住；后台语义见
[[src/main/agent/background-tasks.ts#createBackgroundTaskStore]]）。
输出超限在会话层就把壳掐掉（见 [[src/main/agent/tools/shell-session.ts#AgentShellSessionImpl#runNow]] 的缓冲判据），
与"超限即终止"同语义 —— 半截输出留在一个还能用的壳里，比换个壳危险。

## 路径门控：Agent 线与界面线

[[src/main/agent/guard.ts#ToolGate#check]] 只回答一个问题："这个工具，当前这个 Agent 能不能用"。
路径越界是各工具自己的责任，两者不混在一道闸里 —— 混了就没人说得清一次拒绝是"没这个能力"还是"碰了界"。

档位只作用于 **Agent 线**：[[src/main/agent/guard.ts#PathAccess]] 是这条分界的载体，界面线的文件访问
（资源管理器 / 预览 / git-info）**绝不**读它。把两者一起放开，等于把用户报的"权限不足"换成"界面越权"这个更严重的问题，
而且那是他从没要求过的能力扩张。界面线因此一律走不含策略的 [[src/main/agent/guard.ts#resolveInsideWorkspace]]，
默认锁死是**刻意的 fail-closed**：新增调用点忘了传策略，得到的是更严而不是更松。

「完全访问」在 Agent 线上真的没有边界（[[src/main/agent/runner.ts#runAgent]] 里那一个三元赋值）。
在此之前它的实际语义只有"免确认弹窗"，文件仍被无条件锁在工作区内——用户称之为"假完全"，是准确描述。
放开之后唯一的保障是**看得见它出了界**：[[src/main/agent/guard.ts#ResolvedPath]] 的 `outside` 与解析同源算出，
由工具层在结果里回显绝对路径，上层不许自己再判一遍策略。

界内那一档防三类逃逸：相对路径 `../`、绝对路径直指界外、**符号链接伪装成界内** —— 最后一类只有拿真实路径比对才揭得穿，
见 [[src/main/agent/guard.ts#realpathDeepest]]（解析到最深的已存在祖先，因为待创建文件本身还不存在）。
`allowOutside` 下这一步刻意不做：那个比对的目的是"揭穿伪装成界内的界外路径"，而界外本来就允许时它没有意义。

## 权限档与确认卡

三件事各自独立，别指望其中一件替另一件兜底：**档位**决定能不能拿到工具
（[[src/main/agent/runner.ts#allowedToolsFor]]），**确认卡**决定这一次让不让跑
（[[src/main/confirm.ts#createConfirmBridge]]），**批准闸**决定这份方案要不要执行
（[[src/main/agent/plan-approval.ts#createPlanApprovalBridge]]）。

确认桥的三条决定：① **无人应答 = 拒绝** —— 超时、窗口已关、送不出去、渲染崩了统统按拒，
绝不能因为没等到答复就放行；② 请求带唯一 id、答复成对匹配，过期的响应直接忽略（否则旧答复能放行新请求）；
③ 桥**不知道**哪些工具危险，由 runner 决定何时调它。审批落地的打点也只能在桥这里做——
门控是纯白名单函数，埋不进事件流。桥的等待时长比批准闸短一个量级，因为"这条命令要不要跑"看一眼就能答，
"这份方案要不要执行"要读完一整篇；两者定成同一个数等于逼用户在没读完时随便点一个。

拒绝在**执行之前**生效：[[src/main/agent/tools/system-tools.ts#createSystemToolsWithConfirm]] 接到的确认钩子
要先等答复，命令才被喂进 stdin；拒了就只回一句错误文本给模型（它据此换路子或说明为什么需要），进程与磁盘都没被动过。
后台分支同样要确认 —— 安全不因为"转后台"打折。

**确认请求必须按发起者署名**，而只有组合根这一层知道发起者是谁：工具层拿到的标签是建实例时定格的字符串，
桥只知道 id 与超时，会话身份与 Agent 名都在它们上游。所以 [[src/main/agent/runner.ts#buildCommandTools]]
会为声明了 `run_command` 的子代理各造一份命令工具实例，把 [[src/main/agent/runner.ts#subagentToolNamesFor]]
算出的名字写进卡片与后台任务记录。复用主代理那一份的后果是：并发派发时几张卡全写着主代理的名字，
用户在错信息下点了"允许这一次"。装配拿不到该实例时**抛错而不是静默退回主代理那份** —— 退回就变回错的署名，
而这正是这段代码要修的东西。同一手法补的还有 `conversationId`（卡片要能归位到发起它的会话）。

可写与完全访问的**工具集相同**，差别只在高危工具要不要逐次确认；只读档另有一层读类白名单。
内核默认集不含高危工具，声明了才有 —— 而可写档的上限不再把高危滤掉：滤掉就成了"声明了也被档位压住"，
确认卡永远弹不出来，界面上却写着"执行命令仍需逐次授权"。高于权限档还有一道角色天花板：
带计划批准闸的 Agent 必须没有派发口，否则"先批准、后执行"会当场失效 —— 批准卡没弹，写操作已经经子代理落了盘。

## 检查点保护什么、回滚单位是什么

保护的是**这一轮开始之前**工作区的样子，回滚单位是**一个 agent run**（可缩到单文件）。
[[src/main/store/checkpoints.ts#createCheckpointStore]] 的 `begin` / `record` / `finish` 三段就是这个边界，
而快照挂在**统一写入服务**（[[src/main/workspace-write.ts#WorkspaceWriter]]）而不是文件工具上：
挂在工具上，界面自己写文件就绕过检查点 —— 用户用文件树删掉一个东西，回滚面板里什么都没记、退不回来。

顺序上有两处要紧：先校验 Agent 名再 `begin`（否则名字写错会留下一个永远停在 `running` 的空轮次）；
`begin` 早于建工具（否则写文件工具拿不到 recorder）。子代理复用同一批工具实例，因此它们的写同样记进本轮。

两条设计让**崩溃与中止也可回滚**：快照发生在写文件之前（最坏是多备份一个没改的文件，无害），
manifest **增量落盘**（小 JSON，换来中断的轮次仍有一份可用的清单）。所以 `finish` 必须在 `finally` 里——
不调用的后果不是丢数据，是界面把已经跑完的轮次显示成"中断"。清单侧的核心规则是**同一文件只记第一次**
（[[src/shared/checkpoint.ts#upsertChange]]）：一轮里模型会对同一文件写多次，覆盖备份就等于把"还原"变成
"还原成模型自己的中间产物"。回滚动作由 [[src/shared/checkpoint.ts#planRollback]] 从 `kind` 推出：
本轮新建的文件其"改前"状态是不存在，所以回滚它 = 删除；改过的写回快照。

动手回滚前先把**即将被覆盖的当前内容**另存为一轮：不留的话用户退错了就永远回不去。
一条都没备份成时必须返回 `null`，否则界面照样显示"已备份"、文案还在承诺"退错了还能再退"——
兜底静默消失而界面仍在承诺它。同理，回滚报告里有失败项时**不许**打"已回滚"标记，
面板上同时出现该徽章与"失败 N 个"是用户读得出的自相矛盾。还有两处静默失效要记住：
回滚一个仍在跑的轮次后必须保留它的活动登记（摘掉的后果是它后续每次写文件都不再进检查点，
而这是最难查的那种）；清理按 [[src/shared/checkpoint.ts#compareRunsNewestFirst]] 排序且**正在跑的那轮绝不删**
——上限的用意只是防无限增长，宁可暂时多留一轮。

`rel` 存的是相对路径、检查点目录却是全局的，于是列表里必然混着别的工作区的轮次：
拿"当前工作区"去拼就会读写**同名的另一个文件**，连 mtime 安全阀都拦不住（那是唯一会静默改错文件的路径）。
因此回滚与备份都用**那一轮自己记下的 workspace** 拼路径。manifest 还可能来自旧版本或被人工改过，
故 [[src/shared/checkpoint.ts#isSafeRel]] 与目录前缀比对两处各挡一遍，且 rel **两侧都归一**——
单侧归一的后果是"匹配不上"，回滚静默无事发生。删除走回收站而不是硬删；没有回收站能力时删除直接被拒。

逐处退回（[[src/main/revert-flow.ts#revertOneHunk]]）与整轮回滚共用同一批防线，另多两道块级判据：
mtime 与"界面读数"精确相等，且界面携带的**内容版本**（`CheckpointSides.currentRevision` →
`RevertHunkInput.expectedCurrentRevision`）与当前磁盘内容 SHA-256 一致。只比 mtime 时，
精度粗的文件系统或人工回拨的 utimes 会让"同 mtime 不同字节"骗过阀门 —— 块序号建立在界面看到的那份
内容上，放行的后果是**依据陈旧差异覆盖未知新内容**（2026-10-13 实测补第二道内容阀）。

整轮回滚另有自己的两道门位：回滚前的**逐目标**备份失败者不得被覆盖/删除（`snapshotCurrent` 报
`failed`、`rollback` 收 `exclude`），恢复源的**真实路径**必须仍在**受信 checkpoint 根**内 —— files 目录
被换成外部联接、或 manifest 的 backup 字段被改成越界名，都不得把外部内容当恢复源（Diff 预览取快照侧
同判）；`rolledBackAt` 只在 `failed` 与 `rejected` **都为空**时才打 —— 只标"干净地全部成功"。
真实路径走**严格解析**：只对 ENOENT 的尾部上溯，EACCES 等一律拒绝——吞掉解析错误会让边界检查退化成
字符串比较，恰好放过 junction 这类真实逃逸（2026-10-13 增量独审定点补）。上溯出的**未存在尾部必须挂在目录之下**：
最深的已存在祖先是普通文件时一律拒绝（`realpathDeepest` 与 `canonicalFilePath` 同口径）。否则"看似可创建"的目标
会走到写前登记之后才在 `mkdir` 失败，在检查点里留下一条本轮从未发生的 `created` —— 旧轮回滚随即会把后来人工建出的
同路径文件删掉，还报告恢复成功。

逐目标的**具体**失败原因必须在收尾前取：`record` 把原因记在轮次级 Map 里，而 `finish` 会清掉它
（不让全局记录无界增长）。所以 `snapshotCurrent` 要在 `finish` **之前**取一份局部快照 —— 取晚了就只剩
"当前内容备份失败"这句兜底话，用户永远看不出是权限、manifest 还是联接被拒。`rollback` 的 `exclude`
只收 rel 列表（公共签名不动），原因由 IPC 层按 rel 合并回报告（2026-10-19 首批安全读写）。

## 应用通信、协作写入与退出

[[src/main/trusted-ipc.ts#installTrustedIpc]] 将通信注册收在一个入口：已登记的窗口对象、主 frame 与准确页面三者缺一即拒绝。
事件型通信也经过同一入口；安全安装失败不降级开放。诊断只记录通道，不替代信任判据。

[[src/main/file-revision.ts#withFileCommit]] 按真实路径协调进程内提交；
[[src/main/workspace-write.ts#createWorkspaceWriter]] 在排队后和快照后重新核内容版本、路径身份。
界面保存携带读取版本，Agent 整文件覆盖沿用读取版本；精确修改携带本次源内容版本。
版本不符属于暂停，不是允许模型继续付费重试的普通工具错误。
新建使用排他创建，导入使用排他复制。队列不能锁住外部编辑器最后一次系统调用，不能宣传为跨进程原子比较交换。

**读取资格只在这次读取被接受时提交**：`read_file` 的超 8MiB / 头部 NUL / 起始行越界、`edit` 的大小 / NUL
拒绝都不得留下版本资格 —— 否则"读被拒 → 直接覆盖"就是一条不需要看到内容的覆盖捷径（2026-10-19 实测可复现）。
`edit` 的失配与"内容无变化"不产生写成功事实，也不产生产物记录。路径解析失败要**分类**：越界与
"真实路径核不出来（权限 / 未知）"分开报（[[src/main/agent/guard.ts#inspectPathInWorkspace]]），后者一律拒绝；
只对确证不存在的尾部上溯（[[src/main/agent/guard.ts#realpathDeepest]] 与
[[src/main/file-revision.ts#canonicalFilePath]] 同一口径）。

[[src/main/browser.ts#createBrowserTaskAdapter]] 每轮固定真实标签，独立于界面激活标签；同标签操作排队，定位等待后再次核页面身份。

原生内置浏览器是**公共能力**（plan79）：[[src/main/agent/runner.ts#resolveAgentToolNames]] 在角色
声明之上 union 浏览器集（只读档只留只读子集），原生关时**从工具表剔除**——「表有工具装空」是假承诺。
开关走 [[src/main/store/settings.ts#getNativeBrowserEnabled]]（缺省开、坏值不当 true、旧总开关显式
关过则保守保留关），与外部 MCP 的 browserControl 各管一条线。

授权在**宿主接缝一处**（2026-10-14 修正批 + 剩余两项修正）：[[src/main/browser-policy.ts]] 纯策略 +
[[src/main/browser.ts#createBrowserTaskAdapter]] 执行点门位。分类读**宿主元素事实**：沿命中节点到根的**整条事件路径**汇总危险事实（提交控件/文件选择/任意
button/按钮型 input/明确 onclick/role=button/可编辑），OR 汇总**不被包装层数、最近字段/链接身份或
布尔短路抹掉**；label 另读关联控件路径；路径读取异常按未知处理。任一风险 → 每次问（站点浏览授权
**不吃**外部作用）；无风险普通字段/普通链接/普通元素 → 首次站点授权后连续执行。计划批准角色批准前只给只读浏览器能力。
确认卡带真实 tool/站点/发起者（结构化桥，全权限档注入）；确认返回与真实输入前**重核**开关/取消/
目标/版本。**导航加载期间的人工输入事实（before-input-event）不得被吸收进新版本基线**——采纳前
核对，有介入即暂停且不更新基线。子代理浏览器工具**按 job 重建**（同角色并发也各一份），schema 与
执行工具同一次装配。缺 ctx/确认服务一律拒绝，网页内容与模型自报不是授权来源。关停走 ctx.isEnabled
实时探针：排队中的动作在执行点被拒并说明原因——开关关不掉已发出的网络请求。
导航及可识别键盘输入会使旧版本失效；失效后本轮停止，不自动追逐用户新页面。
检测不等于完整 DOM 仲裁：无导航、无可观察输入事件的任意页面内变化不在版本承诺内。

[[src/main/mcp/mcp-manager.ts#createMcpManager]] 追踪连接中和已连接资源，终止后不接新连接。
晚到的传输不允许重新登记；释放共享结果，不能只清 Map 留下服务进程。
[[src/main/quit-lifecycle.ts#createQuitBarrier]] 首次阻止退出，释放完成或五秒上限后放行；再次退出不重复阻止。
macOS 只关窗口时不终止 MCP，避免重新开窗口拿到永久关闭的管理器。

## 对话内文件与媒体预览（plan74，2026-10-14）

三入口就地预览（输入附件 / 历史用户消息 / Agent 文件产物），用户不必去资源管理器找文件。

**本地预览与模型出站物理分离**（铁律）：PDF/音频/Office 只走 [[src/shared/conversation-preview.ts]] 的
LocalFileRef（ChatMessage.localFiles 承载），**不进 parts、不出站**。图片/视频两处引用同一 assetId，
不复制字节。最终出站装配走**显式白名单**（[[src/shared/content-parts.ts#materializeHistory]] 只放
role/content/parts）——将来任何新本地字段自动不出站，不许 spread 存储消息。

**文本候选装正文前必过 NUL 闸**（[[src/main/workspace-fs.ts#hasBinaryHead]]，2026-10-15 双独审 N-1 回补）：
文本语义 hint（text/*、json、xml）的文件在摄取登记时读前 8KiB 查 NUL，命中即按未知二进制降级——
content 留空、不填模型 parts，本地快照与归属保留。切错的后果：文本扩展名的二进制（如 .log 实为压缩包）
垃圾正文进模型上下文，且旧路径是整件拒绝、有预算路径却放行，同一文件两个待遇。
⚠️ 只做 NUL 探测，不是 magic-byte/编码识别；真实 PDF/Office/音视频走各自格式通路，容器含 NUL 不误拒。
同一判据也用在 [[src/main/workspace-fs.ts#readAttachment]] 无预算分支与 file-tools 的 read_file，三处不许分叉。

**唯一只读加载缝**是 [[src/main/preview-gateway.ts#createPreviewGateway]]（纯逻辑、不 import electron、
可单测）；协议挂载在 [[src/main/preview-protocol.ts#installPreviewProtocol]]（同一 scheme 单一 handler
按 host 分发 doc/mem/asset，`jsl-preview://asset/<handleId>`，Range 越界/多段→416 不静默回全量）；
组合根在 [[src/main/preview-assemble.ts]]（ensureGateway 惰性初始化，模块顶层不碰 electron 运行时）。
[[src/main/preview-identities.ts#PreviewIdentities]] 签发真实窗口绑定的草稿身份；assetId存在不能代替
window/draft/asset三者对应。附件选择与拖入同样经过这个登记，不另开“有文件就读”的入口。
保存前prepare只依据宿主登记或原消息资产边规整成history；写盘成功后committed才消费草稿，
失败仍能重试。持久消息不保留临时draftId。历史读取同时核会话、消息和该消息引用的具体资产，
重启后不依赖进程内草稿表，也不允许用另一条合法消息借读未引用资产。
renderer在保存后尚未重读时可能仍带draft；组合根只有找到真实存档中完全对应的消息资产边
才转换为history，名称/MIME/大小也从这条边或宿主登记读取，不能由客户端改字段提升呈现能力。
artifact 读盘（async）上移装配层，Gateway 保持同步。⚠️ 同一 scheme 只能装一个 protocol.handle ——
曾分 doc/mem 与 asset 两处安装，真实 Electron 在第二个安装处抛 `Failed to register protocol`（Spec R1）。

**资产预算事务** [[src/main/preview-assets.ts#AssetBudget]]：单文件 50MiB、总附件 1GiB。
reserve 返回本账本拥有的预留身份，而不是可重复扣减的字节数；同步复制并关闭两个描述符后，
resize 先核实际增长与总量，rename 与登记成功后才 commit。失败只 release 那笔仍在途的身份，
重复释放、跨账本释放与已结算后释放不影响别的占用。提前结算再按初始大小回退，会在
“源增长但未超预算＋rename失败”组合中留下增长部分的幽灵占用。历史/草稿不自动淘汰（61 项保留）。
旧媒体库与新资产库的统一计账仍在本次单端实施中，不能把预算类单测当作全部组合根已接通。

**Agent 产物路径只信真实入参**（[[src/shared/tool-detail.ts#toolArtifactPaths]]）：从 write_file 类工具的
path 入参提取，**不是**从 detail 文本正则猜——模型随口写的字符串不算可读路径。绝对路径/盘符/`..` 段全拒。

**媒体单播放协调** [[src/renderer/src/media-coordinator.ts]]：激活即互斥，卸载（收起/切会话）即停，
按「会话+稳定资产身份」续进度但不自动播放；产物版本变了不串进度。

[[src/renderer/src/components/FilePreviewCard.tsx#FilePreviewCard]] 的每次加载effect拥有自己的句柄。
收起、换源、切会话与卸载均释放该次句柄；结果晚到时不显示并立即释放。不能用一个
handleRef只在组件卸载时释放最后一次打开的句柄，那会让之前折叠掉的资源失去归属。

**PDF真实页面**由 [[src/renderer/src/components/PdfPreview.tsx#PdfPreview]] 使用现有pdfjs绘制到
浏览器canvas，扫描件图像同样绘制，不用Node canvas。页面内容从签发窗口的有效PDF句柄经
previewRead受控桥读取；用户内容不进入HTML脚本。worker是Vite打包的本地资源，直接以端口
交给PDFWorker，避免file: origin判断转成blob/CDN包装；主窗口/公共HTML的脚本策略不放宽。
翻页、缩放、键盘导航都重绘实际画布；畸形画布有尺寸/像素上限，关闭时取消render并销毁文档/worker。
旧Node纯文本模块已无生产消费者，随同它的四个文本抽取单测退役；原字节在本地实施前快照，
替代证据是生产Electron的真实像素、扫描图像、翻页缩放、损坏反馈和受控句柄读/撤销故事，
不是为了救绿删除失败断言。旧冻结执行/审查包不改。

Office在组合根复用 [[src/main/office-preview.ts#parseDocxBuffer]] 与
[[src/main/office-preview.ts#parseSheetBuffer]]，只返回静态沙箱HTML/工作表URL；token随句柄撤销。
docx异步解析结束后重核句柄仍存在，关窗不能留下孤儿token。单格A1是合法工作表范围，
[[src/shared/office-preview.ts#clipRange]] 不再误判空表；原行列数量截断保留。

### 图片与音视频的共同资产、事务及实际播放生命周期

[[src/main/preview-assets.ts#assetBudgetForRoot]] 对同一宿主数据根只建一份预算：
扫描assets/attachments全部文件（含未知旧名/残留件），旧库不迁移、不自动删；无法核实存量时拒新增。
[[src/main/preview-assets.ts#assetFilePath]] 在最终读取处核真实库根与文件边界，双库同名拒绝，
而非按查找顺序读到另一份内容。模型parts与本地localFiles共用媒体的同一物理ref；
新本地50MiB预览不扩大原5MiB图片/20MiB视频出站限制，超出模型上限的媒体只留本地。

[[src/main/preview-assets.ts#ingestAsset]] 与 [[src/main/preview-assets.ts#storeAssetBuffer]]
均在rename后、结算前调用可撤销宿主登记；复制、关闭、rename、窗口销毁、登记或结算失败
释放同一笔在途预留、撤回本次登记，不把已commit的孤儿附件伪称事务成功。
[[src/main/preview-assemble.ts#attachmentPreviewPublisher]] 在真正登记前重核窗口还活着；
不能把摄取前一次窗口检查当成异步摄取后的许可。清不掉的本次件保守计入并拒新增，
不新增自动清理历史资产机制。

[[src/main/preview-protocol.ts#installPreviewProtocol]] 的资产库媒体响应使用真实fd/大小和
64KiB带背压文件流；Range与无Range均不整份readFile后slice，多段/越界明确416。
浏览器取消、窗口销毁、释放或五分钟主动到期停止在途流；Office临时token同时撤销。
[[src/renderer/src/media-coordinator.ts#MediaCoordinator]] 用元素身份而非只用asset键互斥，
同一资产在两处展开也不能同时播放，卸载旧元素不摘走新元素；进度键包含内容版本。
[[src/renderer/src/components/FilePreviewCard.tsx#FilePreviewCard]] 媒体在metadata就绪后恢复进度，
不自动播放，卸载真实pause并移除src/load停止解码下载。图片是真解码缩略图与同窗浮层，
不通过堆积右侧页签或新窗口实现，Esc关闭归还焦点。

### 成功产物与降级出口不是模型宣称

[[src/main/agent/tools/file-tools.ts#createFileTools]] 保持execute文本返回接口，
仅在实际写入成功后，按本次入参对象身份记录工作区产物；
[[src/main/agent/loop.ts#runAgentLoop]] 执行后消费该证据，start/拒绝/异常/无变化不提前发文件卡。
[[src/shared/tool-detail.ts#toolArtifactPaths]] 只认真实write_file/edit，Windows反斜杠按同一段规则校验。
存档segments保留成功事件的artifactPaths；正文/model请求不搬这些本地事件字段。

[[src/main/preview-assemble.ts#openPreview]] 在宿主补探产物类型、大小和真实内容指纹，
始终读会话原工作区，不用全局当前根或renderer的text/plain/0字节占位事实。
文件读取期间变更或超过50MiB拒绝；PDF/媒体只保留源事实和流句柄，不存整份Buffer。
[[src/renderer/src/components/FilePreviewCard.tsx#FilePreviewCard]] 明确刷新当前文件并显示内容版本变化，
而不是拿旧句柄链接冒称已刷新。对应音视频进度键随真实内容版本改变。

[[src/renderer/src/components/MessageMarkdown.tsx]] 复用既有解析器，但本地只读变体禁止图片和链接
自动取外部资源；缓存键含变体，不把普通消息的外链缓存借给本地文档。
未知/PPTX仍有受限快照与明确降级，
[[src/main/preview-assemble.ts#openPreviewInSystem]] 只接受本人有效句柄并重核真实来源，
不借系统打开回退到任意路径/当前工作区；可执行文件和快捷方式不由预览入口启动。
系统打开为用户主动行为，测试仅替OS打开外设，IPC与来源判断保持生产实现。

发送接收状态从真实异步提交返回，不在调用回调后立即清空附件。
[[src/renderer/src/components/InputConsole.tsx#InputConsole]] 保留拒绝/异常草稿，
成功只清本次批次，不误清等待期间新加入的附件；ChatView不清新输入或别的会话输入。
IPC尚未接受的新轮恢复原内存消息，不持久化失败payload来消费草稿。

资产摄取临时件只有排他创建成功才属于本次事务；EEXIST时不能把已有临时文件删掉。
[[src/main/preview-assets.ts#assetBudgetForRoot]] 只有整库尚未存在可按空库处理，
扫描中单项ENOENT/解析错误仍阻断新增，避免漏算剩余持久资产。
四个Provider最终装配均调用 [[src/shared/attachment-block.ts#attachmentTextForModel]]
去掉规范媒体marker中的内部引用；存档marker保留，普通用户ref文字不改写。
WirePart的内部ref只在进程中定位字节，不序列化进厂商HTTP字段。

用户paste事件的图片字节复用既有attachPath IPC，不引入可读任意路径的新入口。
[[src/main/preview-assemble.ts#ingestClipboardImage]] 在宿主解码转PNG，之后共用预算和可撤销登记；
超原模型5MiB但在本地50MiB内只落本地引用，普通文本粘贴不被截获。
测试不读写用户系统剪贴板，只将合成ClipboardEvent送到真实输入组件。

### 命令输出的末行保留

[[src/main/agent/tools/shell-session.ts#createShellSession]] 在 POSIX 非交互壳中仅移除结束标记本身，
不以整行清理吞掉与标记相邻、没有尾换行的 stdout；退出码仍取协议标记，正文不参与成功判定。
Windows 提示符与回声清理保留原行为。真实 shell 回归同时覆盖零/非零退出、无尾换行和连续命令隔离。
