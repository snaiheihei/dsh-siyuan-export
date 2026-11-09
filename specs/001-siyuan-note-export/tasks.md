---

description: "Task list template for feature implementation"
---

# Tasks: 思源一键导出（SiYuan Note Export）

**Input**: Design documents from `/specs/001-siyuan-note-export/`

**Prerequisites**: plan.md（技术栈/结构）、spec.md（用户故事与优先级）、tech-decisions.md（已拍板选型）、research.md（R1–R5 实证结论）、data-model.md（实体与状态机）、contracts/（rpc.md + siyuan.md）、quickstart.md（验证场景）

**Tests**: **包含测试任务**——依据 plan.md Testing 分层（Vitest 单元/集成/Client + 隔离 Host E2E）与项目 preset 的实现循环（红 → 绿 → 重构，`.specify/presets/spec-addendum/implement-command-wrapper.md`）。每个故事的测试**先写并确认失败（红）**，再实现（绿）；纯配置/文档/环境任务无红灯，报告写「任务 Txxx 无行为变更」。完成勾选时在行尾附当次验证证据：`验证: <命令> → <结果>`（仅认本会话输出，跑不了写「未验证（原因）」）。

**Organization**: 按用户故事分组，每个故事可独立实现、独立测试、独立交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、不依赖未完成任务）
- **[Story]**: 所属用户故事（US1/US2/US3）
- 每个任务带精确文件路径

## Path Conventions

单项目仓库（仓库根 = 本 speckit 项目根），结构按 plan.md Project Structure：Host 侧 `src/`、Client 侧 `client/`、构建 `scripts/`、测试 `tests/`、工程契约 `package.json` / `cordis.patch.yml`。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 工程初始化与加载契约（develop-dsh-plugin 步骤 2）

- [ ] T001 初始化插件工程骨架：`package.json` 加载契约（`type: module`、`main` 与 `exports["."]` 指向 Host 构建产物、`exports["./client"]` + `dsh.client.platform: web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`、`engines.dsh` 对齐宿主 `0.2.2-rc.1`、`files` 覆盖 Host/Client/patch、Cordis/dsh 共享包同时声明 `peerDependencies`+`devDependencies`）、`tsconfig.json`、目录骨架 `src/ client/ scripts/ tests/` —— file: package.json, tsconfig.json
- [ ] T002 [P] 编写 Host bundle patch `cordis.patch.yml`（包根插入行，`name` 为 npm 包名；空层写 `[]`，不写纯注释）—— file: cordis.patch.yml
- [ ] T003 [P] 实现 Client handoff 构建 `scripts/build-client.mjs`：产出 `window.__ModuleLoader__.load({ id, factory(require) {} })` CJS 闭包工厂，无裸 ESM 残留；external 仅用宿主 loader module table 核对过的精确 specifier（React 等基座不得打第二份）—— file: scripts/build-client.mjs
- [ ] T004 配置 Vitest 分层测试与质量脚本：`typecheck`/`lint`/`test`（聚焦与全量）/`build`/`pack`，测试按 `tests/unit tests/integration tests/client tests/e2e` 分层 —— file: package.json, vitest.config.ts
- [ ] T005 [P] 隔离验证环境脚本：独立 `DSH_HOME` + web profile + 独立端口的启动与清理（含 `DSH_AGENTS_HOME` 隔离说明；多行启动逻辑写临时 `.ps1` 用 `pwsh -NoProfile -File` 执行）—— file: scripts/setup-isolated-env.ps1, scripts/teardown-isolated-env.ps1
- [ ] T006 [P] 定义 Host/Client 共享 RPC 类型（按 contracts/rpc.md 全量：请求/响应、统一信封、`ErrorInfo{category,message,retryable}`、category 枚举、`StoragePath`、7 种 status）—— file: src/contract.ts, client/src/rpc.ts

**Checkpoint**: `npm run build`/`test`/`pack` 可跑通，handoff 构建测试（factory 执行、插件 id、apply/inject、external require 断言）通过。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 最小装载切片 + 三个适配器 seam + 偏好存储 + RPC 骨架——US1/US2/US3 共同前置

