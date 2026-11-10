import { describe, expect, it, vi } from 'vitest';
import { zh, en } from '../../client/src/locales';
import { apply, inject } from '../../client/src/entry';

/**
 * T008 · slot 注册（seam：client entry 的 `apply → ctx.slots / ctx.locale`）
 * 抓到什么：inject 导出、目标 slot key、注册描述符（name/id/order/locale）、
 *   **运行时 locale 字典注册**（真实试用缺陷修复：漏注册导致 t() 回退显示 key）。
 * 抓不到什么：真实宿主 slot 是否渲染/是否在 hover 行内（属 T009 隔离链路与 T026 E2E）、
 *   导出业务逻辑（US1 各任务）。
 *
 * 红→绿：inject 缺 'locale'、apply 未调 ctx.locale.register → 断言先红。
 */

describe('client entry slot 注册', () => {
  it('导出 inject = [slots, locale]（locale 服务供字典注册）', () => {
    expect(inject).toEqual(['slots', 'locale']);
  });

  it('apply 注册 locale 字典（siyuan-export NS → zh/en）', () => {
    const register = vi.fn(() => () => {});
    const ctx = {
      slots: { inject: vi.fn(() => () => {}), register: vi.fn(() => () => {}) },
      locale: { register },
      effect: (fn: () => unknown) => fn(),
    };
    apply(ctx as unknown as Parameters<typeof apply>[0]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('siyuan-export', { zh, en });
  });

  it('apply 经 ctx.slots.inject 注册 assistant-actions 导出按钮', () => {
    const register = vi.fn((_desc: unknown, _component: unknown) => () => {});
    const injectFn = vi.fn((_key: string, cb: () => unknown) => {
      cb(); // 模拟「slot 已声明则同步执行」
      return () => {};
    });
    const ctx = {
      slots: { inject: injectFn, register },
      locale: { register: vi.fn(() => () => {}) },
      effect: (fn: () => unknown) => fn(),
    };

    apply(ctx as unknown as Parameters<typeof apply>[0]);

    expect(injectFn).toHaveBeenCalledWith('conversation.chat.assistant-actions', expect.any(Function));
    expect(register).toHaveBeenCalledTimes(1);

    const [desc, component] = register.mock.calls[0] as unknown as [
      { name: string; id: string; order: number; locale?: string },
      unknown,
    ];
    expect(desc.name).toBe('conversation.chat.assistant-actions');
    expect(desc.id).toBe('siyuan-export');
    expect(typeof desc.order).toBe('number');
    expect(desc.locale).toBe('siyuan-export'); // 注册描述符带 NS（框架据此注入 t seat）
    // 注册的是 React 组件（Hooks 组件不可直接调用渲染 —— 渲染行为见 T023/T025 组件测试）
    expect(typeof component).toBe('function');
  });
});
