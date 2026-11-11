/**
 * T025 · 导出弹窗
 *
 * 职责（FR-002/004/009/010/012）：
 *  - 主题名输入（LLM 默认值回填；用户已编辑则不覆盖）
 *  - 存放路径显示与选择入口（US2 挂载 DocTree）
 *  - 状态反馈：generating 占位 / ready 可导出 / degraded-ready 降级提示 /
 *    succeeded 落点 / failed 原因 + 重试（保留已填字段）
 * 文案经 `siyuan-export` locale 命名空间的 `t` seat（T038），不再硬编码。
 */
import type { ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { StoragePath } from '../../../src/contract';
import { isGuideKey, shouldAppendGuide, zh } from '../locales';

export type ExportDialogProps = {
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
} & PropsLocale<'siyuan-export'>;

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
  // app 规范：floats 的阴影也应 faint（原 0 12px 40px .25 过重）
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
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

const SUBMIT_BUTTON_STYLE: React.CSSProperties = {
  ...PRIMARY_BUTTON_STYLE,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  minWidth: '92px',
};

/** 禁用态必须可见：蓝底 + pointer 会让人以为还能点（真实试用缺陷） */
const SUBMIT_DISABLED_STYLE: React.CSSProperties = {
  opacity: 0.45,
  cursor: 'not-allowed',
};

const BUSY_FEEDBACK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 10px',
  borderRadius: '8px',
  background: 'var(--dsh-subtle-bg, rgba(127, 127, 127, 0.08))',
  fontSize: '13px',
  whiteSpace: 'pre-line',
};

/** 自包含转圈（SMIL 动画，不依赖全局 keyframes） */
function Spinner(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.75s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

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
    t,
  } = props;

  const generating = status === 'generating';
  const writing = status === 'writing';
  const busy = generating || writing;
  const succeeded = status === 'succeeded';
  const failed = status === 'failed';
  const degraded = status === 'degraded-ready';
  const canSubmit = (status === 'ready' || degraded) && target !== null && !writing;

  /**
   * 四类错误的行动指引（T036，FR-010）：失败时展示在原因之后，
   * 让用户知道「下一步做什么」——与服务端 message（具体原因）互补。
   */
  const guideText = (category: string): string | null =>
    isGuideKey(category) ? t(`guide.${category}`) : null;

  /** 当前界面是否中文（服务端 message 固定中文，en 界面只走本地化文案避免混排——Top3-3） */
  const zhUi = t('dialog.title') === zh['dialog.title'];

  const feedbackText = ((): string | null => {
    if (succeeded && target) return `${t('feedback.succeeded')}${target.display}`;
    if (failed && error) {
      const guide = guideText(error.category);
      if (!zhUi) {
        // en 界面：本地化 guide 优先；无 guide 的类别用通用句，不透出服务端中文
        return guide !== null
          ? `${t('feedback.failed')}${guide}`
          : `${t('feedback.failedGeneric')}`;
      }
      const needGuide = guide !== null && shouldAppendGuide(error.message, error.category);
      return needGuide
        ? `${t('feedback.failed')}${error.message}\n${guide}`
        : `${t('feedback.failed')}${error.message}`;
    }
    if (degraded && error) {
      if (!zhUi) {
        const guide = guideText(error.category);
        const base = t('feedback.degradedShort');
        return guide !== null ? `${base}\n${guide}` : base;
      }
      const guide = guideText(error.category);
      const needGuide = guide !== null && shouldAppendGuide(error.message, error.category);
      const base = `${t('feedback.degradedPrefix')}${error.message}${t('feedback.degradedSuffix')}`;
      return needGuide ? `${base}\n${guide}` : base;
    }
    if (generating) return t('feedback.generating');
    if (writing) return t('feedback.writing');
    return null;
  })();

  const targetText = target
    ? target.display
    : lastPath
      ? t('field.targetLast', { path: lastPath.display })
      : t('field.targetEmpty');

  const submitLabel = writing
    ? t('submit.exporting')
    : generating
      ? t('submit.generating')
      : t('submit.export');
  // 禁用时给出原因（悬停可见），避免「点了没反应」
  const submitHint = generating
    ? t('feedback.generating')
    : writing
      ? t('feedback.writing')
      : !target
        ? t('field.targetEmpty')
        : undefined;

  return (
    <div style={OVERLAY_STYLE} data-role="export-dialog-overlay">
      <div style={PANEL_STYLE} role="dialog" aria-label={t('dialog.title')}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: '15px' }}>{t('dialog.title')}</strong>
          <button
            type="button"
            data-role="close"
            style={BUTTON_STYLE}
            onClick={onClose}
            aria-label={t('dialog.close')}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M2 2l8 8M10 2L2 10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={{ fontSize: '12px', opacity: 0.75 }}>{t('field.title')}</span>
          <input
            type="text"
            value={title}
            disabled={generating || succeeded}
            placeholder={generating ? t('field.titleGenerating') : t('field.titlePlaceholder')}
            onChange={(event) => onTitleChange(event.target.value)}
            style={INPUT_STYLE}
          />
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={{ fontSize: '12px', opacity: 0.75 }}>{t('field.target')}</span>
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
            {targetText}
          </div>
          {children}
        </div>

        {feedbackText ? (
          <div
            data-role="feedback"
            aria-live="polite"
            style={busy ? BUSY_FEEDBACK_STYLE : { fontSize: '13px', whiteSpace: 'pre-line' }}
          >
            {busy ? <Spinner /> : null}
            {feedbackText}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          {failed && error?.retryable ? (
            <button type="button" data-role="retry" style={BUTTON_STYLE} onClick={onRetry}>
              {t('submit.retry')}
            </button>
          ) : null}
          <button
            type="button"
            data-role="submit"
            style={canSubmit ? SUBMIT_BUTTON_STYLE : { ...SUBMIT_BUTTON_STYLE, ...SUBMIT_DISABLED_STYLE }}
            disabled={!canSubmit}
            aria-busy={busy}
            title={submitHint}
            onClick={onSubmit}
          >
            {busy ? <Spinner /> : null}
            <span>{submitLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
