// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoragePath, TreeNode } from '../../src/contract';
import { zhT } from '../../client/src/locales';
import { DocTree } from '../../client/src/components/DocTree';

// vitest 未开 globals，RTL 不自动 cleanup —— 手动清理避免跨测试 DOM 残留
afterEach(cleanup);

/**
 * T031/T032 · 文档树选择器（seam：onLoadRoot / onLoadChildren / onSelected 注入）
 * 抓到什么：根层懒加载、展开按层加载、选中产出 StoragePath（display 由 path 拼接）、
 *   失败就地显示原因+重试、initialPath 默认展开选中（T032）、stale 响应丢弃。
 * 抓不到什么：真实思源返回（T033 隔离 E2E）。
 * 红→绿：client/src/components/DocTree.tsx 尚不存在。
 */

const NOTEBOOK: TreeNode = {
  id: 'nb-1',
  name: '工作',
  kind: 'notebook',
  notebookId: 'nb-1',
  hasChildren: true,
  path: [],
};

const ROOT_DOC: TreeNode = {
  id: 'doc-1',
  name: '项目A',
  kind: 'doc',
  notebookId: 'nb-1',
  hasChildren: true,
  path: ['项目A'],
};

const CHILD_DOC: TreeNode = {
  id: 'doc-2',
  name: '子文档',
  kind: 'doc',
  notebookId: 'nb-1',
  hasChildren: false,
  path: ['项目A', '子文档'],
};

interface Props {
  initialPath?: StoragePath | null;
  selected?: StoragePath | null;
  onLoadRoot?: () => Promise<TreeNode[]>;
  onLoadChildren?: (notebookId: string, docId: string) => Promise<TreeNode[]>;
  onSelected?: (target: StoragePath) => void;
  t?: typeof zhT;
}

function setup(props: Props = {}) {
  const onLoadRoot = props.onLoadRoot ?? vi.fn(async () => [NOTEBOOK]);
  const onLoadChildren =
    props.onLoadChildren ??
    vi.fn(async (_notebookId: string, docId: string) => (docId === '' ? [ROOT_DOC] : [CHILD_DOC]));
  const onSelected = props.onSelected ?? vi.fn();
  render(
    <DocTree
      initialPath={props.initialPath ?? null}
      selected={props.selected ?? null}
      t={props.t ?? zhT}
      onLoadRoot={onLoadRoot}
      onLoadChildren={onLoadChildren}
      onSelected={onSelected}
    />,
  );
  return { onLoadRoot, onLoadChildren, onSelected };
}

