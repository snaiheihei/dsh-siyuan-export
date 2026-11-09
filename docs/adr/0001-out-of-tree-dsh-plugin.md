# 采用 dsh 树外插件而非浏览器扩展或修改宿主源码

dsh 导出功能以树外插件（Cordis Host/Client bundle + `dsh.bundle.patch`）交付，不修改 dsh 源码、不做浏览器扩展。理由：只有宿主扩展点能同时提供 Session 事件（感知回复完成）、`ctx.llm` 辅助模型通道与 UI slot，且插件可装卸、宿主升级不丢失；浏览器扩展拿不到宿主能力且 DOM 耦合脆，改源码升级即失效。
