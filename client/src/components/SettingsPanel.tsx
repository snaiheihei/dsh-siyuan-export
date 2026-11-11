/**
 * T053 · 导出设置面板（侧栏入口打开的主工作区面板）
 *
 * 即时保存（无全局保存按钮，SC-010 ≤4 次交互）：
 *  - 开关点击即 `prefs.update`，保存中禁用该项，失败回滚 Host 已保存值并就地报错
 *  - 默认路径只能经思源文档树选择或清除（FR-015：不接受本机文件系统路径）
 *  - 打开选择器不自动保存落点（`autoSelectFirst=false`）
 * 文案经 `siyuan-export` locale 的 t()（T038），不硬编码。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoragePath, TreeNode } from '../../../src/contract';
import { createExportClient, type ExportClient } from '../rpc';
import { zhT } from '../locales';
import { DocTree } from './DocTree';

export type SettingsClient = Pick<ExportClient, 'prefsGet' | 'prefsUpdate' | 'treeList'>;

export type SettingsPanelProps = {
  /** 测试注入点；生产由宿主 locale seat 注入 */
  t?: typeof zhT;
  /** 测试注入点；默认 createExportClient（生产走真实 RPC） */
  clientFactory?: () => SettingsClient;
};

type SaveField = 'showDialog' | 'defaultPath';

interface Snapshot {
  showDialog: boolean;
  defaultPath: StoragePath | null;
}

interface SaveError {
  field: SaveField;
  message: string;
}

const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
  padding: '24px',
  maxWidth: '640px',
  fontSize: '13px',
  color: 'inherit',
};

const TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '16px',
  fontWeight: 600,
  letterSpacing: '0.01em',
};

const DESCRIPTION_STYLE: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: '12px',
  opacity: 0.65,
  lineHeight: 1.5,
};

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '14px 16px',
  borderRadius: '10px',
  border: '1px solid var(--dsh-border, #d0d0d0)',
  background: 'var(--dsh-subtle-bg, rgba(127, 127, 127, 0.05))',
};

const LABEL_BLOCK_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  minWidth: 0,
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
};

const HINT_STYLE: React.CSSProperties = {
  fontSize: '12px',
  opacity: 0.6,
  lineHeight: 1.45,
};

const VALUE_STYLE: React.CSSProperties = {
  fontSize: '12px',
  opacity: 0.85,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '260px',
};

const BUTTON_STYLE: React.CSSProperties = {
  borderRadius: '8px',
  border: '1px solid var(--dsh-border, #d0d0d0)',
  background: 'var(--dsh-button-bg, #f3f3f3)',
  color: 'inherit',
  padding: '6px 12px',
  fontSize: '12px',
  cursor: 'pointer',
};

const SWITCH_STYLE: React.CSSProperties = {
  position: 'relative',
  flex: '0 0 auto',
  width: '36px',
  height: '20px',
  padding: 0,
  border: 'none',
  borderRadius: '999px',
  cursor: 'pointer',
  transition: 'background 120ms ease',
};

const KNOB_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: '2px',
  left: '2px',
  width: '16px',
  height: '16px',
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
  transition: 'transform 120ms ease',
};

