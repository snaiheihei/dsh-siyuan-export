# Phase 1 · 数据模型（data-model）

> 来源：spec.md「Key Entities」的设计细化；校验规则逐条映射 FR。思源路径语法细节见 [contracts/siyuan.md](contracts/siyuan.md)。
> Change 2026-11-11 追加：导出模式分派、静默落点解析、Prefs v2 迁移、客户端提示状态。

## 实体关系

```text
SingleOutput ──(被引用)── ExportRequest ──(确认后生成)── ExportTask ──(产出)── StructuredNote ──(经 Siyuan 写入)── 目标文档(思源)
                                    ↑                           │
                                Prefs.lastPath ◄──(成功回写)────┘

SingleOutput ──(静默 open)── SilentExportTask ──(自动 commit)── StructuredNote
                                    │
                       Prefs.defaultPath / Prefs.showDialog ──(模式与落点)
                                    │
                              SilentNotice（Client 展示态，非权威）
```

## 1. SingleOutput（单次输出，导出源）

| 字段 | 类型 | 约束/校验 | 来源 |
|---|---|---|---|
| messageId | MessageId | 必填；只接受**定稿** turn 的消息（slot 仅对定稿消息渲染，天然满足） | slot owner props |
| sessionId | SessionId | 必填 | session 钩子 |
| contentRevision | string | 内容摘要/修订标识；作幂等键组成 | Host 从 Session 派生 |
| content | string (markdown) | 非空；**仅助手正文**，不含用户提问与工具输出（FR-008） | Host 读取 |

**不变量**：content 是唯一事实源；导出失败/重启后可从它重新生成，不落副本。

## 2. ExportRequest（导出请求，弹窗草稿）

| 字段 | 类型 | 约束/校验 | 来源 |
|---|---|---|---|
| source | { messageId, contentRevision } | 必填，指向 SingleOutput | 打开弹窗时绑定 |
| title | string | trim 后非空；≤ 128 字符；清理 `<>:"/\|?*` 与控制符、压平换行；清理后为空 → 校验错误（FR-004 用户可编辑，LLM 值只是默认） | LLM 默认值 / 用户编辑 |
| target | StoragePath | notebookId 必填；确认时必须仍存在（不存在 → FR-010 提示重选） | 文档树选择器 |

**不变量**：title/target 在任何失败路径上**不被清空**（FR-010）。

## 2.1 ExportMode（模式分派，Host 权威）

| 字段 | 类型 | 约束/校验 | 来源 |
|---|---|---|---|
| intent | `'auto' \| 'silent'` | 可选；缺省 `auto` | Client `export.open` |
| mode | `'dialog' \| 'silent'` | Host 决定：`intent='silent'` 恒静默；`auto` 读 `Prefs.showDialog`（缺省 true）| Host |

**规则**：
- 模式只在 **open 时**判定一次；进行中的导出不因 `Prefs.showDialog` 变化而改道（edge case：导出中改设置只影响下一次）。
- `mode='dialog'` 的响应携带 `taskId/status/title/lastPath/defaultPath`，Client 打开弹窗；`mode='silent'` 的响应携带 `taskId/status/target/targetFrom/degraded/alreadyRunning`，Client **不打开弹窗**，直接进入提示与加载态（FR-017/FR-020）。
- 静默模式无取消入口（假设），弹窗模式的 unmount 即 cancel 不适用于静默任务。

## 3. StoragePath（存放路径）

| 字段 | 类型 | 约束/校验 | 来源 |
|---|---|---|---|
| notebookId | string | 必填；必须存在于 `tree.list` 返回 | 文档树选择 |
| notebookName | string | 仅展示用 | 同上 |
| parentSegments | string[] | 每段非空、清理非法字符；允许空数组=笔记本根 | 同上 |
| display | string | 展示串（`笔记本 / a / b`），由前两者派生 | 派生 |

**持久化**：`Prefs.lastPath` 只存最近一次**成功**导出的 StoragePath（FR-006）。弹窗默认值优先级 = `lastPath` → `Prefs.defaultPath`（FR-006/FR-015）→ 无（要求用户选择）。

