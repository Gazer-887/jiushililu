This directory defines the high-level concepts, business logic, and architecture of this project using markdown. It is managed by [lat.md](https://www.npmjs.com/package/lat.md) — a tool that anchors source code to these definitions. Install the `lat` command with `npm i -g lat.md` and run `lat --help`.

## 条目

五个主题，按"改动会落在哪一层"切分；每条一句话说清这个文件管什么，细节进对应文件读小节。

- [[agent-kernel]] — Agent 内核：主循环、上下文出境、并发硬闸、子代理工具集装配、渲染端会话归位
- [[memory-evolution]] — 记忆与自进化：分层记忆、注入税、反思链、执行手册回注
- [[storage-conversations]] — 存储与会话正文：追加 + 游标、回滚与撤销、两份校验口径、落盘预算
- [[tools-and-governance]] — 工具层与治理：共享 shell 会话、权限档与确认卡、检查点与命令超时
- [[quality-discipline]] — 判据工程与门禁：五道闸、能红判据、反向验证、隔离验证进程

## 怎么用（人写、机器查）

查询走 CLI，更新走批次纪律；本项目不装 `lat` 的自动钩子，也不配语义检索的 Key。

- 任何改动过 `src/` 里承重逻辑的批次，**同批**更新这里并跑 `lat check`（不补就等着漂移）。
  `lat init` 的 agent hook 刻意**不装**：本项目的 `AGENTS.md` / `CLAUDE.md` 是纯本地共享文件（D-094），
  不许被工具改写。
- ⚠️ **校验一律用 `npx lat.md@0.12.2 check`**（本机全局 `lat` 是 0.11.0：它对文件级与跨文件链接解析不了，会把好链接报成坏链接 —— 实测两条判据都红过）。要全局升就 `npm i -g lat.md`。
- 查询：`lat locate "并发闸"`、`lat section "agent-kernel#会话并发闸"`、`lat refs "agent-kernel#会话并发闸"`。
  `lat search` 需要 `LAT_LLM_KEY`（`sk-` 或 `vck_`），本项目**不配** —— 纯本地零云端是红线。
- **只写"为什么这么切"与"切错的后果"**。调用形状看源码，历史与理由看 `NOTEBOOK/decisions.md`；
  三处各管一件事，合成一份就会两边同时失真。
