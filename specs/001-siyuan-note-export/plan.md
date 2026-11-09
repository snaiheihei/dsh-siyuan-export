# Implementation Plan: 思源一键导出（SiYuan Note Export）

**Branch**: `001-siyuan-note-export` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-siyuan-note-export/spec.md`

## Summary

为 dsh 交付一个**树外插件**：每条助手回复操作栏出现「导出到思源」按钮 → 弹窗（预填 LLM 生成的主题名 + 思源文档树路径选择器，记住上次成功路径）→ 确认后调用宿主 LLM，**仅以该条单次输出为输入、不携带对话上下文**（FR-013）生成主题名并重排为带小图标的结构化笔记 → 经思源 HTTP API 写入所选路径，失败可重试且内容不丢。四域技术路线已拍板（见 [tech-decisions.md](tech-decisions.md)）：dsh 树外插件 + 思源 HTTP API + 宿主 LLM 通道 + 宿主风格自绘 UI，**0 个运行时 npm 依赖**。Phase 0 已实证：按钮挂载点为官方 slot `conversation.chat.assistant-actions`（[research.md](research.md) R1，含注册纪律与定稿消息边界）；LLM 通道 `ctx.llm.prepareCall(config, signal?, configure?)` 与 `listProviders()/listModels()` 解析可用（R2）；思源侧全部走官方 API，同名经查重消歧硬保证不覆盖（R3 + [contracts/siyuan.md](contracts/siyuan.md)）。

## Technical Context

**Language/Version**: TypeScript（Host 侧 Node ≥ 24.9.0；Client 侧浏览器）；宿主基线 dsh `0.2.2-rc.1`（`@deepseek-ai/dsh-root`，pnpm 11 workspace）

**Primary Dependencies**: 运行时 npm 依赖 **0 个**；宿主 Cordis/dsh 包按需声明 `peerDependencies` + `devDependencies`（选型依据：见 [tech-decisions.md](tech-decisions.md)）

**Storage**: 导出产物 → 思源（HTTP API 写入笔记本文档）；插件偏好（上次成功路径、弹窗草稿、导出任务状态） → 宿主数据根 `resolveDshHome()` 下插件自有单一权威状态（原子发布，Markdown 仅作可重建投影，不形成双事实源）；思源 API Token → 插件 Config（凭据不入状态文件/日志/RPC 响应）

**Testing**: Vitest 分层（纯业务单元 → Temp 目录集成 → Client/RPC/handoff 产物）+ 隔离 `DSH_HOME`（web profile）真实 Host E2E；思源与模型均以 fake 边界（fake HTTP 端口 / 假 prepared call）测试，真实小请求单独验证，不以单测冒充端到端

**Target Platform**: dsh Web（浏览器）+ 本机 dsh Host；Windows 优先但不硬编码用户目录与本机路径

**Project Type**: 树外插件（Cordis Host bundle + Client CJS closure-factory handoff，`dsh.bundle.patch` 安装）

**Performance Goals**: 点击 → 弹窗 < 1s；LLM 重排 + 写入 95% < 30s（SC-002）；LLM 输入仅含单次输出以节省 token（FR-013）

**Constraints**: 不修改 dsh 源码与 Session 历史（append-only，不改写既有消息）；错误响应不含堆栈/内部路径/正文秘密；同名文档不覆盖不合并（FR-007）；一次确认只产生一篇笔记（FR-011）；LLM 输入禁止携带对话上下文（FR-013）

**Scale/Scope**: 单用户本机插件；1 个功能切片（单次输出导出）；UI = 1 弹窗 + 1 文档树 + 1 输入框；13 条 FR、6 条 SC

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 为未初始化的占位模板（无已批准原则、无版本与批准日期）→ **本轮无生效门禁，Gate 通过（无约束可违）**。不阻塞 Phase 0；建议特性交付后用 `/speckit-constitution` 初始化项目宪法。

无宪法期间按通用纪律自查（均通过）：

- **树外原则** ✓：不修改 dsh 源码、Remote 注册表与 Session 持久化格式（ADR-0001）
- **数据归属** ✓：状态写 `resolveDshHome()` 数据根下插件自有目录，不写插件仓库、不硬编码用户目录
- **验证分层** ✓：quickstart 覆盖隔离 Host 真实 E2E，四类事实（模型可见/已排队/已持久化/UI 已显示）分别定义确认信号

**Phase 1 设计后复检（Re-check）**：✅ 通过——设计产物（research / data-model / contracts / quickstart）未引入新违例；两个适配器 seam 已过三问并记入 Complexity Tracking；凭据纪律补充落实：思源 Token 只存插件 Config，不入日志、审计、状态文件与 RPC 响应（contracts/siyuan.md）。

## Project Structure

### Documentation (this feature)

```text
specs/001-siyuan-note-export/
├── plan.md              # 本文件（/speckit-plan 输出）
├── spec.md              # 需求规格（含 FR-013 token 约束）
├── tech-decisions.md    # 已拍板选型（/speckit-tech-gate 输出）
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/           # Phase 1 输出（rpc.md、siyuan.md）
├── checklists/
│   └── requirements.md  # 规格质量检查表
└── tasks.md             # Phase 2 输出（/speckit-tasks，本命令不创建）
docs/adr/
├── 0001-out-of-tree-dsh-plugin.md
└── 0002-siyuan-http-api-integration.md
GLOSSARY.md              # 术语权威定义
```

### Source Code (repository root)

```text
src/
├── index.ts                # Host Cordis 入口（name/inject/Config/apply，资源对称清理）
├── contract.ts             # Host/Client 共享 RPC 类型
├── api/
│   └── routes.ts           # webServer.register() 同源 prefix 路由；白名单方法、字段校验、错误映射
├── export/
│   ├── export-service.ts   # 导出编排：状态机（待确认→生成中→成功/失败）、防重、串行队列
│   ├── llm.ts              # 宿主 LLM 适配器：ctx.llm.prepareCall()→stream()；FR-013 输入裁剪、输出预算、降级标题
│   └── format.ts           # 结构化笔记排版：标题层级、要点小图标、代码块/列表保留
├── siyuan/
│   ├── client.ts           # 思源 HTTP API 适配器：Token、错误分类、重试
│   └── tree.ts             # 文档树读取、路径解析与选中位置定位
└── store/
    └── prefs.ts            # 上次成功路径/草稿：单一权威状态，原子发布（临时位置→切换）