**⚠️ CRITICAL**: 本阶段完成前不得开始任何用户故事任务

- [ ] T007 Host 最小入口：导出 `name`/`inject`/`Config`/`apply()`，只声明实际使用的 Cordis 服务（`slots`、`llm`、`webServer` 等），Config schema 含 `siyuan.endpoint`（默认 `http://127.0.0.1:6806`）与 `siyuan.token`（必填，凭据不入日志/审计/状态文件），资源注册全部经 `ctx.effect()` 对称清理 —— file: src/index.ts
- [ ] T008 [P] Client 最小切片：经 `ctx.slots.inject('conversation.chat.assistant-actions', cb)` 等待声明存活后 `ctx.slots.register({ name, id: 'siyuan-export', order, locale, inject })` 注册占位按钮（只用 `React.createElement` + `styles.insert(css)`，动态包 priority 低于内置条目）—— file: client/src/entry.tsx, client/src/styles.css
- [ ] T009 最小装载链路验证：源码 → Host 构建 → Client handoff → tarball → 隔离安装 → `--profile web --dump-config`（仅证入选）→ 冷启动 Host → UI slot 出现占位按钮；装载失败按 package.json → patch → exports → inject/external → 产物格式 → Host 日志顺序排障 —— file: tests/client/handoff.test.ts（追加断言）
- [ ] T010 SiYuan 适配器核心：Token 经 Config 读取、`Authorization: Token <token>` 头、POST JSON、**同时处理「非 2xx」与「200 但 code!=0」**、错误分类映射（认证→`siyuan-auth`、连接→`siyuan-connect`、路径→`siyuan-path`）、`/api/system/version` 探活、`AbortSignal` + 有限超时 + retryable 限次退避、响应不含堆栈/内部路径/正文秘密 —— file: src/siyuan/client.ts
- [ ] T011 SiYuan 写入与同名消歧：`createDocWithMd` 封装（`path` 以 `/` 开头、缺失父级自动创建）+ commit 前 `getIDsByHPath` 查重，命中追加 ` (2)`、` (3)`… 后缀保证 FR-007「不覆盖、独立文档」；`pathAmbiguous`/`indexUnavailable` → `siyuan-path` —— file: src/siyuan/client.ts
- [ ] T012 [P] LLM 适配器：`inject = ['llm']`；`listProviders()`→`listModels()`→`resolveModelInfo()` 解析后 `prepareCall(config, signal?, configure?)` → `stream()`（一次性）；`maxTokens` 输出预算；**FR-013 输入裁剪的唯一 prompt 构造点**（输入 = 单次输出 + 最小指令模板，禁止 Session 历史/用户提问/工具输出）；`{title, body}` 结构校验与大小限制；错误分类（`llm-adapter`/`llm-quota`/`llm-timeout`/`llm-structure`）；provider/model 以真实小请求验证（防 `NO_ADAPTER` 误报成功）—— file: src/export/llm.ts
- [ ] T013 [P] 偏好存储：`resolveDshHome()` 数据根下插件自有目录、`version` 字段、`lastPath`/`draft`、**临时位置写全量 → 原子切换**、全部写入同一串行队列、Windows 短暂 `EPERM` 有限退避；localStorage 只作非权威显示缓存 —— file: src/store/prefs.ts
- [ ] T014 RPC 路由骨架：`webServer.register()` 同源 prefix；方法白名单仅 `export.open`/`export.state`/`export.commit`/`export.cancel`/`tree.list`；POST JSON + nonce 自定义头 + body 上限 1MB；逐字段校验（可选参数 `!== undefined`，空字符串不回退为未提供）；统一信封 `{ok:true,data}|{ok:false,error}`；`recordInput` 只记 messageId/taskId 元数据 —— file: src/api/routes.ts
- [ ] T015 [P] 测试替身基座（按 真实→fake→stub→mock 顺序取 fake）：内存版思源 HTTP 端口（含同 path 行为开关）与假 `PreparedLlmCall`（可控 成功/超时/结构不合/NO_ADAPTER）—— file: tests/integration/fake-siyuan.ts, tests/integration/fake-llm.ts

