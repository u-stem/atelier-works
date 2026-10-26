import { useId, useState } from "react";
import type {
  DeploymentEntry,
  DeploymentPullRequest,
} from "../../api/guards/deployments.ts";
import { Pagination } from "../../components/Pagination.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge, type BadgeProps } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  deploymentResultLabel,
  hasPullRequestOrigin,
  hostActionLabel,
  pullRequestOriginLabel,
} from "../../lib/labels.ts";
import { pageSlice } from "../../lib/pagination.ts";
import {
  failureReasonText,
  HISTORY_PREVIEW_COUNT,
  isPullRequestListTruncated,
  pullRequestHref,
  pullRequestTitleText,
  pullRequestTruncationNote,
  versionText,
} from "../../lib/updateHistory.ts";
import { usePagination } from "../../lib/usePagination.ts";

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
 * 作り手が確かめられないPRには、バッジを付けない。「不明」の印は、読み手に判断を求めない情報で、行を埋めるだけだからである。
 * 題名はコミットメッセージ由来の信頼できない文字列なので、文字としてだけ出す。
 * 番号は、GitHubのPRのURLの形で番号が一致するときだけリンクにし、それ以外は文字にする。
 */
function PullRequestRow({ pull }: { pull: DeploymentPullRequest }) {
  const href = pullRequestHref(pull);
  return (
    <li className="flex items-baseline gap-3 py-1.5">
      {hasPullRequestOrigin(pull.origin) ? (
        <Badge variant={originVariant(pull.origin)}>
          {pullRequestOriginLabel(pull.origin)}
        </Badge>
      ) : null}
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

/** 1ページに出す反映の数。 */
const PAGE_SIZE = 10;

/**
 * 反映の履歴。新しい順に並べ、反映ごとに日時、版、結果、ホストの作業の要否、含まれるPRを出す。
 * 最初は新しい3件だけを出し、「すべて表示」で全件を開く。全件は10件ずつのページに分け、画面の中で送る。
 * 切り替えのボタンは1つで、開閉で位置も要素も変えない。作り直すと、押した後にフォーカスが失われるためである。
 * 失敗した反映には、理由の先頭部分を文字としてだけ出す。
 * PRごとに、Software Factoryが作ったか、人が作ったかを示す。作り手が不明なPRには示さない。
 * ホストの作業が残っているかは、記録の印では分からない(作業が済んでも印は残る)ので、ここでは数えない。
 */
export function UpdateHistory({
  entries,
  now,
  initialPage,
  initiallyExpanded = false,
}: {
  entries: readonly DeploymentEntry[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。 */
  initialPage?: number | undefined;
  /** 最初から全件を開く。省略すると、新しい3件だけを出す。 */
  initiallyExpanded?: boolean | undefined;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const pager = usePagination(entries.length, PAGE_SIZE, initialPage);
  const baseId = useId();
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
        反映の記録はまだありません
      </p>
    );
  }
  const canExpand = entries.length > HISTORY_PREVIEW_COUNT;
  const listId = `${baseId}-list`;
  const shown = expanded
    ? pageSlice(entries, pager.page, PAGE_SIZE)
    : entries.slice(0, HISTORY_PREVIEW_COUNT);
  return (
    <div ref={pager.anchorRef} className="flex flex-col gap-3">
      {canExpand ? (
        <div>
          <Button
            id={`${baseId}-toggle`}
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => {
              setExpanded(!expanded);
            }}
          >
            {expanded
              ? `新しい${String(HISTORY_PREVIEW_COUNT)}件だけ表示`
              : `すべて表示(${String(entries.length)}件)`}
          </Button>
        </div>
      ) : null}
      <ul id={listId} className="flex flex-col gap-3">
        {shown.map((entry) => (
          <DeploymentItem key={entry.deployment_id} entry={entry} now={now} />
        ))}
      </ul>
      {expanded ? (
        <Pagination
          page={pager.page}
          total={entries.length}
          size={PAGE_SIZE}
          onPageChange={pager.change}
          label="更新履歴のページ送り"
        />
      ) : null}
    </div>
  );
}
