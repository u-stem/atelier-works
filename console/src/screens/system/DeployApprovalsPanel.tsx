import { TriangleAlert } from "lucide-react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import type {
  DeployApprovalItem,
  DeployApprovalsView,
} from "../../lib/deployApprovalsView.ts";
import { DEPLOY_APPROVALS_TEXT, hiddenPathsText } from "../../lib/labels.ts";
import {
  formatAbsoluteIso,
  formatRelativeIso,
} from "../../lib/relativeTime.ts";

/** 押したボタンの判断と、その行。確認のダイアログに渡す。 */
export type DeployDecisionRequest = {
  readonly item: DeployApprovalItem;
  readonly decision: "approve" | "reject";
};

const BIDI = "[unicode-bidi:isolate]";

function Row({
  item,
  now,
  locked,
  onRequest,
}: {
  item: DeployApprovalItem;
  now: number;
  locked: boolean;
  onRequest: (request: DeployDecisionRequest) => void;
}) {
  const absolute = formatAbsoluteIso(item.requestedAt);
  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Badge variant="muted">{DEPLOY_APPROVALS_TEXT.badge}</Badge>
          <span
            dir="ltr"
            className={`min-w-0 font-mono text-body break-all ${BIDI}`}
          >
            {item.sha}
          </span>
        </p>
        <p className="text-small text-subtle">
          {`${DEPLOY_APPROVALS_TEXT.requestedField}: `}
          <time dateTime={item.requestedAt} title={absolute}>
            {formatRelativeIso(item.requestedAt, now)}
          </time>
          <span className="sr-only">({absolute})</span>
        </p>
        <p className="text-small text-subtle">
          {DEPLOY_APPROVALS_TEXT.pathsField}
        </p>
        <ul className="flex list-disc flex-col gap-0.5 pl-5">
          {item.paths.map((path) => (
            <li key={path} dir="ltr" className={`text-small break-all ${BIDI}`}>
              {path}
            </li>
          ))}
        </ul>
        {item.hiddenPathCount > 0 ? (
          <p className="text-small text-muted-foreground">
            {hiddenPathsText(item.hiddenPathCount)}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          data-deploy-approve={item.sha}
          disabled={locked}
          onClick={() => {
            onRequest({ item, decision: "approve" });
          }}
        >
          {locked
            ? DEPLOY_APPROVALS_TEXT.deciding
            : DEPLOY_APPROVALS_TEXT.approve}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-deploy-reject={item.sha}
          disabled={locked}
          onClick={() => {
            onRequest({ item, decision: "reject" });
          }}
        >
          {DEPLOY_APPROVALS_TEXT.reject}
        </Button>
      </div>
    </li>
  );
}

/**
 * 保護パスの変更の反映の承認待ち。承認待ちが無いときは何も描かない(保留と凍結の空の旨は、隣の一覧が出す)。
 * 読めないときは、承認待ちなしとは書かず、反映が止まったままである旨と理由を出す。
 * 版とパスはリポジトリ由来の文字列なので、文字としてだけ描く(リンクにしない)。
 */
export function DeployApprovalsPanel({
  view,
  now,
  isLocked,
  onRequest,
}: {
  view: DeployApprovalsView;
  now: number;
  isLocked: (sha: string) => boolean;
  onRequest: (request: DeployDecisionRequest) => void;
}) {
  if (view.kind === "none") {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-body font-semibold">
          {DEPLOY_APPROVALS_TEXT.cardTitle}
        </h3>
        <p className="text-small text-muted-foreground">
          {DEPLOY_APPROVALS_TEXT.cardNote}
        </p>
      </div>
      {view.kind === "failed" ? (
        <Card
          role="alert"
          padding="compact"
          className="flex flex-col gap-2 border-warning/40 bg-warning/10"
        >
          <p className="flex items-center gap-2 text-body font-semibold text-warning">
            <TriangleAlert aria-hidden="true" className="size-4" />
            {DEPLOY_APPROVALS_TEXT.readFailedTitle}
          </p>
          <p className="text-small">{DEPLOY_APPROVALS_TEXT.readFailedDetail}</p>
          <p
            dir="ltr"
            className={`text-small break-words whitespace-pre-wrap ${BIDI}`}
          >
            {view.reason}
          </p>
        </Card>
      ) : (
        <Card tag="ul" variant="list">
          {view.items.map((item) => (
            <Row
              key={item.sha}
              item={item}
              now={now}
              locked={isLocked(item.sha)}
              onRequest={onRequest}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
