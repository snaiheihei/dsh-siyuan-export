/**
 * T010/T011 · SiYuan HTTP API 适配器（宿主侧唯一出口）
 *
 * 纪律（contracts/siyuan.md）：
 *  - Token 只经 Config 注入本类，不写日志/审计/状态文件/RPC 响应
 *  - 同时处理「非 2xx」与「200 但 code!=0」两种失败形态
 *  - 错误分类：siyuan-auth / siyuan-connect / siyuan-path / internal；message 为
 *    用户可读中文，不含堆栈、内部路径、原始 msg 透传或 token 值
 *  - AbortSignal（调用方取消与超时可区分）+ 有限超时 + retryable 限次退避
 */
import { PluginError } from '../errors';

/** SiYuan 域错误（统一 PluginError 形态；`instanceof SiyuanError` 判定保持有效） */
export class SiyuanError extends PluginError {}

export interface SiyuanClientOptions {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** 单次请求超时，默认 15000ms */
  timeoutMs?: number;
  /** retryable 退避基数（指数），默认 250ms；测试传 0 */
  backoffMs?: number;
  /** postWithRetry 最大尝试次数，默认 3 */
  maxAttempts?: number;
}

const AUTH_MESSAGE =
  '思源鉴权失败，请在思源「设置 → 鉴权 → API token」检查 Token，并在插件配置中更新';
const PATH_404_MESSAGE = '思源中找不到目标位置，请重新选择存放路径';

function makeAbortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 业务错误分类（code != 0 的 msg 只做归类，不透传原文） */
function classifyBusinessMessage(msg: string, code: number): SiyuanError {
  if (/auth|token|session|forbidden|login|unauthorized/i.test(msg)) {
    return new SiyuanError('siyuan-auth', AUTH_MESSAGE, false);
  }
  if (/pathAmbiguous|indexUnavailable|not\s*found|invalid\s*path/i.test(msg)) {
    return new SiyuanError('siyuan-path', '思源路径无效（祖先标题可能含 / 或为空），请重新选择存放位置', false);
  }
  return new SiyuanError('internal', `思源返回错误（code ${code}）`, false);
}

export class SiyuanClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly maxAttempts: number;

  constructor(options: SiyuanClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.backoffMs = options.backoffMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  private url(path: string): string {
    return this.endpoint + (path.startsWith('/') ? path : `/${path}`);
  }

  /** 单次 POST：返回 code=0 的 data；失败抛 SiyuanError（调用方取消原样抛出） */
  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    const onCallerAbort = (): void => ctrl.abort();
    if (signal) {
      if (signal.aborted) onCallerAbort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let res: Response;
    try {
      if (ctrl.signal.aborted) throw makeAbortError();
      res = await this.fetchImpl(this.url(path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${this.token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
    } catch {
      if (signal?.aborted) throw makeAbortError(); // 调用方取消 → 原样形态（上层转 cancelled）
      if (timedOut) throw new SiyuanError('siyuan-connect', '连接思源超时，请稍后重试', true);
      throw new SiyuanError('siyuan-connect', '无法连接思源服务，请确认思源正在运行', true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }

    // 失败形态一：非 2xx
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) throw new SiyuanError('siyuan-auth', AUTH_MESSAGE, false);
      if (status === 404) throw new SiyuanError('siyuan-path', PATH_404_MESSAGE, false);
      if (status >= 500 || status === 429) {
        throw new SiyuanError('siyuan-connect', `思源服务暂时不可用（HTTP ${status}），请稍后重试`, true);
      }
      throw new SiyuanError('internal', `思源接口拒绝了请求（HTTP ${status}）`, false);
    }

    // 响应体解析
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new SiyuanError('siyuan-connect', '思源返回了无法解析的响应', false);
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new SiyuanError('siyuan-connect', '思源返回了无法解析的响应', false);
    }
    const parsed = payload as { code?: unknown; msg?: unknown; data?: unknown };
    if (typeof parsed.code !== 'number') {
      throw new SiyuanError('siyuan-connect', '思源返回了无法解析的响应', false);
    }

    // 失败形态二：200 但 code != 0
    if (parsed.code !== 0) {
      const msg = typeof parsed.msg === 'string' ? parsed.msg : '';
      throw classifyBusinessMessage(msg, parsed.code);
    }
    return parsed.data as T;
  }

  /** retryable 限次指数退避；不可重试错误立即抛出 */
  async postWithRetry<T>(
    path: string,
    body: unknown,
    opts: { signal?: AbortSignal; attempts?: number } = {},
  ): Promise<T> {
    const max = opts.attempts ?? this.maxAttempts;
    let lastError: unknown;
    for (let attempt = 0; attempt < max; attempt += 1) {
      try {
        return await this.post<T>(path, body, opts.signal);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof SiyuanError && err.retryable;
        const cancelled = opts.signal?.aborted === true;
        if (retryable && !cancelled && attempt < max - 1) {
          await sleep(this.backoffMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** 探活：POST /api/system/version */
  async version(signal?: AbortSignal): Promise<unknown> {
    return this.post<unknown>('/api/system/version', {}, signal);
  }
}

export interface CreateNoteOptions {
  client: SiyuanClient;
  notebookId: string;
  /** 父级 hpath（'' = 笔记本根） */
  parentHPath: string;
  title: string;
  markdown: string;
  signal?: AbortSignal;
  /** 同名后缀上限，默认 10 */
  maxSuffix?: number;
}

export interface CreateNoteResult {
  id: string;
  hpath: string;
}

function joinHPath(parent: string, title: string): string {
  return `${parent.replace(/\/+$/, '')}/${title}`;
}

/**
 * T011 · 建文档 + 同名消歧（FR-007 硬保证「不覆盖、独立文档」）：
 * 创建前用 getIDsByHPath 查重，命中依次追加 ` (2)`、` (3)`…；标题内 ASCII `/` 净化为全角 ／。
 */
export async function createNote(options: CreateNoteOptions): Promise<CreateNoteResult> {
  const { client, notebookId, markdown, signal } = options;
  const safeTitle = options.title.replace(/\//g, '／');
  const base = joinHPath(options.parentHPath, safeTitle);
  const max = options.maxSuffix ?? 10;

  for (let n = 0; n < max; n += 1) {
    const candidate = n === 0 ? base : `${base} (${n + 1})`;
    const ids = await client.post<string[]>(
      '/api/filetree/getIDsByHPath',
      { notebook: notebookId, path: candidate },
      signal,
    );
    if (!Array.isArray(ids) || ids.length === 0) {
      const id = await client.post<string>(
        '/api/filetree/createDocWithMd',
        { notebook: notebookId, path: candidate, markdown },
        signal,
      );
      return { id, hpath: candidate };
    }
  }
  throw new SiyuanError('siyuan-path', '同名文档过多，无法自动选择新位置，请更换标题', false);
}
