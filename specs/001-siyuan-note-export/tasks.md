---

description: "Task list template for feature implementation"
---

# Tasks: 思源一键导出（SiYuan Note Export）

**Input**: Design documents from `/specs/001-siyuan-note-export/`

**Prerequisites**: plan.md（技术栈/结构）、spec.md（用户故事与优先级）、tech-decisions.md（已拍板选型 D1–D8）、research.md（R1–R9 实证结论）、data-model.md（实体与状态机）、contracts/（rpc.md + siyuan.md）、quickstart.md（验证场景）；过程纪律（工程形态、最小装载链路、Session/RPC/持久化边界、隔离 E2E、避坑速查）全程参照 `develop-dsh-plugin` skill（`~/.dsh/skills/develop-dsh-plugin/SKILL.md`）

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

- [X] T001 初始化插件工程骨架：`package.json` 加载契约（`type: module`、`main` 与 `exports["."]` 指向 Host 构建产物、`exports["./client"]` + `dsh.client.platform: web` + `dsh.client.inject`（声明提供 slots/locale 的宿主包图边，不能替代 Client `external`）+ `dsh.client.external`（非基座共享模块精确 specifier）+ `dsh.bundle.patch` 指向 `cordis.patch.yml`、`engines.dsh` 对齐宿主 `0.2.2-rc.1`、`files` 覆盖 Host/Client/patch、Cordis/dsh 共享包同时声明 `peerDependencies`+`devDependencies`）、`tsconfig.json`、目录骨架 `src/ client/ scripts/ tests/` —— file: package.json, tsconfig.json — 验证: `npm install` → exit 0（247 包，file: 依赖落为 Junction 指向检出）；`npm run typecheck` → exit 0；纯配置无行为变更
- [X] T002 [P] 编写 Host bundle patch `cordis.patch.yml`（包根插入行，`name` 为 npm 包名；空层写 `[]`，不写纯注释；Cordis 行 `id` 与 Client factory 包名 `id` 属不同命名空间；由 `dsh.bundle.patch` 自动挂载，不手改宿主生成 bundle）—— file: cordis.patch.yml — 验证: 未执行（patch 加载归 T009 隔离链路）；纯配置无行为变更，结构对齐官方 decoration/host-plugin 模板
- [X] T003 [P] 实现 Client handoff 构建 `scripts/build-client.mjs`：产出 `window.__ModuleLoader__.load({ id, factory(require) {} })` CJS 闭包工厂，无裸 ESM 残留；external 仅用宿主 loader module table 核对过的精确 specifier（React 等基座不得打第二份）；**同步创建构建测试** `tests/client/handoff.test.ts`（执行 factory，断言插件 id、`apply`、`inject` 与 external require，而非只看构建退出码）—— file: scripts/build-client.mjs, tests/client/handoff.test.ts — 验证: `npm test` → 红（产物缺失 exit 1）→ `npm run build:client` → exit 0（bundle 1018b → handoff 1322b）→ `npm test` → 1/1 pass
- [X] T004 配置 Vitest 分层测试与质量脚本：`typecheck`/`lint`/`test`（聚焦与全量）/`build`/`pack`，测试按 `tests/unit tests/integration tests/client tests/e2e` 分层 —— file: package.json, vitest.config.ts — 验证: `npm run typecheck` → exit 0；`npm run lint` → exit 0（修复 .ps1 误入 files glob）；vitest 红绿轮次运行正常
- [X] T005 [P] 隔离验证环境脚本：独立 `DSH_HOME` + web profile + 独立端口的启动与清理（`DSH_AGENTS_HOME` 不随 `DSH_HOME` 自动隔离，需另设；`EADDRINUSE` 时识别并只停止自己的遗留测试进程，不盲目换端口或杀进程；多行启动逻辑写临时 `.ps1` 用 `pwsh -NoProfile -File` 执行）—— file: scripts/setup-isolated-env.ps1, scripts/teardown-isolated-env.ps1 — 验证: Parser 语法 0 错；`pwsh -File setup → teardown` 全链路 exit 0/0，随机端口+dot-source env 脚本产出、测试目录已删除
- [X] T006 [P] 定义 Host/Client 共享 RPC 类型（按 contracts/rpc.md 全量：请求/响应、统一信封、`ErrorInfo{category,message,retryable}`、category 枚举、`StoragePath`、7 种 status）—— file: src/contract.ts, client/src/rpc.ts — 验证: `npx -p typescript@5.9 tsc --noEmit --strict src/contract.ts client/src/rpc.ts` → exit 0

**Checkpoint**: `npm run build`/`test`/`pack` 可跑通，handoff 构建测试（factory 执行、插件 id、apply/inject、external require 断言）通过。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 最小装载切片 + 三个适配器 seam + 偏好存储 + RPC 骨架——US1/US2/US3 共同前置

**⚠️ CRITICAL**: 本阶段完成前不得开始任何用户故事任务

- [X] T007 Host 最小入口：导出 `name`/`inject`/`Config`/`apply()`，只声明实际使用的 Cordis 服务（`slots`、`llm`、`webServer` 等），Config schema 含 `siyuan.endpoint`（默认 `http://127.0.0.1:6806`）与 `siyuan.token`（必填，凭据不入日志/审计/状态文件），资源注册全部经 `ctx.effect()` 对称清理、重复 dispose 安全；宿主 config 覆盖是**整体替换而非深合并** —— file: src/index.ts — 验证: `npx vitest run tests/unit/config.test.ts` → 红（src/index 加载失败）→ 实现后 5/5 pass；`npm run typecheck` → 0；`npm run lint` → 0；`npm run build:host` → exit 0（1.2kb）
- [X] T008 [P] Client 最小切片：经 `ctx.slots.inject('conversation.chat.assistant-actions', cb)` 等待声明存活后 `ctx.slots.register({ name, id: 'siyuan-export', order, locale, inject })` 注册占位按钮（只用 `React.createElement` + `styles.insert(css)`，动态包 priority 低于内置条目）—— file: client/src/entry.tsx（样式内联） — 验证: `npx vitest run tests/client/slot-registration.test.ts` → 红（inject 调用 0 次）→ 实现后 2/2 pass；`npm test` 全量 → 8/8（3 文件）；`npm run typecheck`/`lint` → 0；`npm run build:client` → exit 0（handoff 2293b）；注：client 侧类型增强须 import `包名/client` 子路径
- [X] T009 最小装载链路验证：源码 → Host 构建 → Client handoff → tarball → 隔离安装 → `--profile web --dump-config`（仅证入选）→ 冷启动 Host → UI slot 出现占位按钮；装载失败按 package.json → patch → exports → inject/external → 产物格式 → Host 日志顺序排障 —— file: tests/client/handoff.test.ts（追加断言） — 验证: `npm pack` → tgz（7 文件）；隔离环境 `plugin add` → exit 0（`+ dsh-siyuan-export 0.1.0`，peer 警告不阻塞）；`--dump-config` → 入选行 `# == dsh-siyuan-export` + patch insert、无 skip；冷启动 `dsh --profile web --port 63353` → 页面 HTTP 200，模块表含 `{"id":"dsh-siyuan-export","url":"plugins/??…"}` 且 `dsh.client.inject` 边已解析；`GET plugins/??dsh-siyuan-export/client.js` → 200（含 `__ModuleLoader__.load`）；Host 日志无错误。**未验证**：消息行按钮真实渲染（隔离环境无模型产生不了助手消息 + 需浏览器）→ 归 T026；注册路径已由 T008 单测覆盖
- [X] T010 SiYuan 适配器核心：Token 经 Config 读取、`Authorization: Token <token>` 头、POST JSON、**同时处理「非 2xx」与「200 但 code!=0」**、错误分类映射（认证→`siyuan-auth`、连接→`siyuan-connect`、路径→`siyuan-path`）、`/api/system/version` 探活、`AbortSignal` + 有限超时 + retryable 限次退避、响应不含堆栈/内部路径/正文秘密 —— file: src/siyuan/client.ts — 验证: `npx vitest run tests/unit/siyuan-client.test.ts` → 红（模块加载失败）→ 实现后 14/14 pass（含 Token 头断言、双失败形态、超时 vs 调用方中止、退避 attempts=2）；`npm run typecheck`/`lint` → 0
- [X] T011 SiYuan 写入与同名消歧：`createDocWithMd` 封装（`path` 以 `/` 开头、缺失父级自动创建）+ commit 前 `getIDsByHPath` 查重，命中追加 ` (2)`、` (3)`… 后缀保证 FR-007「不覆盖、独立文档」；`pathAmbiguous`/`indexUnavailable` → `siyuan-path` — file: src/siyuan/client.ts — 验证: 同文件 `createNote` 4 用例（查重消歧 ` (2)`、`/`→`／` 净化、上限→siyuan-path、markdown 原样）随 14/14 pass；typecheck/lint → 0
- [X] T012 [P] LLM 适配器：`inject = ['llm']`；`listProviders()`→`listModels()`→`resolveModelInfo()` 解析后 `prepareCall(config, signal?, configure?)` → `stream()`（一次性）；`maxTokens` 输出预算；**FR-013 输入裁剪的唯一 prompt 构造点**（输入 = 单次输出 + 最小指令模板，禁止 Session 历史/用户提问/工具输出）；`{title, body}` 结构校验与大小限制；错误分类（`llm-adapter`/`llm-quota`/`llm-timeout`/`llm-structure`）；provider/model 以真实小请求验证（防 `NO_ADAPTER` 误报成功）—— file: src/export/llm.ts — 验证: `npx vitest run tests/unit/export-llm.test.ts` → 红（模块加载失败）→ 实现后 10/10；`npm test` 全量 → 32/32（5 文件，含 siyuan→PluginError 重构回归 14/14）；typecheck/lint → 0。要点：`FinishReason` 为对象联合（按 `kind` 判定）、`LlmFailure{code,status}` 细化分类、`RequestUserInput` 免运行时依赖。**真实试用缺陷修复（0.1.2，参考 dsh-snail-memory）**：① route 用 `listProviders[0]` 拍脑袋而对话模型在 `agents.options` → 失败 → 改 `selectModelRoute` 同款优先级（agents 选项 → listProviders 回落），Host inject 加 `agents`；② stream 请求自拼字段缺 adapterDefaults → `INVALID_PREPARED_CALL` 被吞成 internal「模型调用失败」→ 改 `{...prepared.config, system, messages, signal}` 展开（snail 同款），`PreparedLike` 补 `config` 字段；红灯复现线上错误后修复 → llm 12/12、全量 139/139
- [X] T013 [P] 偏好存储：`resolveDshHome()` 数据根下插件自有目录、`version` 字段、`lastPath`/`draft`、**临时位置写全量 → 原子切换**、全部写入同一串行队列、Windows 短暂 `EPERM` 有限退避；同 root 多 Host 并发时独占锁 + heartbeat + stale 判定，第二 Host 明确只读不静默并发写；localStorage 只作非权威显示缓存 —— file: src/store/prefs.ts — 验证: `npx vitest run tests/unit/prefs.test.ts` → 红（模块加载失败）→ 实现后 6/6（缺失默认、原子写无 tmp 残留、并发补丁串行、损坏回落、rename 重试 2/3 次语义）；`npm test` 全量 → 38/38（6 文件）；typecheck/lint → 0
- [X] T014 RPC 路由骨架：`webServer.register()` 同源 prefix；方法白名单仅 `export.open`/`export.state`/`export.commit`/`export.cancel`/`tree.list`；POST JSON + nonce 自定义头 + body 上限 1MB；逐字段校验（可选参数 `!== undefined`，空字符串不回退为未提供）；统一信封 `{ok:true,data}|{ok:false,error}`；`recordInput` 只记 messageId/taskId 元数据 —— file: src/api/routes.ts — 验证: `npx vitest run tests/unit/rpc-routes.test.ts` → 红（模块加载失败）→ 实现后 10/10（nonce 403、白名单 404、逐字段校验 400、信封、PluginError 分类保留、未知错误不泄漏栈/路径、413/405/坏 JSON、空串「已提供」语义）；`npm test` → 53/53；typecheck/lint → 0。修复：`failure()` 改返回 `ErrorInfo`、测试夹具补 nonce 头
- [X] T015 [P] 测试替身基座（按 真实→fake→stub→mock 顺序取 fake）：内存版思源 HTTP 端口（含同 path 行为开关）与假 `PreparedLlmCall`（可控 成功/超时/结构不合/NO_ADAPTER）—— file: tests/integration/fake-siyuan.ts, tests/integration/fake-llm.ts — 验证: 测试替身基座（无产品行为变更）；自测 `tests/integration/harness.test.ts` → 5/5（鉴权 401、version 探活、create→getIDs 回读、同名 reuse/duplicate 开关、failNext 注入、FR-013 输入捕获、四模式切换）；`npm test` → 53/53（8 文件）；typecheck/lint → 0

