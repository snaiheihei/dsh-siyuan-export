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
  ExportDialogOpenData,
  ExportMode,
  ExportOpenData,
  ExportOpenRequest,
  ExportSilentOpenData,
  ExportStateData,
  StoragePath,
  TargetFrom,
  TaskStatus,
} from '../contract';
import { PluginError } from '../errors';
import { formatNote } from './format';
import { parseStructuredOutput, type LlmGateway } from './llm';
import { resolveSilentTarget, type TargetIo } from '../siyuan/target';

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
  read(): Promise<{
    lastPath: StoragePath | null;
    defaultPath: StoragePath | null;
    showDialog: boolean;
  }>;
  update(patch: { lastPath?: StoragePath | null }): Promise<unknown>;
}

export interface ExportServiceDeps {
  source: OutputSource;
  gateway: LlmGateway;
  writer: NoteWriter;
  prefs: PrefsLike;
  /** 静默落点解析（notebook 存在性/父级校验） */
  targetIo: TargetIo;
}

interface TaskState {
  taskId: string;
  /** 任务模式在创建时固定；后续 open 返回原模式（同键不重复落盘） */
  mode: ExportMode;
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
  targetFrom: TargetFrom | null;
  /** 生成失败已降级为原文（跨 writing 保留） */
  degraded: boolean;
  href: string | null;
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

  /** 读取偏好；失败按「弹窗 + 无路径」处理，不阻断导出 */
  private async readPrefs(): Promise<{
    lastPath: StoragePath | null;
    defaultPath: StoragePath | null;
    showDialog: boolean;
  }> {
    try {
      return await this.deps.prefs.read();
    } catch {
      return { lastPath: null, defaultPath: null, showDialog: true };
    }
  }

  /** Host 权威模式判定：silent 恒静默；auto 读 Prefs.showDialog（缺省视为 true） */
  private async resolveMode(intent: ExportOpenRequest['intent']): Promise<ExportMode> {
    if (intent === 'silent') return 'silent';
    const prefs = await this.readPrefs();
    return prefs.showDialog === false ? 'silent' : 'dialog';
  }

  /**
   * 打开导出：读取单次输出 → 启动生成（幂等：同键复用既有任务）。
   * 模式分派后 dialog/silent 各自返回判别联合。
   */
  async open(request: ExportOpenRequest): Promise<ExportOpenData> {
    const mode = await this.resolveMode(request.intent);
    if (mode === 'silent') return this.openSilent(request);
    return this.openDialog(request);
  }

