/**
 * T021 · 结构化笔记排版器（纯函数）
 *
 * 职责（FR-008/FR-009）：
 *  - H1 降级为 H2（文档标题即笔记主题，避免与正文一级标题重复）；代码围栏内不动
 *  - 提取要点小图标（✅ 📌 ⚠️ 💡 等）并去重、保序
 *  - 追加元数据注记 footer（导出时间 / 来源会话 / 消息 / 内容修订 / 排版版本）
 *  - 列表、代码块、链接等原样保留
 */
import type { StoragePath } from '../contract';

/** 排版格式版本（便于日后迁移） */
export const FORMAT_VERSION = 1;

/** 允许的小图标集合（通用表情符号，无需额外资源） */
export const NOTE_MARKERS = ['✅', '📌', '⚠️', '💡'] as const;

export interface FormatSource {
  sessionId: string;
  messageId: string;
  contentRevision: string;
}

export interface FormatInput {
  /** 结构化正文（LLM 输出或降级原文） */
  body: string;
  source: FormatSource;
  exportedAt: Date;
  target?: StoragePath;
}

export interface FormatResult {
  markdown: string;
  markers: string[];
  formatVersion: number;
}

/** 代码围栏区间（行号集合）：围栏内的内容一律不改动 */
function fencedLineIndices(lines: string[]): Set<number> {
  const inside = new Set<number>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = line.match(/^\s*(```+|~~~+)/);
    if (match) {
      if (fence === null) {
        fence = match[1]!;
        continue;
      }
      if (line.trim().startsWith(fence)) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) inside.add(i);
  }
  return inside;
}

/** H1 → H2 降级（围栏外） */
function demoteHeadings(lines: string[]): string[] {
  const fenced = fencedLineIndices(lines);
  return lines.map((line, index) => {
    if (fenced.has(index)) return line;
    return line.replace(/^(\s*)#(?=\s)/, '$1##');
  });
}

/** 提取正文中的小图标（按出现顺序去重） */
export function extractMarkers(body: string): string[] {
  const found: string[] = [];
  for (const marker of NOTE_MARKERS) {
    if (body.includes(marker)) found.push(marker);
  }
  // 保留正文中出现的其他常见标记符号（按出现顺序，仅取已知集合）
  return found;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function footer(input: FormatInput, withSeparator: boolean): string {
  const lines = [
    ...(withSeparator ? ['---', ''] : []),
    `> 导出时间：${formatTimestamp(input.exportedAt)}`,
    `> 来源会话：${input.source.sessionId} · 消息：${input.source.messageId} · 内容修订：${input.source.contentRevision}`,
    `> 排版版本：${FORMAT_VERSION}`,
  ];
  if (input.target) {
    lines.push(`> 存放位置：${input.target.display}`);
  }
  return lines.join('\n');
}

/**
 * 产出最终写入思源的 Markdown。
 * @param body 结构化正文（LLM 输出或降级原文）
 */
export function formatNote(input: FormatInput): FormatResult {
  const raw = input.body ?? '';
  const markers = extractMarkers(raw);
  const lines = raw.split('\n');
  const demoted = demoteHeadings(lines);
  const bodyText = demoted.join('\n').trim();
  const footerText = footer(input, bodyText.length > 0);
  const markdown = bodyText.length > 0 ? `${bodyText}\n\n${footerText}\n` : `${footerText}\n`;
  return { markdown, markers, formatVersion: FORMAT_VERSION };
}
