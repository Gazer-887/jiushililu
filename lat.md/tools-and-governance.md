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
字符串比较，恰好放过 junction 这类真实逃逸（2026-10-13 增量独审定点补）。

## 应用通信、协作写入与退出

[[src/main/trusted-ipc.ts#installTrustedIpc]] 将通信注册收在一个入口：已登记的窗口对象、主 frame 与准确页面三者缺一即拒绝。
事件型通信也经过同一入口；安全安装失败不降级开放。诊断只记录通道，不替代信任判据。

[[src/main/file-revision.ts#withFileCommit]] 按真实路径协调进程内提交；
[[src/main/workspace-write.ts#createWorkspaceWriter]] 在排队后和快照后重新核内容版本、路径身份。
界面保存携带读取版本，Agent 整文件覆盖沿用读取版本；精确修改携带本次源内容版本。
版本不符属于暂停，不是允许模型继续付费重试的普通工具错误。
新建使用排他创建，导入使用排他复制。队列不能锁住外部编辑器最后一次系统调用，不能宣传为跨进程原子比较交换。

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
