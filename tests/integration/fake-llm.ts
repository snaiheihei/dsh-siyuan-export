/**
 * T015 · 假宿主 LLM 网关（测试替身：fake）
 *
 * 模式：ok（合法 JSON 输出）/ structure-bad（不合结构，走降级）/ timeout / no-adapter。
 * 捕获每次调用的 config 与 stream options —— 供 FR-013 输入审计（messages 只含单次输出）。
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { LlmHostLike } from '../../src/export/llm';

export type FakeLlmMode = 'ok' | 'structure-bad' | 'timeout' | 'no-adapter';

export interface FakeLlmCall {
  config: Record<string, unknown>;
  options: GenerateOptions | null;
}

export interface FakeLlm {
  llm: LlmHostLike;
  calls: FakeLlmCall[];
}

const DEFAULT_OUTPUT = JSON.stringify({
  title: '默认标题',
  body: '## 小节\n\n- ✅ 要点一\n- 📌 要点二',
});

function textChunk(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text };
}

function finishStop(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } };
}

export function startFakeLlm(
  options: { mode?: FakeLlmMode; output?: string } = {},
): FakeLlm {
  const mode = options.mode ?? 'ok';
  const output = options.output ?? DEFAULT_OUTPUT;
  const calls: FakeLlmCall[] = [];

  const plain = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
    prepareCall: async (config: Record<string, unknown>) => {
      if (mode === 'no-adapter') throw new Error('NO_ADAPTER');
      if (mode === 'timeout') throw new Error('request timed out');
      const record: FakeLlmCall = { config, options: null };
      calls.push(record);
      return {
        stream: (options: GenerateOptions) => {
          record.options = options;
          return (async function* () {
            if (mode === 'structure-bad') {
              yield textChunk('这是一段完全不是 JSON 的自由文本');
              yield finishStop();
              return;
            }
            yield textChunk(output);
            yield finishStop();
          })();
        },
      };
    },
  };

  return { llm: plain as unknown as LlmHostLike, calls };
}
