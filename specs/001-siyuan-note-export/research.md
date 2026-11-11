# Phase 0 研究（Research）

> **选型域不在此展开**：四域结论见 [tech-decisions.md](tech-decisions.md)（D1 树外插件 / D2 思源 HTTP API / D3 宿主 LLM 通道 / D4 宿主风格自绘）。本文只记录**非选型研究**：宿主扩展点实证、思源 API 实证、集成模式与最佳实践、未知项验证计划。
>
> 证据约定：标注 `源码确认` 的条目附 `path:line`（dsh 检出：`github/deepseek-harness`，版本 `0.2.2-rc.1`）；标注 `推断` 的条目需在实现或 quickstart 中验证。

---

## R1 · 消息按钮挂载点（宿主扩展点实证）

**Decision**：使用官方 slot **`conversation.chat.assistant-actions`**（`kind: list`，`scope: session`，owner = `{ messageId }`）。注册方式：`inject = ['slots']`，在 `apply()` 内以 `ctx.slots.inject('conversation.chat.assistant-actions', cb)` 等待声明存活，再 `ctx.slots.register({ name, id, order, locale, inject }, ExportButtonComponent)`；组件渲染在 copy 按钮与 branch 按钮之间（宿主 `extraActions`）。

**Rationale**：
- 源码确认：slot 声明 `packages/client/ui-chat/src/client/contract/slots.ts:489-493`；渲染点 `TurnTailNodeView.tsx:54-56`（每条**定稿**助手消息渲染一次）；插入位置 `MessageIconActions.tsx:26-30,65`。
- 与需求精确对齐：FR-001「每条助手回复的操作栏」（Q2=A）由该 slot 的 list/owner 语义天然满足，无需 DOM 注入。
- 组件 props = owner `{ messageId }` + session 标准钩子（`useSession`/`useChat`/`sessionId`，`docs/subsystems/slots.md:93-105`），可直接拿到该条消息定位单次输出。
- 注册纪律（源码确认）：裸 `register` 到未声明 slot 会抛错，必须先 `ctx.slots.inject(key, ...)`（`docs/subsystems/slots.md:27,209`）；树外动态包自动分配低于所有内置条目的 priority，且只能 `React.createElement` + `styles.insert(css)`（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:68-75`）。

**Alternatives considered**：
- `conversation.chat.turnTail`（list/session，动作行正上方，`slots.ts:487`）：可用但不在操作栏本体内，视觉与交互不符 → 弃。
- `webserver/index-inject` 宿主事件（`packages/host/webserver/src/index.ts:44`）：只能向 `index.html` head/body 追加 script/style/html，无法按消息挂按钮 → 弃。
- 通用 client DOM 注入 / MutationObserver 扩展点：**源码不存在**（`packages/client` 下 MutationObserver 全是内部布局测量；负面结论已核对全量 slot 目录 109 条）→ 不可行。
- 邻近可选（备用）：`conversation.session.header.actions`（会话级导出入口，可作 P2 后备）、`contextMenu.icon`、`shell.overlay`。

**边界与约束（源码确认，直接影响行为定义）**：
- 该行只对持有持久 `messageId` 的**定稿 turn** 渲染；中断冻结的 partial 不渲染（`TurnTailNodeView.tsx:51-56`）→ 与 FR「对话完成后」语义一致，无需自行判断 turn 完成。
- 整行 hover 显隐由 `data-actions-reveal` 控制（`TurnTailNodeView.tsx:61`）→ 按钮常驻但随行显隐，不额外做显隐逻辑。
- 官方占用者先例：点赞插件以 `id: 'feedback'`, `order: 10` 注册（`ui-message-feedback/src/client/index.ts:98-113`）→ 我方用独立 `id`（如 `siyuan-export`）与更高 `order` 并存，不替换。

---

## R2 · 宿主 LLM 通道（宿主扩展点实证）

**Decision**：插件声明 `inject = ['llm']`，经 `ctx.llm.prepareCall(config, signal?, configure?)` 获取一次性 `PreparedLlmCall`，再 `await call.stream()` 完成生成；provider/model 经 `listProviders()` → `listModels(provider)` → `resolveModelInfo()` 解析。

**Rationale**：
- 源码确认：签名 `packages/llm/llm/src/index.ts:960-964`；服务类 `LlmRuntime`（`index.ts:354`，服务名 `llm`）；`PreparedLlmCall` 含 `stream()`（一次性，config 不匹配即 `INVALID_PREPARED_CALL`，`index.ts:999-1016`）。
- 输出预算与中止：`maxTokens`（`call-config.ts:19`、`types.ts:587`）+ `AbortSignal` 全程 `throwIfAborted`（`index.ts:962-974`）→ 支撑 SC-002（30s 内完成）与用户取消。
- provider/model 可用性：`listProviders()`（`index.ts:482-485`，`@Remote`）、`listModels()`（`index.ts:718-749`）、`resolveModelInfo()`（`index.ts:760-766`）；adapter 未注册时报 `NO_ADAPTER`（`index.ts:967,1020-1024`）。
- 宿主先例：标题生成调用 `packages/session/session-title-llm/src/index.ts:258`、循环内调用 `packages/core/agent-loop/src/agent.ts:644` → 「用宿主通道做轻量生成任务」是既有模式。

**Alternatives considered**：直连 OpenAI 兼容 API、本地模型 —— 属选型域 D3，已在 [tech-decisions.md](tech-decisions.md) 拍板，不重复展开。

**未知项（quickstart 验证）**：本机真实可用的 provider/model 需运行时小请求验证（防 `NO_ADAPTER` / unsupported model / 配额错误被误报成功）；错误类别需映射为 FR-010 的用户可读文案。

---

## R3 · 思源 API 实证

**Decision**：宿主侧适配器（`siyuan/client.ts`）统一调用思源本地 API——探活 `system/version`；树 = `notebook/lsNotebooks`（笔记本层）+ `query/sql`（子文档层级，显式 LIMIT + 稳定排序）；写入 = `filetree/createDocWithMd`；认证 = `Authorization: Token <token>`（Token 只存插件 Config）。**Client 不直连思源**，即使 CORS 允许。

**Rationale**（依据：官方 API 参考 `siyuan-note/siyuan docs/API.zh-CN.md`、`API-CONTRACTS.zh-CN.md`、生成类型契约 `app/src/types/api/index.d.ts`、内核源码 `kernel/server/serve.go`）：
- **端点与认证（文档原文）**：`http://127.0.0.1:6806`，一律 POST + JSON body，统一返回 `{code,msg,data}`，`code != 0` 即异常；Token 位于思源 **设置 → 鉴权 → API token**（现行文档；旧版「设置 → 关于」已变更）。源码佐证：内核启动即监听 `127.0.0.1:6806`，**API 默认开启、无任何开关**，Token 常驻。
- **写入（文档原文）**：`POST /api/filetree/createDocWithMd`，body `{notebook, path: "/父级/新标题", markdown}` → `data` 为新建文档 ID；`path` 以 `/` 开头分层，**缺失父级自动创建**，**同 path 重复调用不覆盖已有文档**。官方另建议新接口 `createDocByParent`（仅见于类型契约，API 参考未列参数表）→ 备选。
- **路径语法（文档原文）**：标题内 ASCII `/` 必须替换否则被解析为层级或报 `pathAmbiguous`；另有 `pathAmbiguous`（祖先标题含 `/` 或空标题）、`indexUnavailable`（元数据未就绪）错误分支 → 归 `siyuan-path`。
- **文档树（文档原文 + 负面结论）**：`notebook/lsNotebooks`（无参）列笔记本；**现行官方 API 没有 lsDoc/大纲类接口**，且行为语义明确「只有独立说明的接口才属公开 API」→ 生态常用的 `filetree/lsDoc` 属未公开接口，官方不承诺兼容。可用官方替代：`query/sql`（需显式 `LIMIT/OFFSET` + 稳定排序，否则按设置截断；发布模式禁用——本机非发布模式；写后立读需先 `sqlite/flushTransaction`）、`file/readDir`（只有 ID 无标题）。
- **路径/ID 互转（文档原文，官方）**：`getHPathByID` / `getPathByID` / `getHPathByPath` / `getIDsByHPath`。
- **失败形态（源码佐证 + 推断）**：认证失败可能表现为非 2xx 或 `200 + code!=0`（具体状态码文档未写，需实测）→ 适配器**两种都处理**。
- **CORS（源码佐证）**：内核对全路由 `Access-Control-Allow-Origin: *`，预检直接 204 → 浏览器直连技术上可行；**仍选宿主侧调用**：Token 不下发页面、错误分类收口、不依赖 CORS 且避开 `Allow-Origin:*` 与 `Allow-Credentials:true` 并存导致带凭据请求被拒的陷阱。

