import { describe, expect, it } from 'vitest';
import { blocksToText } from '../../src/export/session-source';

/**
 * T022 支撑 · 内容块 → 正文（seam：纯函数）
 * 抓到什么：只取 text 块、忽略 reasoning/tool 等非文本块、trim。
 * 抓不到什么：真实 Session 派生（宿主运行时才有；归 T026）。
 */

describe('blocksToText', () => {
  it('只拼接 text 块，忽略 reasoning/tool-call 等', () => {
    const blocks = [
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '思考过程不应进入笔记' },
      { type: 'text', text: '第二段' },
      { type: 'tool-call', id: 'tc1' as never, name: 'search', arguments: '{}' },
    ] as never;
    expect(blocksToText(blocks)).toBe('第一段\n第二段');
  });

  it('无 text 块 → 空串（触发 empty-source）', () => {
    expect(blocksToText([{ type: 'reasoning', text: 'x' }] as never)).toBe('');
  });

  it('首尾空白被裁掉', () => {
    expect(blocksToText([{ type: 'text', text: '  内容  ' }] as never)).toBe('内容');
  });
});
