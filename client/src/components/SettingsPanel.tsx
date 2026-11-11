/**
 * T053 · 导出设置面板（侧栏入口打开的主工作区面板）
 *
 * 即时保存（无全局保存按钮，SC-010 ≤4 次交互）：
 *  - 开关点击即 `prefs.update`，保存中禁用该项，失败回滚 Host 已保存值并就地报错
 *  - 默认路径只能经思源文档树选择或清除（FR-015：不接受本机文件系统路径）
 *  - 打开选择器不自动保存落点（`autoSelectFirst=false`）
 * 布局对齐宿主 Memory 页：居中宽栏、发丝线分隔的摘要条、分行设置项、右侧控件。
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
  lastPath: StoragePath | null;
}

interface SaveError {
  field: SaveField;
  message: string;
}

const SETTINGS_CSS = `
.sye-panel {
  --sye-hairline: rgba(127, 127, 127, 0.22);
  --sye-hairline-soft: rgba(127, 127, 127, 0.14);
  padding: 28px 32px 72px;
  color: inherit;
  font-size: 14px;
  line-height: 1.5;
}
.sye-canvas { max-width: 1040px; margin: 0 auto; }
.sye-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.sye-title { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; }
.sye-subtitle { margin: 8px 0 0; font-size: 13px; line-height: 1.5; opacity: 0.64; max-width: 640px; }
.sye-meta { flex: none; padding-top: 4px; font-size: 12px; opacity: 0.5; white-space: nowrap; }
.sye-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 20px;
  border-top: 1px solid var(--sye-hairline);
  border-bottom: 1px solid var(--sye-hairline);
}
.sye-stat { min-width: 0; padding: 14px 20px 14px 0; }
.sye-stat + .sye-stat { border-left: 1px solid var(--sye-hairline); padding-left: 20px; }
.sye-stat-label { display: block; font-size: 12px; opacity: 0.62; }
.sye-stat-value {
  display: block;
  margin-top: 5px;
  font-size: 19px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sye-stat-note {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sye-section { margin-top: 32px; }
.sye-section + .sye-section { border-top: 1px solid var(--sye-hairline); padding-top: 32px; }
.sye-section-title { margin: 0; font-size: 12px; font-weight: 600; opacity: 0.62; letter-spacing: 0.01em; }
.sye-list { margin-top: 4px; }
.sye-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 24px;
  padding: 18px 0;
}
.sye-list > .sye-row + .sye-row { border-top: 1px solid var(--sye-hairline-soft); }
.sye-row-main { min-width: 0; }
.sye-row-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; }
.sye-badge {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--sye-hairline);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 400;
  line-height: 18px;
  opacity: 0.75;
  white-space: nowrap;
}
.sye-row-hint { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; opacity: 0.62; }
.sye-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.sye-value {
  max-width: 320px;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sye-btn {
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 120ms ease;
}
.sye-btn:hover:not(:disabled) { background: rgba(127, 127, 127, 0.1); }
.sye-btn:disabled { opacity: 0.5; cursor: default; }
.sye-btn--quiet { border-color: transparent; opacity: 0.72; }
.sye-btn--quiet:hover:not(:disabled) { opacity: 1; }
.sye-switch {
  position: relative;
  flex: none;
  width: 38px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.35);
  cursor: pointer;
  transition: background 140ms ease;
}
.sye-switch[aria-checked="true"] { background: #2f7d5b; }
.sye-switch:disabled { opacity: 0.5; cursor: default; }
.sye-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: transform 140ms ease;
}
.sye-switch[aria-checked="true"] .sye-knob { transform: translateX(16px); }
.sye-tree { border-top: 1px solid var(--sye-hairline-soft); padding: 12px 0 4px; max-height: 360px; overflow: auto; }
.sye-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid var(--sye-hairline);
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--dsh-danger, #b3261e);
}
.sye-error { margin-top: 8px; font-size: 12.5px; color: var(--dsh-danger, #b3261e); }
.sye-skeleton { display: block; border-radius: 4px; background: rgba(127, 127, 127, 0.18); }
.sye-sk-sub { width: 60%; height: 12px; margin-top: 10px; }
.sye-sk-row { height: 40px; margin-top: 18px; }
.sye-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.sye-panel :focus-visible { outline: 2px solid #4a7dd9; outline-offset: 2px; }
@media (max-width: 720px) {
  .sye-panel { padding: 20px 16px 56px; }
  .sye-header { flex-direction: column; gap: 8px; }
  .sye-meta { padding-top: 0; }
  .sye-stats { grid-template-columns: minmax(0, 1fr); }
  .sye-stat { padding: 12px 0; }
  .sye-stat + .sye-stat { border-left: none; border-top: 1px solid var(--sye-hairline-soft); padding-left: 0; }
  .sye-row { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .sye-control { justify-content: flex-start; }
  .sye-value { max-width: 100%; }
}
`;

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const t = props.t ?? zhT;
  const clientRef = useRef<SettingsClient | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [showDialog, setShowDialog] = useState(true);
  const [defaultPath, setDefaultPath] = useState<StoragePath | null>(null);
  const [lastPath, setLastPath] = useState<StoragePath | null>(null);
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
      const snapshot: Snapshot = {
        showDialog: view.showDialog,
        defaultPath: view.defaultPath,
        lastPath: view.lastPath,
      };
      savedRef.current = snapshot;
      setSaved(snapshot);
      setShowDialog(snapshot.showDialog);
      setDefaultPath(snapshot.defaultPath);
      setLastPath(snapshot.lastPath);
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
        const next: Snapshot = {
          showDialog: view.showDialog,
          defaultPath: view.defaultPath,
          lastPath: view.lastPath,
        };
        savedRef.current = next;
        setSaved(next);
        setShowDialog(next.showDialog);
        setDefaultPath(next.defaultPath);
        setLastPath(next.lastPath);
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

  const modeLabel = showDialog ? t('settings.modeDialog') : t('settings.modeSilent');
  const modeNote = showDialog ? t('settings.modeDialogNote') : t('settings.modeSilentNote');
  const lastPathLabel = lastPath ? lastPath.display : '—';

  return (
    <section
      data-role="settings-panel"
      aria-label={t('settings.panel')}
      aria-busy={loading}
      className="sye-panel"
    >
      <style>{SETTINGS_CSS}</style>
      <div className="sye-canvas">
        <header className="sye-header">
          <div>
            <h1 className="sye-title">{t('settings.panel')}</h1>
            <p className="sye-subtitle">{t('settings.description')}</p>
          </div>
          <span className="sye-meta">{t('settings.autoSave')}</span>
        </header>

        {loading ? (
          <div aria-hidden="true">
            <span className="sye-sr">{t('settings.loading')}</span>
            <div className="sye-stats">
              <div className="sye-stat">
                <span className="sye-skeleton" style={{ width: '48px', height: '12px' }} />
                <span className="sye-skeleton sye-sk-sub" style={{ width: '70%' }} />
              </div>
              <div className="sye-stat">
                <span className="sye-skeleton" style={{ width: '56px', height: '12px' }} />
                <span className="sye-skeleton sye-sk-sub" style={{ width: '60%' }} />
              </div>
              <div className="sye-stat">
                <span className="sye-skeleton" style={{ width: '52px', height: '12px' }} />
                <span className="sye-skeleton sye-sk-sub" style={{ width: '64%' }} />
              </div>
            </div>
            <span className="sye-skeleton sye-sk-row" style={{ width: '100%' }} />
            <span className="sye-skeleton sye-sk-row" style={{ width: '100%' }} />
          </div>
        ) : null}

        {loadError ? (
          <div role="alert" className="sye-notice">
            <span>{`${t('settings.loadError')}：${loadError}`}</span>
            <button type="button" className="sye-btn" onClick={() => void load()}>
              {t('settings.retry')}
            </button>
          </div>
        ) : null}

        {!loading && saved ? (
          <>
            <div className="sye-stats" role="list" aria-label={t('settings.panel')}>
              <div className="sye-stat" role="listitem">
                <span className="sye-stat-label">{t('settings.mode')}</span>
                <span className="sye-stat-value">{modeLabel}</span>
                <span className="sye-stat-note" title={modeNote}>
                  {modeNote}
                </span>
              </div>
              <div className="sye-stat" role="listitem">
                <span className="sye-stat-label">{t('settings.defaultPath')}</span>
                <span
                  className="sye-stat-value"
                  data-role="default-path"
                  title={defaultPath?.display}
                >
                  {defaultPath ? defaultPath.display : t('settings.pathEmpty')}
                </span>
                <span className="sye-stat-note" title={t('settings.pathHint')}>
                  {t('settings.pathHint')}
                </span>
              </div>
              <div className="sye-stat" role="listitem">
                <span className="sye-stat-label">{t('settings.lastPath')}</span>
                <span className="sye-stat-value" title={lastPath?.display ?? undefined}>
                  {lastPathLabel}
                </span>
                <span className="sye-stat-note" title={t('settings.lastPathNote')}>
                  {t('settings.lastPathNote')}
                </span>
              </div>
            </div>

            <section className="sye-section">
              <h2 className="sye-section-title">{t('settings.behavior')}</h2>
              <div className="sye-list">
                <div className="sye-row">
                  <div className="sye-row-main">
                    <div className="sye-row-head">
                      <span id="siyuan-export-show-dialog-label">
                        {t('settings.showDialog')}
                      </span>
                      <span className="sye-badge">
                        {showDialog ? t('settings.on') : t('settings.off')}
                      </span>
                    </div>
                    <p className="sye-row-hint">{t('settings.showDialogHint')}</p>
                  </div>
                  <div className="sye-control">
                    <button
                      type="button"
                      role="switch"
                      className="sye-switch"
                      data-role="show-dialog-switch"
                      aria-checked={showDialog}
                      aria-labelledby="siyuan-export-show-dialog-label"
                      disabled={saving === 'showDialog'}
                      onClick={() => void save('showDialog', { showDialog: !showDialog })}
                    >
                      <span className="sye-knob" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
              {saveError?.field === 'showDialog' ? (
                <div role="alert" className="sye-error">
                  {saveError.message}
                </div>
              ) : null}
            </section>

            <section className="sye-section">
              <h2 className="sye-section-title">{t('settings.destination')}</h2>
              <div className="sye-list">
                <div className="sye-row">
                  <div className="sye-row-main">
                    <div className="sye-row-head">
                      <span>{t('settings.defaultPath')}</span>
                    </div>
                    <p className="sye-row-hint">{t('settings.pathHint')}</p>
                  </div>
                  <div className="sye-control">
                    <button
                      type="button"
                      className="sye-btn"
                      data-role="choose-path"
                      disabled={saving === 'defaultPath'}
                      aria-expanded={treeOpen}
                      onClick={() => setTreeOpen((prev) => !prev)}
                    >
                      {treeOpen ? t('settings.collapseTree') : t('settings.choosePath')}
                    </button>
                    {defaultPath ? (
                      <button
                        type="button"
                        className="sye-btn sye-btn--quiet"
                        data-role="clear-path"
                        disabled={saving === 'defaultPath'}
                        onClick={() => void save('defaultPath', { defaultPath: null })}
                      >
                        {t('settings.clearPath')}
                      </button>
                    ) : null}
                  </div>
                </div>
                {treeOpen ? (
                  <div className="sye-tree">
                    <DocTree
                      initialPath={defaultPath}
                      selected={defaultPath}
                      autoSelectFirst={false}
                      t={t}
                      onLoadRoot={async (): Promise<TreeNode[]> =>
                        (await client().treeList({})).nodes
                      }
                      onLoadChildren={async (
                        notebookId: string,
                        docId: string,
                      ): Promise<TreeNode[]> =>
                        (await client().treeList({ notebookId, docId })).nodes
                      }
                      onSelected={(target) => void save('defaultPath', { defaultPath: target })}
                    />
                  </div>
                ) : null}
              </div>
              {saveError?.field === 'defaultPath' ? (
                <div role="alert" className="sye-error">
                  {saveError.message}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </section>
  );
}