**Alternatives considered**：
- 浏览器 Client 直连 6806（CORS 允许）→ 弃：Token 必须暴露到页面，违背凭据纪律。
- 直写数据目录 `.sy` → 选型域 D2 已弃（[tech-decisions.md](tech-decisions.md)、ADR-0002）。
- `importData` / `importStdMd` 导入通道 → 文档明示 `importStdMd` 为内部 API、不用于单篇 MD → 弃。
- SQL 一次性拉全树 → 弃：大工作区浪费；改为 `tree.list` 逐层懒加载。

**待实测（quickstart）**：
- 同 path 重复创建的真实行为（复用既有 ID vs 新建同名）——文档未说明 → 适配器**必须** `getIDsByHPath` 查重 + 标题消歧后缀，保证 FR-007「不覆盖、独立文档」（V7 覆盖）。
- 认证失败的具体 HTTP 形态；`lsDoc`（若实测后作性能优化）的稳定性（V2/V3）。

---

## R4 · 集成模式与最佳实践（非选型）

**Decision 1 — LLM 两次任务合并为一次结构化调用**：单次 `stream()` 请求，输入 = 该条单次输出 + 固定最小指令模板，要求输出结构 `{ title, body }`（body 为带小图标的 Markdown）；失败或输出不合结构时**本地降级**：title 取回复首行截断、body 直接用原回复（US3-2）。

