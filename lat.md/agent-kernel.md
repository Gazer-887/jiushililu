# Agent 内核

主进程里那台"干活机器"的六件核心事：跑一轮、装配上下文、控并发、按角色收工具、把纪律按实收工具表取舍、
以及渲染端如何把事件按会话归位。这里只写**为什么这么切**与**切错的后果**；
调用形状看源码，历史与理由看 `NOTEBOOK/decisions.md`。

## 主循环与轮次预算

取消是运行生命周期契约，不只是网络请求参数。[[src/main/agent/loop.ts#runAgentLoop]] 在模型前、模型返回后、每个工具派发前和执行返回后检查本轮信号，取消异常独立传播；普通工具错误仍回灌。[[src/main/agent/runner.ts#runAgent]] 同时传给主循环和 [[src/main/agent/scheduler.ts#runSubagents]]，取消后不再领取子作业，等待已在途子作业收尾后才交还父轮次。这样父轮次的checkpoint finally和记忆drain不会提前完成。取消不承诺回滚已发生副作用，也不恢复整轮墙钟；不支持取消的在途工具仍要等待自身结束。

[[src/main/agent/loop.ts#runAgentLoop]] 是唯一的对话主循环：接收已装配好的 `systemPrompt` 与 `history`，
按轮次驱动"模型出话 → 执行工具 → 回填结果 → 再问"，直到模型不再要求调用工具或触到 `maxRounds`。
轮次下限被钳在 1（`Math.max(1, ...)`），因为"允许 0 轮"不是一个可收敛的状态：它会静默产出一条空回答。
工具参数经 [[src/main/agent/loop.ts#parseArgs]] 解析，**非法 JSON 不静默吞**——原文以 `__raw` 交回模型，
让它看见自己写坏了什么，比替它猜一个空对象更快收敛。

## 上下文装配与出境整形

送模型前的历史要过两道**不同性质**的闸：[[src/main/agent/context.ts#trimMessages]] 管"装不下"
（按 token 预算裁剪并留摘要），[[src/main/agent/context.ts#historyForModel]] 管"不该出境的东西"
（把空正文且不带工具调用的助手轮换成了占位句）。两者不可合并：前者改条数，后者一条都不许改。

`historyForModel` 存在理由是**形状而不是内容**——Anthropic 对空 text 块直接报 400，而"被停止生成打断的那一轮"
在盘上就是一条空正文；丢掉它会造出两条连续同角色消息（角色交替的另一项要求），所以**换占位句而不是删**。
主循环其实还有第二层兜底：[[src/main/providers/anthropic-agent.ts#toAnthropicAgentMessages]] 本就会丢弃
空正文助手轮。兜底不等于可以省——[[src/main/memory/reflection.ts#createReflectionRunner]] 这条反思链
**不经主循环**，罩不到它。

## 多模态出境：引用与物化的分界线

图片走的是**引用制**：盘上放真身（[[src/main/attachments-store.ts#saveAttachmentImage]]），
消息里只放一条引用（[[src/shared/content-parts.ts#ImageRef]]），
[[src/shared/content-parts.ts#materializeParts]] 在**出站那一刻**才把引用变成 base64。
这条界线不许合并成一件事，理由各自独立且都踩过：base64 进消息 ⇒ 每次存档重写一遍图、
存档预算 `MAX_STORED_CHARS` 被一张截图吃掉、以及 token 估算按字符数放大两个数量级
（[[src/shared/tokens.ts#estimateImageTokens]] 就是为最后这条立的，判据反过来钉："把 base64 掏空，读数一字不变"）。

**为什么 `content` 没改成联合类型**：`parts` 是**可选新增字段**，`content` 仍是文本真相，
不变式 `content === textOfParts(parts)` 由唯一构造点（[[src/shared/attachment-block.ts#userTurnWithMedia]]）
与 store 现取两处保证。改成 `string | block[]` 要动几十处消费者，而漏判那一处的坏法是**静默的**
（`String(块数组)` 变成 `"object Object"` 发给模型，不报错、门禁也不红）。
代价如实记：图文**交错顺序**没做出来，图恒排在文本块之后。

**读盘侧只认白名单文件名**：[[src/shared/content-parts.ts#isSafeAttachmentRef]] 是全仓唯一放行判据，
`ref` 从存档一路传到主进程，收路径就是给穿越留门 —— 与 `mcp/artifacts.ts` 同一口径，
且**两个目录刻意不共用**（MCP 截图是过程资产、随时可清；附件是用户明确发出去的东西）。

**旧轮按配额折回正文 marker**（[[src/shared/content-parts.ts#materializeHistory]]）：
只物化最近一轮，其余退回 `content` 里那条 `<file kind="image" ref=… />`。
读不到文件时**降级成一句人话而不是让整轮失败** —— 反面教材是业界那类"一张图卡死整段会话"：
历史每轮重放，那块图没人清。**已知欠账**：marker 目前只有人能还原，模型没有"再看这张图"的工具通路（K52）。

## 思考档位的出境契约：三型一条裁决线，编码逐模型声明

思考控制有三种互斥形态（[[src/shared/ipc.ts#ReasoningConfig]] 的 `kind`：`effort` 档位 / `toggle` 开关 / `budget_tokens` 预算 / `none` 不支持），
但出境判定**只有一条线**：[[src/shared/reasoning.ts#effortToSend]]（档位吃不吃）+
[[src/shared/reasoning.ts#openaiReasoningFields]]（toggle / 预算发什么字段）+
[[src/shared/reasoning.ts#anthropicThinkingBudget]]（anthropic 通路的 kind 感知预算）。
**切错的下场**：主进程发不发与界面披露各判各的 ⇒ 漂移的症状是"界面说生效、实际没发"——
假开关里最难查的一类，因为两条判定单看都对。

**能力声明住在模型身上，不住在应用里**：`levels` / `offEncoding` / `budgetEncoding` 全是逐模型字段
（[[src/main/schemas.ts#reasoningConfigSchema]]），应用层**不猜厂商方言**——openai-compatible 通路上
"关闭思考怎么说""预算写哪个键"没有统一答案（Qwen / Z.AI / OpenRouter 各不同）。
未声明 ⇒ 一律不发 + 界面照实披露。猜一个字段名，错的坏法是**静默**：端点忽略未知字段返回 200，
用户以为关掉了其实没关。

**「inert 数据永不出境」必须在两条协议上同时成立**：`kind:'none'` 的模型即便存着 `reasoningEffort:'high'`，
openai 侧（`effortToSend` 对非 effort 形态返 null）与 anthropic 侧（[[src/shared/reasoning.ts#anthropicThinkingBudget]] 对 none/toggle 返 null）
都发不出去。实测踩过的洞：anthropic 侧旧判定只看档名不看 `kind`，none 模型照发思考——
R11′ 在 openai 侧收口时，**另一条协议上的同一不变量是漏的**。同类切分切一半，等于没切。

**单字段落盘走 `models:patch-entry` 不走整表保存**：输入框 chip 改一个旋钮，
若复用 `models:save`（整表提交），主窗与设置窗两个渲染进程并发下互相覆盖。
handler 把补丁合进现存档案**合成整表过同一道 `modelSaveSchema`**（[[src/main/schemas.ts#modelPatchEntrySchema]]）
——patch 与 save 的合法性口径必须一致，两道闸各判各的迟早漂成两个口径。

**已知欠账**：anthropic 侧仍是旧预算契约（`EFFORT_BUDGET` 自定四档，官方已转 `output_config.effort`，K59）；
`toggle` 形态眼下没有真实消费者（三家端点全走档位通道）——机制先立，字段留给第一个开关型端点。

## 模型接入：模板面、认证与请求身份

供应商模板是**冻结名单的纯数据**（[[src/shared/provider-presets.ts#listProviderPresets]]）：12 家普通 API/聚合、6 组订阅、2 个自定义入口与 1 个本地网关连接模板；禁用五项只登记官方原因（[[src/shared/provider-presets.ts#listForbiddenPresets]]），**不提供任何生成通路**。模板只含地址、协议面、必填占位、帮助来源与身份/认证缺省，Key、模型偏好与本机清单一律无值；模块导入不联网、不写配置。

**双协议面是显式选择，不是按地址猜**：同一模板可带 `openai-compatible` 与 `anthropic` 两条 `faces`，选中哪条面就决定 `baseURL`、认证缺省与身份策略（[[src/shared/provider-presets.ts#applyPresetFace]]）。切协议必须走 [[src/shared/provider-presets.ts#handleProtocolSwitch]]：目标面存在就同步草稿；模板没有目标面就**清掉不再匹配的模板**、保留用户地址转手填。切错的坏法是地址与协议面各说各话——请求打到一条不存在的面，报错还像厂商返回的。

**认证缺省 unknown 必须 fail-closed**：`auto` 只在模板的逐协议 `authDefault` 非 unknown 时解析成具体头；unknown + auto 拒绝，openai-compatible + x-api-key 拒绝（[[src/shared/provider-presets.ts#resolvePresetAuth]]）。保存前 [[src/shared/provider-presets.ts#presetSaveBlockers]] 一次给全阻断原因；通过后 [[src/shared/provider-presets.ts#mergePresetIntoEntry]] 把身份策略与**已解析的具体认证**合并进条目的 `settings`，id/model/name/metadata 原样保留。**不猜 Key 前缀、不双发互斥头、失败不自动换认证重试**——猜错的坏法是静默 401/403，或把 Key 送进对方不认的头。

**身份策略只落策略字段，运行键禁入档案**：`requestIdentity` 只有 `default` / `self-ua` / `opencode-v1` 三值（[[src/shared/ipc.ts#RequestIdentityMode]]），`authentication` 只有 `auto` / `bearer` / `x-api-key`（[[src/shared/ipc.ts#AuthenticationChoice]]）。两者都进条目级 `settings` 白名单（[[src/main/schemas.ts#modelSaveSchema]]、[[src/main/schemas.ts#modelPatchEntrySchema]]），`strict` 拒收 `sessionId` / `operationId` / `runId` / `headers` 等运行态键；读盘侧只收枚举内值（[[src/shared/models.ts#normalizeProfiles]]）。本包只负责**选择与持久化**；请求期如何注入不在本包写域，图谱不替它背书。

**保存链只有一条**：模板/手填草稿 → `models:save` → [[src/main/schemas.ts#modelSaveSchema]] → [[src/main/store/models.ts#saveEndpoint]] 写 `models.json`；Key 仍按端点 id 单独存 settings.json，一个字节都不进模型档案。单字段补丁走 `models:patch-entry`：handler 把补丁合进现存档案后**整表再过同一道 `modelSaveSchema`**（[[src/main/schemas.ts#modelPatchEntrySchema]]），patch 与 save 的合法性口径不许漂成两份。

**运行验证**：入口判据不是只测渲染字符串——e2e 从 `out/main/index.js` 真入口起，经真 preload 桥、真 IPC 与真落盘；`scripts/verify-shot.cjs` 的 `models:get-metadata` / `models:patch-metadata` 桩必须**有状态**、返回真实 `ModelsView`，`patch` 只写 user 来源并由桩自己盖 `observedAt`。桩返回固定空值或永久 unknown 时，门禁绿着，界面却永远看不到真值。

## 会话并发闸

[[src/main/agent/concurrency.ts#createChatGate]] 是"这条会话能不能开始跑"的**硬闸**，渲染端的
`streaming` 标志只是软约束。三条规则：同会话重复发送直接拒（一条会话跑两轮会自己串自己）、
跨会话放行、总数超上限拒且理由带上限数字。`abort` **只停被点名的那一条**。

开跑前就退回的路径（未配模型 / 未配 Key）**必须把刚占的位子还回去**，否则那条会话在闸里永远"在跑"，
连重发都发不出去。删除会话同样先 `abort`（[[src/main/ipc.ts]] 的 `convDelete`）：只 abort 不 `end`，
位子由那一轮自己的 `finally` 归还——提前 `end` 会让另一轮挤进来，与仍在跑的那一条撞在同一会话上。

## 子代理的工具集装配

子代理**不继承**主代理的实收工具集，而是按 [[src/main/agent/runner.ts#allowedToolsFor]]（权限档 → 全集）
与 [[src/main/agent/runner.ts#subagentToolNamesFor]]（档位 ∩ 该 Agent 自己的声明）两步收口。
这条口径来自一次实测：Agent 定义文件里的 `tools:` 那行此前**对子代理一个字都不生效**。

在此之上另有一层**角色天花板**（高于权限档）：会话级面板工具与派发口对子代理一律收回——
带计划批准闸的 Agent 必须没有派发口，否则确认卡没弹就能经子代理落盘。

## 做事纪律的按工具表取舍

[[src/main/agent/conduct-rules.ts#composeConductRules]] 生成"怎么做事"那段提示词，按**实收工具表**取舍：
手里没有 `run_command` 就不教它怎么用后台命令。提示词不改权限，但会把闲置能力变成被推动的能力，
所以给某一类角色补一段纪律之前，要先问它手里有什么。

## 渲染端的会话归位

一个事实存在两处：顶层字段（当前显示这条）与 `runtimes` 存档（后台那条）。
[[src/renderer/src/store.ts#applyToConversation]] 按**信封里的会话 id** 决定落在哪一处，这是"切会话不串台"的全部机制。
收口（跑完 / 报错 / 点停止）时还要 [[src/renderer/src/store.ts#settleRuntime]] 把存档里那份的 `streaming` 落回
false——运行期事件只更新顶层，不补就留下"答完了还在跑"，净效果是侧栏假标记与别条会话的假并发提示。
收口必须在 `applyToConversation` **已算出的那份存档**上派生，回头拿旧存档再派生一遍会把刚写入的错误原文盖没。

**事件归属先是本地身份匹配，再是会话归位**：`applyToConversation` 只解决"落到哪条会话"；同一会话先后两轮、或旧轮迟到帧，需要 `runMatches` 按尾部 assistant 草稿的 `requestId` 再判一次。新草稿已有身份时，无身份旧帧一律拒收（chunk / reasoning / tool / done / error）；只有目标仍是无身份的旧草稿才保留升级兼容。已删会话的事件不复活，未知会话的告警照旧留痕。`todos` / `subagents` 带身份时同样过归属门；不带身份的会话级后台刷新（一次性任务子代理进度等合法来源）按"会话现场存在"放行。

`sendMessage` 的调用层迟到拒绝也只结束自己的 Promise：尾部仍是本次 `requestId` 且未结算才回滚草稿；已换轮或已结算一律不动，避免旧轮的 invoke rejection 覆盖新轮或已到终态。

## 一次性任务身份与暂停

[[src/main/agent-task-registry.ts#createAgentTaskRegistry]] 为每次任务创建唯一身份与取消源，窗口所有者不能由载荷自报。
查询与停止沿实际 IPC、preload 接到 [[src/renderer/src/components/TasksPanel.tsx#TasksPanel]]；旧任务身份不能停止同窗口的新任务。
停止先成为“正在停止”，内核结束并完成检查点、记忆收尾后才成为终态。
[[src/main/agent/pause-error.ts#AgentPauseError]] 区分协作条件失效与普通工具错误；
[[src/main/agent/loop.ts#runAgentLoop]] 不吞暂停异常，因此同帧后续工具与下一轮模型调用都不会继续。

## 请求策略：本地并发默认化与权限代次合同

请求策略是**每个 run 一份不可变快照**，不是每轮现读的界面状态。入口解析一次，
[[src/main/agent/runner.ts#runAgent]] 在检查点建立后、任何模型调用前冻结，同一次 run 内主循环与全部子代理共享同一引用。

解析出口唯一：[[src/shared/request-policy.ts#resolveRequestPolicy]] 只返回本地只读批的并发上限
（当前固定为 2 路），由 `runAgent` 复制并冻结。冻结之后，主循环
[[src/main/agent/loop.ts#runAgentLoop]] 与全部子代理 [[src/main/agent/scheduler.ts#runSubagents]]
用同一个引用；loop 只接收不解析，scheduler 也不按子代理自己的 `def.model` 另算。
计划批准后的执行阶段带着**相同策略内容**二次进入 `runAgent`，不重新解析用户设置；
但入口处的复制与冻结会生成**新的一份冻结副本**——两次进入各自持有自己的引用，策略内容相同，不承诺跨 run 共用同一对象。

**并发上限不等于并发许可**：上限由 [[src/shared/request-policy.ts#resolveToolBatchConcurrency]] 收口，
[[src/main/agent/tool-batch.ts#runToolBatch]] 消费。只有整批合格（同一真实内建读取对象、键唯一可解析）才拿到 2 路；
不合格批、缺省或非法输入一律回落到 1 路。`maxLocalReadConcurrency` 可被入口收紧为 1，此时 loop 直接走串行路径。

**旧档案字段只读忽略**：历史配置里的 `speedMode` / `serviceTiers` 在读盘时丢弃，不迁移、不写回、不报错；
服务档意图与厂商 `service_tier` 观测已整体移除，消息与结果不再声明相关字段。

**权限代次合同零变动**：[[src/shared/request-policy.ts#PermissionStateSnapshot]] 与
[[src/shared/request-policy.ts#isPermissionGenerationCurrent]] 仍是"档位 + 进程内代次"的共享形状与提交门判据；
非法代次一律按已变化处理，权限收紧/放宽与父子守卫行为不受本策略改动影响。

**本地请求身份与供应商随机身份是两类东西**：`chat:send` 接受渲染端在发起时生成的 UUID（缺省旧调用由主进程补一个），
同一 run 的每个 `StreamEnvelope` 带同一 `requestId`。它只用于本地事件归属与消息持久关联，
**不进模型请求、headers 或日志**；供应商的 `operationId` / `sessionId`（如 `x-opencode-session`）是逐请求随机键，
**不得**当作本地归属或持久化身份。

**信封与结算**：成功 `done` 与失败 `error` 都带同一个本地 `requestId`（早退、零 chunk 失败、取消同样带）；
emitter 的单结算保证 done / error 只发一次，重复终态不累加用量。

**与省 token 四档正交**：`request-policy.ts` 零依赖，不 import [[src/shared/token-tier.ts#resolvePolicy]]，
也不读写四档（`rich | ultimate | balanced | light`）的任一开关。`runAgent` 分别接收 `policy`（TokenPolicy）
与 `requestPolicy`，两条链路互不推导。

## 有界可信读取并行

并行读取是**有界且按资格**的：上限只由 [[src/shared/request-policy.ts#resolveToolBatchConcurrency]] 给出，
普通模式 1 路，FAST 且整批合格时最多 2 路；非法/未知模式或不合格批绝不无界起跑。
资格判定在 [[src/main/agent/loop.ts#planTrustedReadBatch]]：只认工具对象身份与宿主元数据
（[[src/main/agent/tools/file-tools.ts#isTrustedReadTool]]），不认名字或自述能力。
同文件、大小写或 junction 别名、混合读写、MCP 冒名等不合格批必须串行；这是安全契约，不是性能回退。

结果始终按原 `tool_call` 顺序回灌，完成快慢不改变顺序；读版本只经受控读取接口登记，
调用方不得把未提交的结果当作可写资格。[[src/main/agent/loop.ts#runAgentLoop]] 负责在普通串行路径与
合格批路径之间选择，并保证两条路径对调用方呈现同一套消息顺序与终态。

## 工具批提交契约

[[src/main/agent/tool-batch.ts#runToolBatch]] 的合同由 [[src/main/agent/tool-batch.ts#ToolBatchItemResult]] 表达：
启动前同步核 `canStart`，从核验到启动之间不得有 await；取消后不再启动排队项，在途项等结算后标 stale；
单项失败只标该项，不重试、不整批重跑；结果与副作用只在全部结算后的同一同步门提交，
`committed` 为 true 才代表可消费；提交门失效时整批 discard，未启动项使整批失败，不得只提交已成功的项。

「启动瞬间尚未提交」是接口的硬语义：启动项必须显式携带 `committed: false`，`true` 只能由提交门写入。
[[src/main/agent/tool-batch.ts#ToolBatchResult]] 的调用方按 `index` / `item` 与原 `tool_call` 配对，
不得用完成顺序推断归属。
