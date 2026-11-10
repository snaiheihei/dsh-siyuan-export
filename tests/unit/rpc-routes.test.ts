import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  RPC_NONCE_HEADER,
  RPC_NONCE_VALUE,
  RPC_PREFIX,
  type ExportCommitData,
  type ExportOpenData,
  type TreeListData,
} from '../../src/contract';
import { PluginError } from '../../src/errors';
import { createRpcRoute, dispatchRpc, type RpcHandlers } from '../../src/api/routes';

/**
 * T014 · RPC 路由骨架（seam A：`dispatchRpc` 纯分发；seam B：route handler 传输层 fake req/res）
 * 抓到什么：nonce 403、方法白名单 404、逐字段校验 400、统一信封、PluginError 分类保留、
 *   未知错误 internal 不泄漏、body 超限 413、非 POST 405、坏 JSON 400、空字符串参数语义。
 * 抓不到什么：真实 webServer 注册与端口（归隔离链路/T026）、handler 业务（T016+）。
 * 红→绿：src/api/routes.ts 尚不存在。
 */

function makeHandlers(): { handlers: RpcHandlers; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn(
    async (): Promise<ExportOpenData> => ({
      taskId: 't1',
      status: 'generating',
      title: null,
      lastPath: null,
      error: null,
    }),
  );
  const handlers: RpcHandlers = {
    open,
    state: vi.fn(async () => ({ status: 'ready' as const, title: 'T', error: null })),
    commit: vi.fn(
      async (): Promise<ExportCommitData> => ({
        status: 'succeeded',
        target: {
          notebookId: 'nb',
          notebookName: 'N',
          parentSegments: [],
          display: 'N',
        },
        href: null,
      }),
    ),
    cancel: vi.fn(async () => ({ status: 'noop' as const })),
    treeList: vi.fn(async (): Promise<TreeListData> => ({ nodes: [] })),
  };
  return { handlers, open };
}

const VALID_OPEN = { messageId: 'm1', sessionId: 's1' };

function nonceHeaders(extra: Record<string, string> = {}): Record<string, string | string[] | undefined> {
  return { [RPC_NONCE_HEADER]: RPC_NONCE_VALUE, ...extra };
}

function fakeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const body = opts.body ?? JSON.stringify(VALID_OPEN);
  const stream = Readable.from([body]);
  return Object.assign(stream, {
    method: opts.method ?? 'POST',
    url: opts.url ?? `${RPC_PREFIX}/export.open`,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      [RPC_NONCE_HEADER]: RPC_NONCE_VALUE,
      ...opts.headers,
    },
  }) as unknown as IncomingMessage;
}

interface Captured {
  res: ServerResponse;
  status: () => number;
  body: () => string;
}