**Rationale**：一次调用省一半 token 与一倍延迟（对齐 FR-013 省 token 的本意、SC-004/SC-002）；结构化输出可用 schema 校验（skill：模型输入输出分别做结构校验与大小限制，输入视为不可信数据）。
**Alternatives**：先标题后重排两次调用（隔离失败，但 token/延迟翻倍）→ 弃；流式边生成边写（写入与生成耦合，失败半成品）→ 弃，保持「生成完成 → 一次写入」。

**Decision 2 — 输入裁剪在适配器收口**：`export/llm.ts` 是唯一构造 prompt 的地方，输入**仅含**单次输出正文 + 指令模板，禁止拼接 Session 历史/用户提问/工具输出（FR-013）；单元测试对 prompt 做**断言不含上下文**的负向用例。

**Rationale**：FR-013 是硬约束，散落拼接点无法审计；skill 纪律「模型可见即被记录」下，最小输入也避免污染。
**Alternatives**：在导出服务各处按需拼接 → 弃（无法断言）。

**Decision 3 — 防重以 Host 权威状态为准，按钮禁用只是显示**：一次导出 = 以 `messageId + 内容 revision` 为幂等键的 in-flight 集合；Host 端串行队列内查重（FR-011），Client 按钮 loading 态仅是表现层。

**Rationale**：skill 明确「不要依赖按钮禁用代替 Host 防重」；多次点击、事件重复、重启恢复都按幂等键处理。
**Alternatives**：仅前端禁用按钮（双开/事件重复仍可能双写）→ 弃。

**Decision 4 — 失败分类与可恢复性**：错误分两类收口——思源侧（认证/连接/路径失效）与模型侧（adapter/配额/超时/结构不合），映射为 FR-010 的用户可读原因 + 重试入口；**已填主题名与已选路径永不因失败被清空**；重试复用同一幂等键，成功后只产生一篇笔记（SC-006）。

**Rationale**：spec US3 全部验收场景；skill「业务错误与传输错误分开，响应不含堆栈、内部路径或正文秘密」。
**Alternatives**：统一报「导出失败」（用户无法行动）→ 弃。

**Decision 5 — 偏好记忆为单一权威状态**：上次成功路径（FR-006）与弹窗草稿存插件自有状态文件，原子发布（临时位置 → 切换），localStorage 只做非权威显示缓存。

