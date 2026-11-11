# Implementation Plan: 思源一键导出（SiYuan Note Export）

**Branch**: `001-siyuan-note-export` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-siyuan-note-export/spec.md`

## Summary

为 dsh 交付一个**树外插件**：每条助手回复操作栏出现「导出到思源」按钮 → 弹窗（预填 LLM 生成的主题名 + 思源文档树路径选择器，记住上次成功路径）→ 确认后调用宿主 LLM，**仅以该条单次输出为输入、不携带对话上下文**（FR-013）生成主题名并重排为带小图标的结构化笔记 → 经思源 HTTP API 写入所选路径，失败可重试且内容不丢。四域技术路线已拍板（见 [tech-decisions.md](tech-decisions.md)）：dsh 树外插件 + 思源 HTTP API + 宿主 LLM 通道 + 宿主风格自绘 UI，**0 个运行时 npm 依赖**。Phase 0 已实证：按钮挂载点为官方 slot `conversation.chat.assistant-actions`（[research.md](research.md) R1，含注册纪律与定稿消息边界）；LLM 通道 `ctx.llm.prepareCall(config, signal?, configure?)` 与 `listProviders()/listModels()` 解析可用（R2）；思源侧全部走官方 API，同名经查重消歧硬保证不覆盖（R3 + [contracts/siyuan.md](contracts/siyuan.md)）。

**Change 2026-11-11（侧栏设置 + 静默导出）**：新增一个带 `biji.svg` 图标的侧栏入口 → 主工作区设置面板（默认存放路径 + 「导出时显示弹窗」开关，默认开启，保存即生效）；开关关闭时点击导出按钮不弹窗，Host 在后台完成生成与写入，按钮保持运行态、对话不被阻塞，成功以非阻塞 toast 显示落点，失败显示原因与重试。落点先取设置中的默认路径，未配置时回退到「当前笔记本」根目录（无官方活动笔记本 API，按 research R7 取 `lsNotebooks` 第一本未关闭笔记本）；偏好沿用插件自有单一权威状态并做 v1→v2 迁移。新增四域选型 D5–D8 见 [tech-decisions.md](tech-decisions.md)（独立入口 + 自绘面板 / 扩展 PrefsStore / Host 复用 ExportService / shell.overlay 自绘 toast），**仍为 0 个新运行时依赖**。

## Technical Context

**Language/Version**: TypeScript（Host 侧 Node ≥ 24.9.0；Client 侧浏览器）；宿主基线 dsh `0.2.2-rc.1`（`@deepseek-ai/dsh-root`，pnpm 11 workspace）

**Primary Dependencies**: 运行时 npm 依赖 **0 个**；宿主 Cordis/dsh 包按需声明 `peerDependencies` + `devDependencies`（选型依据：见 [tech-decisions.md](tech-decisions.md)）

**Storage**: 导出产物 → 思源（HTTP API 写入笔记本文档）；插件偏好（上次成功路径、默认存放路径、弹窗开关、弹窗草稿） → 宿主数据根 `resolveDshHome()` 下插件自有单一权威状态 `prefs.json`（v2；v1 读取时迁移，损坏/缺失回退默认值；原子发布，不形成双事实源）；导出任务状态仅 Host 内存；思源 API Token → 插件 Config（凭据不入状态文件/日志/RPC 响应）

**Testing**: Vitest 分层（纯业务单元 → Temp 目录集成 → Client/RPC/handoff 产物）+ 隔离 `DSH_HOME`（web profile）真实 Host E2E；思源与模型均以 fake 边界（fake HTTP 端口 / 假 prepared call）测试，真实小请求单独验证，不以单测冒充端到端；本 Change 增加：偏好 v1→v2 迁移、静默任务并发/跨会话生命周期、设置面板键盘操作、toast 可见性

**Target Platform**: dsh Web（浏览器）+ 本机 dsh Host；Windows 优先但不硬编码用户目录与本机路径

**Project Type**: 树外插件（Cordis Host bundle + Client CJS closure-factory handoff，`dsh.bundle.patch` 安装）

**Performance Goals**: 点击 → 弹窗 < 1s；LLM 重排 + 写入 95% < 30s（SC-002）；静默导出点击 → 结果提示 95% < 30s 且对话输入/发送 0 次阻塞（SC-008）；LLM 输入仅含单次输出以节省 token（FR-013）

**Constraints**: 不修改 dsh 源码与 Session 历史（append-only，不改写既有消息）；错误响应不含堆栈/内部路径/正文秘密；同名文档不覆盖不合并（FR-007）；一次确认只产生一篇笔记（FR-011）；LLM 输入禁止携带对话上下文（FR-013）；静默导出的目标路径失效时失败并说明原因，不静默改写（FR-023）；不同回复互不阻塞、同一回复同时只有一次进行中导出（FR-025）；设置变更无需重启即生效（FR-016）；面板遵循 app screen 规则（无渐变/玻璃拟态/发光，键盘可达）

**Scale/Scope**: 单用户本机插件；2 个功能切片（单次输出导出；设置 + 静默导出）；UI = 1 弹窗 + 2 个文档树入口（弹窗内 / 设置页内）+ 1 设置面板 + 1 toast 栈；25 条 FR、11 条 SC

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 为未初始化的占位模板（无已批准原则、无版本与批准日期）→ **本轮无生效门禁，Gate 通过（无约束可违）**。不阻塞 Phase 0；建议特性交付后用 `/speckit-constitution` 初始化项目宪法。

无宪法期间按通用纪律自查（均通过）：

- **树外原则** ✓：不修改 dsh 源码、Remote 注册表与 Session 持久化格式（ADR-0001）
- **数据归属** ✓：状态写 `resolveDshHome()` 数据根下插件自有目录，不写插件仓库、不硬编码用户目录
- **验证分层** ✓：quickstart 覆盖隔离 Host 真实 E2E，四类事实（模型可见/已排队/已持久化/UI 已显示）分别定义确认信号

**Phase 1 设计后复检（Re-check）**：✅ 通过——设计产物（research / data-model / contracts / quickstart）未引入新违例；两个适配器 seam 已过三问并记入 Complexity Tracking；凭据纪律补充落实：思源 Token 只存插件 Config，不入日志、审计、状态文件与 RPC 响应（contracts/siyuan.md）。

**Change 2026-11-11 复检**：✅ 通过——宪法仍为占位模板，无新增门禁；本 Change 继续遵守树外原则（只注册宿主公开 slot、不改 dsh 源码与 Session）、数据归属（偏好仍写 `resolveDshHome()` 下插件目录）、0 新运行时依赖、app screen 与键盘可达要求已落入 data-model / quickstart；新增 `siyuan/target.ts` 与 `client/silent-export.ts` 两个 seam 已过三问并记入 Complexity Tracking。

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
├── contract.ts             # Host/Client 共享 RPC 类型（7 方法；dialog/silent 联合响应）
├── api/
│   └── routes.ts           # webServer.register() 同源 prefix 路由；白名单 7 方法、字段校验、错误映射
├── export/
│   ├── export-service.ts   # 导出编排：弹窗/静默模式分派、状态机、防重、并发边界
│   ├── llm.ts              # 宿主 LLM 适配器：ctx.llm.prepareCall()→stream()；FR-013 输入裁剪、输出预算、降级标题
│   └── format.ts           # 结构化笔记排版：标题层级、要点小图标、代码块/列表保留
├── siyuan/
│   ├── client.ts           # 思源 HTTP API 适配器：Token、错误分类、重试
│   ├── tree.ts             # 文档树读取、路径解析与选中位置定位
│   └── target.ts           # 默认路径校验 + 静默落点解析（设置路径 → 上次笔记本根 → 首个笔记本根）
└── store/
    └── prefs.ts            # 偏好 v2：lastPath/defaultPath/showDialog/draft；v1 迁移、原子发布

client/
├── src/entry.tsx           # Client 入口：assistant-actions / sidebar.panellist / main / shell.overlay
├── src/rpc.ts              # 类型化同源请求（与 contract.ts 共享类型，运行时仍校验）
├── src/silent-export.ts    # 静默任务单例：后台轮询、跨会话保持加载态、完成即推 toast、按 sessionId+messageId 防重
├── src/toast-store.ts      # 非阻塞提示队列（成功/失败/重试动作，上限与自动消失）
├── src/svg.d.ts            # `*.svg` 模块声明（esbuild dataurl）
├── src/components/
│   ├── BijiIcon.tsx        # 侧栏图标：biji.svg（dataurl）+ 失败降级，可访问名称由 label 元数据提供
│   ├── ExportButton.tsx    # 消息操作栏导出按钮（弹窗/静默共用；运行态禁用）
│   ├── ExportDialog.tsx    # 导出弹窗：主题名输入 + 路径选择 + 生成中/成功/失败反馈 + 重试
│   ├── DocTree.tsx         # 思源文档树选择器（自绘，展开/选中态；补充键盘操作）
│   ├── SettingsPanel.tsx   # 主工作区设置面板：默认路径 + 弹窗开关 + 即时保存/失败回退
│   └── ToastHost.tsx       # shell.overlay 提示栈（aria-live、重试/打开设置、自动消失）
└── src/styles.css          # 对齐宿主主题变量，不引入第二份样式体系

biji.svg                   # 侧栏图标源文件（构建时 dataurl 内联）
scripts/build-client.mjs   # Client handoff 构建（__ModuleLoader__.load 闭包工厂，无裸 ESM；svg→dataurl）
cordis.patch.yml           # Host bundle patch（package.json 的 dsh.bundle.patch 指向）
package.json               # 加载契约：type:module、exports["."]、exports["./client"]、engines.dsh、files

tests/
├── unit/                   # 状态机、幂等防重、排版、路径解析、FR-013 输入裁剪；偏好 v1→v2 迁移；
│                           # 静默落点解析（设置路径/上次笔记本/首笔记本/无笔记本）；目标校验错误分类
├── integration/            # Temp 目录原子写/锁竞争/删除重建、fake 思源端口、假 prepared call；
│                           # 静默自动提交、写失败重试复用 body、3 并发各 1 篇
├── client/                 # slots 注册（sidebar/main/overlay）、RPC 往返、stale response、
│                           # 静默单例跨卸载继续、toast 队列/键盘、设置面板即时保存与失败回退、
│                           # handoff 产物（factory 执行断言、biji dataurl）
└── e2e/                    # 隔离 DSH_HOME 真实 Host：安装→启动→真实 UI→真实模型/思源各自由证据确认
```

