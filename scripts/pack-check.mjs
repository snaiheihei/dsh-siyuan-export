/**
 * T039 · 打包内容检查（develop-dsh-plugin §2：files 覆盖运行时文件、不发布敏感内容）
 *
 * 用 `npm pack --dry-run --json` 取真实 tarball 文件清单并断言：
 *  - 必含：Host/Client 产物、patch、locale、icon、package.json
 *  - 必不含：node_modules、测试、源码、env、日志、tgz、隔离测试环境
 * 退出码非 0 = 打包内容不合格。
 */
import { spawnSync } from 'node:child_process';

const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'dist/host/index.js',
  'dist/client/handoff.js',
];

const FORBIDDEN_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)tests\//,
  /(^|\/)src\//,
  /(^|\/)scripts\//,
  /\.env/,
  /\.log$/,
  /\.tgz$/,
  /dsh-siyuan-export-test/,
];

function main() {
  // --ignore-scripts：prepack 的 build 日志会污染 JSON stdout（dist 已构建，dry-run 无需重建）
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`pack --dry-run 失败: ${result.stderr}`);
    process.exit(1);
  }

  let files = [];
  try {
    const parsed = JSON.parse(result.stdout);
    files = parsed[0]?.files ?? [];
  } catch {
    console.error('无法解析 npm pack --json 输出');
    process.exit(1);
  }

  const paths = files.map((file) => file.path.replace(/\\/g, '/'));
  const problems = [];

  for (const required of REQUIRED) {
    if (!paths.includes(required)) problems.push(`缺少必需文件: ${required}`);
  }
  for (const path of paths) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(path)) problems.push(`不应打包的文件: ${path}`);
    }
  }

  if (problems.length > 0) {
    console.error('打包检查未通过:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`打包检查通过：${paths.length} 个文件，必需文件齐全、无敏感内容`);
}

main();
