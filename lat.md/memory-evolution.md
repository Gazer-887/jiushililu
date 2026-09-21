# 记忆与自进化

跨会话留下的东西切成四块（注入索引 / 条目正文 / 待批候选 / 事件流），程序记忆 Playbook 另起一条独立线；
写入按来源分三条通路，注入按字节单独记账。这里只写**为什么这么切**与**切错的后果**；
调用形状看源码，历史与理由看 `NOTEBOOK/decisions.md`。

## 分类轴与注入优先级

[[src/shared/memory.ts#MEMORY_CLASSES]] 一个字段同时决定"怎么注入"和"能不能被自动遗忘"。
不拆成两个字段，是因为新增一类要同步的地方会从一处变两处——
[[src/main/memory/reflection.ts#VALID_CLASSES]] 旁边就是分叉的活标本。

注入分档见 [[src/shared/memory.ts#MEMORY_CLASS_POLICY]]：style 与 profile 总是注入，default 与 knowledge 按相关性。
排序把这两类钉在被截断名单之外（[[src/main/memory/memory-core.ts#CLASS_RANK]]）——条件类挤掉常驻类是不可接受的失真。
画像全库最多一条：重复时在 [[src/main/memory/memory-core.ts#createMemoryRepo]] 的加载环节按 `updatedAt` 取较新者生效，
其余不注入并双通道留痕，但**不删文件**——删是用户的决定，系统只做"哪条生效"的消解。
[[src/main/memory/memory-core.ts#isExemptFromForget]] 让 style 与 profile 免于 LRU：
被自动遗忘掉的偏好等于系统替用户做了决定。

## 索引段与正文段是两段

进 prompt 的只有一行摘要，正文由 [[src/main/agent/tools/memory-tools.ts#createMemoryTools]] 的 `recall` 按需取。
这一刀是为了让"记忆越多"不等于"每轮越贵"：索引字节封顶在
[[src/shared/memory.ts#MEMORY_LIMITS]] 的 `maxIndexBytes`，正文另有单条上限，且这些数源码自己注明是未校准初值。

索引行的**唯一口径**是 [[src/main/memory/memory-core.ts#indexLine]]——
预算账（[[src/main/memory/memory-core.ts#buildIndex]]）与真正发出去的文字都用它，各写一份就会算出与发送不一致的字节。
截断要求确定性（同刻按 name 升序），否则同一批记忆每次截掉不同条目，"越用越稳定"就反了。
`omitted` 必须如实带进段尾（不静默截断是 R9.1 红线）。
⚠️ 一处已知边界：`recall` 取名字查的是注入集合，被预算截断的那几条既看不见也取不到，而段尾那句提示对它并不成立。

## 三条写入通路

写入按来源分三条：模型显式调用（[[src/main/agent/tools/memory-tools.ts#createMemoryTools]] 的 `remember`）、
用户选中即记（[[src/renderer/src/components/MemoryCapture.tsx#MemoryCaptureProps]]）、反思候选。
分开不是因为流程不同，而是**信任级不同**：只有第二条不经模型。

三条共用同一个校验口径 [[src/shared/memory.ts#validateMemoryFields]] 与同一个事件流——
分叉的代价是"某条通路悄悄绕过凭据检测"。开关也按通路切：记忆开关关掉的是模型通路
（[[src/main/agent/runner.ts#runAgent]] 里每轮读一次开关，关掉就整个不下发——结构性关断而非提示词劝阻），
选中即记是用户主动行为不受它管，反思链另有一个自动记忆开关。
画像禁止模型直写是双保险：工具层连选项都不给（[[src/shared/memory.ts#MODEL_MEMORY_CLASSES]]），
`save` 层再拦一道，因为改错画像的影响面是整份档案。
新条目撞相似旧条目时带回指针而非静默并存（[[src/main/memory/similarity.ts#findSimilarEntry]]，
阈值 [[src/main/memory/similarity.ts#MEMORY_SIMILAR_THRESHOLD]] 取保守值：宁可漏放也不错杀），
`force` 只对用户开放——模型被拒后只能换更具体的 name，这正是闸门的目的。

## 注入税是三笔账里的一笔

记忆段每轮占掉的 token 单独一笔账：[[src/main/memory/inject.ts#estimateMemoryTokens]] 本地估算 →
[[src/main/chat-emitter.ts#createChatEmitter]] 的收尾事件 →
[[src/shared/ipc.ts#ChatDonePayload]] → 会话账本第三格。
不并进厂商报的用量，是因为一个是真值、一个是估算，混一起就分不清谁是谁。

三笔账在 [[src/shared/ipc.ts#ConversationMeta]] 上并排：真实用量 / 窗口化省下的估算 / 注入税，
对应厂商真值、替它做的减法、自己加的固定开销。估算一律带"估"的标记；
缺字段一律**不显示**而不补 0——"没记忆"与"税为 0"是两件事。
[[src/renderer/src/store.ts#mergeUsage]] 并盘上累计时只许往前长（取 max），倒退比不显示更难解释。
反思自己那次调用是**第四格**：它不占对话轮，却真花钱。
[[src/main/memory/reflection.ts#ReflectChat]] 随候选一起把厂商用量交出来，
[[src/main/store/memory-store.ts#MemoryStoreReflectionOptions]] 的钩子把它送到
[[src/main/store/conversations-core.ts#ConversationsRepo]] 的 `addReflectionUsage`，落
`ConversationMeta.reflectionUsage`。存的是**整份用量而不是一个总数** —— 存总数等于替展示层丢掉
输入/输出这一半信息，将来任何按方向算成本的读法都会拿到假形状（理由见 D-127）。
合并口径与上面那格**相反**：这里每次写入的是本次调用的增量，所以逐次**累加**（`addUsage`），
取 max 会把"反思三次"显示成"最大那一次"（反转记录见 D-128）。
厂商没报仍然什么都不显示：这一格与前三格共用"缺 = 不显示"的规矩，不拿估算冒充真值。

## 反思链：从会话正文到候选

一条会话产出候选走 [[src/main/memory/reflection.ts#createReflectionRunner]]，**不进 Agent 主循环**：
不带工具、不带记忆注入（[[src/main/index.ts#createReflectChat]]）。切这条线的理由是成本与身份——
走主循环就等于带着刚被审的那段上下文再烧一轮工具预算，还可能把正在提炼的东西再 `remember` 一遍。

四处形状是被迫与主循环对齐的：前置门看 [[src/main/memory/reflection.ts#MIN_BODY_BYTES]]，
口径是正文的 UTF-8 字节数而非字符数（中文一字符三字节，用字符数会让中文会话全部误判为"够长"）；
出境前仍过一次 [[src/main/agent/context.ts#historyForModel]]，因为主循环那层空正文兜底罩不到这条链
（同一次整形的正面理由见 `lat.md/agent-kernel.md` 的「上下文装配与出境整形」）；system prompt 单独住
[[src/main/memory/reflection-prompt.ts#REFLECTION_SYSTEM_PROMPT]]，为的是单测能断言它而不拖着 electron 全家桶；
候选一律落 [[src/main/store/memory-fs.ts#candidatesDir]]，与正式条目物理隔离——
[[src/main/memory/memory-core.ts#MemoryBackend]] 的 `listFiles` 只列正式目录，没批准的候选进不了注入段。

失败留痕在装配层而不在执行器：执行器只咽下"输出形状不对"这一种
（模型没按格式回答不是故障），其余异常一律抛出；[[src/main/store/memory-store.ts#createMemoryStore]]
那层 catch 后写日志、再照旧走完计数。两种写反法都见过：全咽则"反思失败"与"这轮没什么可记"在日志里长得一样，
全抛则一次跑偏的输出被记成故障，把真故障淹在噪音里。

## 反思的额度、队列与日界

反思花真钱，于是有两道**不同性质**的闸：入队看队列长度、执行看当日次数，两个数同取
[[src/main/store/memory-store.ts#DEFAULT_REFLECTION_DAILY_LIMIT]]。不是一个数，是因为队列长度挡积压失控、
次数挡花钱失控，两者会独立地先撞线。

三条顺序容易写反：限额检查在**出队之前**，超限直接返回且队列项原地保留，否则每次熔断都吃掉一条待反思会话；
计数在**执行之后**且不看结果——一次失败的反思也占一次额度，因为熔断挡的是调用本身而不是产出
（判据在 `tests/unit/memory-queue.test.ts`）；跨日归零看 [[src/main/store/memory-store.ts#todayString]]，
它取 ISO 串前 10 位，即 **UTC 日界**，与本地时区差一个固定偏移，且归零后立刻落盘
（meta 是局部对象，不写回去下次读又回到旧值）。执行本身是异步的，期间可能有另一次反思写过 meta，故计数前必须重读。
关窗时入队、启动时补跑队列（[[src/main/index.ts#installFlushBeforeClose]] 那条链），补跑只在两个开关都开着时进行。

## 事件流是统计的唯一真相源

[[src/main/memory/events.ts#MemoryEventPayload]] 走的是**追加型**落盘而不是原子写：
半行尾巴是预期内的，读时跳过并把跳过行数一起带出来
（[[src/main/store/memory-fs.ts#FsMemoryBackend]] 的 `readEvents`）——与会话正文的取舍不同，
那些是用户攒下来的原文，这些只是观测。

[[src/main/memory/memory-core.ts#computeStats]] 一律从事件流算而不读盘：盘上"删了又写回"会让存活率假性归零。
两条口径值得单独记：`inject` 事件按名集合去重（[[src/main/memory/events.ts#injectionKey]]），
它是唯一每轮都可能多次的事件，全写会让它主导日志增长；被护栏拒掉的写入**必须**落一条 rejected 的 write
（事件流要能回答"试过写什么、为什么没成"），而拒绝候选**不落事件**（用户没接受的东西不进历史，见
[[src/main/memory/memory-core.ts#parseMemoryFile]] 同文件的 `rejectCandidate`）。

## 否决与纠错改的是什么数据

用户对一条记忆做的四件事，数据面差别很大：标记不对（[[src/main/ipc.ts]] 的 `memoryFlag`）
**只追加一条 flag 事件**，条目一个字节都不动——用户可能还要再看，替他删是越权，而它是误伤率唯一的来源。
编辑按 file 定位而不按 name 反推（文件可手改，二者可脱钩），改正文并刷新 `updatedAt`，
而它同时是排序与 LRU 的输入。

删除删文件、留一条带 by 的 delete 事件，事件本身不删——不然
[[src/main/memory/memory-core.ts#computeStats]] 算不出存活率。
合并把较旧那条的正文以引用块并入较新那条再删旧文件，方向在 [[src/main/memory/memory-core.ts#createMemoryRepo]]
的 `merge` 里按 `createdAt` 重判：调用方传的顺序不可信。

候选的两个终态不对称：批准要么覆盖旧条目（`origin` 沿用旧条目）、要么提升为新条目（`origin` 记 user，
批准等于用户认可），两种都必须删候选文件，否则同名双条同时进索引；拒绝只删文件。
模型侧的"纠正"是另一条判据：光有同名改写不算纠正，必须同时命中
[[src/main/agent/tools/memory-tools.ts#NEGATION_WORDS]]（[[src/main/agent/tools/memory-tools.ts#hasNegation]]），
否则模型可以自己把"用户否掉了这条"写成事件，重复纠正率就不再是用户给的信号。

## 手册回注落在哪

干活 → 复盘 → 沉淀 → 回注四环里，回注在代码上是两处拼装：[[src/main/memory/inject.ts#composeMemoryBlock]]
（无条件，语义记忆）与 [[src/main/memory/playbook-inject.ts#composePlaybookBlock]]（条件召回，程序记忆）。
沉淀侧目前只有模型显式调用的 [[src/main/agent/tools/playbook-tools.ts#createPlaybookTools]] 与人工编辑，
没有独立的策展角色在改写手册。

Playbook 与记忆分目录（[[src/main/store/playbook-fs.ts#playbooksDir]] 与
[[src/main/store/playbook-fs.ts#playbookEventsPath]]）、分预算
（[[src/shared/playbook.ts#PLAYBOOK_LIMITS]] 的注入上限与记忆的 `maxIndexBytes` 互不影响），
因为两者花钱模型不同：一份每轮无条件地花，一份只在任务类型匹配时才花。
活跃标签从用户这一轮的原话推断（[[src/main/ipc.ts]] 的 `inferActiveTags`，那张关键词表自己注明
只求"可演示、可机器判定"、不求准），而推断只能住在组合根——runner 不碰 electron-store，
没有别处同时知道"这一轮是谁"与"手册库在哪"。

段必须**静态**：混进时间戳、轮数或会话 id 就会让前缀缓存每轮失效，
而静态性正是靠 [[src/main/memory/inject.ts#composeMemoryBlock]] 只吃记忆集合来保证的。
拼装顺序同样是合同的一部分——数据边界声明必须先于数据本身出现
（[[src/main/agent/runner.ts#runAgent]] 里记忆段接在安全基线之后）。两个估算函数的口径**不同**：
[[src/main/memory/inject.ts#estimateMemoryTokens]] 按宽字符逐字计，
[[src/main/memory/playbook-inject.ts#estimatePlaybookTokens]] 按 UTF-8 字节除三，
别把两个读数当同一个数比。两笔在收尾时由
[[src/main/memory/inject.ts#sumInjectionTax]] 合成一个注入税读数 —— 相加这件事放在 `inject.ts`
而不是调用点，是因为调用点在 `ipc.ts`，那一层起不了真进程、也就钉不住单测。
