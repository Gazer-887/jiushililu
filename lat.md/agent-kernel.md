# Agent 内核

主进程里那台"干活机器"的六件核心事：跑一轮、装配上下文、控并发、按角色收工具、把纪律按实收工具表取舍、
以及渲染端如何把事件按会话归位。这里只写**为什么这么切**与**切错的后果**；
调用形状看源码，历史与理由看 `NOTEBOOK/decisions.md`。

## 主循环与轮次预算

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
不变式 `content === textOfParts(parts)` 由唯一构造点（[[src/shared/attachment-block.ts#userTurnWithImages]]）
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