## 4. StructuredNote（结构化笔记，导出产物）

| 字段 | 类型 | 约束/校验 | 来源 |
|---|---|---|---|
| title | string | 同 ExportRequest.title 规则 | 确认值 |
| body | string (markdown) | ≤ 1 MB；含明确标题分节、列表、代码块原样保留（FR-008/FR-009）；要点以小图标标注（✅ 📌 ⚠️ 💡 等，FR-009） | LLM 输出（结构校验通过）或本地降级（原文） |
| markers | string[] | 实际使用的小图标清单（供展示与测试断言） | 派生 |
| exportedAt | ISO-8601 | 写入时生成 | Host |
| source | { sessionId, messageId, contentRevision } | 回溯源（笔记内以元数据注记，不含对话上下文正文） | Host |
| formatVersion | number | 排版格式版本，便于日后迁移 | 常量 |

**不变量**：`body` 只在 Host 侧存在，**不回传 Client**（省传输、避免正文进 UI 状态）；同名文档不覆盖不合并（FR-007）。

## 5. ExportTask（状态机，运行时权威）

| 字段 | 类型 | 说明 |
|---|---|---|
| taskId | string | **幂等键 = sessionId + messageId + contentRevision**（FR-011/FR-025；不同会话同 messageId 不得相撞） |
| mode | `'dialog' \| 'silent'` | open 时判定，之后不变（FR-016/FR-017） |
| state | 见下表 | 单一权威状态，Host 内存持有 |
| phase | `llm` \| `write` | 当前阶段（用于 UI 文案「生成中…/写入中…」） |
| title | string \| null | LLM 默认值（可被 Client 确认值覆盖）；静默模式直接用 LLM/降级标题 |
| body | string \| null | 仅 Host 持有；**写失败重试直接复用，不再调 LLM**（省 token） |
| degraded | boolean | 生成失败降级为原文时为 true（FR-020/SC-009） |
| error | { category, message, retryable } \| null | 分类见下；静默模式作为 `data` 返回而非传输错误 |
| target | StoragePath \| null | 弹窗模式 = 确认值；静默模式 = 落点解析结果（见 §7） |
| targetFrom | `'default' \| 'last' \| 'first-notebook' \| null` | 静默落点来源，供提示与排障 |

**状态转移**：

| From | Event | To | Guard/动作 |
|---|---|---|---|
| （无） | `open(messageId, intent='auto'\|'silent')` | `generating` | 模式由 `intent`/`Prefs.showDialog` 判定；同键任务已存在 → 复用（不重复调 LLM）；启动 LLM 调用（FR-013 输入裁剪） |
| `generating` | llm 输出结构校验通过 | `ready`（弹窗）/ 直接 `writing`（静默） | 缓存 body/title；静默无需用户确认，自动进入写入（FR-017/FR-021） |
| `generating` | llm 失败/超时/结构不合 | `degraded-ready`（弹窗）/ 直接 `writing` 且 `degraded=true`（静默） | 本地降级：标题=首行截断、body=原文（US3-2），仍执行写入（FR-020 提示降级） |
| `generating` | `cancel` / dialog 关闭 | `cancelled` | **仅弹窗模式**：AbortSignal 中止流；未 commit 则无副作用；静默任务不受卸载影响 |
| `ready` / `degraded-ready` | `commit(title, target)` | `writing` | title/target 校验通过；同键 writing 中 → 拒绝重复（FR-011） |
| `writing` | 写入成功 | `succeeded` | 回写 `Prefs.lastPath`（FR-006）；反馈含落点（FR-012/FR-020） |
| `writing` | 写入失败 | `failed` | 错误分类（见下），保留 title/target（FR-010） |
| `generating`（静默） | 落点解析失败（默认路径失效/无笔记本） | `failed` | `siyuan-path`，**不写入、不改道**（FR-023）；`target=null`，`targetFrom` 标明尝试来源 |
| `generating` / `writing`（静默） | 同键再次 `open` | 不变 | 返回当前状态 + `alreadyRunning=true`；**不重复生成或写入**（FR-019/FR-025） |
| `failed` | `retry`（弹窗）/ 再次 `open(intent='silent')` | `writing` | **复用缓存 body**（同 taskId 幂等，SC-006），不调 LLM；落点重新解析，仍失败则再次 `failed` |
| `succeeded` | 同键再次 `open` | `writing`（重置） | 视为一次新导出，可复用缓存 body 直接再写一篇（同名消歧），不重复调 LLM（edge case） |
| 任意终态 | dialog 关闭 | （任务表清理） | 仅弹窗任务；静默任务由 Host 生命周期回收，不因 UI unmount 取消 |

