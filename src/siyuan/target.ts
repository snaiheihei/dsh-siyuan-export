/**
 * T050 · 静默落点解析与目标校验（contracts/siyuan.md 规则 7）
 *
 * - `validateTarget`：notebook 存在且未关闭；`parentSegments` 非空时父级 hpath 可解析。
 *   失败一律 `siyuan-path`，不自动创建父级链、不写入。
 * - `resolveSilentTarget`：defaultPath → lastPath 笔记本根 → 首本未关闭笔记本根。
 *   **defaultPath 存在但失效时直接失败**，不回退（FR-023）。
 */
import type { StoragePath, TargetFrom } from '../contract';
import { SiyuanError, type SiyuanClient } from './client';

export interface NotebookInfo {
  id: string;
  name: string;
  closed?: boolean;
}

/** 校验/解析所需的最小 IO 边界（生产由 createTargetIo 接 SiyuanClient） */
export interface TargetIo {
  listNotebooks(): Promise<NotebookInfo[]>;
  getIdsByHPath(notebookId: string, hpath: string): Promise<string[]>;
}

export type { TargetFrom };

export interface SilentTargetResult {
  target: StoragePath;
  targetFrom: TargetFrom;
}

const INVALID_TARGET_MESSAGE = '思源路径已失效，请在设置中重新选择存放位置';
const PARENT_MISSING_MESSAGE = '思源中找不到所选父级位置，请重新选择存放位置';
const NO_NOTEBOOK_MESSAGE = '思源中没有可用的笔记本，请先创建或打开一个笔记本';

function parentHPath(path: StoragePath): string | null {
  if (path.parentSegments.length === 0) return null;
  return `/${path.parentSegments.join('/')}`;
}

/** 目标校验：失败抛 siyuan-path，调用方不得写入 */
export async function validateTarget(path: StoragePath, io: TargetIo): Promise<void> {
  const notebooks = await io.listNotebooks();
  const notebook = notebooks.find((item) => item.id === path.notebookId);
  if (!notebook || notebook.closed === true) {
    throw new SiyuanError('siyuan-path', INVALID_TARGET_MESSAGE, false);
  }
  const hpath = parentHPath(path);
  if (hpath !== null) {
    const ids = await io.getIdsByHPath(path.notebookId, hpath);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new SiyuanError('siyuan-path', PARENT_MISSING_MESSAGE, false);
    }
  }
}

function notebookRoot(notebook: NotebookInfo): StoragePath {
  return {
    notebookId: notebook.id,
    notebookName: notebook.name,
    parentSegments: [],
    display: notebook.name,
  };
}

export async function resolveSilentTarget(
  prefs: { defaultPath: StoragePath | null; lastPath: StoragePath | null },
  io: TargetIo,
): Promise<SilentTargetResult> {
  if (prefs.defaultPath) {
    // 失效直接抛出，不尝试 lastPath / 首本笔记本（FR-023）
    await validateTarget(prefs.defaultPath, io);
    return { target: prefs.defaultPath, targetFrom: 'default' };
  }

  const notebooks = await io.listNotebooks();

  if (prefs.lastPath) {
    const remembered = notebooks.find(
      (item) => item.id === prefs.lastPath?.notebookId && item.closed !== true,
    );
    if (remembered) {
      return { target: notebookRoot(remembered), targetFrom: 'last' };
    }
    // 记住的笔记本已关闭/不存在 → 落到首本未关闭笔记本
  }

  const first = notebooks.find((item) => item.closed !== true);
  if (!first) {
    throw new SiyuanError('siyuan-path', NO_NOTEBOOK_MESSAGE, false);
  }
  return { target: notebookRoot(first), targetFrom: 'first-notebook' };
}

export function createTargetIo(client: SiyuanClient): TargetIo {
  return {
    async listNotebooks(): Promise<NotebookInfo[]> {
      const payload = await client.post<{ notebooks?: NotebookInfo[] } | NotebookInfo[]>(
        '/api/notebook/lsNotebooks',
        {},
      );
      const list = Array.isArray(payload) ? payload : (payload.notebooks ?? []);
      if (!Array.isArray(list)) {
        throw new SiyuanError('siyuan-connect', '思源未返回笔记本列表', true);
      }
      return list;
    },
    async getIdsByHPath(notebookId: string, hpath: string): Promise<string[]> {
      const ids = await client.postWithRetry<string[]>(
        '/api/filetree/getIDsByHPath',
        { notebook: notebookId, path: hpath },
      );
      return Array.isArray(ids) ? ids : [];
    },
  };
}