function fakeRes(): Captured {
  const chunks: string[] = [];
  let status = 200;
  const res = {
    set statusCode(value: number) {
      status = value;
    },
    get statusCode() {
      return status;
    },
    setHeader: () => undefined,
    write: (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(String(chunk));
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => chunks.join('') };
}

describe('dispatchRpc（纯分发）', () => {
  it('合法请求 → 200 + ok:true 信封，body 原样交给 handler', async () => {
    const { handlers, open } = makeHandlers();
    const result = await dispatchRpc({ handlers }, 'export.open', VALID_OPEN, nonceHeaders());
    expect(result.status).toBe(200);
    expect(result.payload).toEqual({
      ok: true,
      data: { taskId: 't1', status: 'generating', title: null, lastPath: null, error: null },
    });
    expect(open).toHaveBeenCalledWith(VALID_OPEN);
  });

  it('缺 nonce → 403 信封', async () => {
    const { handlers } = makeHandlers();
    const result = await dispatchRpc({ handlers }, 'export.open', VALID_OPEN, {});
    expect(result.status).toBe(403);
    expect(result.payload.ok).toBe(false);
  });

  it('方法不在白名单 → 404', async () => {
    const { handlers } = makeHandlers();
    const result = await dispatchRpc({ handlers }, 'export.explode', {}, nonceHeaders());
    expect(result.status).toBe(404);
    expect(result.payload.ok).toBe(false);
  });

  it('逐字段校验：缺 messageId / 缺 taskId / commit 缺 target.notebookId → 400', async () => {
    const { handlers } = makeHandlers();
    const cases: [string, unknown][] = [
      ['export.open', { sessionId: 's' }],
      ['export.state', {}],
      ['export.commit', { taskId: 't', title: 'T' }],
      ['export.commit', { taskId: 't', title: 'T', target: { parentSegments: [] } }],
    ];
    for (const [method, body] of cases) {
      const result = await dispatchRpc({ handlers }, method, body, nonceHeaders());
      expect(result.status, `${method} ${JSON.stringify(body)}`).toBe(400);
      expect(result.payload.ok).toBe(false);
      if (!result.payload.ok) expect(result.payload.error.retryable).toBe(false);
    }
  });

  it("空字符串参数按『已提供』语义透传（不回退为未提供）", async () => {
    const { handlers } = makeHandlers();
    const treeList = handlers.treeList as ReturnType<typeof vi.fn>;
    const result = await dispatchRpc({ handlers }, 'tree.list', { notebookId: '' }, nonceHeaders());
    expect(result.status).toBe(200);
    expect(treeList).toHaveBeenCalledWith({ notebookId: '' });
  });

  it('handler 抛 PluginError → 200 + ok:false，category/retryable 保留', async () => {
    const { handlers } = makeHandlers();
    (handlers.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new PluginError('siyuan-auth', '思源鉴权失败', false),
    );
    const result = await dispatchRpc({ handlers }, 'export.open', VALID_OPEN, nonceHeaders());
    expect(result.status).toBe(200);
    expect(result.payload).toEqual({
      ok: false,
      error: { category: 'siyuan-auth', message: '思源鉴权失败', retryable: false },
    });
  });

  it('handler 抛未知错误 → 200 + internal，不泄漏消息/栈/路径', async () => {
    const { handlers } = makeHandlers();
    (handlers.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('secret stack at C:\\internal\\path.ts:12'),
    );
    const result = await dispatchRpc({ handlers }, 'export.open', VALID_OPEN, nonceHeaders());
    expect(result.status).toBe(200);
    if (result.payload.ok) throw new Error('expected failure envelope');
    expect(result.payload.error.category).toBe('internal');
    expect(result.payload.error.message).not.toContain('secret');
    expect(result.payload.error.message).not.toContain('path.ts');
  });
});

describe('createRpcRoute（传输层）', () => {
  it('POST 正常请求 → 200 JSON 响应', async () => {
    const { handlers } = makeHandlers();
    const route = createRpcRoute({ handlers });
    const captured = fakeRes();
    await route.handler(fakeReq({}), captured.res);
    expect(captured.status()).toBe(200);
    const payload = JSON.parse(captured.body()) as { ok: boolean };
    expect(payload.ok).toBe(true);
    expect(route.kind).toBe('prefix');
    expect(route.path).toBe(RPC_PREFIX);
  });

  it('GET → 405；坏 JSON → 400；缺 nonce → 403；未知方法 → 404', async () => {
    const { handlers } = makeHandlers();
    const route = createRpcRoute({ handlers });

    const cases: { req: IncomingMessage; expect: number }[] = [
      { req: fakeReq({ method: 'GET', body: '' }), expect: 405 },
      { req: fakeReq({ body: '{ bad json' }), expect: 400 },
      { req: fakeReq({ headers: { [RPC_NONCE_HEADER]: 'wrong' } }), expect: 403 },
      { req: fakeReq({ url: `${RPC_PREFIX}/nope` }), expect: 404 },
    ];
    for (const item of cases) {
      const captured = fakeRes();
      await route.handler(item.req, captured.res);
      expect(captured.status(), item.req.url).toBe(item.expect);
      const payload = JSON.parse(captured.body()) as { ok: boolean };
      expect(payload.ok).toBe(false);
    }
  });

  it('content-length 超限 → 413（读 body 之前拒绝）', async () => {
    const { handlers } = makeHandlers();
    const route = createRpcRoute({ handlers });
    const captured = fakeRes();
    const req = fakeReq({ headers: { 'content-length': String(2 * 1024 * 1024) } });
    await route.handler(req, captured.res);
    expect(captured.status()).toBe(413);
    const payload = JSON.parse(captured.body()) as { ok: boolean };
    expect(payload.ok).toBe(false);
  });
});
