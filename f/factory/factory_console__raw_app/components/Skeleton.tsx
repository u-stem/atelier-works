// タブの最初のデータ取得(`lib/useConsoleQuery.ts`を参照)の間に表示する、
// 光が流れる最小限のプレースホルダー。

import React from "react";

type SkeletonProps = {
  readonly rows?: number;
};

/**
 * プレースホルダーの行のkey。配列の添字ではなく固定のkeyを使い、
 * 行の同一性を安定させる(biomeの`noArrayIndexKey`ルールの要求)。
 */
const ROW_KEYS = [
  "skeleton-row-1",
  "skeleton-row-2",
  "skeleton-row-3",
  "skeleton-row-4",
  "skeleton-row-5",
  "skeleton-row-6",
] as const;

export function Skeleton({ rows = 4 }: SkeletonProps): React.ReactElement {
  const keys = ROW_KEYS.slice(0, rows);
  return (
    <div className="skeleton" role="status" aria-label="読み込み中">
      {keys.map((key) => (
        <div key={key} className="skeleton-line" />
      ))}
    </div>
  );
}
