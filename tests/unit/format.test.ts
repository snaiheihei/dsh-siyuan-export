import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, formatNote, type FormatSource } from '../../src/export/format';

/**
 * T018 · 排版器（seam：formatNote 纯函数）
 * 抓到什么：H1 降级（代码围栏内不动）、小图标 markers 提取去重、
 *   元数据注记 footer（导出时间/来源会话/消息/修订/formatVersion）、结构原样保留。
 * 抓不到什么：LLM 输出质量本身（归 quickstart SC-003 抽样）。
 * 红→绿：src/export/format.ts 尚不存在。
 */

const SOURCE: FormatSource = { sessionId: 's1', messageId: 'm1', contentRevision: 'rev123' };
const AT = new Date('2026-11-10T03:00:00Z');

describe('formatNote（T018）', () => {
  it('H1 降级为 H2（避免与文档标题重复），代码围栏内的 # 标题不受影响', () => {
    const body = '# 一级标题\n\n## 二级保持\n\n```md\n# 围栏内标题\n```\n\n正文';
    const { markdown } = formatNote({ body, source: SOURCE, exportedAt: AT });
    const lines = markdown.split('\n');
    expect(lines).toContain('## 一级标题');
    expect(lines).not.toContain('# 一级标题');
    expect(lines).toContain('## 二级保持');
    expect(lines).toContain('# 围栏内标题'); // 围栏内原样
    expect(lines).toContain('```md');
  });

  it('markers 提取：按出现顺序、去重；无图标为空数组', () => {
    const withIcons = formatNote({ body: '✅ a\n📌 b\n⚠️ c\n✅ d', source: SOURCE, exportedAt: AT });
    expect(withIcons.markers).toEqual(['✅', '📌', '⚠️']);
    expect(withIcons.formatVersion).toBe(FORMAT_VERSION);

    const without = formatNote({ body: '纯文本，没有图标', source: SOURCE, exportedAt: AT });
    expect(without.markers).toEqual([]);
  });

  it('元数据注记 footer：导出时间 + 来源会话/消息/修订，且以分隔线独立于正文', () => {
    const { markdown } = formatNote({ body: '正文内容', source: SOURCE, exportedAt: AT });
    expect(markdown).toContain('正文内容');
    expect(markdown).toContain('---');
    expect(markdown).toContain('来源会话');
    expect(markdown).toContain('s1');
    expect(markdown).toContain('m1');
    expect(markdown).toContain('rev123');
    expect(markdown).toContain('2026-11-10');
    // footer 在正文之后
    expect(markdown.indexOf('正文内容')).toBeLessThan(markdown.indexOf('来源会话'));
  });

  it('列表/代码块等原样保留（除 H1 降级外不改结构）', () => {
    const body = [
      '- 列表项1',
      '- 列表项2',
      '',
      '```ts',
      'const x = 1; // # 不是标题',
      '```',
      '',
      '[链接](https://example.com)',
    ].join('\n');
    const { markdown } = formatNote({ body, source: SOURCE, exportedAt: AT });
    expect(markdown).toContain('- 列表项1');
    expect(markdown).toContain('- 列表项2');
    expect(markdown).toContain('const x = 1; // # 不是标题');
    expect(markdown).toContain('[链接](https://example.com)');
  });

  it('空 body → 不抛错，仅产出 footer', () => {
    const { markdown, markers } = formatNote({ body: '', source: SOURCE, exportedAt: AT });
    expect(markers).toEqual([]);
    expect(markdown).toContain('来源会话');
    expect(markdown.trim().startsWith('---')).toBe(false);
  });
});
