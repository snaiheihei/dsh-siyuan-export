/**
 * T014/T051 · RPC 路由骨架（同源 prefix 路由，不修改 dsh Remote allowlist）
 *
 * 纪律（contracts/rpc.md + develop-dsh-plugin §6）：
 *  - 方法白名单（7 个）、POST JSON、nonce 自定义头、body ≤ 1MB、逐字段校验
 *    （可选参数 `!== undefined`：空字符串按「已提供」处理，不回退）
 *  - 统一信封 `{ok:true,data} | {ok:false,error}`；业务错误（PluginError）与传输错误分开；
 *    响应不含堆栈、内部路径或正文秘密
 *  - 本插件无 dsh 命令面 → 无 recordInput 历史问题；RPC 只记元数据（由调用方约束）
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import {
  RPC_BODY_LIMIT,
  RPC_NONCE_HEADER,
  RPC_NONCE_VALUE,
  RPC_PREFIX,
  type ErrorInfo,
  type ExportCancelData,
  type ExportCancelRequest,
  type ExportCommitData,
  type ExportCommitRequest,
  type ExportOpenData,
  type ExportOpenRequest,
  type ExportStateData,
  type ExportStateRequest,
  type PrefsGetData,
  type PrefsGetRequest,
  type PrefsUpdateData,
  type PrefsUpdateRequest,
  type RpcMethod,
  type RpcResult,
  type TreeListData,
  type TreeListRequest,
} from '../contract';
import { PluginError } from '../errors';

export interface RpcHandlers {
  open(request: ExportOpenRequest): Promise<ExportOpenData>;
  state(request: ExportStateRequest): Promise<ExportStateData>;
  commit(request: ExportCommitRequest): Promise<ExportCommitData>;
  cancel(request: ExportCancelRequest): Promise<ExportCancelData>;
  treeList(request: TreeListRequest): Promise<TreeListData>;
  prefsGet(request: PrefsGetRequest): Promise<PrefsGetData>;
  prefsUpdate(request: PrefsUpdateRequest): Promise<PrefsUpdateData>;
}

export interface DispatchResult {
  status: number;
  payload: RpcResult<unknown>;
}

const RPC_METHODS: readonly RpcMethod[] = [
  'export.open',
  'export.state',
  'export.commit',
  'export.cancel',
  'tree.list',
  'prefs.get',
  'prefs.update',
];

function failure(category: ErrorInfo['category'], message: string, retryable: boolean): ErrorInfo {
  return { category, message, retryable };
}

function envelopeError(status: number, error: ErrorInfo): DispatchResult {
  return { status, payload: { ok: false, error } };
}

function envelopeOk<T>(data: T): DispatchResult {
  return { status: 200, payload: { ok: true, data } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateOpen(body: unknown): string | null {
  if (!isRecord(body)) return 'body 必须是对象';
  for (const field of ['messageId', 'sessionId'] as const) {
    if (!isNonEmptyString(body[field])) return field;
  }
  if (body.intent !== undefined && body.intent !== 'auto' && body.intent !== 'silent') {
    return 'intent';
  }
  return null;
}

function validateTaskId(body: unknown): string | null {
  if (!isRecord(body)) return 'body 必须是对象';
  if (!isNonEmptyString(body.taskId)) return 'taskId';
  return null;
}

function validateStoragePath(value: unknown, field = 'target'): string | null {
  if (!isRecord(value)) return field;
  if (!isNonEmptyString(value.notebookId)) return `${field}.notebookId`;
  if (typeof value.notebookName !== 'string') return `${field}.notebookName`;
  if (typeof value.display !== 'string') return `${field}.display`;
  if (!Array.isArray(value.parentSegments) || !value.parentSegments.every((s) => typeof s === 'string')) {
    return `${field}.parentSegments`;
  }
  return null;
}

function validateCommit(body: unknown): string | null {
  if (!isRecord(body)) return 'body 必须是对象';
  if (!isNonEmptyString(body.taskId)) return 'taskId';
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return 'title';
  return validateStoragePath(body.target);
}

function validateTreeList(body: unknown): string | null {
  if (!isRecord(body)) return 'body 必须是对象';
  for (const field of ['notebookId', 'docId'] as const) {
    const value = body[field];
    if (value !== undefined && typeof value !== 'string') return field;
  }
  return null;
}

function validatePrefsGet(body: unknown): string | null {
  if (!isRecord(body)) return 'body 必须是对象';
  return null;
}

function validatePrefsUpdate(body: unknown): string | null {
  if (!isRecord(body)) return 'body 必须是对象';
  if (body.showDialog !== undefined && typeof body.showDialog !== 'boolean') return 'showDialog';
  if (body.defaultPath !== undefined && body.defaultPath !== null) {
    return validateStoragePath(body.defaultPath, 'defaultPath');
  }
  return null;
}

function validate(method: RpcMethod, body: unknown): string | null {
  switch (method) {
    case 'export.open':
      return validateOpen(body);
    case 'export.state':
    case 'export.cancel':
      return validateTaskId(body);
    case 'export.commit':
      return validateCommit(body);
    case 'tree.list':
      return validateTreeList(body);
    case 'prefs.get':
      return validatePrefsGet(body);
    case 'prefs.update':
      return validatePrefsUpdate(body);
  }
}

/** 纯分发：nonce → 白名单 → 逐字段校验 → handler（可直接单测，不经 HTTP） */
export async function dispatchRpc(
  deps: { handlers: RpcHandlers },
  method: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): Promise<DispatchResult> {
  if (headers[RPC_NONCE_HEADER] !== RPC_NONCE_VALUE) {
    return envelopeError(403, failure('internal', '请求校验失败', false));
  }
  if (!(RPC_METHODS as readonly string[]).includes(method)) {
    return envelopeError(404, failure('internal', '未知方法', false));
  }
  const invalidField = validate(method as RpcMethod, body);
  if (invalidField !== null) {
    return envelopeError(400, failure('internal', `请求参数无效（${invalidField}）`, false));
  }

  try {
    switch (method as RpcMethod) {
      case 'export.open':
        return envelopeOk(await deps.handlers.open(body as ExportOpenRequest));
      case 'export.state':
        return envelopeOk(await deps.handlers.state(body as ExportStateRequest));
      case 'export.commit':
        return envelopeOk(await deps.handlers.commit(body as ExportCommitRequest));
      case 'export.cancel':
        return envelopeOk(await deps.handlers.cancel(body as ExportCancelRequest));
      case 'tree.list':
        return envelopeOk(await deps.handlers.treeList(body as TreeListRequest));
      case 'prefs.get':
        return envelopeOk(await deps.handlers.prefsGet(body as PrefsGetRequest));
      case 'prefs.update':
        return envelopeOk(await deps.handlers.prefsUpdate(body as PrefsUpdateRequest));
    }
  } catch (err) {
    if (err instanceof PluginError) {
      return envelopeError(200, {
        category: err.category,
        message: err.message,
        retryable: err.retryable,
      });
    }
    // 未知错误：不透传消息/栈/路径（业务错误与传输错误分开）
    return envelopeError(200, failure('internal', '内部错误，请稍后重试', false));
  }
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(res: ServerResponse, status: number, payload: RpcResult<unknown>): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 同源 prefix 路由工厂（`/plugins/siyuan-export/<method>`，全部 POST） */
export function createRpcRoute(deps: { handlers: RpcHandlers }): WebRoute {
  return {
    kind: 'prefix',
    path: RPC_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: failure('internal', '仅支持 POST', false) });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://placeholder.local');
        const method = url.pathname.slice(RPC_PREFIX.length).replace(/^\/+/, '');

        const contentLength = Number(req.headers['content-length'] ?? '0');
        if (Number.isFinite(contentLength) && contentLength > RPC_BODY_LIMIT) {
          writeJson(res, 413, { ok: false, error: failure('internal', '请求体超过大小限制', false) });
          return;
        }

        let raw: string;
        try {
          raw = await readBody(req, RPC_BODY_LIMIT);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            writeJson(res, 413, { ok: false, error: failure('internal', '请求体超过大小限制', false) });
          } else {
            writeJson(res, 400, { ok: false, error: failure('internal', '读取请求体失败', false) });
          }
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          writeJson(res, 400, { ok: false, error: failure('internal', '请求不是有效 JSON', false) });
          return;
        }

        const result = await dispatchRpc(deps, method, parsed, req.headers);
        writeJson(res, result.status, result.payload);
      } catch {
        writeJson(res, 500, { ok: false, error: failure('internal', '内部错误，请稍后重试', false) });
      }
    },
  };
}

export interface RouteRegistrar {
  register(route: WebRoute): () => void;
}

/** 注册到宿主 webServer（返回 disposer，交由 ctx.effect 管理） */
export function registerRpcRoute(registrar: RouteRegistrar, handlers: RpcHandlers): () => void {
  return registrar.register(createRpcRoute({ handlers }));
}
