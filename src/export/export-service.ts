/**
 * T020 · 导出编排状态机（Host 权威状态）
 *
 * 状态（data-model §5）：
 *   generating → ready | degraded-ready → writing → succeeded | failed
 *   generating → cancelled（用户关闭弹窗，中止模型流，无半成品）
 *
 * 纪律：
 *  - 幂等键 = sessionId:messageId:contentRevision；同键 open 复用既有任务（不重复调 LLM）
 *  - Host 权威防重：writing 中的重复 commit 被拒（按钮禁用只是表现层）
 *  - 写失败保留 title/target，retry 复用缓存 body（不重调 LLM，省 token）
 *  - LLM 失败 → 降级（标题取正文首行、body 用原文），仍可导出
 *  - 正文（body）只存于 Host，绝不回传 Client
 */
import type {
  ErrorInfo,
  ExportCancelData,
  ExportCommitData,
  ExportOpenData,
  ExportOpenRequest,
  ExportStateData,
  StoragePath,
  TaskStatus,
} from '../contract';
import { PluginError } from '../errors';
import { formatNote } from './format';
import { parseStructuredOutput, type LlmGateway } from './llm';

export interface OutputSource {
  /** 按 messageId 读取该条定稿助手消息正文（Host 侧派生 contentRevision） */
  readOutput(input: { messageId: string; sessionId: string }): Promise<{
    content: string;
    contentRevision: string;
  }>;
}

export interface NoteWriterInput {
  notebookId: string;
  parentHPath: string;
  title: string;
  markdown: string;
}

export interface NoteWriter {
  write(input: NoteWriterInput): Promise<{ id: string; hpath: string }>;
}

export interface PrefsLike {
  read(): Promise<{ lastPath: StoragePath | null }>;
  update(patch: { lastPath?: StoragePath | null }): Promise<unknown>;
}

export interface ExportServiceDeps {
  source: OutputSource;
  gateway: LlmGateway;
  writer: NoteWriter;
  prefs: PrefsLike;
}

interface TaskState {
  taskId: string;
  messageId: string;
  sessionId: string;
  contentRevision: string;
  status: TaskStatus;
  /** LLM 默认主题名（用户可覆盖） */
  title: string | null;
  /** 结构化正文：仅 Host 持有 */
  body: string | null;
  /** 原始正文（降级用） */
  rawContent: string;
  error: ErrorInfo | null;
  target: StoragePath | null;
  /** 写入进行中标记（防重复 commit） */
  writing: boolean;
  abort?: AbortController;
}

const TITLE_MAX = 128;
const ILLEGAL_TITLE_CHARS = /[<>:"/\\|?*]/g;
// 控制字符需从文档名剔除（Windows/思源均不接受）；eslint no-control-regex 对此用例不适用
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** 标题清洗：去非法字符与控制符、压平换行、限长 */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_TITLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);
}

/** 降级标题：正文首行（去掉 Markdown 标记）截断 */
export function fallbackTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '未命名笔记';
  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s*/, '')
    .trim();
  return sanitizeTitle(cleaned) || '未命名笔记';
}

function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof PluginError) {
    return { category: err.category, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { category: 'internal', message: '已取消', retryable: false };
  }
  return { category: 'internal', message: '导出失败，请稍后重试', retryable: false };
}

export class ExportService {
  private readonly deps: ExportServiceDeps;
  private readonly tasks = new Map<string, TaskState>();

  constructor(deps: ExportServiceDeps) {
    this.deps = deps;
  }

  private static taskKey(sessionId: string, messageId: string, revision: string): string {
    return `${sessionId}:${messageId}:${revision}`;
  }

  /**
   * 打开导出：读取单次输出 → 启动生成（幂等：同键复用既有任务）。
   */
  async open(request: ExportOpenRequest): Promise<ExportOpenData> {
    const output = await this.deps.source.readOutput({
      messageId: request.messageId,
      sessionId: request.sessionId,
    });
    const content = (output.content ?? '').trim();
    if (content.length === 0) {
      throw new PluginError('empty-source', '这条回复没有可导出的内容', false);
    }
    const revision = output.contentRevision;
    const key = ExportService.taskKey(request.sessionId, request.messageId, revision);

    const existing = this.tasks.get(key);
    if (existing) {
      // 终态处理（spec edge「同一条回复连续导出到不同路径 → 各自独立成文」）：
      // - succeeded → 重置 ready（复用缓存 body，允许再次导出，不重调 LLM 省 token）
      // - cancelled → 重新生成（清空缓存，重新走 LLM）
      // - failed → 保留（直接重试，复用缓存 body）
      // - 其余状态 → 原样返回（幂等）
      if (existing.status === 'succeeded') {
        existing.status = 'ready';
        existing.error = null;
      } else if (existing.status === 'cancelled') {
        existing.status = 'generating';
        existing.body = null;
        existing.title = null;
        existing.error = null;
        const retryAbort = new AbortController();
        existing.abort = retryAbort;
        void this.generate(existing, retryAbort.signal);
      }
      const lastPath = await this.readLastPath();
      return { ...this.toOpenData(existing), lastPath };
    }

    const task: TaskState = {
      taskId: key,
      messageId: request.messageId,
      sessionId: request.sessionId,
      contentRevision: revision,
      status: 'generating',
      title: null,
      body: null,
      rawContent: content,
      error: null,
      target: null,
      writing: false,
    };
    this.tasks.set(key, task);

    const lastPath = await this.readLastPath();

    // 后台生成（失败走降级，不阻塞 open 返回）
    const abort = new AbortController();
    task.abort = abort;
    void this.generate(task, abort.signal);

    return {
      taskId: task.taskId,
      status: task.status,
      title: task.title,
      lastPath,
      error: task.error,
    };
  }

