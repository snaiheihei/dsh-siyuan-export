/**
 * Client 入口（T008）：在助手消息操作栏注册「导出到思源」占位按钮。
 *
 * 纪律（develop-dsh-plugin §3/§7 + R1 调研）：
 *  - `ctx.slots.inject(key, cb)` 等待 slot 声明存活后再 `register`（裸 register 会抛错）
 *  - 独立 id `siyuan-export`、order 高于官方 feedback(10)，共存不替换
 *  - JSX 编译为 react/jsx-runtime（宿主基座 external，不打第二份 React）
 *  - 顶层不触碰 DOM；样式内联（不引入第二套样式体系，T038 统一文案与 locale）
 */
import type { Context } from '@deepseek-ai/cordis';
// 拉入 slot 相关的 Context/SlotMap 模块增强（type-only；注意 client 侧增强在 ./client 子路径）
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';

const SLOT_KEY = 'conversation.chat.assistant-actions' as const;

export const inject = ['slots'];

/** 占位按钮：T023 替换为真实导出交互（点击 → export.open → 弹窗） */
export function ExportButton(): JSX.Element {
  return (
    <button
      type="button"
      data-siyuan-export="placeholder"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        border: '1px solid transparent',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '2px 6px',
      }}
    >
      导出到思源
    </button>
  );
}

export function apply(ctx: Context): void {
  ctx.slots.inject(SLOT_KEY, () =>
    ctx.slots.register({ name: SLOT_KEY, id: 'siyuan-export', order: 100 }, ExportButton),
  );
}
