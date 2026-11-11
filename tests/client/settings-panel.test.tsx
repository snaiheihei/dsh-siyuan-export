// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrefsUpdateRequest, PrefsView, StoragePath, TreeNode } from '../../src/contract';
import { ClientRpcError, type ExportClient } from '../../client/src/rpc';
import { en, zh, zhT } from '../../client/src/locales';
import { SettingsPanel } from '../../client/src/components/SettingsPanel';

// vitest 未开 globals，RTL 不自动 cleanup —— 手动清理避免跨测试 DOM 残留
afterEach(cleanup);

/**
 * T053 · 设置面板（seam：注入 fake client 的 prefs.get / prefs.update / tree.list）
 * 抓到什么：开关默认开启、修改即保存（无全局保存按钮）、保存中禁用、
 *   失败回滚 Host 值并就地报错、路径仅经思源树选择/清除、zh/en 键集一致。
 * 抓不到什么：真实宿主侧栏/tab 渲染（T056 隔离 E2E 与 quickstart 手工核验）、
 *   真实思源树数据（T055/T056）。
 * 红→绿：client/src/components/SettingsPanel.tsx 尚不存在。
 */

const PATH: StoragePath = {
  notebookId: 'nb-1',
  notebookName: '工作',
  parentSegments: ['项目A'],
  display: '工作 / 项目A',
};

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
  hasChildren: false,
  path: ['项目A'],
};

type PanelClient = Pick<ExportClient, 'prefsGet' | 'prefsUpdate' | 'treeList'>;

interface FakePanel {
  client: PanelClient;
  prefsGet: ReturnType<typeof vi.fn>;
  prefsUpdate: ReturnType<typeof vi.fn>;
  treeList: ReturnType<typeof vi.fn>;
  view: () => PrefsView;
}

function makePanelClient(initial: PrefsView): FakePanel {
  let view: PrefsView = { ...initial };
  const prefsGet = vi.fn(async (): Promise<PrefsView> => ({ ...view }));
  const prefsUpdate = vi.fn(async (patch: PrefsUpdateRequest): Promise<PrefsView> => {
    if (patch.showDialog !== undefined) view = { ...view, showDialog: patch.showDialog };
    if (patch.defaultPath !== undefined) view = { ...view, defaultPath: patch.defaultPath };
    return { ...view };
  });
  const treeList = vi.fn(async (request: { notebookId?: string; docId?: string }) => ({
    nodes: request.notebookId ? [ROOT_DOC] : [NOTEBOOK],
  }));
  return {
    client: { prefsGet, prefsUpdate, treeList } as unknown as PanelClient,
    prefsGet,
    prefsUpdate,
    treeList,
    view: () => view,
  };
}

function setup(initial: PrefsView = { showDialog: true, defaultPath: null, lastPath: null }) {
  const fake = makePanelClient(initial);
  render(<SettingsPanel t={zhT} clientFactory={() => fake.client} />);
  return fake;
}

const switchEl = (): HTMLElement =>
  screen.getByRole('switch', { name: /导出时显示弹窗/ });