**Structure Decision**: 单仓库树外插件，按职责分层（Host `src/` + Client `client/` + 共享契约 `contract.ts` + 分层 `tests/`），不把逻辑塞进入口文件——采用 develop-dsh-plugin 推荐布局，前后端（Host/Client）同仓以保证 RPC 类型单一来源。

## Complexity Tracking

> 仅记录确实需要辩护的复杂度（新模块三问已过：删除测试 → 散到调用方而非消失；两侧真会变且生产+测试两实现；接口明显小于实现）。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| SiYuan / LLM 适配器 seam（`siyuan/client.ts`、`export/llm.ts`） | 外部副作用边界：测试需 fake 端口与假 prepared call；错误分类、重试与 FR-013 输入裁剪集中收口 | 直接在导出服务内调 HTTP/模型流，会让状态机测试依赖真实网络与宿主，且输入裁剪逻辑散落各处无法断言 |
| 落点解析 seam（`siyuan/target.ts`） | FR-018/FR-023 的「设置路径 → 当前笔记本根」「失效即失败不改写」需要两个调用方（静默导出、设置保存校验）共用；测试用 fake client 覆盖无笔记本/路径失效/认证失败 | 规则直接写进 `export-service.ts` 与 `routes.ts`：两处会重复且可能分叉，单测需构造完整服务与 HTTP |
| 静默任务单例（`client/src/silent-export.ts`） | 任务生命周期必须独立于消息行组件：切换会话/面板后仍要轮询、保留按钮加载态并在完成时弹 toast；测试注入 fake client 验证跨卸载与按 sessionId+messageId 防重 | 把轮询放在 `SiyuanExportAction` 的 effect 里：卸载即中止/丢结果，违背 FR-019/FR-025，且重复点击无法在组件间去重 |

