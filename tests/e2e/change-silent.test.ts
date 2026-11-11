import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostLlmGateway, type LlmGateway } from '../../src/export/llm';
import { ExportService, type NoteWriter } from '../../src/export/export-service';
import { createNote, SiyuanClient, SiyuanError } from '../../src/siyuan/client';
import { PrefsStore } from '../../src/store/prefs';
import {
  SilentExportManager,
  silentTaskKey,
  type SilentClientLike,
  type SilentTaskView,
} from '../../client/src/silent-export';
import { ToastStore } from '../../client/src/toast-store';
import { startFakeLlm } from '../integration/fake-llm';
import { startFakeSiyuan, type FakeSiyuan } from '../integration/fake-siyuan';

/**
 * T063 · 隔离 Change E2E（quickstart V9–V11）：真实 Host `ExportService` + 真实
 * `PrefsStore` + 真实 `SiyuanClient`（对本地 fake 思源 HTTP）+ 真实 Client 单例 + 真实
 * ToastStore 走同一进程；按钮/对话/toast 的 DOM 表现已由 T061/T062 的 jsdom 单测覆盖。
 *
 * 抓得到：关闭开关后 open 分派 silent（不弹窗）、生成期间继续发起其他导出不被阻塞、
 *   切会话（无订阅者）后单例续跑并落 toast、3 条并发各 1 篇、重复点击不写第二篇、
 *   失败 toast 常驻并可重试且只落一篇、静默任务不写持久任务文件（V10d 的「无半成品」近似）。
 * 抓不到（按 quickstart 记为手工证据，不以本文件冒充）：
 *   真实浏览器计时与录屏（V9）、真实 dsh 关窗/重启（V10d）、真实模型与真实思源写入、
 *   侧栏入口与设置页渲染（V8 属 T056/quickstart 手工）。
 */

