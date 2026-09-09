# AGENTS.md — 项目级底层规范

> 本文件是本项目的最高约定，优先级高于通用模板与个人习惯。
>
> **命名说明**：`AGENTS.md` 是跨工具事实标准（Linux Foundation AAIF 托管，Codex / Cursor /
> OpenCode / Copilot / Windsurf / Cline / Roo / Amp / Zed / Jules 等 10+ 工具原生读取）。
> 但 **Claude Code 只读 `CLAUDE.md`**，故根目录另有一个 `CLAUDE.md` 桥接文件，
> 内容仅一行 `@AGENTS.md` 用于导入本文件。**改约定一律改这里，不要改桥接文件。**
> 全局规范见 `~/.workbuddy/NORMS.md`（WorkBuddy 适配版，权威），本文件只写项目特有约定。
> 初始化/恢复/重大操作前，**必须先读本文件 + 全局 NORMS + `NOTEBOOK/` + `PLAN/`**。

## 一、项目定位

- **名称**：**九十里路**（Jiushililu），仓库名 `jiushililu`。
- **形态**：**Electron 桌面应用**，全栈 TypeScript。定位为**全能型 AI 工作台**（对标 WorkBuddy / Qoder / Trae 量级的完整工具链）。
- **核心卖点**：**自进化 —— 越用越好用，越用越懂你**。技术主轴为 ACE 三角色闭环（干活 → 复盘 → 沉淀 → 手册自动回注）。
- **第一性质：学习载体。** 本项目的首要目的是**学习和积累经验**，不是商业竞争。
  因此可以胆大心细：技术上该踩的坑可以踩，但不做无意义的重复造轮子；
  选型偏好**能覆盖 Agent 技术全貌**的方案，而不是最省事的方案。
- **第二性质：公开作品。** 代码提交 GitHub 公开，要求工程完备度达标（测试、CI、类型、文档、日志）。
- **目标受众**：所有开发者。README 需要硬核架构图和可复现的 benchmark。

### 范围：六层能力全部要做

交互层（对话/资源管理器/编辑器/Diff 审查/终端/内置浏览器）、Agent 内核（主循环/任务分解/上下文管理/多 Agent 编排/任务摘要）、
工具层（文件读写/命令执行/代码搜索/网页检索/Git）、协议与生态（MCP/技能/规则/插件）、
记忆与进化（四层记忆/自进化闭环/用户画像/经验手册）、治理与工程（权限门控/检查点回滚/成本统计/多模型路由）。

### 关键策略（不可动摇）

1. **"全能"靠生态，不靠自研** —— 内核只做最通用的六件事（读/写/命令/搜索/终端/网页），其余能力由 MCP server 与技能包扩展。
2. **能借就借** —— 编辑器用 Monaco、终端用 xterm.js、UI 用 React 组件库。力气全部花在 Agent 内核与自进化上。
3. **分期交付** —— P0 骨架 → P1 内核 → P2 工作台 → P3 生态 → P4 进化 → P5 成熟，每期结束都是可运行版本。
4. **复用前辈经验（项目级开发规范）** —— 当前已有大量成熟的开源 Agent / IDE 项目（Claude Code、Aider、Cursor、OpenCode、Cline、Roo、Continue 等），其架构取舍与踩坑**完全可以复用**。
   在做决策、想实现方案、定接口前，**先检索前辈怎么做**，能借就借、能对照就对照，不闭门造车；借用要明确来源、理解其适用边界，再落到本项目约定里。
   检索动作：先查 `DIARY/专题-*.md` 与 `NOTEBOOK/decisions.md` 是否已有结论，再向外查官方文档 / 源码 / 社区讨论。

## 二、DIARY 铁律（用户强制约定，不可绕过）

**`DIARY/` 是写给用户本人看的学习日记目录。不入 git，不主动贴进对话（除非用户要求）。**

### 记什么

每一轮开发中，凡是用户可能不懂的**名词、概念、技术、缩写、设计思想**，以及
**用户问了什么 → 答案是什么 → 理解了什么**，一律写进来。

### 文件命名（全中文，写给人看）

```
DIARY/
  说明.md              索引与本目录用法
  术语词典.md          术语词典 —— 新术语一律追加到这里
  diary-YY.MM.DD.md    当天日记，例 diary-26.09.09.md
  专题-XXX.md          深挖的专题，中文命名
```

### 硬要求

- **教材级标准（2026-09-09 用户升级）** —— DIARY 将**复用为教材**：内容必须**准确、真实、完整**。
  事实拿不准先查证再写；查不到标注「待验证」，绝不编造数字；引用数据带出处与时间
- **术语全收录** —— 开发全程遇到的**专有名词一律进 `术语词典.md`**，发现缺漏随发现随补，不等用户问
- **全中文命名** —— 这是给人读的目录，不是给机器读的
- **排版优先** —— 用标题、分隔线、表格、引用块分层；**禁止 emoji**；
  语气可以口语，内容必须扎实
- **术语三件套** —— ① 一句话说清是什么 ② 一个生活化类比 ③ 在本项目里用在哪
- **一天结束后必须整理** —— 当天零散问答整理成结构化日记，**禁止堆流水账**
- **禁止**只罗列英文缩写不解释；**禁止**把不懂的东西糊弄过去
- 讲解给用户时，术语一律**先白话解释再用**，不默认用户懂
- **安安的职责**：每次学习或讨论告一段落，**主动提醒用户把笔记整理进 DIARY**

### 三个笔记位置的分工

