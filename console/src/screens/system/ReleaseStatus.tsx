import type { ReactNode } from "react";
import type { SystemStatus } from "../../api/guards/systemStatus.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  describeFetcher,
  describeHostAction,
  describeLatestDeployment,
  type HostActionSource,
} from "../../lib/systemView.ts";
import { shortSha } from "../../lib/updateHistory.ts";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-baseline gap-x-4 px-5 py-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-body break-words text-foreground">
        {children}
      </dd>
    </div>
  );
}

const MONO = "font-mono text-small tabular-nums";

/**
 * 反映の状態。反映した版、直近の反映、Consoleの取り込みの状態を出す。
 * 取り込んだ版と最後に確かめた時刻は、サイドバーの下部が示すので、取り込みの行では繰り返さない。
 * ホストの作業は、未解決の通知の件数で出す。反映の記録の印は、作業が済んでも残るためである。
 * 版が読めないときや、取り込みの状態を読めないときも、ほかの行は出す。
 */
export function ReleaseStatus({
  status,
  now,
  hostAction,
}: {
  status: SystemStatus;
  now: number;
  /** summaryの未解決の通知から数えた、ホストの作業。取得中は`"pending"`、取得に失敗したときは`null`。 */
  hostAction: HostActionSource;
}) {
  const deployment =
    status.deployment === null
      ? null
      : describeLatestDeployment(status.deployment);
  const fetcher = describeFetcher(status.fetcher);
  const hostActionView = describeHostAction(
    hostAction,
    status.deployment?.needs_host_action === true,
  );
  return (
    <dl className="divide-y divide-border rounded-xl border border-border bg-card">
      <Row label="反映した版">
        {status.deployed_sha === null ? (
          <span className="text-muted-foreground">不明</span>
        ) : (
          <span className={MONO}>{shortSha(status.deployed_sha)}</span>
        )}
      </Row>
      <Row label="直近の反映">
        {deployment === null ? (
          <span className="text-muted-foreground">
            反映の記録はまだありません
          </span>
        ) : (
          <>
            <span className="text-small text-muted-foreground">
              <TimeText iso={deployment.occurredAt} now={now} />
            </span>
            <span className={MONO}>{deployment.versionLabel}</span>
            <Badge variant={deployment.resultTone}>
              {deployment.resultLabel}
            </Badge>
            <Badge
              variant={
                hostActionView.tone === "warning" ? "warning" : "outline"
              }
            >
              {hostActionView.label}
            </Badge>
          </>
        )}
      </Row>
      <Row label="Consoleの取り込み">
        <Badge variant={fetcher.tone}>{fetcher.label}</Badge>
      </Row>
      {fetcher.detail === null &&
      fetcher.errorCode === null &&
      fetcher.nextAction === null ? null : (
        <Row label="取り込みの補足">
          <div className="flex min-w-0 flex-col gap-1">
            {fetcher.detail === null ? null : <p>{fetcher.detail}</p>}
            {fetcher.errorCode === null ? null : (
              <p>
                失敗の分類:{" "}
                <span className="font-mono text-small">
                  {fetcher.errorCode}
                </span>
              </p>
            )}
            {fetcher.nextAction === null ? null : (
              <p>次の操作: {fetcher.nextAction}</p>
            )}
          </div>
        </Row>
      )}
    </dl>
  );
}
