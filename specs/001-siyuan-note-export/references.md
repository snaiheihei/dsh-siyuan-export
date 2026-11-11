# References

> Updated: 2026-11-11
> 仅作按需索引；适用阶段为 specify / plan / implement，tech-gate 与 plan 共用 plan 条目。

| ID | 类型 | 来源 | 版本 / 访问日期 | 适用阶段 | 可借鉴点 | 证据与限制 |
|---|---|---|---|---|---|---|
| REF-001 | project | `C:\Users\503247565\OneDrive - GE HealthCare\Desktop\program\github\deepseek-harness` | 0.2.2-rc.1；commit `66491b05`；2026-11-11 | plan/implement | 插件宿主契约与可用扩展点：导出按钮可挂 `conversation.chat.assistant-actions`；模型标题生成用 `ctx.llm.prepareCall()` 保持同一注册；本地宿主在 3080 端口运行，可直接验证装载与 UI | `docs/subsystems/slots.md` 的会话槽位树；`docs/subsystems/llm-streaming.md` 的 `prepareCall` 与输出预算说明；`docs/cookbook/` 的插件与工具示例。限制：仅代表该 commit 的契约，宿主升级后需重新核对；不改宿主源码 |
| REF-002 | project | `C:\Users\503247565\OneDrive - GE HealthCare\Desktop\program\github\dsh-snail-memory` | 0.1.5；commit `0369ea22`；2026-11-11 | plan/implement | 可复用的辅助模型调用形态：`AuxiliaryModel.prepareCall()` → `prepared.stream()`，按字符预算换算 `maxTokens`、超预算即中止、输出按不可信数据解析；状态用单一权威 JSON 原子发布，Markdown 只作可重建投影 | `src/lifecycle/llm.ts:13`（接口）与 `src/lifecycle/llm.ts:146`（调用与预算）；`src/runtime.ts:167`（宿主 `ctx.llm` 适配）；`README.md` 的「配置」「数据位置」「隐私与安全」。限制：记忆业务语义不可照搬；只借鉴模型调用、RPC 同源路由与持久化纪律 |
| REF-003 | skill | `C:\Users\503247565\.qoder-cn\skills\develop-dsh-plugin\SKILL.md` | 2026-11-11 | plan/implement | 树外插件开发与验证清单：锁定宿主版本与扩展点、先最小装载切片、Host 为权威状态、RPC 同源路由与逐字段校验、隔离 `DSH_HOME` 做真实 E2E；明确区分“已排队 / 已持久化 / UI 已显示” | `SKILL.md` 的工作流与第 3、6、8、10、11 节。限制：面向 dsh 树外插件，不覆盖宿主改造；真实主机安装与重启须用户授权 |
| REF-004 | skill | `C:\Users\503247565\.qoder-cn\skills\design-taste-frontend\SKILL.md` | 2026-11-11 | implement | 弹窗与导出面板按“component / single section”路径处理：匹配宿主既有设计语言，套用 house rules（无渐变、无玻璃拟态、无发丝线、控件可用键盘）；改版需先用真实浏览器度量再评审 | `SKILL.md` 的「A component or a single section, not a page」与「House rules」。限制：主体面向整页与 App screen；`inspect.mjs` 需要 Node 22+ 与 Chrome/Edge，未安装时只能人工截图评审 |
