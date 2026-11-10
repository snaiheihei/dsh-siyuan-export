/**
 * T029 · 文档树服务（思源官方 API）
 *
 * 端点（全部官方，contracts/siyuan.md）：
 *  - 笔记本列表：`POST /api/notebook/lsNotebooks`（无参）
 *  - 子文档层级：`POST /api/query/sql`（显式 LIMIT + 稳定排序；未显式写 LIMIT 会按设置截断）
 *
 * blocks 表列名（真实 API 实证，2026-11-10 思源 3.8.9）：
 *   id, parent_id, root_id, box, path, hpath, name, type, ...
 *   type='d' 为文档；box 为 notebookId；hpath 为 `/层级/…/文档名`
 */
import type { TreeNode } from '../contract';
import { SiyuanClient, SiyuanError } from './client';

export interface DocRow {
  id: string;
  parent_id: string;
  box: string;
  hpath: string;
  name: string;
  /** 完整祖先链（`/<祖先id>/…/<自身id>.sy`），层级判定的真实依据 */
  path?: string;
  type: string;
}

const LIMIT_MIN = 50;
const LIMIT_MAX = 500;

/** LIMIT 钳制（子文档/根层查询共用）：非法值回落默认，区间 [50, 500] */
function clampLimit(value: number | undefined): number {
  const raw = value ?? LIMIT_MIN;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.trunc(raw)));
}

/**
 * 子文档查询（真实思源 3.8.9 实测形态）：
 *  - 文档的 `parent_id` 恒为空；层级由 `path` 表达：`/<祖先id>/<祖先id>/…/<自身id>.sy`
 *  - 直接子文档：path 以 `/<父id>/` 开头 且 path 的 `/` 段数 = 父 path 段数 + 1
 *    → 用 `instr(substr(path, length(<父path>) + 1), '/') = 0` 判定「只有一层深」
 *  - 根层文档：path 不含 `/`（仅 `/<自身id>.sy`）
 */
export function buildChildDocsQuery(input: {
  notebookId: string;
  docId: string;
  limit?: number;
}): string {
  const limit = clampLimit(input.limit);
  return [
    'SELECT id, parent_id, box, hpath, name, path, type FROM blocks',
    `WHERE type = 'd' AND box = '${escapeSql(input.notebookId)}'`,
    `AND path LIKE '/${escapeSql(input.docId)}/%'`,
    `AND instr(substr(path, length('/${escapeSql(input.docId)}/') + 1), '/') = 0`,
    'ORDER BY hpath ASC, id ASC',
    `LIMIT ${limit}`,
  ].join('\n');
}

/** 根层子文档查询：path 仅含开头 1 个斜杠（`/<自身id>.sy`） */
export function buildRootDocsQuery(input: { notebookId: string; limit?: number }): string {
  const limit = clampLimit(input.limit);
  return [
    'SELECT id, parent_id, box, hpath, name, path, type FROM blocks',
    `WHERE type = 'd' AND box = '${escapeSql(input.notebookId)}'`,
    "AND (length(path) - length(replace(path, '/', ''))) = 1",
    'ORDER BY hpath ASC, id ASC',
    `LIMIT ${limit}`,
  ].join('\n');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/** hpath → 层级分段（去掉首尾空段） */
export function splitHPath(hpath: string): string[] {
  return hpath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * 行 → 节点。hasChildren 依据同批数据中是否存在 parent_id 命中的文档行
 * （懒加载场景下父节点的子文档尚未加载时为 false，展开时再拉）。
 */
export function mapDocRows(rows: readonly DocRow[], context: { notebookId: string }): TreeNode[] {
  const docs = rows.filter((row) => row.type === 'd');
  const childIds = new Set(docs.map((row) => row.parent_id));
  return docs.map((row) => ({
    id: row.id,
    name: row.name && row.name.length > 0 ? row.name : (splitHPath(row.hpath).pop() ?? row.id),
    kind: 'doc' as const,
    notebookId: context.notebookId,
    hasChildren: childIds.has(row.id),
    path: splitHPath(row.hpath),
  }));
}

export interface SiyuanNotebook {
  id: string;
  name: string;
  closed?: boolean;
}

/** lsNotebooks 真实响应为包装对象 { notebooks: [...] }（2026-11-10 思源 3.8.9 实测） */
export interface SiyuanNotebooksPayload {
  notebooks?: SiyuanNotebook[];
}

export interface TreeService {
  /** 笔记本列表（根层） */
  listNotebooks(): Promise<TreeNode[]>;
  /** 某笔记本/文档的直接子文档 */
  listChildren(input: { notebookId: string; docId: string }): Promise<TreeNode[]>;
}

export function createTreeService(client: SiyuanClient): TreeService {
  return {
    async listNotebooks(): Promise<TreeNode[]> {
      const payload = await client.post<SiyuanNotebooksPayload | SiyuanNotebook[]>(
        '/api/notebook/lsNotebooks',
        {},
      );
      // 兼容两种形态：包装对象 {notebooks:[...]} 与裸数组
      const notebooks = Array.isArray(payload)
        ? payload
        : (payload.notebooks ?? []);
      if (!Array.isArray(notebooks)) {
        throw new SiyuanError('siyuan-connect', '思源未返回笔记本列表', true);
      }
      return notebooks.map((notebook) => ({
        id: notebook.id,
        name: notebook.name,
        kind: 'notebook' as const,
        notebookId: notebook.id,
        hasChildren: true,
        path: [],
      }));
    },

    async listChildren(input: { notebookId: string; docId: string }): Promise<TreeNode[]> {
      // 根层：parent_id 为空字符串（真实思源实测）；其余：直接子文档
      const stmt =
        input.docId === ''
          ? buildRootDocsQuery({ notebookId: input.notebookId })
          : buildChildDocsQuery(input);
      const rows = await client.post<DocRow[]>('/api/query/sql', { stmt });
      if (!Array.isArray(rows)) {
        throw new SiyuanError('siyuan-connect', '思源未返回文档列表', true);
      }
      return mapDocRows(rows, { notebookId: input.notebookId });
    },
  };
}
