// A minimal shimmering placeholder shown while a tab's initial data fetch
// (see lib/useConsoleQuery.ts) is in flight, standing in for the previous
// plain "読み込み中..." text.

import React from "react";

type SkeletonProps = {
  readonly rows?: number;
};

// Fixed pool of keys (rather than the array index) so the placeholder rows
// have stable identities, as biome's noArrayIndexKey rule requires.
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
