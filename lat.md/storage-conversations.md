# 存储与会话正文

会话正文是用户唯一的原始数据：它分成两半存（索引与日志）、被两把尺子量（出境与落盘）、
并在每一次保存里由主进程裁定"这次到底该写什么"。这里只写**为什么这么切**与**切错的后果**；
调用形状看源码，事故与取舍看 `NOTEBOOK/`。

## 索引与正文分文件

[[src/main/store/conversations-core.ts#ConversationsBackend]] 是存取的唯一接缝，它的形状就是分层的形状：
`readMeta` 一条正文都不碰，`readMessages` 只按 id 取那一份。分文件不是审美，是两笔算得出来的账。

旧版把全部会话连同正文塞进一个文件：列一次侧边栏要解析所有历史，写一条会话要重写全部会话。
electron-store 只支持"整个对象一把写"，与分层不可兼得；它又在构造函数里就锁死 userData 路径，
只能出现在装配层（[[src/main/store/conversations.ts#repo]]）。于是行为一律留在
[[src/main/store/conversations-core.ts#createConversationsRepo]]——那里不依赖 electron 也不依赖 fs，
才是可单测的那一份；fs 本身也做成可注入的接口（[[src/main/store/conversations-fs.ts#FsAdapter]]），
读盘足迹才数得清。物理上每次保存仍是整份原子重写：**追加是语义层的**，崩溃安全靠
[[src/main/store/conversations-fs.ts#atomicWrite]] 的写 tmp → fsync → rename → fsync 目录四步。
只做 tmp + rename 不等于崩溃安全：rename 只改目录项、不等数据落盘，"读者看不到半截"成立而
"写入活得过崩溃"不成立。

⚠️ 三条不可回退的约束：**写序先正文后索引**——反过来的话索引里会短暂出现"游标说有 N 条而正文还不存在"，
崩在中间就是"点进去空白"；**单个坏文件不拖垮整张表**——
[[src/main/store/conversations-fs.ts#createFsConversationsBackend]] 把读不出来的正文当空处理并留痕，
而旧版遇到坏 JSON 直接抛，一条坏会话就是一次全列表故障；**动手前留备份只发生在迁移那一步**
（[[src/main/store/conversations-fs.ts#migrateConversationsFormat]]：写齐 → 回读校验 → 才覆盖索引），
日常保存没有第二层保护，它全靠上面那条写序与那两道 fsync。

## 追加 + 游标

正文文件存**完整日志**，`meta.messageCount` 兼作**游标**（可见长度）。刻意不另立 `cursor` 字段：
这个数在用户眼里本来就是可见条数，两者是同一个数，于是老数据没有新字段也照样读得对。

三个问题因此各自变便宜：**回滚**（[[src/main/store/conversations.ts#rollbackConversation]]）
只是把游标往回移，数据一条都不删；**撤销回滚**（[[src/main/store/conversations.ts#undoRollback]]）把游标移回末尾，
尾巴一直在盘上所以零成本；**"留几轮"**这个问题根本不存在——不复制历史就没有副本膨胀。
上下文装不下的裁剪是另一层的事（token 预算改的是发出去的那份，从不动盘上的日志）。
[[src/main/store/conversations-core.ts#createConversationsRepo]] 每次切可见正文都把游标夹紧在日志长度之内：
手改过的文件、迁移留下的老数据都不该让界面炸。

⚠️ 回滚与撤销都返回权威正文（[[src/main/store/conversations-core.ts#RollbackOutcome]]），渲染端**必须用它覆盖内存**，
否则下一次保存会把"已经回滚掉"的内容原样写回去——**回滚被自己的界面撤销**，这是这类功能最经典的事故；
同理，回滚之后那一条不再落盘（存储已是权威状态）。撤销有保质期：继续说话即命中下节的情形 ①，尾巴当场作废，
所以提示条要在发送那一刻清掉（`src/renderer/src/store.ts` 的 `rollbackNotice`），留着就是假承诺。
两条通道在会话运行中一律拒绝（判据是 [[src/main/agent/concurrency.ts#createChatGate]] 的 `isRunning`）：
流式中途把尾巴接回来，随后落盘会拿"恢复后的正文 + 这一轮"去对账，被回滚掉的那段和新答案就搅成一条会话。

## 一次保存的四种情形

有了游标，保存就不能照单全收。比对用三份数据：`v` = 磁盘日志按游标切出的可见正文，`t` = 游标之后的尾巴，
`m` = 渲染端交上来的那份。裁决在 [[src/main/store/conversations-core.ts#createConversationsRepo]] 的
`saveConversation` 里，装配层的入口是 [[src/main/store/conversations.ts#saveConversation]]。

[[src/main/store/conversations-core.ts#isPrefixWithMutableTail]] 判前缀时**末条允许不同**：流式回复是原地生长的
（先塞一条空助手消息，token 逐段往上长），把末条算进严格比对等于每吐一个字都判成"不是前缀"，
于是每次保存整份重写，追加语义作废。

| `m` 与 `v` 的关系 | 判读 | 结果 |
|---|---|---|
| 更长，且 `v` 是它的前缀 | 真有新消息 | 日志 = `m`，`t` **作废** |
| 等长，且 `v` 是它的前缀 | 原地更新 / 原样回传 | 日志 = `m + t`，游标不动 |
| 更短，且 `m` 是 `v` 的前缀 | 回滚 | 日志不动，只移游标 |
| 认不出前缀 | 无法判定 | 整份重写（安全优先，不猜） |

⚠️ 第二行的"尾巴必须留着"修的是一次真实丢失：该条件一度写成 `m.length >= v.length`，把"等长"划进了第一行，
于是**回滚之后任何一次保存**（切会话、点停止、关窗口都会触发）顺手抹掉尾巴，撤销从此静默失效——
回滚当场看着成功，只有点撤销时才"什么都没发生"。这类缺陷不抛异常、不留日志，界面上也看不出来。

同一条原则管着随保存一起进来的统计字段（用量、省下的量、主 Agent）：**没给就保持原值**，
回滚与改名这类保存不许把账抹掉——"没有账"与"账为零"是两回事，不能用缺字段覆盖一个真数字。
账本只长不缩（取较大值而非覆盖）：并发两条会话同时落盘时，晚到的那个若拿着较旧的快照，
直接覆盖会让数字倒退，而"看着像真的"。

## 用量来源与覆盖范围随账保存

[[src/shared/conversation-usage.ts#accumulateConversationUsage]] 分开厂商报告、本地估算与独立反思。
无报告也记一次漏报事实，但不赋予数学空账厂商来源；真实成对0仍是有效报告。
[[src/shared/conversation-usage.ts#mergeConversationUsage]] 重读累计时不制造最近一轮，恢复来源、覆盖、档位与本地估算。
旧全0来源无法反推，原数保留但不作为实报；旧正数沿原报告契约显示，覆盖范围仍未知。

[[src/shared/usage.ts#mergeUsageSnapshots]] 合并同一累计账的快照，明确未知及较大范围缺失明细不能借旧局部数字变成整笔已知。
[[src/main/store/conversations-core.ts#createConversationsRepo]] 保存所有统计字段；不给不抹，明确漏报不能被晚到true洗掉。
主进程保存校验保留可选明细的0/null/缺字段，不能只收两个基础数便丢掉缓存、思考与档位。

[[src/main/providers/usage-parsers.ts#createAnthropicUsageAccumulator]] 以初始输入和最终输出成对收口，最终累计报告覆盖阶段值。
[[src/main/agent/runner.ts#runAgent]] 观察主请求、摘要及批准后的执行请求；任一漏报或摘要失败，则只能说已报部分。
实际档位来自本轮策略，不能在异步结束后读取已被用户更改的设置。独立反思不在这份请求覆盖声明里。
Anthropic输入是否归一为未缓存输入加缓存读写仍待裁，当前保留既有原始input_tokens，不将本切片当成跨协议计费对账。

## 出境与落盘是两把尺子

同一份消息被两把尺子量：发给模型的 [[src/main/schemas.ts#chatMessagesSchema]] 与落盘的
[[src/main/schemas.ts#storedMessagesSchema]]。它们量的是两件不同的事，因此条数上限刻意不同——
前者管"一次请求别把上下文撑爆"，后者管"一条会话能有多长"。

两把尺子不许合并，两条理由都是踩出来的：共用发送侧那个较小的上限（200 条），会让会话超过它之后
**保存永久失败**，等于给用户设了一道看不见的会话寿命上限；共用落盘侧那个较宽的（2000 条），则放任一次请求撑爆上下文。
落盘侧另有总字数预算（[[src/main/schemas.ts#MAX_STORED_CHARS]]），口径是 `content` 与 `segments`
序列化长度**都计入**——分段里带着工具摘要，只算正文的门是盲的。

松紧也各朝不同方向：[[src/main/schemas.ts#messageSchema]] 按角色放行空正文助手轮
（被"停止生成"留下空轮的那条会话否则再也发不出消息），且**永远不含** `segments`——分段是本地渲染资产，
不随请求出境；[[src/main/schemas.ts#storedMessageSchema]] 收分段，并要求空正文只在"助手轮且带分段"时才可落盘。
口径分岔时不存在谁覆盖谁：两条通道各判各的，发送侧那一点差额由
[[src/main/agent/context.ts#historyForModel]] 补（换占位句而不是删条，见 `lat.md/agent-kernel.md`）。

### 逐轮运行事实：只落在 assistant，且必须可归属

服务档这一包给消息增加了三个**本地运行事实**字段：`requestId`（本轮本地身份）、`requestPolicy`（起点冻结策略）、`serviceTier`（最后真实观测）。三者都只允许挂在 assistant 上，且策略 / 档位必须能归属到 `requestId`；`observed=false` 却带 actual 之类的矛盾一律拒收。

规则只有一份（[[src/main/schemas.ts#runFactsSchema]]）：UUID、长度、枚举、策略工厂不变量（normal → 并发 1、fast → 并发 2；仅 fast + supported 请求 `priority`）、服务档有界非空白、observed / actual 一致。入站白名单与落盘白名单都声明这三个字段——未声明就会被 IPC 入口静默剥离；conversations-core 的 [[src/main/store/conversations-core.ts#assertRunFactsAttribution]] 直接复用同一份 schema，**绕过 IPC 直调仓储也拦得住**。

只存逐轮事实，不建会话级 `latest*`：会话级"最近一档"会让下一轮缺报时继承上一轮 actual，正是"无观测保持未知"的反面；界面需要最近事实时读尾部消息，不另存一份。旧档缺字段原样兼容；存档 → 新仓储实例重读与磁盘 JSON 一致，重启不丢。本地 `requestId` 不是供应商随机身份键，不随模型请求出境。

进主进程是一条固定流水：先松收下（[[src/main/schemas.ts#incomingMessagesSchema]]，流式占位是合法中间状态）→
规整（[[src/main/store/conversations-core.ts#normalizeHistory]]）→ 才严格审（流水在 [[src/main/ipc.ts]] 的 `convSaveCore`）。
中间那道规整封的是一条**真实的数据丢失渠道**：渲染端一按发送就塞空助手占位，而落盘要求正文非空，
于是"没吐字就切会话 / 点停止 / 关窗口"这几条路保存必然被拒；而当年被拒之后既无日志也无提示——
静默、丢数据、无从解释，切会话那条路甚至整个动作都不再执行。现在被拒会写日志，并把理由回给界面单独一格。

⚠️ 规整规则与游标是一根绳上的：渲染端算 `messages` 时的过滤必须与 `normalizeHistory` **同一条规则**
（"空正文 + 带分段"的助手轮要留着）。一边丢一边不丢，渲染索引与磁盘索引就错位，
按索引移游标的回滚会切错位置——那时错的不是显示，是数据。

## 降级只能丢可再生的一半

超预算不等于整条会话作废：[[src/main/store/conversations-core.ts#fitStoredBudget]] 从**最老**的消息开始丢分段、
保住正文。取舍只有一条——分段是回看时的增强，正文是合同。

顺序是硬的：先降级、再让落盘审过。[[src/main/schemas.ts#storedMessagesSchema]] 只会整条拒（兜底），
这一道是能救则救；反过来排，一次超限就把整条会话判死。丢了几段要留痕，否则用户只会觉得"回看怎么没了"，
排查时没有任何东西可对齐。

⚠️ 降错东西比不降级更糟：空正文的助手轮**靠分段才合法**，把它的分段一并删掉就成"空正文 + 无分段"，
落盘审会**整批**拒掉。不降级只是那一条会话存不下（日志里说得出理由），降级降错了是一条会话在盘上整个消失。
所以丢弃循环里嵌着一个前置判定：先看这条有没有正文，再看它多老。

## 标题的两条来源

[[src/main/store/conversations-core.ts#deriveTitle]] 是机械兜底：取首条用户消息的首个非空行、剥掉 Markdown
记号、超长截断，确定且不花钱；智能标题要发一次请求，所以每一道关口都收紧。

触发条件收在两处：**首答刚落盘**（消息恰好两条且其中一条是助手轮）+ **当前标题仍等于机械候选**
（[[src/main/ipc.ts]] 的 `maybeGenerateSmartTitle`）。时机选在落盘而不是对话流收尾，因为收尾跑在渲染端落盘之前，
那一刻读不到首答；"仍是候选"这一条同时管住两种重复——用户改过名则条件不成立、天然让位，
生成过一次则标题不再是候选，不必另立状态位来防重复烧钱。

原子性不是优化而是必须：模型还在生成时用户可能已经手动改名，无条件覆盖就会冲掉用户的改名。
所以写回只走 [[src/main/store/conversations.ts#setConversationTitleIfEquals]]
（当前值仍等于期望值才更新，否则静默让位），成功再向各窗广播一声让界面重读。
清洗端同样克制：[[src/main/store/conversations-core.ts#sanitizeGeneratedTitle]] 只去引号、前缀、多余行与尾部标点，
**不补词不创作**，洗空了判为无效并退回机械标题；它与 [[src/main/store/conversations-core.ts#buildTitlePrompt]]
是两个纯函数、放在逻辑层，为的是让"要什么"和"接受什么"两份约束都被单测盯住，真正发请求的动作留在 IPC 层。
手动改名是另一条路：[[src/main/store/conversations.ts#renameConversation]] 把空标题视为
"没改"、原样返回不落盘——既省一次无意义写，也不给"清空标题"留出口。

## 工作区：分组键同时是权限键

每条会话的 meta 带一个 `workspace` 字符串，它同时是侧栏的分组键与主进程授权白名单的成员。
一个字段两用是这个存储层最省真相源的地方，也是最容易被忽略的耦合。

读侧：[[src/shared/conversation-group.ts#groupByWorkspace]] 按它分组（组内按更新时间倒序，
组间按各自最新时间倒序），[[src/shared/conversation-group.ts#workspaceLabel]] 取路径末段当展示名、
完整路径留给悬停。写侧：[[src/main/store/conversations.ts#knownWorkspaces]]
从整张 meta 表去重得出白名单，切换工作区、打开目录、新建会话三处判定共用它。

后果一：**白名单是派生的，不是登记簿**。删掉某个工作区的最后一条会话，顺带就撤销了那次授权；
反过来，授权面只随会话的存在而存在，不必另养一本会漂移的授权台账。点开历史会话会连带把工作区切过去，
走的正是这张表——表里没有的路径切不动。

后果二：分组与白名单都只读 meta，所以列表、每次切会话、启动早期都付得起，正文只在点开那一条时才读。
这是分层唯一要换来的东西，也是它值得存在的判据：一旦有人在列表路径上顺手取正文，分层就失去意义。

⚠️ 后果三：分组键就是那个**原始字符串**，没有任何规范化。同一个目录写成两种路径（结尾斜杠、分隔符不同）
会分成两组，并各自判一次授权。当前所有写入都出自同一个目录选择器，所以实践中一致——这是隐式前提，
新增任何写入口（导入、命令行、别处拼路径）都要先补规范化。

⚠️ 后果四：分组规则在渲染端**另有一份**（渲染层不 import `src/main`）。两份的排序与取末段口径必须同步改，
而有单测钉着的是主进程这一份——只改渲染端那份不会红，正是"看着像改了"。

## 目标（goal）也走同一刀：core 收接缝，薄壳只装配

长期意图的落盘原先把五个入口直接挂在模块级 `new Store()` 上，于是这段真实行为在单测层是黑的。

切法与会话那把刀同一条：语义进 [[src/main/store/goal-core.ts#createGoalRepo]]，
接缝是 [[src/main/store/goal-core.ts#GoalBackend]]（只有 `readRaw` / `writeRaw`），
留痕通道是 [[src/main/store/goal-core.ts#GoalLog]]；装配留在薄壳 [[src/main/store/goal.ts#listGoals]]，
它只允许"造 Store + 转发"。黑的原因写在 [[tests/unit/architecture.test.ts#BANNED]] ——
单测 import 图里不许出现 electron / electron-store，直接测旧形状就会把架构守卫打红。

为什么切错了会贵：

- 接缝一旦变成"可选参数注入 logger"这种松形状，生产走 Store、测试走另一套默认值，
  **两条路径会各自长出自己的行为**，测过的不再是跑着的那条。
- 薄壳里一旦重新出现判断（哪怕只是一句"没有匹配就不写盘"），那段行为立刻回到测不到的地方 ——
  [[src/main/store/goal-core.ts#createGoalRepo]] 里 `removeGoalsOf` 的"没匹配不落盘、不落 info"就是这条纪律的具体形状。
- 主进程那份账与渲染端那份视图是两件事：会话归属由渲染端 store 的 `applyAgentGoal`
  （挂在 [[src/renderer/src/store.ts#useAppStore]] 上）比一次 `conversationId` 守住，
  主进程那边靠过滤守住。两侧各有判据（`goal-agent-apply.test.ts` / `goal-store.test.ts`），**互不替代**：
  门禁的 `goal:list` 是单会话桩，给不出"两条会话"这个形状，所以那条判据只能在单测或真入口里成立。

## 本地预览引用不是可降级的过程缓存

[[src/main/store/conversations-core.ts#fitStoredBudget]] 超预算时可去掉思考和工具长摘要，
但用户的localFiles/messageId和成功工具的最小artifactPaths必须保留。
只剩文件工具段时，界面仍从content显示正文，不能把“保卡片”变成“正文空白”。

回滚只移游标。[[src/main/store/conversations-core.ts#createConversationsRepo]] 默认getConversation
依旧只返回可见消息；仅宿主预览和编辑存档核身份时显式查含隐藏尾部的原消息。
编辑重发沿用原messageId、媒体parts与本地引用，宿主仍按同一会话/消息/资产边核对；
不是把全局资产存在当成许可，不重读已经变化的原文件。
发送失败保留编辑附件，切会话清空编辑状态；恢复游标不改原资产。

## 模型档案的元数据：三源、时间与未知态

模型条目的 `metadata` 是**单一档案字段**（[[src/shared/models.ts#ModelEntry]]），不建 `metadataByEntry` 或第二配置库；十个字段各自独立保留 `official` / `catalog` / `user` 三类观测（[[src/shared/model-metadata.ts#ModelMetadata]]）。解析顺序固定 **user > official > catalog**（[[src/shared/model-metadata.ts#resolveMetadata]]）：每个来源都带自己的 `observedAt` 与可选 `limitations`，解析结果把**值与来源、时间一起带出**，界面不自行猜优先级。

**没有合法来源就是 `undefined`，不补 0、不补空串、不造默认值**；`0` 只允许作为真实零价出现（[[src/shared/model-metadata.ts#PriceEntry]]）。

应用默认走 [[src/shared/model-metadata.ts#withAppDefault]]，来源只能标 `app-default`，**不许伪装成官方/目录/用户**。上下文窗口与最大输出 Token 有应用内回退值，其余字段无已知来源时一律「未知」——拿应用默认冒充厂商规格，比留空更坏。

**原生输入与附件解析是两个独立字段，不得互相推导**：`nativeInputModalities` + `nativeExtendedInputs` 回答「模型原生收什么」，`attachmentParsing` 回答「应用能把什么解析后送进去」（[[src/shared/model-metadata.ts#AttachmentParsing]]）。附件能解析 PDF **不等于**模型原生接受 PDF；两栏在界面上固定分开（[[src/renderer/src/components/ModelCatalogEditor.tsx#NATIVE_INPUT_KEYS]]）。`INPUT_MODALITIES` 仍是 `text/image/video`，本模块不扩产品出境枚举；audio/pdf/file 只存在于 `nativeExtendedInputs`（[[src/shared/model-metadata.ts#NATIVE_EXTENDED_INPUTS]]）。

**保存门 fail-closed，读盘容错逐字段**：保存走 [[src/shared/model-metadata.ts#modelMetadataSchema]]（`.strict()`，未知键/非法来源/非法时间/非法值一律拒）；读盘走 [[src/shared/model-metadata.ts#normalizeModelMetadata]] 逐字段白名单重建，坏字段丢弃、好字段保留。严格整门若拿来读存量，一个坏字段会把整份元数据全丢——两条路径**同一合同、不同容错层**，不能合并。

**用户覆盖只写 user 层，且只对已保存条目开放**：补丁入参 [[src/shared/model-metadata.ts#modelMetadataPatchInputSchema]] 只收 user 来源、不收 `observedAt`；主进程用一次 `Date.now()` 盖章后 [[src/shared/model-metadata.ts#applyUserMetadataPatch]] 只替换该字段的 user 观测，official/catalog 原样保留。清除只清 user，字段回落到 official/catalog；唯一来源清空才移除字段。落盘走 [[src/main/store/models.ts#patchEntryMetadata]] 单次 `store.set('profiles', …)`，其它 profile/entry/settings/name/Key 不动；metadata 整体不存在时移除键而不是留空对象。

**刷新链是广播 + 重读，不是渲染端自盖**：`models:patch-metadata` 成功后主进程广播 `models`，设置窗收到后重读 `listModels()` 真值（[[src/renderer/src/views/SettingsView.tsx]]）；渲染端 [[src/renderer/src/components/ModelCatalogEditor.tsx#submitMetadataOverride]] 只发 `{ user: { value } }`，成功后 [[src/renderer/src/components/ModelCatalogEditor.tsx#mergeMetadataFromView]] 只替换草稿里的 `metadata`，保留 Key、模板、认证与其它未保存草稿。未保存端点/条目不调用 metadata IPC（[[src/renderer/src/components/ModelCatalogEditor.tsx#canOverrideMetadata]]）——没有档案可打，发了只会拿到「条目不存在」。

## 会话级速度覆盖：寄生在既有偏好表里的一张有界映射

`conversationSpeedOverrides` 不另立文件，就住在既有 `ui-prefs`（[[src/shared/splitter.ts#UIPrefs]]）：
与主题、字号、语言同一条通路——主进程存、改完广播、每个窗口自己重读
（[[src/main/store/ui-prefs.ts#getUIPrefs]]）。渲染端只提交整表补丁，落盘后回显主进程清洗过的结果，
不做乐观更新（[[src/renderer/src/store.ts#useAppStore]] 的 `persistUIPrefs`）。

**取值只有三个**：`inherit | normal | fast`（[[src/shared/request-policy.ts#SPEED_OVERRIDES]]）。
缺键、坏值、非法 id 一律回 `inherit`（[[src/shared/splitter.ts#getConversationSpeedOverride]]）——
坏值绝不能冒充"用户显式覆盖"。

**键与会话 id 同域**：1–128 字符（[[src/shared/splitter.ts#CONVERSATION_SPEED_KEY_MAX]]），
含 C0/C1 控制字符即丢弃；**故意不 trim**——把 `" a"` 悄悄改成 `"a"` 等于替用户丢键。上限 200 项
（[[src/shared/splitter.ts#CONVERSATION_SPEED_OVERRIDES_MAX]]），键序就是 LRU 队列：队首最旧、队尾最近，
超限从队首裁。清洗过程内部借 `Map` 临时保序（纯对象会把整数形键按数值重排），
但清洗器最终经 `Object.fromEntries` 落成普通对象，下一次 `Object.entries` 会重新按整数键顺序枚举；
真实生成的会话 id 属于非整数 id 域，当前行为不受影响。**不承诺任意整数形键经 JSON 持久化后的 LRU 保序**，
此边界留待后续专项核验。

**清洗逐项，不整表陪葬**：[[src/shared/splitter.ts#sanitizeConversationSpeedOverrides]] 丢坏键坏值、
裁到上限；一条坏数据不该让整张覆盖表消失。读盘（`getUIPrefs`）与入参（`ui-prefs:set`）都走它。

**写侧两条容易被忽略的语义**：① **脏入参不等于清空**——只有显式给 `{}` 才清空，类型不对的入参直接忽略，
否则一次坏调用就把整张表抹掉（[[src/main/store/ui-prefs.ts#setUIPref]]）。② **按最近使用合并**——
值没变的键沿用入参次序（纯函数的 set/touch 已把它挪到队尾），改值或新增的键统一进队尾；
落盘前再过一次清洗与裁剪。

**删除会话精确移除**：`IPC.convDelete` 先 `abort` 再删正文与目标，随后**只在该会话确有覆盖时**调用
[[src/shared/splitter.ts#deleteConversationSpeedOverride]] 清这一条并广播；其他会话的覆盖与次序原样不动，
没有覆盖就不写盘、不广播（[[src/main/ipc.ts]]）。**reset 清空整表**：
[[src/main/store/ui-prefs.ts#resetUIPrefs]] 写 `{}`，渲染端用返回值覆盖内存，界面不必等重启。
**旧档案缺字段回空映射**：字段不存在时清洗器返回 `{}`，不迁移、不补写、不生成第二份默认表。

**边界**：覆盖只是一条偏好，不触发请求、不清正文、不动运行中的 run；它对请求策略的影响发生在
下一次 run 起点（冻结规则见 `lat.md/agent-kernel.md`）。
