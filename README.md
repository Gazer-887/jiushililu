# 九十里路 · Jiushililu

> 行百里者半九十。一个**会自己长经验**的全能 AI 工作台 —— 越用越好用，越用越懂你。

「九十里路」是一个 Electron 桌面端的全能型 AI Agent 工作台。它不与框架、记忆层、MCP 生态竞争，
而是把力气花在 **Agent 内核与自进化闭环**上：干活（Generator）→ 复盘（Reflector）→ 沉淀（Curator）→ 经验手册自动回注上下文（ACE）。

- **模型全自定义接入**：不内置任何模型与 API Key，OpenAI 兼容协议 + Anthropic 原生协议双适配
- **安全底盘**：命令白名单、Key 加密存储（safeStorage）、操作审计、人工卡点
- **学习载体**：本项目同时是一份公开的 Agent 技术学习笔记，开发规范见 [AGENTS.md](./AGENTS.md)

## 当前状态

**P0 骨架阶段**（分期：P0 骨架 → P1 内核 → P2 工作台 → P3 生态 → P4 进化 → P5 成熟）。

P0 已有：Electron + React + TS 三进程骨架、Provider 双适配器、设置页（Key 加密存储 + 测试连接）、流式对话、Vitest 单测、GitHub Actions CI。

## 开发

```bash
npm install        # Electron 二进制自动走 .npmrc 里的国内镜像
npm run dev        # 开发模式（热更新）
npm run build      # 构建（产物在 out/）
npm start          # 运行构建产物（冷启动）
npm test           # 单元测试
npm run typecheck  # 类型检查
npm run lint       # ESLint
```

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
