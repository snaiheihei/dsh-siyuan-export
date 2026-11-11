// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zhT } from '../../client/src/locales';
import { ExportButton } from '../../client/src/components/ExportButton';
import { SiyuanExportAction } from '../../client/src/entry';
import type { ExportClient } from '../../client/src/rpc';
import { SilentExportManager } from '../../client/src/silent-export';
import type {
  ExportOpenData,
  ExportOpenRequest,
  ExportStateData,
} from '../../src/contract';

/**
 * T023 · 导出按钮组件（seam：props 注入 —— onExport 回调 + loading 态）
 * T061 · 静默分派（seam：SiyuanExportAction + 注入 clientFactory/silentFactory）
 * 抓到什么：渲染文案、点击触发 onExport(messageId)、loading 时禁用且不重复触发、
 *   aria-label 可访问；dialog 响应打开弹窗；silent 响应不弹窗、按钮进入运行态、
 *   重复点击不二次 open、卸载后由单例恢复运行态、终态恢复可用。
 * 抓不到什么：真实 slot 宿主渲染（归 T026）；toast（T062）。
 */

type ButtonProps = {
  messageId: string;
  loading?: boolean;
  onExport: (messageId: string) => void;
};

function renderButton(props: Partial<ButtonProps> = {}): {
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
  it('渲染 SVG 图标与 aria-label', () => {
    const { element } = renderButton();
    expect(element.type).toBe('button');
    expect(element.props['aria-label']).toBe('导出到思源');
    const icon = element.props.children as { type: string; props: Record<string, unknown> };
    expect(icon.type).toBe('svg');
    expect(icon.props['aria-hidden']).toBe('true');
  });

  it('点击触发 onExport 并带上 messageId', () => {
    const onExport = vi.fn();
    const { click } = renderButton({ messageId: 'msg-42', onExport });
    click();
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith('msg-42');
  });

  it('loading 时禁用且点击不再触发', () => {
    const onExport = vi.fn();
    const { element, click } = renderButton({ loading: true, onExport });
    expect(element.props.disabled).toBe(true);
    click();
    expect(onExport).not.toHaveBeenCalled();
  });
});

afterEach(cleanup);

const TARGET = {
  notebookId: 'nb',
  notebookName: 'N',
  parentSegments: [],
  display: 'N',
};

function dialogClient(): ExportClient {
  return {
    open: vi.fn(async () => ({
      mode: 'dialog' as const,
      taskId: 't1',
      status: 'ready' as const,
      title: 'T',
      lastPath: TARGET,
      defaultPath: null,
      error: null,
    })),
    state: vi.fn(async () => ({
      mode: 'dialog' as const,
      status: 'ready' as const,
      title: 'T',
      target: null,
      href: null,
      degraded: false,
      error: null,
    })),
    commit: vi.fn(async () => ({ status: 'succeeded' as const, target: TARGET, href: null })),
    cancel: vi.fn(async () => ({ status: 'noop' as const })),
    treeList: vi.fn(async () => ({ nodes: [] })),
    prefsGet: vi.fn(async () => ({ showDialog: true, defaultPath: null, lastPath: null })),
    prefsUpdate: vi.fn(async () => ({ showDialog: true, defaultPath: null, lastPath: null })),
    pollUntilSettled: vi.fn(async () => ({
      mode: 'dialog' as const,
      status: 'ready' as const,
      title: 'T',
      target: null,
      href: null,
      degraded: false,
      error: null,
    })),
  } as unknown as ExportClient;
}

interface SilentHarness {
  client: ExportClient;
  openCalls: ExportOpenRequest[];
  settle: (patch: Partial<ExportStateData>) => void;
  factory: () => SilentExportManager;
}

function silentHarness(opened: ExportOpenData): SilentHarness {
  const openCalls: ExportOpenRequest[] = [];
  let pending: ((state: ExportStateData) => void) | null = null;

  const client = {
    open: vi.fn(async (request: ExportOpenRequest) => {
      openCalls.push(request);
      return opened;
    }),
    state: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(async () => ({ status: 'noop' as const })),
    treeList: vi.fn(async () => ({ nodes: [] })),
    prefsGet: vi.fn(async () => ({ showDialog: false, defaultPath: null, lastPath: null })),
    prefsUpdate: vi.fn(async () => ({ showDialog: false, defaultPath: null, lastPath: null })),
    pollUntilSettled: vi.fn(
      () =>
        new Promise<ExportStateData>((resolve) => {
          pending = resolve;
        }),
    ),
  } as unknown as ExportClient;

  return {
    client,
    openCalls,
    settle: (patch) => {
      if (!pending) throw new Error('没有等待中的轮询');
      const resolve = pending;
      pending = null;
      resolve({
        mode: 'silent',
        status: 'succeeded',
        title: '默认标题',
        target: TARGET,
        href: 'siyuan://blocks/doc-1',
        degraded: false,
        error: null,
        ...patch,
      });
    },
    factory: () => new SilentExportManager({ client }),
  };
}

