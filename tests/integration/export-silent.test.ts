import { mkdtemp, readdir, rename as fsRename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoragePath } from '../../src/contract';
import { createHostLlmGateway, type LlmGateway } from '../../src/export/llm';
import {
  ExportService,
  type NoteWriter,
  type NoteWriterInput,
} from '../../src/export/export-service';
import { SiyuanClient, SiyuanError, createNote } from '../../src/siyuan/client';
import { PrefsStore } from '../../src/store/prefs';
import { startFakeLlm } from './fake-llm';
import { startFakeSiyuan, type FakeSiyuan } from './fake-siyuan';

/**
 * T058/T059 · 静默后台编排与失败边界（seam：真实 ExportService + 真实 SiyuanClient + 真实 PrefsStore）
 * 抓到什么：open 立即返回、后台「生成 → 自动写入」、同键不启第二条流水线（alreadyRunning）、
 *   writing 门闩只写一篇、不同 messageId 并发各成一篇、静默任务不落任务文件；
 *   失败保留原因/retryable 且不改道、重试复用缓存 body、降级仍写入。
 * 抓不到什么：真实思源/真实模型/真实浏览器（T063）、Client 单例与 toast（T060–T062）。
 */

const CONTENT = '# 会话摘要\n这是需要导出的单次输出。';

const ROOT_TARGET: StoragePath = {
  notebookId: 'nb-default',
  notebookName: '默认笔记本',
  parentSegments: [],
  display: '默认笔记本',
};

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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function createDocs(siyuan: FakeSiyuan) {
  return siyuan.requests.filter((r) => r.path === '/api/filetree/createDocWithMd');
}

async function setup(options: {
  gateway?: LlmGateway;
  wrapWriter?: (inner: NoteWriter) => NoteWriter;
  content?: (messageId: string) => string;
  defaultPath?: StoragePath | null;
  /** 思源笔记本列表（fake 与 targetIo 共用；默认只有 nb-default） */
  notebooks?: { id: string; name: string }[];
  /** 注入慢 rename：让「状态先于原子写完成可见」的竞态稳定复现（T073） */
  prefsRenameDelayMs?: number;
} = {}): Promise<{
  service: ExportService;
  prefs: PrefsStore;
  siyuan: FakeSiyuan;
  dir: string;
  createDocs: () => ReturnType<typeof createDocs>;
  llmCalls: string[];
  /** 最近一次 lastPath 回写的 Promise（T073：等待写盘完成，而不是轮询读同一个文件） */
  prefsWrites: { lastPath: Promise<unknown> | null };
}> {
  const dir = await mkdtemp(join(tmpdir(), 'export-silent-flow-'));
  // Windows：lastPath 回写可能在断言后仍在途，删除临时目录用重试避免 ENOTEMPTY
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const prefs = new PrefsStore(
    dir,
    options.prefsRenameDelayMs
      ? {
          ops: {
            rename: async (from, to) => {
              await new Promise((resolve) => setTimeout(resolve, options.prefsRenameDelayMs));
              await fsRename(from, to);
            },
          },
        }
      : {},
  );
  const prefsWrites = { lastPath: null as Promise<unknown> | null };
  const rawUpdate = prefs.update.bind(prefs);
  prefs.update = (patch) => {
    const pending = rawUpdate(patch);
    if (patch.lastPath !== undefined) prefsWrites.lastPath = pending;
    return pending;
  };
  await prefs.update({ showDialog: false, defaultPath: options.defaultPath ?? null });

  const notebooks = options.notebooks ?? [{ id: 'nb-default', name: '默认笔记本' }];
  const siyuan = await startFakeSiyuan({ token: 'TK', notebooks });
  cleanups.push(siyuan.close);
  const client = new SiyuanClient({ endpoint: siyuan.endpoint, token: 'TK' });

  const llmCalls: string[] = [];
  const inner: LlmGateway = options.gateway ?? createHostLlmGateway(startFakeLlm({}).llm);
  const gateway: LlmGateway = {
    generate: (input) => {
      llmCalls.push(input.content);
      return inner.generate(input);
    },
  };

  const innerWriter: NoteWriter = { write: (input) => createNote({ client, ...input }) };
  const writer = options.wrapWriter ? options.wrapWriter(innerWriter) : innerWriter;

  const service = new ExportService({
    source: {
      readOutput: async ({ messageId }) => ({
        content: options.content?.(messageId) ?? CONTENT,
        contentRevision: `rev-${messageId}`,
      }),
    },
    gateway,
    writer,
    prefs,
    targetIo: {
      listNotebooks: async () => notebooks,
      getIdsByHPath: async () => [],
    },
  });

  return {
    service,
    prefs,
    siyuan,
    dir,
    createDocs: () => createDocs(siyuan),
    llmCalls,
    prefsWrites,
  };
}

