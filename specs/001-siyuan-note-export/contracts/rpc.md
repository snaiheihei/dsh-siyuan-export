# 契约 · Host ↔ Client RPC（contracts/rpc.md）

> 树外插件自有同源 prefix 路由（`webServer.register()`），不修改 dsh Remote allowlist。共享类型在 `src/contract.ts`（Client 经 `client/src/rpc.ts` 使用），**运行时双侧仍做边界校验**。
> Change 2026-11-11：方法由 5 个扩为 7 个，新增 `prefs.get` / `prefs.update`；`export.open` 增加模式分派与静默联合响应。

## 传输规则

- 全部 `POST` + JSON body；方法白名单（下表 7 个，其余一律拒绝）。
- 自定义请求头携带插件内部 nonce（防简单 CSRF/误调）；body 上限 **1 MB**（对齐 body 尺寸上限）。
- 响应信封统一：`{ ok: true, data }` 或 `{ ok: false, error: { category, message, retryable } }`。
  - `message` 为**用户可读中文文案**；禁止堆栈、内部文件路径、正文秘密（skill：业务错误与传输错误分开）。
  - `category` 取值 = data-model 错误分类表（`siyuan-auth` / `siyuan-connect` / `siyuan-path` / `llm-adapter` / `llm-quota` / `llm-timeout` / `llm-structure` / `empty-source` / `internal`）。
- **静默导出的业务失败不是传输错误**：`export.open` 已判定 `mode='silent'` 后，生成/写入/落点失败均以 `ok:true` + `status:'failed'` + `error` 返回，Client 据此弹 toast 而非弹窗；只有参数非法、未知方法、nonce 错误等才用 `ok:false`。
- 响应**永不包含** SiYuan Token、`body` 正文、宿主内部文件路径。
- `recordInput` 审慎设置：导出请求可能含正文引用，命令历史只记 messageId/taskId 等元数据。

## 方法清单

### 1. `export.open`

绑定源消息、判定导出模式、幂等启动生成。响应在 1s 内返回（生成在后台继续）。

```ts
// req
{ messageId: string, sessionId: string, intent?: 'auto' | 'silent' }  // 缺省 'auto'
// res (ok) — 判别联合
| { mode: 'dialog',
    taskId: string,
    status: 'generating' | 'ready' | 'degraded-ready',
    title: string | null,            // LLM 默认主题名；generating 中为 null
    lastPath: StoragePath | null,    // Prefs.lastPath（FR-006）
    defaultPath: StoragePath | null, // Prefs.defaultPath；弹窗默认值回退（FR-006/FR-015）
    error: ErrorInfo | null }
| { mode: 'silent',
    taskId: string,
    status: 'generating' | 'writing' | 'succeeded' | 'failed',
    target: StoragePath | null,      // 已知落点；解析失败为 null
    targetFrom: 'default' | 'last' | 'first-notebook' | null,
    degraded: boolean,               // 生成失败已降级为原文
    alreadyRunning: boolean,         // 同键任务已在进行，本次未重复启动
    error: ErrorInfo | null }        // status='failed' 时给出原因与 retryable
```

- **模式判定（Host 权威）**：本次请求的模式由 `intent`/`Prefs.showDialog` 判定——`intent='silent'` → 恒静默；`intent='auto'` 读 `Prefs.showDialog`（缺省 true）。Client 不缓存/不猜测模式（FR-016/FR-017）。同键既有任务的创建模式不改变本次请求的通道语义：静默请求命中弹窗任务时返回 `mode:'silent'`，绝不因任务创建模式打开弹窗。
- **幂等**：同 `taskId`（= `sessionId:messageId:contentRevision`）已有任务 → 返回当前状态，**不重复调 LLM/写入**（FR-011/FR-025）；进行中时 `alreadyRunning=true`，静默响应照常返回。跨模式命中按静默语义收敛：`succeeded`/`writing` 原样返回且不改道，其余状态就地转静默、落点按静默规则重新解析，已生成则复用缓存 body 自动写入。
- `mode='dialog'` 时 Client 立即打开弹窗，`status='generating'` 以轮询等待（见下）；`title` 非 null 即自动填入（未被用户编辑时）。
- `mode='silent'` 时 Client **不得打开弹窗**；以返回的 `taskId/status` 驱动按钮加载态与提示（FR-019/FR-020）。
- 已是 `succeeded|failed` 的终态也可能直接返回（重试/重复点击的幂等命中）。
- `empty-source` 等不可导出输入：静默模式返回 `mode:'silent', status:'failed'`；`intent='silent'` 时仍不弹窗。

### 2. `export.state`

弹窗轮询（500ms + jitter）与静默任务对账（会话切换后恢复加载态/提示）。

```ts
// req  { taskId: string }
// res  { mode: 'dialog' | 'silent',
//        status: 'generating' | 'ready' | 'degraded-ready' | 'writing' | 'succeeded' | 'failed' | 'cancelled',
//        title: string | null,
//        target: StoragePath | null,
//        href: string | null,          // 成功后可用于「打开笔记」，不可得为 null
//        degraded: boolean,
//        error: ErrorInfo | null }
```

- **不返回 body**（正文仅 Host 持有，data-model 不变量）。
- `mode` 是任务当前通道：一般等于创建模式；静默请求接管弹窗任务后为 `silent`，但 `succeeded`/`writing` 的接管保留原 `dialog`（不改道）。Client 只按本次 `open` 响应的 `mode` 决定是否打开弹窗，不据 `state.mode` 改道。
- 未知/已回收 `taskId` → `ok:false` + `internal`（retryable false），Client 按终态清除加载态，不重试。

### 3. `export.commit`

确认导出（写入思源）。**仅弹窗模式**使用；静默任务由 Host 自动 commit。

