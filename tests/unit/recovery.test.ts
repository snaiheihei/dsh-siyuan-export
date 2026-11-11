import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoragePath } from '../../src/contract';
import { createHostLlmGateway, type LlmGateway } from '../../src/export/llm';
import { ExportService, type ExportServiceDeps } from '../../src/export/export-service';
import { SiyuanError } from '../../src/siyuan/client';
import { PrefsStore } from '../../src/store/prefs';
import { startFakeLlm } from '../integration/fake-llm';

/**
 * T035 · 失败恢复（seam：ExportServiceDeps 注入边界）
 * 抓到什么：
 *  - 写失败 → retry 复用缓存 body 不重调 LLM（token 守卫）
 *  - 字段全程不清空（FR-010）
 *  - 生成中 cancel 中止、任务清理无半成品
 *  - **终态 open 行为**（spec edge「同一条回复连续导出到不同路径」）：
 *    succeeded 再 open → 允许再次 commit（不抛「已导出」）；
 *    cancelled 再 open → 重新生成；
 *    failed 再 open → 保留 failed 可直接重试
 * 抓不到什么：真实网络/真实思源（归 T037）。
 * 红→绿：当前实现中 succeeded 再 commit 会抛错 → 本文件先红。
 */

const CONTENT = '# 恢复测试\n正文内容';

const TARGET: StoragePath = {
  notebookId: 'nb-default',
  notebookName: '默认',
  parentSegments: ['p1'],
  display: '默认 / p1',
};

