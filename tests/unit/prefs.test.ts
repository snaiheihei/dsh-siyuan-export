import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PREFS_VERSION, PrefsStore, type PrefsData } from '../../src/store/prefs';

/**
 * T049 · 偏好 v2（seam：真实 Temp 目录 + 可注入 rename）
 * 抓到什么：缺失文件默认值（showDialog=true/defaultPath=null）、v1 迁移保留
 *   lastPath/draft 并写回 v2、损坏文件回退、未知 version 回退并写回 v2、
 *   显式 `false`/`null` 不被 definedPatch 吞掉、原子写无 tmp 残留、串行队列。
 * 抓不到什么：resolveDshHome 组合（归 T020 接线）、真实 Windows 瞬态 EPERM（用注入模拟）。
 * 红→绿：期望 v2 结构/迁移行为，当前实现仍为 v1。
 */

let base: string;

async function makeDir(): Promise<string> {
  return mkdtemp(join(base, 'prefs-'));
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'siyuan-prefs-test-'));
});

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

const EMPTY_DEFAULTS: PrefsData = {
  version: 2,
  lastPath: null,
  defaultPath: null,
  showDialog: true,
  draft: null,
};

const SAMPLE_PATH = {
  notebookId: 'nb-1',
  notebookName: '工作',
  parentSegments: ['项目A'],
  display: '工作 / 项目A',
};

async function readRaw(dir: string): Promise<PrefsData> {
  return JSON.parse(await readFile(join(dir, 'prefs.json'), 'utf8')) as PrefsData;
}

describe('PrefsStore v2', () => {
  it('文件缺失 → 默认值（version=2, lastPath/defaultPath=null, showDialog=true）', async () => {
    const store = new PrefsStore(await makeDir());
    const prefs = await store.read();
    expect(prefs).toEqual(EMPTY_DEFAULTS);
    expect(PREFS_VERSION).toBe(2);
  });

  it('update 原子写入：读回一致、无 .tmp 残留', async () => {
    const dir = await makeDir();
    const store = new PrefsStore(dir);
    const merged = await store.update({ lastPath: SAMPLE_PATH });
    expect(merged.lastPath).toEqual(SAMPLE_PATH);

    const raw = await readRaw(dir);
    expect(raw.lastPath).toEqual(SAMPLE_PATH);
    expect(raw.version).toBe(2);

    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('并发 update 串行执行：两个补丁都保留（队列语义）', async () => {
    const dir = await makeDir();
    const store = new PrefsStore(dir);
    const draft = { title: '草稿标题' };
    await Promise.all([store.update({ lastPath: SAMPLE_PATH }), store.update({ draft })]);
    const final = await store.read();
    expect(final.lastPath).toEqual(SAMPLE_PATH);
    expect(final.draft).toEqual(draft);
  });

  it('损坏文件 → 回落默认值且不抛错（不覆盖原文件）', async () => {
    const dir = await makeDir();
    const broken = '{ not valid json !!';
    await writeFile(join(dir, 'prefs.json'), broken, 'utf8');
    const store = new PrefsStore(dir);
    const prefs = await store.read();
    expect(prefs).toEqual(EMPTY_DEFAULTS);
    // 损坏文件不可解析，保留原文不写回（避免掩盖可恢复数据）
    expect(await readFile(join(dir, 'prefs.json'), 'utf8')).toBe(broken);
  });

  it('v1 迁移：保留 lastPath/draft，补默认字段并写回 v2', async () => {
    const dir = await makeDir();
    const v1 = {
      version: 1,
      lastPath: SAMPLE_PATH,
      draft: { title: '旧草稿' },
    };
    await writeFile(join(dir, 'prefs.json'), JSON.stringify(v1, null, 2), 'utf8');
    const store = new PrefsStore(dir);

    const prefs = await store.read();
    expect(prefs).toEqual({
      version: 2,
      lastPath: SAMPLE_PATH,
      defaultPath: null,
      showDialog: true,
      draft: { title: '旧草稿' },
    });

    const raw = await readRaw(dir);
    expect(raw.version).toBe(2);
    expect(raw.lastPath).toEqual(SAMPLE_PATH);
    expect(raw.draft).toEqual({ title: '旧草稿' });
  });

  it('未知 version → 回退默认值并写回 v2', async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, 'prefs.json'),
      JSON.stringify({ version: 99, lastPath: SAMPLE_PATH, showDialog: false }),
      'utf8',
    );
    const store = new PrefsStore(dir);

    const prefs = await store.read();
    expect(prefs).toEqual(EMPTY_DEFAULTS);

    const raw = await readRaw(dir);
    expect(raw.version).toBe(2);
    expect(raw.lastPath).toBeNull();
    expect(raw.showDialog).toBe(true);
  });

  it('显式 showDialog:false 与 defaultPath:null 不被默认值吞掉', async () => {
    const dir = await makeDir();
    const store = new PrefsStore(dir);
    await store.update({ showDialog: true, defaultPath: SAMPLE_PATH });

    const merged = await store.update({ showDialog: false, defaultPath: null });
    expect(merged.showDialog).toBe(false);
    expect(merged.defaultPath).toBeNull();

    const raw = await readRaw(dir);
    expect(raw.showDialog).toBe(false);
    expect(raw.defaultPath).toBeNull();
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
