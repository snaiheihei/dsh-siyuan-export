import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_NONCE_HEADER, RPC_NONCE_VALUE, type ExportOpenData, type StoragePath } from '../../src/contract';
import { dispatchRpc } from '../../src/api/routes';
import { ExportService } from '../../src/export/export-service';
import type { LlmGateway } from '../../src/export/llm';
import { SiyuanError } from '../../src/siyuan/client';
import { PrefsStore } from '../../src/store/prefs';
import type { NotebookInfo, TargetIo } from '../../src/siyuan/target';

/**
 * T057 · Host 模式分派与静默联合响应（seam：ExportService.open/state/commit/cancel + dispatchRpc）
 * 抓到什么：auto 读 Prefs.showDialog、silent 恒静默、静默响应字段（target/targetFrom/degraded/
 *   alreadyRunning）且不含弹窗字段；静默业务失败以 ok:true + status:'failed' 返回（empty-source /
 *   siyuan-path / siyuan-connect）；state 增补 mode/target/href/degraded；commit 拒绝静默任务、
 *   cancel 对静默任务 noop；intent 非法在路由层 400。
 * 抓不到什么：后台自动写入与并发编排（T058/T059）、真实思源与浏览器（T063）。
 * 红→绿：contract/ExportService 尚无 mode 分派与静默字段。
 */

const CONTENT = '# 标题行\n正文内容';

const DEFAULT_PATH: StoragePath = {
  notebookId: 'nb-1',
  notebookName: '工作',
  parentSegments: [],
  display: '工作',
};

const LAST_PATH: StoragePath = {
  notebookId: 'nb-2',
  notebookName: '归档',
  parentSegments: [],
  display: '归档',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface SilentHarness {
  service: ExportService;
  prefs: PrefsStore;
  gatewayCalls: () => number;
  writerCalls: number;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeTargetIo(options: {
  notebooks?: NotebookInfo[];
  fail?: Error;
} = {}): TargetIo & { listCalls: number } {
  const io = {
    listCalls: 0,
    async listNotebooks(): Promise<NotebookInfo[]> {
      io.listCalls += 1;
      if (options.fail) throw options.fail;
      return options.notebooks ?? [
        { id: 'nb-1', name: '工作' },
        { id: 'nb-2', name: '归档' },
        { id: 'nb-closed', name: '已关闭', closed: true },
      ];
    },
    async getIdsByHPath(): Promise<string[]> {
      return [];
    },
  };
  return io;
}

async function makeHarness(
  options: {
    showDialog?: boolean;
    defaultPath?: StoragePath | null;
    lastPath?: StoragePath | null;
    content?: string;
    gateway?: LlmGateway;
    targetIo?: TargetIo;
  } = {},
): Promise<SilentHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'export-silent-'));
  dirs.push(dir);
  const prefs = new PrefsStore(dir);
  await prefs.update({
    showDialog: options.showDialog ?? true,
    defaultPath: options.defaultPath ?? null,
    lastPath: options.lastPath ?? null,
  });

  const gate = deferred<string>();
  const gateway: LlmGateway = options.gateway ?? { generate: () => gate.promise };
  let gatewayCount = 0;
  let writerCount = 0;

  const service = new ExportService({
    source: {
      readOutput: async () => ({
        content: options.content ?? CONTENT,
        contentRevision: 'rev-1',
      }),
    },
    gateway: {
      generate: (input) => {
        gatewayCount += 1;
        return gateway.generate(input);
      },
    },
    writer: {
      write: async () => {
        writerCount += 1;
        return { id: `doc-${writerCount}`, hpath: '/x' };
      },
    },
    prefs,
    targetIo: options.targetIo ?? fakeTargetIo(options.defaultPath
      ? { notebooks: [{ id: 'nb-1', name: '工作' }, { id: 'nb-2', name: '归档' }] }
      : undefined),
  });

  return {
    service,
    prefs,
    gatewayCalls: () => gatewayCount,
    get writerCalls() {
      return writerCount;
    },
  };
}

function asRecord(data: ExportOpenData): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

