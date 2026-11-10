/**
 * T012 · LLM 适配器（宿主 `ctx.llm` 通道）
 *
 * - `LlmHostLike` 是结构化宿主边界：生产注入 `ctx.llm`，测试注入假实现
 * - FR-013 输入裁剪的**唯一 prompt 构造点**（`buildExportPrompt`）：输入 = 单次输出 + 固定指令模板
 * - `prepareCall(config, signal)` → `stream(GenerateOptions)` 一次性流式消费，
 *   按 StreamChunk 协议拼装 text-delta 并以 terminal finish 判定成败
 * - 输出结构校验（`parseStructuredOutput`）失败 → `llm-structure`，由上层走降级（US3-2）
 * - 错误分类：llm-adapter / llm-quota / llm-timeout / llm-structure / internal；调用方中止原样抛出
 */
import type {
  GenerateOptions,
  LlmCallConfig,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { PluginError } from '../errors';

/** LLM 域错误（统一 PluginError 形态） */
export class LlmError extends PluginError {}

/** 单次导出生成的默认输出预算 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 结构化正文上限（与 RPC body 上限一致：1MB） */
const MAX_BODY_BYTES = 1024 * 1024;

export interface PreparedLike {
  /**
   * prepareCall 解析出的深冻结配置（含 adapterDefaults 物化字段）——
   * stream 请求必须与其匹配，否则宿主报 INVALID_PREPARED_CALL（真实失败根因2）。
   */
  config: LlmCallConfig;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/** ctx.llm 的结构化子集（真实 LlmRuntime 结构兼容） */
export interface LlmHostLike {
  listProviders(): readonly LlmProviderInfo[] | Promise<readonly LlmProviderInfo[]>;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLike>;
  /**
   * 对话 agent 列表（route 优先级最高——学 snail-memory `selectModelRoute`）：
   * agent.options 携带对话实际使用的 provider/model，优先于 listProviders[0]
   * （真实失败根因1：列表第一个 provider 往往未配置凭据）。
   */
  agents?: {
    list(): readonly { options: { provider?: string; model?: string } }[];
  };
}

export interface GenerateInput {
  /** 单次输出正文——prompt 的唯一内容来源（FR-013） */
  content: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface LlmGateway {
  generate(input: GenerateInput): Promise<string>;
}

/**
 * FR-013 唯一 prompt 构造点：只接收单次输出与固定模板，结构上无法携带对话上下文。
 */
export function buildExportPrompt(content: string): { system: string; user: string } {
  const system = [
    '你是笔记整理助手。把用户提供的「单次输出」整理成一篇结构清晰的 Markdown 笔记。',
    '输出仅含一个 JSON 对象，字段：',
    '- "title": 笔记标题（不超过 60 字，概括主题）',
    '- "body": Markdown 正文',
    '要求：',
    '1. 只能使用给定内容的信息，禁止编造，禁止补充任何对话上下文；',
    '2. 用二级标题分节，要点用小图标标注（✅ 📌 ⚠️ 💡 等）；',
    '3. 代码块、列表、链接原样保留，不删减关键细节；',
    '4. 不要输出 JSON 之外的任何文字。',
  ].join('\n');
  const user = `<single-output>\n${content}\n</single-output>`;
  return { system, user };
}

function structureFail(reason: string): never {
  throw new LlmError('llm-structure', `模型输出不合结构（${reason}），可重试或走降级`, true);
}

/**
 * 结构化输出校验：容忍 ```json 围栏与前后杂讯；title/body 必须为非空字符串，body ≤ 1MB。
 */
export function parseStructuredOutput(raw: string): { title: string; body: string } {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) text = fence[1];

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) structureFail('未找到 JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    structureFail('JSON 解析失败');
  }
  if (typeof parsed !== 'object' || parsed === null) structureFail('不是 JSON 对象');

  const record = parsed as Record<string, unknown>;
  const title = record.title;
  const body = record.body;
  if (typeof title !== 'string' || title.trim() === '') structureFail('title 缺失或为空');
  if (typeof body !== 'string' || body.trim() === '') structureFail('body 缺失或为空');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) structureFail('body 超过 1MB');
  return { title: title.trim(), body };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function classifyLlmThrown(err: unknown): LlmError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/NO_ADAPTER|unsupported|no adapter|unknown provider|not registered/i.test(msg)) {
    return new LlmError('llm-adapter', '宿主未配置可用的模型通道，请检查模型设置', false);
  }
  if (/quota|429|rate.?limit|billing|insufficient/i.test(msg)) {
    return new LlmError('llm-quota', '模型配额受限，请稍后重试', true);
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) {
    return new LlmError('llm-timeout', '模型调用超时，请稍后重试', true);
  }
  return new LlmError('internal', '模型调用失败，请稍后重试', false);
}

