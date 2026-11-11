/**
 * T038 · `siyuan-export` locale 命名字典（zh 为 key-set 真源）
 *
 * 接入模式（对齐官方 ui-message-feedback）：
 *  - declare module 合并 `LocaleNamespaceMap`（声明本 NS 的键集）
 *  - **apply 时 `ctx.locale.register(NS, { zh, en })` 注册运行时字典**
 *    （真实试用缺陷修复：漏注册 → t() 回退显示 key，如 "button.export"）
 *  - register 描述符带 `locale: NS` → 框架把 `t` seat 注入组件 props
 *  - 组件用 `t('key')` / `t('key', { param })` 取文案，不再硬编码
 */
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots';

/** 简体中文字典（key-set 真源） */
export const zh = {
  'button.export': '导出到思源',
  'button.exporting': '导出中…',
  'sidebar.label': 'Siyuan Export',
  'settings.panel': '导出设置',
  'settings.description': '配置默认存放位置与导出交互；修改立即生效，无需保存。',
  'settings.autoSave': '即时保存',
  'settings.mode': '导出方式',
  'settings.modeDialog': '弹窗确认',
  'settings.modeDialogNote': '每次导出确认标题与落点',
  'settings.modeSilent': '静默导出',
  'settings.modeSilentNote': '后台写入，不打断对话',
  'settings.on': '已开启',
  'settings.off': '已关闭',
  'settings.lastPath': '上次成功落点',
  'settings.lastPathNote': '未设默认路径时回退到该笔记本',
  'settings.behavior': '导出行为',
  'settings.destination': '存放位置',
  'settings.showDialog': '导出时显示弹窗',
  'settings.showDialogHint': '关闭后点击导出直接后台写入，不再弹出确认框',
  'settings.defaultPath': '默认存放路径',
  'settings.pathHint': '静默导出优先使用；只能选择思源中的笔记本或文档',
  'settings.pathEmpty': '未选择',
  'settings.choosePath': '选择路径',
  'settings.collapseTree': '收起',
  'settings.clearPath': '清除',
  'settings.loading': '加载中…',
  'settings.loadError': '设置加载失败',
  'settings.saveError': '保存失败，已恢复上次设置',
  'settings.retry': '重试',
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
  'submit.generating': '生成中…',
  'submit.retry': '重试',
  'feedback.succeeded': '已导出到：',
  'feedback.failed': '导出失败：',
  'feedback.degradedPrefix': '未能自动排版（',
  'feedback.degradedSuffix': '），已使用原文，可继续导出',
  'feedback.generating': '正在调用模型生成标题与正文…',
  'feedback.writing': '正在写入思源…',
  'feedback.failedGeneric': '导出失败，请稍后重试',
  'feedback.degradedShort': '自动排版失败，已使用原文，仍可继续导出',
  'guide.siyuan-auth': '请在思源「设置 → 鉴权 → API token」复制 Token，并填入插件配置后重试。',
  'guide.siyuan-connect': '请确认思源已启动且端口可访问（默认 127.0.0.1:6806），然后重试。',
  'guide.siyuan-path': '目标路径可能已被删除或无效，请在文档树中重新选择存放位置。',
  'guide.llm-adapter': '请在 dsh 模型设置中检查可用的 provider/model，然后重试。',
  'toast.degraded': '已导出到：{path}（未自动排版，已使用原文）',
  'toast.dismiss': '关闭提示',
  'toast.failed': '导出失败：{reason}',
  'toast.openSettings': '打开设置',
  'toast.retry': '重试',
  'toast.succeeded': '已导出到：{path}',
  'tree.loading': '加载中…',
  'tree.retry': '重试',
  'tree.selected': '已选中',
  'tree.loadError': '加载失败',
  'tree.expand': '展开',
  'tree.collapse': '折叠',
  'tree.empty': '思源中还没有笔记本，请先在思源创建',
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
  'sidebar.label': 'Siyuan Export',
  'settings.panel': 'Export settings',
  'settings.description':
    'Configure the default destination and export behavior. Changes apply immediately; no save button needed.',
  'settings.autoSave': 'Saves instantly',
  'settings.mode': 'Export mode',
  'settings.modeDialog': 'Dialog',
  'settings.modeDialogNote': 'Confirm title and destination on each export',
  'settings.modeSilent': 'Silent',
  'settings.modeSilentNote': 'Writes in the background without interrupting',
  'settings.on': 'On',
  'settings.off': 'Off',
  'settings.lastPath': 'Last successful destination',
  'settings.lastPathNote': 'Used as fallback when no default is set',
  'settings.behavior': 'Export behavior',
  'settings.destination': 'Destination',
  'settings.showDialog': 'Show dialog when exporting',
  'settings.showDialogHint':
    'When off, exporting writes in the background without a confirmation dialog',
  'settings.defaultPath': 'Default destination',
  'settings.pathHint': 'Used first for silent export; only notebooks or documents in SiYuan',
  'settings.pathEmpty': 'Not selected',
  'settings.choosePath': 'Choose path',
  'settings.collapseTree': 'Hide',
  'settings.clearPath': 'Clear',
  'settings.loading': 'Loading…',
  'settings.loadError': 'Failed to load settings',
  'settings.saveError': 'Saving failed; previous settings restored',
  'settings.retry': 'Retry',
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
  'submit.generating': 'Generating…',
  'submit.retry': 'Retry',
  'feedback.succeeded': 'Exported to: ',
  'feedback.failed': 'Export failed: ',
  'feedback.degradedPrefix': 'Auto formatting failed (',
  'feedback.degradedSuffix': '); the original text is used and you can still export',
  'feedback.generating': 'Generating title and body with the model…',
  'feedback.writing': 'Writing to SiYuan…',
  'feedback.failedGeneric': 'Export failed, please retry.',
  'feedback.degradedShort': 'Auto formatting failed; the original text is used.',
  'guide.siyuan-auth':
    'Copy the token from SiYuan Settings → Authentication → API token and put it in the plugin config, then retry.',
  'guide.siyuan-connect':
    'Make sure SiYuan is running and the port is reachable (default 127.0.0.1:6806), then retry.',
  'guide.siyuan-path':
    'The target path may have been deleted or is invalid; pick another place in the document tree.',
  'guide.llm-adapter': 'Check the available provider/model in the dsh model settings, then retry.',
  'toast.degraded': 'Exported to: {path} (auto formatting failed; the original text is used)',
  'toast.dismiss': 'Dismiss notification',
  'toast.failed': 'Export failed: {reason}',
  'toast.openSettings': 'Open settings',
  'toast.retry': 'Retry',
  'toast.succeeded': 'Exported to: {path}',
  'tree.loading': 'Loading…',
  'tree.retry': 'Retry',
  'tree.selected': 'Selected',
  'tree.loadError': 'Loading failed',
  'tree.expand': 'Expand',
  'tree.collapse': 'Collapse',
  'tree.empty': 'No notebook in SiYuan yet. Create one first.',
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

/**
 * 测试/降级用的同步 zh 翻译器。
 * 签名对齐官方 `TranslateNS<'siyuan-export'>`：键集 = 本 NS 键 ∪ 公共词表
 * （`LocaleKeysOf` 含 common 键如 `search`，不在本字典时回退显示 key）。
 */
export function zhT(
  key: LocaleKeysOf<'siyuan-export'>,
  params?: Record<string, unknown>,
): string {
  let text = (zh as Record<string, string>)[key] ?? String(key);
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
