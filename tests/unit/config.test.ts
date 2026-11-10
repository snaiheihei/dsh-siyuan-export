import { describe, expect, it } from 'vitest';
import { Config } from '../../src/index';

/**
 * T007 · Config 校验（seam：Standard Schema `~standard.validate`）
 * 抓到什么：默认 endpoint、token 可缺省、非法类型与非对象被拒、清洗后的结构。
 * 抓不到什么：apply 装载、路由注册、真实 profile 激活（属 T009 隔离链路）。
 *
 * 红→绿：src/index.ts 尚无 Config 导出 → 本测试先红。
 */

type ValidateResult = { value?: unknown; issues?: { message: string }[] };
interface StandardShape {
  '~standard': { version: number; vendor: string; validate: (value: unknown) => ValidateResult };
}

const validate = (Config as unknown as StandardShape)['~standard'].validate;

describe('插件 Config（~standard.validate）', () => {
  it('空对象 → 默认 endpoint + 空 token + 默认 dataDir', () => {
    const r = validate({});
    expect(r.issues).toBeUndefined();
    expect(r.value).toEqual({
      endpoint: 'http://127.0.0.1:6806',
      token: '',
      dataDir: 'plugins/siyuan-export',
    });
  });

  it('显式提供 endpoint/token 时原样保留', () => {
    const r = validate({ endpoint: 'http://127.0.0.1:6807', token: 'secret-token' });
    expect(r.issues).toBeUndefined();
    expect(r.value).toEqual({
      endpoint: 'http://127.0.0.1:6807',
      token: 'secret-token',
      dataDir: 'plugins/siyuan-export',
    });
  });

  it('dataDir 类型非法 → issues', () => {
    expect(validate({ dataDir: 42 }).issues?.length).toBeGreaterThan(0);
    expect(validate({ dataDir: '' }).issues?.[0]?.message).toContain('dataDir');
  });

  it('endpoint/token 类型非法 → issues（带 path）', () => {
    const r1 = validate({ endpoint: 123 });
    expect(r1.issues?.length).toBeGreaterThan(0);
    expect(r1.issues?.[0]?.message).toContain('endpoint');
    const r2 = validate({ token: null });
    expect(r2.issues?.length).toBeGreaterThan(0);
    expect(r2.issues?.[0]?.message).toContain('token');
  });

  it('非对象配置 → issues', () => {
    for (const bad of ['nope', 42, null, ['x']]) {
      expect(validate(bad).issues?.length).toBeGreaterThan(0);
    }
  });

  it('schema 元数据符合 Standard Schema v1（version/vendor）', () => {
    const shape = Config as unknown as StandardShape;
    expect(shape['~standard'].version).toBe(1);
    expect(shape['~standard'].vendor).toBe('dsh-siyuan-export');
  });
});