**Checkpoint**: 隔离环境最小装载成功（占位按钮出现，重启无重复注入）；三个 seam 均可注入替身。

---

## Phase 3: User Story 1 - 一键把单次输出导出为思源笔记 (Priority: P1) 🎯 MVP

**Goal**: 每条助手回复操作栏出现「导出到思源」按钮 → 弹窗（预填 LLM 主题名 + 默认上次路径）→ 确认后仅以该条单次输出为输入生成带小图标的结构化笔记并写入思源，成功反馈落点。

**Independent Test**: quickstart **V1、V3、V4、V5A/B** 与 SC-001——完成一次对话，点击该条回复的导出按钮直接确认，所选路径下出现结构化带图标笔记，全程 ≤3 次点击、弹窗 <1s。

### Tests for User Story 1（先写，确认红灯）

> **NOTE: 先写这些测试并运行看见失败（红），断言来自 spec.md 验收标准；再实现使其变绿。**

- [X] T016 [P] [US1] 状态机单测：幂等键（同 `messageId+contentRevision` 重复 open 不重复调 LLM）、writing 中重复 commit 幂等拒绝（FR-011）、转移表全路径、`degraded-ready` 降级、cancel 中止、**空/仅图片源 → `empty-source` 拒绝且不产生笔记（边界）** —— file: tests/unit/export-service.test.ts — 验证: 🔴 红（export-service 模块缺失）→ 🟢 11/11 pass
- [X] T017 [P] [US1] FR-013 负向断言：构造的 prompt **仅含单次输出 + 指令模板**，断言不含用户提问/Session 历史/工具输出（SC 节省 token 硬约束）—— file: tests/unit/llm-prompt.test.ts — 验证: 4/4 pass（system 静态模板、user 严格 <single-output> 包裹、messages 精确相等、无 sessionId/purpose/toolHistory）；FR-013 行为由 T012 正向实现先红过，本文件为负向回归护栏
- [X] T018 [P] [US1] 排版单测：要点小图标标注（✅ 📌 ⚠️ 💡）、标题层级、代码块/列表原样保留、`markers` 清单断言（FR-008/FR-009）—— file: tests/unit/format.test.ts — 验证: 🔴 红（format 模块缺失）→ 🟢 5/5 pass（H1 降级、围栏内不动、markers 去重保序、footer 注记、列表/代码/链接原样、空 body 不抛错）
- [X] T019 [P] [US1] 集成测试：fake 思源 + 假 LLM 全流程 `open→generating→ready→commit→succeeded`、`Prefs.lastPath` 回写（FR-006）、失败时 title/target 不清空（FR-010）—— file: tests/integration/export-flow.test.ts — 验证: 🔴 红 → 🟢 1/1 pass（真实 SiyuanClient+PrefsStore+服务全链；断言思源侧落盘 markdown 含分节/✅/footer、lastPath 回写、幂等 open 只调一次 LLM、state 不回传 body、FR-013 集成复核）

### Implementation for User Story 1

- [X] T020 [US1] 导出编排状态机：**open 时经宿主 Session 按 `messageId` 读取该条定稿消息正文、派生 `contentRevision` 并校验非空**（SingleOutput 来源，FR-008/FR-013 的输入源头；空/仅图片 → 返回 `empty-source` 用户可读提示，不产生空笔记）；状态 `generating→ready|degraded-ready→writing→succeeded|failed`、单一 Host 权威状态、同键任务复用、串行写队列、Host 权威防重（按钮禁用仅表现层）、llm→write 编排、`cancel` 触发 AbortSignal、成功回写 Prefs —— file: src/export/export-service.ts（依赖 T010–T014） — 验证: 见 T016 11/11 + T019 1/1；title 清洗（去非法字符、≤128）、降级标题取首行、`href=siyuan://blocks/<id>`
- [X] T021 [US1] 排版器：结构化笔记产出（`{title, body}` → 分节 Markdown、小图标要点、原结构保留、`formatVersion`、body 仅存 Host 不回传 Client）—— file: src/export/format.ts — 验证: 见 T018 5/5；H1 降级为 H2（代码围栏内不动）、footer 注记（导出时间/来源会话/消息/修订/版本/位置）
- [X] T022 [US1] RPC 方法实现接线：`export.open`（幂等启动生成 + 返回 lastPath）、`export.state`（轮询语义、不返回 body）、`export.commit`（title 校验：trim 后非空、≤128 字符、清理 `<>:"/\|?*` 与控制符、压平换行，清理后为空报错；target 校验）、`export.cancel`；stale taskId 响应丢弃 —— file: src/api/routes.ts（追加） + src/export/session-source.ts + src/index.ts（装配） — 验证: 契约修正 `contentRevision` 改由 Host 派生（Client 不传，contracts/rpc.md 同步）；Session 读取源 `ctx.sessions.get → deriveMessages → 按 id 找助手消息 → contentGeneration 作 contentRevision`，`blocksToText` 单测 3/3；typecheck/lint → 0
- [X] T023 [P] [US1] 导出按钮组件：slot owner `{ messageId }` props、独立 `id: 'siyuan-export'` 与 `order`（与官方 `feedback` 共存不替换）、点击调 `export.open` 并打开弹窗、loading 态 —— file: client/src/components/ExportButton.tsx — 验证: 🔴 红（组件缺失）→ 🟢 3/3（文案、onExport(messageId)、loading 禁用不触发）
- [X] T024 [P] [US1] Client RPC 与轮询：`export.open/state/commit/cancel` 类型化请求、500ms+jitter 轮询至终态即停、旧 sessionId/taskId 响应不覆盖新弹窗（stale 防护）—— file: client/src/rpc.ts（追加） — 验证: 🔴 红（createExportClient 缺失）→ 🟢 6/6（路径拼装、nonce 头、ok:false 保留 category/retryable、轮询终态即停、stale 丢弃、transport 失败归 internal）
- [X] T025 [US1] 导出弹窗组件：标题输入框「正在生成默认主题名…」占位 → LLM 值自动填入（**用户已编辑则不覆盖**）、「导出」按钮 `ready/degraded-ready` 前不可用、成功反馈含落点（FR-012）、失败保留 title/target 并显示「重试」（FR-010）、关闭时 generating 先 `export.cancel`；样式对齐宿主主题变量 —— file: client/src/components/ExportDialog.tsx, client/src/entry.tsx（接线：open→弹窗→轮询→回填→commit→反馈） — 验证: 🔴 红 → 🟢 8/8（占位提示、ready 禁用、回填不覆盖、提交、成功落点、失败+重试且字段保留、degraded 仍可导出、无路径禁用）；入口接线后全量 95/95、build handoff 16.7KB。**真实试用缺陷修复（0.1.1）**：弹窗 `position:fixed` overlay 渲染在消息行内、宿主 transform 祖先致 fixed 退化错位（截图）→ 🔴 红（overlay parent 非 body）→ 🟢 `createPortal(…, document.body)` + 可注入 `clientFactory` 测试点；export-dialog-portal 1/1、全量 137/137
- [X] T026 [US1] 隔离 Host E2E：按 quickstart 走 **V1**（按钮出现/重启无重复注入）、**V2 标题部分**（打开<1s、自动填入不覆盖）、**V3**（真实写入+落点反馈）、**V4**（连点只产生一篇、同键 open 不重复调 LLM）、**V5A/B**（真实小请求 + prompt 不含上下文复核），证据留存于任务行 —— file: tests/e2e/ — 验证: 隔离环境 pack→install→`--profile web --port 57893` 冷启动 → **RPC 真实端到端**：缺 nonce→403、未知方法→404、缺字段→400、真实 open（session 不存在）→200 业务错误信封「找不到对应会话」、tree.list→`{nodes:[]}`；页面 HTTP 200、client.js 200（16794B，id=dsh-siyuan-export、含 slot key）；Host 日志无错误；**用完即 teardown**（端口释放、目录删除）。**未验证（诚实标注）**：真实思源写入与真实模型生成（需本机思源 Token + 已配模型 + 助手消息，归 quickstart V3/V5）；消息行按钮真实渲染（需浏览器+真实对话）

