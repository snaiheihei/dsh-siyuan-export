/**
 * T062 · 全局 toast 宿主（注册到 `shell.overlay`）
 *
 * 纪律：
 *  - overlay 层本身 click-through，toast 卡片必须 `pointer-events:auto`
 *  - 容器 `aria-live="polite"`；成功 `role="status"`，失败 `role="alert"`
 *  - 成功/降级显示落点与说明并自动消失；失败常驻并提供「重试」/「打开设置」
 */
import { useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ToastItem, ToastStore } from '../toast-store';

export type ToastHostProps = PropsLocale<'siyuan-export'> & {
  store: ToastStore;
  onRetry?: (item: ToastItem) => void;
  onOpenSettings?: () => void;
};

const BUTTON_STYLE = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '12px',
  lineHeight: '18px',
  padding: '2px 4px',
  textDecoration: 'underline',
} as const;

export function ToastHost(props: ToastHostProps): JSX.Element | null {
  const { store, onRetry, onOpenSettings, t } = props;
  const items = useSyncExternalStore(store.subscribe, store.list);
  if (items.length === 0) return null;

  return (
    <div
      data-role="toast-host"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        width: '320px',
        maxWidth: 'calc(100vw - 32px)',
        pointerEvents: 'none',
      }}
    >
      {items.map((item) => {
        const failed = item.kind === 'failure';
        const path = item.target?.display ?? '';
        const message = failed
          ? t('toast.failed', { reason: item.error?.message ?? t('feedback.failedGeneric') })
          : item.degraded
            ? t('toast.degraded', { path })
            : t('toast.succeeded', { path });
        return (
          <div
            key={item.id}
            role={failed ? 'alert' : 'status'}
            data-role={`toast-${item.kind}`}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
              padding: '10px 12px',
              border: '1px solid var(--dsh-border, rgba(127,127,127,0.28))',
              borderLeft: `3px solid ${failed ? 'var(--dsh-danger, #e5484d)' : 'var(--dsh-success, #30a46c)'}`,
              borderRadius: '8px',
              background: 'var(--dsh-panel-bg, #fff)',
              color: 'inherit',
              boxShadow: 'var(--dsh-shadow-overlay, 0 6px 18px rgba(0,0,0,0.16))',
              fontSize: '12px',
              lineHeight: '18px',
            }}
          >
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{message}</span>
            {failed ? (
              <span style={{ display: 'inline-flex', gap: '2px', flexShrink: 0 }}>
                {item.taskKey ? (
                  <button type="button" style={BUTTON_STYLE} onClick={() => onRetry?.(item)}>
                    {t('toast.retry')}
                  </button>
                ) : null}
                <button type="button" style={BUTTON_STYLE} onClick={() => onOpenSettings?.()}>
                  {t('toast.openSettings')}
                </button>
              </span>
            ) : null}
            <button
              type="button"
              aria-label={t('toast.dismiss')}
              style={{ ...BUTTON_STYLE, textDecoration: 'none', flexShrink: 0 }}
              onClick={() => store.dismiss(item.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