**Rationale**：skill 持久化纪律（单一权威、原子发布、可读文件仅作投影、不形成双事实源）。
**Alternatives**：localStorage 直存（跨端/清理即丢、宿主不可权威）→ 弃。

---

## R5 · 未知项与验证计划

| 未知项 | 验证方式 | 归属 |
|---|---|---|
| 本机 provider/model 实际可用（`NO_ADAPTER`/unsupported/配额） | 隔离环境真实小请求（quickstart V5） | quickstart |
| 思源 Token/端口/接口行为（同名、路径语法） | 官方文档（R3）+ quickstart V3 真实写入 | R3 / quickstart |
| 消息操作栏 slot 在真实 Host 的渲染与 props | quickstart V2（真实 UI + slot 注册证据） | quickstart |
| 隔离安装链路（patch → dump-config → 启动 → UI） | develop-dsh-plugin 工作流 + quickstart V1 | quickstart |
| FR-013 输入裁剪 | 单元测试负向断言（prompt 不含上下文） | tests/unit |
| 侧栏入口/设置主面板在真实 Host 的渲染与图标尺寸 | quickstart V8（真实 UI + slot 注册证据） | quickstart |
| 静默导出跨会话/面板切换仍完成并提示 | quickstart V11（隔离 Host 真实操作） | quickstart |
| 偏好 v1→v2 迁移与损坏回退 | 单元测试（Temp 目录）+ quickstart V12 | tests/unit |
| 3 条不同回复并发静默导出各 1 篇 | 集成测试（fake writer）+ quickstart V11 | tests/integration |

---

## R6 · 侧栏入口与主面板（宿主扩展点实证）

**Decision**：使用官方 **`sidebar.panellist`**（list/root）注册设置入口，组件本身即图标（owner props `{ size, active }`）；`label` 元数据提供按钮可访问名称。主页面注册到 **`main`**（keyed/root），`key` 必须与 panellist 的 `id` 相同。点击侧栏由宿主调用 `ctx.layout.selectPanel(id)`，插件不需要自行绑定点击。全局提示使用 **`shell.overlay`**（list/root）。

**Rationale**（源码确认，dsh `0.2.2-rc.1`）：
- slot 声明：`packages/client/ui-sidebar/src/client/contract/slots.ts:36`；图标 owner props `{ size, active }` 在同文件 `:73-78`。
- 可访问名称：sidebar 从注册元数据解析 `resolveSlotLabel(options.label) ?? id`（`packages/client/ui-sidebar/src/client/index.ts:54`），按钮标签与图标解耦 → 图标加载失败不影响名称。
- 点击行为：`injectProps.selectPanel(id) → ctx.layout.selectPanel(id)`（`ui-sidebar/src/client/index.ts:76`）。
- 主面板：`main` 为 keyed slot（`packages/client/ui-layout/src/client/index.ts:75`），按 `entryKey` 渲染（`AppFrame.tsx:49`）；宿主先例 `ui-plugin-manager/src/client/index.ts:133`（main）与 `:167`（panellist）、`ui-schedule/src/client/index.ts:219/240`。
- overlay：`shell.overlay` list/root（`ui-layout/src/client/index.ts:107`），层本身 click-through（注释 `:97-106`），toast 根必须 `pointer-events:auto`；渲染于 `AppFrame.tsx:281,328`。

**Alternatives considered**：
- 复用 ui-settings 的 `settings.section` 页：D5 已拍板弃用（树选择与即时生效与 configForms 语义不合）。
- 用 `label` 字符串充当图标：宿主只把 label 当文本/可访问名，不是图标通道 → 不可行。
- 直接 DOM 注入侧栏：无公开扩展点、升级易碎 → 弃。

---

## R7 · 静默落点解析（产品歧义裁决）

**Decision**：静默落点按以下顺序解析（`src/siyuan/target.ts`）：
1. `Prefs.defaultPath`（设置中的默认存放路径）→ 校验后使用；失效则失败，**不回退**（FR-023）。
2. 否则取 `Prefs.lastPath.notebookId` 对应笔记本的根目录（把「最近一次成功导出的笔记本」视为「当前笔记本」）。
3. 无历史成功路径 → `lsNotebooks` 返回顺序的第一个笔记本根。
4. 无任何笔记本 → `siyuan-path` 失败，提示先创建笔记本。