client/
├── src/entry.tsx           # Client 入口（inject/apply；dsh.client.platform: web）
├── src/rpc.ts              # 类型化同源请求（与 contract.ts 共享类型，运行时仍校验）
├── src/components/
│   ├── ExportButton.tsx    # 消息操作栏导出按钮（挂载点以 research.md 为准）
│   ├── ExportDialog.tsx    # 导出弹窗：主题名输入 + 路径选择 + 生成中/成功/失败反馈 + 重试
│   └── DocTree.tsx         # 思源文档树选择器（自绘，展开/选中态）
└── src/styles.css          # 对齐宿主主题变量，不引入第二份样式体系

scripts/build-client.mjs   # Client handoff 构建（__ModuleLoader__.load 闭包工厂，无裸 ESM）
cordis.patch.yml           # Host bundle patch（package.json 的 dsh.bundle.patch 指向）
package.json               # 加载契约：type:module、exports["."]、exports["./client"]、engines.dsh、files

tests/
├── unit/                   # 状态机、幂等防重、排版、路径解析、FR-013 输入裁剪（断言不含上下文）
├── integration/            # Temp 目录原子写/锁竞争/删除重建、fake 思源端口、假 prepared call
├── client/                 # slots 注册、RPC 往返、stale response、handoff 产物（factory 执行断言）
└── e2e/                    # 隔离 DSH_HOME 真实 Host：安装→启动→真实 UI→真实模型/思源各自由证据确认
```

**Structure Decision**: 单仓库树外插件，按职责分层（Host `src/` + Client `client/` + 共享契约 `contract.ts` + 分层 `tests/`），不把逻辑塞进入口文件——采用 develop-dsh-plugin 推荐布局，前后端（Host/Client）同仓以保证 RPC 类型单一来源。

## Complexity Tracking

> 仅记录确实需要辩护的复杂度（新模块三问已过：删除测试 → 散到调用方而非消失；两侧真会变且生产+测试两实现；接口明显小于实现）。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| SiYuan / LLM 适配器 seam（`siyuan/client.ts`、`export/llm.ts`） | 外部副作用边界：测试需 fake 端口与假 prepared call；错误分类、重试与 FR-013 输入裁剪集中收口 | 直接在导出服务内调 HTTP/模型流，会让状态机测试依赖真实网络与宿主，且输入裁剪逻辑散落各处无法断言 |
