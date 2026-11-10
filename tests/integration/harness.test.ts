import { afterEach, describe, expect, it } from 'vitest';
import { createHostLlmGateway } from '../../src/export/llm';
import { startFakeLlm } from './fake-llm';
import { startFakeSiyuan, type FakeSiyuan } from './fake-siyuan';

/**
 * T015 · 替身基座自测（测试环境准备，无产品行为变更）
 * 验证 fake-siyuan 的鉴权/端点/同名开关/failNext 与 fake-llm 的模式与捕获能力，
 * 供 T019 集成测试直接消费。
 */

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function post(
  fake: FakeSiyuan,
  path: string,
  body: unknown,
  token = fake.expectedToken,
): Promise<{ status: number; payload: { code: number; msg: string; data: unknown } }> {
  const res = await fetch(`${fake.endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Token ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, payload: (await res.json()) as { code: number; msg: string; data: unknown } };
}

describe('fake-siyuan', () => {
  it('鉴权 401 / version 探活 / createDocWithMd→getIDsByHPath 回读 / 同名默认 reuse', async () => {
    const fake = await startFakeSiyuan({ token: 'T1' });
    closers.push(fake.close);

    const unauth = await post(fake, '/api/system/version', {}, 'wrong');
    expect(unauth.status).toBe(401);

    const version = await post(fake, '/api/system/version', {});
    expect(version.status).toBe(200);
    expect(version.payload.code).toBe(0);

    const created = await post(fake, '/api/filetree/createDocWithMd', {
      notebook: 'nb-default',
      path: '/父级/标题',
      markdown: '# hi',
    });
    expect(created.payload.code).toBe(0);

    const ids = await post(fake, '/api/filetree/getIDsByHPath', {
      notebook: 'nb-default',
      path: '/父级/标题',
    });
    expect(ids.payload.data).toEqual([created.payload.data]);

    const again = await post(fake, '/api/filetree/createDocWithMd', {
      notebook: 'nb-default',
      path: '/父级/标题',
      markdown: '# hi2',
    });
    expect(again.payload.data).toBe(created.payload.data);

    expect(fake.requests.map((r) => r.path)).toContain('/api/filetree/createDocWithMd');
    expect(fake.docs).toHaveLength(1);
  });

  it('failNext 单次故障注入（非 2xx 形态，消费即清空）', async () => {
    const fake = await startFakeSiyuan({});
    closers.push(fake.close);

    fake.control.failNext = { status: 500, body: { error: 'boom' } };
    const first = await post(fake, '/api/system/version', {});
    expect(first.status).toBe(500);

    const second = await post(fake, '/api/system/version', {});
    expect(second.status).toBe(200);
  });

  it('duplicate 模式：同 path 并存为独立文档', async () => {
    const fake = await startFakeSiyuan({ samePath: 'duplicate' });
    closers.push(fake.close);
    const body = { notebook: 'nb-default', path: '/p/t', markdown: 'x' };
    const a = await post(fake, '/api/filetree/createDocWithMd', body);
    const b = await post(fake, '/api/filetree/createDocWithMd', body);
    expect(a.payload.data).not.toBe(b.payload.data);
    expect(fake.docs.filter((d) => d.path === '/p/t')).toHaveLength(2);
  });
});

describe('fake-llm', () => {
  it('ok 模式：产出 JSON、捕获 config/options（FR-013 输入可审计）', async () => {
    const { llm, calls } = startFakeLlm({});
    const gateway = createHostLlmGateway(llm);
    const raw = await gateway.generate({ content: '单次输出XYZ' });
    expect(JSON.parse(raw)).toEqual({ title: '默认标题', body: expect.stringContaining('✅') });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config.maxTokens).toBe(4096);
    expect(calls[0]!.options?.system).toContain('title');
    expect(JSON.stringify(calls[0]!.options?.messages)).toContain('单次输出XYZ');
  });

  it('structure-bad / timeout / no-adapter 模式可切换', async () => {
    const gatewayFor = (mode: 'structure-bad' | 'timeout' | 'no-adapter') =>
      createHostLlmGateway(startFakeLlm({ mode }).llm);

    const raw = await gatewayFor('structure-bad').generate({ content: 'x' });
    expect(raw).toContain('自由文本');

    await expect(gatewayFor('timeout').generate({ content: 'x' })).rejects.toMatchObject({
      category: 'llm-timeout',
    });
    await expect(gatewayFor('no-adapter').generate({ content: 'x' })).rejects.toMatchObject({
      category: 'llm-adapter',
    });
  });
});
