/**
 * T023 · 导出按钮（挂在助手消息操作栏 slot）
 *
 * 纪律：loading 时禁用避免重复点击（表现层）；Host 侧另有权威防重。
 * 文案经 `siyuan-export` locale 命名空间的 `t` seat（T038），不再硬编码。
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

export type ExportButtonProps = {
  messageId: string;
  loading?: boolean;
  onExport: (messageId: string) => void;
} & PropsLocale<'siyuan-export'>;

export function ExportButton(props: ExportButtonProps): JSX.Element {
  const { messageId, loading = false, onExport, t } = props;
  const label = loading ? t('button.exporting') : t('button.export');
  return (
    <button
      type="button"
      data-siyuan-export="button"
      data-role="export-button"
      aria-label={t('button.export')}
      title={t('button.export')}
      disabled={loading}
      onClick={() => {
        if (loading) return;
        onExport(messageId);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        border: '1px solid transparent',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        cursor: loading ? 'default' : 'pointer',
        fontSize: '12px',
        lineHeight: '18px',
        opacity: loading ? 0.6 : 1,
        padding: '2px 6px',
      }}
    >
      {label}
    </button>
  );
}
