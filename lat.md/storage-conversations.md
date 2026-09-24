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
