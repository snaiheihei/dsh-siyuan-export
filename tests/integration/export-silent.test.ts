import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
} = {}): Promise<{
  service: ExportService;
  prefs: PrefsStore;
  siyuan: FakeSiyuan;
  dir: string;
  createDocs: () => ReturnType<typeof createDocs>;
  llmCalls: string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'export-silent-flow-'));
  // Windows：lastPath 回写可能在断言后仍在途，删除临时目录用重试避免 ENOTEMPTY
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const prefs = new PrefsStore(dir);
  await prefs.update({ showDialog: false, defaultPath: options.defaultPath ?? null });

  const siyuan = await startFakeSiyuan({ token: 'TK' });
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
      listNotebooks: async () => [{ id: 'nb-default', name: '默认笔记本' }],
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

    // 落点回写 lastPath（FR-006）；state 先于回写完成，故轮询等待
    await vi.waitFor(async () => {
      expect((await h.prefs.read()).lastPath).toEqual(ROOT_TARGET);
    });
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
    const h = await setup();
    const opened = expectSilent(await h.service.open({ messageId: 'm1', sessionId: 's1' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('succeeded');
    });

    const files = await readdir(h.dir);
    expect(files.sort()).toEqual(['prefs.json']);
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