**Rationale**：
- 思源官方 API 没有「当前活动笔记本」查询（`lsNotebooks` 仅返回列表，见 R3）；必须给出确定规则，否则同一操作会产生随机落点。
- 「最近成功导出的笔记本」最接近用户心中的「当前」；首次使用时取列表首个笔记本是唯一稳定选择。
- 设置保存同样调用 `validateTarget`（笔记本存在 + `getIDsByHPath` 可解析父级），失败不写入偏好，满足 US4-6「保留上一次有效配置」。

**Alternatives considered**：
- 始终取第一个笔记本：忽略用户最近使用上下文，静默导出可能落到错误笔记本。
- 多笔记本且无历史时直接失败：违背 US5-5「未配置默认路径时落到当前笔记本根」的可完成预期。
- 读取思源 UI 的活动笔记本：无公开 API，DOM 耦合 → 不可行。

**边界**：该「当前笔记本」定义是产品假设（spec 未指定多笔记本时的选择规则）；如后续要改为真实活动笔记本，需要思源提供对应 API 或用户显式设置。

---

## R8 · 偏好 v2 迁移与读写纪律

**Decision**：`prefs.json` 升到 `version: 2`，新增 `defaultPath` 与 `showDialog`；读取时对 v1 做迁移（保留 `lastPath`/`draft`，补默认值），未知版本/损坏回退默认值（`showDialog:true`、`defaultPath:null`）。

**Rationale**：
- 现有 `isPrefsData` 对版本不等直接返回默认值（`src/store/prefs.ts:49`）→ 若只改版本号会丢掉用户上次路径；FR-022 要求「缺失/损坏回退默认值」，但 v1 是合法旧数据，不应按损坏处理。
- 继续用单一 `PrefsStore`：原子写 + 串行队列已满足 D6；不引入第二套配置面。
- `update()` 的 `definedPatch` 会保留 `false`/`null`（只丢弃显式 `undefined`），因此开关关闭与清除默认路径都能落盘。

**Alternatives considered**：
- 新建 `settings.json`：形成双事实源，且 lastPath/defaultPath 需要跨文件事务 → 弃。
- 版本不匹配一律重置：最简单但丢失已验证的 lastPath → 弃。
- 存 localStorage：Host 静默导出读不到 → 弃（见 D6）。

---

## R9 · 静默任务生命周期与提示（Client 侧）

**Decision**：
- 静默任务由模块级单例 `client/src/silent-export.ts` 持有：按 `messageId` 记录进行中任务、轮询 `export.state`、完成时写入全局 toast；消息行组件卸载（切会话/面板）**不取消**任务，重新挂载时从单例恢复加载态。
- `client/src/toast-store.ts` + `ToastHost.tsx` 注册到 `shell.overlay`；成功 toast 约 6s 自动消失，失败 toast 常驻并提供重试/打开设置；栈上限 3；容器 `aria-live="polite"`，toast 根 `pointer-events:auto`。

**Rationale**：
- `conversation.chat.assistant-actions` 组件随消息行/会话卸载；若把轮询放在组件 effect 中，切换会话会中止或丢失结果，违背 FR-019「不阻塞切换会话」与 FR-025「互不阻塞」。
- overlay 层 click-through（R6），不设 pointer-events 的 toast 无法点击「重试」。
- 失败 toast 自动消失会让用户错过可恢复错误；成功 toast 自动消失符合「知情但不打扰」。

**Alternatives considered**：
- Host 主动推送完成事件：插件只有同源 RPC，无面向插件的 client 事件通道；轮询 500ms 已足够且与弹窗一致 → 弃。
- 用模态弹窗展示结果：阻塞对话，违背 US5 → 弃。
- 每条消息自建 toast 容器：重复挂载/卸载，且切会话后不可见 → 弃。

**未知项（quickstart）**：真实宿主中 `shell.overlay` 的层叠上下文与 toast 位置需 UI 核验；`biji.svg` dataurl 在 handoff 中的实际渲染需构建测试 + 真实侧栏核验。
