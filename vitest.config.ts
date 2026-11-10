import { defineConfig } from 'vitest/config';

/**
 * 分层测试（plan.md Testing）：
 *  - tests/unit        纯业务单元（node 环境）
 *  - tests/integration Temp 目录 / fake 端口集成（node 环境）
 *  - tests/client      组件与 handoff（组件测试文件头声明 // @vitest-environment jsdom）
 *  - tests/e2e         隔离 Host 真实验证（由 quickstart 驱动，单独运行）
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
