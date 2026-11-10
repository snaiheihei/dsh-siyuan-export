import { describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../../client/src/entry';

/**
 * T008 · slot 注册（seam：client entry 的 `apply → ctx.slots`）
 * 抓到什么：inject 导出、目标 slot key、注册描述符（name/id/order）、组件渲染出占位按钮与文案。
 * 抓不到什么：真实宿主 slot 是否渲染/是否在 hover 行内（属 T009 隔离链路与 T026 E2E）、
 *   导出业务逻辑（US1 各任务）。
 *
 * 红→绿：当前 entry.apply 为空实现 → 注册断言先红。
 */

describe('client entry slot 注册', () => {
  it('导出 inject = [slots]', () => {
    expect(inject).toEqual(['slots']);
  });

  it('apply 经 ctx.slots.inject 注册 assistant-actions 导出按钮', () => {
    const register = vi.fn((_desc: unknown, _component: unknown) => () => {});
    const injectFn = vi.fn((_key: string, cb: () => unknown) => {
      cb(); // 模拟「slot 已声明则同步执行」
      return () => {};
    });
    const ctx = { slots: { inject: injectFn, register } };

    apply(ctx as unknown as Parameters<typeof apply>[0]);

    expect(injectFn).toHaveBeenCalledWith('conversation.chat.assistant-actions', expect.any(Function));
    expect(register).toHaveBeenCalledTimes(1);

    const [desc, component] = register.mock.calls[0] as unknown as [
      { name: string; id: string; order: number },
      unknown,
    ];
    expect(desc.name).toBe('conversation.chat.assistant-actions');
    expect(desc.id).toBe('siyuan-export');
    expect(typeof desc.order).toBe('number');
    // 注册的是 React 组件（Hooks 组件不可直接调用渲染 —— 渲染行为见 T023/T025 组件测试）
    expect(typeof component).toBe('function');
  });
});
