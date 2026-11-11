import { describe, expect, it } from 'vitest';
import type {
  ExportOpenData,
  ExportOpenRequest,
  ExportSilentOpenData,
  ExportStateData,
  StoragePath,
} from '../../src/contract';
import {
  SilentExportManager,
  silentTaskKey,
  type SilentTaskView,
} from '../../client/src/silent-export';

/**
 * T060 · Client 静默任务单例（seam：SilentExportManager + fake ExportClient）
 * 抓到什么：按 `sessionId:messageId` 去重、轮询在组件卸载后继续、终态保留可恢复、
 *   同 messageId 跨会话互不覆盖、失败态不空转轮询、retry 仍发 intent:'silent'（并发只开一次）。
 * 抓不到什么：按钮运行态/弹窗分流（T061）、toast（T062）、真实 RPC 轮询实现（rpc-client 测试）。
 * 红→绿：client/src/silent-export.ts 尚不存在。
 */

const ROOT_TARGET: StoragePath = {
  notebookId: 'nb-default',
  notebookName: '默认笔记本',
  parentSegments: [],
  display: '默认笔记本',
};

function silentOpen(patch: Partial<ExportSilentOpenData> = {}): ExportSilentOpenData {
  return {
    mode: 'silent',
    taskId: 't1',
    status: 'generating',
    target: ROOT_TARGET,
    targetFrom: 'first-notebook',
    degraded: false,
    alreadyRunning: false,
    error: null,
    ...patch,
  };
}

interface PollCall {
  taskId: string;
  resolve: (state: ExportStateData) => void;
}

