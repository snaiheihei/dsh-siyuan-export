import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * T003 · Client handoff 构建测试（develop-dsh-plugin §3）
 *
 * 抓到什么：产物存在、`__ModuleLoader__.load` 闭包形态、包名 id、factory 返回
 *   `{ inject, apply }`、外部 require 仅限宿主基座 specifier、无裸 ESM import。
 * 抓不到什么：真实宿主加载时序与 slot 是否渲染（属 T009 / 隔离 E2E）、组件运行时行为。
 *
 * 红→绿：本测试先于 scripts/build-client.mjs 存在，先跑见红（产物缺失），再实现构建脚本转绿。
 */

const HANDOFF = 'dist/client/handoff.js';

/** 宿主 loader module table 基座清单（packages/client/web/src/platform.ts:8-15） */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

interface Captured {
  id?: string;
  factory?: (req: (m: string) => unknown) => { inject?: unknown; apply?: unknown };
}

describe('client handoff 产物', () => {
  it('存在、为 __ModuleLoader__.load 闭包、id/factory/导出契约与 external 纪律正确', () => {
    // 红：产物尚未构建
    expect(existsSync(HANDOFF)).toBe(true);

    const code = readFileSync(HANDOFF, 'utf8');
    expect(code).toContain('__ModuleLoader__.load');
    // 无裸 ESM import/export（CJS 闭包工厂要求）；只认行首语句，避免文案里的 "export xxx" 误报
    expect(code).not.toMatch(/^\s*(?:import|export)\s[\w{*]/m);
    // 侧栏图标内联为 dataurl（运行时不发资源请求）
    expect(code).toContain('data:image/svg+xml');

    const captured: Captured = {};
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (x: { id: string; factory: Captured['factory'] }) => {
            captured.id = x.id;
            captured.factory = x.factory;
          },
        },
      },
    };
    vm.runInNewContext(code, sandbox, { filename: HANDOFF });

    expect(captured.id).toBe('dsh-siyuan-export');
    expect(typeof captured.factory).toBe('function');

    const required: string[] = [];
    const fakeRequire = (m: string): unknown => {
      required.push(m);
      if (m === 'react') {
        return { createElement: (...args: unknown[]) => args, Fragment: 'Fragment' };
      }
      if (m === 'react/jsx-runtime') {
        return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
      }
      if (m === 'react-dom' || m === 'react-dom/client') {
        return { createPortal: (node: unknown) => node };
      }
      throw new Error(`handoff 引用了非基座 external: ${m}`);
    };

    const mod = captured.factory!(fakeRequire) as { inject?: unknown; apply?: unknown };
    expect(typeof mod.apply).toBe('function');
    expect(Array.isArray(mod.inject)).toBe(true);
    // 外部 require 全部属于宿主基座清单（基座之外必须内联）
    expect(required.every((m) => PLATFORM_MODULES.includes(m))).toBe(true);
  });
});
