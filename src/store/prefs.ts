/**
 * T013 · 偏好存储（单一权威状态，原子发布）
 *
 * 纪律（develop-dsh-plugin §8）：
 *  - 数据根由组合期用 resolveDshHome 解析（T020 接线），不硬编码用户目录、不写插件仓库
 *  - 临时位置写全量 → 原子 rename 切换；失败保留旧版本并清理临时产物
 *  - 全部写入同一串行队列；Windows 瞬态 EPERM 等有限退避重试，不无限重试
 *  - 可读文件仅作投影；localStorage 只作非权威显示缓存（Client 侧）
 */
import { mkdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoragePath } from '../contract';

export const PREFS_VERSION = 1;

export interface PrefsDraft {
  title?: string;
  path?: StoragePath;
}

export interface PrefsData {
  version: number;
  lastPath: StoragePath | null;
  draft: PrefsDraft | null;
}

/** 可注入的 rename（EPERM 退避的测试注入点；生产为 fs.rename） */
export interface PrefsOps {
  rename: (from: string, to: string) => Promise<void>;
}

export interface PrefsStoreOptions {
  ops?: PrefsOps;
  /** rename 最大重试次数（不含首次），默认 3 */
  renameRetries?: number;
  /** 重试退避基数 ms，默认 50 */
  retryDelayMs?: number;
}

const DEFAULT_PREFS: PrefsData = { version: PREFS_VERSION, lastPath: null, draft: null };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrefsData(value: unknown): value is PrefsData {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<PrefsData>;
  if (record.version !== PREFS_VERSION) return false; // 版本不符 → 默认值（未来迁移点）
  const lastPathOk = record.lastPath === null || typeof record.lastPath === 'object';
  const draftOk = record.draft === null || typeof record.draft === 'object';
  return lastPathOk && draftOk;
}

/** 丢弃显式 undefined，避免覆盖已有值 */
function definedPatch<T extends object>(patch: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export class PrefsStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly ops: PrefsOps;
  private readonly renameRetries: number;
  private readonly retryDelayMs: number;
  /** 串行队列尾（所有写入共用） */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: PrefsStoreOptions = {}) {
    this.dir = dir;
    this.file = join(dir, 'prefs.json');
    this.ops = options.ops ?? { rename: (from, to) => fsRename(from, to) };
    this.renameRetries = options.renameRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 50;
  }

  /** 读取：文件缺失/损坏/版本不符 → 默认值，不抛错 */
  async read(): Promise<PrefsData> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isPrefsData(parsed) ? parsed : { ...DEFAULT_PREFS };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  /** 合并补丁并原子发布（串行队列内执行，保证读-改-写不交错） */
  async update(patch: Partial<PrefsData>): Promise<PrefsData> {
    return this.enqueue(async () => {
      const current = await this.read();
      const next: PrefsData = {
        ...current,
        ...definedPatch<PrefsData>(patch),
        version: PREFS_VERSION,
      };
      await this.writeAtomic(next);
      return next;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeAtomic(data: PrefsData): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ops.rename(tmp, this.file);
        return;
      } catch (err) {
        if (attempt >= this.renameRetries) {
          // 保留旧版本（目标未被覆盖）；清理临时产物，失败不掩盖原始错误
          await rm(tmp, { force: true }).catch(() => undefined);
          throw err;
        }
        await sleep(this.retryDelayMs);
      }
    }
  }
}