**Checkpoint**: 隔离环境最小装载成功（占位按钮出现，重启无重复注入）；三个 seam 均可注入替身。

---

## Phase 3: User Story 1 - 一键把单次输出导出为思源笔记 (Priority: P1) 🎯 MVP

**Goal**: 每条助手回复操作栏出现「导出到思源」按钮 → 弹窗（预填 LLM 主题名 + 默认上次路径）→ 确认后仅以该条单次输出为输入生成带小图标的结构化笔记并写入思源，成功反馈落点。

**Independent Test**: quickstart **V1、V3、V4、V5A/B** 与 SC-001——完成一次对话，点击该条回复的导出按钮直接确认，所选路径下出现结构化带图标笔记，全程 ≤3 次点击、弹窗 <1s。

### Tests for User Story 1（先写，确认红灯）

> **NOTE: 先写这些测试并运行看见失败（红），断言来自 spec.md 验收标准；再实现使其变绿。**

- [ ] T016 [P] [US1] 状态机单测：幂等键（同 `messageId+contentRevision` 重复 open 不重复调 LLM）、writing 中重复 commit 幂等拒绝（FR-011）、转移表全路径、`degraded-ready` 降级、cancel 中止 —— file: tests/unit/export-service.test.ts
- [ ] T017 [P] [US1] FR-013 负向断言：构造的 prompt **仅含单次输出 + 指令模板**，断言不含用户提问/Session 历史/工具输出（SC 节省 token 硬约束）—— file: tests/unit/llm-prompt.test.ts
- [ ] T018 [P] [US1] 排版单测：要点小图标标注（✅ 📌 ⚠️ 💡）、标题层级、代码块/列表原样保留、`markers` 清单断言（FR-008/FR-009）—— file: tests/unit/format.test.ts
- [ ] T019 [P] [US1] 集成测试：fake 思源 + 假 LLM 全流程 `open→generating→ready→commit→succeeded`、`Prefs.lastPath` 回写（FR-006）、失败时 title/target 不清空（FR-010）—— file: tests/integration/export-flow.test.ts

### Implementation for User Story 1

- [ ] T020 [US1] 导出编排状态机：状态 `generating→ready|degraded-ready→writing→succeeded|failed`、单一 Host 权威状态、同键任务复用、串行写队列、Host 权威防重（按钮禁用仅表现层）、llm→write 编排、`cancel` 触发 AbortSignal、成功回写 Prefs —— file: src/export/export-service.ts（依赖 T010–T014）
- [ ] T021 [US1] 排版器：结构化笔记产出（`{title, body}` → 分节 Markdown、小图标要点、原结构保留、`formatVersion`、body 仅存 Host 不回传 Client）—— file: src/export/format.ts
- [ ] T022 [US1] RPC 方法实现接线：`export.open`（幂等启动生成 + 返回 lastPath）、`export.state`（轮询语义、不返回 body）、`export.commit`（title 校验：trim 后非空、≤128 字符、清理 `<>:"/\|?*` 与控制符、压平换行，清理后为空报错；target 校验）、`export.cancel`；stale taskId 响应丢弃 —— file: src/api/routes.ts（追加）
- [ ] T023 [P] [US1] 导出按钮组件：slot owner `{ messageId }` props、独立 `id: 'siyuan-export'` 与 `order`（与官方 `feedback` 共存不替换）、点击调 `export.open` 并打开弹窗、loading 态 —— file: client/src/components/ExportButton.tsx
- [ ] T024 [US1] 导出弹窗组件：标题输入框「正在生成默认主题名…」占位 → LLM 值自动填入（**用户已编辑则不覆盖**）、「导出」按钮 `ready/degraded-ready` 前不可用、成功反馈含落点（FR-012）、失败保留 title/target 并显示「重试」（FR-010）、关闭时 generating 先 `export.cancel`；样式对齐宿主主题变量 —— file: client/src/components/ExportDialog.tsx, client/src/styles.css（依赖 T025）
- [ ] T025 [P] [US1] Client RPC 与轮询：`export.open/state/commit/cancel` 类型化请求、500ms+jitter 轮询至终态即停、旧 sessionId/taskId 响应不覆盖新弹窗（stale 防护）—— file: client/src/rpc.ts（追加）
- [ ] T026 [US1] 隔离 Host E2E：按 quickstart 走 **V1**（按钮出现/重启无重复注入）、**V2 标题部分**（打开<1s、自动填入不覆盖）、**V3**（真实写入+落点反馈）、**V4**（连点只产生一篇、同键 open 不重复调 LLM）、**V5A/B**（真实小请求 + prompt 不含上下文复核），证据留存于任务行 —— file: tests/e2e/

