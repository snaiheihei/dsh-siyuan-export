import { describe, expect, it } from 'vitest';
import {
  RPC_NONCE_HEADER,
  RPC_NONCE_VALUE,
  RPC_PREFIX,
  type ExportOpenData,
  type RpcResult,
} from '../../src/contract';
import { createExportClient } from '../../client/src/rpc';

/**
 * T024 · Client RPC（seam：注入 fetchImpl —— 类型化同源请求 + 轮询控制）
 * 抓到什么：POST + 路径拼装 + nonce 头、ok:false → 抛带 category 的错误、
 *   轮询至终态即停、stale taskId 响应被丢弃、cancel 调用。
 * 抓不到什么：真实宿主路由（归 T026）、弹窗 UI 行为（T025）。
 * 红→绿：client/src/rpc.ts 尚无 createExportClient。
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: RpcResult<unknown>[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string>) };
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OPEN_DATA: ExportOpenData = {
  taskId: 't1',
  status: 'generating',
  title: null,
  lastPath: null,
  error: null,
};

describe('createExportClient（T024）', () => {
  it('open：POST 到 /plugins/siyuan-export/export.open，带 nonce 头与 JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch([{ ok: true, data: OPEN_DATA }]);
    const client = createExportClient({ fetchImpl });
    const data = await client.open({ messageId: 'm1', sessionId: 's1' });
    expect(data.taskId).toBe('t1');
    expect(calls[0]!.url).toBe(`${RPC_PREFIX}/export.open`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers[RPC_NONCE_HEADER]).toBe(RPC_NONCE_VALUE);
    expect(calls[0]!.body).toEqual({ messageId: 'm1', sessionId: 's1' });
  });

  it('ok:false → 抛错并保留 category/retryable（供 UI 分类展示）', async () => {
    const { fetchImpl } = fakeFetch([
      { ok: false, error: { category: 'siyuan-auth', message: '需要 Token', retryable: false } },
    ]);
    const client = createExportClient({ fetchImpl });
    await expect(client.open({ messageId: 'm', sessionId: 's' })).rejects.toMatchObject({
      category: 'siyuan-auth',
      retryable: false,
      message: '需要 Token',
    });
  });

  it('pollUntilSettled：轮询到终态即停（不再多打一次）', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { ok: true, data: { status: 'generating', title: null, error: null } },
      { ok: true, data: { status: 'ready', title: '标题', error: null } },
    ]);
    const client = createExportClient({ fetchImpl, pollIntervalMs: 1 });
    const state = await client.pollUntilSettled('t1');
    expect(state.status).toBe('ready');
    expect(state.title).toBe('标题');
    expect(calls).toHaveLength(2);
  });

  it('pollUntilSettled：stale taskId 的响应被丢弃（不覆盖当前任务）', async () => {
    const { fetchImpl } = fakeFetch([
      { ok: true, data: { status: 'ready', title: '旧的', error: null } },
    ]);
    const client = createExportClient({ fetchImpl, pollIntervalMs: 1 });
    const state = await client.pollUntilSettled('t2', { isCurrent: (id) => id === 't1' });
    expect(state.status).toBe('generating'); // 视为未就绪（stale 被忽略）
    expect(state.title).toBeNull();
  });

  it('commit / cancel 调用正确路径', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        ok: true,
        data: {
          status: 'succeeded',
          target: { notebookId: 'nb', notebookName: 'N', parentSegments: [], display: 'N' },
          href: 'siyuan://blocks/x',
        },
      },
      { ok: true, data: { status: 'cancelled' } },
    ]);
    const client = createExportClient({ fetchImpl });
    const result = await client.commit({
      taskId: 't1',
      title: 'T',
      target: { notebookId: 'nb', notebookName: 'N', parentSegments: [], display: 'N' },
    });
    expect(result.status).toBe('succeeded');
    expect(calls[0]!.url).toBe(`${RPC_PREFIX}/export.commit`);

    await client.cancel('t1');
    expect(calls[1]!.url).toBe(`${RPC_PREFIX}/export.cancel`);
  });

  it('transport 失败（非 JSON / 网络错）→ 归为 internal 可重试', async () => {
    const brokenFetch = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const client = createExportClient({ fetchImpl: brokenFetch });
    await expect(client.open({ messageId: 'm', sessionId: 's' })).rejects.toMatchObject({
      category: 'internal',
    });
  });
});
