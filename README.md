# dsh-siyuan-export · 导出到思源

在 dsh（DeepSeek Harness）对话中，把**单条助手回复**一键导出为结构清晰、带小图标的思源笔记。

- 每条助手回复的操作栏都有「导出到思源」按钮（官方 slot `conversation.chat.assistant-actions`）
- 点击弹窗：**主题名**由大模型基于该条回复生成（可编辑，不带任何对话上下文，省 token）；**存放位置**在弹窗内的文档树中逐层选择（记住上次成功路径）
- 导出内容为结构化 Markdown：二级标题分节、要点带小图标（✅ 📌 ⚠️ 💡）、代码块与列表原样保留，文末附来源元数据
- 失败可恢复：明确原因 + 分类引导文案 + 重试（复用已生成内容，不重调模型）

## 安装

```powershell
# 构建并打包（prepack 自动执行 typecheck + host/client 构建）
npm run build
npm pack                       # 产出 dsh-siyuan-export-<version>.tgz

# 安装到 dsh profile（隔离验证建议先用独立 DSH_HOME）
node "<dsh-repo>\apps\cli\lib\bin.js" plugin --profile web add "<此仓库>\dsh-siyuan-export-0.1.0.tgz"
node "<dsh-repo>\apps\cli\lib\bin.js" --profile web --dump-config   # 确认 # == dsh-siyuan-export 入选
# 重启 dsh Web 宿主
```

## 配置

在插件配置中设置（Standard Schema 校验，均有默认值）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:6806` | 思源本地 API 地址 |
| `token` | 空 | 思源 **设置 → 鉴权 → API token**；未开鉴权的服务可留空 |
| `dataDir` | `plugins/siyuan-export` | 插件偏好数据子目录（相对 `$DSH_HOME`） |

> Token 只经 Config 传入，不写日志、审计、状态文件或 RPC 响应（tests/unit/secret-scan.test.ts 守护）。

## 使用

1. 等待助手回复完成 → hover 消息行 → 点击「导出到思源」
2. 弹窗打开：标题自动生成中（用户已编辑则不覆盖）；文档树逐层展开选择存放位置
3. 点击「导出」→ 成功显示落点；失败显示原因 + 分类引导 + 「重试」（保留已填内容）

## 开发

```powershell
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run（单元 + 集成 + client + 真实思源 E2E）
npm run build       # typecheck + host + client handoff
node scripts/pack-check.mjs   # 打包内容核对
```

- 红→绿→重构逐任务循环；测试替身：`tests/integration/fake-siyuan.ts`（内存端口）与 `fake-llm.ts`（四模式）
- 真实思源 E2E：`tests/e2e/siyuan-real.test.ts`（思源未运行时整体 skip，不假绿；写入后自动清理测试目录）
- 隔离环境：`scripts/setup-isolated-env.ps1` → 启动 → `scripts/teardown-isolated-env.ps1`（junction 安全清理）

## 未验证边界（诚实清单）

以下项**尚未**在本实现阶段完成真实验证（见 quickstart.md 执行记录）：

- 浏览器中消息行按钮/弹窗/文档树的**真实渲染与点击**（需真实对话 + 浏览器）
- **真实模型**生成链路（`prepareCall → stream` 全链与 SC-001/002/003/004 计时与抽样）——隔离环境无模型凭据
- 思源「目标路径被删除后重选」的真实场景（错误分类已单测覆盖）

## 设计文档

- 规格：[specs/001-siyuan-note-export/spec.md](specs/001-siyuan-note-export/spec.md)
- 选型：[specs/001-siyuan-note-export/tech-decisions.md](specs/001-siyuan-note-export/tech-decisions.md)
- 计划与任务：[specs/001-siyuan-note-export/plan.md](specs/001-siyuan-note-export/plan.md) · [tasks.md](specs/001-siyuan-note-export/tasks.md)
- 契约：[contracts/rpc.md](specs/001-siyuan-note-export/contracts/rpc.md) · [contracts/siyuan.md](specs/001-siyuan-note-export/contracts/siyuan.md)
- 术语：[GLOSSARY.md](GLOSSARY.md)