**错误分类**（FR-010 文案映射，不泄漏堆栈/内部路径/正文秘密）：

| category | 典型原因 | retryable |
|---|---|---|
| `siyuan-auth` | Token 缺失/无效 | 否（引导重新配置） |
| `siyuan-connect` | 思源未运行/端口不通 | 是 |
| `siyuan-path` | 目标路径失效/无权限 | 否（引导重选路径） |
| `llm-adapter` | provider 无 adapter（NO_ADAPTER） | 否（引导检查模型配置） |
| `llm-quota` / `llm-timeout` | 配额/超时 | 是 |
| `llm-structure` | 输出不合结构且降级也失败 | 是 |
| `empty-source` | 回复为空或仅图片，无可导出正文（open 时拒绝，不产生笔记） | 否 |

**持久性**：ExportTask 不持久化（重启后弹窗内状态丢失可接受——内容源是消息本身，重新 open 即可再生）；`Prefs` 持久化。

## 6. Prefs（持久化偏好，单一权威状态，v2）

| 字段 | 类型 | 约束/默认 | 对应 FR |
|---|---|---|---|
| version | `2` | 结构版本；v1 → v2 迁移见下 | FR-022 |
| lastPath | StoragePath \| null | 仅成功导出后写入；弹窗打开时优先作默认值 | FR-006 |
| defaultPath | StoragePath \| null | 设置页维护；静默导出首选；`null` = 未配置 | FR-015/FR-018 |
| showDialog | boolean | 默认 `true`；false 时走静默 | FR-016/FR-017 |
| draft | { title?, path? } \| null | 可选草稿（打开弹窗时恢复） | UX 增强 |

**读写规则**：
- 文件缺失或 JSON 损坏 → 整体回退默认值（`showDialog:true`、`defaultPath:null`、`lastPath:null`），不阻断使用（FR-022）。
- `version === 1` → 迁移：保留 `lastPath`/`draft`，补 `defaultPath:null`、`showDialog:true`、`version:2`，原子写回；**不得因版本升级丢弃已记住的路径**。
- 未知版本 → 回退默认值并覆盖写回（向前不兼容，避免把未知结构当 v2 误读）。
- 局部更新走 `definedPatch`：显式 `false`/`null` 必须保留，不能被默认值吞掉（`showDialog:false`、清空默认路径）。
- `defaultPath` 保存前需 `validateTarget(path)`（notebook 存在 + 父级 hpath 可解析）；校验失败返回 `siyuan-path`，不落库（FR-015/FR-022）。
- 思源离线时设置页**保留已保存值可读**，保存动作报 `siyuan-connect` 并可重试；不得静默清空。

**存储纪律**：写在 `resolveDshHome()` 数据根下插件自有目录；临时位置写全量 → 原子切换（Windows 短暂 EPERM 有限退避）；所有写入进同一串行队列；localStorage 仅作非权威显示缓存。

## 7. SilentTarget（静默落点解析，Host 权威）

`resolveSilentTarget(prefs, siyuanClient)` 按固定优先级取第一个可解析项；**第 1 项存在但失效时直接失败、不回退**，只有无默认路径时才尝试后续项（FR-018/FR-023）：

| 顺序 | 来源 | 条件 | targetFrom |
|---|---|---|---|
| 1 | `Prefs.defaultPath` | 配置存在且校验通过 | `default` |
| 2 | `Prefs.lastPath` 的笔记本根 | 无默认路径但有上次成功记录 | `last` |
| 3 | `lsNotebooks` 第一本打开的笔记本根 | 两者都无 | `first-notebook` |
| — | 失败 | 默认路径失效/无权限、无任何笔记本、思源不可达 | `null` |

