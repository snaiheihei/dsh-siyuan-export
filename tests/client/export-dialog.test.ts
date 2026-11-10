import { describe, expect, it, vi } from 'vitest';
import { en, zhT } from '../../client/src/locales';
import { ExportDialog } from '../../client/src/components/ExportDialog';
import type { StoragePath } from '../../src/contract';

/**
 * T025 · 导出弹窗（seam：props 注入 —— 标题/路径/状态/回调）
 * 抓到什么：标题输入框与占位提示、LLM 标题回填（用户已编辑则不覆盖）、
 *   ready 前「导出」禁用、成功反馈含落点、失败保留字段并显示「重试」、关闭时 cancel。
 * 抓不到什么：真实宿主渲染与轮询（归 T026）。
 * 红→绿：client/src/components/ExportDialog.tsx 尚不存在。
 */

type DialogProps = {
  status: string;
  title: string;
  target: StoragePath | null;
  lastPath: StoragePath | null;
  error: { category: string; message: string; retryable: boolean } | null;
  titleEdited: boolean;
  onTitleChange: (title: string) => void;
  onTargetChange: (target: StoragePath | null) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onClose: () => void;
};

const TARGET: StoragePath = {
  notebookId: 'nb',
  notebookName: '笔记本',
  parentSegments: ['父级'],
  display: '笔记本 / 父级',
};

function render(props: Partial<DialogProps> & { t?: typeof zhT } = {}): {
  element: { props: Record<string, unknown> };
  find: (predicate: (props: Record<string, unknown>) => boolean) => Record<string, unknown> | undefined;
} {
  const merged: DialogProps & { t: typeof zhT } = {
    status: 'ready',
    title: 'LLM 标题',
    target: TARGET,
    lastPath: TARGET,
    error: null,
    titleEdited: false,
    onTitleChange: () => {},
    onTargetChange: () => {},
    onSubmit: () => {},
    onRetry: () => {},
    onClose: () => {},
    t: zhT,
    ...props,
  };
  const element = ExportDialog(merged) as unknown as { type?: unknown; props: Record<string, unknown> };
  const children = flatten(element);
  return {
    element,
    find: (predicate) => children.find(predicate),
  };
}

/**
 * 深度展开 children 树（组件返回元素数组）。
 * JSX 编译后：元素对象的 `type` 是标签名，`props` 是属性 —— 两者都要保留。
 */
function flatten(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const element = node as { type?: unknown; props: Record<string, unknown> };
    // 元素标签名放最后（props.type 是 DOM 属性如 type="text"，不能覆盖标签名）
    out.push({ ...element.props, type: element.type });
    flatten(element.props.children, out);
  }
  return out;
}

/** 按 DOM 标签匹配（JSX 的 type 即标签名字符串） */
function byTag(tag: string): (props: Record<string, unknown>) => boolean {
  return (props) => props.type === tag;
}

/** 按 data-role 匹配 */
function byRole(role: string): (props: Record<string, unknown>) => boolean {
  return (props) => props['data-role'] === role;
}

describe('ExportDialog（T025）', () => {
  it('generating：标题占位提示，导出按钮禁用', () => {
    const { find } = render({ status: 'generating', title: '' });
    const input = find(byTag('input'));
    expect(input).toBeDefined();
    expect(String(input!.placeholder)).toContain('正在生成');
    const submit = find(byRole('submit'));
    expect(submit!.disabled).toBe(true);
  });

  it('ready：标题回填 LLM 值，用户已编辑时不覆盖', () => {
    const { find } = render({ status: 'ready', title: 'LLM 标题', titleEdited: false });
    const input = find(byTag('input'));
    expect(input!.value).toBe('LLM 标题');

    const edited = render({ status: 'ready', title: '用户改的', titleEdited: true });
    const editedInput = edited.find(byTag('input'));
    expect(editedInput!.value).toBe('用户改的');
  });

  it('ready：导出按钮可用，点击触发 onSubmit', () => {
    const onSubmit = vi.fn();
    const { find } = render({ onSubmit });
    const submit = find(byRole('submit'));
    expect(submit!.disabled).toBe(false);
    (submit!.onClick as () => void)();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('成功：显示落点反馈', () => {
    const { find } = render({ status: 'succeeded' });
    const feedback = find(byRole('feedback'));
    expect(String(feedback?.children)).toContain('已导出');
    expect(String(feedback?.children)).toContain(TARGET.display);
  });

  it('失败：显示原因 + 重试按钮，且标题字段保留', () => {
    const onRetry = vi.fn();
    const { find } = render({
      status: 'failed',
      error: { category: 'siyuan-connect', message: '无法连接思源服务', retryable: true },
      onRetry,
    });
    const feedback = find(byRole('feedback'));
    expect(String(feedback?.children)).toContain('无法连接思源服务');
    const retry = find(byRole('retry'));
    expect(retry).toBeDefined();
    (retry!.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);

    const input = find(byTag('input'));
    expect(input!.value).toBe('LLM 标题');
  });

  it('degraded-ready：提示已降级但仍可导出', () => {
    const { find } = render({
      status: 'degraded-ready',
      error: { category: 'llm-timeout', message: '模型调用超时', retryable: true },
    });
    const feedback = find(byRole('feedback'));
    expect(String(feedback?.children)).toContain('模型调用超时');
    const submit = find(byRole('submit'));
    expect(submit!.disabled).toBe(false);
  });

  it('关闭：触发 onClose', () => {
    const onClose = vi.fn();
    const { find } = render({ status: 'generating', onClose });
    const close = find(byRole('close'));
    (close!.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('四类错误的引导文案（T036）：auth/connect/path/llm-adapter 各有行动指引', () => {
    const cases: [string, RegExp][] = [
      ['siyuan-auth', /API token/],
      ['siyuan-connect', /思源已启动/],
      ['siyuan-path', /重新选择/],
      ['llm-adapter', /模型设置/],
    ];
    for (const [category, pattern] of cases) {
      const { find } = render({
        status: 'failed',
        error: { category, message: `原始消息-${category}`, retryable: true },
      });
      const feedback = find(byRole('feedback'));
      const text = String(feedback?.children);
      expect(text, category).toContain(`原始消息-${category}`);
      expect(text, category).toMatch(pattern);
    }
  });

  it('en 界面失败反馈不混排服务端中文（Top3-3：语言分流）', () => {
    const enT = ((key: Parameters<typeof zhT>[0], params?: Record<string, unknown>) => {
      let text = (en as Record<string, string>)[String(key)] ?? String(key);
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
      }
      return text;
    }) as typeof zhT;
    const { find } = render({
      status: 'failed',
      error: { category: 'siyuan-auth', message: '思源鉴权失败，请检查 Token', retryable: true },
      t: enT,
    });
    const text = String(find(byRole('feedback'))?.children);
    expect(text).toContain('Export failed');
    expect(text).toContain('API token'); // 英文 guide
    expect(text).not.toContain('鉴权'); // 服务端中文 message 不出现
    expect(text).not.toContain('Token，');
  });

  it('无目标路径时导出禁用', () => {
    const { find } = render({ target: null });
    const submit = find(byRole('submit'));
    expect(submit!.disabled).toBe(true);
  });
});
