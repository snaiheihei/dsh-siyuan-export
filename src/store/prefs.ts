/**
 * T013/T049 · 偏好存储（单一权威状态，原子发布，v2）
 *
 * 纪律（develop-dsh-plugin §8）：
 *  - 数据根由组合期用 resolveDshHome 解析（T020 接线），不硬编码用户目录、不写插件仓库
 *  - 临时位置写全量 → 原子 rename 切换；失败保留旧版本并清理临时产物
 *  - 全部写入同一串行队列；Windows 瞬态 EPERM 等有限退避重试，不无限重试
 *  - 可读文件仅作投影；localStorage 只作非权威显示缓存（Client 侧）
 *  - v1 → v2 迁移保留 lastPath/draft；未知版本回退默认值并写回
 */
import { mkdir, readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoragePath } from '../contract';

export const PREFS_VERSION = 2;

export interface PrefsDraft {
  title?: string;
  path?: StoragePath;
}

export interface PrefsData {
  version: number;
  lastPath: StoragePath | null;
  /** 设置页维护；静默导出首选；null = 未配置 */
  defaultPath: StoragePath | null;
  /** false 时导出走静默；默认 true */
  showDialog: boolean;
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

const DEFAULT_PREFS: PrefsData = {
  version: PREFS_VERSION,
  lastPath: null,
  defaultPath: null,
  showDialog: true,
  draft: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObjectOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'object' && value !== null);
}

/** 读取结果：needsWriteBack 表示迁移/未知版本需要把规范化结果落盘 */
interface LoadResult {
  data: PrefsData;
  needsWriteBack: boolean;
}

/** 解析成功 → 规范化数据；JSON 损坏或非对象 → null（保留原文件，不写回） */
function normalize(parsed: unknown): LoadResult | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version === 1) {
    return {
      data: {
        version: PREFS_VERSION,
        lastPath: isObjectOrNull(record.lastPath) ? (record.lastPath as StoragePath | null) : null,
        defaultPath: null,
        showDialog: true,
        draft: isObjectOrNull(record.draft) ? (record.draft as PrefsDraft | null) : null,
      },
      needsWriteBack: true,
    };
  }
  if (
    record.version === PREFS_VERSION &&
    isObjectOrNull(record.lastPath) &&
    isObjectOrNull(record.defaultPath) &&
    typeof record.showDialog === 'boolean' &&
    isObjectOrNull(record.draft)
  ) {
    return { data: record as unknown as PrefsData, needsWriteBack: false };
  }
  // 未知版本/结构不合法 → 默认值并写回 v2（避免把未知结构当 v2 误读）
  return { data: { ...DEFAULT_PREFS }, needsWriteBack: true };
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

  /** 读取：文件缺失/损坏 → 默认值；v1/未知版本 → 规范化并写回 v2，不抛错 */
  async read(): Promise<PrefsData> {
    const { data, needsWriteBack } = await this.load();
    if (needsWriteBack) {
      // 迁移写回失败不影响读取结果（下次写入会再落盘）
      await this.enqueue(() => this.writeAtomic(data)).catch(() => undefined);
    }
    return data;
  }

  /** 合并补丁并原子发布（串行队列内执行，保证读-改-写不交错） */
  async update(patch: Partial<PrefsData>): Promise<PrefsData> {
    return this.enqueue(async () => {
      const { data: current } = await this.load();
      const next: PrefsData = {
        ...current,
        ...definedPatch<PrefsData>(patch),
        version: PREFS_VERSION,
      };
      await this.writeAtomic(next);
      return next;
    });
  }

  private async load(): Promise<LoadResult> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const result = normalize(JSON.parse(raw));
      return result ?? { data: { ...DEFAULT_PREFS }, needsWriteBack: false };
    } catch {
      return { data: { ...DEFAULT_PREFS }, needsWriteBack: false };
    }
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
