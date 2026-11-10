# Phase 1 · 数据模型（data-model）

> 来源：spec.md「Key Entities」的设计细化；校验规则逐条映射 FR。思源路径语法细节待 R3（思源 API 实证）确认后补注。

## 实体关系

```text
SingleOutput ──(被引用)── ExportRequest ──(确认后生成)── ExportTask ──(产出)── StructuredNote ──(经 Siyuan 写入)── 目标文档(思源)
                                    ↑                           │
                                Prefs.lastPath ◄──(成功回写)────┘
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

## 3. StoragePath（存放路径）

| 字段 | 类型 | 约束/校验 | 来源 |
|---|---|---|---|
| notebookId | string | 必填；必须存在于 `tree.list` 返回 | 文档树选择 |
| notebookName | string | 仅展示用 | 同上 |
| parentSegments | string[] | 每段非空、清理非法字符；允许空数组=笔记本根 | 同上 |
| display | string | 展示串（`笔记本 / a / b`），由前两者派生 | 派生 |

**持久化**：`Prefs.lastPath` 只存最近一次**成功**导出的 StoragePath（FR-006）。

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
| taskId | string | **幂等键 = messageId + contentRevision**（FR-011） |
| state | 见下表 | 单一权威状态，Host 内存持有 |
| phase | `llm` \| `write` | 当前阶段（用于 UI 文案「生成中…/写入中…」） |
| title | string \| null | LLM 默认值（可被 Client 确认值覆盖） |
| body | string \| null | 仅 Host 持有；**写失败重试直接复用，不再调 LLM**（省 token） |
| error | { category, message, retryable } \| null | 分类见下 |
| target | StoragePath \| null | 成功后的落点 |

**状态转移**：

| From | Event | To | Guard/动作 |
|---|---|---|---|
| （无） | `open(messageId)` | `generating` | 同键任务已存在 → 复用（不重复调 LLM）；发起 LLM 调用（FR-013 输入裁剪） |
| `generating` | llm 输出结构校验通过 | `ready` | 缓存 body/title |
| `generating` | llm 失败/超时/结构不合 | `degraded-ready` | 本地降级：标题=首行截断、body=原文（US3-2），仍可导出 |
| `generating` | `cancel` / dialog 关闭 | `cancelled` | AbortSignal 中止流；未 commit 则无副作用（edge case：关闭不产生半成品） |
| `ready` / `degraded-ready` | `commit(title, target)` | `writing` | title/target 校验通过；同键 writing 中 → 拒绝重复（FR-011） |
| `writing` | 写入成功 | `succeeded` | 回写 `Prefs.lastPath`（FR-006）；反馈含落点（FR-012） |
| `writing` | 写入失败 | `failed` | 错误分类（见下），保留 title/target（FR-010） |
| `failed` | `retry` | `writing` | **复用缓存 body**（同 taskId 幂等，SC-006） |
| 任意终态 | dialog 关闭 | （任务表清理） | 释放资源；`succeeded` 后同键 open 视为新导出（允许再次导出到别处，edge case） |

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

## 6. Prefs（持久化偏好，单一权威状态）

| 字段 | 类型 | 约束 | 对应 FR |
|---|---|---|---|
| version | number | 结构版本，迁移用 | — |
| lastPath | StoragePath \| null | 仅成功导出后写入 | FR-006 |
| draft | { title?, path? } \| null | 可选草稿（打开弹窗时恢复） | UX 增强 |

**存储纪律**：写在 `resolveDshHome()` 数据根下插件自有目录；临时位置写全量 → 原子切换（Windows 短暂 EPERM 有限退避）；所有写入进同一串行队列；localStorage 仅作非权威显示缓存。

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
