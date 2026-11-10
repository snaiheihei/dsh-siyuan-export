import { describe, expect, it } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  LlmError,
  buildExportPrompt,
  createHostLlmGateway,
  parseStructuredOutput,
  type LlmHostLike,
  type PreparedLike,
} from '../../src/export/llm';

/**
 * T012 · LLM 适配器（seam：`LlmHostLike` 结构化宿主边界 —— 生产用 ctx.llm，测试用假实现）
 * 抓到什么：route 解析（无模型→llm-adapter）、prepareCall/stream 流式拼装与 finish 判定、
 *   错误分类（NO_ADAPTER/quota/timeout）、调用方中止原样抛出、prompt/输出结构校验、maxTokens 预算。
 * 抓不到什么：真实 provider/model 可用性（归 quickstart V5A 真实小请求）、FR-013 负向断言（T017）。
 * 红→绿：src/export/llm.ts 尚不存在。
 */

function asLlm(x: unknown): LlmHostLike {
  return x as LlmHostLike;
}

function chunkText(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text };
}
function chunkFinish(kind: 'stop' | 'error' | 'aborted'): StreamChunk {
  if (kind === 'stop') return { type: 'finish', reason: { kind: 'stop' } };
  const failure = { message: 'provider boom', code: 'PROVIDER_ERROR' };
  if (kind === 'aborted') return { type: 'finish', reason: { kind: 'aborted', failure } };
  return { type: 'finish', reason: { kind: 'error', failure } };
}

interface Seen {
  config?: { provider?: string; model?: string; maxTokens?: number };
  options?: GenerateOptions;
}

function fakeLlm(opts: {
  providers?: { id: string; name: string }[];
  models?: Record<string, string[]>;
  chunks?: StreamChunk[];
  prepareThrows?: Error;
}): { llm: LlmHostLike; seen: Seen } {
  const seen: Seen = {};
  const llm = asLlm({
    listProviders: () => opts.providers ?? [{ id: 'p1', name: 'Provider One' }],
    listModels: async (provider: string) =>
      (opts.models?.[provider] ?? ['m1']).map((id) => ({ id, name: id })),
    prepareCall: async (config: Seen['config']) => {
      if (opts.prepareThrows) throw opts.prepareThrows;
      seen.config = config;
      const prepared: PreparedLike = {
        stream: (options: GenerateOptions) => {
          seen.options = options;
          return (async function* () {
            for (const c of opts.chunks ?? [chunkText('{"title":"T","body":"B"}'), chunkFinish('stop')]) {
              yield c;
            }
          })();
        },
      };
      return prepared;
    },
  });
  return { llm, seen };
}

describe('buildExportPrompt（FR-013 输入构造点）', () => {
  it('system 为固定指令模板，user 仅由单次输出构成', () => {
    const { system, user } = buildExportPrompt('这是回复正文ABC');
    expect(system).toContain('title');
    expect(system).toContain('body');
    expect(user).toContain('这是回复正文ABC');
    // 正向：构造签名只有 content 一个输入（负向「不含上下文」断言在 T017）
    expect(buildExportPrompt.length).toBe(1);
  });
});