describe('SettingsPanel（T053）', () => {
  it('默认值：开关开启、未配置默认路径显示未选择，且不接受本机路径输入', async () => {
    const fake = setup();
    await waitFor(() => expect(fake.prefsGet).toHaveBeenCalledTimes(1));
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByText('未选择')).toBeTruthy();
    // 摘要条先回答“导出会怎样”：弹窗确认、默认落点、上次成功落点
    expect(screen.getByText('导出方式')).toBeTruthy();
    expect(screen.getByText('弹窗确认')).toBeTruthy();
    expect(screen.getByText('上次成功落点')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    // 路径只能从思源树选择：面板内没有自由文本输入框
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('静默模式：摘要条显示静默导出与上次落点（T053/T061）', async () => {
    setup({ showDialog: false, defaultPath: null, lastPath: PATH });
    expect(await screen.findByText('静默导出')).toBeTruthy();
    expect(screen.getByText('上次成功落点')).toBeTruthy();
    expect(screen.getByText('工作 / 项目A')).toBeTruthy();
  });

  it('修改开关即保存（无全局保存按钮），保存中禁用，成功后落到已保存值', async () => {
    const fake = setup();
    await screen.findByRole('switch', { name: /导出时显示弹窗/ });

    let resolveUpdate: ((view: PrefsView) => void) | null = null;
    fake.prefsUpdate.mockImplementationOnce(
      (patch: PrefsUpdateRequest) =>
        new Promise<PrefsView>((resolve) => {
          resolveUpdate = () => resolve({ ...fake.view(), ...patch });
        }),
    );

    fireEvent.click(switchEl());
    await waitFor(() =>
      expect(fake.prefsUpdate).toHaveBeenCalledWith({ showDialog: false }),
    );
    expect((switchEl() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull();

    resolveUpdate!({ showDialog: false, defaultPath: null, lastPath: null });
    await waitFor(() => expect((switchEl() as HTMLButtonElement).disabled).toBe(false));
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
  });

  it('保存失败 → 回滚 Host 值并就地报错', async () => {
    const fake = setup();
    await screen.findByRole('switch', { name: /导出时显示弹窗/ });
    fake.prefsUpdate.mockRejectedValueOnce(
      new ClientRpcError('internal', '无法连接宿主服务', true),
    );

    fireEvent.click(switchEl());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无法连接宿主服务');
    // 回滚到 Host 的已保存值（开启）
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(fake.view().showDialog).toBe(true);
  });

  it('经思源树选择默认路径 → 即调 prefs.update 保存所选 StoragePath', async () => {
    const fake = setup();
    await screen.findByText('未选择');

    fireEvent.click(screen.getByRole('button', { name: /选择路径/ }));
    fireEvent.click(await screen.findByText('工作'));
    expect(await screen.findByText('项目A')).toBeTruthy();
    fireEvent.click(screen.getByText('项目A'));

    await waitFor(() =>
      expect(fake.prefsUpdate).toHaveBeenLastCalledWith({ defaultPath: PATH }),
    );
    expect(screen.getByText('工作 / 项目A')).toBeTruthy();
  });

  it('清除默认路径 → 保存 null 并回到未选择', async () => {
    const fake = setup({ showDialog: true, defaultPath: PATH, lastPath: null });
    expect(await screen.findByText('工作 / 项目A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /清除/ }));
    await waitFor(() =>
      expect(fake.prefsUpdate).toHaveBeenCalledWith({ defaultPath: null }),
    );
    expect(await screen.findByText('未选择')).toBeTruthy();
  });

  it('prefs.get 失败 → 显示加载错误与重试，重试后恢复（T055）', async () => {
    const fake = makePanelClient({ showDialog: true, defaultPath: PATH, lastPath: null });
    fake.prefsGet.mockRejectedValueOnce(new ClientRpcError('internal', '宿主不可用', true));
    render(<SettingsPanel t={zhT} clientFactory={() => fake.client} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('宿主不可用');

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(await screen.findByText('工作 / 项目A')).toBeTruthy();
  });

  it('思源不可用 → 路径区显示原因与重试，已保存路径保留，开关独立可保存（T055）', async () => {
    const fake = makePanelClient({ showDialog: true, defaultPath: PATH, lastPath: null });
    fake.treeList.mockRejectedValueOnce(
      new ClientRpcError('siyuan-connect', '无法连接思源服务', true),
    );
    render(<SettingsPanel t={zhT} clientFactory={() => fake.client} />);
    expect(await screen.findByText('工作 / 项目A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /选择路径/ }));
    expect(await screen.findByText(/无法连接思源服务/)).toBeTruthy();
    // 已保存路径不被清空
    expect(screen.getByText('工作 / 项目A')).toBeTruthy();

    // 开关仍可独立修改
    fake.prefsUpdate.mockClear();
    fireEvent.click(switchEl());
    await waitFor(() =>
      expect(fake.prefsUpdate).toHaveBeenCalledWith({ showDialog: false }),
    );

    // 重试恢复树数据
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(await screen.findByText('工作')).toBeTruthy();
  });

  it('思源无笔记本 → 空态提示而非崩溃（T055）', async () => {
    const fake = setup();
    fake.treeList.mockResolvedValueOnce({ nodes: [] });
    await screen.findByText('未选择');

    fireEvent.click(screen.getByRole('button', { name: /选择路径/ }));
    expect(await screen.findByText(/还没有笔记本/)).toBeTruthy();
  });

  it('设置文案 zh/en 键集一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
});