```ts
// req  { taskId: string, title: string, target: StoragePath }
// res  { status: 'succeeded', target: StoragePath, href: string | null }   // href 用于「已导出到…」反馈（FR-012）
```

- 服务端校验：title 规则、target.notebookId 存在、任务 `mode='dialog'` 且处于 `ready|degraded-ready|failed`；`writing` 中重复 commit → `retryable: false` 的幂等拒绝（FR-011）。
- 静默任务调用 → `ok:false` + `internal`（retryable false），提示 Client 走错通道。
- 成功后回写 `Prefs.lastPath`（FR-006）。

### 4. `export.cancel`

关闭弹窗/用户取消（仅 `generating` 阶段的**弹窗**任务有效）。

```ts
// req  { taskId: string }   // res { status: 'cancelled' | 'noop' }
```

- 触发 `AbortSignal` 中止 LLM 流；`writing` 阶段不可取消（避免半成品）。
- 静默任务 → `status:'noop'`（静默模式不提供取消，假设）；Client unmount **不得**对静默任务发 cancel。

### 5. `tree.list`

懒加载文档树（弹窗选择器与设置页默认路径选择共用）。

```ts
// req  { notebookId?: string, docId?: string }   // 两者皆空 = 列出笔记本
// res  { nodes: Array<{ id: string, name: string, kind: 'notebook' | 'doc',
//                      notebookId: string, hasChildren: boolean,
//                      path: string[] /* parentSegments，选中即 StoragePath.parentSegments */ }> }
```

- 展开某节点时带 `notebookId + docId` 再调；只读操作，失败映射 `siyuan-connect` / `siyuan-auth`。
- 空笔记本列表是合法结果（`nodes: []`），不是错误；静默落点解析失败由此触发 `siyuan-path`。

### 6. `prefs.get`

设置页与弹窗读取偏好（Host 权威）。

```ts
// req  {}
// res  { showDialog: boolean,          // 缺省 true
//        defaultPath: StoragePath | null,
//        lastPath: StoragePath | null }
```

- 只返回展示/决策所需字段，不含 version、draft、Token。
- 文件损坏/缺失时返回默认值（`showDialog:true, defaultPath:null, lastPath:null`），不报错（FR-022）。

### 7. `prefs.update`

设置页即时保存（局部更新，串行队列原子写）。

```ts
// req  { showDialog?: boolean, defaultPath?: StoragePath | null }
// res  { showDialog: boolean, defaultPath: StoragePath | null, lastPath: StoragePath | null }
```

- `undefined` = 不修改；显式 `false` / `null` 必须保留（`definedPatch`，data-model §6）。
- `defaultPath` 非 null 时服务端 `validateTarget`（notebook + 父级 hpath）；失败 → `siyuan-path`（retryable false），**不落库**。
- 思源离线时保存 → `siyuan-connect`（retryable true）；已保存值仍可读，不被清空。
- `lastPath` 只读，客户端不可写。

## Client 行为契约（UI 状态 ↔ RPC）

| UI 事件 | 行为 |
|---|---|
| 点击导出按钮 | `export.open({ messageId, sessionId })`（`intent` 缺省，由 Host 判定） |
| 响应 `mode='dialog'` | 立即打开弹窗（< 1s，SC-001 前半）；title 生成中显示占位「正在生成默认主题名…」；目标默认值 = `lastPath ?? defaultPath`（都无则要求选择） |
| 响应 `mode='silent'` | **不打开弹窗**；按钮进入加载/运行态；登记到 Client 静默任务单例（键 = `sessionId:messageId`，跨会话存活；终态提示按 taskId 归属） |
| 静默 `alreadyRunning=true` | 不重复发起；沿用当前加载态 |
| title 返回（弹窗） | 未编辑则自动填入（FR-003 默认值），编辑过则不覆盖 |
| 轮询至 `ready/degraded-ready` | 「导出」按钮可用 |
| 点击「导出」 | 按钮 loading（表现层防重）→ `export.commit`；成败均更新反馈区（FR-012/FR-010），失败保留 title/target 并显示「重试」 |
| 重试（弹窗） | 再次 `export.commit`（同 taskId，Host 复用缓存 body，不重调 LLM） |
| 静默成功/降级 | 轮询得知终态 → toast 显示落点/降级说明，~6s 自动消失（FR-020） |
| 静默失败 | toast 常驻显示原因 + 「重试」/「打开设置」；**不自动打开弹窗**（FR-020） |
| 静默重试 | 再次 `export.open({ messageId, sessionId, intent:'silent' })`，同幂等键复用 body |
| 静默进行中切换会话/面板 | 任务不受影响；单例继续轮询并在终态发 toast（FR-019） |
| 关闭弹窗 | `generating` 中先 `export.cancel`；其余直接关闭；**静默任务不受此影响** |
| 打开设置面板 | `prefs.get` 渲染开关与默认路径；失败回退默认值 + 就地提示 |
| 修改开关/路径 | 即时 `prefs.update`（无全局保存按钮）；保存中禁用该项，失败回滚到服务端值并提示（SC-010） |
| 设置页展开树 | `tree.list` 懒加载；选择节点 → `prefs.update({ defaultPath })`，服务端校验 |
| 展开树节点（弹窗） | `tree.list` 懒加载；失败就地显示原因与重试 |

## 类型共享与校验

- `src/contract.ts` 导出全部请求/响应类型；Host 侧逐字段校验（可选参数用 `!== undefined`，空字符串不回退为「未提供」）。
- `export.open` 的响应是**按 `mode` 的判别联合**；Client 必须先判 `mode` 再解包，禁止读取不存在字段。
- Client 侧同样校验边界数据（stale response 防护：旧 taskId 响应不得覆盖新弹窗状态；静默 toast 按 taskId 去重）。
