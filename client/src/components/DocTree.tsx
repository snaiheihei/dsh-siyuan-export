/**
 * T031/T032 · 思源文档树选择器
 *
 * 交互：单击节点 = 选中该层为落点 +（若有子）展开并懒加载下一层。
 * 纪律（contracts/rpc.md + develop-dsh-plugin §7）：
 *  - 懒加载：根层 onLoadRoot（笔记本），展开按层 onLoadChildren（tree.list 懒加载语义）
 *  - stale 响应丢弃：慢的旧请求不覆盖新状态（requestId 比对）
 *  - initialPath 逐层展开并默认选中（T032：上次成功路径）
 *  - initialPath 为空时默认选中第一个笔记本根（spec：笔记本根可直接导出）
 *  - 加载失败就地显示原因并可重试（FR-010）
 * 文案经 `siyuan-export` locale 的 t()，不硬编码（T038/T043）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { StoragePath, TreeNode } from '../../../src/contract';

export type DocTreeProps = {
  /** 上次成功路径（Prefs.lastPath）；null = 首次导出 */
  initialPath: StoragePath | null;
  /** 外部控制的选中态（用于回显） */
  selected: StoragePath | null;
  /** 根层加载（笔记本列表） */
  onLoadRoot: () => Promise<TreeNode[]>;
  /** 按层加载子文档；docId 为空串表示笔记本根层 */
  onLoadChildren: (notebookId: string, docId: string) => Promise<TreeNode[]>;
  onSelected: (target: StoragePath) => void;
} & PropsLocale<'siyuan-export'>;

interface LoadError {
  key: string;
  notebookId: string;
  docId: string;
  message: string;
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '6px',
  padding: '4px 6px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
};

const BUTTON_STYLE: React.CSSProperties = {
  borderRadius: '6px',
  border: '1px solid var(--dsh-border, #d0d0d0)',
  background: 'var(--dsh-button-bg, #f3f3f3)',
  color: 'inherit',
  padding: '2px 8px',
  fontSize: '12px',
  cursor: 'pointer',
};

const CARET_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '14px',
  height: '14px',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 1,
  cursor: 'pointer',
  opacity: 0.7,
};

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