**Checkpoint**: US1 独立可用即 MVP——可停止验证、演示。

---

## Phase 4: User Story 2 - 挑选并记住思源存放位置 (Priority: P2)

**Goal**: 弹窗内嵌思源文档树选择器（笔记本 → 子文档逐层懒加载），任选层级为落点，记住并默认最近一次成功导出的位置。

**Independent Test**: quickstart **V2 完整**（树逐层展开、默认路径=上次成功位置、改选后落点跟随）与 **V3**（笔记出现在所选层级）。

### Tests for User Story 2（先写，确认红灯）

- [ ] T027 [P] [US2] 文档树服务测试：`lsNotebooks` 笔记本层、`query/sql` 子文档层行映射（**显式 LIMIT + 稳定排序**，列名以实测校正）、`file/readDir` 官方兜底、`siyuan-connect`/`siyuan-auth` 错误映射、`hpath → parentSegments` 切分 —— file: tests/unit/siyuan-tree.test.ts
- [ ] T028 [P] [US2] DocTree 组件测试：懒加载展开（按层 `tree.list`）、stale 响应丢弃、选中态、`lastPath` 默认选中、失败就地重试 —— file: tests/client/doc-tree.test.tsx

### Implementation for User Story 2

- [ ] T029 [US2] 文档树服务：`src/siyuan/tree.ts`——笔记本层 `POST /api/notebook/lsNotebooks`，子文档层 `POST /api/query/sql` 懒加载（显式 `LIMIT/OFFSET` + 稳定排序），备选 `file/readDir` + `getPathByID` 兜底；`lsDoc` 仅实测稳定后才可作优化（未公开接口不作依赖）—— file: src/siyuan/tree.ts
- [ ] T030 [US2] RPC `tree.list` 实现：`{notebookId?, docId?}` 参数语义（两者皆空=列笔记本）、节点 `{id,name,kind,notebookId,hasChildren,path}`、只读错误映射 —— file: src/api/routes.ts（追加）
- [ ] T031 [US2] 文档树选择器组件：展开/选中/`hasChildren` 懒加载、选中即 `StoragePath`（notebookId + parentSegments + display）、失败就地显示原因与重试；接入弹窗路径选择区 —— file: client/src/components/DocTree.tsx, client/src/components/ExportDialog.tsx（追加）
- [ ] T032 [US2] `lastPath` 记忆接线：打开弹窗默认选中 `Prefs.lastPath`（首次 null → 笔记本根可直接导出）、用户改选即时生效、成功导出后回写（T020 已实现回写，此处接默认选中）—— file: client/src/components/ExportDialog.tsx（追加）
- [ ] T033 [US2] 隔离 Host E2E：quickstart **V2 完整** + **V3 落点跟随**——逐层展开、默认路径、改选后笔记出现在新层级，证据留存 —— file: tests/e2e/

**Checkpoint**: US1+US2 均可独立测试通过。

---

## Phase 5: User Story 3 - 出错可恢复、内容不丢 (Priority: P3)

**Goal**: 失败场景全部可恢复：明确原因 + 重试入口、已填内容不丢、防重复提交、LLM 失败降级可导出、生成中取消无半成品。

