import { apiErrorOf, describeQueryFailure } from "../lib/queryFailureView.ts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";

/**
 * 取得の失敗を出す共通の警告。
 * 主文は何が起きたかと次の操作で、サーバーの文は折りたたむ「詳細」に置く。
 * 401を画面上部のバナーに任せる分岐は、呼び出し側が先に済ませる。
 */
export function QueryFailureAlert({
  title,
  error,
  onRetry,
  className,
}: {
  /** 取得できなかったものを指す題。 */
  title: string;
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const view = describeQueryFailure(apiErrorOf(error));
  return (
    <Alert variant="destructive" className={className}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{view.summary}</p>
        <p>{view.nextStep}</p>
        {view.detail === "" ? null : (
          <details className="max-w-full text-small text-muted-foreground">
            <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              詳細
            </summary>
            <p className="mt-1 break-words whitespace-pre-wrap">
              {view.detail}
            </p>
          </details>
        )}
        <Button size="sm" variant="outline" onClick={onRetry}>
          もう一度取得する
        </Button>
      </AlertDescription>
    </Alert>
  );
}
