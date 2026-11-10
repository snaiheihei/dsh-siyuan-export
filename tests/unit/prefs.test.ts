import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PREFS_VERSION, PrefsStore, type PrefsData } from '../../src/store/prefs';

/**
 * T013 · 偏好存储（seam：真实 Temp 目录 + 可注入 rename（EPERM 退避重试的注入点））
 * 抓到什么：缺失文件默认值、原子写（无 tmp 残留）、串行队列（并发 update 不丢补丁）、
 *   损坏文件回落默认值、rename 失败有限重试、版本字段。
 * 抓不到什么：resolveDshHome 组合（归 T020 接线）、真实 Windows 瞬态 EPERM（用注入模拟）。
 * 红→绿：src/store/prefs.ts 尚不存在。
 */

let base: string;

async function makeDir(): Promise<string> {
  return mkdtemp(join(base, 'prefs-'));
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'siyuan-prefs-test-'));
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe('PrefsStore', () => {
  it('文件缺失 → 默认值（version=1, lastPath=null, draft=null）', async () => {
    const store = new PrefsStore(await makeDir());
    const prefs = await store.read();
    expect(prefs).toEqual({ version: PREFS_VERSION, lastPath: null, draft: null });
    expect(PREFS_VERSION).toBe(1);
  });

  it('update 原子写入：读回一致、无 .tmp 残留', async () => {
    const dir = await makeDir();
    const store = new PrefsStore(dir);
    const path = {
      notebookId: 'nb-1',
      notebookName: '工作',
      parentSegments: ['项目A'],
      display: '工作 / 项目A',
    };
    const merged = await store.update({ lastPath: path });
    expect(merged.lastPath).toEqual(path);

    const raw = JSON.parse(await readFile(join(dir, 'prefs.json'), 'utf8')) as PrefsData;
    expect(raw.lastPath).toEqual(path);
    expect(raw.version).toBe(1);

    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('并发 update 串行执行：两个补丁都保留（队列语义）', async () => {
    const dir = await makeDir();
    const store = new PrefsStore(dir);
    const path = { notebookId: 'nb', notebookName: 'N', parentSegments: [], display: 'N' };
    const draft = { title: '草稿标题' };
    await Promise.all([store.update({ lastPath: path }), store.update({ draft })]);
    const final = await store.read();
    expect(final.lastPath).toEqual(path);
    expect(final.draft).toEqual(draft);
  });

  it('损坏文件 → 回落默认值且不抛错', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, 'prefs.json'), '{ not valid json !!', 'utf8');
    const store = new PrefsStore(dir);
    const prefs = await store.read();
    expect(prefs).toEqual({ version: PREFS_VERSION, lastPath: null, draft: null });
  });

  it('rename 首次失败 → 有限重试后成功（EPERM 退避的注入点）', async () => {
    const dir = await makeDir();
    let attempts = 0;
    const store = new PrefsStore(dir, {
      renameRetries: 3,
      retryDelayMs: 0,
      ops: {
        rename: async (from: string, to: string) => {
          attempts += 1;
          if (attempts === 1) {
            const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
            err.code = 'EPERM';
            throw err;
          }
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      },
    });
    await store.update({ draft: { title: 'T' } });
    expect(attempts).toBe(2);
    const raw = JSON.parse(await readFile(join(dir, 'prefs.json'), 'utf8')) as PrefsData;
    expect(raw.draft).toEqual({ title: 'T' });
  });

  it('rename 持续失败 → 抛出（有限重试不无限）', async () => {
    const dir = await makeDir();
    let attempts = 0;
    const store = new PrefsStore(dir, {
      renameRetries: 2,
      retryDelayMs: 0,
      ops: {
        rename: async () => {
          attempts += 1;
          const err = new Error('EPERM') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        },
      },
    });
    await expect(store.update({ draft: { title: 'X' } })).rejects.toThrow('EPERM');
    expect(attempts).toBe(3); // 1 次原始 + 2 次重试
  });
});
