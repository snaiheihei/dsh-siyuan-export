import type { ErrorCategory } from './contract';

/**
 * 插件统一错误形态：业务错误与传输错误分开，`category` 对齐 contracts/rpc.md 枚举，
 * `message` 为用户可读中文（不含堆栈、内部路径、正文秘密）。
 * 子类（SiyuanError / LlmError）经 `new.target.name` 自动携带类名。
 */
export class PluginError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;

  constructor(category: ErrorCategory, message: string, retryable: boolean) {
    super(message);
    this.name = new.target.name;
    this.category = category;
    this.retryable = retryable;
  }
}
