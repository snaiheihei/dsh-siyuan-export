/**
 * T022 · 单次输出读取源（宿主 Session → 正文 + contentRevision）
 *
 * 链路（源码实证）：
 *   ctx.sessions.get(sessionId) → Session
 *   session.deriveMessages() → Message[]（派生副本，冻结）
 *   messages.find(m => m.id === messageId) → AssistantMessage
 *   message.content: readonly ContentBlock[] → 拼接 type==='text' 块
 *   session.surface.contentGeneration → 单调内容代数（作 contentRevision）
 *
 * 纪律（FR-008）：只取该条**助手**消息正文，不含用户提问与工具结果。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { OutputSource } from './export-service';
import { PluginError } from '../errors';

/** 从 ContentBlock[] 提取纯文本（忽略 reasoning/tool 等非文本块） */
export function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** 宿主 Session 读取源 */
export function createSessionOutputSource(ctx: Context): OutputSource {
  return {
    async readOutput(input: { messageId: string; sessionId: string }) {
      const session = ctx.sessions.get(input.sessionId as never);
      if (!session) {
        throw new PluginError('internal', '找不到对应会话，请重新打开弹窗', false);
      }
      const messages = session.deriveMessages();
      const message = messages.find((m) => m.id === input.messageId);
      if (!message) {
        throw new PluginError('internal', '找不到这条回复，可能已被清理', false);
      }
      if (message.role !== 'assistant') {
        throw new PluginError('empty-source', '只有助手回复可以导出', false);
      }
      const content = blocksToText(message.content);
      const generation = session.surface.contentGeneration;
      return { content, contentRevision: `g${generation}` };
    },
  };
}
