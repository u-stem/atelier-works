import type {
  DeploymentEntry,
  DeploymentPullRequest,
} from "../../api/guards/deployments.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge, type BadgeProps } from "../../components/ui/badge.tsx";
import {
  deploymentResultLabel,
  hostActionLabel,
  pullRequestOriginLabel,
} from "../../lib/labels.ts";
import {
  failureReasonText,
  isPullRequestListTruncated,
  pullRequestHref,
  pullRequestTitleText,
  pullRequestTruncationNote,
  versionText,
} from "../../lib/updateHistory.ts";

function resultVariant(result: string): BadgeProps["variant"] {
  switch (result) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    default:
      return "outline";
  }
}

function originVariant(origin: string): BadgeProps["variant"] {
  switch (origin) {
    case "factory":
      return "approval";
    case "human":
      return "secondary";
    default:
      return "outline";
  }
}

/**
 * PRの1行。作り手のバッジ、題名、番号を並べる。
 * 題名はコミットメッセージ由来の信頼できない文字列なので、文字としてだけ出す。
 * 番号は、GitHubのPRのURLの形で番号が一致するときだけリンクにし、それ以外は文字にする。
 */
function PullRequestRow({ pull }: { pull: DeploymentPullRequest }) {
  const href = pullRequestHref(pull);
  return (
    <li className="flex items-baseline gap-3 py-1.5">
      <Badge variant={originVariant(pull.origin)}>
        {pullRequestOriginLabel(pull.origin)}
      </Badge>
      <span className="min-w-0 flex-1 break-words text-body">
        {pullRequestTitleText(pull)}
      </span>
      {href === null ? (
        <span className="shrink-0 text-small text-subtle tabular-nums">
          #{pull.number}
        </span>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-sm text-small tabular-nums underline underline-offset-2"
        >
          #{pull.number}
        </a>
      )}
    </li>
  );
}

function DeploymentItem({
  entry,
  now,
}: {
  entry: DeploymentEntry;
  now: number;
}) {
  const reason = failureReasonText(entry);
  return (
    <li className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-small text-muted-foreground">
          <TimeText iso={entry.occurred_at} now={now} />
        </span>
        <span className="font-mono text-small tabular-nums">
          {versionText(entry.sha_from, entry.sha_to)}
        </span>
        <Badge variant={resultVariant(entry.result)}>
          {deploymentResultLabel(entry.result)}
        </Badge>
        <Badge variant={entry.needs_host_action ? "warning" : "outline"}>
          {hostActionLabel(entry.needs_host_action)}
        </Badge>
      </div>
      {reason === null ? null : (
        <p className="mt-3 break-words text-small">
          <span className="text-muted-foreground">理由: </span>
          {reason}
        </p>
      )}
      {entry.pull_requests.length === 0 ? (
        <p className="mt-3 text-small text-muted-foreground">
          含まれるPRの記録はありません
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-t border-border">
          {entry.pull_requests.map((pull) => (
            <PullRequestRow key={pull.number} pull={pull} />
          ))}
        </ul>
      )}
      {isPullRequestListTruncated(entry.pull_requests.length) ? (
        <p className="mt-2 text-small text-muted-foreground">
          {pullRequestTruncationNote()}
        </p>
      ) : null}
    </li>
  );
}

/**
 * 反映の履歴。新しい順に並べ、反映ごとに日時、版、結果、ホストの作業の要否、含まれるPRを出す。
 * 失敗した反映には、理由の先頭部分を文字としてだけ出す。
 * PRごとに、Software Factoryが作ったか、人が作ったか、不明かを示す。
 */
export function UpdateHistory({
  entries,
  now,
}: {
  entries: readonly DeploymentEntry[];
  now: number;
  initialPage?: number | undefined;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
        反映の記録はまだありません
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => (
        <DeploymentItem key={entry.deployment_id} entry={entry} now={now} />
      ))}
    </ul>
  );
}
