/**
 * T023 · 导出按钮（挂在助手消息操作栏 slot）
 *
 * 纪律：loading 时禁用避免重复点击（表现层）；Host 侧另有权威防重。
 */

export interface ExportButtonProps {
  messageId: string;
  loading?: boolean;
  onExport: (messageId: string) => void;
}

export function ExportButton(props: ExportButtonProps): JSX.Element {
  const { messageId, loading = false, onExport } = props;
  return (
    <button
      type="button"
      data-siyuan-export="button"
      data-role="export-button"
      aria-label="导出到思源"
      title="导出到思源"
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
      {loading ? '导出中…' : '导出到思源'}
    </button>
  );
}
