/**
 * Client 入口：在助手消息操作栏注册「导出到思源」按钮并驱动导出弹窗。
 *
 * 纪律（develop-dsh-plugin §3/§7 + R1 调研）：
 *  - `ctx.slots.inject(key, cb)` 等待 slot 声明存活后再 `register`（裸 register 会抛错）
 *  - 独立 id `siyuan-export`、order 高于官方 feedback(10)，共存不替换
 *  - JSX 编译为 react/jsx-runtime（宿主基座 external，不打第二份 React）
 *  - 顶层不触碰 DOM；弹窗经 createPortal 直挂 document.body
 *    （真实试用缺陷修复：fixed overlay 在宿主 transform 祖先内会退化错位）
 *  - 运行时必须 `ctx.locale.register(NS, {zh, en})` 注册字典
 *    （真实试用缺陷修复：漏注册导致 t() 回退显示 key，如 "button.export"）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Context } from '@deepseek-ai/cordis';
// 拉入 slot 相关的 Context/SlotMap 模块增强（type-only；client 侧增强在 ./client 子路径）
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
// locale 服务（ctx.locale.register）的 Context 增强
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { StoragePath, TreeNode } from '../../src/contract';
import { ExportButton } from './components/ExportButton';
import { DocTree } from './components/DocTree';
import { ExportDialog } from './components/ExportDialog';
// 值导入：字典需在 apply 时注册进宿主 locale 服务（type-only 不携带运行时）
import { zh, en } from './locales';
// type-only：拉入 siyuan-export 命名空间的 LocaleNamespaceMap 合并
import type {} from './locales';
import { ClientRpcError, createExportClient, type ExportClient } from './rpc';

const SLOT_KEY = 'conversation.chat.assistant-actions' as const;

/** locale 命名空间（client/src/locales.ts 声明键集） */
const NS = 'siyuan-export';

export const inject = ['slots', 'locale'];

interface DialogState {
  taskId: string;
  status: string;
  title: string;
  titleEdited: boolean;
  target: StoragePath | null;
  lastPath: StoragePath | null;
  error: { category: string; message: string; retryable: boolean } | null;
}

/** slot owner 提供的 props + locale seat（Research R1：owner = { messageId }） */
type SiyuanExportActionProps = PropsRuntime<typeof SLOT_KEY> &
  PropsLocale<'siyuan-export'> & {
    /** 测试注入点：默认 createExportClient（生产走真实 RPC） */
    clientFactory?: () => ExportClient;
  };

function toErrorInfo(err: unknown): { category: string; message: string; retryable: boolean } {
  if (err instanceof ClientRpcError) {
    return { category: err.category, message: err.message, retryable: err.retryable };
  }
  return { category: 'internal', message: '导出失败，请稍后重试', retryable: false };
}

/**
 * 导出按钮 + 弹窗容器（每个消息行一个实例，但弹窗只渲染一个）
 */
export function SiyuanExportAction(props: SiyuanExportActionProps): JSX.Element | null {
  const { messageId, sessionId, t } = props;
  const clientRef = useRef<ExportClient | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(false);
  const taskRef = useRef<string | null>(null);

  const client = (): ExportClient => {
    if (!clientRef.current) {
      clientRef.current = (props.clientFactory ?? createExportClient)();
    }
    return clientRef.current;
  };

  const startExport = useCallback(
    async (messageId: string) => {
      setLoading(true);
      try {
        const opened = await client().open({ messageId, sessionId: sessionId ?? '' });
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
      taskRef.current = null;
      setDialog(null);
    } catch (err) {
      setDialog((prev) => (prev ? { ...prev, status: 'failed', error: toErrorInfo(err) } : prev));
    }
  }, [dialog]);

  const retry = useCallback(async () => {
    if (!dialog) return;
    setDialog((prev) => (prev ? { ...prev, status: 'writing', error: null } : prev));
    try {
      await client().commit({ taskId: dialog.taskId, title: dialog.title, target: dialog.target! });
      taskRef.current = null;
      setDialog(null);
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
      <ExportButton messageId={messageId} loading={loading} t={t} onExport={(id) => void startExport(id)} />
      {dialog ? (
        createPortal(
          <ExportDialog
          status={dialog.status}
          title={dialog.title}
          target={dialog.target}
          lastPath={dialog.lastPath}
          error={dialog.error}
          titleEdited={dialog.titleEdited}
          t={t}
          onTitleChange={(value) =>
            setDialog((prev) => (prev ? { ...prev, title: value, titleEdited: true } : prev))
          }
          onTargetChange={(value) => setDialog((prev) => (prev ? { ...prev, target: value } : prev))}
          onSubmit={() => void submit()}
          onRetry={() => void retry()}
          onClose={close}
        >
          <DocTree
            initialPath={dialog.lastPath}
            selected={dialog.target}
            t={t}
            onLoadRoot={async (): Promise<TreeNode[]> => (await client().treeList({})).nodes}
            onLoadChildren={async (notebookId: string, docId: string): Promise<TreeNode[]> =>
              (await client().treeList({ notebookId, docId })).nodes
            }
            onSelected={(target) =>
              setDialog((prev) => (prev ? { ...prev, target } : prev))
            }
          />
          </ExportDialog>,
          document.body,
        )
      ) : null}
    </>
  );
}

export function apply(ctx: Context): void {
  // 运行时字典注册（真实试用缺陷修复：漏注册 → t() 回退显示 key，如 "button.export"）
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-siyuan-export: dictionaries',
  );
  ctx.slots.inject(SLOT_KEY, () =>
    ctx.slots.register(
      { name: SLOT_KEY, id: 'siyuan-export', order: 100, locale: NS },
      SiyuanExportAction,
    ),
  );
}