## Change 增量设计（2026-11-11）

### 1. 模式分派：Host 权威，Client 只消费结果

- `export.open` 请求增加可选 `intent?: 'auto' | 'silent'`（默认 `auto`；retry 用 `silent`）。
- Host 在 `open` 内读取偏好：`intent === 'silent'` 或 `showDialog === false` → 静默分支；否则保持现有弹窗分支。
- 响应改为判别联合：
  - `{ mode: 'dialog', taskId, status, title, lastPath, defaultPath, error }`（原字段 + 默认路径回退）；
  - `{ mode: 'silent', taskId, status, target, targetFrom, error, degraded, alreadyRunning }`。
- 静默分支的**业务失败也以 `mode:'silent'` 数据返回**（如落点解析失败、空回复），保证 Client 无需先读偏好即可决定「不弹窗」；传输失败仍由 Client 统一转 toast。
- 弹窗分支完全保留现有行为与类型语义，减少回归面。

### 2. 静默落点解析（FR-018 / FR-023）

`siyuan/target.ts` 导出两个职责：

- `resolveSilentTarget(prefs, client)`：
  1. `prefs.defaultPath` 存在 → 校验笔记本存在、`parentSegments` 可解析（`getIDsByHPath`）；失败 → `siyuan-path`，**不回退**；
  2. 否则用 `prefs.lastPath.notebookId` 定位「当前笔记本」，取其根（`parentSegments: []`）；
  3. 无历史成功路径 → 取 `lsNotebooks` 返回顺序的第一个笔记本根；
  4. 无任何笔记本 → `siyuan-path`「思源中还没有笔记本，请先创建一个」。