| 位置 | 记什么 | 给谁看 |
|------|--------|--------|
| `DIARY/` | **学习知识** —— 名词是什么、技术原理、行业怎么做、今天问了什么 | 用户本人 |
| `NOTEBOOK/learnings.md` | **工程教训** —— 踩了什么坑、流程怎么改进 | 开发留痕 |
| `NOTEBOOK/decisions.md` | **决策理由** —— 为什么选它、否决了什么 | 开发留痕 |

## 三、目录约定（根目录保持干净）

**根目录整洁铁律**：根目录只放「工具硬性要求 or 约定俗成」的少量文件，其余一律收纳进子目录。
允许留在根目录的文件：`package.json`、`README.md`、`AGENTS.md`、`CLAUDE.md`、`.gitignore`、`.gitattributes`、`.npmrc`、`.git/`。
所有构建/类型/检查配置进 `config/`，CI 进 `.github/workflows/`，禁止在根目录堆散装单文件。

| 目录 | 用途 | 入 git |
|------|------|:------:|
| `src/` | 源码（见下方子树） | ✅ |
| `src/main/` | 主进程：Agent 内核、工具、记忆、进化、Provider、治理、MCP、存储 | ✅ |
| `src/preload/` | 预加载脚本（contextIsolation 桥，暴露受控 IPC） | ✅ |
| `src/renderer/` | 渲染进程：React UI | ✅ |
| `src/shared/` | 主/渲染共享类型与 IPC 通道定义 | ✅ |
| `tests/` | 测试 | ✅ |
| `tests/unit/` | 单元测试（Vitest） | ✅ |
| `tests/e2e/` | 端到端测试（Playwright） | ✅ |
| `config/` | 构建/类型/检查配置（见下方清单） | ✅ |
| `docs/` | 对外文档（架构、设计、使用说明） | ✅ |
| `scripts/` | 工具脚本 | ✅ |
| `resources/` | 静态资源、示例配置 | ✅ |
| `.github/workflows/` | CI 工作流（如 `ci.yml`） | ✅ |
| `README.md` / `AGENTS.md` / `CLAUDE.md` | 项目说明与规范（含桥接） | ✅ |
| `NOTEBOOK/` | 开发过程笔记（progress/problem/decisions/learnings） | ❌ |
| `PLAN/` | 计划文档 `planN_中文关键字.md` | ❌ |
| `DIARY/` | **学习日记（全中文命名）**：`diary-YY.MM.DD.md`、`术语词典.md`、`专题-*.md` | ❌ |
| `.workbuddy/` | WorkBuddy 内部数据（含 memory/） | ❌ |

`config/` 收纳清单（工具均支持通过 flag / package.json 指向非根路径）：

```
config/
  electron.vite.config.ts   electron-vite 构建配置（--config 指定）
  electron-builder.yml     electron-builder 打包配置（package.json build.config 指向）
  tsconfig.base.json       公共 TS 预设
  tsconfig.main.json       主进程 TS 配置（extends base）
  tsconfig.renderer.json   渲染进程 TS 配置（extends base）
  eslint.config.js         ESLint 扁平配置
  .prettierrc.json         Prettier 配置
  vitest.config.ts         单元测试配置
  （待建）tsconfig.node.json       工具链 TS 配置（P1）
  （待建）playwright.config.ts     端到端测试配置（P2 e2e）
```

> 注：P0 落地时新建这些配置文件并写入 `config/`，同步在 `package.json` 脚本里用 `--config` / `build.config` 指回，避免根目录散装。

## 四、进度追踪（强制，不可跳过）

- `NOTEBOOK/progress.md` — **每完成一个子任务立即更新**，标注当前处于七步流程的哪一步
- `NOTEBOOK/problem.md` — 发现/修复问题立即更新
- `NOTEBOOK/decisions.md` — 技术/架构/产品决策立即更新（含否决的方案与理由）
- `NOTEBOOK/learnings.md` — 踩坑与经验教训（区别于 `DIARY/` 的**知识学习**，这里记**工程教训**）
- 任务真相源以 WorkBuddy TaskList 为准，二者互补不冲突

## 五、七步流程

```
澄清 → 计划 → 计划验证 → 分工 → 落盘 → 交叉验证 → 交付
```
不得跳步；计划验证（>30min 项目）与交叉验证（≥2 独立子代理）为**强制步骤**。
**澄清 / 计划两步必须先检索前辈经验**（见关键策略第 4 条），把可复用的方案先摆上桌，再决定自研哪些。

## 六、Git 规范

- 用 **Bash（Git Bash）** 执行 git，不用 PowerShell / cmd
- 默认分支 `master`；用户 `Gazer / gazer@users.noreply.github.com`
- 提交走 `/commit` 技能，推送开 PR 走 `/commit-push-pr`
- 提交信息末尾附 `Co-Authored-By: Anan (WorkBuddy) <noreply@local>`
- 查询操作直接执行；commit/push/merge 需用户确认
- **Git Bash 路径转换坑**：`taskkill /F` 这类带 `/` 开关的 Windows 命令，用 `cmd //c "..."` 包裹

## 七、环境

- Python 统一用 `ai_env`（`D:\MiniConda3\envs\ai_env`），不新建冗余环境
- 下载走三层 fallback：直连 → 国内镜像（pip 清华 / npm 阿里）→ 开代理（Clash Verge `127.0.0.1:7897`）
- 大文件（>10MB）下载必须让用户看见进度，禁止前台长阻塞

---
_最后更新：2026-09-09_
