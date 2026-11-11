import { describe, expect, it } from 'vitest';
import type { StoragePath } from '../../src/contract';
import { SiyuanClient, SiyuanError } from '../../src/siyuan/client';
import {
  createTargetIo,
  resolveSilentTarget,
  validateTarget,
  type NotebookInfo,
  type TargetIo,
} from '../../src/siyuan/target';

/**
 * T050 · 静默落点解析与目标校验（seam：TargetIo 边界 + 真实 SiyuanClient 接线）
 * 抓到什么：default → last 根 → 首本未关闭笔记本 的优先级、默认路径失效不改道、
 *   无笔记本失败、validateTarget 的 notebook/父级校验、createTargetIo 的端点与参数。
 * 抓不到什么：真实思源行为（归 quickstart V8/V9）；写入本身（归 T011/T057）。
 * 红→绿：src/siyuan/target.ts 尚不存在。
 */

const PATH_WITH_PARENT: StoragePath = {
  notebookId: 'nb-1',
  notebookName: '工作',
  parentSegments: ['项目A'],
  display: '工作 / 项目A',
};

function fakeIo(overrides: Partial<TargetIo> & { notebooks?: NotebookInfo[] } = {}): {
  io: TargetIo;
  hpathCalls: { notebookId: string; hpath: string }[];
} {
  const hpathCalls: { notebookId: string; hpath: string }[] = [];
  const io: TargetIo = {
    listNotebooks: async () => overrides.notebooks ?? [{ id: 'nb-1', name: '工作' }],
    getIdsByHPath: async (notebookId, hpath) => {
      hpathCalls.push({ notebookId, hpath });
      return ['doc-1'];
    },
    ...overrides,
  };
  return { io, hpathCalls };
}

async function expectSiyuanError(p: Promise<unknown>): Promise<SiyuanError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SiyuanError);
    return err as SiyuanError;
  }
  throw new Error('expected SiyuanError, but resolved');
}

describe('validateTarget', () => {
  it('notebook 缺失或已关闭 → siyuan-path', async () => {
    const missing = await expectSiyuanError(
      validateTarget({ ...PATH_WITH_PARENT, notebookId: 'nb-missing' }, fakeIo().io),
    );
    expect(missing.category).toBe('siyuan-path');

    const closed = await expectSiyuanError(
      validateTarget(PATH_WITH_PARENT, fakeIo({ notebooks: [{ id: 'nb-1', name: '工作', closed: true }] }).io),
    );
    expect(closed.category).toBe('siyuan-path');
  });

  it('父级 hpath 无命中 → siyuan-path；命中则通过', async () => {
    const { io, hpathCalls } = fakeIo({
      getIdsByHPath: async () => {
        hpathCalls.push({ notebookId: 'nb-1', hpath: '/项目A' });
        return [];
      },
    });
    const err = await expectSiyuanError(validateTarget(PATH_WITH_PARENT, io));
    expect(err.category).toBe('siyuan-path');
    expect(hpathCalls).toEqual([{ notebookId: 'nb-1', hpath: '/项目A' }]);

    await expect(validateTarget(PATH_WITH_PARENT, fakeIo().io)).resolves.toBeUndefined();
  });
});

describe('resolveSilentTarget', () => {
  it('默认路径有效 → targetFrom=default，校验父级', async () => {
    const { io, hpathCalls } = fakeIo();
    const result = await resolveSilentTarget(
      { defaultPath: PATH_WITH_PARENT, lastPath: null },
      io,
    );
    expect(result).toEqual({ target: PATH_WITH_PARENT, targetFrom: 'default' });
    expect(hpathCalls).toEqual([{ notebookId: 'nb-1', hpath: '/项目A' }]);
  });

  it('默认路径存在但失效 → 直接失败，不回退到其他落点', async () => {
    const { io, hpathCalls } = fakeIo({
      notebooks: [
        { id: 'nb-1', name: '工作' },
        { id: 'nb-2', name: '备用' },
      ],
      getIdsByHPath: async (notebookId, hpath) => {
        hpathCalls.push({ notebookId, hpath });
        return [];
      },
    });
    const err = await expectSiyuanError(
      resolveSilentTarget({ defaultPath: PATH_WITH_PARENT, lastPath: null }, io),
    );
    expect(err.category).toBe('siyuan-path');
    expect(hpathCalls).toHaveLength(1); // 未尝试首本笔记本
  });

  it('无默认路径 → 上次成功记录所在笔记本的根', async () => {
    const { io, hpathCalls } = fakeIo({
      notebooks: [{ id: 'nb-9', name: '项目库' }],
    });
    const lastPath: StoragePath = {
      notebookId: 'nb-9',
      notebookName: '项目库',
      parentSegments: ['归档', '2025'],
      display: '项目库 / 归档 / 2025',
    };
    const result = await resolveSilentTarget({ defaultPath: null, lastPath }, io);
    expect(result.targetFrom).toBe('last');
    expect(result.target).toEqual({
      notebookId: 'nb-9',
      notebookName: '项目库',
      parentSegments: [],
      display: '项目库',
    });
    expect(hpathCalls).toEqual([]); // 根不需要父级校验
  });

  it('无默认路径且无成功记录 → 首本未关闭笔记本根', async () => {
    const { io } = fakeIo({
      notebooks: [
        { id: 'nb-closed', name: '已关闭', closed: true },
        { id: 'nb-open', name: '打开中' },
      ],
    });
    const result = await resolveSilentTarget({ defaultPath: null, lastPath: null }, io);
    expect(result.targetFrom).toBe('first-notebook');
    expect(result.target).toEqual({
      notebookId: 'nb-open',
      notebookName: '打开中',
      parentSegments: [],
      display: '打开中',
    });
  });

  it('没有任何可用笔记本 → siyuan-path', async () => {
    const { io } = fakeIo({ notebooks: [{ id: 'nb-closed', name: '已关闭', closed: true }] });
    const err = await expectSiyuanError(
      resolveSilentTarget({ defaultPath: null, lastPath: null }, io),
    );
    expect(err.category).toBe('siyuan-path');
  });
});

describe('createTargetIo', () => {
  it('lsNotebooks 解包 {notebooks}，getIDsByHPath 传 notebook+path', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const responses = [
      { code: 0, data: { notebooks: [{ id: 'nb-1', name: '工作' }] } },
      { code: 0, data: ['doc-1'] },
    ];
    let i = 0;
    const client = new SiyuanClient({
      endpoint: 'http://127.0.0.1:6806',
      token: 'TOKEN',
      backoffMs: 0,
      fetchImpl: (async (input: string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        const body = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    const io = createTargetIo(client);
    await expect(io.listNotebooks()).resolves.toEqual([{ id: 'nb-1', name: '工作' }]);
    await expect(io.getIdsByHPath('nb-1', '/项目A')).resolves.toEqual(['doc-1']);

    expect(calls[0]?.url).toContain('/api/notebook/lsNotebooks');
    expect(calls[1]?.url).toContain('/api/filetree/getIDsByHPath');
    expect(calls[1]?.body).toEqual({ notebook: 'nb-1', path: '/项目A' });
  });
});