**Independent Test**: quickstart **V6 a–d**、**V7** 与 SC-005/SC-006——断开思源导出失败显示原因与重试且字段保留；恢复后重试成功仅一篇；LLM 失败走降级标题仍可导出；同名两次独立文档。

### Tests for User Story 3（先写，确认红灯）

- [ ] T034 [P] [US3] 错误分类映射单测：非 2xx、`200+code!=0`、`pathAmbiguous`/`indexUnavailable`、`NO_ADAPTER`/配额/超时 → 各自 category、retryable 与用户可读文案（不含堆栈/内部路径/正文秘密，FR-010）—— file: tests/unit/error-mapping.test.ts
- [ ] T035 [P] [US3] 失败恢复单测：写失败 → `retry` **复用缓存 body 不重调 LLM**（token 守卫）、title/target 全程不清空、生成中 cancel 中止流、任务表清理无半成品 —— file: tests/unit/recovery.test.ts

### Implementation for User Story 3

- [ ] T036 [US3] 错误文案与重试 UI 打磨：`siyuan-auth` 引导（思源 设置 → 鉴权 → API token + 插件 Config 配置指引）、`siyuan-connect`（引导启动思源）、`llm-adapter`（引导检查模型配置）、`siyuan-path`（引导重选路径）四类必备文案；「重试」复用同 taskId（Host 缓存 body）—— file: client/src/components/ExportDialog.tsx（追加）, client/src/styles.css
- [ ] T037 [US3] 注入故障 E2E：quickstart **V6a**（关思源→失败→恢复→重试仅一篇）、**V6b**（LLM 断开→`degraded-ready` 首行截断标题仍可导出）、**V6c**（生成中关闭→无半成品）、**V6d**（删目标路径→`siyuan-path` 重选）、**V7**（同名两次独立文档、数万字长回复不截断），证据留存 —— file: tests/e2e/

**Checkpoint**: 三个故事全部独立可用，SC-005/SC-006 达成。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事收尾与交付检查