/** terminal finish 携带的 provider 失败事实 → 分类（代码/状态优先，缺省可重试） */
function classifyLlmFailure(failure: LlmFailure): LlmError {
  const haystack = `${failure.code ?? ''} ${failure.message ?? ''}`;
  if (failure.status === 429 || /quota|rate.?limit|billing|insufficient/i.test(haystack)) {
    return new LlmError('llm-quota', '模型配额受限，请稍后重试', true);
  }
  if (failure.status === 504 || /timeout|timed.?out/i.test(haystack)) {
    return new LlmError('llm-timeout', '模型调用超时，请稍后重试', true);
  }
  if (/no.?adapter|unsupported/i.test(haystack)) {
    return new LlmError('llm-adapter', '宿主未配置可用的模型通道，请检查模型设置', false);
  }
  return new LlmError('llm-adapter', '模型调用失败，请稍后重试', true);
}

/** 统一抛出路径：宿主错误分类 / 中止原样保留 */
function rethrowAsAppropriate(err: unknown, signal?: AbortSignal): never {
  if (err instanceof PluginError) throw err;
  if (isAbortError(err)) throw err;
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  throw classifyLlmThrown(err);
}

async function resolveRoute(
  llm: LlmHostLike,
  signal?: AbortSignal,
): Promise<{ provider: string; model: string }> {
  // 1) 对话 agent 的模型选项（真实失败根因1：优先用对话实际 route）
  try {
    for (const agent of llm.agents?.list() ?? []) {
      const provider = agent.options?.provider;
      const model = agent.options?.model;
      if (provider && model) return { provider, model };
    }
  } catch {
    // agents 查询失败不阻断，回落 listProviders
  }
  let providers: readonly LlmProviderInfo[];
  try {
    providers = await llm.listProviders();
  } catch (err) {
    rethrowAsAppropriate(err, signal);
  }
  for (const provider of providers) {
    let models: readonly LlmModelInfo[];
    try {
      models = await llm.listModels(provider.id);
    } catch {
      continue; // 单个 provider 查询失败不阻断整体解析
    }
    const first = models[0];
    if (first) return { provider: provider.id, model: first.id };
  }
  throw new LlmError('llm-adapter', '宿主未配置可用的模型，请先在模型设置中添加', false);
}

async function runGenerate(llm: LlmHostLike, input: GenerateInput): Promise<string> {
  input.signal?.throwIfAborted();
  const route = await resolveRoute(llm, input.signal);
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  let prepared: PreparedLike;
  try {
    prepared = await llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens } satisfies LlmCallConfig,
      input.signal,
    );
  } catch (err) {
    rethrowAsAppropriate(err, input.signal);
  }

  const { system, user } = buildExportPrompt(input.content);
  // 真实失败根因2：request 必须与 prepared.config 匹配（含 adapterDefaults 物化字段），
  // 自拼字段会触发 INVALID_PREPARED_CALL —— 展开 prepared.config（对齐 snail-memory 用法）
  const options: GenerateOptions = {
    ...prepared.config,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    ...(input.signal ? { signal: input.signal } : {}),
  };

  let text = '';
  let sawFinish = false;
  try {
    for await (const chunk of prepared.stream(options)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
      } else if (chunk.type === 'finish') {
        sawFinish = true;
        if (chunk.reason.kind === 'error') {
          throw classifyLlmFailure(chunk.reason.failure);
        }
        if (chunk.reason.kind === 'aborted') {
          throw new DOMException('aborted', 'AbortError');
        }
      }
    }
  } catch (err) {
    rethrowAsAppropriate(err, input.signal);
  }

  if (!sawFinish) throw new LlmError('llm-adapter', '模型输出不完整，请重试', false);
  return text;
}

/** 构建宿主 LLM 网关（生产注入 ctx.llm；agents 用于 route 优先级） */
export function createHostLlmGateway(
  llm: LlmHostLike,
  agents?: LlmHostLike['agents'],
): LlmGateway {
  const host: LlmHostLike = agents ? { ...llm, agents } : llm;
  return {
    generate: (input: GenerateInput) => runGenerate(host, input),
  };
}
