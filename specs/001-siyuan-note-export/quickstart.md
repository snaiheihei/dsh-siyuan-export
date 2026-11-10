# Quickstart · 端到端验证指南

> 目的：用可复跑的场景证明特性成立。数据形状见 [data-model.md](data-model.md)，接口见 [contracts/rpc.md](rpc.md)（思源侧见 `contracts/siyuan.md`），实现细节不在此重复。命令以插件仓库 `package.json` 真实脚本为准，下表为预期形态。

## 前置条件

- Node ≥ 24.9.0、pnpm（宿主 workspace 要求）；dsh 检出 `github/deepseek-harness` `0.2.2-rc.1`
- 思源运行中（本机默认 `http://127.0.0.1:6806`，API 默认开启无需开关），已获取 **API Token**（思源 设置 → 鉴权 → API token），配置为插件 Config 项（Token 不写入日志/审计/状态文件）
- 隔离环境：独立 `DSH_HOME` + web profile + 独立端口（不碰真实环境与真实数据）
- 宿主已配置至少一个可用 LLM provider/model（D3 宿主通道）

## V0 · 构建与隔离安装（链路打通）

```powershell
npm run typecheck; npm test; npm run build; npm pack
node "<dsh-repo>\apps\cli\lib\bin.js" --profile web plugin add "<plugin>.tgz"
node "<dsh-repo>\apps\cli\lib\bin.js" --profile web --dump-config   # 仅证 bundle 入选；非严格只读
# 以隔离 DSH_HOME、独立端口启动测试 Host（冷启动，不假设热重载）
```

**预期**：typecheck/test/build 全绿；`dump-config` 显示 bundle 与 patch 行；Host 启动无装载错误（按 package.json → patch → exports → inject → 产物格式 → Host 日志顺序排障）。

## V1 · 消息操作栏按钮（FR-001）

**操作**：隔离环境发起一次对话，等待回复**完成**，hover 该条消息行。
**预期**：copy 与 branch 按钮之间出现「导出到思源」；仅定稿消息有该按钮（中断消息无）；重启 Host 后按钮仍注册且**无重复注入**。
**证据**：UI 截图 + Host 日志无 slot 注册错误。

## V2 · 弹窗、默认主题名与文档树（FR-002/003/004/005/006）

**操作**：点击导出按钮；观察标题输入框；展开并选择文档树的笔记本/子文档。
**预期**：< 1s 打开弹窗；标题先显示「正在生成默认主题名…」随后**自动填入** LLM 默认值（用户已编辑则不覆盖）；树懒加载（`tree.list`），选中即目标落点；曾成功导出过则 `lastPath` 为默认选中（首次为 null，可选笔记本根）。
**边界**：stale 响应不覆盖新弹窗状态；「导出」按钮在 `ready/degraded-ready` 前不可用。

## V3 · 真实写入思源（FR-007/009/012 + SC-003/004）

**操作**：确认主题名与路径 → 点击「导出」。
**预期**：所选路径下**新建**以主题名命名的文档；打开即为结构化笔记——清晰标题分节、要点带小图标（✅ 📌 ⚠️ 💡 等）、代码块与列表原样保留；反馈区显示落点（FR-012）；再次打开弹窗默认路径 = 本次位置（FR-006）。
**抽样**：按 SC-003 评估 ≥90% 无需二次编辑；SC-004 默认主题名 ≥80% 免改。
**证据**：思源中打开文档截图 + 第二次导出的默认路径。

## V4 · 幂等防重（FR-011 + SC-006）

**操作**：按钮 loading 期间重复点击；同消息重复 `export.open`；writing 中重复 commit。
**预期**：**只产生一篇**笔记；同键 open 不重复调 LLM（Host 调用计数为 1）；重复 commit 被幂等拒绝而非二次写入。

## V5 · LLM 通道与 FR-013（省 token 硬约束）

**操作 A（真实小请求）**：`export.open` 触发生成，验证 provider/model 经 `listProviders()/listModels()` 解析成功、生成完成。
**操作 B（输入裁剪复核）**：检查该次真实请求的 prompt（测试日志或 mock 捕获）。
**预期 B**：输入 = **该条单次输出 + 固定指令模板**，**不含** Session 历史、用户提问、工具输出（FR-013；`tests/unit` 已有负向断言，此处真实链路复核）。
**失败注入**：故意配置无 adapter 的 provider → 弹窗显示 `llm-adapter` 引导文案，**不误报成功**。

## V6 · 失败与重试（FR-010 + US3 全场景）

| 步骤 | 操作 | 预期 |
|---|---|---|
| a | 关闭思源后导出 | `siyuan-connect` 文案 + 「重试」；**title/target 保留**；恢复思源后重试成功且仅一篇（SC-006） |
| b | 模拟 LLM 超时/断开模型 | 进入 `degraded-ready`：标题=首行截断、正文=原文，仍可导出（US3-2） |
| c | 生成中关闭弹窗 | `cancel` 中止模型流；**无半成品文档**（edge case） |
| d | 导出前删除目标文档 | commit 报 `siyuan-path`，引导重选路径 |

