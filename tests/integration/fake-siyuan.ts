/**
 * T015 · 内存版思源 HTTP 端口（测试替身：fake，按 真实→fake→stub→mock 阶梯取 fake）
 *
 * 覆盖 T019/T029 所需端点：version / lsNotebooks / getIDsByHPath / createDocWithMd / query(sql 桩)。
 * 开关：同 path 行为（reuse=复用既有 id / duplicate=并存新文档）、failNext 单次故障注入。
 * 鉴权：Authorization 必须为 `Token <expectedToken>`，否则 401（覆盖「非 2xx」失败形态）。
 */
import { createServer, type Server } from 'node:http';

export interface FakeDoc {
  id: string;
  path: string;
}

export interface FakeNotebook {
  id: string;
  name: string;
}

export interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}

export interface FakeSiyuanControl {
  /** 下一次请求的注入故障（消费即清空）；非 2xx 形态 */
  failNext: { status: number; body: unknown } | null;
}

export interface FakeSiyuan {
  endpoint: string;
  expectedToken: string;
  notebooks: FakeNotebook[];
  docs: FakeDoc[];
  requests: RecordedRequest[];
  control: FakeSiyuanControl;
  close: () => Promise<void>;
}

interface Envelope {
  code: number;
  msg: string;
  data: unknown;
}

function ok(data: unknown): Envelope {
  return { code: 0, msg: '', data };
}

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(raw: string): Promise<Record<string, unknown>> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startFakeSiyuan(
  options: {
    token?: string;
    notebooks?: FakeNotebook[];
    docs?: FakeDoc[];
    /** 同 path 再次创建的行为，默认 reuse（真实行为文档未定，V7 用 duplicate 验证并存语义） */
    samePath?: 'reuse' | 'duplicate';
  } = {},
): Promise<FakeSiyuan> {
  const token = options.token ?? 'FAKE-TOKEN';
  const notebooks = options.notebooks ?? [{ id: 'nb-default', name: '默认笔记本' }];
  const docs: FakeDoc[] = options.docs ? [...options.docs] : [];
  const samePath = options.samePath ?? 'reuse';
  const requests: RecordedRequest[] = [];
  const control: FakeSiyuanControl = { failNext: null };
  let seq = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '/';
      const auth = req.headers.authorization;
      void readJsonBody(Buffer.concat(chunks).toString('utf8')).then((body) => {
        requests.push({ path, body, auth });

        const injected = control.failNext;
        if (injected) {
          control.failNext = null;
          json(res, injected.status, injected.body);
          return;
        }

        if (auth !== `Token ${token}`) {
          json(res, 401, { error: 'unauthorized' });
          return;
        }

        if (path === '/api/system/version') {
          json(res, 200, ok({ version: '0.0.0-fake' }));
          return;
        }
        if (path === '/api/notebook/lsNotebooks') {
          json(res, 200, ok(notebooks));
          return;
        }
        if (path === '/api/filetree/getIDsByHPath') {
          const target = typeof body.path === 'string' ? body.path : '';
          json(res, 200, ok(docs.filter((d) => d.path === target).map((d) => d.id)));
          return;
        }
        if (path === '/api/filetree/createDocWithMd') {
          const target = typeof body.path === 'string' ? body.path : '';
          const existing = docs.filter((d) => d.path === target);
          if (existing.length > 0 && samePath === 'reuse') {
            json(res, 200, ok(existing[0]!.id));
            return;
          }
          seq += 1;
          const id = `doc-${seq}-${Date.now().toString(36)}`;
          docs.push({ id, path: target });
          json(res, 200, ok(id));
          return;
        }
        if (path === '/api/query/sql') {
          // 文档树桩：T029 按真实语义扩展（按 box/parent_id 过滤 blocks 行）
          json(res, 200, ok([]));
          return;
        }
        json(res, 404, { code: -1, msg: 'not found', data: null });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    expectedToken: token,
    notebooks,
    docs,
    requests,
    control,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