describe('DocTree（T031/T032）', () => {
  it('初始加载根层（笔记本列表）', async () => {
    const { onLoadRoot } = setup();
    await waitFor(() => expect(onLoadRoot).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('工作')).toBeTruthy();
  });

  it('展开笔记本 → 按层加载子文档', async () => {
    const { onLoadChildren } = setup();
    fireEvent.click(await screen.findByText('工作'));
    await waitFor(() => expect(onLoadChildren).toHaveBeenCalledWith('nb-1', ''));
    expect(await screen.findByText('项目A')).toBeTruthy();
  });

  it('展开后可折叠，再次展开复用缓存不重复加载', async () => {
    const { onLoadChildren } = setup();
    fireEvent.click(await screen.findByText('工作'));
    expect(await screen.findByText('项目A')).toBeTruthy();

    const toggle = () =>
      (screen.getByText('工作').closest('[role="treeitem"]') as HTMLElement).querySelector(
        '[data-role="tree-toggle"]',
      ) as HTMLButtonElement;

    fireEvent.click(toggle());
    expect(screen.queryByText('项目A')).toBeNull();
    expect(onLoadChildren).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle());
    expect(await screen.findByText('项目A')).toBeTruthy();
    expect(onLoadChildren).toHaveBeenCalledTimes(1);
  });

  it('折叠不改变已选目标', async () => {
    const { onSelected } = setup();
    fireEvent.click(await screen.findByText('工作'));
    await screen.findByText('项目A');
    const callsAfterSelect = (onSelected as ReturnType<typeof vi.fn>).mock.calls.length;

    const toggle = (screen.getByText('工作').closest('[role="treeitem"]') as HTMLElement).querySelector(
      '[data-role="tree-toggle"]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(onSelected).toHaveBeenCalledTimes(callsAfterSelect);
  });

  it('选中节点 → onSelected 收到 StoragePath（display 由 path 拼接）', async () => {
    const { onSelected } = setup();
    fireEvent.click(await screen.findByText('工作'));
    const doc = await screen.findByText('项目A');
    fireEvent.click(doc);
    expect(onSelected).toHaveBeenCalledWith({
      notebookId: 'nb-1',
      notebookName: '工作',
      parentSegments: ['项目A'],
      display: '工作 / 项目A',
    } satisfies StoragePath);
  });

  it('加载失败 → 显示原因并可重试', async () => {
    let fail = true;
    const onLoadChildren = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error('无法连接思源服务');
      }
      return [ROOT_DOC];
    });
    setup({ onLoadChildren });
    fireEvent.click(await screen.findByText('工作'));
    expect(await screen.findByText(/无法连接思源服务/)).toBeTruthy();
    const retry = await screen.findByRole('button', { name: /重试/ });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('项目A')).toBeTruthy());
  });

  it('加载失败的兜底文案来自 locale 字典 t()（T043，不硬编码）', async () => {
    const called: string[] = [];
    const spyT = ((key: Parameters<typeof zhT>[0], params?: Record<string, unknown>) => {
      called.push(String(key));
      return zhT(key, params);
    }) as typeof zhT;
    let fail = true;
    const onLoadRoot = vi.fn(async () => {
      if (fail) {
        fail = false;
        // 非 Error 值 → 走 t('tree.loadError') 兜底分支
        return Promise.reject('boom-not-an-error');
      }
      return [NOTEBOOK];
    });
    setup({ onLoadRoot, t: spyT });
    expect(await screen.findByText('加载失败')).toBeTruthy();
    expect(called).toContain('tree.loadError');
    // 重试成功
    const retry = await screen.findByRole('button', { name: /重试/ });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('工作')).toBeTruthy());
  });

  it('initialPath 匹配 → 默认展开该层级并标记选中（T032）', async () => {
    const initialPath: StoragePath = {
      notebookId: 'nb-1',
      notebookName: '工作',
      parentSegments: ['项目A'],
      display: '工作 / 项目A',
    };
    const { onSelected } = setup({ initialPath });
    // 自动展开到匹配层
    expect(await screen.findByText('项目A')).toBeTruthy();
    expect(await screen.findByText('已选中')).toBeTruthy();
    // 自动回填选中位置（供弹窗 target 使用）
    expect(onSelected).toHaveBeenCalledWith(initialPath);
  });

  it('stale 响应丢弃：慢的旧请求不覆盖新状态', async () => {
    let resolveSlow: ((nodes: TreeNode[]) => void) | null = null;
    const slow = new Promise<TreeNode[]>((resolve) => {
      resolveSlow = resolve;
    });
    const onLoadChildren = vi.fn((notebookId: string) => {
      if (notebookId === 'nb-slow') return slow as Promise<TreeNode[]>;
      return Promise.resolve([{ ...ROOT_DOC, id: 'fast', name: '快速文档' }]);
    });
    render(
      <DocTree
        initialPath={null}
        selected={null}
        t={zhT}
        onLoadRoot={async () => [{ ...NOTEBOOK, id: 'nb-slow', name: '慢本' }, { ...NOTEBOOK, id: 'nb-fast', name: '快本' }]}
        onLoadChildren={onLoadChildren}
        onSelected={() => undefined}
      />,
    );
    const slowBook = await screen.findByText('慢本');
    const fastBook = await screen.findByText('快本');
    fireEvent.click(slowBook);
    fireEvent.click(fastBook);
    expect(await screen.findByText('快速文档')).toBeTruthy();
    // 慢响应晚到，不应覆盖快速文档
    resolveSlow!([{ ...ROOT_DOC, id: 'late', name: '迟到文档' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText('迟到文档')).toBeNull();
  });
});