**Checkpoint**: US1 独立可用即 MVP——可停止验证、演示。

---

## Phase 4: User Story 2 - 挑选并记住思源存放位置 (Priority: P2)

**Goal**: 弹窗内嵌思源文档树选择器（笔记本 → 子文档逐层懒加载），任选层级为落点，记住并默认最近一次成功导出的位置。

**Independent Test**: quickstart **V2 完整**（树逐层展开、默认路径=上次成功位置、改选后落点跟随）与 **V3**（笔记出现在所选层级）。

### Tests for User Story 2（先写，确认红灯）

- [X] T027 [P] [US2] 文档树服务测试：`lsNotebooks` 笔记本层、`query/sql` 子文档层行映射（**显式 LIMIT + 稳定排序**，列名以实测校正）、`file/readDir` 官方兜底、`siyuan-connect`/`siyuan-auth` 错误映射、`hpath → parentSegments` 切分 —— file: tests/unit/siyuan-tree.test.ts — 验证: 🔴 红 → 🟢 9/9 pass（含根层斜杠数=1、path 前缀+深度过滤两个真实语义用例）；**blocks 列名经真实 API 实证**（id/parent_id/box/path/hpath/name/type）
- [X] T028 [P] [US2] DocTree 组件测试：懒加载展开（按层 `tree.list`）、stale 响应丢弃、选中态、`lastPath` 默认选中、失败就地重试 —— file: tests/client/doc-tree.test.tsx — 验证: 🔴 红 → 🟢 6/6 pass（jsdom + testing-library，手动 cleanup 避免跨测试残留）

### Implementation for User Story 2

- [X] T029 [US2] 文档树服务：`src/siyuan/tree.ts`——笔记本层 `POST /api/notebook/lsNotebooks`（响应为 `{notebooks:[…]}` 包装对象，实测校正），子文档层 `POST /api/query/sql` 懒加载（**真实语义：parent_id 恒空，层级由 path 表达**——直接子文档 = `path LIKE '/<父id>/%'` + 深度过滤，根层 = 斜杠数 1）；备选 `file/readDir` + `getPathByID` 兜底；`lsDoc` 仅实测稳定后才可作优化（未公开接口不作依赖）—— file: src/siyuan/tree.ts — 验证: T027 9/9；**真实思源 3.8.9 逐条实测**（根层 18 条、/AI 子文档 9 条、SQL 语句 code=0）
- [X] T030 [US2] RPC `tree.list` 实现：`{notebookId?, docId?}` 参数语义（两者皆空=列笔记本；有 notebookId 无 docId=根层文档；有 docId=直接子文档）、节点 `{id,name,kind,notebookId,hasChildren,path}`、只读错误映射 —— file: src/api/routes.ts（追加）+ src/index.ts（接线） — 验证: T033 三层 E2E 真实通过（1 本 → 18 根文档 → 9 子文档，path 数组正确）
- [X] T031 [US2] 文档树选择器组件：展开/选中/`hasChildren` 懒加载、选中即 `StoragePath`（notebookId + parentSegments + display）、失败就地显示原因与重试；接入弹窗路径选择区 —— file: client/src/components/DocTree.tsx, client/src/components/ExportDialog.tsx（children 挂载）+ client/src/entry.tsx（treeList 转接） — 验证: T028 6/6；stale requestId 丢弃、逐层渲染缩进、「已选中」徽标
- [X] T032 [US2] `lastPath` 记忆接线：打开弹窗默认选中 `Prefs.lastPath`（**首次 null → 自动选中第一个笔记本根，使「笔记本根可直接导出」**）、用户改选即时生效、成功导出后回写（T020 已实现回写，此处接默认选中）—— file: client/src/components/DocTree.tsx（initialPath 逐层展开 + 首次默认）+ client/src/entry.tsx（lastPath → initialPath/target） — 验证: T028 initialPath 用例（自动展开匹配层 + onSelected 回填）；全量 110/110
- [X] T033 [US2] 隔离 Host E2E：quickstart **V2 完整** + **V3 落点跟随**——逐层展开、默认路径、改选后笔记出现在新层级，证据留存 —— file: tests/e2e/ — 验证: 隔离 pack→install→冷启动→**tree.list 三层真实数据**（笔记本 1 个「work」→ 根层 18 文档 [AI/Agent concept/Book note/GoLang…] → /AI 直接子文档 9 个 [DSH/Hanako/Memory…]，path 数组 `['AI','DSH']` 正确）；空 Token 头 code=0、假 Token 401（本机未开鉴权）；用完即 teardown（端口释放、目录删除）。**未验证**：浏览器内树的真实渲染与点击交互（需真实对话场景，归 quickstart V2 手工核验）

**Checkpoint**: US1+US2 均可独立测试通过。

---

## Phase 5: User Story 3 - 出错可恢复、内容不丢 (Priority: P3)

**Goal**: 失败场景全部可恢复：明确原因 + 重试入口、已填内容不丢、防重复提交、LLM 失败降级可导出、生成中取消无半成品。

**Independent Test**: quickstart **V6 a–d**、**V7** 与 SC-005/SC-006——断开思源导出失败显示原因与重试且字段保留；恢复后重试成功仅一篇；LLM 失败走降级标题仍可导出；同名两次独立文档。

### Tests for User Story 3（先写，确认红灯）

- [X] T034 [P] [US3] 错误分类映射单测：非 2xx、`200+code!=0`、`pathAmbiguous`/`indexUnavailable`、`NO_ADAPTER`/配额/超时 → 各自 category、retryable 与用户可读文案（不含堆栈/内部路径/正文秘密，FR-010）—— file: tests/unit/error-mapping.test.ts — 验证: 9/9 pass（含补充分支：siyuan 429→connect、indexUnavailable→path、LLM finish failure status429→quota/504→timeout/no-adapter→adapter/未知→adapter 可重试、thrown 未知→internal）
- [X] T035 [P] [US3] 失败恢复单测：写失败 → `retry` **复用缓存 body 不重调 LLM**（token 守卫）、title/target 全程不清空、生成中 cancel 中止流、任务表清理无半成品 —— file: tests/unit/recovery.test.ts — 验证: 🔴 红（精确暴露两个真实缺陷：cancelled 再 open 卡死、succeeded 再 open 无法再次导出违反 spec 边界）→ 修复 open 终态分支（succeeded→ready 复用缓存、cancelled→重新生成、existing 回填 lastPath）→ 🟢 5/5；全量 124/124

### Implementation for User Story 3

- [X] T036 [US3] 错误文案与重试 UI 打磨：`siyuan-auth` 引导（思源 设置 → 鉴权 → API token + 插件 Config 配置指引）、`siyuan-connect`（引导启动思源）、`llm-adapter`（引导检查模型配置）、`siyuan-path`（引导重选路径）四类必备文案；「重试」复用同 taskId（Host 缓存 body）—— file: client/src/components/ExportDialog.tsx（CATEGORY_GUIDE 拼接） — 验证: 🔴 红（引导文案缺失）→ 🟢 9/9（四类 category 各有行动指引、与服务端 message 互补不重复）；全量 131/131
- [X] T037 [US3] 注入故障 E2E：quickstart **V6a**（关思源→失败→恢复→重试仅一篇）、**V6b**（LLM 断开→`degraded-ready` 首行截断标题仍可导出）、**V6c**（生成中关闭→无半成品）、**V6d**（删目标路径→`siyuan-path` 重选）、**V7**（同名两次独立文档、数万字长回复不截断），证据留存 —— file: tests/e2e/siyuan-real.test.ts — 验证: 真实思源 E2E **5 passed**（V6a 错误 endpoint→connect 可重试、真实写入+回读+formatNote 元数据、V7 同名消歧落盘 `/同名测试`+`/同名测试 (2)`、同 path 直接重复实测、清理零残留；思源未运行则整体 skip 不假绿）。**实测纠正三项**：① `document metadata is not ready` 为瞬时错误→分类改 `siyuan-connect` 可重试（原归 path 不可重试）② 跨级自动创建不可靠→`createNote` 逐级 ensure 父级 ③ `removeDocByID {id}` 才是按 id 删除的官方签名。V6b/V6c 归单测（T016/T035）；浏览器 UI 归 quickstart 手工核验

