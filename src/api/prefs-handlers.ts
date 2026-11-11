/**
 * T051 · 设置页偏好 handlers（Host 权威）
 *
 * - `prefs.get` 只投影展示/决策字段（不含 version/draft/Token）；损坏文件由 PrefsStore 回退默认值。
 * - `prefs.update` 局部更新：undefined = 不修改；显式 false/null 保留；
 *   `defaultPath` 非 null 先 `validateTarget`，失败抛 `siyuan-path` 且整次更新不落库。
 */
import type { PrefsUpdateData, PrefsUpdateRequest, PrefsView } from '../contract';
import type { PrefsData, PrefsStore } from '../store/prefs';
import { validateTarget, type TargetIo } from '../siyuan/target';

export interface PrefsHandlerDeps {
  prefs: Pick<PrefsStore, 'read' | 'update'>;
  targetIo: TargetIo;
}

export function toPrefsView(data: PrefsData): PrefsView {
  return {
    showDialog: data.showDialog,
    defaultPath: data.defaultPath,
    lastPath: data.lastPath,
  };
}

export function createPrefsHandlers(deps: PrefsHandlerDeps): {
  prefsGet(): Promise<PrefsView>;
  prefsUpdate(request: PrefsUpdateRequest): Promise<PrefsUpdateData>;
} {
  return {
    async prefsGet(): Promise<PrefsView> {
      return toPrefsView(await deps.prefs.read());
    },

    async prefsUpdate(request: PrefsUpdateRequest): Promise<PrefsUpdateData> {
      const patch: Partial<PrefsData> = {};
      if (request.showDialog !== undefined) patch.showDialog = request.showDialog;
      if (request.defaultPath !== undefined) {
        if (request.defaultPath !== null) {
          await validateTarget(request.defaultPath, deps.targetIo);
        }
        patch.defaultPath = request.defaultPath;
      }
      return toPrefsView(await deps.prefs.update(patch));
    },
  };
}
