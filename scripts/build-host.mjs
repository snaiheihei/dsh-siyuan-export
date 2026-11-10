/**
 * T007 · Host 侧构建（esbuild 单文件 ESM）
 *
 * - 全部裸包导入外置（`packages: 'external'`）：@deepseek-ai/* 由宿主运行时提供，
 *   绝不打入第二份 Cordis/dsh 运行时（develop-dsh-plugin §3）。
 * - 源码对 @deepseek-ai/* 仅 type-only 导入，产物运行时零解析依赖。
 */
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/host', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/host/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
});

console.log('host 已写出: dist/host/index.js');
