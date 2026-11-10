import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrefsStore } from '../../src/store/prefs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

/**
 * T040 · 秘密扫描（FR/凭据纪律：Token 不入日志、审计、状态文件、RPC 响应）
 *
 * 抓到什么：
 *  - 源码无 console 打印 token/config 的模式
 *  - Prefs 持久化内容只含 version/lastPath/draft（无 token/endpoint 泄漏）
 *  - RPC open/state 响应序列化不含 token/endpoint 字段
 *  - 构建产物无硬编码长 Token 字面量
 * 抓不到什么：运行时内存中的 Token（宿主 Config 传入属预期，不落盘即合规）。
 */

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? dir, entry.name));
}

describe('秘密扫描（T040）', () => {
  it('源码无 console 打印 token/config 的模式', async () => {
    const files = await listFiles(join(process.cwd(), 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // 打印配置/token 的日志属于凭据泄漏面（审计只记操作/id/revision 元数据）
      if (/console\.(log|info|warn|error|debug)\s*\([^)]*\b(token|config|endpoint)\b/i.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Prefs 持久化内容只含 version/lastPath/draft（无 token/endpoint）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'secret-scan-'));
    try {
      const store = new PrefsStore(dir);
      await store.update({
        lastPath: {
          notebookId: 'nb',
          notebookName: 'N',
          parentSegments: ['p'],
          display: 'N / p',
        },
      });
      const raw = await readFile(join(dir, 'prefs.json'), 'utf8');
      expect(raw).not.toMatch(/token/i);
      expect(raw).not.toMatch(/endpoint/i);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Prefs schema 固定三键：version/lastPath/draft —— 不含任何凭据字段
      expect(Object.keys(parsed).sort()).toEqual(['draft', 'lastPath', 'version']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('RPC 响应数据结构不含 token/endpoint 字段', async () => {
    const { ExportService } = await import('../../src/export/export-service');
    const { createHostLlmGateway } = await import('../../src/export/llm');
    const { startFakeLlm } = await import('../integration/fake-llm');
    const fake = startFakeLlm({});
    const service = new ExportService({
      source: { readOutput: async () => ({ content: '# 扫描\n内容', contentRevision: 'r' }) },
      gateway: createHostLlmGateway(fake.llm),
      writer: { write: async (input) => ({ id: 'x', hpath: input.title }) },
      prefs: new PrefsStore(join(tmpdir(), `secret-rpc-${Date.now()}`)),
    });
    const opened = await service.open({ messageId: 'm', sessionId: 's' });
    const state = await service.state(opened.taskId);
    const openJson = JSON.stringify(opened);
    const stateJson = JSON.stringify(state);
    expect(openJson).not.toMatch(/token/i);
    expect(openJson).not.toMatch(/endpoint/i);
    expect(stateJson).not.toMatch(/token/i);
    expect(stateJson).not.toMatch(/endpoint/i);
  });

  it('构建产物无硬编码长 Token 字面量（形如 Token <20+ 位>）', async () => {
    const distDir = join(process.cwd(), 'dist');
    let files: string[] = [];
    try {
      files = await listFiles(distDir);
    } catch {
      return; // dist 不存在（未构建）时跳过本条——构建产物扫描在 build 后执行
    }
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.(js|mjs|cjs)$/.test(file)) continue;
      const text = await readFile(file, 'utf8');
      if (/Token\s+[A-Za-z0-9_-]{20,}/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
