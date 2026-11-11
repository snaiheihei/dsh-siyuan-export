import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportDialogOpenData, StoragePath } from '../../src/contract';
import { createHostLlmGateway, type LlmGateway } from '../../src/export/llm';
import { ExportService, type ExportServiceDeps } from '../../src/export/export-service';
import { SiyuanError } from '../../src/siyuan/client';
import { PrefsStore } from '../../src/store/prefs';
import { startFakeLlm } from '../integration/fake-llm';

/**
 * T016 · 导出编排状态机（seam：ExportServiceDeps 注入边界 —— source / gateway / writer + prefs）
 * 抓到什么：状态转移全路径（generating→ready|degraded-ready→writing→succeeded|failed、cancel）、
 *   幂等键（同键 open 不重复调 LLM）、writing 中重复 commit 拒绝、空源 empty-source 拒绝、
 *   LLM 失败降级（首行标题+原文）、写失败保留字段且重试复用缓存 body、title 清洗与上限。
 * 抓不到什么：真实 Session 读取（T022 接线）、真实思源/模型（归 T026/quickstart）。
 * 红→绿：src/export/export-service.ts 尚不存在。
 */

const CONTENT = '# 标题行\n这是正文内容，含代码 `npm test`\n- 要点一';

const TARGET: StoragePath = {
  notebookId: 'nb-default',
  notebookName: '默认笔记本',
  parentSegments: ['父级'],
  display: '默认笔记本 / 父级',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 本文件默认偏好 showDialog=true，open 应走弹窗分支 */
async function openDialog(
  service: ExportService,
  request: { messageId: string; sessionId: string },
): Promise<ExportDialogOpenData> {
  const data = await service.open(request);
  if (data.mode !== 'dialog') throw new Error('应为弹窗模式');
  return data;
}

interface WriterCall {
  notebookId: string;
  parentHPath: string;
  title: string;
  markdown: string;
}

interface Harness {
  service: ExportService;
  prefs: PrefsStore;
  gatewayCalls: number;
  writerCalls: WriterCall[];
  releaseWriter: () => void;
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHarness(
  options: {
    content?: string;
    gateway?: LlmGateway;
    writerFailTimes?: number;
    writerGate?: boolean;
    seedLastPath?: StoragePath;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'export-service-'));
  dirs.push(dir);
  const prefs = new PrefsStore(dir);
  if (options.seedLastPath) await prefs.update({ lastPath: options.seedLastPath });

  const fake = startFakeLlm({});
  const custom = options.gateway;
  const customCalls = { n: 0 };
  const gateway: LlmGateway = custom
    ? {
        generate: (input) => {
          customCalls.n += 1;
          return custom.generate(input);
        },
      }
    : createHostLlmGateway(fake.llm);
  const gatewayCount = (): number => (custom ? customCalls.n : fake.calls.length);

  const writerCalls: WriterCall[] = [];
  let failures = options.writerFailTimes ?? 0;
  const gate = deferred<void>();
  const writer: ExportServiceDeps['writer'] = {
    write: async (input) => {
      writerCalls.push(input);
      if (options.writerGate) await gate.promise;
      if (failures > 0) {
        failures -= 1;
        throw new SiyuanError('siyuan-connect', '无法连接思源服务，请确认思源正在运行', true);
      }
      return { id: `doc-${writerCalls.length}`, hpath: `${input.parentHPath}/${input.title}` };
    },
  };

  const service = new ExportService({
    source: {
      readOutput: async () => ({
        content: options.content ?? CONTENT,
        contentRevision: 'rev-1',
      }),
    },
    gateway,
    writer,
    prefs,
    targetIo: {
      listNotebooks: async () => [{ id: 'nb-default', name: '默认笔记本' }],
      getIdsByHPath: async () => ['doc-parent'],
    },
  });

  const harness: Harness = {
    service,
    prefs,
    get gatewayCalls() {
      return gatewayCount();
    },
    writerCalls,
    releaseWriter: () => gate.resolve(),
  };
  return harness;
}

describe('ExportService 状态机（T016）', () => {
  it('open → generating（prefill lastPath）→ LLM 完成 → ready；state 不含 body', async () => {
    const gate = deferred<string>();
    const h = await makeHarness({
      gateway: { generate: () => gate.promise },
      seedLastPath: TARGET,
    });
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    expect(opened.status).toBe('generating');
    expect(opened.title).toBeNull();
    expect(opened.lastPath).toEqual(TARGET);

    const during = await h.service.state(opened.taskId);
    expect(during.status).toBe('generating');

    gate.resolve(JSON.stringify({ title: 'LLM标题', body: '正文' }));
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('ready');
    });
    const ready = await h.service.state(opened.taskId);
    expect(ready.title).toBe('LLM标题');
    expect(Object.keys(ready)).not.toContain('body');
    expect(JSON.stringify(ready)).not.toContain('正文');
  });

  it('同键重复 open 幂等：只调一次 LLM', async () => {
    const h = await makeHarness({});
    const first = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    const second = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    expect(second.taskId).toBe(first.taskId);
    await vi.waitFor(async () => {
      expect((await h.service.state(first.taskId)).status).toBe('ready');
    });
    expect(h.gatewayCalls).toBe(1);
    expect((await h.service.state(first.taskId)).status).toBe('ready');
  });

  it('空源 → empty-source 拒绝，不建任务、不调 LLM', async () => {
    const h = await makeHarness({ content: '   \n  ' });
    await expect(openDialog(h.service, { messageId: 'm1', sessionId: 's1' })).rejects.toMatchObject({
      category: 'empty-source',
    });
    expect(h.gatewayCalls).toBe(0);
    await expect(h.service.state('s1:m1')).rejects.toMatchObject({ category: 'internal' });
  });

  it('LLM 超时 → degraded-ready（首行标题），error 保留类别', async () => {
    const fake = startFakeLlm({ mode: 'timeout' });
    const h = await makeHarness({ gateway: createHostLlmGateway(fake.llm) });
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('degraded-ready');
    });
    const state = await h.service.state(opened.taskId);
    expect(state.title).toBe('标题行'); // 首行 '# 标题行' 去掉 # 后截断
    expect(state.error?.category).toBe('llm-timeout');
  });

  it('LLM 输出结构不合 → degraded-ready（category=llm-structure）', async () => {
    const fake = startFakeLlm({ mode: 'structure-bad' });
    const h = await makeHarness({ gateway: createHostLlmGateway(fake.llm) });
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('degraded-ready');
    });
    expect((await h.service.state(opened.taskId)).error?.category).toBe('llm-structure');
  });

  it('ready → commit → succeeded：写入格式化笔记、回写 lastPath、返回 href', async () => {
    const h = await makeHarness({});
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('ready');
    });
    const result = await h.service.commit({ taskId: opened.taskId, title: '我的标题', target: TARGET });
    expect(result.status).toBe('succeeded');
    expect(result.href).toContain('siyuan://blocks/');
    expect(h.writerCalls).toHaveLength(1);
    expect(h.writerCalls[0]!.title).toBe('我的标题');
    expect(h.writerCalls[0]!.parentHPath).toBe('/父级');
    expect(h.writerCalls[0]!.markdown).toContain('来源会话'); // formatNote 元数据注记
    const prefs = await h.prefs.read();
    expect(prefs.lastPath).toEqual(TARGET);
    expect((await h.service.state(opened.taskId)).status).toBe('succeeded');
  });

  it('writing 中重复 commit → 幂等拒绝（retryable=false），只写一次', async () => {
    const h = await makeHarness({ writerGate: true });
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('ready');
    });
    const first = h.service.commit({ taskId: opened.taskId, title: 'T', target: TARGET });
    await vi.waitFor(() => {
      expect(h.writerCalls).toHaveLength(1);
    });
    await expect(h.service.commit({ taskId: opened.taskId, title: 'T', target: TARGET })).rejects.toMatchObject({
      retryable: false,
    });
    h.releaseWriter();
    const result = await first;
    expect(result.status).toBe('succeeded');
    expect(h.writerCalls).toHaveLength(1);
  });

  it('写失败 → failed 保留字段；重试复用缓存 body（不再调 LLM）', async () => {
    const h = await makeHarness({ writerFailTimes: 1 });
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('ready');
    });
    await expect(
      h.service.commit({ taskId: opened.taskId, title: '保留标题', target: TARGET }),
    ).rejects.toMatchObject({ category: 'siyuan-connect' });
    const failed = await h.service.state(opened.taskId);
    expect(failed.status).toBe('failed');
    expect(failed.title).toBe('保留标题'); // 字段不清空（FR-010）
    expect(failed.error?.category).toBe('siyuan-connect');

    const retry = await h.service.commit({ taskId: opened.taskId, title: '保留标题', target: TARGET });
    expect(retry.status).toBe('succeeded');
    expect(h.writerCalls).toHaveLength(2);
    expect(h.writerCalls[1]!.markdown).toBe(h.writerCalls[0]!.markdown); // 缓存 body 复用
    expect(h.gatewayCalls).toBe(1); // 不重调 LLM（token 守卫）
  });

  it('generating 中 cancel → cancelled，晚到的 LLM 结果不覆盖状态', async () => {
    const gate = deferred<string>();
    const h = await makeHarness({ gateway: { generate: () => gate.promise } });
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    const cancelled = await h.service.cancel(opened.taskId);
    expect(cancelled.status).toBe('cancelled');
    expect((await h.service.state(opened.taskId)).status).toBe('cancelled');

    gate.resolve(JSON.stringify({ title: '迟到', body: '迟到正文' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await h.service.state(opened.taskId)).status).toBe('cancelled');
  });

  it('未知 taskId：state/commit 抛不存在；cancel 返回 noop', async () => {
    const h = await makeHarness({});
    await expect(h.service.state('nope')).rejects.toMatchObject({ category: 'internal' });
    await expect(h.service.commit({ taskId: 'nope', title: 'T', target: TARGET })).rejects.toMatchObject({
      category: 'internal',
    });
    expect((await h.service.cancel('nope')).status).toBe('noop');
  });

  it('title 清洗：非法字符移除、空串与超长拒绝（commit 前校验，不产生写入）', async () => {
    const h = await makeHarness({});
    const opened = await openDialog(h.service, { messageId: 'm1', sessionId: 's1' });
    await vi.waitFor(async () => {
      expect((await h.service.state(opened.taskId)).status).toBe('ready');
    });

    await h.service.commit({ taskId: opened.taskId, title: 'a/b<c>d', target: TARGET });
    expect(h.writerCalls[0]!.title).toBe('abcd');

    await expect(h.service.commit({ taskId: opened.taskId, title: '///', target: TARGET })).rejects.toMatchObject({
      category: 'internal',
    });
    await expect(
      h.service.commit({ taskId: opened.taskId, title: 'x'.repeat(129), target: TARGET }),
    ).rejects.toMatchObject({ category: 'internal' });
    expect(h.writerCalls).toHaveLength(1);
  });
});
