# 九十里路 · Jiushililu

> 行百里者半九十。一个**会自己长经验**的全能 AI 工作台 —— 越用越好用，越用越懂你。

「九十里路」是一个 Electron 桌面端的全能型 AI Agent 工作台。它不与框架、记忆层、MCP 生态竞争，
而是把力气花在 **Agent 内核与自进化闭环**上：干活（Generator）→ 复盘（Reflector）→ 沉淀（Curator）→ 经验手册自动回注上下文（ACE）。

- **模型全自定义接入**：不内置任何模型与 API Key，OpenAI 兼容协议 + Anthropic 原生协议双适配
- **安全底盘**：命令白名单、Key 加密存储（safeStorage）、操作审计、人工卡点
- **学习载体**：本项目同时是一份公开的 Agent 技术学习笔记，开发规范见 [AGENTS.md](./AGENTS.md)

## 当前状态

**v0.13.47**（分期：P0 骨架 → P1 内核 → P2 工作台 → P3 生态 → P4 进化 → P5 成熟）。

- **已完成**：P0 骨架（三进程 + 双协议 Provider + 流式对话 + Key 加密存储）· P1 内核（主循环 +
  工具层 + 三档权限门控 + 检查点回滚 + JSON 分层会话存储）· P2 工作台（工作台分栏 /
  Monaco 编辑与 Diff 审查 / 内置终端（真 PTY，node-pty N-API）/ 资源管理器 / 内置浏览器 /
  多会话并发 / 用量计量与省 token 档位 / 系统集成开关 / 子 Agent 管理 / 模型分组切换 /
  任务栏自动折叠 / 电脑控制开关）
- **已落地**：P4 进化**四环全闭** ——
  ① 语义记忆（两条写入通路：模型 `remember` / 用户选中即记；影响面三分类；注入与预算截断；
  事件流；三条架构守卫；右抽屉记忆页签与写入痕迹面板）
  ② 自动捕获（会话切换异步反思 → 候选**物理隔离**在 `memory/candidates/` → 批准/拒绝/冲突标记；
  前置门 2KB；日上限与队列）
  ③ Playbook（`evolution/playbooks/` 布局，tags 条件召回，预算与语义记忆分开；
  `save_playbook` / `recall_playbook` 已注册下发；右抽屉 Playbook 页签）
  ④ 遗忘与度量（LRU 遗忘 + style 豁免；描述相似度警告；纠正通路 + 重复纠正率 / 误伤率）
- **未开始**：P3 生态（MCP 客户端 / 技能 / 规则 / 插件）；P5 成熟缺端到端测试与可观测面板
- 逐条状态见 `PLAN/`（`plan1` 分区 · `plan7` 工作台 · `plan8` 技术债 · `plan19` 记忆批）；
  最新一次全项目对账见 `docs/交接-全项目对账-26.09.13.md`（`docs/交接*.md` 不入库）

> ⚠️ **关于记忆的安全声明（如实，不是免责套话）**
> 记忆层做了三道防线：**架构守卫**（记忆层代码物理上碰不到权限设置）、**写入侧判定**
> （授权语义拒写 + 凭据形状硬拒）、**可见性**（写入痕迹面板 + 巡检区）。
> 但它们是**必要非充分条件，不是"已解决"**：判定是关键词与形状匹配，可被同义改写绕过；
> 只读权限档也具备**出境与操作远端页面**的能力；记忆文件是 userData 下的**明文 markdown**，
> 本机任意进程可读。请把巡检区当习惯用，别把护栏当承诺信。
> ⚠️ 自动捕获（反思）会**读会话正文**并可能产出候选记忆；候选在用户批准前**不进注入索引段**，
> 且**物理隔离**在独立目录。但反思本身是一次**出境的模型调用**，请据此决定是否开启。

## 开发

```bash
npm install        # Electron 二进制自动走 .npmrc 里的国内镜像
npm run dev        # 开发模式（热更新）
npm run build      # 构建（产物在 out/）
npm start          # 运行构建产物（冷启动）
npm run dist       # 打包 Windows 安装包 + 便携版（产物在 dist/）
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run lint       # ESLint
```

> 换应用图标：替换 `resources/icon-source.jpg` 后运行 `D:/MiniConda3/envs/ai_env/python.exe scripts/make_icons.py`（需 Pillow），重新 `npm run dist` 即可。

## 目录结构

```
src/
  main/       主进程：Agent 内核（规划）、Provider、设置存储、IPC
  preload/    预加载脚本：contextBridge 受控桥
  renderer/   渲染进程：React UI
  shared/     主/渲染共享类型与 IPC 通道定义
tests/
  unit/       单元测试（Vitest）
  e2e/        端到端测试（Playwright，后续阶段）
config/       全部构建 / 类型 / 检查配置
.github/      CI 工作流
```

架构与分期详情见 `PLAN/`（内部文档）；项目约定以 [`AGENTS.md`](./AGENTS.md) 为唯一真相源。

## License

MIT