## V7 · 同名与长内容（Edge cases）

- 同名路径导出两次 → 两篇独立文档，互不覆盖（FR-007）。
- 数万字长回复 → 正常导出不截断（edge case）。

## 验证矩阵

| FR / SC | 用例 |
|---|---|
| FR-001 | V1 |
| FR-002/003/004/005/006 | V2 |
| FR-007/009/012 · SC-003/004 | V3 |
| FR-011 · SC-006 | V4 |
| FR-013 | V5B（+ unit 负向断言） |
| FR-010 · US3 · SC-005 | V6 |
| FR-008 · edge cases | V3（结构保留）、V7 |
| SC-001 | V2（打开 <1s，3 次点击内完成） |
| SC-002 | V3 计时（95% < 30s） |

## 清理

停止自己启动的测试 Host → 确认测试端口不再监听 → 从隔离 profile 移除插件 → 清理临时 Token 与测试数据；真实 `$DSH_HOME` 的 dump/诊断不外发。

---

## 执行记录（2026-11-10 · implement 阶段）

> 图例：✅ 自动化已通过（当次会话命令输出）　⏳ 待手工/需真实模型或浏览器

| 场景 | 状态 | 证据 / 说明 |
|---|---|---|
| V0 构建与隔离安装 | ✅ | `npm pack` → 隔离 `plugin add` exit 0 → `--dump-config` 入选无 skip → 冷启动 200（T009/T026/T033 三次执行） |
| V1 消息行按钮渲染 | ⏳ | 注册路径单测覆盖（T008 2/2）+ 产物含 slot key（T026）；**真实对话中按钮出现需浏览器手工核验** |
| V2 标题部分（打开<1s、回填不覆盖） | ✅（逻辑）/ ⏳（渲染） | 逻辑单测 T025 9/9 + T016；树部分三层 E2E 真实数据（T033）；浏览器计时待手工 |
| V2 树逐层展开与默认路径 | ✅ | 隔离 Host `tree.list` 三层真实：1 本 → 18 根文档 → /AI 下 9 子文档（T033） |
| V3 真实写入思源 | ✅ | 真实思源 E2E：createNote 落盘 + 回读 + formatNote 元数据随文（siyuan-real.test.ts） |
| V4 幂等防重 | ✅ | T016 幂等 open / writing 拒绝 + T019 集成（同键只调一次 LLM） |
| V5A 真实模型小请求 | ⏳ | 隔离环境无模型凭据；**需在已配模型的环境点一次导出核验**（prepareCall→stream 全链） |
| V5B FR-013 输入复核 | ✅ | 负向断言 T017 4/4 + 集成捕获 T019（messages 精确等于单次输出包裹） |
| V6a 连接失败→恢复重试 | ✅ | 真实 E2E：错误 endpoint → `siyuan-connect` 可重试（siyuan-real.test.ts） |
| V6b LLM 失败→降级 | ✅ | 单测 T016：timeout/structure-bad → `degraded-ready` 首行标题仍可导出 |
| V6c 生成中关闭→无半成品 | ✅ | 单测 T016/T035：cancel 中止、晚到结果不覆盖 |
| V6d 目标路径失效 | ✅（分类）/ ⏳（真实删除场景） | `pathAmbiguous`/404 → `siyuan-path` 单测覆盖；真实删路径重选待手工 |
| V7 同名两次独立文档 | ✅ | 真实思源：`/同名测试` + `/同名测试 (2)` 两篇独立落盘；同 path 直接重复语义已实测 |
| V7 长回复不截断 | ✅（结构）/ ⏳（数万字真实） | body 1MB 上限单测；数万字真实导出待手工 |
| SC-001 ≤3 点击/弹窗<1s | ⏳ | 需浏览器计时手工核验 |
| SC-002 95% <30s | ⏳ | 需真实模型导出计时 |
| SC-003/004 抽样评估 | ⏳ | 需真实模型产出后人工抽样 |
| 隔离环境清理纪律 | ✅ | 三次 E2E 均用完即 teardown（端口释放、目录删除、测试文档 removeDocByID 清零） |

**本阶段实测纠正（进入实现前未知的真实行为）**：
1. `document metadata is not ready` 为瞬时错误 → 分类 `siyuan-connect` 可重试（原按 `indexUnavailable` 归 path 不可重试）
2. 跨级路径自动创建不可靠 → `createNote` 逐级 ensure 父级（DocTree 选的已存在路径通常零额外写）
3. `removeDocByID {id}` 才是按 id 删除的官方签名（`removeDoc` 要 `.sy` 存储路径）
4. 根层文档判定 = path 斜杠数 1；`lsNotebooks` 返回 `{notebooks:[…]}` 包装对象

