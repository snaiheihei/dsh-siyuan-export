/**
 * T007 · Host 最小入口（dsh 树外插件）
 *
 * - 导出形态：`apply(ctx, config)` + `export const inject` + `export const Config`（官方 host-plugin 参考）
 * - Config 用 Standard Schema `~standard` 手写校验（零运行时依赖，不引 zod）
 * - 所有资源注册经 `ctx.effect()` 对称清理、重复 dispose 安全
 * - token 只经 Config 传入，不写日志/审计/状态文件（凭据纪律）
 */
import type { Context } from '@deepseek-ai/cordis';
// 拉入宿主服务的 Context 模块增强（webServer / llm / sessions），type-only 不产生运行时依赖
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session';

export interface SiyuanExportConfig {
  /** 思源本地 API 端点，默认 http://127.0.0.1:6806 */
  endpoint: string;
  /** 思源 API Token（设置 → 鉴权 → API token）；空 = 未配置，使用时按 siyuan-auth 引导 */
  token: string;
}

interface StandardIssue {
  message: string;
  path?: PropertyKey[];
}

type StandardResult = { value: SiyuanExportConfig } | { issues: StandardIssue[] };

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:6806';

function validateConfig(value: unknown): StandardResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { issues: [{ message: 'config must be a plain object' }] };
  }
  const raw = value as Record<string, unknown>;
  const issues: StandardIssue[] = [];

  let endpoint = DEFAULT_ENDPOINT;
  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint === 'string' && raw.endpoint.length > 0) {
      endpoint = raw.endpoint;
    } else {
      issues.push({ message: 'endpoint must be a non-empty string', path: ['endpoint'] });
    }
  }

  let token = '';
  if (raw.token !== undefined) {
    if (typeof raw.token === 'string') {
      token = raw.token;
    } else {
      issues.push({ message: 'token must be a string', path: ['token'] });
    }
  }

  if (issues.length > 0) return { issues };
  return { value: { endpoint, token } };
}

/** 激活期配置校验（Standard Schema v1；dsh 经 `~standard` 消费） */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-siyuan-export',
    validate: validateConfig,
  },
} as const;

/** Cordis 服务注入（名称来自树内用法：webServer / llm / sessions） */
export const inject = ['webServer', 'llm', 'sessions'];

export function apply(ctx: Context, config: SiyuanExportConfig): void {
  ctx.effect(() => {
    // 注册点收口：T014 在此注册同源 RPC 路由、T020 组合导出服务，各自返回 disposer
    void config;
    return () => {
      // 对称清理：卸载时由各注册点 disposer 释放资源
    };
  }, 'dsh-siyuan-export: apply');
}