const CONTENT = '# 会话摘要\n这是需要导出的单次输出。';

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    dirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 最小 SilentClientLike：open 走真实 ExportService，轮询 service.state（等价 RPC 语义） */
function clientLikeFor(service: ExportService): SilentClientLike {
  return {
    open: (request) => service.open(request),
    pollUntilSettled: async (taskId, options) => {
      for (;;) {
        if (options?.isCurrent && !options.isCurrent(taskId)) return service.state(taskId);
        const state = await service.state(taskId);
        if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
          return state;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

async function setup(options: { gateway?: LlmGateway; wrapWriter?: (inner: NoteWriter) => NoteWriter } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'change-silent-e2e-'));
  dirs.push(dir);
  const prefs = new PrefsStore(dir);
  await prefs.update({ showDialog: false, defaultPath: null });

  const siyuan: FakeSiyuan = await startFakeSiyuan({ token: 'TK' });
  closers.push(siyuan.close);
  const client = new SiyuanClient({ endpoint: siyuan.endpoint, token: 'TK' });
  const innerWriter: NoteWriter = { write: (input) => createNote({ client, ...input }) };

  const llmCalls: string[] = [];
  const inner = options.gateway ?? createHostLlmGateway(startFakeLlm({}).llm);
  const service = new ExportService({
    source: {
      readOutput: async ({ messageId }) => ({
        content: `${CONTENT}\n${messageId}`,
        contentRevision: `rev-${messageId}`,
      }),
    },
    gateway: {
      generate: (input) => {
        llmCalls.push(input.content);
        return inner.generate(input);
      },
    },
    writer: options.wrapWriter ? options.wrapWriter(innerWriter) : innerWriter,
    prefs,
    targetIo: {
      listNotebooks: async () => [{ id: 'nb-default', name: '默认笔记本' }],
      getIdsByHPath: async () => [],
    },
  });

  const toasts = new ToastStore();
  const clientLike = clientLikeFor(service);
  const manager = new SilentExportManager({
    client: clientLike,
    onSettled: (view) => {
      toasts.push(
        view.status === 'succeeded'
          ? {
              kind: 'success',
              taskKey: view.key,
              title: view.title,
              target: view.target,
              href: view.href,
              degraded: view.degraded,
              error: null,
            }
          : {
              kind: 'failure',
              taskKey: view.key,
              title: view.title,
              target: view.target,
              href: null,
              degraded: false,
              error: view.error,
            },
      );
    },
  });

  return { service, prefs, siyuan, dir, manager, toasts, llmCalls, client: clientLike };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** 复刻 entry.tsx 的分派：silent 直接 track 单例，不打开弹窗 */
async function dispatch(h: Harness, messageId: string, sessionId: string): Promise<SilentTaskView> {
  const key = silentTaskKey(sessionId, messageId);
  const existing = h.manager.get(key);
  if (existing) {
    if (existing.status === 'failed') return h.manager.retry(key);
    return existing;
  }
  const opened = await h.client.open({ messageId, sessionId });
  if (opened.mode !== 'silent') throw new Error('期望静默模式响应（弹窗未打开）');
  return h.manager.track({ messageId, sessionId }, opened);
}

function createDocs(siyuan: FakeSiyuan) {
  return siyuan.requests.filter((request) => request.path === '/api/filetree/createDocWithMd');
}

describe('Change 静默链路隔离 E2E（V9–V11）', () => {
  it('V9：开关关闭 → 分派 silent 不弹窗；生成期间对话可继续；完成后 toast 显示落点', async () => {
    const gate = deferred<string>();
    const h = await setup({
      gateway: {
        generate: async ({ content }) =>
          content.includes('m1')
            ? gate.promise
            : JSON.stringify({ title: '并行', body: '## 小节\n- ✅ 并行' }),
      },
    });

    const started = await dispatch(h, 'm1', 's1');
    expect(started.status).toBe('generating');
    expect(started.target?.display).toBe('默认笔记本'); // 无默认路径 → 第一本未关闭笔记本根
    expect(h.siyuan.docs).toHaveLength(0);

    // 对话可继续：上一条仍在生成时继续发起另一条导出，立即返回且不被阻塞
    const other = await dispatch(h, 'm2', 's1');
    expect(other.status).toBe('generating');
    expect(h.manager.get('s1:m1')?.status).toBe('generating');

    await vi.waitFor(() => {
      expect(h.manager.get('s1:m2')?.status).toBe('succeeded');
    });
    gate.resolve(JSON.stringify({ title: '静默标题', body: '## 小节\n- ✅ 成功' }));
    await vi.waitFor(() => {
      expect(h.manager.get('s1:m1')?.status).toBe('succeeded');
    });

    const success = h.toasts.list().find((item) => item.taskKey === 's1:m1');
    expect(success?.kind).toBe('success');
    expect(success?.target?.display).toBe('默认笔记本');
    expect(h.siyuan.docs.map((doc) => doc.path).sort()).toEqual(['/并行', '/静默标题']);
  });

  it('V11：切会话（无订阅者）后单例续跑并出 toast，重挂载可恢复终态', async () => {
    const gate = deferred<string>();
    const h = await setup({ gateway: { generate: () => gate.promise } });

    const started = await dispatch(h, 'm1', 's1');
    const unsubscribe = h.manager.subscribe(() => undefined);
    unsubscribe(); // 切走面板/会话：无订阅者

    gate.resolve(JSON.stringify({ title: '跨会话', body: '## 小节\n- ✅ 跨会话' }));
    await vi.waitFor(() => {
      expect(h.manager.get('s1:m1')?.status).toBe('succeeded');
    });
    expect(h.toasts.list().some((item) => item.taskKey === started.key)).toBe(true);
    expect(h.manager.get(started.key)?.title).toBe('跨会话'); // 重挂载读单例即时恢复
  });

  it('V11：3 条并发各 1 篇；同一回复重复点击不再写第二篇', async () => {
    const h = await setup({
      gateway: {
        generate: async ({ content }) =>
          JSON.stringify({ title: content.split('\n').at(-1)!, body: '## 小节\n- ✅ 独立' }),
      },
    });
    const ids = ['m1', 'm2', 'm3'];
    await Promise.all(ids.map((id) => dispatch(h, id, 's1')));

    await vi.waitFor(() => {
      for (const id of ids) {
        expect(h.manager.get(`s1:${id}`)?.status).toBe('succeeded');
      }
    });
    expect(h.siyuan.docs.map((doc) => doc.path).sort()).toEqual(['/m1', '/m2', '/m3']);
    expect(createDocs(h.siyuan)).toHaveLength(3);
    expect(h.toasts.list()).toHaveLength(3);

    await dispatch(h, 'm1', 's1'); // 重复点击：命中已有成功任务
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.siyuan.docs).toHaveLength(3);
    expect(createDocs(h.siyuan)).toHaveLength(3);
  });

  it('V10：写入失败 → 失败 toast 常驻含原因；重试成功后只落一篇', async () => {
    let failures = 1;
    const h = await setup({
      wrapWriter: (inner) => ({
        write: async (input) => {
          if (failures > 0) {
            failures -= 1;
            throw new SiyuanError('siyuan-connect', '思源服务暂时不可用（HTTP 503），请稍后重试', true);
          }
          return inner.write(input);
        },
      }),
    });

    await dispatch(h, 'm1', 's1');
    await vi.waitFor(() => {
      expect(h.manager.get('s1:m1')?.status).toBe('failed');
    });
    const failure = h.toasts.list()[0];
    expect(failure?.kind).toBe('failure');
    expect(failure?.error?.category).toBe('siyuan-connect');
    expect(h.siyuan.docs).toHaveLength(0);

    await dispatch(h, 'm1', 's1'); // 失败任务重试（仍走静默通道）
    await vi.waitFor(() => {
      expect(h.manager.get('s1:m1')?.status).toBe('succeeded');
    });
    expect(h.siyuan.docs.map((doc) => doc.path)).toEqual(['/默认标题']);
    expect(h.llmCalls).toHaveLength(1); // 重试复用缓存 body，不重调模型

    // 重试复用同一幂等 taskId：新终态仍要通知，并替换旧失败提示（不堆叠）
    const toasts = h.toasts.list().filter((item) => item.taskKey === 's1:m1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('success');
    expect(toasts[0]?.target?.display).toBe('默认笔记本');
  });

  it('V10d（隔离近似）：静默任务不写持久任务文件，数据目录只有 prefs.json', async () => {
    const h = await setup();
    const opened = await dispatch(h, 'm1', 's1');
    await vi.waitFor(() => {
      expect(h.manager.get(opened.key)?.status).toBe('succeeded');
    });

    // 无半成品持久化：数据目录只有 prefs.json（真实关窗/重启为手工证据）
    // 成功状态先于 lastPath 回写可见，读写目录需等原子写完成（临时文件随即 rename）
    await vi.waitFor(async () => {
      expect((await readdir(h.dir)).sort()).toEqual(['prefs.json']);
    });
    expect(h.siyuan.docs).toHaveLength(1);

    // 同一数据目录新建 PrefsStore 读出偏好：任务状态未持久化，重启后没有可续写的半成品
    const restarted = new PrefsStore(h.dir);
    const state = await restarted.read();
    expect(state.showDialog).toBe(false);
    await vi.waitFor(async () => {
      expect((await readdir(h.dir)).sort()).toEqual(['prefs.json']);
    });
  });
});
