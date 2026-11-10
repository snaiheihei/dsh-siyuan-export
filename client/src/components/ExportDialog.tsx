/**
 * T025 · 导出弹窗
 *
 * 职责（FR-002/004/009/010/012）：
 *  - 主题名输入（LLM 默认值回填；用户已编辑则不覆盖）
 *  - 存放路径显示与选择入口（US2 挂载 DocTree）
 *  - 状态反馈：generating 占位 / ready 可导出 / degraded-ready 降级提示 /
 *    succeeded 落点 / failed 原因 + 重试（保留已填字段）
 */
import type { ReactNode } from 'react';
import type { StoragePath } from '../../../src/contract';

export interface ExportDialogProps {
  status: string;
  title: string;
  target: StoragePath | null;
  lastPath: StoragePath | null;
  error: { category: string; message: string; retryable: boolean } | null;
  /** 用户是否手动改过标题（决定 LLM 回填是否覆盖） */
  titleEdited: boolean;
  onTitleChange: (title: string) => void;
  onTargetChange: (target: StoragePath | null) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onClose: () => void;
  /** US2：文档树选择区挂载点 */
  children?: ReactNode;
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.35)',
  zIndex: 1000,
};

const PANEL_STYLE: React.CSSProperties = {
  width: 'min(520px, 92vw)',
  maxHeight: '80vh',
  overflow: 'auto',
  borderRadius: '12px',
  padding: '20px',
  background: 'var(--dsh-panel-bg, #fff)',
  color: 'var(--dsh-panel-fg, #1a1a1a)',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  borderRadius: '8px',
  border: '1px solid var(--dsh-border, #d0d0d0)',
  background: 'var(--dsh-input-bg, #fff)',
  color: 'inherit',
  padding: '8px 10px',
  fontSize: '14px',
};

const BUTTON_STYLE: React.CSSProperties = {
  borderRadius: '8px',
  border: '1px solid var(--dsh-border, #d0d0d0)',
  background: 'var(--dsh-button-bg, #f3f3f3)',
  color: 'inherit',
  padding: '8px 14px',
  fontSize: '13px',
  cursor: 'pointer',
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  background: 'var(--dsh-accent, #2f6fed)',
  borderColor: 'var(--dsh-accent, #2f6fed)',
  color: '#fff',
};

export function ExportDialog(props: ExportDialogProps): JSX.Element {
  const {
    status,
    title,
    target,
    lastPath,
    error,
    onTitleChange,
    onSubmit,
    onRetry,
    onClose,
    children,
  } = props;

  const generating = status === 'generating';
  const writing = status === 'writing';
  const succeeded = status === 'succeeded';
  const failed = status === 'failed';
  const degraded = status === 'degraded-ready';
  const canSubmit = (status === 'ready' || degraded) && target !== null && !writing;

  const feedbackText = ((): string | null => {
    if (succeeded && target) return `已导出到：${target.display}`;
    if (failed && error) return `导出失败：${error.message}`;
    if (degraded && error) return `未能自动排版（${error.message}），已使用原文，可继续导出`;
    if (generating) return '正在生成默认主题名…';
    if (writing) return '正在写入思源…';
    return null;
  })();

  return (
    <div style={OVERLAY_STYLE} data-role="export-dialog-overlay">
      <div style={PANEL_STYLE} role="dialog" aria-label="导出到思源">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: '15px' }}>导出到思源</strong>
          <button
            type="button"
            data-role="close"
            style={BUTTON_STYLE}
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '12px', opacity: 0.75 }}>主题名</span>
          <input
            type="text"
            value={title}
            disabled={generating || succeeded}
            placeholder={generating ? '正在生成默认主题名…' : '请输入笔记标题'}
            onChange={(event) => onTitleChange(event.target.value)}
            style={INPUT_STYLE}
          />
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '12px', opacity: 0.75 }}>存放位置</span>
          <div
            data-role="target-display"
            style={{
              border: '1px solid var(--dsh-border, #d0d0d0)',
              borderRadius: '8px',
              padding: '8px 10px',
              fontSize: '13px',
              minHeight: '34px',
            }}
          >
            {target ? target.display : lastPath ? `未选择（上次：${lastPath.display}）` : '未选择'}
          </div>
          {children}
        </div>

        {feedbackText ? (
          <div data-role="feedback" style={{ fontSize: '13px', opacity: 0.85 }}>
            {feedbackText}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          {failed && error?.retryable ? (
            <button type="button" data-role="retry" style={BUTTON_STYLE} onClick={onRetry}>
              重试
            </button>
          ) : null}
          <button
            type="button"
            data-role="submit"
            style={PRIMARY_BUTTON_STYLE}
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {writing ? '导出中…' : '导出'}
          </button>
        </div>
      </div>
    </div>
  );
}
