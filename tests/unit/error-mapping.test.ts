import { describe, expect, it } from 'vitest';
import { SiyuanClient, SiyuanError } from '../../src/siyuan/client';
import { LlmError, createHostLlmGateway } from '../../src/export/llm';
import type { LlmHostLike } from '../../src/export/llm';

/**
 * T034 · 错误分类映射（seam：HTTP 边界 + LLM 宿主边界）
 * 抓到什么：T010/T012 尚未覆盖的分类分支——
 *   siyuan 429 → connect 可重试、indexUnavailable → siyuan-path、
 *   LLM finish failure 的 status/code 分类（429→quota、504→timeout、no-adapter→adapter）、
 *   未知 failure → adapter 可重试。
 * 抓不到什么：真实思源/真实模型错误（归 T037 注入故障 E2E）。
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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

describe('SiYuan 错误分类（T034 补充分支）', () => {
  it('HTTP 429 → siyuan-connect 可重试', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(429, {});
    const client = new SiyuanClient({
      endpoint: 'http://127.0.0.1:6806',
      token: 'T',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 0,
    });
    const err = await expectSiyuanError(client.post('/api/x', {}));
    expect(err.category).toBe('siyuan-connect');
    expect(err.retryable).toBe(true);
  });

  it('200 + code!=0 indexUnavailable → siyuan-connect 可重试（瞬时，实测纠正）', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { code: -1, msg: 'indexUnavailable', data: null });
    const client = new SiyuanClient({
      endpoint: 'http://127.0.0.1:6806',
      token: 'T',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 0,
    });
    const err = await expectSiyuanError(client.post('/api/x', {}));
    expect(err.category).toBe('siyuan-connect');
    expect(err.retryable).toBe(true);
  });

  it('200 + code!=0 未知业务错误 → internal 不透传原始 msg', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { code: -42, msg: 'some/internal/detail', data: null });
    const client = new SiyuanClient({
      endpoint: 'http://127.0.0.1:6806',
      token: 'T',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 0,
    });
    const err = await expectSiyuanError(client.post('/api/x', {}));
    expect(err.category).toBe('internal');
    expect(err.message).not.toContain('some/internal/detail');
    expect(err.message).toContain('-42');
  });
});

/** 构造带 finish failure 的假宿主 LLM */
function llmWithFailure(failure: {
  message: string;
  code: string;
  status?: number;
}): LlmHostLike {
  const plain = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm', name: 'M' }],
    prepareCall: async () => ({
      stream: () =>
        (async function* () {
          yield {
            type: 'finish',
            reason: { kind: 'error', failure },
          } as never;
        })(),
    }),
  };
  return plain as unknown as LlmHostLike;
}

describe('LLM finish failure 分类（T034 补充分支）', () => {
  it('status 429 → llm-quota 可重试', async () => {
    const gateway = createHostLlmGateway(llmWithFailure({ message: 'rate limited', code: 'RATE_LIMIT', status: 429 }));
    await expect(gateway.generate({ content: 'x' })).rejects.toMatchObject({
      category: 'llm-quota',
      retryable: true,
    });
  });

  it('status 504 → llm-timeout 可重试', async () => {
    const gateway = createHostLlmGateway(llmWithFailure({ message: 'gateway timeout', code: 'GATEWAY_TIMEOUT', status: 504 }));
    await expect(gateway.generate({ content: 'x' })).rejects.toMatchObject({
      category: 'llm-timeout',
      retryable: true,
    });
  });

  it('code 含 no-adapter → llm-adapter 不可重试', async () => {
    const gateway = createHostLlmGateway(llmWithFailure({ message: 'no adapter', code: 'NO_ADAPTER' }));
    await expect(gateway.generate({ content: 'x' })).rejects.toMatchObject({
      category: 'llm-adapter',
      retryable: false,
    });
  });

  it('未知 provider failure → llm-adapter 可重试（保守重试）', async () => {
    const gateway = createHostLlmGateway(llmWithFailure({ message: 'upstream 500', code: 'UPSTREAM_ERROR' }));
    await expect(gateway.generate({ content: 'x' })).rejects.toMatchObject({
      category: 'llm-adapter',
      retryable: true,
    });
  });

  it('thrown 错误：ECONNRESET 类未知 → internal 不可重试', async () => {
    const plain = {
      listProviders: () => [{ id: 'p', name: 'P' }],
      listModels: async () => [{ id: 'm', name: 'M' }],
      prepareCall: async () => {
        throw new Error('ECONNRESET socket hang up');
      },
    };
    const gateway = createHostLlmGateway(plain as unknown as LlmHostLike);
    await expect(gateway.generate({ content: 'x' })).rejects.toMatchObject({
      category: 'internal',
      retryable: false,
    });
  });

  it('LlmError 形态校验：category 属于既定枚举', () => {
    const err = new LlmError('llm-structure', 'x', true);
    expect(err.category).toBe('llm-structure');
    expect(err.name).toBe('LlmError');
  });
});
