/**
 * T003 · Client handoff 构建（develop-dsh-plugin §3）
 *
 * 产出宿主要求的 CJS 闭包工厂形态：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return module.exports } })
 *
 * - 外部化 = 宿主 loader module table 基座清单（不得打入第二份 React 等）
 * - 产物不得残留裸 ESM import/export（tests/client/handoff.test.ts 断言）
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

/** 宿主 loader module table 基座（packages/client/web/src/platform.ts:8-15） */
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

const pkg = JSON.parse(await readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const result = await build({
  entryPoints: ['client/src/entry.tsx'],
  outfile: 'dist/client/handoff.js',
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  loader: { '.svg': 'dataurl' },
  sourcemap: false,
  logLevel: 'info',
});

const bundle = result.outputFiles?.[0]?.text;
if (!bundle) throw new Error('esbuild 未产出文件');

// 包裹为 __ModuleLoader__.load 闭包工厂：factory 作用域内提供 require(参数)、module、exports
const indented = bundle
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n');
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${indented}
    return module.exports;
  },
});
`;

await mkdir('dist/client', { recursive: true });
await writeFile('dist/client/handoff.js', wrapped, 'utf8');
console.log(`handoff 已写出: dist/client/handoff.js (${wrapped.length} bytes)`);
