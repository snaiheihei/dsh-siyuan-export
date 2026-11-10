import { describe, expect, it, vi } from 'vitest';
import { zhT } from '../../client/src/locales';
import { ExportButton } from '../../client/src/components/ExportButton';

/**
 * T023 · 导出按钮组件（seam：props 注入 —— onExport 回调 + loading 态）
 * 抓到什么：渲染文案、点击触发 onExport(messageId)、loading 时禁用且不重复触发、
 *   aria-label 可访问。
 * 抓不到什么：真实 slot 宿主渲染（归 T026）。
 * 红→绿：client/src/components/ExportButton.tsx 尚不存在。
 */

type ButtonProps = {
  messageId: string;
  loading?: boolean;
  onExport: (messageId: string) => void;
};

function render(props: Partial<ButtonProps> = {}): {
  element: { type: string; props: Record<string, unknown> };
  click: () => void;
} {
  const merged: ButtonProps & { t: typeof zhT } = {
    messageId: 'm1',
    loading: false,
    onExport: () => {},
    t: zhT,
    ...props,
  };
  const element = ExportButton(merged) as unknown as {
    type: string;
    props: Record<string, unknown>;
  };
  return {
    element,
    click: () => {
      const onClick = element.props.onClick as (() => void) | undefined;
      onClick?.();
    },
  };
}

describe('ExportButton（T023）', () => {
  it('渲染「导出到思源」文案与 aria-label', () => {
    const { element } = render();
    expect(element.type).toBe('button');
    expect(element.props.children).toBe('导出到思源');
    expect(element.props['aria-label']).toBe('导出到思源');
  });

  it('点击触发 onExport 并带上 messageId', () => {
    const onExport = vi.fn();
    const { click } = render({ messageId: 'msg-42', onExport });
    click();
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith('msg-42');
  });

  it('loading 时禁用且不重复触发', () => {
    const onExport = vi.fn();
    const { element, click } = render({ loading: true, onExport });
    expect(element.props.disabled).toBe(true);
    click();
    expect(onExport).not.toHaveBeenCalled();
  });
});