**不变量**：
- 第 1 项存在但失效 → **直接失败**，不回退到 2/3（FR-023：不得静默改写）。
- 第 2/3 项只使用**笔记本根**（`parentSegments=[]`），不猜测子目录。
- 思源没有「当前活动笔记本」官方 API（research R7），第 3 项是产品假设：取 `lsNotebooks` 返回的第一本未关闭笔记本。
- 解析结果是 `StoragePath`，后续与弹窗导出共用 `createDocWithMd` + 查重消歧路径。

## 8. SilentNotice（客户端提示状态，非权威）

| 字段 | 类型 | 约束 |
|---|---|---|
| noticeId | string | = taskId；同任务只保留一条 |
| kind | `'success' \| 'degraded' \| 'failed'` | 决定样式与是否自动消失 |
| target | StoragePath \| null | 成功/降级时展示落点 |
| message | string | 用户可读；不含堆栈/内部路径/正文 |
| retryable | boolean | 失败时决定是否显示「重试」 |
| createdAt | number | 成功 ~6s 自动消失；失败**常驻**直至关闭/重试 |

**规则**：Client 静默任务单例键 = `sessionId:messageId`（与 Host 幂等键同粒度，避免不同会话同 messageId 串台）；Notice 键 = taskId。最多同时 3 条；`success/degraded` 用 `role=status`、`failed` 用 `role=alert`；重试即再次 `export.open({intent:'silent'})`，复用幂等键；不在状态文件中持久化。

## 校验规则 ↔ FR 映射

| FR | 落点 |
|---|---|
| FR-001/002 | slot 注册 + 弹窗字段（title、target） |
| FR-003 | ExportTask.generating（LLM 调用） |
| FR-004 | ExportRequest.title 可编辑覆盖 |
| FR-005/006 | StoragePath + Prefs.lastPath |
| FR-007 | StructuredNote 落点为新建文档；commit 前 `getIDsByHPath` 查重 + 消歧后缀，硬保证不覆盖（契约 siyuan.md 规则 2） |
| FR-008 | SingleOutput.content 范围 + body 保留原结构 |
| FR-009 | StructuredNote.body 格式规则 + markers 断言 |
| FR-010 | error 分类表 + title/target 不清空 |
| FR-011 | taskId 幂等键 + writing 态拒绝重复 |
| FR-012 | succeeded 反馈含落点 |
| FR-013 | `export/llm.ts` 唯一 prompt 构造点：输入 = content + 最小指令模板，单测负向断言不含上下文 |
| FR-014 | 侧栏 `sidebar.panellist` 入口（`biji.svg` + label）+ `main` keyed 面板（key 与入口 id 一致），非模态 |
| FR-015 | Prefs.defaultPath + `validateTarget`；选择器只遍历思源树（无本机路径输入） |
| FR-016 | Prefs.showDialog + 设置页即时保存（串行队列，无全局保存按钮） |
| FR-017 | §2.1 模式分派：`showDialog=false` → `mode='silent'`，不返回弹窗字段 |
| FR-018 | §7 静默落点优先级（default → last 根 → 首本 → 失败） |
| FR-019 | 静默 `open` 立即返回 `taskId/status`；按钮由 Client 任务单例驱动加载态与去重 |
| FR-020 | `SilentNotice`：成功含落点自动消失；失败常驻 + 重试；降级单独提示；不自动开弹窗 |
| FR-021 | 静默复用 `ExportService.generate/commit` 与 `export/llm.ts`，输入仍仅单次输出 |
| FR-022 | Prefs v2 默认值/损坏回退/原子写；v1 迁移保留 lastPath 与 draft |
| FR-023 | 默认路径校验失败 → `failed(siyuan-path)`，`resolveSilentTarget` 不回退 |
| FR-024 | 设置页与树选择器键盘可达（roving tabindex、方向键/Enter/Space）、zh/en 字典；图标失败保留 label |
| FR-025 | 幂等键含 sessionId；不同 messageId 并发独立；同键 generating/writing → `alreadyRunning` |
