// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh, en, zhT } from '../../client/src/locales';
import { apply, inject } from '../../client/src/entry';
import { BijiIcon } from '../../client/src/components/BijiIcon';

/**
 * T008/T052 · slot 注册（seam：client entry 的 `apply → ctx.slots / ctx.locale`）
 * 抓到什么：inject 导出、assistant-actions / sidebar.panellist / main 三处注册、
 *   侧栏入口 id 与主面板 key 一致、label 提供可访问名称、locale 字典注册、
 *   biji.svg 图标 onError 后仍保留入口可访问名称（label 由 slot 元数据提供）。
 * 抓不到什么：真实宿主 slot 是否渲染（属隔离链路与 E2E）、导出业务逻辑（US1/US5）。
 */

afterEach(cleanup);

function makeCtx(): {
  ctx: unknown;
  register: ReturnType<typeof vi.fn>;
  injectFn: ReturnType<typeof vi.fn>;
  localeRegister: ReturnType<typeof vi.fn>;
} {
  const register = vi.fn((_desc: unknown, _component: unknown) => () => {});
  const injectFn = vi.fn((_key: string, cb: () => unknown) => {
    cb(); // 模拟「slot 已声明则同步执行」
    return () => {};
  });
  const localeRegister = vi.fn(() => () => {});
  const ctx = {
    slots: { inject: injectFn, register },
    locale: { register: localeRegister, bind: () => zhT },
    effect: (fn: () => unknown) => fn(),
  };
  return { ctx, register, injectFn, localeRegister };
}

interface Descriptor {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  locale?: string;
  label?: () => string;
}

describe('client entry slot 注册', () => {
  it('导出 inject = [slots, locale]（locale 服务供字典注册）', () => {
    expect(inject).toEqual(['slots', 'locale']);
  });

  it('apply 注册 locale 字典（siyuan-export NS → zh/en）', () => {
    const { ctx, localeRegister } = makeCtx();
    apply(ctx as unknown as Parameters<typeof apply>[0]);
    expect(localeRegister).toHaveBeenCalledTimes(1);
    expect(localeRegister).toHaveBeenCalledWith('siyuan-export', { zh, en });
  });

  it('apply 注册 assistant-actions、sidebar.panellist 与 main（key 一致）', () => {
    const { ctx, register, injectFn } = makeCtx();

    apply(ctx as unknown as Parameters<typeof apply>[0]);

    const injectedKeys = injectFn.mock.calls.map((call) => call[0]);
    expect(injectedKeys).toEqual([
      'conversation.chat.assistant-actions',
      'sidebar.panellist',
      'main',
      'shell.overlay',
    ]);

    const descs = register.mock.calls.map((call) => call[0] as Descriptor);
    const action = descs.find((d) => d.name === 'conversation.chat.assistant-actions');
    expect(action?.id).toBe('siyuan-export');
    expect(typeof action?.order).toBe('number');

    const sidebar = descs.find((d) => d.name === 'sidebar.panellist');
    expect(sidebar).toBeDefined();
    expect(sidebar?.id).toBe('siyuan-export.settings');
    expect(sidebar?.locale).toBe('siyuan-export');
    expect(typeof sidebar?.label).toBe('function');
    expect(sidebar?.label?.()).toBeTruthy(); // 可访问名称

    const main = descs.find((d) => d.name === 'main');
    expect(main).toBeDefined();
    expect(main?.key).toBe(sidebar?.id); // 侧栏入口 id ↔ 主面板 key
    expect(main?.locale).toBe('siyuan-export');

    // 注册的都是 React 组件
    for (const call of register.mock.calls) {
      expect(typeof call[1]).toBe('function');
    }
  });

  it('biji.svg 图标加载失败 → 回退占位且不抛错（入口名称仍来自 label）', () => {
    const view = render(createElement(BijiIcon, { size: 16 }));
    const img = view.container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('data:image/svg+xml');

    fireEvent.error(img as HTMLImageElement);

    expect(view.container.querySelector('img')).toBeNull();
    const fallback = view.container.firstElementChild;
    expect(fallback?.getAttribute('aria-hidden')).toBe('true');
  });
});