function expectSilent(opened: Awaited<ReturnType<ExportService['open']>>) {
  expect(opened.mode).toBe('silent');
  if (opened.mode !== 'silent') throw new Error('期望静默模式响应');
  return opened;
}

describe('静默后台编排（T058）', () => {
  it('open 立即返回，后台自动「生成 → 写入」，无需 commit', async () => {
    const h = await setup();
    const opened = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));

    // 立即返回：尚未写盘，状态为 generating
    expect(opened.status).toBe('generating');
    expect(opened.target).toEqual(ROOT_TARGET);
    expect(opened.targetFrom).toBe('first-notebook');
    expect(opened.alreadyRunning).toBe(false);
    expect(h.siyuan.docs).toHaveLength(0);

    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('succeeded');
    });

    const state = await h.service.state(opened.taskId);
    expect(state.mode).toBe('silent');
    expect(state.title).toBe('默认标题');
    expect(state.href).toMatch(/^siyuan:\/\/blocks\//);
    expect(state.degraded).toBe(false);

    expect(h.siyuan.docs).toHaveLength(1);
    expect(h.siyuan.docs[0]!.path).toBe('/默认标题');
    const writes = h.createDocs();
    expect(writes).toHaveLength(1);
    expect(String(writes[0]!.body.markdown)).toContain('## 小节');
    expect(h.llmCalls).toHaveLength(1);

    // 落点回写 lastPath（FR-006）；succeeded 先于回写完成，故等那次 update 落盘后再断言。
    // 不轮询 prefs.read()：Windows 下 readFile 与原子 rename 并发会让 rename 持续 EPERM（T073）。
    await vi.waitFor(() => {
      expect(h.prefsWrites.lastPath).not.toBeNull();
    });
    await h.prefsWrites.lastPath;
    expect((await h.prefs.read()).lastPath).toEqual(ROOT_TARGET);
  });

  it('冷启动并发同键 open → 只建一条流水线、只调一次 LLM、只写一篇', async () => {
    const gate = deferred<string>();
    const h = await setup({ gateway: { generate: () => gate.promise } });

    const opened = await Promise.all([
      h.service.open({ messageId: 'm1', sessionId: 's1' }),
      h.service.open({ messageId: 'm1', sessionId: 's1' }),
    ]);
    const first = opened[0]!;
    if (first.mode !== 'silent') throw new Error('期望静默模式响应');
    for (const item of opened) expect(item.mode).toBe('silent');
    expect(h.llmCalls).toHaveLength(1);
    expect(opened.filter((item) => item.mode === 'silent' && item.alreadyRunning)).toHaveLength(1);

    gate.resolve(JSON.stringify({ title: '并发标题', body: '## 小节\n- ✅ 一份' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });
    expect(h.createDocs()).toHaveLength(1);
  });

  it('同键重复 open：alreadyRunning=true，只调一次 LLM、只写一篇', async () => {
    const gate = deferred<string>();
    const h = await setup({ gateway: { generate: () => gate.promise } });

    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(first.alreadyRunning).toBe(false);

    const second = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(second.taskId).toBe(first.taskId);
    expect(second.status).toBe('generating');
    expect(second.alreadyRunning).toBe(true);
    expect(h.llmCalls).toHaveLength(1);

    gate.resolve(JSON.stringify({ title: '同键标题', body: '## 小节\n- ✅ 一份' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });

    const after = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(after.status).toBe('succeeded');
    expect(after.alreadyRunning).toBe(false);
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
    expect(h.siyuan.docs).toHaveLength(1);
  });

  it('writing 门闩：写入进行中同键 open → alreadyRunning=true，不产生第二次写入', async () => {
    const gate = deferred<void>();
    const writeCalls: NoteWriterInput[] = [];
    const h = await setup({
      wrapWriter: (inner) => ({
        write: async (input) => {
          writeCalls.push(input);
          await gate.promise;
          return inner.write(input);
        },
      }),
    });

    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('writing');
    });

    const second = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(second.status).toBe('writing');
    expect(second.alreadyRunning).toBe(true);
    expect(writeCalls).toHaveLength(1);

    gate.resolve();
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });
    expect(writeCalls).toHaveLength(1);
    expect(h.siyuan.docs).toHaveLength(1);
  });

  it('不同 messageId 并发：三条回复各自独立成文', async () => {
    const h = await setup({
      content: (messageId) => `# 回复\n正文 ${messageId}`,
      gateway: {
        generate: async ({ content }) =>
          JSON.stringify({ title: content.split('\n')[1]!, body: '## 小节\n- ✅ 独立' }),
      },
    });

    const ids = ['m1', 'm2', 'm3'];
    const opened = await Promise.all(
      ids.map((messageId) => h.service.open({ messageId, sessionId: 's1' })),
    );
    expect(opened.map((item) => expectSilent(item).status)).toEqual([
      'generating',
      'generating',
      'generating',
    ]);

    await vi.waitFor(async () => {
      for (const item of opened) {
        expect((await h.service.state(expectSilent(item).taskId)).status).toBe('succeeded');
      }
    });

    expect(h.siyuan.docs.map((doc) => doc.path).sort()).toEqual([
      '/正文 m1',
      '/正文 m2',
      '/正文 m3',
    ]);
    expect(h.createDocs()).toHaveLength(3);
    expect(h.llmCalls).toHaveLength(3);
  });

  it('静默任务不写持久化任务文件：数据目录只有 prefs.json', async () => {
    const h = await setup({ prefsRenameDelayMs: 80 });
    const opened = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('succeeded');
    });

    // succeeded 先于 lastPath 回写可见；原子写的临时文件随即 rename。
    // 断言等待目录收敛（慢 rename 注入下，立即读会稳定读到 .tmp-*）
    await vi.waitFor(async () => {
      expect((await readdir(h.dir)).sort()).toEqual(['prefs.json']);
    });
  });
});

