# 契约 · Host ↔ Client RPC（contracts/rpc.md）

> 树外插件自有同源 prefix 路由（`webServer.register()`），不修改 dsh Remote allowlist。共享类型在 `src/contract.ts`（Client 经 `client/src/rpc.ts` 使用），**运行时双侧仍做边界校验**。

## 传输规则

- 全部 `POST` + JSON body；方法白名单（下表 5 个，其余一律拒绝）。
- 自定义请求头携带插件内部 nonce（防简单 CSRF/误调）；body 上限 **1 MB**（对齐 body 尺寸上限）。
- 响应信封统一：`{ ok: true, data }` 或 `{ ok: false, error: { category, message, retryable } }`。
  - `message` 为**用户可读中文文案**；禁止堆栈、内部文件路径、正文秘密（skill：业务错误与传输错误分开）。
  - `category` 取值 = data-model 错误分类表（`siyuan-auth` / `siyuan-connect` / `siyuan-path` / `llm-adapter` / `llm-quota` / `llm-timeout` / `llm-structure` / `internal`）。
- `recordInput` 审慎设置：导出请求可能含正文引用，命令历史只记 messageId/taskId 等元数据。

## 方法清单

### 1. `export.open`

打开弹窗：绑定源消息、恢复偏好、幂等启动生成。

```ts
// req
{ messageId: string, sessionId: string, contentRevision: string }
// res (ok)
{ taskId: string,
  status: 'generating' | 'ready' | 'degraded-ready',
  title: string | null,            // LLM 默认主题名；generating 中为 null
  lastPath: StoragePath | null,    // Prefs.lastPath（FR-006）
  error: ErrorInfo | null }
```

- **幂等**：同 `taskId`（= messageId+revision）已有任务 → 返回其状态，**不重复调 LLM**（FR-011）。
- `status: 'generating'` 时 Client 以轮询等待（见下）；`title` 一旦非 null 即自动填入输入框（未被用户编辑时覆盖，否则保留用户输入）。

### 2. `export.state`

弹窗打开期间轮询（间隔 500ms，带 jitter；收到终态即停）。

```ts
// req  { taskId: string }
// res  { status, title: string | null, error: ErrorInfo | null }
```

- `status` ∈ `generating | ready | degraded-ready | writing | succeeded | failed | cancelled`。
- **不返回 body**（正文仅 Host 持有，data-model 不变量）。

### 3. `export.commit`

确认导出（写入思源）。

```ts
// req  { taskId: string, title: string, target: StoragePath }
// res  { status: 'succeeded', target: StoragePath, href: string | null }   // href 用于「已导出到…」反馈（FR-012）
```

- 服务端校验：title 规则、target.notebookId 存在、任务处于 `ready|degraded-ready|failed`；`writing` 中重复 commit → `retryable: false` 的幂等拒绝（FR-011）。
- 成功后回写 `Prefs.lastPath`（FR-006）。

### 4. `export.cancel`

关闭弹窗/用户取消（仅 `generating` 阶段有效）。

```ts
// req  { taskId: string }   // res { status: 'cancelled' | 'noop' }
```

- 触发 `AbortSignal` 中止 LLM 流；`writing` 阶段不可取消（避免半成品）。

### 5. `tree.list`

懒加载文档树（弹窗选择器用）。

```ts
// req  { notebookId?: string, docId?: string }   // 两者皆空 = 列出笔记本
// res  { nodes: Array<{ id: string, name: string, kind: 'notebook' | 'doc',
//                      notebookId: string, hasChildren: boolean,
//                      path: string[] /* parentSegments，选中即 StoragePath.parentSegments */ }> }
```

- 参数语义与思源 API 的对应关系见 `siyuan.md`（R3 确认后填）。
- 展开某节点时带 `notebookId + docId` 再调；只读操作，失败映射 `siyuan-connect` / `siyuan-auth`。

## Client 行为契约（UI 状态 ↔ RPC）

| UI 事件 | 行为 |
|---|---|
| 点击导出按钮 | `export.open` → 立即打开弹窗（< 1s，SC-001 前半）；title 生成中显示占位「正在生成默认主题名…」 |
| title 返回 | 未编辑则自动填入（FR-003 默认值），编辑过则不覆盖 |
| 轮询至 `ready/degraded-ready` | 「导出」按钮可用 |
| 点击「导出」 | 按钮 loading（表现层防重）→ `export.commit`；成败均更新反馈区（FR-012/FR-010），失败保留 title/target 并显示「重试」 |
| 重试 | 再次 `export.commit`（同 taskId，Host 复用缓存 body，不重调 LLM） |
| 关闭弹窗 | `generating` 中先 `export.cancel`；其余直接关闭 |
| 展开树节点 | `tree.list` 懒加载；失败就地显示原因与重试 |

## 类型共享与校验

- `src/contract.ts` 导出全部请求/响应类型；Host 侧逐字段校验（可选参数用 `!== undefined`，空字符串不回退为「未提供」）。
- Client 侧同样校验边界数据（stale response 防护：旧 taskId 响应不得覆盖新弹窗状态）。
