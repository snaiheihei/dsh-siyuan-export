import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RPC_NONCE_HEADER,
  RPC_NONCE_VALUE,
  RPC_PREFIX,
  type PrefsView,
  type RpcResult,
  type StoragePath,
} from '../../src/contract';
import { createPrefsHandlers } from '../../src/api/prefs-handlers';
import { createRpcRoute, type RpcHandlers } from '../../src/api/routes';
import { PREFS_VERSION, PrefsStore } from '../../src/store/prefs';
import type { TargetIo } from '../../src/siyuan/target';

/**
 * T056/T070 · 设置 Change 隔离 E2E（quickstart V12）：真实 `PrefsStore` +
 * `createPrefsHandlers` + `createRpcRoute` 走同一进程，数据目录为临时 DSH_HOME 下的
 * 插件目录（与 `src/index.ts` 的 `plugins/siyuan-export` 一致）。
 *
 * 抓得到：v1→v2 迁移、关闭弹窗经真实 RPC 落盘、新建 store 实例（模拟宿主重启）读回、
 *   损坏文件回退默认并保持可写、defaultPath 校验失败整次不落库、目录无临时残留。
 * 抓不到（按 quickstart 记为手工证据，不以本文件冒充）：
 *   真实 dsh 安装/侧栏入口/设置面板渲染与浏览器交互（V8/V12 手工）、真实思源与模型。
 */

const PATH: StoragePath = {
  notebookId: 'nb-1',
  notebookName: '工作',
  parentSegments: ['项目A'],
  display: '工作 / 项目A',
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function fakeReq(opts: { url: string; body?: string; headers?: Record<string, string> }): IncomingMessage {
  const body = opts.body ?? '{}';
  const stream = Readable.from([body]);
  return Object.assign(stream, {
    method: 'POST',
    url: opts.url,
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
    end: (chunk?: unknown) => {
      if (chunk !== undefined) chunks.push(String(chunk));
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => chunks.join('') };
}

interface Harness {
  /** 临时 DSH_HOME 下的插件数据目录 */
  dataDir: string;
  route: ReturnType<typeof createRpcRoute>;
  targetIo: TargetIo;
}

async function setup(options: { initialFile?: string; targetIo?: TargetIo } = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'change-settings-e2e-'));
  closers.push(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dataDir = join(home, 'plugins', 'siyuan-export');
  if (options.initialFile !== undefined) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'prefs.json'), options.initialFile, 'utf8');
  }

  const targetIo: TargetIo =
    options.targetIo ??
    ({
      listNotebooks: async () => [{ id: 'nb-1', name: '工作' }],
      getIdsByHPath: async () => ['doc-1'],
    } satisfies TargetIo);

  const prefs = new PrefsStore(dataDir);
  const prefsHandlers = createPrefsHandlers({ prefs, targetIo });
  const stub = async (): Promise<never> => {
    throw new Error('本用例不使用导出方法');
  };
  const handlers: RpcHandlers = {
    open: stub,
    state: stub,
    commit: stub,
    cancel: stub,
    treeList: stub,
    prefsGet: () => prefsHandlers.prefsGet(),
    prefsUpdate: (request) => prefsHandlers.prefsUpdate(request),
  };

  return { dataDir, route: createRpcRoute({ handlers }), targetIo };
}

async function call(
  harness: Harness,
  method: 'prefs.get' | 'prefs.update',
  body: unknown = {},
): Promise<RpcResult<PrefsView>> {
  const captured = fakeRes();
  await harness.route.handler(
    fakeReq({ url: `${RPC_PREFIX}/${method}`, body: JSON.stringify(body) }),
    captured.res,
  );
  expect(captured.status()).toBe(200);
  return JSON.parse(captured.body()) as RpcResult<PrefsView>;
}

function expectOk(result: RpcResult<PrefsView>): PrefsView {
  if (!result.ok) throw new Error(`期望 ok 信封，收到：${result.error.message}`);
  return result.data;
}

describe('Change 设置持久化隔离 E2E（V12）', () => {
  it('v1 迁移 → 关闭弹窗经 RPC 落盘 → 新实例（重启）读回', async () => {
    const h = await setup({
      initialFile: JSON.stringify({ version: 1, lastPath: PATH, draft: null }),
    });

    // v1 读取即迁移：补 defaultPath/showDialog，保留 lastPath
    expect(expectOk(await call(h, 'prefs.get'))).toEqual({
      showDialog: true,
      defaultPath: null,
      lastPath: PATH,
    });

    expect(expectOk(await call(h, 'prefs.update', { showDialog: false, defaultPath: PATH }))).toEqual({
      showDialog: false,
      defaultPath: PATH,
      lastPath: PATH,
    });

    const raw = JSON.parse(await readFile(join(h.dataDir, 'prefs.json'), 'utf8')) as {
      version: number;
      showDialog: boolean;
    };
    expect(raw.version).toBe(PREFS_VERSION);
    expect(raw.showDialog).toBe(false);
    // 原子写不残留临时文件
    expect((await readdir(h.dataDir)).sort()).toEqual(['prefs.json']);

    // 模拟宿主重启：同一数据目录新建 store 与 handlers
    const restarted = createPrefsHandlers({ prefs: new PrefsStore(h.dataDir), targetIo: h.targetIo });
    expect(await restarted.prefsGet()).toEqual({
      showDialog: false,
      defaultPath: PATH,
      lastPath: PATH,
    });
  });

  it('prefs.json 损坏 → 回退默认值并保持可写', async () => {
    const h = await setup({ initialFile: '{ not json' });

    expect(expectOk(await call(h, 'prefs.get'))).toEqual({
      showDialog: true,
      defaultPath: null,
      lastPath: null,
    });

    expect(expectOk(await call(h, 'prefs.update', { showDialog: false })).showDialog).toBe(false);
    expect(expectOk(await call(h, 'prefs.get')).showDialog).toBe(false);
  });

  it('defaultPath 无效 → siyuan-path 信封且整次更新不落库', async () => {
    const h = await setup({
      targetIo: { listNotebooks: async () => [], getIdsByHPath: async () => [] },
    });

    const result = await call(h, 'prefs.update', { showDialog: false, defaultPath: PATH });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe('siyuan-path');

    expect(expectOk(await call(h, 'prefs.get'))).toEqual({
      showDialog: true,
      defaultPath: null,
      lastPath: null,
    });
  });
});