describe('ExportService 模式分派（T057）', () => {
  it('auto + showDialog=true → dialog 响应（含 lastPath/defaultPath，不含静默字段）', async () => {
    const h = await makeHarness({ showDialog: true, lastPath: LAST_PATH, defaultPath: DEFAULT_PATH });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('dialog');
    if (opened.mode !== 'dialog') throw new Error('mode 判定错误');
    expect(opened.status).toBe('generating');
    expect(opened.lastPath).toEqual(LAST_PATH);
    expect(opened.defaultPath).toEqual(DEFAULT_PATH);
    const raw = asRecord(opened);
    expect(raw.target).toBeUndefined();
    expect(raw.targetFrom).toBeUndefined();
    expect(raw.alreadyRunning).toBeUndefined();
  });

  it('auto + showDialog=false → silent（落点=默认路径，targetFrom=default）', async () => {
    const h = await makeHarness({ showDialog: false, defaultPath: DEFAULT_PATH });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('silent');
    if (opened.mode !== 'silent') throw new Error('mode 判定错误');
    expect(opened.status).toBe('generating');
    expect(opened.target).toEqual(DEFAULT_PATH);
    expect(opened.targetFrom).toBe('default');
    expect(opened.degraded).toBe(false);
    expect(opened.alreadyRunning).toBe(false);
    expect(opened.error).toBeNull();
    const raw = asRecord(opened);
    expect(raw.lastPath).toBeUndefined();
    expect(raw.defaultPath).toBeUndefined();
  });

  it("intent='silent' 覆盖 showDialog=true；未配置默认路径时退到 lastPath", async () => {
    const h = await makeHarness({ showDialog: true, lastPath: LAST_PATH });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1', intent: 'silent' });
    expect(opened.mode).toBe('silent');
    if (opened.mode !== 'silent') throw new Error('mode 判定错误');
    expect(opened.target).toEqual(LAST_PATH);
    expect(opened.targetFrom).toBe('last');
  });

  it('静默默认路径失效 → status:failed（siyuan-path，不可重试），不调 LLM、不建任务', async () => {
    const h = await makeHarness({
      showDialog: false,
      defaultPath: { ...DEFAULT_PATH, notebookId: 'nb-deleted' },
    });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('silent');
    if (opened.mode !== 'silent') throw new Error('mode 判定错误');
    expect(opened.status).toBe('failed');
    expect(opened.target).toBeNull();
    expect(opened.targetFrom).toBeNull();
    expect(opened.error?.category).toBe('siyuan-path');
    expect(opened.error?.retryable).toBe(false);
    expect(h.gatewayCalls()).toBe(0);
    await expect(h.service.state(opened.taskId)).rejects.toMatchObject({ category: 'internal' });
  });

  it('思源连接失败 → status:failed（siyuan-connect，可重试）', async () => {
    const h = await makeHarness({
      showDialog: false,
      targetIo: fakeTargetIo({
        fail: new SiyuanError('siyuan-connect', '无法连接思源服务，请确认思源正在运行', true),
      }),
    });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('silent');
    if (opened.mode !== 'silent') throw new Error('mode 判定错误');
    expect(opened.status).toBe('failed');
    expect(opened.error?.category).toBe('siyuan-connect');
    expect(opened.error?.retryable).toBe(true);
  });

  it('空源 → 静默 failed（empty-source），不调 LLM', async () => {
    const h = await makeHarness({ showDialog: false, content: '   \n' });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('silent');
    if (opened.mode !== 'silent') throw new Error('mode 判定错误');
    expect(opened.status).toBe('failed');
    expect(opened.error?.category).toBe('empty-source');
    expect(h.gatewayCalls()).toBe(0);
  });

  it('lastPath 指向已关闭笔记本 → 落首本未关闭笔记本（targetFrom=first-notebook）', async () => {
    const h = await makeHarness({
      showDialog: false,
      lastPath: { ...LAST_PATH, notebookId: 'nb-closed' },
    });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('silent');
    if (opened.mode !== 'silent') throw new Error('mode 判定错误');
    expect(opened.targetFrom).toBe('first-notebook');
    expect(opened.target?.notebookId).toBe('nb-1');
  });

  it('state 增补 mode/target/href/degraded；dialog 与 silent 各自正确', async () => {
    const silent = await makeHarness({ showDialog: false, defaultPath: DEFAULT_PATH });
    const silentOpen = await silent.service.open({ messageId: 'm1', sessionId: 's1' });
    const silentState = await silent.service.state(silentOpen.taskId);
    expect(silentState.mode).toBe('silent');
    expect(silentState.target).toEqual(DEFAULT_PATH);
    expect(silentState.href).toBeNull();
    expect(silentState.degraded).toBe(false);

    const dialog = await makeHarness({ showDialog: true });
    const dialogOpen = await dialog.service.open({ messageId: 'm1', sessionId: 's1' });
    expect((await dialog.service.state(dialogOpen.taskId)).mode).toBe('dialog');
  });

  it('commit 拒绝静默任务；cancel 对静默任务返回 noop', async () => {
    const h = await makeHarness({ showDialog: false, defaultPath: DEFAULT_PATH });
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    await expect(
      h.service.commit({ taskId: opened.taskId, title: 'T', target: DEFAULT_PATH }),
    ).rejects.toMatchObject({ category: 'internal', retryable: false });
    expect((await h.service.cancel(opened.taskId)).status).toBe('noop');
    expect(h.writerCalls).toBe(0);
  });

  it('路由层拒绝非法 intent（400），静默业务失败仍为 ok:true 数据', async () => {
    const h = await makeHarness({
      showDialog: false,
      defaultPath: { ...DEFAULT_PATH, notebookId: 'nb-deleted' },
    });
    const handlers = {
      open: (request: { messageId: string; sessionId: string; intent?: 'auto' | 'silent' }) =>
        h.service.open(request),
      state: (request: { taskId: string }) => h.service.state(request.taskId),
      commit: async () => {
        throw new Error('not used');
      },
      cancel: (request: { taskId: string }) => h.service.cancel(request.taskId),
      treeList: async () => ({ nodes: [] }),
      prefsGet: async () => ({ showDialog: false, defaultPath: null, lastPath: null }),
      prefsUpdate: async () => ({ showDialog: false, defaultPath: null, lastPath: null }),
    };
    const headers = { [RPC_NONCE_HEADER]: RPC_NONCE_VALUE };

    const invalid = await dispatchRpc({ handlers }, 'export.open', {
      messageId: 'm1',
      sessionId: 's1',
      intent: 'dial',
    }, headers);
    expect(invalid.status).toBe(400);

    const failed = await dispatchRpc({ handlers }, 'export.open', {
      messageId: 'm1',
      sessionId: 's1',
      intent: 'silent',
    }, headers);
    expect(failed.status).toBe(200);
    expect(failed.payload.ok).toBe(true);
    if (failed.payload.ok) {
      expect((failed.payload.data as { status: string }).status).toBe('failed');
    }
  });
});
