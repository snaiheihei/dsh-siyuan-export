/**
 * Client 侧类型化同源请求（T006 = 共享类型；T024 追加具体请求与轮询实现）。
 * 仅 type-only 引用共享契约，不需要 external（develop-dsh-plugin §3）。
 */
export type {
  ErrorCategory,
  ErrorInfo,
  StoragePath,
  TaskStatus,
  ExportOpenRequest,
  ExportOpenData,
  ExportStateRequest,
  ExportStateData,
  ExportCommitRequest,
  ExportCommitData,
  ExportCancelRequest,
  ExportCancelData,
  TreeListRequest,
  TreeNode,
  TreeListData,
  RpcMethod,
  RpcContractMap,
  RpcResult,
} from '../../src/contract';

export {
  RPC_PREFIX,
  RPC_NONCE_HEADER,
  RPC_NONCE_VALUE,
  RPC_BODY_LIMIT,
  RPC_POLL_INTERVAL_MS,
} from '../../src/contract';
