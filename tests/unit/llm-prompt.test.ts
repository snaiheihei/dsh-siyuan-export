import { describe, expect, it } from 'vitest';
import { buildExportPrompt, createHostLlmGateway } from '../../src/export/llm';
import { startFakeLlm } from '../integration/fake-llm';

/**
 * T017 · FR-013 输入裁剪负向断言（seam：buildExportPrompt 构造点 + 网关捕获的 GenerateOptions）
 * 抓到什么：system 为静态模板（不同内容完全一致）、user 严格为 <single-output> 包裹原文、
 *   构造签名只有 content 一个输入、真实调用的 messages 精确等于模板（无 sessionId/purpose/toolHistory）。
 * 抓不到什么：模型实际收到的字节（provider 侧，归 V5B 真实链路复核）。
 *
 * 说明：FR-013 行为由 T012 实现（正向用例先红过），本文件为负向回归护栏，首跑即绿。
 */

describe('FR-013 输入裁剪（T017）', () => {
  it('prompt 构造只有 content 一个输入：system 为静态模板（不同内容完全一致）', () => {
    expect(buildExportPrompt.length).toBe(1);
    const a = buildExportPrompt('内容A');
    const b = buildExportPrompt('内容B');
    expect(a.system).toBe(b.system); // 静态，无上下文混入
    expect(a.user).not.toBe(b.user);
  });

  it('user 严格为 <single-output> 包裹的原文（无任何附加字段）', () => {
    const content = 'UNIQUE_MARKER_C1';
    const { user } = buildExportPrompt(content);
    expect(user).toBe(`<single-output>\n${content}\n</single-output>`);
  });

  it('system 不含内容本身、不含会话/消息标识词', () => {
    const { system } = buildExportPrompt('MARKER_XYZ');
    expect(system).not.toContain('MARKER_XYZ');
    expect(system).not.toContain('sessionId');
    expect(system).not.toContain('messageId');
    expect(system).not.toContain('用户提问');
  });

  it('网关真实调用：messages 精确等于模板包裹的单次输出，options 无 sessionId/purpose/toolHistory', async () => {
    const { llm, calls } = startFakeLlm({});
    await createHostLlmGateway(llm).generate({ content: 'SINGLE_ONLY_9' });
    expect(calls).toHaveLength(1);
    const options = calls[0]!.options!;
    expect(JSON.stringify(options.messages)).toBe(
      JSON.stringify([
        { role: 'user', content: [{ type: 'text', text: '<single-output>\nSINGLE_ONLY_9\n</single-output>' }] },
      ]),
    );
    expect(options).not.toHaveProperty('sessionId');
    expect(options).not.toHaveProperty('purpose');
    expect(options).not.toHaveProperty('toolHistory');
  });
});
