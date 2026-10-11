import { ApiFailure, isBannerError } from "../api/errors.ts";
import { Button } from "./ui/button.tsx";

/**
 * 取り直しに失敗して、前回取得した値を出し続けているときの知らせ。
 * 値が無い失敗は、失敗の表示が受け持つ。ここは値を出したまま、古いことと再取得の操作を添える。
 * 401は画面上部のバナーが知らせるので、何も出さない。
 */
export function StaleDataNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  if (error instanceof ApiFailure && isBannerError(error.apiError)) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-small text-warning">
        最新の取得に失敗したため、前回取得した値を表示しています。
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        もう一度取得する
      </Button>
    </div>
  );
}
