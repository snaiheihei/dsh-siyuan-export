/**
 * T038 · `siyuan-export` locale 命名字典（zh 为 key-set 真源）
 *
 * 接入模式（对齐官方 ui-message-feedback）：
 *  - declare module 合并 `LocaleNamespaceMap`（声明本 NS 的键集）
 *  - register 描述符带 `locale: NS` → 框架把 `t` seat 注入组件 props
 *  - 组件用 `t('key')` / `t('key', { param })` 取文案，不再硬编码
 */

/** 简体中文字典（key-set 真源） */
export const zh = {
  'button.export': '导出到思源',
  'button.exporting': '导出中…',
  'dialog.title': '导出到思源',
  'dialog.close': '关闭',
  'field.title': '主题名',
  'field.titleGenerating': '正在生成默认主题名…',
  'field.titlePlaceholder': '请输入笔记标题',
  'field.target': '存放位置',
  'field.targetEmpty': '未选择',
  'field.targetLast': '未选择（上次：{path}）',
  'submit.export': '导出',
  'submit.exporting': '导出中…',
  'submit.retry': '重试',
  'feedback.succeeded': '已导出到：',
  'feedback.failed': '导出失败：',
  'feedback.degradedPrefix': '未能自动排版（',
  'feedback.degradedSuffix': '），已使用原文，可继续导出',
  'feedback.generating': '正在生成默认主题名…',
  'feedback.writing': '正在写入思源…',
  'guide.siyuan-auth': '请在思源「设置 → 鉴权 → API token」复制 Token，并填入插件配置后重试。',
  'guide.siyuan-connect': '请确认思源已启动且端口可访问（默认 127.0.0.1:6806），然后重试。',
  'guide.siyuan-path': '目标路径可能已被删除或无效，请在文档树中重新选择存放位置。',
  'guide.llm-adapter': '请在 dsh 模型设置中检查可用的 provider/model，然后重试。',
  'tree.loading': '加载中…',
  'tree.retry': '重试',
  'tree.selected': '已选中',
  'tree.loadError': '加载失败',
} satisfies Record<string, string>

/** 本命名空间的键集 */
export type SiyuanExportKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 导出到思源的全部界面文案：按钮、弹窗、状态反馈、错误引导、文档树。 */
    'siyuan-export': SiyuanExportKey
  }
}

/** 英文字典（对照 zh 键集完整性由类型校验） */
export const en = {
  'button.export': 'Export to SiYuan',
  'button.exporting': 'Exporting…',
  'dialog.title': 'Export to SiYuan',
  'dialog.close': 'Close',
  'field.title': 'Title',
  'field.titleGenerating': 'Generating default title…',
  'field.titlePlaceholder': 'Enter a note title',
  'field.target': 'Destination',
  'field.targetEmpty': 'Not selected',
  'field.targetLast': 'Not selected (last: {path})',
  'submit.export': 'Export',
  'submit.exporting': 'Exporting…',
  'submit.retry': 'Retry',
  'feedback.succeeded': 'Exported to: ',
  'feedback.failed': 'Export failed: ',
  'feedback.degradedPrefix': 'Auto formatting failed (',
  'feedback.degradedSuffix': '); the original text is used and you can still export',
  'feedback.generating': 'Generating default title…',
  'feedback.writing': 'Writing to SiYuan…',
  'guide.siyuan-auth':
    'Copy the token from SiYuan Settings → Authentication → API token and put it in the plugin config, then retry.',
  'guide.siyuan-connect':
    'Make sure SiYuan is running and the port is reachable (default 127.0.0.1:6806), then retry.',
  'guide.siyuan-path':
    'The target path may have been deleted or is invalid; pick another place in the document tree.',
  'guide.llm-adapter': 'Check the available provider/model in the dsh model settings, then retry.',
  'tree.loading': 'Loading…',
  'tree.retry': 'Retry',
  'tree.selected': 'Selected',
  'tree.loadError': 'Loading failed',
} satisfies Record<SiyuanExportKey, string>

/** 有引导文案的错误类别（对应 `guide.${category}` 字典键） */
export const GUIDE_CATEGORIES = [
  'siyuan-auth',
  'siyuan-connect',
  'siyuan-path',
  'llm-adapter',
] as const;

export type GuideCategory = (typeof GUIDE_CATEGORIES)[number];

export function isGuideKey(category: string): category is GuideCategory {
  return (GUIDE_CATEGORIES as readonly string[]).includes(category);
}

/** 各指引文案的首短语（与上方 guide.* 字典值一致；用于判重，避免魔法 slice） */
const GUIDE_LEAD_PHRASE: Record<GuideCategory, string> = {
  'siyuan-auth': '请在思源',
  'siyuan-connect': '请确认思源',
  'siyuan-path': '目标路径',
  'llm-adapter': '请在 dsh',
};

/**
 * 是否追加指引（T046）：服务端 message 已含该指引时（如 auth 文案自带配置路径）
 * 不重复拼接；按命名首短语判断，替代无解释的 `guide.slice(0, 6)`。
 */
export function shouldAppendGuide(message: string, category: string): boolean {
  if (!isGuideKey(category)) return false;
  return !message.includes(GUIDE_LEAD_PHRASE[category]);
}

/** 测试/降级用的同步 zh 翻译器（签名对齐官方 TranslateNS：params 值为 unknown） */
export function zhT(key: SiyuanExportKey, params?: Record<string, unknown>): string {
  let text: string = zh[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
