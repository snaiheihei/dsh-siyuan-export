import { describe, expect, it } from 'vitest';
import {
  buildChildDocsQuery,
  buildNotebooksQuery,
  buildRootDocsQuery,
  mapDocRows,
  type DocRow,
} from '../../src/siyuan/tree';

/**
 * T027 · 文档树服务（seam：SQL 语句生成 + 行映射 —— 纯函数）
 * 抓到什么：子文档查询按 box + 父 id 过滤、显式 LIMIT + 稳定排序（按官方「默认截断」规则）、
 *   行映射产出 id/name/hpath/hasChildren、hpath → parentSegments 切分、
 *   未闭合父路径时只取到自身段落（边界）。
 * 抓不到什么：真实思源返回（T026/quickstart V2 实测；blocks 列名已由真实 API 实证：
 *   id, parent_id, root_id, box, path, hpath, name, type='d'）。
 * 红→绿：src/siyuan/tree.ts 尚不存在。
 */

const ROWS: DocRow[] = [
  {
    id: '20260707141833-ce745w8',
    parent_id: '20231130192456-0yzae7f',
    box: 'nb-1',
    hpath: '/AI',
    name: 'AI',
    type: 'd',
  },
  {
    id: 'child-1',
    parent_id: '20260707141833-ce745w8',
    box: 'nb-1',
    hpath: '/AI/Spec-Test-Driven',
    name: 'Spec-Test-Driven',
    type: 'd',
  },
];

describe('buildNotebooksQuery（T027）', () => {
  it('笔记本列表用官方 lsNotebooks 接口（无 SQL）', () => {
    expect(buildNotebooksQuery()).toBeNull();
  });
});

describe('buildChildDocsQuery（T027）', () => {
  it('按 box 过滤，type 为文档类型，显式 LIMIT 与稳定排序', () => {
    const stmt = buildChildDocsQuery({ notebookId: 'nb-1', docId: 'parent-1', limit: 200 });
    expect(stmt).toContain("type = 'd'");
    expect(stmt).toContain('box =');
    expect(stmt).toContain('LIMIT 200');
    // 稳定排序：同一目录多次查询结果一致
    expect(stmt).toMatch(/ORDER BY[\s\S]*hpath/i);
  });

  it('根层查询：path 斜杠数 = 1（真实思源 3.8.9 实测：根=1、子=2+）', () => {
    const stmt = buildRootDocsQuery({ notebookId: 'nb-1' });
    expect(stmt).toContain("(length(path) - length(replace(path, '/', ''))) = 1");
    expect(stmt).toContain("type = 'd'");
    expect(stmt).toContain('LIMIT 50');
  });

  it('子文档查询用 path 前缀 + 深度过滤（parent_id 恒为空的真实语义）', () => {
    const stmt = buildChildDocsQuery({ notebookId: 'nb-1', docId: 'DOC-1' });
    expect(stmt).toContain("path LIKE '/DOC-1/%'");
    expect(stmt).toContain("instr(substr(path");
    // 不再依赖 parent_id
    expect(stmt).not.toContain('parent_id =');
  });

  it('LIMIT 为正整数且受上限保护', () => {
    expect(buildChildDocsQuery({ notebookId: 'nb', docId: 'p', limit: 0 })).toContain('LIMIT 50');
    expect(buildChildDocsQuery({ notebookId: 'nb', docId: 'p', limit: 10_000 })).toContain('LIMIT 500');
    expect(buildChildDocsQuery({ notebookId: 'nb', docId: 'p', limit: 50 })).toContain('LIMIT 50');
  });
});

describe('mapDocRows（T027）', () => {
  it('行 → 节点：id/name/kind/hasChildren/path', () => {
    const nodes = mapDocRows(ROWS, { notebookId: 'nb-1' });
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      id: '20260707141833-ce745w8',
      name: 'AI',
      kind: 'doc',
      notebookId: 'nb-1',
    });
    expect(nodes[0]!.path).toEqual(['AI']);
    expect(nodes[1]!.path).toEqual(['AI', 'Spec-Test-Driven']);
  });

  it('hasChildren：存在子文档的父节点为 true（依据行中的 parent_id 命中）', () => {
    const nodes = mapDocRows(ROWS, { notebookId: 'nb-1' });
    const ai = nodes.find((n) => n.name === 'AI');
    expect(ai!.hasChildren).toBe(true);
    const leaf = nodes.find((n) => n.name === 'Spec-Test-Driven');
    expect(leaf!.hasChildren).toBe(false);
  });

  it('非文档行（type != d）被过滤', () => {
    const nodes = mapDocRows(
      [...ROWS, { ...ROWS[0]!, id: 'p1', type: 'p' }],
      { notebookId: 'nb-1' },
    );
    expect(nodes).toHaveLength(2);
  });

  it('空 hpath 的行 → path 为空数组（不抛错）', () => {
    const nodes = mapDocRows([{ ...ROWS[0]!, hpath: '' }], { notebookId: 'nb-1' });
    expect(nodes[0]!.path).toEqual([]);
  });
});
