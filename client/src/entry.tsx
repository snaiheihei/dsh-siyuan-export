/**
 * Client 入口：在助手消息操作栏注册「导出到思源」按钮并驱动导出弹窗。
 *
 * 纪律（develop-dsh-plugin §3/§7 + R1 调研）：
 *  - `ctx.slots.inject(key, cb)` 等待 slot 声明存活后再 `register`（裸 register 会抛错）
 *  - 独立 id `siyuan-export`、order 高于官方 feedback(10)，共存不替换
 *  - JSX 编译为 react/jsx-runtime（宿主基座 external，不打第二份 React）
 *  - 顶层不触碰 DOM；弹窗用 React 状态挂在宿主 overlay 容器
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
// 拉入 slot 相关的 Context/SlotMap 模块增强（type-only；client 侧增强在 ./client 子路径）
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type { StoragePath } from '../../src/contract';
import { ExportButton } from './components/ExportButton';
import { ExportDialog } from './components/ExportDialog';
import { ClientRpcError, createExportClient, type ExportClient } from './rpc';

const SLOT_KEY = 'conversation.chat.assistant-actions' as const;

export const inject = ['slots'];

interface DialogState {
  taskId: string;
  status: string;
  title: string;
  titleEdited: boolean;
  target: StoragePath | null;
  lastPath: StoragePath | null;
  error: { category: string; message: string; retryable: boolean } | null;
}

/** slot owner 提供的 props（Research R1：owner = { messageId }） */
interface SlotProps {
  messageId: string;
  sessionId?: string;
}

function toErrorInfo(err: unknown): { category: string; message: string; retryable: boolean } {
  if (err instanceof ClientRpcError) {
    return { category: err.category, message: err.message, retryable: err.retryable };
  }
  return { category: 'internal', message: '导出失败，请稍后重试', retryable: false };
}

/**
 * 导出按钮 + 弹窗容器（每个消息行一个实例，但弹窗只渲染一个）
 */
export function SiyuanExportAction(props: SlotProps): JSX.Element | null {
  const clientRef = useRef<ExportClient | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(false);
  const taskRef = useRef<string | null>(null);

  const client = (): ExportClient => {
    if (!clientRef.current) clientRef.current = createExportClient();
    return clientRef.current;
  };

  const startExport = useCallback(
    async (messageId: string) => {
      setLoading(true);
      try {
        const opened = await client().open({ messageId, sessionId: props.sessionId ?? '' });
        taskRef.current = opened.taskId;
        setDialog({
          taskId: opened.taskId,
          status: opened.status,
          title: opened.title ?? '',
          titleEdited: false,
          target: opened.lastPath,
          lastPath: opened.lastPath,
          error: opened.error,
        });
        // 轮询至就绪（stale 防护：任务切换时不覆盖）
        const settled = await client().pollUntilSettled(opened.taskId, {
          isCurrent: (id) => taskRef.current === id,
        });
        setDialog((prev) => {
          if (!prev || prev.taskId !== opened.taskId) return prev;
          return {
            ...prev,
            status: settled.status,
            // 用户未编辑标题时才回填 LLM 默认值（FR-004）
            title: prev.titleEdited ? prev.title : (settled.title ?? prev.title),
            error: settled.error,
          };
        });
      } catch (err) {
        setDialog({
          taskId: '',
          status: 'failed',
          title: '',
          titleEdited: false,
          target: null,
          lastPath: null,
          error: toErrorInfo(err),
        });
      } finally {
        setLoading(false);
      }
    },
    [props.sessionId],
  );

  const submit = useCallback(async () => {
    if (!dialog || !dialog.target) return;
    setDialog((prev) => (prev ? { ...prev, status: 'writing', error: null } : prev));
    try {
      await client().commit({ taskId: dialog.taskId, title: dialog.title, target: dialog.target });
      setDialog((prev) => (prev ? { ...prev, status: 'succeeded', error: null } : prev));
    } catch (err) {
      setDialog((prev) => (prev ? { ...prev, status: 'failed', error: toErrorInfo(err) } : prev));
    }
  }, [dialog]);

  const retry = useCallback(async () => {
    if (!dialog) return;
    setDialog((prev) => (prev ? { ...prev, status: 'writing', error: null } : prev));
    try {
      await client().commit({ taskId: dialog.taskId, title: dialog.title, target: dialog.target! });
      setDialog((prev) => (prev ? { ...prev, status: 'succeeded', error: null } : prev));
    } catch (err) {
      setDialog((prev) => (prev ? { ...prev, status: 'failed', error: toErrorInfo(err) } : prev));
    }
  }, [dialog]);

  const close = useCallback(() => {
    const taskId = taskRef.current;
    setDialog(null);
    taskRef.current = null;
    if (taskId) void client().cancel(taskId).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    const taskId = taskRef.current;
    if (taskId) void client().cancel(taskId).catch(() => undefined);
  }, []);

  return (
    <>
      <ExportButton messageId={props.messageId} loading={loading} onExport={(id) => void startExport(id)} />
      {dialog ? (
        <ExportDialog
          status={dialog.status}
          title={dialog.title}
          target={dialog.target}
          lastPath={dialog.lastPath}
          error={dialog.error}
          titleEdited={dialog.titleEdited}
          onTitleChange={(value) =>
            setDialog((prev) => (prev ? { ...prev, title: value, titleEdited: true } : prev))
          }
          onTargetChange={(value) => setDialog((prev) => (prev ? { ...prev, target: value } : prev))}
          onSubmit={() => void submit()}
          onRetry={() => void retry()}
          onClose={close}
        />
      ) : null}
    </>
  );
}

export function apply(ctx: Context): void {
  ctx.slots.inject(SLOT_KEY, () =>
    ctx.slots.register({ name: SLOT_KEY, id: 'siyuan-export', order: 100 }, SiyuanExportAction),
  );
}