describe('跨模式同键导出（T075）', () => {
  it('静默已 succeeded 后重新打开弹窗开关 → 同键 open 沿用静默任务，不重置状态、不再写一篇', async () => {
    const h = await setup();
    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });
    await vi.waitFor(() => {
      expect(h.prefsWrites.lastPath).not.toBeNull();
    });
    await h.prefsWrites.lastPath;

    await h.prefs.update({ showDialog: true });

    // 主按钮走 auto：偏好已改为弹窗，但同键任务的 mode 在创建时固定（FR-025 / US5/AC2）
    const reopened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(reopened.mode).toBe('silent');
    if (reopened.mode !== 'silent') throw new Error('期望沿用既有静默任务');
    expect(reopened.taskId).toBe(first.taskId);
    expect(reopened.status).toBe('succeeded');
    expect(reopened.alreadyRunning).toBe(false);
    expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    expect(h.createDocs()).toHaveLength(1);
    expect(h.siyuan.docs).toHaveLength(1);
  });
});

describe('跨模式同键导出（T076）', () => {
  type Harness = Awaited<ReturnType<typeof setup>>;

  async function openDialog(h: Harness) {
    const opened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.mode).toBe('dialog');
    if (opened.mode !== 'dialog') throw new Error('期望弹窗模式响应');
    return opened;
  }

  async function waitReady(h: Harness, taskId: string) {
    await vi.waitFor(async () => {
      expect((await h.service.state(taskId)).status).toBe('ready');
    });
  }

  it('弹窗已 succeeded 后关闭弹窗开关 → 同键 open 走静默语义，不重置、不再写一篇', async () => {
    const h = await setup();
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    await waitReady(h, dialog.taskId);

    // 根级落点：不带父级，createDocWithMd 只发一次（父级链会额外建目录文档）
    const dialogTarget: StoragePath = {
      notebookId: 'nb-dialog',
      notebookName: '弹窗笔记本',
      parentSegments: [],
      display: '弹窗笔记本',
    };
    await h.service.commit({ taskId: dialog.taskId, title: '弹窗标题', target: dialogTarget });

    await h.prefs.update({ showDialog: false });

    const reopened = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(reopened.taskId).toBe(dialog.taskId);
    expect(reopened.status).toBe('succeeded');
    expect(reopened.alreadyRunning).toBe(false);
    expect(reopened.target).toEqual(dialogTarget);
    expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
  });

  it('弹窗任务就绪未提交 → 关闭开关后同键 open 转静默自动写入，仅调 1 次 LLM', async () => {
    const h = await setup();
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    await waitReady(h, dialog.taskId);

    await h.prefs.update({ showDialog: false });

    const adopted = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(adopted.taskId).toBe(dialog.taskId);
    expect(adopted.status).toBe('writing');
    expect(adopted.alreadyRunning).toBe(true);

    await vi.waitFor(async () => {
      expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    });
    const state = await h.service.state(dialog.taskId);
    expect(state.mode).toBe('silent');
    expect(state.target).toEqual(ROOT_TARGET);
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
  });

  it('弹窗 commit 失败后关闭开关 → 同键 open 复用缓存 body 静默重写，只落一篇', async () => {
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
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    await waitReady(h, dialog.taskId);

    await expect(
      h.service.commit({ taskId: dialog.taskId, title: '弹窗标题', target: ROOT_TARGET }),
    ).rejects.toThrow();
    expect((await h.service.state(dialog.taskId)).status).toBe('failed');

    await h.prefs.update({ showDialog: false });

    const adopted = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(adopted.taskId).toBe(dialog.taskId);
    expect(adopted.status).toBe('writing');

    await vi.waitFor(async () => {
      expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    });
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
    expect(h.siyuan.docs).toHaveLength(1);
  });

  it('弹窗任务写入中关闭开关 → 同键 open 返回静默 writing，不改道、不重复写入', async () => {
    const gate = deferred<void>();
    const h = await setup({
      wrapWriter: (inner) => ({
        write: async (input) => {
          await gate.promise;
          return inner.write(input);
        },
      }),
    });
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    await waitReady(h, dialog.taskId);

    const pending = h.service.commit({ taskId: dialog.taskId, title: '弹窗标题', target: ROOT_TARGET });
    expect((await h.service.state(dialog.taskId)).status).toBe('writing');

    await h.prefs.update({ showDialog: false });

    const adopted = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(adopted.taskId).toBe(dialog.taskId);
    expect(adopted.status).toBe('writing');
    expect(adopted.alreadyRunning).toBe(true);
    expect(adopted.target).toEqual(ROOT_TARGET);
    // 已确定的写入不改道：state 仍是创建模式，Client 只按 open 响应决定是否弹窗
    expect((await h.service.state(dialog.taskId)).mode).toBe('dialog');

    gate.resolve();
    await pending;
    await vi.waitFor(async () => {
      expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    });
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
  });

  it('并发静默接管就绪的弹窗任务 → 只写一篇（解析落点期间不放行第二条流水线）', async () => {
    const h = await setup();
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    await waitReady(h, dialog.taskId);

    const opened = await Promise.all([
      h.service.open({ messageId: 'm1', sessionId: 's1', intent: 'silent' }),
      h.service.open({ messageId: 'm1', sessionId: 's1', intent: 'silent' }),
    ]);
    for (const item of opened) {
      expect(item.mode).toBe('silent');
      if (item.mode !== 'silent') throw new Error('期望静默模式响应');
      expect(item.taskId).toBe(dialog.taskId);
    }

    await vi.waitFor(async () => {
      expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    });
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
  });

  it('弹窗任务生成中关闭开关 → 同键 open 转静默并沿用进行中的 LLM 流', async () => {
    const gate = deferred<string>();
    const h = await setup({ gateway: { generate: () => gate.promise } });
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    expect((await h.service.state(dialog.taskId)).status).toBe('generating');

    await h.prefs.update({ showDialog: false });

    const adopted = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(adopted.taskId).toBe(dialog.taskId);
    expect(adopted.status).toBe('generating');
    expect(adopted.alreadyRunning).toBe(true);
    expect(h.llmCalls).toHaveLength(1); // 沿用同一条 LLM 流，不重启

    gate.resolve(JSON.stringify({ title: '沿用标题', body: '## 小节\n- ✅ 继续' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    });
    const state = await h.service.state(dialog.taskId);
    expect(state.mode).toBe('silent');
    expect(state.target).toEqual(ROOT_TARGET);
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
  });

  it('弹窗任务已取消后关闭开关 → 同键 open 重新生成并按静默落点写入', async () => {
    const gates: Deferred<string>[] = [];
    const h = await setup({
      gateway: {
        generate: ({ signal }) =>
          new Promise<string>((resolve, reject) => {
            const gate = deferred<string>();
            gates.push(gate);
            const onAbort = () => reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
            signal?.addEventListener('abort', onAbort, { once: true });
            gate.promise.then((value) => {
              signal?.removeEventListener('abort', onAbort);
              resolve(value);
            });
          }),
      },
    });
    await h.prefs.update({ showDialog: true });
    const dialog = await openDialog(h);
    expect((await h.service.state(dialog.taskId)).status).toBe('generating');

    expect(await h.service.cancel(dialog.taskId)).toEqual({ status: 'cancelled' });
    expect((await h.service.state(dialog.taskId)).status).toBe('cancelled');

    await h.prefs.update({ showDialog: false });

    const adopted = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(adopted.taskId).toBe(dialog.taskId);
    expect(adopted.status).toBe('generating');
    expect(gates).toHaveLength(2); // 取消后重新发起生成

    gates[1]!.resolve(JSON.stringify({ title: '重生成标题', body: '## 小节\n- ✅ 重来' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(dialog.taskId)).status).toBe('succeeded');
    });
    expect(h.llmCalls).toHaveLength(2);
    expect(h.createDocs()).toHaveLength(1);
    expect(h.siyuan.docs[0]!.path).toBe('/重生成标题');
  });
});

