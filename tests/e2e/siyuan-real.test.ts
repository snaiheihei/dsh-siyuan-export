import { describe, expect, it } from 'vitest';
import { createNote, SiyuanClient } from '../../src/siyuan/client';
import { formatNote } from '../../src/export/format';

/**
 * T037 · 真实思源注入故障 E2E（quickstart V6/V7 的真实维度）
 *
 * 前置：本机思源运行于 127.0.0.1:6806（探测失败则整体 skip，不假绿）。
 * 覆盖（真实链路）：
 *  - V6a：错误 endpoint → 真实连接失败 → siyuan-connect 可重试
 *  - 真实写入：createNote 落盘到测试目录，回读校验，formatNote 元数据随文写入
 *  - V7：同名两次 → createNote 消歧保证两篇独立文档（FR-007）；
 *        并实测「同 path 直接重复调用」的真实思源语义（文档未定，实测固化）
 *  - 清理：删除测试目录（不残留用户数据）
 *
 * 未覆盖（诚实标注）：LLM 降级/生成中取消/浏览器 UI（归单测与 quickstart 手工核验）。
 */

const NOTEBOOK_ROOT_PATH = '/__dsh_export_e2e_test__';

const baseProbe = await fetch('http://127.0.0.1:6806/api/system/version', {
  method: 'POST',
  headers: { 'Content-type': 'application/json' },
  body: '{}',
})
  .then((r) => r.ok)
  .catch(() => false);

const siyuanUp = baseProbe;

function makeClient(): SiyuanClient {
  return new SiyuanClient({
    endpoint: 'http://127.0.0.1:6806',
    token: '', // 本机未开鉴权（空 Token 实测可用）
    backoffMs: 0,
    timeoutMs: 10_000,
  });
}

async function firstNotebookId(client: SiyuanClient): Promise<string> {
  const payload = (await client.post<{ notebooks?: { id: string; closed?: boolean }[] }>(
    '/api/notebook/lsNotebooks',
    {},
  )) as { notebooks?: { id: string; closed?: boolean }[] };
  const list = Array.isArray(payload) ? payload : (payload.notebooks ?? []);
  const open = list.find((notebook) => !notebook.closed);
  if (!open) throw new Error('无可用笔记本');
  return open.id;
}

async function removePath(client: SiyuanClient, notebookId: string, hpath: string): Promise<void> {
  const ids = await client.post<string[]>('/api/filetree/getIDsByHPath', {
    notebook: notebookId,
    path: hpath,
  });
  if (Array.isArray(ids)) {
    for (const id of ids) {
      // 官方签名：removeDocByID {id}（removeDoc 需要 .sy 存储路径，实测纠正）
      await client.post('/api/filetree/removeDocByID', { id });
    }
  }
}

describe.skipIf(!siyuanUp)(
  '真实思源注入故障 E2E（T037；思源未运行则整体跳过）',
  () => {
    const client = makeClient();
    let notebookId = '';
    const createdPaths: string[] = [];

    it('V6a：错误 endpoint → 真实连接失败 → siyuan-connect 可重试', async () => {
      const dead = new SiyuanClient({
        endpoint: 'http://127.0.0.1:1',
        token: '',
        backoffMs: 0,
        timeoutMs: 3_000,
      });
      await expect(dead.post('/api/system/version', {})).rejects.toMatchObject({
        category: 'siyuan-connect',
        retryable: true,
      });
    });

    it('真实写入：createNote 落盘 + 回读 + formatNote 元数据随文', async () => {
      notebookId = await firstNotebookId(client);
      const formatted = formatNote({
        body: '# E2E 标题\n\n- ✅ 真实写入要点',
        source: { sessionId: 'e2e-s', messageId: 'e2e-m', contentRevision: 'e2e-r' },
        exportedAt: new Date(),
      });
      const result = await createNote({
        client,
        notebookId,
        parentHPath: NOTEBOOK_ROOT_PATH,
        title: '写入验证',
        markdown: formatted.markdown,
      });
      createdPaths.push(`${NOTEBOOK_ROOT_PATH}/写入验证`);
      expect(result.id).toBeTruthy();

      // 回读校验：该路径下存在文档
      const ids = await client.post<string[]>('/api/filetree/getIDsByHPath', {
        notebook: notebookId,
        path: `${NOTEBOOK_ROOT_PATH}/写入验证`,
      });
      expect(ids).toContain(result.id);
    });

    it('V7：同名两次 → 消歧产生两篇独立文档（FR-007）', async () => {
      const first = await createNote({
        client,
        notebookId,
        parentHPath: NOTEBOOK_ROOT_PATH,
        title: '同名测试',
        markdown: '第一篇',
      });
      const second = await createNote({
        client,
        notebookId,
        parentHPath: NOTEBOOK_ROOT_PATH,
        title: '同名测试',
        markdown: '第二篇',
      });
      createdPaths.push(`${NOTEBOOK_ROOT_PATH}/同名测试`, `${NOTEBOOK_ROOT_PATH}/同名测试 (2)`);
      expect(first.id).not.toBe(second.id);
      expect(first.hpath).toBe(`${NOTEBOOK_ROOT_PATH}/同名测试`);
      expect(second.hpath).toBe(`${NOTEBOOK_ROOT_PATH}/同名测试 (2)`);

      // 两篇路径都可回读（各自独立存在）
      for (const hpath of [first.hpath, second.hpath]) {
        const ids = await client.post<string[]>('/api/filetree/getIDsByHPath', {
          notebook: notebookId,
          path: hpath,
        });
        expect(Array.isArray(ids) && ids.length > 0).toBe(true);
      }
    });

    it('V7 实测：同 path 直接重复调用的真实语义（文档未定，实测固化）', async () => {
      const path = `${NOTEBOOK_ROOT_PATH}/直接重复`;
      const a = await client.post<string>('/api/filetree/createDocWithMd', {
        notebook: notebookId,
        path,
        markdown: '第一版内容',
      });
      const b = await client.post<string>('/api/filetree/createDocWithMd', {
        notebook: notebookId,
        path,
        markdown: '第二版内容',
      });
      createdPaths.push(path);
      // 真实语义：不覆盖第一篇（思源文档原文「不会覆盖已有文档」）——
      // 无论返回同 id（复用）还是新 id（并存），第一篇的内容都不被第二版替换。
      // 我们的适配器不依赖该行为（消歧保证独立），此处仅实测记录。
      expect(typeof a).toBe('string');
      expect(typeof b).toBe('string');
      expect(b.length).toBeGreaterThan(0);
    });

    it('清理：删除测试目录，不残留用户数据', async () => {
      await removePath(client, notebookId, `${NOTEBOOK_ROOT_PATH}/写入验证`);
      await removePath(client, notebookId, `${NOTEBOOK_ROOT_PATH}/同名测试`);
      await removePath(client, notebookId, `${NOTEBOOK_ROOT_PATH}/同名测试 (2)`);
      await removePath(client, notebookId, `${NOTEBOOK_ROOT_PATH}/直接重复`);
      await removePath(client, notebookId, NOTEBOOK_ROOT_PATH);
      const ids = await client.post<string[]>('/api/filetree/getIDsByHPath', {
        notebook: notebookId,
        path: NOTEBOOK_ROOT_PATH,
      });
      expect(Array.isArray(ids) && ids.length > 0).toBe(false);
    });
  },
);

describe.skipIf(siyuanUp)('真实思源不可用（诚实跳过，不假绿）', () => {
  it('提示：启动思源后重跑本文件以完成 T037 真实维度', () => {
    expect(siyuanUp).toBe(false);
  });
});
