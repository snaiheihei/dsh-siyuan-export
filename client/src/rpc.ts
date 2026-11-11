/**
 * Client 侧类型化同源请求（T006 共享类型 + T024 实现）
 *
 * 纪律（contracts/rpc.md + develop-dsh-plugin §7）：
 *  - POST + JSON + nonce 自定义头；统一信封 {ok:true,data} | {ok:false,error}
 *  - ok:false → 抛带 category/retryable 的错误（UI 按类展示引导文案）
 *  - 轮询 500ms + jitter，终态即停；stale taskId 响应丢弃（不覆盖新弹窗）
 *  - 仅 type-only 引用共享契约（不需要 external）
 */
export type {
  ErrorCategory,
  ErrorInfo,
  StoragePath,
  TargetFrom,
  TaskStatus,
  ExportMode,
  ExportIntent,
  ExportOpenRequest,
  ExportOpenData,
  ExportDialogOpenData,
  ExportSilentOpenData,
  ExportStateRequest,
  ExportStateData,
  ExportCommitRequest,
  ExportCommitData,
  ExportCancelRequest,
  ExportCancelData,
  TreeListRequest,
  TreeNode,
  TreeListData,
  PrefsView,
  PrefsGetRequest,
  PrefsGetData,
  PrefsUpdateRequest,
  PrefsUpdateData,
  RpcMethod,
  RpcContractMap,
  RpcResult,
} from '../../src/contract';

import {
  RPC_NONCE_HEADER,
  RPC_NONCE_VALUE,
  RPC_PREFIX,
  RPC_POLL_INTERVAL_MS,
  type ErrorInfo,
  type ExportCancelData,
  type ExportCommitData,
  type ExportOpenData,
  type ExportOpenRequest,
  type ExportStateData,
  type PrefsUpdateData,
  type PrefsUpdateRequest,
  type PrefsView,
  type RpcResult,
  type StoragePath,
  type TreeListData,
  type TreeListRequest,
} from '../../src/contract';

/** Client 侧错误（保留 category/retryable 供 UI 分类） */
export class ClientRpcError extends Error {
  readonly category: ErrorInfo['category'];
  readonly retryable: boolean;

  constructor(category: ErrorInfo['category'], message: string, retryable: boolean) {
    super(message);
    this.name = 'ClientRpcError';
    this.category = category;
    this.retryable = retryable;
  }
}

export interface ExportClientOptions {
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

export interface PollOptions {
  /** 当前任务是否仍有效（stale 防护）：false 时忽略响应 */
  isCurrent?: (taskId: string) => boolean;
  /** 终态判定（默认：generating/writing 之外即终态） */
  isSettled?: (status: string) => boolean;
}

const DEFAULT_SETTLED = (status: string): boolean =>
  status !== 'generating' && status !== 'writing';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExportClient {
  open(request: ExportOpenRequest): Promise<ExportOpenData>;
  state(taskId: string): Promise<ExportStateData>;
  commit(request: { taskId: string; title: string; target: StoragePath }): Promise<ExportCommitData>;
  cancel(taskId: string): Promise<ExportCancelData>;
  treeList(request: TreeListRequest): Promise<TreeListData>;
  prefsGet(): Promise<PrefsView>;
  prefsUpdate(request: PrefsUpdateRequest): Promise<PrefsUpdateData>;
  pollUntilSettled(taskId: string, options?: PollOptions): Promise<ExportStateData>;
}

export function createExportClient(options: ExportClientOptions = {}): ExportClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollInterval = options.pollIntervalMs ?? RPC_POLL_INTERVAL_MS;

  async function call<T>(method: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${RPC_PREFIX}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [RPC_NONCE_HEADER]: RPC_NONCE_VALUE,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ClientRpcError('internal', '无法连接宿主服务，请稍后重试', true);
    }

    let payload: RpcResult<T>;
    try {
      payload = (await response.json()) as RpcResult<T>;
    } catch {
      throw new ClientRpcError('internal', '宿主返回了无法解析的响应', true);
    }
    if (!payload || typeof payload !== 'object') {
      throw new ClientRpcError('internal', '宿主返回了无法解析的响应', true);
    }
    if (payload.ok) return payload.data;
    throw new ClientRpcError(payload.error.category, payload.error.message, payload.error.retryable);
  }

  return {
    open: (request) => call<ExportOpenData>('export.open', request),
    state: (taskId) => call<ExportStateData>('export.state', { taskId }),
    commit: (request) => call<ExportCommitData>('export.commit', request),
    cancel: (taskId) => call<ExportCancelData>('export.cancel', { taskId }),
    treeList: (request) => call<TreeListData>('tree.list', request),
    prefsGet: () => call<PrefsView>('prefs.get', {}),
    prefsUpdate: (request) => call<PrefsUpdateData>('prefs.update', request),

    async pollUntilSettled(taskId: string, pollOptions: PollOptions = {}): Promise<ExportStateData> {
      const isCurrent = pollOptions.isCurrent ?? (() => true);
      const isSettled = pollOptions.isSettled ?? DEFAULT_SETTLED;
      for (;;) {
        // jitter：避免多标签页/多弹窗同频轮询
        await sleep(pollInterval + Math.floor(Math.random() * 100));
        const state = await call<ExportStateData>('export.state', { taskId });
        if (!isCurrent(taskId)) {
          // stale：忽略该响应（返回未就绪的占位，不覆盖上层状态）
          return {
            mode: 'dialog',
            status: 'generating',
            title: null,
            target: null,
            href: null,
            degraded: false,
            error: null,
          };
        }
        if (isSettled(state.status)) return state;
      }
    },
  };
}
