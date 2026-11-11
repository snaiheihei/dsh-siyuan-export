// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, zh, zhT } from '../../client/src/locales';
import { ToastHost } from '../../client/src/components/ToastHost';
import { ToastStore, type ToastDraft } from '../../client/src/toast-store';

/**
 * T062 · 非阻塞 toast（seam：ToastStore + ToastHost，注入真实 store）
 * 抓得到：自动消失、失败常驻、重试/打开设置回调、栈上限淘汰、可访问属性、zh/en 键集一致。
 * 抓不到：真实宿主的 shell.overlay 层叠与视觉位置（quickstart 手工核验）。
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TARGET = {
  notebookId: 'nb',
  notebookName: 'N',
  parentSegments: [],
  display: 'N',
};

function draft(overrides: Partial<ToastDraft> = {}): ToastDraft {
  return {
    kind: 'success',
    taskKey: 's1:m1',
    title: 'T',
    target: TARGET,
    href: null,
    degraded: false,
    error: null,
    ...overrides,
  };
}

function renderHost(store: ToastStore, extra: Record<string, unknown> = {}) {
  return render(<ToastHost store={store} t={zhT} {...extra} />);
}

describe('ToastStore 队列', () => {
  it('成功 toast 约 6s 自动消失，失败常驻', () => {
    vi.useFakeTimers();
    const store = new ToastStore();
    renderHost(store);
    act(() => {
      store.push(draft());
      store.push(
        draft({
          kind: 'failure',
          taskKey: 's1:m2',
          error: { category: 'siyuan-connect', message: '连不上', retryable: true },
        }),
      );
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('栈上限 3：第四条淘汰最旧', () => {
    const store = new ToastStore();
    renderHost(store);
    act(() => {
      for (let i = 1; i <= 4; i += 1) {
        store.push(draft({ title: `T${i}`, target: { ...TARGET, display: `P${i}` } }));
      }
    });
    expect(store.list().map((item) => item.title)).toEqual(['T2', 'T3', 'T4']);
    expect(screen.getAllByRole('status')).toHaveLength(3);
    expect(screen.getByText(/P4/)).toBeTruthy();
    expect(screen.queryByText(/P1/)).toBeNull();
  });

  it('dismiss 单独清除且不影响其他项', () => {
    const store = new ToastStore();
    act(() => {
      store.push(draft({ title: 'A' }));
      store.push(draft({ title: 'B' }));
    });
    const first = store.list()[0];
    if (!first) throw new Error('expected a toast');
    act(() => store.dismiss(first.id));
    expect(store.list().map((item) => item.title)).toEqual(['B']);
  });
});

describe('ToastHost 表现与可访问性', () => {
  it('容器 aria-live=polite，成功 role=status 显示落点，失败 role=alert 显示原因', () => {
    const store = new ToastStore();
    renderHost(store);
    act(() => {
      store.push(draft());
      store.push(
        draft({
          kind: 'failure',
          taskKey: 's1:m2',
          error: { category: 'siyuan-path', message: '路径无效', retryable: false },
        }),
      );
    });
    const host = document.querySelector('[data-role="toast-host"]') as HTMLElement;
    expect(host.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').textContent).toContain('N');
    expect(screen.getByRole('alert').textContent).toContain('路径无效');
  });

  it('toast 卡片 pointer-events:auto（overlay 层本身 click-through）', () => {
    const store = new ToastStore();
    renderHost(store);
    act(() => store.push(draft()));
    const card = document.querySelector('[data-role="toast-success"]') as HTMLElement;
    expect(card.style.pointerEvents).toBe('auto');
  });

  it('降级成功说明未自动排版', () => {
    const store = new ToastStore();
    renderHost(store);
    act(() => store.push(draft({ degraded: true })));
    expect(screen.getByRole('status').textContent).toContain('未自动排版');
  });

  it('失败 toast 的「重试」与「打开设置」分别回调', () => {
    const store = new ToastStore();
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    renderHost(store, { onRetry, onOpenSettings });
    act(() =>
      store.push(
        draft({
          kind: 'failure',
          error: { category: 'siyuan-connect', message: '连不上', retryable: true },
        }),
      ),
    );

    fireEvent.click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]?.taskKey).toBe('s1:m1');

    fireEvent.click(screen.getByText('打开设置'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('成功 toast 不出现重试/打开设置按钮', () => {
    const store = new ToastStore();
    renderHost(store, { onRetry: vi.fn(), onOpenSettings: vi.fn() });
    act(() => store.push(draft()));
    expect(screen.queryByText('重试')).toBeNull();
    expect(screen.queryByText('打开设置')).toBeNull();
  });
});

describe('toast 文案键', () => {
  it('zh/en 键集一致且包含 toast.* 全部键', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const toastKeys = Object.keys(zh).filter((key) => key.startsWith('toast.'));
    expect(toastKeys).toEqual([
      'toast.degraded',
      'toast.dismiss',
      'toast.failed',
      'toast.openSettings',
      'toast.retry',
      'toast.succeeded',
    ]);
  });
});
