// Shared data-fetching hook for every tab: calls f/factory/steps/
// console_query.ts through lib/api.ts's `queryConsole`, converts the result
// via the caller's `toRow` mapper (lib/types.ts), and exposes a `reload()`
// escape hatch (used after an Approve/Reject/retry action to refresh the
// list it came from).

import { useCallback, useEffect, useState } from "react";
import { describeError, queryConsole } from "./api";
import { toRows } from "./coerce";
import type { ConsoleView } from "./types";

export type ConsoleQueryState<T> = {
  readonly rows: T[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
};

export type ConsoleQueryArgs = {
  readonly limit?: number;
  readonly days?: number;
};

export function useConsoleQuery<T>(
  view: ConsoleView,
  toRow: (row: Record<string, unknown>) => T,
  args: ConsoleQueryArgs = {},
): ConsoleQueryState<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const { limit, days } = args;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is never read inside the effect — bumping it (via reload()) is what forces a refetch, the standard "dummy dependency" hook idiom.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    queryConsole(view, limit, days)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setRows(toRows(result).map(toRow));
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setError(describeError(caught));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [view, limit, days, reloadToken, toRow]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { rows, loading, error, reload };
}
