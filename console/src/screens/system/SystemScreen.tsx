import {
  ApiFailure,
  describeApiError,
  isBannerError,
} from "../../api/errors.ts";
import { useDeployments } from "../../api/queries.ts";
import { PageHeader } from "../../app/PageHeader.tsx";
import { refreshStatusOf } from "../../app/refreshStatus.ts";
import { useNow } from "../../app/useNow.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { UpdateHistory } from "./UpdateHistory.tsx";

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" role="status">
      <span className="sr-only">読み込み中</span>
      {["a", "b", "c"].map((key) => (
        <Skeleton key={key} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * 取得に失敗して表示できる履歴が無いときの表示。
 * 401は画面上部のバナーが知らせるので、同じ内容の警告を重ねない。
 */
function FailureState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const apiError = error instanceof ApiFailure ? error.apiError : null;
  if (apiError !== null && isBannerError(apiError)) {
    return (
      <p className="text-small text-muted-foreground">
        上のバナーからログインすると、更新履歴を表示します。
      </p>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>更新履歴を取得できませんでした</AlertTitle>
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
}

/**
 * システムの画面。Software Factoryが自分を更新した履歴を、反映ごとに出す。
 * 読み取り専用で、操作は起こさない。反映の状態と通知の履歴は、まだ出さない。
 */
export function SystemScreen() {
  const deployments = useDeployments();
  const now = useNow();
  const refresh = refreshStatusOf(deployments);

  return (
    <>
      <PageHeader title="システム" refresh={refresh} />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <section aria-labelledby="update-history-heading" className="max-w-3xl">
          <h2
            id="update-history-heading"
            className="mb-1 text-lead font-semibold"
          >
            更新履歴
          </h2>
          <p className="mb-4 text-small text-muted-foreground">
            Software Factoryが自分を更新した記録です。
            PRの作り手は、マージしたブランチの名前から判断しています。
          </p>
          {deployments.data === undefined ? (
            deployments.isError ? (
              <FailureState
                error={deployments.error}
                onRetry={refresh.onRefresh}
              />
            ) : (
              <LoadingState />
            )
          ) : (
            <UpdateHistory entries={deployments.data} now={now} />
          )}
        </section>
        <p className="mt-8 max-w-3xl text-small text-subtle">
          反映の状態と通知の履歴は、ここに表示する予定です。
        </p>
      </div>
    </>
  );
}
