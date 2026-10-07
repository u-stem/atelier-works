// すべてのタブが共有する、データ取得のフック。
// `lib/api.ts`の`queryConsole`で`f/factory/steps/console_query.ts`を呼び、
// 呼び出し側の`toRow`(`lib/types.ts`)で結果を変換する。
// 承認・却下・再開の操作の後に一覧を取り直せるよう、`reload()`も返す。

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
  /** "requirements_doc"と"audit_doc"のビューでだけ使う。 */
  readonly work_item_id?: number;
  /** "requirements_doc"のビューでだけ使う。 */
  readonly attempt?: number;
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
  const { limit, days, work_item_id, attempt } = args;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTokenはeffectの中で読まない。reload()で値を増やして再取得させる、依存配列にダミーの値を置く定番の書き方。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    queryConsole(view, limit, days, work_item_id, attempt)
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
  }, [view, limit, days, work_item_id, attempt, reloadToken, toRow]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { rows, loading, error, reload };
}