  private async generate(task: TaskState, signal: AbortSignal): Promise<void> {
    try {
      const raw = await this.deps.gateway.generate({ content: task.rawContent, signal });
      const parsed = parseStructuredOutput(raw);
      if (task.status === 'cancelled') return;
      task.title = sanitizeTitle(parsed.title) || fallbackTitle(task.rawContent);
      task.body = parsed.body;
      task.status = 'ready';
      task.error = null;
    } catch (err) {
      if (task.status === 'cancelled') return;
      if (err instanceof Error && err.name === 'AbortError') {
        task.status = 'cancelled';
        return;
      }
      // 降级：标题取首行、正文用原文（仍可导出）
      task.title = fallbackTitle(task.rawContent);
      task.body = task.rawContent;
      task.status = 'degraded-ready';
      task.error = toErrorInfo(err);
    }
  }

  private require(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new PluginError('internal', '导出任务不存在或已结束', false);
    return task;
  }

  /** 读上次成功路径（open 两处共用；读失败按 null 处理，不阻断导出） */
  private async readLastPath(): Promise<StoragePath | null> {
    const prefs = await this.deps.prefs.read().catch(() => ({ lastPath: null }));
    return prefs.lastPath;
  }

  private toOpenData(task: TaskState): ExportOpenData {
    return {
      taskId: task.taskId,
      status: task.status,
      title: task.title,
      lastPath: null,
      error: task.error,
    };
  }

  /** 查询状态（不回传 body） */
  async state(taskId: string): Promise<ExportStateData> {
    const task = this.require(taskId);
    return { status: task.status, title: task.title, error: task.error };
  }

  /** 确认导出：写思源（幂等保护、失败保留字段、retry 复用缓存 body） */
  async commit(input: {
    taskId: string;
    title: string;
    target: StoragePath;
  }): Promise<ExportCommitData> {
    const task = this.require(input.taskId);
    if (task.status === 'writing' || task.writing) {
      throw new PluginError('internal', '导出正在进行中，请勿重复提交', false);
    }
    if (task.status === 'succeeded') {
      throw new PluginError('internal', '该回复已导出', false);
    }
    if (task.status === 'cancelled') {
      throw new PluginError('internal', '导出已取消，请重新发起', false);
    }
    if (task.status === 'generating') {
      throw new PluginError('internal', '内容仍在生成中，请稍候', true);
    }
    if (!task.body) {
      throw new PluginError('internal', '内容尚未准备好，请稍候', true);
    }

    const title = sanitizeTitle(input.title);
    if (title.length === 0) {
      throw new PluginError('internal', '标题不能为空', false);
    }

    task.title = title;
    task.target = input.target;
    task.status = 'writing';
    task.writing = true;
    task.error = null;

    try {
      const { markdown } = formatNote({
        body: task.body,
        source: {
          sessionId: task.sessionId,
          messageId: task.messageId,
          contentRevision: task.contentRevision,
        },
        exportedAt: new Date(),
        target: input.target,
      });

      const parentHPath = `/${input.target.parentSegments.join('/')}`.replace(/\/+$/, '');
      const written = await this.deps.writer.write({
        notebookId: input.target.notebookId,
        parentHPath,
        title,
        markdown,
      });

      task.status = 'succeeded';
      task.writing = false;
      // 回写偏好（FR-006）；失败不阻断导出结果
      await this.deps.prefs.update({ lastPath: input.target }).catch(() => undefined);

      return {
        status: 'succeeded',
        target: input.target,
        href: written.id ? `siyuan://blocks/${written.id}` : null,
      };
    } catch (err) {
      task.status = 'failed';
      task.writing = false;
      task.error = toErrorInfo(err);
      throw err instanceof PluginError
        ? err
        : new PluginError('internal', '导出失败，请稍后重试', false);
    }
  }

  /** 取消（仅 generating 有效；中止模型流、无半成品） */
  async cancel(taskId: string): Promise<ExportCancelData> {
    const task = this.tasks.get(taskId);
    if (!task) return { status: 'noop' };
    if (task.status !== 'generating') return { status: 'noop' };
    task.status = 'cancelled';
    task.abort?.abort();
    return { status: 'cancelled' };
  }
}