export function DocTree(props: DocTreeProps): JSX.Element {
  const { initialPath, selected, onLoadRoot, onLoadChildren, t } = props;

  const [roots, setRoots] = useState<TreeNode[] | null>(null);
  const [childrenMap, setChildrenMap] = useState<Record<string, TreeNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<LoadError | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [autoSelectedKey, setAutoSelectedKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const requestRef = useRef(0);
  const initialAppliedRef = useRef(false);
  // onSelected 在初始化逻辑中使用最新引用（一次性初始化，避免 effect 重跑）
  const selectedRef = useRef(props.onSelected);
  selectedRef.current = props.onSelected;

  const buildTarget = useCallback(
    (node: TreeNode): StoragePath => {
      if (node.kind === 'notebook') {
        return {
          notebookId: node.id,
          notebookName: node.name,
          parentSegments: [],
          display: node.name,
        };
      }
      const notebookName = roots?.find((n) => n.id === node.notebookId)?.name ?? node.notebookId;
      return {
        notebookId: node.notebookId,
        notebookName,
        parentSegments: node.path,
        display: node.path.length > 0 ? `${notebookName} / ${node.path.join(' / ')}` : notebookName,
      };
    },
    [roots],
  );

  /** 无条件展开某 key（懒加载成功后/已加载节点点击）——消 5 处 Set+add 重复 */
  const expandKey = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  /** 折叠/展开切换（独立于行点击，避免折叠时改变目标路径） */
  const toggleKey = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadChildren = useCallback(
    async (key: string, notebookId: string, docId: string): Promise<void> => {
      const requestId = ++requestRef.current;
      setLoadingKey(key);
      setError(null);
      try {
        const nodes = await onLoadChildren(notebookId, docId);
        if (requestId !== requestRef.current) return; // stale：丢弃旧响应
        setChildrenMap((prev) => ({ ...prev, [key]: nodes }));
        expandKey(key);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError({
          key,
          notebookId,
          docId,
          message: err instanceof Error ? err.message : t('tree.loadError'),
        });
      } finally {
        if (requestId === requestRef.current) setLoadingKey(null);
      }
    },
    [onLoadChildren, expandKey, t],
  );

  const loadRoot = useCallback(async (): Promise<TreeNode[] | null> => {
    const requestId = ++requestRef.current;
    setLoadingKey('root');
    setError(null);
    try {
      const nodes = await onLoadRoot();
      if (requestId !== requestRef.current) return null;
      setRoots(nodes);
      return nodes;
    } catch (err) {
      if (requestId === requestRef.current) {
        setError({
          key: 'root',
          notebookId: '',
          docId: '',
          message: err instanceof Error ? err.message : t('tree.loadError'),
        });
      }
      return null;
    } finally {
      if (requestId === requestRef.current) setLoadingKey(null);
    }
  }, [onLoadRoot, t]);

  /**
   * 从笔记本根层逐段加载并展开，直到与 path.parentSegments 完全匹配（T047 提取：
   * 缩短初始化 effect、以局部常量替代 `matched!` 非空断言）。
   * 中途失败/过期请求则停止，保持已展开部分（行内重试兜底）。
   */
  const expandToPath = async (notebook: TreeNode, path: StoragePath): Promise<void> => {
    const requestId = ++requestRef.current;
    let current: TreeNode[];
    try {
      current = await onLoadChildren(notebook.id, '');
    } catch (err) {
      if (requestId === requestRef.current) {
        setError({
          key: notebook.id,
          notebookId: notebook.id,
          docId: '',
          message: err instanceof Error ? err.message : t('tree.loadError'),
        });
      }
      return;
    }
    if (requestId !== requestRef.current) return;
    setChildrenMap((prev) => ({ ...prev, [notebook.id]: current }));
    expandKey(notebook.id);

    let matched: TreeNode | undefined;
    for (let depth = 1; depth <= path.parentSegments.length; depth += 1) {
      const prefix = path.parentSegments.slice(0, depth);
      const hit = current.find((node) => samePath(node.path, prefix));
      if (!hit) {
        matched = undefined;
        break;
      }
      matched = hit;
      if (hit.path.length === path.parentSegments.length) break;
      expandKey(hit.id);
      try {
        current = await onLoadChildren(hit.notebookId, hit.id);
      } catch {
        return; // 中途失败：错误由行内重试兜底
      }
      if (requestId !== requestRef.current) return;
      const childKey = hit.id;
      setChildrenMap((prev) => ({ ...prev, [childKey]: current }));
    }

    if (matched && samePath(matched.path, path.parentSegments)) {
      setAutoSelectedKey(matched.id);
      selectedRef.current(
        matched.kind === 'notebook'
          ? {
              notebookId: matched.id,
              notebookName: matched.name,
              parentSegments: [],
              display: matched.name,
            }
          : path,
      );
    }
  };

  // 初始化：加载根层 + initialPath 逐层展开（T032）或默认选中首个笔记本根
  useEffect(() => {
    if (initialAppliedRef.current) return;
    initialAppliedRef.current = true;
    void (async () => {
      const nodes = await loadRoot();
      if (!nodes || nodes.length === 0) return;

      if (initialPath) {
        const notebook = nodes.find((n) => n.id === initialPath.notebookId);
        if (notebook) await expandToPath(notebook, initialPath);
        return;
      }

      // 首次导出（lastPath=null）：默认选中第一个笔记本根，使「笔记本根可直接导出」
      const first = nodes[0]!;
      setAutoSelectedKey(first.id);
      selectedRef.current({
        notebookId: first.id,
        notebookName: first.name,
        parentSegments: [],
        display: first.name,
      });
    })();
    // 一次性初始化（effect 仅在挂载时执行一次）
  }, []);

  const handleNodeClick = (node: TreeNode): void => {
    props.onSelected(buildTarget(node));
    setAutoSelectedKey(node.id);
    if (node.kind === 'notebook') {
      if (!childrenMap[node.id]) void loadChildren(node.id, node.id, '');
      else expandKey(node.id);
    } else if (node.hasChildren) {
      if (!childrenMap[node.id]) void loadChildren(node.id, node.notebookId, node.id);
      else expandKey(node.id);
    }
  };

  /** 指示符点击：已展开则折叠；未展开且未加载则先加载，否则直接展开 */
  const handleToggle = (node: TreeNode): void => {
    if (expanded.has(node.id)) {
      toggleKey(node.id);
      return;
    }
    if (!childrenMap[node.id]) {
      if (node.kind === 'notebook') void loadChildren(node.id, node.id, '');
      else void loadChildren(node.id, node.notebookId, node.id);
    } else {
      expandKey(node.id);
    }
  };

  const retry = (): void => {
    if (!error) return;
    if (error.key === 'root') void loadRoot();
    else void loadChildren(error.key, error.notebookId, error.docId);
  };

  const isSelected = (node: TreeNode): boolean => {
    const target = buildTarget(node);
    return (
      autoSelectedKey === node.id ||
      (selected !== null && selected.display === target.display)
    );
  };

  const renderRow = (node: TreeNode, depth: number): JSX.Element => {
    const open = expanded.has(node.id);
    const loading = loadingKey === node.id;
    const selectedRow = isSelected(node);
    const hovered = hoverKey === node.id;
    return (
      <div key={node.id}>
        <div
          style={{
            ...ROW_STYLE,
            paddingLeft: `${6 + depth * 14}px`,
            // app 规范：selected 用 active 灰底 fill（accent 不上 chrome）
            background: selectedRow ? 'var(--dsh-active, #eeeeee)' : 'transparent',
            // hover 用 1px outline，不改 fill（app 规范：No hover that changes the fill）
            outline: hovered && !selectedRow ? '1px solid var(--dsh-control, #d1d5db)' : 'none',
            outlineOffset: '-1px',
          }}
          onClick={() => handleNodeClick(node)}
          onMouseEnter={() => setHoverKey(node.id)}
          onMouseLeave={() => setHoverKey((prev) => (prev === node.id ? null : prev))}
          role="treeitem"
          aria-expanded={node.hasChildren ? open : undefined}
          aria-selected={selectedRow}
        >
          {node.hasChildren ? (
            <button
              type="button"
              data-role="tree-toggle"
              aria-label={open ? t('tree.collapse') : t('tree.expand')}
              aria-expanded={open}
              disabled={loading}
              onClick={(event) => {
                event.stopPropagation();
                handleToggle(node);
              }}
              style={CARET_STYLE}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span style={{ opacity: 0.6 }}>·</span>
          )}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.name}
          </span>
          {selectedRow ? (
            <span style={{ fontSize: '11px', color: 'inherit', opacity: 0.7 }}>
              {t('tree.selected')}
            </span>
          ) : null}
          {loading ? (
            <span style={{ fontSize: '11px', opacity: 0.6 }}>{t('tree.loading')}</span>
          ) : null}
        </div>
        {open && childrenMap[node.id] ? (
          <div>{childrenMap[node.id]!.map((child) => renderRow(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div data-role="doc-tree" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {error ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
          <span style={{ color: 'var(--dsh-danger, #c0392b)' }}>{error.message}</span>
          <button type="button" style={BUTTON_STYLE} onClick={retry}>
            {t('tree.retry')}
          </button>
        </div>
      ) : null}
      {roots === null && !error ? (
        <div style={{ fontSize: '12px', opacity: 0.6 }}>{t('tree.loading')}</div>
      ) : null}
      {roots?.map((node) => renderRow(node, 0))}
    </div>
  );
}
