import { describe, expect, it } from 'vitest';
import { SiyuanClient, SiyuanError, createNote } from '../../src/siyuan/client';

/**
 * T010/T011 · SiYuan 适配器（seam：HTTP 边界 —— 注入 fetchImpl）
 * 抓到什么：双失败形态分类（非 2xx / 200+code!=0）、超时与调用方中止的区分、
 *   retryable 限次退避、Token 不进错误消息、同名消歧与标题 '/' 净化。
 * 抓不到什么：真实思源行为与网络（归 quickstart V3/V6/V7）、文档树语义（T029）。
 * 红→绿：src/siyuan/client.ts 尚不存在 → 本文件先红。
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function queuedFake(responses: Response[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    calls.push({ url: String(input), body, headers });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!res) throw new Error('queuedFake: no more responses');
    return res;
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: FetchLike, extra: { timeoutMs?: number } = {}): SiyuanClient {
  return new SiyuanClient({
    endpoint: 'http://127.0.0.1:6806',
    token: 'TOPSECRET-TOKEN',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    backoffMs: 0,
    ...extra,
  });
}

async function expectSiyuanError(p: Promise<unknown>): Promise<SiyuanError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SiyuanError);
    return err as SiyuanError;
  }
  throw new Error('expected SiyuanError, but resolved');
}

describe('SiyuanClient.post', () => {
  it('code=0 → 返回 data；请求头带 Authorization: Token <token>', async () => {
    const { fetchImpl, calls } = queuedFake([jsonResponse(200, { code: 0, msg: '', data: ['nb-1'] })]);
    const client = makeClient(fetchImpl);
    const data = await client.post<string[]>('/api/notebook/lsNotebooks', {});
    expect(data).toEqual(['nb-1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:6806/api/notebook/lsNotebooks');
    expect(calls[0]!.headers['Authorization']).toBe('Token TOPSECRET-TOKEN');
  });

  it('网络失败 → siyuan-connect 可重试，消息不含栈/URL/token', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await expectSiyuanError(makeClient(fetchImpl).post('/api/system/version', {}));
    expect(err.category).toBe('siyuan-connect');
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('fetch failed');
    expect(err.message).not.toContain('http');
    expect(err.message).not.toContain('TOPSECRET');
    expect(err.stack ?? '').not.toContain('127.0.0.1');
  });

  it('HTTP 401 → siyuan-auth 不可重试；消息引导配置 Token 且不含 token 值', async () => {
    const err = await expectSiyuanError(
      makeClient(queuedFake([jsonResponse(401, { error: 'unauthorized' })]).fetchImpl).post('/api/system/version', {}),
    );
    expect(err.category).toBe('siyuan-auth');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('API token');
    expect(err.message).not.toContain('TOPSECRET');
  });

  it('HTTP 500 → siyuan-connect 可重试；404 → siyuan-path 不可重试', async () => {
    const e500 = await expectSiyuanError(
      makeClient(queuedFake([jsonResponse(500, {})]).fetchImpl).post('/api/x', {}),
    );
    expect(e500.category).toBe('siyuan-connect');
    expect(e500.retryable).toBe(true);

    const e404 = await expectSiyuanError(
      makeClient(queuedFake([jsonResponse(404, {})]).fetchImpl).post('/api/x', {}),
    );
    expect(e404.category).toBe('siyuan-path');
    expect(e404.retryable).toBe(false);
  });

  it('200 + code!=0 认证类 → siyuan-auth；路径类 → siyuan-path', async () => {
    const auth = await expectSiyuanError(
      makeClient(queuedFake([jsonResponse(200, { code: -1, msg: 'session expired' })]).fetchImpl).post('/api/x', {}),
    );
    expect(auth.category).toBe('siyuan-auth');

    const path = await expectSiyuanError(
      makeClient(queuedFake([jsonResponse(200, { code: -1, msg: 'pathAmbiguous' })]).fetchImpl).post('/api/x', {}),
    );
    expect(path.category).toBe('siyuan-path');
    expect(path.retryable).toBe(false);
  });

  it('200 + code!=0 未知类 → internal，不透传原始 msg（防路径泄漏）但带 code', async () => {
    const err = await expectSiyuanError(
      makeClient(
        queuedFake([jsonResponse(200, { code: -7, msg: 'weird-internal-detail /data/nb/doc' })]).fetchImpl,
      ).post('/api/x', {}),
    );
    expect(err.category).toBe('internal');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('weird-internal-detail');
    expect(err.message).not.toContain('/data/nb/doc');
    expect(err.message).toContain('-7');
  });

  it('响应非 JSON → siyuan-connect 不可重试', async () => {
    const fetchImpl: FetchLike = async () => new Response('<html>oops</html>', { status: 200 });
    const err = await expectSiyuanError(makeClient(fetchImpl).post('/api/x', {}));
    expect(err.category).toBe('siyuan-connect');
    expect(err.retryable).toBe(false);
  });

  it('超时 → siyuan-connect 可重试（超时文案）', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const err = await expectSiyuanError(
      makeClient(fetchImpl, { timeoutMs: 15 }).post('/api/system/version', {}),
    );
    expect(err.category).toBe('siyuan-connect');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('超时');
  });

  it('调用方 abort → 原样抛出（非 SiyuanError，供上层转 cancelled）', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const ac = new AbortController();
    ac.abort();
    try {
      await makeClient(fetchImpl).post('/api/x', {}, ac.signal);
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(SiyuanError);
    }
  });

  it('postWithRetry：retryable 失败后重试至成功（attempts=2）；不可重试立即停', async () => {
    let n = 0;
    const flaky: FetchLike = async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { code: 0, msg: '', data: 'ok' });
    };
    const client = makeClient(flaky);
    const data = await client.postWithRetry<string>('/api/system/version', {});
    expect(data).toBe('ok');
    expect(n).toBe(2);

    let m = 0;
    const denied: FetchLike = async () => {
      m += 1;
      return jsonResponse(401, {});
    };
    await expectSiyuanError(makeClient(denied).postWithRetry('/api/x', {}));
    expect(m).toBe(1);
  });
});

describe('createNote（T011 同名消歧）', () => {
  const ok = (data: unknown) => jsonResponse(200, { code: 0, msg: '', data });

  it('无同名 → 直接创建，path = /父级/标题；markdown 原样传递', async () => {
    const { fetchImpl, calls } = queuedFake([ok([]), ok('doc-1')]);
    const result = await createNote({
      client: makeClient(fetchImpl),
      notebookId: 'nb-1',
      parentHPath: '/父级',
      title: '标题',
      markdown: '# hi',
    });
    expect(result).toEqual({ id: 'doc-1', hpath: '/父级/标题' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ notebook: 'nb-1', path: '/父级/标题' });
    expect(calls[1]!.body).toMatchObject({ notebook: 'nb-1', path: '/父级/标题', markdown: '# hi' });
  });

  it('已有同名 → 依次尝试 (2) 后缀再建', async () => {
    const { fetchImpl, calls } = queuedFake([ok(['existing-id']), ok([]), ok('doc-2')]);
    const result = await createNote({
      client: makeClient(fetchImpl),
      notebookId: 'nb-1',
      parentHPath: '/父级',
      title: '标题',
      markdown: 'body',
    });
    expect(result.id).toBe('doc-2');
    expect(result.hpath).toBe('/父级/标题 (2)');
    expect(calls[1]!.body.path).toBe('/父级/标题 (2)');
  });

  it("标题含 / → 净化为全角 ／（防 pathAmbiguous）", async () => {
    const { fetchImpl, calls } = queuedFake([ok([]), ok('doc-3')]);
    const result = await createNote({
      client: makeClient(fetchImpl),
      notebookId: 'nb-1',
      parentHPath: '',
      title: 'a/b',
      markdown: 'x',
    });
    expect(result.hpath).toBe('/a／b');
    expect(calls[1]!.body.path).toBe('/a／b');
  });

  it('同名超过上限 → siyuan-path 不可重试', async () => {
    const responses = Array.from({ length: 12 }, () => ok(['occupied']));
    const { fetchImpl } = queuedFake(responses);
    const err = await expectSiyuanError(
      createNote({
        client: makeClient(fetchImpl),
        notebookId: 'nb-1',
        parentHPath: '/p',
        title: 't',
        markdown: 'm',
        maxSuffix: 3,
      }),
    );
    expect(err.category).toBe('siyuan-path');
    expect(err.retryable).toBe(false);
  });
});