const ERROR_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '12px',
  color: 'var(--dsh-danger, #c0392b)',
};

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const t = props.t ?? zhT;
  const clientRef = useRef<SettingsClient | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [showDialog, setShowDialog] = useState(true);
  const [defaultPath, setDefaultPath] = useState<StoragePath | null>(null);
  const [saving, setSaving] = useState<SaveField | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);

  /** 上一次 Host 确认的值（回滚基准；saved 状态用于渲染） */
  const savedRef = useRef<Snapshot | null>(null);

  const client = (): SettingsClient => {
    if (!clientRef.current) {
      clientRef.current = (props.clientFactory ?? createExportClient)();
    }
    return clientRef.current;
  };

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const view = await client().prefsGet();
      const snapshot: Snapshot = { showDialog: view.showDialog, defaultPath: view.defaultPath };
      savedRef.current = snapshot;
      setSaved(snapshot);
      setShowDialog(snapshot.showDialog);
      setDefaultPath(snapshot.defaultPath);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('settings.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 一次性加载（面板按 key 常驻，重复挂载会重新拉取 Host 权威值）
  useEffect(() => {
    void load();
    // eslint 未启用 react-hooks 规则；load 仅依赖 t（运行期不变）
  }, []);

  const save = useCallback(
    async (field: SaveField, patch: { showDialog?: boolean; defaultPath?: StoragePath | null }) => {
      const previous = savedRef.current;
      if (!previous) return;
      // 乐观显示新值；失败按字段回滚到 Host 已保存值
      if (patch.showDialog !== undefined) setShowDialog(patch.showDialog);
      if (patch.defaultPath !== undefined) setDefaultPath(patch.defaultPath);
      setSaving(field);
      setSaveError(null);
      try {
        const view = await client().prefsUpdate(patch);
        const next: Snapshot = { showDialog: view.showDialog, defaultPath: view.defaultPath };
        savedRef.current = next;
        setSaved(next);
        setShowDialog(next.showDialog);
        setDefaultPath(next.defaultPath);
      } catch (err) {
        if (field === 'showDialog') setShowDialog(previous.showDialog);
        else setDefaultPath(previous.defaultPath);
        const detail = err instanceof Error ? err.message : t('settings.saveError');
        setSaveError({ field, message: `${t('settings.saveError')}：${detail}` });
      } finally {
        setSaving(null);
      }
    },
    [t],
  );

  return (
    <section data-role="settings-panel" aria-label={t('settings.panel')} style={PANEL_STYLE}>
      <header>
        <h2 style={TITLE_STYLE}>{t('settings.panel')}</h2>
        <p style={DESCRIPTION_STYLE}>{t('settings.description')}</p>
      </header>

      {loading ? <div style={{ fontSize: '12px', opacity: 0.6 }}>{t('settings.loading')}</div> : null}

      {loadError ? (
        <div role="alert" style={ERROR_STYLE}>
          <span>{`${t('settings.loadError')}：${loadError}`}</span>
          <button type="button" style={BUTTON_STYLE} onClick={() => void load()}>
            {t('settings.retry')}
          </button>
        </div>
      ) : null}

      {!loading && saved ? (
        <>
          <div style={ROW_STYLE}>
            <div style={LABEL_BLOCK_STYLE}>
              <span id="siyuan-export-show-dialog-label" style={LABEL_STYLE}>
                {t('settings.showDialog')}
              </span>
              <span style={HINT_STYLE}>{t('settings.showDialogHint')}</span>
            </div>
            <button
              type="button"
              role="switch"
              data-role="show-dialog-switch"
              aria-checked={showDialog}
              aria-labelledby="siyuan-export-show-dialog-label"
              disabled={saving === 'showDialog'}
              onClick={() => void save('showDialog', { showDialog: !showDialog })}
              style={{
                ...SWITCH_STYLE,
                background: showDialog
                  ? 'var(--dsh-accent, #2f6fed)'
                  : 'var(--dsh-control, #c9ccd1)',
                opacity: saving === 'showDialog' ? 0.5 : 1,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  ...KNOB_STYLE,
                  transform: showDialog ? 'translateX(16px)' : 'translateX(0)',
                }}
              />
            </button>
          </div>
          {saveError?.field === 'showDialog' ? (
            <div role="alert" style={ERROR_STYLE}>
              {saveError.message}
            </div>
          ) : null}

          <div style={ROW_STYLE}>
            <div style={LABEL_BLOCK_STYLE}>
              <span style={LABEL_STYLE}>{t('settings.defaultPath')}</span>
              <span style={HINT_STYLE}>{t('settings.pathHint')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span data-role="default-path" style={VALUE_STYLE}>
                {defaultPath ? defaultPath.display : t('settings.pathEmpty')}
              </span>
              <button
                type="button"
                data-role="choose-path"
                style={BUTTON_STYLE}
                disabled={saving === 'defaultPath'}
                aria-expanded={treeOpen}
                onClick={() => setTreeOpen((prev) => !prev)}
              >
                {treeOpen ? t('settings.collapseTree') : t('settings.choosePath')}
              </button>
              {defaultPath ? (
                <button
                  type="button"
                  data-role="clear-path"
                  style={BUTTON_STYLE}
                  disabled={saving === 'defaultPath'}
                  onClick={() => void save('defaultPath', { defaultPath: null })}
                >
                  {t('settings.clearPath')}
                </button>
              ) : null}
            </div>
          </div>
          {saveError?.field === 'defaultPath' ? (
            <div role="alert" style={ERROR_STYLE}>
              {saveError.message}
            </div>
          ) : null}

          {treeOpen ? (
            <div style={{ padding: '4px 2px' }}>
              <DocTree
                initialPath={defaultPath}
                selected={defaultPath}
                autoSelectFirst={false}
                t={t}
                onLoadRoot={async (): Promise<TreeNode[]> => (await client().treeList({})).nodes}
                onLoadChildren={async (notebookId: string, docId: string): Promise<TreeNode[]> =>
                  (await client().treeList({ notebookId, docId })).nodes
                }
                onSelected={(target) => void save('defaultPath', { defaultPath: target })}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
