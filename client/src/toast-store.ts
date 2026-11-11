/**
 * T062 · 非阻塞 toast 队列（与 React 解耦的纯状态层）
 *
 * 纪律：
 *  - 快照不可变：`list()` 返回稳定引用，供 `useSyncExternalStore` 判等
 *  - 成功/降级约 6s 自动消失；失败常驻（等待用户重试或打开设置）
 *  - 栈上限 3，超出淘汰最旧并清理其定时器
 */
import type { ErrorInfo, StoragePath } from '../../src/contract';

export type ToastKind = 'success' | 'failure';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  /** `sessionId:messageId`；失败时供重试定位任务 */
  taskKey: string | null;
  title: string | null;
  target: StoragePath | null;
  href: string | null;
  degraded: boolean;
  error: ErrorInfo | null;
}

export type ToastDraft = Omit<ToastItem, 'id'>;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface ToastTimers {
  setTimeout(callback: () => void, ms: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

export interface ToastStoreOptions {
  autoDismissMs?: number;
  max?: number;
  timers?: ToastTimers;
}

export const SUCCESS_TOAST_MS = 6000;
export const MAX_TOASTS = 3;

const defaultTimers: ToastTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class ToastStore {
  private readonly autoDismissMs: number;
  private readonly max: number;
  private readonly timers: ToastTimers;
  private readonly timerHandles = new Map<string, TimeoutHandle>();
  private readonly listeners = new Set<() => void>();
  private items: ToastItem[] = [];
  private snapshot: readonly ToastItem[] = [];
  private seq = 0;

  constructor(options: ToastStoreOptions = {}) {
    this.autoDismissMs = options.autoDismissMs ?? SUCCESS_TOAST_MS;
    this.max = options.max ?? MAX_TOASTS;
    this.timers = options.timers ?? defaultTimers;
  }

  /** 稳定快照（仅变更时换引用），可直接作为 useSyncExternalStore 的 getSnapshot */
  readonly list = (): readonly ToastItem[] => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  push(draft: ToastDraft): ToastItem {
    const item: ToastItem = { ...draft, id: `toast-${(this.seq += 1)}` };
    const next = [...this.items, item];
    while (next.length > this.max) {
      const evicted = next.shift()!;
      this.clearTimer(evicted.id);
    }
    this.items = next;
    if (item.kind === 'success') {
      this.timerHandles.set(
        item.id,
        this.timers.setTimeout(() => this.dismiss(item.id), this.autoDismissMs),
      );
    }
    this.commit();
    return item;
  }

  dismiss(id: string): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.clearTimer(id);
    this.items = next;
    this.commit();
  }

  private clearTimer(id: string): void {
    const handle = this.timerHandles.get(id);
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this.timerHandles.delete(id);
  }

  private commit(): void {
    this.snapshot = [...this.items];
    for (const listener of this.listeners) listener();
  }
}