  private async openDialog(request: ExportOpenRequest): Promise<ExportDialogOpenData> {
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

    const prefs = await this.readPrefs();
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
        existing.href = null;
      } else if (existing.status === 'cancelled') {
        existing.status = 'generating';
        existing.body = null;
        existing.title = null;
        existing.error = null;
        const retryAbort = new AbortController();
        existing.abort = retryAbort;
        void this.generate(existing, retryAbort.signal);
      }
      return this.toDialogData(existing, prefs);
    }

    const task: TaskState = {
      taskId: key,
      mode: 'dialog',
      messageId: request.messageId,
      sessionId: request.sessionId,
      contentRevision: revision,
      status: 'generating',
      title: null,
      body: null,
      rawContent: content,
      error: null,
      target: null,
      targetFrom: null,
      degraded: false,
      href: null,
      writing: false,
    };
    this.tasks.set(key, task);

    // 后台生成（失败走降级，不阻塞 open 返回）
    const abort = new AbortController();
    task.abort = abort;
    void this.generate(task, abort.signal);

    return this.toDialogData(task, prefs);
  }

  private async openSilent(request: ExportOpenRequest): Promise<ExportOpenData> {
    let output: { content: string; contentRevision: string };
    try {
      output = await this.deps.source.readOutput({
        messageId: request.messageId,
        sessionId: request.sessionId,
      });
    } catch (err) {
      // 静默业务失败是数据而非传输错误（contracts/rpc.md）
      return this.silentFailure(request, toErrorInfo(err));
    }

    const content = (output.content ?? '').trim();
    if (content.length === 0) {
      return this.silentFailure(request, {
        category: 'empty-source',
        message: '这条回复没有可导出的内容',
        retryable: false,
      });
    }

    const revision = output.contentRevision;
    const key = ExportService.taskKey(request.sessionId, request.messageId, revision);
    const existing = this.tasks.get(key);
    if (existing) {
      // 同键任务模式在创建时固定：已存在的弹窗任务按弹窗响应返回，不重复建流水线
      if (existing.mode === 'dialog') {
        return this.toDialogData(existing, await this.readPrefs());
      }
      // 写失败重试：复用缓存 body 与已解析落点，不重调 LLM、不改道（FR-020）
      if (existing.status === 'failed' && existing.body && existing.target) {
        existing.status = 'writing';
        existing.writing = true;
        existing.error = null;
        void this.writeTask(
          existing,
          existing.title ?? fallbackTitle(existing.rawContent),
          existing.target,
        ).catch(() => undefined);
        return { ...this.toSilentData(existing), alreadyRunning: true };
      }
      const alreadyRunning = existing.status === 'generating' || existing.status === 'writing';
      return { ...this.toSilentData(existing), alreadyRunning };
    }

    const prefs = await this.readPrefs();
    let resolved: { target: StoragePath; targetFrom: TargetFrom };
    try {
      resolved = await resolveSilentTarget(prefs, this.deps.targetIo);
    } catch (err) {
      return this.silentFailure(request, toErrorInfo(err));
    }

    const task: TaskState = {
      taskId: key,
      mode: 'silent',
      messageId: request.messageId,
      sessionId: request.sessionId,
      contentRevision: revision,
      status: 'generating',
      title: null,
      body: null,
      rawContent: content,
      error: null,
      target: resolved.target,
      targetFrom: resolved.targetFrom,
      degraded: false,
      href: null,
      writing: false,
    };
    this.tasks.set(key, task);

    const abort = new AbortController();
    task.abort = abort;
    void this.generate(task, abort.signal);

    return { ...this.toSilentData(task), alreadyRunning: false };
  }

  /** 未建任务的静默失败：taskId 用稳定占位，客户端据 status:'failed' 直接出 toast */
  private silentFailure(request: ExportOpenRequest, error: ErrorInfo): ExportSilentOpenData {
    return {
      mode: 'silent',
      taskId: `${request.sessionId}:${request.messageId}:unavailable`,
      status: 'failed',
      target: null,
      targetFrom: null,
      degraded: false,
      alreadyRunning: false,
      error,
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
      task.degraded = false;
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
      task.degraded = true;
      task.error = toErrorInfo(err);
    }

    // 静默任务生成完即自动写入（open 早已返回，不阻塞调用方）
    if (task.mode === 'silent') await this.autoWrite(task);
  }

  /** 静默自动写入：失败原因留在 task.error，由 state/toast 呈现，不向调用方抛出 */
  private async autoWrite(task: TaskState): Promise<void> {
    if (task.status !== 'ready' && task.status !== 'degraded-ready') return;
    const target = task.target;
    if (!target) return;
    try {
      await this.writeTask(task, task.title ?? fallbackTitle(task.rawContent), target);
    } catch {
      // task.error 已记录；静默通道无 RPC 调用方
    }
  }

  private require(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new PluginError('internal', '导出任务不存在或已结束', false);
    return task;
  }

  /** 弹窗响应：状态收敛到 generating|ready|degraded-ready（写中/失败按 ready 对待，详情走 state） */
  private toDialogData(
    task: TaskState,
    prefs: { lastPath: StoragePath | null; defaultPath: StoragePath | null },
  ): ExportDialogOpenData {
    const status = task.status === 'generating' || task.status === 'degraded-ready'
      ? task.status
      : 'ready';
    return {
      mode: 'dialog',
      taskId: task.taskId,
      status,
      title: task.title,
      lastPath: prefs.lastPath,
      defaultPath: prefs.defaultPath,
      error: task.error,
    };
  }

  /** 静默响应：status 收敛到 generating|writing|succeeded|failed（ready 阶段即将自动写入） */
  private toSilentData(task: TaskState): ExportSilentOpenData {
    const status = task.status === 'ready' || task.status === 'degraded-ready' || task.status === 'cancelled'
      ? (task.status === 'cancelled' ? 'failed' : 'generating')
      : task.status;
    return {
      mode: 'silent',
      taskId: task.taskId,
      status,
      target: task.target,
      targetFrom: task.targetFrom,
      degraded: task.degraded,
      alreadyRunning: false,
      error: task.error,
    };
  }

  /** 查询状态（不回传 body） */
  async state(taskId: string): Promise<ExportStateData> {
    const task = this.require(taskId);
    return {
      mode: task.mode,
      status: task.status,
      title: task.title,
      target: task.target,
      href: task.href,
      degraded: task.degraded,
      error: task.error,
    };
  }

  /** 确认导出：写思源（幂等保护、失败保留字段、retry 复用缓存 body） */
  async commit(input: {
    taskId: string;
    title: string;
    target: StoragePath;
  }): Promise<ExportCommitData> {
    const task = this.require(input.taskId);
    if (task.mode === 'silent') {
      // 静默任务由 Host 自动写入；手动 commit 说明客户端走错通道
      throw new PluginError('internal', '静默导出由后台自动写入，无需手动提交', false);
    }
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

    return this.writeTask(task, input.title, input.target);
  }

  /** 写入核心（弹窗 commit 与静默自动写入共用；writing 门闩防重复落盘） */
  private async writeTask(
    task: TaskState,
    titleInput: string,
    target: StoragePath,
  ): Promise<ExportCommitData> {
    const title = sanitizeTitle(titleInput);
    if (title.length === 0) {
      throw new PluginError('internal', '标题不能为空', false);
    }

    task.title = title;
    task.target = target;
    task.status = 'writing';
    task.writing = true;
    task.error = null;

    try {
      const { markdown } = formatNote({
        body: task.body!,
        source: {
          sessionId: task.sessionId,
          messageId: task.messageId,
          contentRevision: task.contentRevision,
        },
        exportedAt: new Date(),
        target,
      });

      const parentHPath = `/${target.parentSegments.join('/')}`.replace(/\/+$/, '');
      const written = await this.deps.writer.write({
        notebookId: target.notebookId,
        parentHPath,
        title,
        markdown,
      });

      task.status = 'succeeded';
      task.writing = false;
      task.href = written.id ? `siyuan://blocks/${written.id}` : null;
      // 回写偏好（FR-006）；失败不阻断导出结果
      await this.deps.prefs.update({ lastPath: target }).catch(() => undefined);

      return {
        status: 'succeeded',
        target,
        href: task.href,
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

  /** 取消（仅弹窗任务 generating 有效；静默任务不提供取消） */
  async cancel(taskId: string): Promise<ExportCancelData> {
    const task = this.tasks.get(taskId);
    if (!task) return { status: 'noop' };
    if (task.mode === 'silent') return { status: 'noop' };
    if (task.status !== 'generating') return { status: 'noop' };
    task.status = 'cancelled';
    task.abort?.abort();
    return { status: 'cancelled' };
  }
}
