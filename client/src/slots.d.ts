/**
 * 宿主布局 slot 的最小类型增强（本插件只消费以下两个）。
 *
 * ui-sidebar / ui-layout 不在插件依赖内，故在此声明用到的 slot；
 * 形状与宿主源码一致（sidebar.panellist = list/list root；main = keyed/root）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 侧栏全局面板图标列表；list id 对应 main 面板 key */
    'sidebar.panellist': { kind: 'list'; scope: 'root' };
    /** 中央面板：按侧栏入口 id 选中 */
    main: { kind: 'keyed'; scope: 'root' };
    /** 全窗浮层（click-through），toast 等全局提示挂这里 */
    'shell.overlay': { kind: 'list'; scope: 'root' };
  }
}