- `validateTarget(path, client)`：设置保存时校验笔记本 + 父级 hpath；失败不写入偏好，设置页保留上一个有效值。

「当前笔记本」没有官方「活动笔记本」API（R7），因此固定为「最近成功导出所在笔记本 → 首个笔记本」；该规则写入 data-model 并作为产品假设记录，避免隐式随机选择。

### 3. 偏好 v2（FR-015 / FR-016 / FR-022）

```ts
interface PrefsData {
  version: 2
  lastPath: StoragePath | null
  defaultPath: StoragePath | null
  showDialog: boolean          // 默认 true
  draft: PrefsDraft | null
}
```

- `read()`：文件缺失/JSON 损坏 → 默认值；`version === 1` → 迁移（保留 lastPath/draft，补 `defaultPath:null`、`showDialog:true`）；未知版本 → 默认值。
- `update()` 继续走串行队列 + 临时文件原子切换；`showDialog:false` 与 `defaultPath:null` 都必须能写入（`definedPatch` 已保留 `false`/`null`）。
- 设置保存成功才更新 UI 的「已保存」值；失败保持旧值并就地报错。

### 4. 设置面板（US4 / FR-014–016 / FR-024）

- 注册三元组：
  - `sidebar.panellist`：`id = 'siyuan-export.settings'`、`label` 提供可访问名称、图标组件渲染 `biji.svg`（dataurl `<img>`，失败降级为无文字占位，不丢 label）；
  - `main`：`key` 与 `id` 相同；侧栏点击由宿主 `selectPanel(id)` 切换；页面为普通主面板，不是模态；
  - `shell.overlay`：toast 宿主（见下）。