describe('静默失败、重试与降级（T059）', () => {
  it('默认路径失效 → failed 且不改道：不回退、不调 LLM、不写盘、不回写 lastPath', async () => {
    const h = await setup({
      defaultPath: {
        notebookId: 'nb-gone',
        notebookName: '已删除',
        parentSegments: [],
        display: '已删除',
      },
    });

    const opened = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(opened.status).toBe('failed');
    expect(opened.error?.category).toBe('siyuan-path');
    expect(opened.error?.retryable).toBe(false);
    expect(opened.target).toBeNull();
    expect(opened.targetFrom).toBeNull();

    expect(h.llmCalls).toHaveLength(0);
    expect(h.siyuan.docs).toHaveLength(0);
    expect((await h.prefs.read()).lastPath).toBeNull();
  });

  it('写入失败 → failed 保留原因/retryable；再次 open 复用缓存 body 重试，只落一篇', async () => {
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

    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('failed');
    });

    const failed = await h.service.state(first.taskId);
    expect(failed.error?.category).toBe('siyuan-connect');
    expect(failed.error?.retryable).toBe(true);
    expect(failed.target).toEqual(ROOT_TARGET); // 失败不改道
    expect(h.siyuan.docs).toHaveLength(0);

    const retry = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(retry.taskId).toBe(first.taskId);
    expect(retry.status).toBe('writing');
    expect(retry.alreadyRunning).toBe(true);

    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });

    const done = await h.service.state(first.taskId);
    expect(done.degraded).toBe(false);
    expect(done.href).toMatch(/^siyuan:\/\/blocks\//);
    expect(done.target).toEqual(ROOT_TARGET);
    expect(h.llmCalls).toHaveLength(1); // 重试不重调 LLM
    expect(h.createDocs()).toHaveLength(1);
    expect(h.siyuan.docs).toHaveLength(1);
    expect(h.siyuan.docs[0]!.path).toBe('/默认标题');
  });

  it('失败后修改默认路径 → 重试按当前偏好重新解析落点（data-model `failed` 行）', async () => {
    const other: StoragePath = {
      notebookId: 'nb-other',
      notebookName: '第二笔记本',
      parentSegments: [],
      display: '第二笔记本',
    };
    let failures = 1;
    const h = await setup({
      defaultPath: ROOT_TARGET,
      notebooks: [
        { id: 'nb-default', name: '默认笔记本' },
        { id: 'nb-other', name: '第二笔记本' },
      ],
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

    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('failed');
    });
    expect((await h.service.state(first.taskId)).target).toEqual(ROOT_TARGET);

    await h.prefs.update({ defaultPath: other });
    expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });

    const done = await h.service.state(first.taskId);
    expect(done.target).toEqual(other);
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
    expect(h.createDocs()[0]!.body.notebook).toBe('nb-other');
  });

  it('失败重试并发 open → 只写一篇（解析落点期间不放开 writing 门闩）', async () => {
    let failures = 1;
    const h = await setup({
      defaultPath: ROOT_TARGET,
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

    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('failed');
    });

    const opened = await Promise.all([
      h.service.open({ messageId: 'm1', sessionId: 's1' }),
      h.service.open({ messageId: 'm1', sessionId: 's1' }),
    ]);
    for (const item of opened) expect(item.mode).toBe('silent');

    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('succeeded');
    });
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(1);
  });

  it('重试时默认路径失效 → 再次 failed（siyuan-path），不写入、不重调 LLM', async () => {
    let failures = 1;
    const h = await setup({
      defaultPath: ROOT_TARGET,
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

    const first = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('failed');
    });

    await h.prefs.update({
      defaultPath: { ...ROOT_TARGET, notebookId: 'nb-missing', notebookName: '已删除' },
    });
    const retry = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    expect(retry.status).toBe('failed');
    expect(retry.alreadyRunning).toBe(false);

    const failed = await h.service.state(first.taskId);
    expect(failed.error?.category).toBe('siyuan-path');
    expect(failed.target).toEqual(ROOT_TARGET); // 落点未被改写
    expect(h.llmCalls).toHaveLength(1);
    expect(h.createDocs()).toHaveLength(0);
  });

  it('生成失败降级：仍以原文写入并置 degraded=true', async () => {
    const h = await setup({ gateway: createHostLlmGateway(startFakeLlm({ mode: 'structure-bad' }).llm) });

    const opened = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('succeeded');
    });

    const state = await h.service.state(opened.taskId);
    expect(state.degraded).toBe(true);
    expect(state.error).toBeNull();
    expect(state.title).toBe('会话摘要'); // 降级标题取正文首行
    expect(h.siyuan.docs).toHaveLength(1);
    expect(h.siyuan.docs[0]!.path).toBe('/会话摘要');
    const markdown = String(h.createDocs()[0]!.body.markdown);
    expect(markdown).toContain('这是需要导出的单次输出。');
  });
});