const TARGET2: StoragePath = {
  ...TARGET,
  parentSegments: ['p2'],
  display: '默认 / p2',
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeService(options: {
  writerFailTimes?: number;
  gateway?: LlmGateway;
} = {}): Promise<{
  service: ExportService;
  gatewayCalls: () => number;
  writerCalls: { markdown: string; title: string }[];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-'));
  dirs.push(dir);
  const prefs = new PrefsStore(dir);

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

  const writerCalls: { markdown: string; title: string }[] = [];
  let failures = options.writerFailTimes ?? 0;
  const writer: ExportServiceDeps['writer'] = {
    write: async (input) => {
      writerCalls.push({ markdown: input.markdown, title: input.title });
      if (failures > 0) {
        failures -= 1;
        throw new SiyuanError('siyuan-connect', '无法连接思源服务，请确认思源正在运行', true);
      }
      return { id: `doc-${writerCalls.length}`, hpath: `${input.parentHPath}/${input.title}` };
    },
  };

  const service = new ExportService({
    source: { readOutput: async () => ({ content: CONTENT, contentRevision: 'rev' }) },
    gateway,
    writer,
    prefs,
    targetIo: {
      listNotebooks: async () => [{ id: 'nb-1', name: '工作' }],
      getIdsByHPath: async () => [],
    },
  });

  return {
    service,
    gatewayCalls: () => (custom ? customCalls.n : fake.calls.length),
    writerCalls,
  };
}

async function readyTask(service: ExportService): Promise<string> {
  const opened = await service.open({ messageId: 'm1', sessionId: 's1' });
  await vi.waitFor(async () => {
    expect((await service.state(opened.taskId)).status).toBe('ready');
  });
  return opened.taskId;
}

describe('失败恢复（T035）', () => {
  it('写失败 → failed 字段保留；retry 复用缓存 body（不重调 LLM）', async () => {
    const h = await makeService({ writerFailTimes: 1 });
    const taskId = await readyTask(h.service);

    await expect(h.service.commit({ taskId, title: '保留', target: TARGET })).rejects.toMatchObject({
      category: 'siyuan-connect',
    });
    const failed = await h.service.state(taskId);
    expect(failed.status).toBe('failed');
    expect(failed.title).toBe('保留');
    expect(failed.error?.category).toBe('siyuan-connect');

    const retry = await h.service.commit({ taskId, title: '保留', target: TARGET });
    expect(retry.status).toBe('succeeded');
    expect(h.writerCalls).toHaveLength(2);
    expect(h.writerCalls[1]!.markdown).toBe(h.writerCalls[0]!.markdown);
    expect(h.gatewayCalls()).toBe(1);
  });

  it('二次写入失败 → 仍 failed、字段仍保留（可反复重试）', async () => {
    const h = await makeService({ writerFailTimes: 2 });
    const taskId = await readyTask(h.service);
    await expect(h.service.commit({ taskId, title: 'T', target: TARGET })).rejects.toThrow();
    await expect(h.service.commit({ taskId, title: 'T', target: TARGET })).rejects.toThrow();
    const state = await h.service.state(taskId);
    expect(state.status).toBe('failed');
    expect(state.title).toBe('T');
    expect(state.error?.category).toBe('siyuan-connect');
    expect(h.gatewayCalls()).toBe(1);
  });

  it('generating 中 cancel → cancelled；再 open 同键 → 重新生成（不卡死在 cancelled）', async () => {
    const gate: { resolve?: (v: string) => void } = {};
    const hanging: LlmGateway = {
      generate: () =>
        new Promise<string>((resolve) => {
          gate.resolve = resolve;
        }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'recovery-cancel-'));
    dirs.push(dir);
    const fake = startFakeLlm({});
    const service = new ExportService({
      source: { readOutput: async () => ({ content: CONTENT, contentRevision: 'rev' }) },
      gateway: hanging,
      writer: { write: async (input) => ({ id: 'x', hpath: input.title }) },
      prefs: new PrefsStore(dir),
      targetIo: {
        listNotebooks: async () => [{ id: 'nb-1', name: '工作' }],
        getIdsByHPath: async () => [],
      },
    });

    const first = await service.open({ messageId: 'm1', sessionId: 's1' });
    expect((await service.cancel(first.taskId)).status).toBe('cancelled');
    expect((await service.state(first.taskId)).status).toBe('cancelled');

    // 晚到的生成结果不覆盖 cancelled（已由 T016 覆盖）；再 open 应重新生成而非卡在 cancelled
    gate.resolve?.(JSON.stringify({ title: '迟到', body: 'b' }));
    const second = await service.open({ messageId: 'm1', sessionId: 's1' });
    const statusAfterReopen = (await service.state(second.taskId)).status;
    expect(['generating', 'ready']).toContain(statusAfterReopen);
    expect(statusAfterReopen).not.toBe('cancelled');
    void fake;
    void hanging;
  });

  it('succeeded 再 open → 允许再次 commit 到不同路径（spec edge：各自独立成文）', async () => {
    const h = await makeService({});
    const taskId = await readyTask(h.service);
    const first = await h.service.commit({ taskId, title: '标题一', target: TARGET });
    expect(first.status).toBe('succeeded');

    // 再次打开同一条回复：应可再次导出到另一路径（不抛「已导出」）
    const reopened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(reopened.taskId).toBe(taskId);
    await vi.waitFor(async () => {
      expect(['ready', 'generating']).toContain((await h.service.state(taskId)).status);
    });
    const state = await h.service.state(taskId);
    if (state.status === 'generating') {
      await vi.waitFor(async () => {
        expect((await h.service.state(taskId)).status).toBe('ready');
      });
    }
    const second = await h.service.commit({ taskId, title: '标题二', target: TARGET2 });
    expect(second.status).toBe('succeeded');
    expect(h.writerCalls).toHaveLength(2);
    expect(h.writerCalls[1]!.title).toBe('标题二');
    // 复用缓存 body（不重调 LLM 省 token）
    expect(h.gatewayCalls()).toBe(1);
  });

  it('failed 再 open → 保留 failed 状态可直接重试（复用缓存）', async () => {
    const h = await makeService({ writerFailTimes: 1 });
    const taskId = await readyTask(h.service);
    await expect(h.service.commit({ taskId, title: 'T', target: TARGET })).rejects.toThrow();

    const reopened = await h.service.open({ messageId: 'm1', sessionId: 's1' });
    expect(reopened.taskId).toBe(taskId);
    expect((await h.service.state(taskId)).status).toBe('failed');
    expect(h.gatewayCalls()).toBe(1);
  });
});
