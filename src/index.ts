/**
 * Host 入口（dsh 树外插件）
 *
 * 装配（develop-dsh-plugin §2/§4）：
 *  - Host 侧组合领域服务：Session 读取源 → LLM 网关 → 思源写入器 → 偏好存储 → RPC 路由
 *  - 资源注册全部经 `ctx.effect()` 对称清理、重复 dispose 安全
 *  - Config 含思源 endpoint/token（凭据不入日志/审计/状态文件/RPC 响应）
 *  - 只声明实际使用的 Cordis 服务：webServer / llm / sessions
 */
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session';
import { registerRpcRoute, type RpcHandlers } from './api/routes';
import { ExportService } from './export/export-service';
import { createHostLlmGateway } from './export/llm';
import { createSessionOutputSource } from './export/session-source';
import { SiyuanClient, createNote } from './siyuan/client';
import { PrefsStore } from './store/prefs';

export interface SiyuanExportConfig {
  /** 思源本地 API 端点，默认 http://127.0.0.1:6806 */
  endpoint: string;
  /** 思源 API Token（设置 → 鉴权 → API token）；空 = 未配置，使用时按 siyuan-auth 引导 */
  token: string;
  /** 插件数据子目录（相对 resolveDshHome） */
  dataDir?: string;
}

interface StandardIssue {
  message: string;
  path?: PropertyKey[];
}

type StandardResult = { value: SiyuanExportConfig } | { issues: StandardIssue[] };

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:6806';
export const DEFAULT_DATA_DIR = 'plugins/siyuan-export';

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

  let dataDir = DEFAULT_DATA_DIR;
  if (raw.dataDir !== undefined) {
    if (typeof raw.dataDir === 'string' && raw.dataDir.length > 0) {
      dataDir = raw.dataDir;
    } else {
      issues.push({ message: 'dataDir must be a non-empty string', path: ['dataDir'] });
    }
  }

  if (issues.length > 0) return { issues };
  return { value: { endpoint, token, dataDir } };
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

/** 数据根：尊重显式配置与 DSH_HOME，不硬编码用户目录 */
function resolveDataDir(config: SiyuanExportConfig): string {
  const home = (process.env.DSH_HOME ?? '').trim() || join(process.env.HOME ?? '', '.dsh');
  return join(home, config.dataDir ?? DEFAULT_DATA_DIR);
}

export function apply(ctx: Context, config: SiyuanExportConfig): void {
  ctx.effect(() => {
    const client = new SiyuanClient({ endpoint: config.endpoint, token: config.token });
    const prefs = new PrefsStore(resolveDataDir(config));

    const service = new ExportService({
      source: createSessionOutputSource(ctx),
      gateway: createHostLlmGateway(ctx.llm as never),
      writer: {
        write: async (input) =>
          createNote({
            client,
            notebookId: input.notebookId,
            parentHPath: input.parentHPath,
            title: input.title,
            markdown: input.markdown,
          }),
      },
      prefs,
    });

    const handlers: RpcHandlers = {
      open: (request) => service.open(request),
      state: (request) => service.state(request.taskId),
      commit: (request) =>
        service.commit({ taskId: request.taskId, title: request.title, target: request.target }),
      cancel: (request) => service.cancel(request.taskId),
      treeList: async () => ({ nodes: [] }), // US2（T029/T030）实现文档树
    };

    const disposeRoute = registerRpcRoute(ctx.webServer as never, handlers);
    return () => {
      disposeRoute();
    };
  }, 'dsh-siyuan-export: apply');
}