function fakeClient(): {
  client: {
    open: (request: ExportOpenRequest) => Promise<ExportOpenData>;
    pollUntilSettled: (taskId: string) => Promise<ExportStateData>;
  };
  openCalls: ExportOpenRequest[];
  polls: PollCall[];
  setNextOpen: (data: ExportOpenData | Promise<ExportOpenData>) => void;
  settle: (taskId: string, patch: Partial<ExportStateData>) => void;
} {
  const openCalls: ExportOpenRequest[] = [];
  const polls: PollCall[] = [];
  const pendingPolls = new Map<string, PollCall>();
  let nextOpen: ExportOpenData | Promise<ExportOpenData> | null = null;

  const client = {
    open: async (request: ExportOpenRequest): Promise<ExportOpenData> => {
      openCalls.push(request);
      const queued = nextOpen;
      nextOpen = null;
      if (queued) return queued;
      throw new Error('未预置 open 响应');
    },
    pollUntilSettled: (taskId: string): Promise<ExportStateData> =>
      new Promise<ExportStateData>((resolve) => {
        const call: PollCall = { taskId, resolve };
        pendingPolls.set(taskId, call);
        polls.push(call);
      }),
  };

  return {
    client,
    openCalls,
    polls,
    setNextOpen: (data) => {
      nextOpen = data;
    },
    settle: (taskId, patch) => {
      const call = pendingPolls.get(taskId);
      if (!call) throw new Error(`没有等待中的轮询：${taskId}`);
      pendingPolls.delete(taskId);
      call.resolve({
        mode: 'silent',
        status: 'succeeded',
        title: '默认标题',
        target: ROOT_TARGET,
        href: 'siyuan://blocks/doc-1',
        degraded: false,
        error: null,
        ...patch,
      });
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SilentExportManager（T060）', () => {
  it('track 启动轮询，终态保留在单例并可被订阅者观察', async () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });
    const updates: SilentTaskView[] = [];
    const off = manager.subscribe((view) => updates.push({ ...view }));

    const view = manager.track(
      { messageId: 'm1', sessionId: 's1' },
      silentOpen({ taskId: 't1' }),
    );
    expect(view.key).toBe(silentTaskKey('s1', 'm1'));
    expect(view.status).toBe('generating');
    expect(fake.polls).toHaveLength(1);
    expect(fake.polls[0]!.taskId).toBe('t1');

    fake.settle('t1', { status: 'succeeded', href: 'siyuan://blocks/doc-1' });
    await flush();
    const settled = manager.get('s1:m1');
    expect(settled?.status).toBe('succeeded');
    expect(settled?.href).toBe('siyuan://blocks/doc-1');
    expect(settled?.target).toEqual(ROOT_TARGET);
    expect(updates.at(-1)?.status).toBe('succeeded');
    off();
  });

  it('组件卸载（退订）不取消任务：重新挂载时从单例恢复加载态与终态', async () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });

    manager.track({ messageId: 'm1', sessionId: 's1' }, silentOpen({ taskId: 't1' }));
    const off = manager.subscribe(() => undefined);
    off(); // 卸载：退订不触发 cancel，轮询继续

    expect(manager.get('s1:m1')?.status).toBe('generating');

    fake.settle('t1', { status: 'succeeded', href: 'siyuan://blocks/doc-9' });
    await flush();

    // 再次挂载：无需重新 open 即可看到终态
    const restored = manager.get('s1:m1');
    expect(restored?.status).toBe('succeeded');
    expect(restored?.href).toBe('siyuan://blocks/doc-9');
    expect(fake.polls).toHaveLength(1);
  });

  it('同一 sessionId:messageId 重复 track 复用任务，不重启轮询', async () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });

    const first = manager.track({ messageId: 'm1', sessionId: 's1' }, silentOpen({ taskId: 't1' }));
    const second = manager.track({ messageId: 'm1', sessionId: 's1' }, silentOpen({ taskId: 't1' }));
    expect(second.taskId).toBe(first.taskId);
    expect(fake.polls).toHaveLength(1);

    fake.settle('t1', { status: 'succeeded' });
    await flush();

    const third = manager.track({ messageId: 'm1', sessionId: 's1' }, silentOpen({ taskId: 't9' }));
    expect(third.taskId).toBe('t1');
    expect(third.status).toBe('succeeded');
    expect(fake.polls).toHaveLength(1);
  });

  it('同 messageId 跨两个会话互不覆盖', async () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });

    manager.track({ messageId: 'm1', sessionId: 's1' }, silentOpen({ taskId: 't1' }));
    manager.track({ messageId: 'm1', sessionId: 's2' }, silentOpen({ taskId: 't2' }));
    expect(fake.polls.map((item) => item.taskId).sort()).toEqual(['t1', 't2']);

    fake.settle('t1', { status: 'succeeded', href: 'siyuan://blocks/a' });
    await flush();
    expect(manager.get('s1:m1')?.status).toBe('succeeded');
    expect(manager.get('s2:m1')?.status).toBe('generating');

    fake.settle('t2', {
      status: 'failed',
      href: null,
      error: { category: 'siyuan-connect', message: '思源服务暂时不可用', retryable: true },
    });
    await flush();
    const failed = manager.get('s2:m1');
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.retryable).toBe(true);
  });

  it('open 直接返回 failed 时不启动轮询', () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });

    const view = manager.track(
      { messageId: 'm1', sessionId: 's1' },
      silentOpen({
        taskId: 's1:m1:unavailable',
        status: 'failed',
        target: null,
        targetFrom: null,
        error: { category: 'siyuan-path', message: '思源路径已失效', retryable: false },
      }),
    );
    expect(view.status).toBe('failed');
    expect(view.error?.category).toBe('siyuan-path');
    expect(fake.polls).toHaveLength(0);
  });

  it('retry 发送 intent:silent 且并发只开一次；成功后跟踪新 taskId', async () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });

    manager.track(
      { messageId: 'm1', sessionId: 's1' },
      silentOpen({
        taskId: 's1:m1:unavailable',
        status: 'failed',
        target: null,
        targetFrom: null,
        error: { category: 'siyuan-connect', message: '连接失败', retryable: true },
      }),
    );

    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    fake.setNextOpen(
      gate.then(() => silentOpen({ taskId: 't2', status: 'writing' })),
    );

    const retryA = manager.retry('s1:m1');
    const retryB = manager.retry('s1:m1');
    expect(fake.openCalls).toHaveLength(1);
    expect(fake.openCalls[0]).toEqual({ messageId: 'm1', sessionId: 's1', intent: 'silent' });

    releaseOpen();
    const [a, b] = await Promise.all([retryA, retryB]);
    expect(a).toBe(b);
    expect(a.taskId).toBe('t2');
    expect(a.status).toBe('writing');
    expect(fake.polls.map((item) => item.taskId)).toEqual(['t2']);

    fake.settle('t2', { status: 'succeeded', href: 'siyuan://blocks/retry' });
    await flush();
    expect(manager.get('s1:m1')?.status).toBe('succeeded');
    expect(manager.get('s1:m1')?.href).toBe('siyuan://blocks/retry');
  });

  it('retry 对非失败任务直接返回现值，不再调用 open', async () => {
    const fake = fakeClient();
    const manager = new SilentExportManager({ client: fake.client });
    manager.track({ messageId: 'm1', sessionId: 's1' }, silentOpen({ taskId: 't1' }));

    const view = await manager.retry('s1:m1');
    expect(view.status).toBe('generating');
    expect(fake.openCalls).toHaveLength(0);
  });
});