function silentOpened(patch: Partial<Extract<ExportOpenData, { mode: 'silent' }>> = {}): ExportOpenData {
  return {
    mode: 'silent',
    taskId: 't1',
    status: 'generating',
    target: TARGET,
    targetFrom: 'first-notebook',
    degraded: false,
    alreadyRunning: false,
    error: null,
    ...patch,
  };
}

function actionProps(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'm1',
    sessionId: 's1',
    t: zhT,
    ...overrides,
  } as unknown as React.ComponentProps<typeof SiyuanExportAction>;
}

const buttonName = '导出到思源';

async function button(): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', { name: buttonName })) as HTMLButtonElement;
}

describe('SiyuanExportAction 模式分派（T061）', () => {
  it('dialog 响应保持弹窗，不进入静默单例', async () => {
    const client = dialogClient();
    render(
      <SiyuanExportAction
        {...actionProps({ clientFactory: () => client, silentFactory: () => new SilentExportManager({ client }) })}
      />,
    );
    fireEvent.click(await button());
    await waitFor(() => {
      expect(document.querySelector('[data-role="export-dialog-overlay"]')).not.toBeNull();
    });
  });

  it('dialog 响应无上次路径时用设置默认路径预填落点（FR-006）', async () => {
    const DEFAULT_TARGET = {
      notebookId: 'nb-default',
      notebookName: '设置默认',
      parentSegments: [],
      display: '设置默认',
    };
    const client = {
      ...dialogClient(),
      open: vi.fn(async () => ({
        mode: 'dialog' as const,
        taskId: 't1',
        status: 'ready' as const,
        title: 'T',
        lastPath: null,
        defaultPath: DEFAULT_TARGET,
        error: null,
      })),
      treeList: vi.fn(async ({ notebookId }: { notebookId?: string }) => ({
        nodes: notebookId
          ? []
          : [
              {
                id: 'nb-first',
                name: '第一个笔记本',
                kind: 'notebook',
                notebookId: 'nb-first',
                hasChildren: true,
                path: ['第一个笔记本'],
              },
              {
                id: 'nb-default',
                name: '设置默认',
                kind: 'notebook',
                notebookId: 'nb-default',
                hasChildren: true,
                path: ['设置默认'],
              },
            ],
      })),
    } as unknown as ExportClient;

    render(
      <SiyuanExportAction
        {...actionProps({
          clientFactory: () => client,
          silentFactory: () => new SilentExportManager({ client }),
        })}
      />,
    );
    fireEvent.click(await button());

    const preferred = await screen.findByRole('treeitem', { name: /设置默认/ });
    await waitFor(() => expect(preferred.getAttribute('aria-selected')).toBe('true'));
    const first = screen.getByRole('treeitem', { name: /第一个笔记本/ });
    expect(first.getAttribute('aria-selected')).toBe('false');
  });

  it('silent 响应不弹窗：按钮进入运行态，重复点击不二次 open', async () => {
    const harness = silentHarness(silentOpened());
    render(
      <SiyuanExportAction
        {...actionProps({ clientFactory: () => harness.client, silentFactory: harness.factory })}
      />,
    );
    const el = await button();
    fireEvent.click(el);

    await waitFor(() => expect(el.disabled).toBe(true));
    expect(document.querySelector('[data-role="export-dialog-overlay"]')).toBeNull();

    fireEvent.click(el);
    expect(harness.openCalls).toHaveLength(1);
    expect(harness.openCalls[0]).toEqual({ messageId: 'm1', sessionId: 's1' });
  });

  it('silent 终态后按钮恢复可用', async () => {
    const harness = silentHarness(silentOpened());
    render(
      <SiyuanExportAction
        {...actionProps({ clientFactory: () => harness.client, silentFactory: harness.factory })}
      />,
    );
    const el = await button();
    fireEvent.click(el);
    await waitFor(() => expect(el.disabled).toBe(true));

    harness.settle({ status: 'succeeded' });
    await waitFor(() => expect(el.disabled).toBe(false));
  });

  it('卸载后重新挂载由单例恢复运行态', async () => {
    const harness = silentHarness(silentOpened());
    const props = actionProps({
      clientFactory: () => harness.client,
      silentFactory: harness.factory,
    });

    const first = render(<SiyuanExportAction {...props} />);
    fireEvent.click(await button());
    await waitFor(() => {
      expect((screen.getByRole('button', { name: buttonName }) as HTMLButtonElement).disabled).toBe(true);
    });
    first.unmount();

    render(<SiyuanExportAction {...props} />);
    const remounted = await button();
    await waitFor(() => expect(remounted.disabled).toBe(true));
    expect(harness.openCalls).toHaveLength(1);

    harness.settle({ status: 'succeeded' });
    await waitFor(() => expect(remounted.disabled).toBe(false));
  });
});