- [ ] T038 [P] 文案与 locale：slot `locale` 命名空间接入、按钮/弹窗/错误文案中文一致性 —— file: client/src/entry.tsx, client/src/components/*
- [ ] T039 [P] 打包与安装检查：`prepack` 构建、`npm pack` tarball 内容核对（`files` 覆盖 Host/Client/patch/locale；**不含** node_modules、测试数据、真实 `$DSH_HOME`、日志、凭据）—— file: package.json, scripts/pack-check.mjs
- [ ] T040 安全与秘密扫描：断言 Token 不出现在日志、审计、状态文件与 RPC 响应；对产物与错误文案做高置信秘密扫描 —— file: tests/unit/secret-scan.test.ts
- [ ] T041 quickstart 全矩阵回归（V0–V7）与性能核对：SC-001（≤3 次点击、弹窗<1s）、SC-002（95% <30s）、SC-003/004 抽样评估，结果记录回 quickstart —— file: quickstart.md, tests/e2e/
- [ ] T042 文档与交付一致性收尾：插件 README（安装/配置 Token/使用/未验证边界清单）、spec/plan/tasks/contracts 与 GLOSSARY 交叉同步、按 develop-dsh-plugin「完成检查」逐项核对 —— file: README.md, specs/001-siyuan-note-export/tasks.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，立即可开始
- **Foundational (Phase 2)**: 依赖 Setup 完成——**阻塞全部用户故事**
- **US1 (Phase 3)**: 依赖 Foundational 完成——**MVP**
- **US2 (Phase 4) / US3 (Phase 5)**: 均依赖 US1 完成（US2 在弹窗上加树选择器，US3 在导出链路上加故障面）；**US2 与 US3 相互独立，可并行**
- **Polish (Phase 6)**: 依赖所选故事全部完成

### 关键任务依赖

```text
T001 → T004（scripts 挂到 package.json）
T007 → T008 → T009（入口 → 占位切片 → 装载链路验证）
T010 → T011（适配器核心 → 写入消歧，同文件）
T006 → T014 → T020/T022（类型 → 路由骨架 → 编排/方法实现）
T015 → T019（替身 → 集成测试）
T025 → T024（Client RPC → 弹窗调用）
T020 → T023/T024（编排 → UI 接线）
T029/T030 → T031（树服务/路由 → 树组件）
```

### User Story Dependencies

- **US1 (P1)**: Foundational 后即可开始，不依赖其他故事
- **US2 (P2)**: 依赖 US1 的弹窗骨架；树服务（T029/T030）本身只依赖 Foundational，可提前并行开发
- **US3 (P3)**: 依赖 US1 的导出链路；测试任务（T034/T035）可与 US2 并行

### Within Each User Story

- 测试先写并确认红灯 → 实现变绿 → 全绿下重构（preset 红→绿→重构）
- 状态机/服务先于 UI；RPC 服务端先于 Client 调用
- 故事完成 → 独立验证（quickstart 对应用例）→ 再进下一故事

### Parallel Opportunities

- Setup：`T002 ∥ T003 ∥ T005 ∥ T006`（不同文件），与 `T001/T004` 分组串行
- Foundational：`T008 ∥ T012 ∥ T013 ∥ T015`；`T010 → T011` 同文件串行
- US1 测试：`T016 ∥ T017 ∥ T018 ∥ T019`（红灯可一次跑齐）
- US1 实现：`T023 ∥ T025` 与 `T020/T021/T022/T024` 分组
- US2 测试：`T027 ∥ T028`；US3 测试：`T034 ∥ T035`
- **US2 ∥ US3**：两个故事阶段整体可并行
- Polish：`T038 ∥ T039`

---

## Parallel Example: User Story 1

```text
# 红灯批次（全部并行，不同文件）：
Task: "T016 状态机单测 tests/unit/export-service.test.ts"
Task: "T017 FR-013 负向断言 tests/unit/llm-prompt.test.ts"
Task: "T018 排版单测 tests/unit/format.test.ts"
Task: "T019 集成测试 tests/integration/export-flow.test.ts"

# 实现批次（T023/T025 并行，其余按依赖串行）：
Task: "T025 Client RPC client/src/rpc.ts"
Task: "T023 按钮组件 client/src/components/ExportButton.tsx"
→ T020 编排 → T021 排版 → T022 服务端接线 → T024 弹窗 → T026 E2E
```

---

## Implementation Strategy

### MVP First（仅 User Story 1）

1. 完成 Phase 1: Setup
2. 完成 Phase 2: Foundational（**关键——阻塞所有故事**）
3. 完成 Phase 3: US1
4. **停止并验证**：按 quickstart V1/V3/V4/V5 独立测试 US1
5. 可演示即交付候选（弹窗默认路径可用 `lastPath=null → 笔记本根`，树选择器留待 US2）

### Incremental Delivery

1. Setup + Foundational → 地基就绪（占位按钮可见）
2. + US1 → 独立测试 → 演示（**MVP**）
3. + US2 → 独立测试 → 演示（树选择 + 路径记忆）
4. + US3 → 独立测试 → 演示（故障面全覆盖）
5. + Polish → quickstart 全矩阵回归 → 交付

### Parallel Team Strategy

1. 全队先做 Setup + Foundational
2. 就绪后：开发者 A = US1（MVP，优先），US1 完成后 B = US2、C = US3 并行
3. 各故事独立集成，互不阻塞

---

## Notes

- `[P]` = 不同文件且不依赖未完成任务；同文件任务一律串行
- `[Story]` 标签仅用于故事阶段任务；Setup/Foundational/Polish 不带故事标签
- 测试先红后绿；坏测试反模式（实现耦合/同义反复/横向切片）按 preset 规避，走**纵向切片**（一个测试 → 一个实现 → 一个重构）
- 测试替身顺序：真实实现 → fake → stub → mock（本特性用 fake 思源端口与假 prepared call）
- 每个任务勾选时附当次会话的验证证据；未跑写「未验证（原因）」
- 每个故事完成后停在 Checkpoint 独立验证，避免跨故事回归