- 页面结构：标题/说明 → 默认存放路径区块（当前值、选择/清除、内嵌 `DocTree`）→ 弹窗开关区块 → 状态条（保存中/已保存/错误）。
- 交互：开关与路径选择均**即时保存**（无全局保存按钮，满足 SC-010 ≤4 次交互）；保存失败回退显示 Host 值。
- 思源不可用：路径区块显示原因 + 重试，**不清空**已保存路径（US4-6）；开关仍可修改（不依赖思源）。
- 键盘：原生按钮/开关；`DocTree` 行补 `tabIndex`、Enter/Space 选择、←/→ 折叠/展开；焦点样式使用宿主变量。
- 样式：app screen 规则——无渐变、无玻璃拟态、无发光、无图标色块；细边框、小标签、重复区块；颜色/间距全部走 `--dsh-*` 变量。

### 5. 静默执行与并发（US5 / FR-017–021 / FR-025）

- `ExportService.open` 静默分支：读取单次输出 → 解析落点 → 复用/创建任务 → **立即返回**，后台执行「生成 → 自动 commit」；Client 轮询 `export.state`。
- 幂等键仍为 `sessionId:messageId:contentRevision`：
  - 同键 `generating/writing` → 返回 `alreadyRunning:true`，不启动第二条流水线；
  - 同键 `ready/degraded-ready/failed` → 复用缓存 body 直接重试写入（不重调 LLM）；
  - 同键 `succeeded` → 重置为 `ready` 再写一篇（用户再次点击 = 新的一次导出）。
- 不同 messageId 的任务互不等待；同一任务的写入由 `writing` 门闩保护。写入成功仍回写 `lastPath`，不改 `defaultPath`。
- 生成失败沿用现有降级（标题取首行、正文原文）并继续写入；状态携带 `degraded:true` 供 toast 说明。
- 静默任务**不持久化**；关窗/重启视为该次失败，不留半成品（写入是单次 `createDocWithMd`，不会产生部分文档）。

### 6. 结果提示与静默任务生命周期（FR-019/020）

- `client/src/silent-export.ts` 单例按 `sessionId:messageId` 维护进行中任务（与 Host 幂等键同粒度；终态提示按 taskId 归属）：组件卸载（切会话/切面板）不取消；完成时写入全局 toast；再次挂载的按钮从单例读取加载态。
- `toast-store.ts` + `ToastHost.tsx` 注册到 `shell.overlay`：
  - 成功：`已导出到：{display}`，可带 `siyuan://blocks/{id}` 链接，约 6s 自动消失，可手动关闭；
  - 失败：原因 + 「重试」+ 路径/认证类错误附「打开设置」；常驻直到用户处理（不自动消失，避免错过）；
  - 栈上限 3，超出淘汰最旧；`aria-live="polite"`、成功 `role=status`、失败 `role=alert`；toast 根 `pointer-events:auto`（overlay 层本身 click-through）。
- 重试调用 `export.open({messageId, sessionId, intent:'silent'})`，避免用户已改开关时误弹窗；重试仍失败则更新同一条 toast。
- 弹窗模式关闭/卸载仍 `export.cancel`；静默模式卸载不取消（两者由 `mode` 区分）。

### 7. 验证边界

- 自动化：偏好迁移/损坏回退、落点解析四分支、静默自动提交与写失败重试复用 body、3 并发各 1 篇、同键重复点击 1 条流水线、toast 队列/键盘、设置保存失败回退、slot 注册与 handoff 含 biji dataurl。
- 真实 E2E（隔离 `DSH_HOME`）：侧栏入口 → 设置面板 → 改开关/路径 → 消息按钮无弹窗导出 → 切会话仍完成 → toast 落点 → 重启后偏好保留。
- 不以单测冒充真实 UI；浏览器计时与真实模型/思源写入分别记录证据（quickstart V8–V12）。
