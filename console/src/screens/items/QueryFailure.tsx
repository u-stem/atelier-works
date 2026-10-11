import { LogIn } from "lucide-react";
import {
  ApiFailure,
  describeApiError,
  isBannerError,
} from "../../api/errors.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";

/**
 * 取得に失敗して表示できるデータが無いときの表示。
 * 401は画面上部のバナーが知らせるので、同じ内容の警告を重ねず、ログインを促す文にする。
 */
export function QueryFailure({
  title,
  loginHint,
  error,
  onRetry,
  compact = false,
}: {
  /** 取得できなかったものを指す題。 */
  title: string;
  /** ログインが要るときに、ログイン後に何が出るかを伝える文。 */
  loginHint: string;
  error: unknown;
  onRetry: () => void;
  /** 画面の一部の節に出すときは真にする。画面全体を占めず、ログインの案内も文だけにする。 */
  compact?: boolean;
}) {
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  if (apiError !== null && isBannerError(apiError)) {
    if (compact) {
      return <p className="text-small text-muted-foreground">{loginHint}</p>;
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
          <LogIn aria-hidden="true" className="size-6" />
        </span>
        <p className="text-lead font-semibold">ログインが必要です</p>
        <p className="max-w-sm text-small text-muted-foreground">{loginHint}</p>
      </div>
    );
  }
  const alert = (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          {apiError === null ? "原因は不明です。" : describeApiError(apiError)}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          もう一度取得する
        </Button>
      </AlertDescription>
    </Alert>
  );
  return compact ? alert : <div className="p-8">{alert}</div>;
}
