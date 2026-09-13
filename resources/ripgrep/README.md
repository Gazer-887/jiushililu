# 随包 ripgrep 二进制

本目录存放随应用分发的 `rg`（ripgrep）可执行文件，供 **L0 代码检索**使用。
打包时经 `config/electron-builder.yml` 的 `extraResources` 映射到安装目录下的 `ripgrep/`
（**必须放在 asar 之外** —— asar 里的可执行文件无法 spawn）。

## 为什么二进制要进 git

`rg` 是**运行时依赖**，不是构建期依赖：应用启动后随时可能调用它。
若改为安装时从 `node_modules` 拷贝，则任何一次 `npm ci --ignore-scripts`、
或 CI 缓存命中而跳过 lifecycle script，都会让 `rg` 静默缺席 ——
届时检索会**降级**到内置扫描器，功能"能用但慢且弱"，而用户与 CI 都看不出异常。
本项目已把"降级必须如实报告"立为纪律，但**最好的报告是不需要报告**：
二进制入库可让 `clone` 之后直接可跑，不依赖任何后处理。

代价是仓库体积永久增加约 5.2MB（每个目标平台各一份）。权衡后接受。

## 来源与可追溯性

| 项 | 值 |
|---|---|
| 上游包 | `@vscode/ripgrep`（VS Code 官方维护的 ripgrep 分发） |
| 主包版本 | `1.18.0` |
| 二进制实际所在 | 独立平台包 `@vscode/ripgrep-win32-x64` 的 `bin/rg.exe` |
| ripgrep 本体版本 | `15.0.0 (rev 3a612f88b8)`，编译特性含 `+pcre2` |
| 源文件 SHA-256 | `f9dde63498b3193f098355dbec97af99dc4f6b8fa0df5ed04114a03012c042cb` |
| 随包副本 SHA-256 | 同上（**与上游字节完全一致，无任何加工**） |

校验方式：

```bash
sha256sum resources/ripgrep/rg.exe \
          node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe
# 两行哈希必须相同
```

> 注意：二进制**不得手工放置**。由 `scripts/vendor-ripgrep.cjs` 从
> `node_modules` 对应平台包拷贝，保证可复现。手工拷贝会让哈希与来源脱钩。

## 各平台包名

`vendor-ripgrep.cjs` 按当前平台选择包名，目录内文件名同：

| 平台 | npm 包 | 二进制文件名 |
|---|---|---|
| Windows x64 | `@vscode/ripgrep-win32-x64` | `rg.exe` |
| macOS x64 | `@vscode/ripgrep-darwin-x64` | `rg` |
| macOS arm64 | `@vscode/ripgrep-darwin-arm64` | `rg` |
| Linux x64 | `@vscode/ripgrep-linux-x64` | `rg` |
| Linux arm64 | `@vscode/ripgrep-linux-arm64` | `rg` |

本仓库当前**只入库 win32-x64 一份**（开发者本机平台）。其他平台由各自的
打包机在 `npm run vendor:ripgrep` 时生成 —— 那一步在 CI 上是"有则更好，无则告警"，
**不阻断构建**（见 `scripts/vendor-ripgrep.cjs` 的容错设计）。

## 与"降级"的关系

运行时定位 `rg` 的优先级为：**随包目录 > 环境变量 `JSL_RIPGREP` > 系统 `PATH`**。
三者都找不到时，`search_files` 会退回内置扫描器，**并在工具返回值里写明降级原因**
（`fallbackReason`）。因此：

- 装了包的用户：走随包 `rg`，性能与正确性最好
- 开发态（未打包）：`resourcesPath` 为 `null`，会退到系统 `PATH`
  —— **这是预期行为，不算降级事故**，但工具返回里仍会注明引擎
- 都没命中：走内置扫描器 + 如实报告原因
