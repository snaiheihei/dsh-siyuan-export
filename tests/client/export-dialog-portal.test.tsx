// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zhT } from '../../client/src/locales';
import { SiyuanExportAction } from '../../client/src/entry';
import type { ExportClient } from '../../client/src/rpc';

/**
 * 真实试用缺陷修复 · 弹窗 portal（seam：SiyuanExportAction + 注入式 clientFactory）
 * 抓到什么：弹窗 overlay 经 createPortal 直挂 document.body——
 *   `position:fixed` 不再受宿主消息行 transform 祖先影响（修复截图错位）。
 * 抓不到什么：真实宿主的 transform 环境（jsdom 无布局，仅验证挂载点）。
 * 红→绿：未 portal 时 overlay 的 parent 是 RTL container → 断言先红。
 */

afterEach(cleanup);

function fakeClient(): ExportClient {
  return {
    open: vi.fn(async () => ({
      taskId: 't1',
      status: 'ready',
      title: 'T',
      lastPath: null,
      error: null,
    })),
    state: vi.fn(async () => ({ status: 'ready', title: 'T', error: null })),
    commit: vi.fn(async () => ({
      status: 'succeeded' as const,
      target: { notebookId: 'nb', notebookName: 'N', parentSegments: [], display: 'N' },
      href: null,
    })),
    cancel: vi.fn(async () => ({ status: 'noop' as const })),
    treeList: vi.fn(async () => ({ nodes: [] })),
    pollUntilSettled: vi.fn(async () => ({ status: 'ready', title: 'T', error: null })),
  } as unknown as ExportClient;
}

describe('弹窗 portal（真实试用缺陷修复）', () => {
  it('点击导出后 overlay 直挂 document.body（fixed 不受宿主祖先影响）', async () => {
    const slotProps = {
      messageId: 'm1',
      sessionId: 's1',
      t: zhT,
      clientFactory: fakeClient,
    } as unknown as React.ComponentProps<typeof SiyuanExportAction>;
    render(<SiyuanExportAction {...slotProps} />);
    const button = await screen.findByRole('button', { name: '导出到思源' });
    fireEvent.click(button);

    const overlay = await waitFor(() => {
      const el = document.querySelector('[data-role="export-dialog-overlay"]');
      if (!el) throw new Error('overlay 未出现');
      return el as HTMLElement;
    });
    // portal 判据：overlay 的父节点必须是 body 本身（非 portal 时是 RTL 的 container div）
    expect(overlay.parentElement).toBe(document.body);
  });
});
