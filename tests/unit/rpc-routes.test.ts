import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { createPrefsHandlers } from '../../src/api/prefs-handlers';
import { PrefsStore } from '../../src/store/prefs';
import { SiyuanError } from '../../src/siyuan/client';
import type { TargetIo } from '../../src/siyuan/target';

/**
 * T014/T051 · RPC 路由骨架与 prefs 方法（seam A：`dispatchRpc` 纯分发；
 * seam B：route handler 传输层 fake req/res；seam C：prefs handlers + 真实 PrefsStore）
 * 抓到什么：nonce 403、方法白名单 404、逐字段校验 400、统一信封、PluginError 分类保留、
 *   未知错误 internal 不泄漏、body 超限 413、非 POST 405、坏 JSON 400、空字符串参数语义；
 *   7 方法白名单、prefs 默认值读取、definedPatch（undefined 不改/false/null 保留）、
 *   defaultPath 校验失败不落库。
 * 抓不到什么：真实 webServer 注册与端口（归隔离链路/T056/T063）、handler 业务（T016+）。
 */

function makeHandlers(): { handlers: RpcHandlers; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn(
    async (): Promise<ExportOpenData> => ({
      mode: 'dialog',
      taskId: 't1',
      status: 'generating',
      title: null,
      lastPath: null,
      defaultPath: null,
      error: null,
    }),
  );
  const handlers: RpcHandlers = {
    open,
    state: vi.fn(async () => ({
      mode: 'dialog' as const,
      status: 'ready' as const,
      title: 'T',
      target: null,
      href: null,
      degraded: false,
      error: null,
    })),
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
    prefsGet: vi.fn(async () => ({ showDialog: true, defaultPath: null, lastPath: null })),
    prefsUpdate: vi.fn(async () => ({ showDialog: true, defaultPath: null, lastPath: null })),
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
      data: {
        mode: 'dialog',
        taskId: 't1',
        status: 'generating',
        title: null,
        lastPath: null,
        defaultPath: null,
        error: null,
      },
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

  it('prefs.get / prefs.update 在白名单内，并逐字段校验', async () => {
    const { handlers } = makeHandlers();
    const get = await dispatchRpc({ handlers }, 'prefs.get', {}, nonceHeaders());
    expect(get.status).toBe(200);
    expect(get.payload.ok).toBe(true);

    const update = await dispatchRpc(
      { handlers },
      'prefs.update',
      { showDialog: false, defaultPath: null },
      nonceHeaders(),
    );
    expect(update.status).toBe(200);

    const invalid = [
      { showDialog: 'yes' },
      { defaultPath: 'nb-1' },
      { defaultPath: {} },
      { defaultPath: { notebookId: 'nb-1' } },
    ];
    for (const body of invalid) {
      const result = await dispatchRpc({ handlers }, 'prefs.update', body, nonceHeaders());
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
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

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('prefs handlers（Host 权威读写）', () => {
  const PATH_WITH_PARENT = {
    notebookId: 'nb-1',
    notebookName: '工作',
    parentSegments: ['项目A'],
    display: '工作 / 项目A',
  };

  function makeIo(overrides: Partial<TargetIo> = {}): TargetIo {
    return {
      listNotebooks: async () => [{ id: 'nb-1', name: '工作' }],
      getIdsByHPath: async () => ['doc-1'],
      ...overrides,
    };
  }

  async function setup(io: TargetIo = makeIo()): Promise<{
    store: PrefsStore;
    handlers: ReturnType<typeof createPrefsHandlers>;
  }> {
    tempDir = await mkdtemp(join(tmpdir(), 'siyuan-rpc-prefs-'));
    const store = new PrefsStore(tempDir);
    return { store, handlers: createPrefsHandlers({ prefs: store, targetIo: io }) };
  }

  it('缺失文件 → 默认值；undefined 不修改，false/null 显式保留', async () => {
    const { handlers } = await setup();
    await expect(handlers.prefsGet()).resolves.toEqual({
      showDialog: true,
      defaultPath: null,
      lastPath: null,
    });

    await handlers.prefsUpdate({ showDialog: false, defaultPath: PATH_WITH_PARENT });
    // undefined = 不修改
    await handlers.prefsUpdate({ showDialog: undefined, defaultPath: undefined });
    await expect(handlers.prefsGet()).resolves.toEqual({
      showDialog: false,
      defaultPath: PATH_WITH_PARENT,
      lastPath: null,
    });

    await handlers.prefsUpdate({ defaultPath: null });
    const view = await handlers.prefsGet();
    expect(view.defaultPath).toBeNull();
    expect(view.showDialog).toBe(false);

    const raw = JSON.parse(await readFile(join(tempDir as string, 'prefs.json'), 'utf8')) as {
      showDialog: boolean;
      defaultPath: unknown;
    };
    expect(raw.showDialog).toBe(false);
    expect(raw.defaultPath).toBeNull();
  });

  it('defaultPath 校验失败 → siyuan-path，且不落库', async () => {
    const { store, handlers } = await setup(makeIo({ listNotebooks: async () => [] }));
    let caught: unknown;
    try {
      await handlers.prefsUpdate({ showDialog: false, defaultPath: PATH_WITH_PARENT });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SiyuanError);
    expect((caught as SiyuanError).category).toBe('siyuan-path');

    const stored = await store.read();
    expect(stored.defaultPath).toBeNull();
    expect(stored.showDialog).toBe(true); // 校验失败时整次更新不落库
  });
});
