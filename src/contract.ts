/**
 * Host/Client 共享 RPC 类型 —— contracts/rpc.md 的类型化落地。
 * 纯类型 + 常量，无运行时宿主依赖（Client 经 type-only import 引用，不需要 external）。
 */

/** 错误分类 = data-model.md 错误分类表（含 open 时的 empty-source） */
export type ErrorCategory =
  | 'siyuan-auth'
  | 'siyuan-connect'
  | 'siyuan-path'
  | 'llm-adapter'
  | 'llm-quota'
  | 'llm-timeout'
  | 'llm-structure'
  | 'empty-source'
  | 'internal';

/** 用户可读错误信息；message 为中文文案，禁止堆栈/内部路径/正文秘密 */
export interface ErrorInfo {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
}

/** 存放路径：笔记本 + 文档层级（data-model §3） */
export interface StoragePath {
  notebookId: string;
  notebookName: string;
  parentSegments: string[];
  display: string;
}

/** 导出任务状态机的状态集合（data-model §5） */
export type TaskStatus =
  | 'generating'
  | 'ready'
  | 'degraded-ready'
  | 'writing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** 打开导出；contentRevision 不由 Client 传——Host 读取正文后自行派生（data-model §1） */
export interface ExportOpenRequest {
  messageId: string;
  sessionId: string;
}

export interface ExportOpenData {
  taskId: string;
  status: TaskStatus;
  /** LLM 默认主题名；generating 中为 null */
  title: string | null;
  /** Prefs.lastPath（FR-006），首次为 null */
  lastPath: StoragePath | null;
  error: ErrorInfo | null;
}

export interface ExportStateRequest {
  taskId: string;
}

export interface ExportStateData {
  status: TaskStatus;
  title: string | null;
  /** 永不返回 body（正文仅 Host 持有） */
  error: ErrorInfo | null;
}

export interface ExportCommitRequest {
  taskId: string;
  title: string;
  target: StoragePath;
}

export interface ExportCommitData {
  status: 'succeeded';
  target: StoragePath;
  /** 用于「已导出到…」反馈（FR-012） */
  href: string | null;
}

export interface ExportCancelRequest {
  taskId: string;
}

export interface ExportCancelData {
  status: 'cancelled' | 'noop';
}

/** 可选参数语义：!== undefined（空字符串不回退为未提供） */
export interface TreeListRequest {
  notebookId?: string;
  docId?: string;
}

export interface TreeNode {
  id: string;
  name: string;
  kind: 'notebook' | 'doc';
  notebookId: string;
  hasChildren: boolean;
  /** 选中即 StoragePath.parentSegments */
  path: string[];
}

export interface TreeListData {
  nodes: TreeNode[];
}

/** 方法白名单（仅此 5 个，其余一律拒绝） */
export type RpcMethod =
  | 'export.open'
  | 'export.state'
  | 'export.commit'
  | 'export.cancel'
  | 'tree.list';

/** 方法 → 请求/响应映射 */
export interface RpcContractMap {
  'export.open': { req: ExportOpenRequest; res: ExportOpenData };
  'export.state': { req: ExportStateRequest; res: ExportStateData };
  'export.commit': { req: ExportCommitRequest; res: ExportCommitData };
  'export.cancel': { req: ExportCancelRequest; res: ExportCancelData };
  'tree.list': { req: TreeListRequest; res: TreeListData };
}

/** 统一响应信封 */
export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorInfo };

/** 同源 prefix（webServer.register，不改 dsh Remote allowlist） */
export const RPC_PREFIX = '/plugins/siyuan-export';

/** 自定义请求头（防简单 CSRF/误调） */
export const RPC_NONCE_HEADER = 'x-siyuan-export-nonce';

/** nonce 固定值：自定义头使跨域表单无法简单投递（轻量防护，非机密） */
export const RPC_NONCE_VALUE = 'dsh-siyuan-export';

/** body 上限 1MB（对齐 body 尺寸上限） */
export const RPC_BODY_LIMIT = 1024 * 1024;

/** 轮询参数：500ms + jitter（contracts/rpc.md） */
export const RPC_POLL_INTERVAL_MS = 500;