describe('parseStructuredOutput', () => {
  it('纯 JSON → {title, body}', () => {
    expect(parseStructuredOutput('{"title":"标题","body":"正文"}')).toEqual({ title: '标题', body: '正文' });
  });

  it('```json 围栏与前后杂讯 → 截取解析', () => {
    const raw = '好的：\n```json\n{"title":"T","body":"B"}\n```\n希望有帮助';
    expect(parseStructuredOutput(raw)).toEqual({ title: 'T', body: 'B' });
  });

  it('缺字段 / 非 JSON / body 超 1MB → LlmError llm-structure 可重试', () => {
    const cases = [
      '{"title":"T"}',
      'not json at all',
      '{"title":"","body":"B"}',
      `{"title":"T","body":"${'x'.repeat(1024 * 1024 + 1)}"}`,
    ];
    for (const raw of cases) {
      try {
        parseStructuredOutput(raw);
        throw new Error(`expected LlmError for: ${raw.slice(0, 30)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        const e = err as LlmError;
        expect(e.category).toBe('llm-structure');
        expect(e.retryable).toBe(true);
      }
    }
  });
});

describe('createHostLlmGateway.generate', () => {
  it('route 解析 + 流式拼装：返回完整文本，maxTokens 默认 4096，prompt 进入 stream options', async () => {
    const { llm, seen } = fakeLlm({ chunks: [chunkText('{"title":"T",'), chunkText('"body":"B"}'), chunkFinish('stop')] });
    const gateway = createHostLlmGateway(llm);
    const text = await gateway.generate({ content: '单次输出内容' });
    expect(text).toBe('{"title":"T","body":"B"}');
    expect(seen.config?.provider).toBe('p1');
    expect(seen.config?.model).toBe('m1');
    expect(seen.config?.maxTokens).toBe(4096);
    expect(seen.options?.system).toContain('title');
    expect(seen.options?.messages?.[0]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(seen.options?.messages)).toContain('单次输出内容');
  });

  it('maxTokens 可覆盖', async () => {
    const { llm, seen } = fakeLlm({});
    await createHostLlmGateway(llm).generate({ content: 'x', maxTokens: 1234 });
    expect(seen.config?.maxTokens).toBe(1234);
  });

  it('无可用 provider/model → llm-adapter 不可重试', async () => {
    const { llm } = fakeLlm({ providers: [], models: {} });
    try {
      await createHostLlmGateway(llm).generate({ content: 'x' });
      throw new Error('expected LlmError');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).category).toBe('llm-adapter');
      expect((err as LlmError).retryable).toBe(false);
    }
  });

  it('prepareCall 抛 NO_ADAPTER → llm-adapter；quota → llm-quota 可重试；timeout → llm-timeout 可重试', async () => {
    const expectations: [Error, string, boolean][] = [
      [new Error('NO_ADAPTER'), 'llm-adapter', false],
      [new Error('quota exceeded, code 429 rate limit'), 'llm-quota', true],
      [new Error('request timed out'), 'llm-timeout', true],
    ];
    for (const [thrown, category, retryable] of expectations) {
      const { llm } = fakeLlm({ prepareThrows: thrown });
      try {
        await createHostLlmGateway(llm).generate({ content: 'x' });
        throw new Error('expected LlmError');
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        expect((err as LlmError).category).toBe(category);
        expect((err as LlmError).retryable).toBe(retryable);
      }
    }
  });

  it('finish reason=error → llm-adapter 可重试；缺 terminal finish → llm-adapter 不可重试', async () => {
    const { llm: errLlm } = fakeLlm({ chunks: [chunkFinish('error')] });
    try {
      await createHostLlmGateway(errLlm).generate({ content: 'x' });
      throw new Error('expected LlmError');
    } catch (err) {
      expect((err as LlmError).category).toBe('llm-adapter');
      expect((err as LlmError).retryable).toBe(true);
    }

    const { llm: noFinish } = fakeLlm({ chunks: [chunkText('partial')] });
    try {
      await createHostLlmGateway(noFinish).generate({ content: 'x' });
      throw new Error('expected LlmError');
    } catch (err) {
      expect((err as LlmError).category).toBe('llm-adapter');
      expect((err as LlmError).retryable).toBe(false);
    }
  });

  it('调用方中止 → 原样 AbortError（非 LlmError，供上层转 cancelled）', async () => {
    const controller = new AbortController();
    const seen2: Seen = {};
    const llm = asLlm({
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'm1' }],
      prepareCall: async (config: Seen['config']) => {
        seen2.config = config;
        const prepared: PreparedLike = {
          stream: () =>
            (async function* () {
              yield chunkText('partial');
              controller.abort();
              throw new DOMException('aborted', 'AbortError');
            })(),
        };
        return prepared;
      },
    });
    try {
      await createHostLlmGateway(llm).generate({ content: 'x', signal: controller.signal });
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(LlmError);
    }
  });
});
