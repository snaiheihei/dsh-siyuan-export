/**
 * T052 · 侧栏入口图标（biji.svg 内联为 dataurl）
 *
 * - 构建期经 esbuild `loader: {'.svg':'dataurl'}` 内联，运行时不发资源请求
 * - 图片加载失败时渲染 aria-hidden 占位；入口可访问名称由 slot 元数据 label 提供
 */
import { useState, type JSX } from 'react';
import biji from '../../../biji.svg';

export interface BijiIconProps {
  size?: number;
  active?: boolean;
}

export function BijiIcon({ size = 16 }: BijiIconProps): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        aria-hidden="true"
        data-siyuan-export-icon="fallback"
        style={{ display: 'inline-block', width: size, height: size }}
      />
    );
  }

  return (
    <img
      src={biji}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
