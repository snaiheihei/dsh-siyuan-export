# 契约 · 思源 HTTP API 适配器（contracts/siyuan.md）

> 宿主侧唯一出口（`src/siyuan/client.ts`）；**Token 只存插件 Config**，不入日志/审计/状态文件/RPC 响应。全部 `POST` + JSON body，标头 `Authorization: Token <token>`。适配器**同时处理「非 2xx」与「200 但 code != 0」**两种失败形态。依据见 [research.md](../research.md) R3。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `siyuan.endpoint` | `http://127.0.0.1:6806` | 可配；探活 `POST /api/system/version` |
| `siyuan.token` | —（必填） | 思源 **设置 → 鉴权 → API token**；凭据经插件 Config 提供 |

未配置/无效 → `tree.list` 即报 `siyuan-auth`，弹窗显示引导文案（FR-010）。

## 使用的接口（均为官方）

| 用途 | 接口 | 请求 | 响应要点 | 错误映射 |
|---|---|---|---|---|
| 探活 | `/api/system/version` | `{}` | `code`/`data` | `siyuan-connect` |
| 笔记本列表 | `/api/notebook/lsNotebooks` | 无参 | `data.notebooks[]{id,name,closed}` | `siyuan-connect` / `siyuan-auth` |
| 子文档层级 | `/api/query/sql` | `{stmt}` 显式 `LIMIT`+稳定排序 | 行含 `id,parent_id,box,hpath,type`（列名以实测为准） | `siyuan-connect`（发布模式禁用也归此） |
| 路径↔ID | `/api/filetree/getIDsByHPath`、`/api/filetree/getPathByID` | `{notebook,path}` / `{id}` | `id[]` / `{notebook,path}` | `siyuan-path` |
| **写入** | `/api/filetree/createDocWithMd` | `{notebook, path: "/父级/标题", markdown}` | `data` = 新建文档 ID | `pathAmbiguous`/`indexUnavailable` → `siyuan-path`；其余按类 |
| （备选）子文档 | `/api/filetree/lsDoc` | `{notebook,path,...}` | **未公开**，实测稳定后才可作性能优化 | 同上 |
| （备选）建文档 | `/api/filetree/createDocByParent` | 见生成类型契约 `index.d.ts` | 官方建议的替代路径 | 同上 |

## 规则

1. **标题净化在上游完成**：`ExportRequest.title` 校验层已清理 `/` 等非法字符（data-model），杜绝 `pathAmbiguous` 的标题诱因；`/` 保留在路径分隔语义中。
2. **同名消歧（FR-007 硬保证）**：commit 前先 `getIDsByHPath(notebook, hpath + "/" + title)` 查重；命中 → 追加 ` (2)`、` (3)`… 后缀重试，**保证「不覆盖、独立文档」**。原因：同 path 重复创建的真实行为（复用 ID vs 新建同名）文档未说明（R3 待实测），不能依赖其默认行为。
3. **错误分类**：连接失败/非 2xx → `siyuan-connect`；`code != 0`：认证类 → `siyuan-auth`，路径类（`pathAmbiguous`、路径失效）→ `siyuan-path`，**瞬时索引未就绪（`indexUnavailable` / `document metadata is not ready`，真实实测）→ `siyuan-connect` 可重试**，其余 → `siyuan-connect`（retryable）。RPC 层输出的 `message` 为用户可读中文，**不含堆栈、内部路径、正文秘密**。
4. **写后不立即 SQL 读**：如需回读验证，先 `POST /api/sqlite/flushTransaction` 等 `code:0`（quickstart 的落点核验以思源 UI 打开为准，不走此路径）。
5. **路径拼接**：`StoragePath.parentSegments`（选中文档的 `hpath` 分段）+ 消歧后的 title → `createDocWithMd.path`；`createDocWithMd` 的「父级缺失自动创建」只作接口既有语义，不作为落点失效的兜底——设置默认路径与静默导出按规则 7 先校验，选中路径失效仍映射 `siyuan-path` 引导重选。
6. **超时与中止**：适配器请求带 `AbortSignal`（与导出任务的 cancel 同源）与有限超时；重试仅对 retryable 分类、限次退避。
7. **目标校验（Change：设置默认路径 / 静默落点）**：写入前与 `prefs.update` 保存前都调用 `validateTarget(path)`——
   - `notebookId` 必须存在于 `lsNotebooks` 且未关闭；否则 `siyuan-path`。
   - `parentSegments` 非空时用 `getIDsByHPath(notebook, hpath)` 校验父级存在；不存在 → `siyuan-path`，**不自动创建父级链**（设置页要求选中真实节点）。
   - 校验失败**不写入**；静默模式直接 `failed`，**不回退到其他落点**（FR-023）。
   - 静默落点第三优先级取 `lsNotebooks` 第一本未关闭笔记本的根（`parentSegments=[]`）；无任何笔记本 → `siyuan-path`。
8. **静默写入**：与弹窗共用 `createDocWithMd` + 查重消歧；写入前 `getIDsByHPath` 失败（如索引未就绪 `indexUnavailable`）按规则 3 映射 `siyuan-connect` 可重试，**不得**在未查重时直接创建（FR-007）。