**Checkpoint**: 三个故事全部独立可用，SC-005/SC-006 达成。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事收尾与交付检查

- [X] T038 [P] 文案与 locale：slot `locale` 命名空间接入、按钮/弹窗/错误文案中文一致性 —— file: client/src/locales.ts, client/src/entry.tsx, client/src/components/* — 验证: `siyuan-export` NS 完整接入（declare module 合并 LocaleNamespaceMap、zh 为 key-set 真源、en 对照校验、`t('key',{param})` 模板参数）；三组件不再硬编码文案、测试经 `zhT` 注入；全量 135/135 + typecheck/lint/build 0。注：`TranslateNS` params 为 `Record<string, unknown>`（签名对齐实测）。**真实试用缺陷修复（0.1.1）**：漏运行时 `ctx.locale.register(NS,{zh,en})` → 线上 `t()` 回退显示 key（截图 `button.export`）→ 🔴 红（inject 缺 locale、register 0 调用）→ 🟢 修复：`inject=['slots','locale']` + apply 注册 + `@deepseek-ai/dsh-client-locale` 依赖 + `zhT` 键集对齐 `LocaleKeysOf`（含 common 词表）；slot-registration 3/3
- [X] T039 [P] 打包与安装检查：`prepack` 构建、`npm pack` tarball 内容核对（`files` 覆盖 Host/Client/patch/locale；**不含** node_modules、测试数据、真实 `$DSH_HOME`、日志、凭据）—— file: package.json, scripts/pack-check.mjs — 验证: `node scripts/pack-check.mjs` → exit 0「7 个文件，必需文件齐全、无敏感内容」；修复点：`--ignore-scripts` 避免 prepack 日志污染 JSON stdout（`.mjs` 无 TS 注解）
- [X] T040 安全与秘密扫描：断言 Token 不出现在日志、审计、状态文件与 RPC 响应；对产物与错误文案做高置信秘密扫描 —— file: tests/unit/secret-scan.test.ts — 验证: 4/4 pass（源码无 console 打印 token/config、prefs.json 固定三键无凭据字段、RPC open/state 序列化无 token/endpoint、构建产物无 `Token <20+位>` 字面量）；全量 135/135
- [X] T041 quickstart 全矩阵回归（V0–V7）与性能核对：SC-001（≤3 次点击、弹窗<1s）、SC-002（95% <30s）、SC-003/004 抽样评估，结果记录回 quickstart —— file: quickstart.md, tests/e2e/ — 验证: 执行记录已回写 quickstart.md（✅ 12 项自动化覆盖：V0/V2树/V3/V4/V5B/V6a-c/V7/清理纪律；⏳ 7 项待手工：真实浏览器渲染、真实模型链路与 SC 计时抽样、真实删路径场景）；全量 135/135 + pack-check 0；含 4 条实测纠正记录
- [X] T042 文档与交付一致性收尾：插件 README（安装/配置 Token/使用/未验证边界清单）、spec/plan/tasks/contracts 与 GLOSSARY 交叉同步、按 develop-dsh-plugin「完成检查」逐项核对 —— file: README.md, specs/001-siyuan-note-export/tasks.md — 验证: README 已建（安装/配置/使用/开发/未验证边界五节）；交叉同步核对（契约 contentRevision Host 派生、siyuan 错误分类实测修正、locale 一致性均已回写）；漏勾任务清零（T010–T013/T015 补勾）；develop-dsh-plugin 完成检查逐项过（树外未改宿主 tracked 文件、隔离安装真实通过、未验证边界明确列出、未 commit/未发布/未装真实环境）

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
T024 → T025（Client RPC → 弹窗调用）
T020 → T023/T025（编排 → UI 接线）
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
- US1 实现：`T023 ∥ T024` 与 `T020/T021/T022/T025` 分组
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
Task: "T024 Client RPC client/src/rpc.ts"
Task: "T023 按钮组件 client/src/components/ExportButton.tsx"
→ T020 编排 → T021 排版 → T022 服务端接线 → T025 弹窗 → T026 E2E
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
- E2E 成功判定以**真实状态**为准（RPC 响应、持久化状态、思源文档、重启结果）——DOM 点击成功不等于业务成功（skill 避坑速查）
- 每个故事完成后停在 Checkpoint 独立验证，避免跨故事回归

---

## Phase 7: Convergence

> 来源：`/speckit-converge`（2026-11-10，输入 = verify-standards 6 判断项 + analyze 复核）。宪法：占位模板（跳过）。Append-only：不改既有任务。

- [X] T043 DocTree 三处「加载失败」兜底文案接入 locale：`client/src/locales.ts` 增 `tree.loadError` 键（zh/en），`client/src/components/DocTree.tsx:117,141,172` 硬编码改 `t('tree.loadError')` —— per T038 (partial) [MEDIUM] — 验证: 🔴 红（记录型 t 断言 `tree.loadError` 未被调用）→ 🟢 7/7（含新用例：非 Error 值触发兜底分支、重试成功）；typecheck 0
- [X] T044 删除死代码 `buildNotebooksQuery`（恒返回 null，生产不使用）及其在 `tests/unit/siyuan-tree.test.ts` 的断言用例 —— per plan: tree 服务 (unrequested) [LOW] — 验证: 函数+无效断言用例删除，tree 测试 8/8（9→8，删的是死代码对应断言）；typecheck 0。无行为变更（纯删除）
- [X] T045 提取 `clampLimit(value, min, max)` 共用辅助，消除 `src/siyuan/tree.ts:41,59` 两处重复的 LIMIT 钳制逻辑 —— per T029 (partial) [LOW] — 验证: 重构后 tree 8/8（钳制语义不变：[50,500] 区间、非法回落默认）；typecheck 0。无行为变更（纯重构）
- [X] T046 提取 `shouldAppendGuide(message, guide)` 命名判重函数（首短语为命名常量），替换 `client/src/components/ExportDialog.tsx:118,125` 两处无解释的 `guide.slice(0, 6)` 魔法值 —— per T036 (partial) [LOW] — 验证: `GUIDE_LEAD_PHRASE` 常量与 guide 字典首短语对齐（locales.ts），dialog 9/9（四类指引断言仍过）；typecheck 0。无行为变更（等价重构）
- [X] T047 DocTree 结构重构：提取 `toggleExpanded(key)` 消除 5 处 `Set+add` 重复、提取 `expandToPath` 缩短 ~80 行三层嵌套的初始化 effect 并去掉 `matched!` 非空断言 —— per plan: DocTree 组件 (partial) [LOW] — 验证: 重构为 `expandKey`+`expandToPath`（局部常量 `hit` 替代非空断言、effect 瘦身至 ~20 行），doc-tree 7/7 行为不变；typecheck 0。无行为变更（纯重构）
- [X] T048 提取 `readLastPath()` 辅助，消除 `src/export/export-service.ts:166,185` 两处重复的 `prefs.read().catch(...)` —— per plan: 存储决策 (partial) [LOW] — 验证: 私有辅助提取后 open 两处调用；全量 135/135 + typecheck/lint/build/pack-check 全 0。无行为变更（纯重构）

---

## Phase 8: Change 2026-11-11 · Shared Foundation

> 依据 spec.md US4/US5、plan.md「Change 增量设计」、data-model §6–§7、contracts/rpc.md 7 方法。按 preset：每个行为任务在**同一复选框**内先写测试（红）再实现（绿）；不设独立测试小节。Append-only：不改 T001–T048。

**Purpose**: Prefs v2、静默落点与 7 方法契约——US4/US5 共同前置。

- [X] T049 [P] 实现偏好 v2 与 v1 迁移：`version: 2`、`lastPath`、`defaultPath`（`null` = 未配置）、`showDialog`（默认 `true`）、`draft`；文件缺失/JSON 损坏回退默认值，`version === 1` 迁移时保留 `lastPath`/`draft`，显式 `false`/`null` 经 `definedPatch` 保留，写入仍走串行队列 + 临时文件原子切换；测试覆盖缺失默认、v1 保留、损坏回退、未知 `version` 回退并写回 v2、`showDialog:false` 不被吞 —— 验证: `npx vitest run tests/unit/prefs.test.ts` → 9/9 pass（先红 5 failed/4 passed）—— file: tests/unit/prefs.test.ts, src/store/prefs.ts — FR-022
- [X] T050 [P] 实现静默落点解析与目标校验：`resolveSilentTarget` 按 `Prefs.defaultPath`（有效）→ `Prefs.lastPath` 笔记本根 → `lsNotebooks` 第一本未关闭笔记本根 → `siyuan-path` 失败；**默认路径存在但失效时直接失败、不回退**；`validateTarget(path)` 校验 notebook 存在且非关闭、`parentSegments` 经 `getIDsByHPath` 可解析，失败返回 `siyuan-path` 且不写入；测试覆盖五分支与「默认路径失效不改道」 —— 验证: `npx vitest run tests/unit/siyuan-target.test.ts` → 8/8 pass（先红：模块缺失）—— file: tests/unit/siyuan-target.test.ts, src/siyuan/target.ts — FR-018/FR-023
- [X] T051 [P] 扩展共享契约与 prefs RPC：`RpcMethod` 增至 7 个，新增 `prefs.get`（返回 `showDialog/defaultPath/lastPath`，损坏时默认值不报错）与 `prefs.update`（`undefined` 不修改、显式 `false`/`null` 保留、`defaultPath` 保存前 `validateTarget`）；路由白名单、逐字段校验与统一信封同步；响应不含 Token/body；测试断言方法白名单、默认值、definedPatch、校验失败不落库 —— 验证: `npx vitest run tests/unit/rpc-routes.test.ts` → 13/13 pass（先红：模块缺失）；`npm run typecheck` pass —— file: tests/unit/rpc-routes.test.ts, src/contract.ts, src/api/routes.ts, client/src/rpc.ts — FR-015/FR-016/FR-022
  - 注：为保持装配可编译，新增 `src/api/prefs-handlers.ts` 并在 `src/index.ts` 接线（任务文件清单之外的最小补充）

**Checkpoint**: `npx vitest run tests/unit/prefs.test.ts tests/unit/siyuan-target.test.ts tests/unit/rpc-routes.test.ts` 全绿；typecheck/lint 0。

---

## Phase 9: User Story 4 - 从侧栏打开导出设置 (Priority: P2)

**Goal**: 左侧栏出现带 `biji.svg` 的「导出设置」入口，点击在主工作区以 tab/面板打开（非模态）；可改默认存放路径与「导出时显示弹窗」开关，保存即生效，重启保留。

**Independent Test**: quickstart **V8** 与 **V12**——侧栏入口可发现、面板非模态、开关/路径即时保存、重启后保留、v1 偏好自动迁移。

- [X] T052 [US4] 注册侧栏入口与主面板：`sidebar.panellist`（`id = 'siyuan-export.settings'`、`label` 提供可访问名称、组件渲染 `biji.svg`）与 `main`（`key` 与入口 id 一致，点击经宿主 `selectPanel(id)` 切换）；图标用 esbuild `loader: {'.svg':'dataurl'}` + `client/src/svg.d.ts` 内联，加载失败保留 label；测试断言两个 slot 注册、key 一致、handoff 产物含 dataurl 且 apply/inject 可执行、模拟图标 onError 后入口仍带可访问名称 —— 验证: `npx vitest run tests/client/slot-registration.test.ts tests/client/handoff.test.ts` → 5/5 pass；`npm run build:client` → dataurl 内联；`npm run typecheck` pass；eslint 0（红灯未单独捕获：测试先写、实现后一次转绿）—— file: tests/client/slot-registration.test.ts, tests/client/handoff.test.ts, scripts/build-client.mjs, client/src/svg.d.ts, client/src/components/BijiIcon.tsx, client/src/entry.tsx — FR-014/FR-024
  - 注：新增 `client/src/slots.d.ts` 声明本插件消费的 `sidebar.panellist` / `main`（ui-sidebar/ui-layout 不在依赖内）
- [X] T053 [US4] 实现设置面板的开关与默认路径即时保存：开关默认开启；路径仅可从思源树选择/清除，不接受本机路径；修改即调 `prefs.update`（无全局保存按钮，≤4 次交互），保存中禁用该项，成功后更新「已保存」值，失败回滚 Host 值并就地报错；测试用 fake RPC 覆盖默认值、成功保存、失败回滚、路径清除，并断言新增设置文案键 zh/en 键集一致 —— file: tests/client/settings-panel.test.tsx, client/src/components/SettingsPanel.tsx, client/src/locales.ts, client/src/entry.tsx — FR-015/FR-016/FR-022/SC-010 — 验证: 🔴 `npx vitest run tests/client/settings-panel.test.tsx` → 模块缺失失败 → 🟢 6/6 pass（默认开启/即时保存+保存中禁用/失败回滚+alert/树选择保存 StoragePath/清除 null/zh-en 键集一致）；`npx vitest run tests/client` → 42/42；`npm run typecheck`/`lint` → 0。附注：DocTree 新增 `autoSelectFirst`（默认 true），设置页传 false，避免打开选择器未经点击即保存首个笔记本
- [X] T054 [P] [US4] 文档树键盘可达：为 `role=treeitem` 行补 roving `tabIndex`、Enter/Space 选择、←/→ 折叠展开、焦点样式走宿主变量；测试断言 Tab 进入、方向键移动/展开、Enter 选中并回调 `StoragePath`，且鼠标行为不变 —— file: tests/client/doc-tree.test.tsx, client/src/components/DocTree.tsx — FR-024 — 验证: 🔴 `npx vitest run tests/client/doc-tree.test.tsx` → 3 failed/9 passed（无 tabIndex、键盘无响应）→ 🟢 12/12 pass（roving tabIndex 0/-1 切换、↑↓ 漫游并同步 DOM 焦点、→ 懒加载展开/← 折叠、Enter 与 Space 回调同一 StoragePath、原鼠标用例全绿）；容器补 `role=tree`+aria-label、折叠按钮移出 Tab 序；焦点环用 `--dsh-focus`/`--dsh-accent`；`npm run typecheck`/`lint` → 0；`npx vitest run tests/client` → 45/45。重构：无需改动，全绿复跑确认
- [X] T055 [US4] 设置页加载与离线容错：打开面板先 `prefs.get`；思源不可用时路径区显示原因 + 重试，**已保存路径不被清空**，开关仍可修改；无笔记本时显示空态而非崩溃；测试覆盖加载失败保留值、重试恢复、空笔记本、开关独立可保存 —— file: tests/client/settings-panel.test.tsx, client/src/components/SettingsPanel.tsx — FR-015/FR-022 · US4-6 — 验证: 🔴 `npx vitest run tests/client/settings-panel.test.tsx` → 1 failed/8 passed（仅缺空态提示）→ 🟢 9/9 pass（prefs.get 失败 alert+重试恢复；树连接失败显示原因、默认路径保留、开关仍独立保存、重试恢复；空笔记本走 `tree.empty` 空态不崩溃）；`tests/client/doc-tree.test.tsx` 12/12；`npm run typecheck`/`lint` → 0。实现补 `tree.empty` zh/en 文案与 `data-role=tree-empty` 渲染；离线/重试路径复用 DocTree 既有错误条，未新增重复状态
- [X] T056 [US4] 隔离 Host E2E（V8/V12）：独立 `DSH_HOME` 安装后确认侧栏入口注册与主面板 key、`prefs.update` 落盘、重启后偏好保留、v1 `prefs.json` 迁移不丢 `lastPath/draft`；真实浏览器点击/键盘交互按 quickstart 记录为手工证据 —— file: tests/e2e/change-settings.test.ts — 无行为变更（仅隔离验证） — 验证: 临时脚本 `%TEMP%\dsh-settings-e2e.ps1`（setup-isolated-env → `plugin --profile web add <tgz>` → 三次冷启动 → teardown）实跑 `E2E_RESULT=PASS`：`DUMP_INCLUDED=1 SKIP_LINES=0`；带 token 访问页面 `PAGE_STATUS=200 HTML_HAS_PLUGIN=True`，modules 汇总 client.js 返回 200 且 bundle 含 `sidebar.panellist`/`siyuan-export.settings`/`"main"`；`prefs.get` → `{showDialog:true,defaultPath:null,lastPath:null}`，`prefs.update {showDialog:false}` 返回同值且 `prefs.json` = `{"version":2,...,"showDialog":false}`；重启后 `PREFS_GET_2.showDialog=false`；写入 v1 文件后冷启动 → `PREFS_FILE_MIGRATED` 为 v2 且保留 `lastPath.notebookId=nb-v1`、`draft.title=旧草稿`、`showDialog:true`。未验证：真实浏览器点击/键盘交互（无人工操作，按 quickstart 记手工证据，留待 V8 手工项） — 补记（2026-11-11，用户手工核验，构建 c247b5e）：真实宿主侧栏/设置面板点击与键盘交互已通过


**Checkpoint**: US4 可独立验证——设置面板可用且偏好重启保留，不依赖静默导出。

---

## Phase 10: User Story 5 - 静默一键导出、不打断对话 (Priority: P2)

**Goal**: 开关关闭时点击导出按钮不弹窗；Host 后台生成并自动写入，按钮保持运行态；成功 toast 显示落点并自动消失，失败显示原因与重试；切换会话不中断，不同回复互不阻塞。

**Independent Test**: quickstart **V9–V11**——无弹窗、加载态、跨会话继续、3 并发各 1 篇、toast 成功/失败行为符合 SC-007–009/011。

- [X] T057 [US5] Host 模式分派与静默联合响应：`export.open` 增加可选 `intent?: 'auto' | 'silent'`；`intent='silent'` 或 `showDialog=false` → `mode:'silent'` 并立即返回 `taskId/status/target/targetFrom/degraded/alreadyRunning/error`，业务失败以 `ok:true + status:'failed'` 返回；`export.state` 增补 `mode/target/href/degraded`，`export.commit` 拒绝静默任务、`export.cancel` 对静默任务返回 `noop`；测试断言 auto 读偏好、silent 不弹窗字段、静默失败仍为数据、dialog 行为不回归 —— file: tests/unit/export-service-silent.test.ts, src/export/export-service.ts, src/contract.ts, src/api/routes.ts — FR-017/FR-019/FR-021 — 验证: 🔴 `npx vitest run tests/unit/export-service-silent.test.ts` → 10/10 失败（无 mode 字段/无意图分派）→ 🟢 10/10 pass（auto 读 showDialog、intent silent 覆盖、default/last/first-notebook 三种落点、siyuan-path 不可重试、siyuan-connect 可重试、empty-source 静默失败、state 增补字段、commit 拒绝静默/cancel noop、路由 intent 非法 400 + 静默失败仍 ok:true）；`npx vitest run` → 186 passed/1 skipped；`npm run typecheck`/`lint` → 0。附带修正两处陈旧断言：handoff 裸 import 正则误报英文文案 `export behavior`（改为行首匹配）、secret-scan 的 prefs 键集断言仍按 v1 三键（改 v2 五键）

- [X] T058 [US5] 静默后台编排与并发边界：open 返回后后台执行「生成 → 自动 commit」；幂等键 = `sessionId:messageId:contentRevision`，同键 `generating/writing` → `alreadyRunning=true` 不启第二条流水线，不同 messageId 并发独立，写入由 `writing` 门闩保护；测试断言立即返回、自动落盘、同键只调一次 LLM/只写一篇、3 条并发各 1 篇、静默任务不写持久化文件 —— file: tests/integration/export-silent.test.ts, src/export/export-service.ts — FR-019/FR-025/SC-011 — 验证: 🔴 `npx vitest run tests/integration/export-silent.test.ts` → 5/5 失败（静默任务停在 `ready`、从不自动写入）→ 🟢 5/5 pass（open 立即返回 generating、后台生成后自动落盘、lastPath 回写、同键 generating 时 `alreadyRunning=true` 且 LLM 仅 1 次/文档 1 篇、`writing` 门闩下再 open 不产生第二次写入、3 个 messageId 并发各 1 篇、数据目录仅剩 `prefs.json`）；重构：把 commit 的写入核心抽成 `writeTask`，弹窗与静默共用
- [X] T059 [US5] 静默失败、重试与降级：目标解析/写入失败 → `failed` 保留原因与 `retryable`，**不改道**；再次 open 复用缓存 body 不重调 LLM；生成失败仍以原文写入并置 `degraded=true`；测试覆盖默认路径失效、连接失败后重试仅一篇、降级仍写入 —— file: tests/integration/export-silent.test.ts, src/export/export-service.ts, src/siyuan/target.ts — FR-020/FR-023/SC-006 — 验证: 🔴 新增 3 条中写入失败重试为红（再次 open 仍返回 `failed`）→ 🟢 8/8 pass（默认路径失效 `siyuan-path` 不可重试且不回退/不调 LLM/不回写 lastPath；写入失败保留 `siyuan-connect`+retryable 且 target 不变，再次 open 复用缓存 body 进入 `writing`，重试仅落 1 篇、LLM 仅 1 次；structure-bad 降级以原文写入、`degraded=true`、标题取首行）；`npx vitest run` → 194 passed/1 skipped；`npm run typecheck`/`lint` → 0。测试侧修正一处竞态：lastPath 回写发生在 state 变 succeeded 之后，改轮询断言（行为未放宽）
- [X] T060 [US5] Client 静默任务单例与 RPC 类型：按 `sessionId:messageId` 维护任务（与 Host 幂等键同粒度；终态 toast 按 taskId 归属），组件卸载（切会话/面板）不取消、不丢终态；再次挂载从单例恢复加载态；重复点击复用同任务；重试发送 `intent:'silent'`；测试用 fake client 覆盖跨卸载轮询、按 `sessionId:messageId` 防重、同 messageId 跨两个会话互不覆盖、重试仍静默 —— file: tests/client/silent-export.test.ts, client/src/silent-export.ts, client/src/rpc.ts — FR-019/FR-025 — 验证: 🔴 `npx vitest run tests/client/silent-export.test.ts` → 模块不存在（0 test）→ 🟢 7/7 pass（track 轮询并通知订阅者、退订后轮询继续且可恢复终态、同键重复 track 不重启轮询、同 messageId 双会话互不覆盖、open 直接失败不空转、并发 retry 只发一次 `intent:'silent'` 并跟踪新 taskId、非失败任务 retry 不调 open）；`npm run typecheck`/`lint` → 0。rpc.ts 补齐静默相关 type 再导出
- [X] T061 [US5] 导出按钮运行态与静默分派：点击后按响应 `mode` 分流——`dialog` 保持现有弹窗，`silent` **不打开弹窗**、按钮进入加载/运行态并阻止重复触发，终态恢复；测试覆盖两种响应、运行态禁用、重复点击不二次调用、卸载后由单例恢复 —— file: tests/client/export-button.test.tsx, client/src/components/ExportButton.tsx, client/src/entry.tsx — FR-017/FR-019 — 验证: 🔴 `npx vitest run tests/client/export-button.test.tsx` → 3/7 失败（silent 路径直接 return，按钮无运行态/不阻止重复点击）→ 🟢 7/7 pass（dialog 打开 overlay 保留原行为；silent 不弹窗且按钮 disabled、二次点击不调 open；终态恢复可点；卸载后重挂载由单例恢复运行态再终态恢复）；`npx vitest run tests/client/export-button.test.tsx tests/client/silent-export.test.ts tests/client/export-dialog-portal.test.tsx` → 16/16 pass；`npm run typecheck`/`lint` → 0。修复一个 React 缺陷：单例原地复用 view 对象导致 `setState` 因 `Object.is` 相等而 bail out（emit 改发 `{...view}` 快照）；测试文件由 `.ts` 更名为 `.tsx`，断言用 `.disabled`（未装 jest-dom）
- [X] T062 [US5] 非阻塞 toast：`shell.overlay` 注册 `ToastHost` + `toast-store`；成功/降级显示落点与说明并约 6s 自动消失，失败常驻显示原因 + 「重试」/「打开设置」；栈上限 3、`aria-live="polite"`、成功 `role=status`/失败 `role=alert`、toast 根 `pointer-events:auto`；测试断言自动消失、失败不消失、重试回调、上限淘汰、可访问属性与新增 toast 文案键 zh/en 键集一致 —— file: tests/client/toast-host.test.tsx, client/src/toast-store.ts, client/src/components/ToastHost.tsx, client/src/entry.tsx, client/src/locales.ts — FR-020/SC-009 — 验证: 🔴 `npx vitest run tests/client/toast-host.test.tsx` → 模块不存在（0 test）→ 🟢 9/9 pass（成功 6s 消失/失败 60s 常驻、上限 3 淘汰最旧、单条 dismiss、aria-live=polite + status/alert、卡片 pointer-events:auto、降级说明、重试/打开设置回调、成功无操作按钮、zh/en 键集一致）；`npx vitest run` → 214 passed/1 skipped（29 files）；`npm run typecheck`/`lint` → 0。配套改动：`silent-export.ts` 增 `onSettled`（按 `key:taskId` 只发一次终态）、`slots.d.ts` 声明 `shell.overlay`、`slot-registration` 期望补第四处 inject、export-silent 临时目录清理加 Windows 重试（lastPath 回写在途致 ENOTEMPTY，断言未放宽）
- [X] T063 [US5] 隔离 Host E2E（V9–V11）：验证关闭开关后点击不弹窗、按钮加载期间对话可继续、切会话后任务完成并出 toast、3 条并发各 1 篇；V10d 关窗/重启无半成品与真实模型/思源写入、浏览器计时按 quickstart 记录为手工证据，不以单测冒充 —— file: tests/e2e/change-silent.test.ts — 无行为变更（仅隔离验证）— 验证: `npx vitest run tests/e2e/change-silent.test.ts` → 5/5 pass（V9 开关关闭走 silent 且生成中可并行发起第二条、完成后 success toast 含落点；V11 无订阅者时单例续跑并落 toast、重挂载读终态；3 并发各 1 篇且重复点击零新增；V10 失败 toast 含 `siyuan-connect`、重试仅落一篇且不重调 LLM；V10d 数据目录仅 `prefs.json`）；全量 `npx vitest run` 连续 3 次 → 30 files / 219 passed + 1 skipped；`npm run typecheck`/`lint` → 0。未执行（按 quickstart 记手工证据）：真实浏览器计时与录屏、真实 dsh 关窗/重启、真实模型与真实思源写入、V8 侧栏/设置页渲染 — 补记（2026-11-11，用户手工核验，构建 c247b5e）：真实 dsh 重启、真实思源写入、浏览器渲染与 V9–V11 手工项已通过；计时与录屏未归档

**Checkpoint**: US5 可独立验证——静默路径不弹窗、不阻塞、结果可见可重试；US4 设置可回退。

---

## Phase 11: Change 收尾

- [X] T064 Change 全矩阵证据回填：按 quickstart **V8–V12** 执行并回写执行记录（成功的写命令与结果，未执行的写「未验证（原因）」）；核对 README 使用说明（侧栏设置、静默模式、未验证边界）与 spec/plan/contracts 无漂移 —— file: quickstart.md, README.md, tasks.md — 无行为变更 — 验证: `npx vitest run tests/client/settings-panel.test.tsx tests/unit/prefs.test.ts` → 18/18（V8 组件/逻辑、V12 迁移含 v1→v2 与损坏 JSON）；quickstart 追加 Change 执行表（V8–V12 逐条 ✅隔离/单测 或 ⏳手工，并列出仍未真实复现项）；README 增补侧栏设置、静默模式、toast 与「未验证边界」四条；核对 `contracts/rpc.md` 已含 `intent`/`mode:'silent'`/`showDialog`/静默 toast 语义，无漂移 — 补记（2026-11-11，用户手工核验，构建 c247b5e）：V8–V12 真实宿主手工项全部通过；quickstart 执行表已回填（计时/抽样/截图仍标注未归档）
- [X] T065 弹窗预填回退设置默认路径（FR-006 MODIFIED；analyze 发现 Host 已返回 `defaultPath` 但 Client 只消费 `lastPath`，与 contracts/rpc.md 漂移）：`tests/client/export-button.test.tsx` 新增用例「dialog 响应无上次路径时用设置默认路径预填落点」（两个笔记本，默认路径不是首本，断言默认本被选中、首本未选中）；`client/src/entry.tsx` 弹窗初始 `target = opened.lastPath ?? opened.defaultPath`、传入 DocTree 的 `initialPath = dialog.target` —— file: tests/client/export-button.test.tsx, client/src/entry.tsx — 验证: 🔴 `npx vitest run tests/client/export-button.test.tsx` → 1 failed / 7 passed（`aria-selected` 期望 true 收到 false）→ 🟢 8/8 pass；`npx vitest run tests/client` → 10 files / 69 passed；`npm run typecheck`/`lint` → 0

---

## Change 2026-11-11 · Dependencies & Execution Order

### 关键依赖

```text
T049 → T053（偏好 v2 → 设置面板读写）
T051 → T053（prefs RPC → 设置面板）
T050 → T057（落点解析 → 静默 open）
T051 → T057（契约/路由 → 模式分派）
T052 → T053（侧栏/主面板 → 设置内容）
T053 → T055（面板基础 → 加载/离线容错）
T054 → T055（树键盘 → 面板内选择器；可先并行开发）
T052–T055 → T056（US4 E2E）
T057 → T058 → T059（分派 → 并发编排 → 失败重试；同文件串行）
T057 → T060 → T061 → T062（契约/单例 → 按钮 → toast；entry.tsx 串行）
T057–T062 → T063（US5 E2E）
T049–T063 → T064（证据回填）
```

### 并行机会

- Foundation：`T049 ∥ T050 ∥ T051`（不同文件；T051 触碰 contract/routes 与其余不冲突）
- US4：`T054 ∥ T053`（DocTree 与 SettingsPanel 不同文件）；`T052` 先于 `T053` 接线
- US5：`T057` 完成后，`T058/T059` 同文件串行；`T060` 可在 `T057` 后与 `T058` 并行（Client 与 Host 不同文件）
- US4 与 US5 可在 Foundation 后并行；`T056` 与 `T063` 分别依赖各自故事完成

### 执行策略

1. 先完成 T049–T051（v2 偏好、落点、7 方法契约）并跑绿。
2. US4（T052–T056）先交付可发现的设置入口与持久化；可独立演示。
3. US5（T057–T063）再接通静默链路与 toast；每个行为任务严格红→绿→重构，同文件任务串行。
4. T064 统一回填 quickstart 证据；未真实验证的项目保持「未验证」。

---

## Phase 12: Convergence

> 来源：`/speckit-converge`（2026-11-11，实现后复核：spec.md FR/SC/US、plan.md Change 增量设计 §1–§7、tasks.md T001–T065 声明与实际代码）。宪法：占位模板（跳过）。Append-only：不改 T001–T065，只追加本节。

- [X] T066 修复静默重试后的终态提示：`SilentExportManager` 的终态去重不能永久按 `key:taskId` 锁定（Host 的 `taskId` 就是幂等键，重试复用同一 taskId），`retry()` 需重置该键的终态标记；同一 taskKey 的新终态到达时替换旧失败 toast（不堆叠），重试再失败只更新同一条；测试改用与 Host 一致的 fake（重试返回同一 taskId）覆盖「写失败 → 重试成功 → 成功 toast 含落点且旧失败提示消失」 —— per FR-020/SC-009 + plan: §6 重试提示 (partial) [HIGH] — file: tests/client/silent-export.test.ts, tests/client/toast-host.test.tsx, tests/e2e/change-silent.test.ts, client/src/silent-export.ts, client/src/toast-store.ts, client/src/entry.tsx — 验证: 🔴 `npx vitest run tests/client/silent-export.test.ts tests/client/toast-host.test.tsx`（现 fake 用「新 taskId」掩盖冲突，改为 Host 语义后失败）→ 🟢 全绿 + `npx vitest run tests/e2e/change-silent.test.ts` 新增重试成功用例 — 验证: `npx vitest run tests/client/silent-export.test.ts tests/client/toast-host.test.tsx tests/e2e/change-silent.test.ts` → 24/24 pass（红：4 failed；绿：3 files pass） — 补记（2026-11-11，用户手工核验，构建 c247b5e）：真实宿主 V10 重试后终态提示已通过
- [X] T067 弹窗模式成功落点反馈：`submit`/`retry` 的 commit 成功后不立即关闭弹窗，置 `succeeded` 并保留 target（可带 href），由用户关闭完成 SC-001 的第三次点击；复用 `ExportDialog` 既有 succeeded 分支，不新增样式体系 —— per FR-012 (partial) [HIGH] — file: tests/client/export-button.test.tsx, client/src/entry.tsx — 验证: 🔴 `npx vitest run tests/client/export-button.test.tsx` 新增「commit 成功后弹窗仍在且显示已导出到：<display>」→ 🟢 全绿（dialog 既有用例不回归） — 验证: `npx vitest run tests/client/export-button.test.tsx` → 11/11 pass（红：新增 2 例 failed）；同轮把 tests/client/export-dialog-portal.test.tsx 的「成功自动关闭」用例改为「成功后保留并显示落点」→ 2/2 pass
- [X] T068 传输失败不得弹出导出弹窗：`startExport` 的 catch 分支不再无条件 `setDialog(failed)`；改为非阻塞失败提示（含「重试」，重试重新 `export.open` 且不带 `intent`，由 Host 按当前偏好重新分派；若返回 `mode:'dialog'` 则提示回到该条回复确认），静默模式保证不出现任何弹窗；测试覆盖 open 拒绝 → 无 overlay、按钮回 idle、失败可重试 —— per FR-017/FR-020 (contradicts) [MEDIUM] — file: tests/client/export-button.test.tsx, client/src/entry.tsx, client/src/silent-export.ts — 验证: 🔴 `npx vitest run tests/client/export-button.test.tsx`（新增 open reject 用例：现存实现渲染 overlay）→ 🟢 全绿 — 验证: `npx vitest run tests/client/export-button.test.tsx` → 12/12 pass（红：1 failed）
- [X] T069 设置面板打开即探测思源可用性：`prefs.get` 成功后探测 `treeList({})`，失败在默认存放路径区块就地显示可理解原因 + 重试，保留已保存路径、开关仍独立可保存；探测结果可复用于 DocTree 避免重复请求 —— per US4-6 / FR-022 (partial) [MEDIUM] — file: tests/client/settings-panel.test.tsx, client/src/components/SettingsPanel.tsx — 验证: 🔴 `npx vitest run tests/client/settings-panel.test.tsx` 新增「不展开树即显示 siyuan-connect 原因」「已保存路径仍在」「重试恢复」→ 🟢 全绿 — 验证: npx vitest run tests/client/settings-panel.test.tsx → 12/12 pass（红：新增 2 例 failed）
- [X] T070 补齐 T056 声明的设置 E2E 产物：新增 `tests/e2e/change-settings.test.ts`，用临时 `DSH_HOME` + 真实 `PrefsStore`/`createPrefsHandlers`/`createRpcRoute` 复现 V12（v1→v2 迁移、`showDialog:false` 落盘、新建 store 实例模拟重启后保留、损坏文件回退默认），并在任务证据中标注真实宿主安装与浏览器交互仍为 quickstart 手工项 —— per T056 (partial) [MEDIUM] — file: tests/e2e/change-settings.test.ts — 验证: 🔴 `npx vitest run tests/e2e/change-settings.test.ts`（文件不存在）→ 🟢 全绿 — 验证: npx vitest run tests/e2e/change-settings.test.ts → 3/3 pass（红：No test files found，exit 1）；真实宿主安装与浏览器交互仍为 quickstart 手工项，未验证
- [X] T071 补齐设置保存状态条：在面板中显示「保存中… / 已保存 / 错误」的可见状态（`aria-live="polite"`），失败仍在对应区块就地报错；不引入全局保存按钮，保持 SC-010 ≤4 次交互 —— per plan: §4 状态条 (partial) [LOW] — file: tests/client/settings-panel.test.tsx, client/src/components/SettingsPanel.tsx — 验证: 🔴 `npx vitest run tests/client/settings-panel.test.tsx` 新增「保存中→已保存」可见状态断言 → 🟢 全绿（即时保存/回滚用例不回归） — 验证: npx vitest run tests/client/settings-panel.test.tsx → 14/14 pass（红：新增 2 例 failed）
- [X] T072 同步侧栏入口名称文档：把 `spec.md` US4-1/FR-014 的「导出设置」表述更新为「Siyuan Export」（用户 2026-11-11 明确要求改名），保留 `biji.svg` 与可访问名称约束；代码与 README 已一致，不改代码 —— per FR-014 (contradicts) [LOW] — 无行为变更（纯文档） — 验证: 纯文档改动，编辑 spec.md 第 66/74/137 行后 grep 确认无残留「导出设置」引号表述

## Phase 13: Convergence

> 来源：`/speckit-converge`（2026-11-11，Phase 12 实现后复核：spec.md FR/SC/US、plan.md Change 增量 §1–§7、tasks.md T001–T072 声明与当前代码）。宪法：占位模板（跳过）。Append-only：不改 T001–T072，只追加本节。

- [X] T073 消除静默导出集成测试的时间竞态：`tests/integration/export-silent.test.ts` 的「数据目录只有 prefs.json」在 `state()` 报 succeeded 后立即 `readdir`，而 `writeTask` 先置 succeeded 再 `await prefs.update`（原子写临时文件可能尚未 rename），全量并发运行时偶发失败（本会话 `npm test` 2 次中 1 次失败、单跑 8/8）；改为 `vi.waitFor` 等待目录收敛（对齐 `tests/e2e/change-silent.test.ts` 既有写法），并给 `setup()` 增加可注入的 `prefsOps`（慢 rename）让红灯稳定复现 —— per SC-006 / T058 验证口径 (partial) [MEDIUM] — file: tests/integration/export-silent.test.ts, src/export/export-service.ts — 验证: 🔴 `npx vitest run tests/integration/export-silent.test.ts`（注入 80ms rename 后立即 readdir 读到 `prefs.json.tmp-mwc1s9sy-ow8l79`）→ 🟢 复跑中又暴露同源第二处竞态：首用例轮询 `prefs.read()` 与原子 rename 并发，Windows 下 readFile 持续占住目标文件使 rename 连续 EPERM（独立探针：5ms 轮询读 + 300 次 rename → 71 次 EPERM），`writeTask` 按设计吞掉回写失败 → `lastPath` 恒为 null；改为 `setup()` 记录那次 `prefs.update` 的 Promise，断言前 `await` 它（不再读同一文件）→ 本会话 `npx vitest run tests/integration/export-silent.test.ts` 连续 20/20 pass；`npm test` 连续 3 次 31 files / 235 pass + 1 skipped 全绿；`npm run typecheck`、`npm run lint` 通过
- [X] T074 对齐静默导出「成功后再次点击」的语义：`plan.md` §5 规定同键 `succeeded` 重置为 `ready` 再写一篇，但 `contracts/rpc.md`（已有任务不重复写入）、`openSilent`/`SilentExportManager.track` 与 e2e「重复点击不再写第二篇」均按去重实现（与 SC-006 一致，且已由用户真实核验）。按去重为准修正 plan §5 该行描述，使 plan 与契约/实现/测试一致，不改产品行为 —— per plan: §5 静默执行与并发 (contradicts) [LOW] — 无行为变更（纯文档） — file: specs/001-siyuan-note-export/plan.md — 验证: 纯文档改动，改后 `grep -rn "重置为 ready 再写一篇" specs/` 仅命中本任务描述本身，`plan.md` §5 与 `data-model.md` 状态表均无残留；同时把 `data-model.md` 该行拆成弹窗/静默两行，避免第二处矛盾；实现后 analyze 复核发现原稿「从弹窗模式重新发起」在同键静默任务上不可达（commit 拒绝且任务被置 ready），已改为「新 contentRevision」描述，跨模式行为缺口另建议以 converge 追加任务

## Phase 14: Convergence

> 来源：`/speckit-converge`（2026-11-11，Phase 13 实现后复核：spec.md FR/SC/US、plan.md Change 增量 §1–§7、tasks.md T001–T074 与当前代码）。宪法：占位模板（跳过）。Append-only：不改 T001–T074，只追加本节。

- [X] T075 修复跨模式同键导出的破坏性重置：静默导出已 `succeeded` 后重新打开「显示弹窗」并再次点击同一回复，主按钮走 `open({ messageId, sessionId })`（auto）→ `openDialog` 命中既有静默任务时仍把 `status` 重置为 `ready` 并返回 `mode:'dialog'`（`src/export/export-service.ts:193-212`），随后 `commit` 因 `task.mode==='silent'` 直接拒绝（`:437-440`），任务停在 `ready`，Client 的 `toSilentStatus('ready')` 一直视为进行中、按钮可能一直转圈；改为「既有任务 mode 优先」：`openDialog` 命中静默任务时委托静默分支（`openSilent`）返回其当前状态，不重置、不改写、不进入 commit 路径，也不新增文档 —— per FR-025 / US5/AC2 (contradicts) [HIGH] — file: tests/integration/export-silent.test.ts, src/export/export-service.ts — 验证: 🔴 新增用例（静默成功 → `prefs.update({ showDialog: true })` → 同键 `open` 期望 `mode:'silent'`、`status:'succeeded'`、文档数不变；当前返回 `mode:'dialog'` + `status:'ready'`）→ 🟢 `npx vitest run tests/integration/export-silent.test.ts` 全绿且 `npm test` 全绿 — 结果: 🔴 `npx vitest run tests/integration/export-silent.test.ts` → `expected 'dialog' to be 'silent'`（8 passed / 1 failed）；🟢 修复后同命令 9/9 pass（含慢 rename 用例），重构出 `respondExistingSilent` 复用失败重试分支后仍 9/9；`npm run typecheck` 通过（修复 `openDialog` 返回类型为 `ExportOpenData`）、`npm run lint` 通过；`npm test` → 31 files / 236 passed + 1 skipped 全绿

## Phase 15: Convergence

> 来源：`/speckit-converge`（2026-11-12，Phase 14 实现后复核：spec.md FR/SC/US 与 edge cases、plan.md Change 增量 §1–§7、contracts/rpc.md、data-model §2.1/§5、tasks.md T001–T075 与当前代码）。宪法：占位模板（跳过）。Append-only：不改 T001–T075，只追加本节。

- [X] T076 修复反向跨模式的弹窗泄露：`openSilent` 命中既有**弹窗**任务时直接 `toDialogData` 返回 `mode:'dialog'`（`src/export/export-service.ts:270`），用户关闭「显示弹窗」后在同一回复上再点导出仍会打开弹窗，违反 FR-017；且 succeeded 任务在弹窗内 commit 报「该回复已导出」、cancelled 报「导出已取消」，用户无出路（T075 只修了 silent→dialog 方向）。改为按静默语义收敛：`succeeded` → 返回 `mode:'silent', status:'succeeded'` + 既有 target/href，不重复写入；`writing` → 返回 `mode:'silent', status:'writing', alreadyRunning:true`，轮询到终态即 toast；其余状态（generating/ready/degraded-ready/failed/cancelled）→ 中止并移除旧弹窗任务，按静默落点（FR-018/FR-023）重建静默任务，有缓存 body 时直接写入、不重调 LLM；全程不打开弹窗 —— per FR-017/FR-018/FR-025 (contradicts) [HIGH] — file: tests/integration/export-silent.test.ts, src/export/export-service.ts — 验证: 🔴 新增三条用例（① 弹窗导出 succeeded 后 `prefs.update({ showDialog: false })` → 同键 `open` 期望 `mode:'silent'`、`status:'succeeded'`、文档数/LLM 调用数不变，当前返回 `mode:'dialog'` + `status:'ready'`；② 弹窗任务 ready 未提交 → 关闭开关后再点，期望 silent 自动写入且仅调 1 次 LLM；③ 弹窗 commit 失败 → 关闭开关后再点，期望 silent 复用缓存 body 写入、只落 1 篇）→ 🟢 `npx vitest run tests/integration/export-silent.test.ts` 全绿，`npm run typecheck`/`lint` 通过，`npm test` 全绿 — 结果: 🔴 `npx vitest run tests/integration/export-silent.test.ts` → 三条新用例均 `expected 'dialog' to be 'silent'`（9 passed / 3 failed）；🟢 新增 `adoptDialogForSilent` 后同命令 12/12 pass；`npm run typecheck` 通过、`npm run lint` 通过；`npm test` → 31 files / 239 passed + 1 skipped 全绿。实现说明：同一幂等键下的任务就地转静默（taskId 不变），生成中沿用进行中的 LLM 流而不中止重建，取消态才重新生成；succeeded/writing 不改道、不重复落盘
- [X] T077 同步跨模式语义文档（T076 完成后）：更新 `plan.md` §1「弹窗分支完全保留现有行为与类型语义」与 §5 的跨模式描述（silent 意图命中既有弹窗任务按静默语义收敛）；在 `contracts/rpc.md:44-45` 明确「本次 `intent`/`Prefs.showDialog` 判定模式，同键既有任务按静默语义返回、不因任务创建模式打开弹窗」；`data-model.md` §2.1 规则与 §5 状态表补跨模式行；把 `quickstart.md:70` V8 的侧栏入口名「导出设置」改为 `Siyuan Export`（与 `client/src/locales.ts:17` 及 FR-014 一致）—— per FR-014/FR-017 + plan §1 (partial) [LOW] — 无行为变更（纯文档） — file: specs/001-siyuan-note-export/plan.md, specs/001-siyuan-note-export/contracts/rpc.md, specs/001-siyuan-note-export/data-model.md, specs/001-siyuan-note-export/quickstart.md — 验证: 纯文档改动，改后 `grep -n "导出设置" specs/001-siyuan-note-export/quickstart.md` 无命中，plan/contracts/data-model 的跨模式描述与 T076 实现及测试断言一致 — 结果: `grep -n "导出设置" specs/001-siyuan-note-export/quickstart.md` → 无命中（exit=1）；plan §1/§5（`:143`/`:193`）、contracts/rpc.md 模式判定与幂等条目、data-model §2.1 规则与 §5 字段/状态表均已补跨模式语义，措辞与 `adoptDialogForSilent` 及 T076 三条集成用例一致；无代码改动，未新增测试
