import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoragePath } from '../../src/contract';
import { createHostLlmGateway } from '../../src/export/llm';
import { ExportService } from '../../src/export/export-service';
import { SiyuanClient, createNote } from '../../src/siyuan/client';
import { PrefsStore } from '../../src/store/prefs';
import { startFakeLlm } from './fake-llm';
import { startFakeSiyuan, type FakeSiyuan } from './fake-siyuan';

/**
 * T019 · 全流程集成（真实 SiyuanClient + 真实 PrefsStore + 真实 service/format 状态机）
 * 替身：fake-siyuan HTTP 端口、fake-llm、内存 source（fake 阶梯）。
 * 抓到什么：open→ready→commit→succeeded 全链、落盘 markdown 结构（H2 分节/图标/footer）、
 *   lastPath 回写、幂等 open、state 不回传 body、FR-013 输入集成复核。
 * 抓不到什么：真实思源/真实模型/真实 Session 读取（quickstart V3/V5）。
 * 红→绿：src/export/export-service.ts 尚不存在。
 */

const CONTENT = '# 会话摘要\n这是需要导出的单次输出。\n- ✅ 结论';

const TARGET: StoragePath = {
  notebookId: 'nb-default',
  notebookName: '默认笔记本',
  parentSegments: ['父级'],
  display: '默认笔记本 / 父级',
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('导出全流程集成（T019）', () => {
  it('open → ready → commit → succeeded：落盘结构、路径回写、幂等、FR-013 复核', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-flow-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const prefs = new PrefsStore(dir);

    const siyuan: FakeSiyuan = await startFakeSiyuan({ token: 'TK' });
    cleanups.push(siyuan.close);
    const client = new SiyuanClient({ endpoint: siyuan.endpoint, token: 'TK' });

    const { llm, calls } = startFakeLlm({});
    const service = new ExportService({
      source: {
        readOutput: async () => ({ content: CONTENT, contentRevision: 'rev-flow' }),
      },
      gateway: createHostLlmGateway(llm),
      writer: { write: (input) => createNote({ client, ...input }) },
      prefs,
    });

    // open → generating → ready
    const opened = await service.open({ messageId: 'm1', sessionId: 's1' });
    expect(opened.status).toBe('generating');
    await vi.waitFor(async () => {
      expect((await service.state(opened.taskId)).status).toBe('ready');
    });

    // commit → succeeded
    const result = await service.commit({ taskId: opened.taskId, title: '导出标题', target: TARGET });
    expect(result.status).toBe('succeeded');
    expect(result.href).toContain('siyuan://blocks/');

    // 思源侧落盘断言
    expect(siyuan.docs).toHaveLength(1);
    expect(siyuan.docs[0]!.path).toBe('/父级/导出标题');
    const createReq = siyuan.requests.find((r) => r.path === '/api/filetree/createDocWithMd');
    expect(createReq).toBeDefined();
    const markdown = String(createReq!.body.markdown);
    expect(markdown).toContain('## 小节'); // fake-llm 输出的分节
    expect(markdown).toContain('✅'); // 小图标
    expect(markdown).toContain('来源会话'); // formatNote 元数据注记
    expect(markdown).toContain('s1');
    expect(markdown.indexOf('这是需要导出的单次输出')).toBeLessThan(markdown.indexOf('来源会话'));

    // lastPath 回写
    expect((await prefs.read()).lastPath).toEqual(TARGET);

    // 幂等：再次 open 不重调 LLM
    const again = await service.open({ messageId: 'm1', sessionId: 's1' });
    expect(again.taskId).toBe(opened.taskId);
    expect(calls).toHaveLength(1);

    // state 不回传 body
    const state = await service.state(opened.taskId);
    expect(JSON.stringify(state)).not.toContain('需要导出的单次输出');

    // FR-013 集成复核：捕获的 messages 仅含 <single-output> 包裹的单次输出
    const messagesJson = JSON.stringify(calls[0]!.options!.messages);
    expect(messagesJson).toContain('<single-output>');
    expect(messagesJson).toContain(JSON.stringify(CONTENT).slice(1, -1)); // 转义后的原文
    expect(calls[0]!.options!).not.toHaveProperty('sessionId');
  });
});
