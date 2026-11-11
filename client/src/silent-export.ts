/**
 * T060 · 静默任务单例（Client 侧）
 *
 * 纪律（FR-019/FR-025）：
 *  - 粒度与 Host 幂等键同粒度：`sessionId:messageId`；同一回复重复点击复用任务
 *  - 轮询归单例所有：组件卸载（切会话/关面板）只退订，不取消、不丢终态
 *  - 终态保留在内存映射中，重新挂载可直接恢复（toast 按 taskId 归属）
 *  - 重试仍走静默通道（`intent:'silent'`），并发重复重试只发一次
 */
import type {
  ErrorInfo,
  ExportOpenData,
  ExportOpenRequest,
  ExportSilentOpenData,
  ExportStateData,
  StoragePath,
  TargetFrom,
} from '../../src/contract';
import { ClientRpcError } from './rpc';

export type SilentStatus = 'generating' | 'writing' | 'succeeded' | 'failed';

export interface SilentExportInput {
  messageId: string;
  sessionId: string;
}

export interface SilentTaskView {
  /** `sessionId:messageId` */
  key: string;
  messageId: string;
  sessionId: string;
  taskId: string;
  status: SilentStatus;
  title: string | null;
  target: StoragePath | null;
  targetFrom: TargetFrom | null;
  href: string | null;
  degraded: boolean;
  error: ErrorInfo | null;
}

/** 静默任务依赖的最小 RPC 面（fake 可直接实现） */
export interface SilentClientLike {
  open(request: ExportOpenRequest): Promise<ExportOpenData>;
  pollUntilSettled(
    taskId: string,
    options?: { isCurrent?: (taskId: string) => boolean },
  ): Promise<ExportStateData>;
}

export function silentTaskKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

function toSilentStatus(status: string): SilentStatus {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'writing') return 'writing';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  // generating / ready / degraded-ready 均视为仍在进行（静默会紧接着自动写入）
  return 'generating';
}

function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof ClientRpcError) {
    return { category: err.category, message: err.message, retryable: err.retryable };
  }
  return { category: 'internal', message: '导出失败，请稍后重试', retryable: false };
}

export interface SilentExportManagerOptions {
  client: SilentClientLike;
  /** 每个任务首次进入终态时回调一次（toast 桥接；跨卸载不丢） */
  onSettled?: (view: SilentTaskView) => void;
}

export class SilentExportManager {
  private readonly client: SilentClientLike;
  private readonly onSettled?: (view: SilentTaskView) => void;
  private readonly tasks = new Map<string, SilentTaskView>();
  private readonly retries = new Map<string, Promise<SilentTaskView>>();
  private readonly listeners = new Set<(view: SilentTaskView) => void>();
  /** 已发过终态通知的 `key:taskId`，重试复用同一 taskId 时不重复弹 toast */
  private readonly settled = new Set<string>();

  constructor(options: SilentExportManagerOptions) {
    this.client = options.client;
    this.onSettled = options.onSettled;
  }

  get(key: string): SilentTaskView | null {
    return this.tasks.get(key) ?? null;
  }

  subscribe(listener: (view: SilentTaskView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 登记一次静默 open 的响应并接管轮询。
   * 同键进行中/已成功的任务直接返回既有值（重复点击不重启流水线）；失败态允许被新响应替换。
   */
  track(input: SilentExportInput, opened: ExportSilentOpenData): SilentTaskView {
    const key = silentTaskKey(input.sessionId, input.messageId);
    const existing = this.tasks.get(key);
    if (existing && existing.status !== 'failed') return existing;

    const view: SilentTaskView = {
      key,
      messageId: input.messageId,
      sessionId: input.sessionId,
      taskId: opened.taskId,
      status: opened.status,
      title: null,
      target: opened.target,
      targetFrom: opened.targetFrom,
      href: null,
      degraded: opened.degraded,
      error: opened.error,
    };
    this.tasks.set(key, view);
    this.emit(view);

    if (view.status !== 'failed') void this.poll(key, opened.taskId);
    return view;
  }

  /** 重试失败任务（仍为静默通道）；并发重试共享同一 promise */
  retry(key: string): Promise<SilentTaskView> {
    const existing = this.tasks.get(key);
    if (!existing) {
      return Promise.reject(new ClientRpcError('internal', '导出任务不存在', false));
    }
    if (existing.status !== 'failed') return Promise.resolve(existing);

    const inflight = this.retries.get(key);
    if (inflight) return inflight;

    // Host 的 taskId 就是幂等键，重试会复用同一 taskId；不清掉旧终态标记，
    // 重试成功/再失败都不会再通知（toast 永远停在第一次失败）。
    this.clearSettled(key);

    const run = (async (): Promise<SilentTaskView> => {
      try {
        const opened = await this.client.open({
          messageId: existing.messageId,
          sessionId: existing.sessionId,
          intent: 'silent',
        });
        if (opened.mode !== 'silent') {
          throw new ClientRpcError('internal', '该回复正在弹窗处理中，请在弹窗内完成导出', false);
        }
        return this.track(existing, opened);
      } catch (err) {
        const current = this.tasks.get(key) ?? existing;
        current.status = 'failed';
        current.error = toErrorInfo(err);
        this.tasks.set(key, current);
        this.emit(current);
        return current;
      } finally {
        this.retries.delete(key);
      }
    })();

    this.retries.set(key, run);
    return run;
  }

  private async poll(key: string, taskId: string): Promise<void> {
    try {
      const state = await this.client.pollUntilSettled(taskId, {
        isCurrent: (id) => this.tasks.get(key)?.taskId === id,
      });
      const current = this.tasks.get(key);
      if (!current || current.taskId !== taskId) return; // stale：任务已被替换
      current.status = toSilentStatus(state.status);
      current.title = state.title;
      current.target = state.target ?? current.target;
      current.href = state.href;
      current.degraded = state.degraded;
      current.error = state.error;
      this.emit(current);
    } catch (err) {
      const current = this.tasks.get(key);
      if (!current || current.taskId !== taskId) return;
      current.status = 'failed';
      current.error = toErrorInfo(err);
      this.emit(current);
    }
  }

  private clearSettled(key: string): void {
    const prefix = `${key}:`;
    for (const entry of this.settled) {
      if (entry.startsWith(prefix)) this.settled.delete(entry);
    }
  }

  private emit(view: SilentTaskView): void {
    // 快照：内部对象原地更新，订阅方（React setState）需要新引用才会重渲染
    const snapshot: SilentTaskView = { ...view };
    for (const listener of this.listeners) listener(snapshot);
    if (snapshot.status === 'succeeded' || snapshot.status === 'failed') {
      const settledKey = `${snapshot.key}:${snapshot.taskId}`;
      if (!this.settled.has(settledKey)) {
        this.settled.add(settledKey);
        this.onSettled?.(snapshot);
      }
    }
  }
}
