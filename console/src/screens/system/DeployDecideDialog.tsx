import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { DEPLOY_APPROVALS_TEXT, hiddenPathsText } from "../../lib/labels.ts";
import type { DeployDecisionRequest } from "./DeployApprovalsPanel.tsx";

function titleOf(request: DeployDecisionRequest | null): string {
  if (request === null) {
    return "";
  }
  return request.decision === "approve"
    ? DEPLOY_APPROVALS_TEXT.approveTitle
    : DEPLOY_APPROVALS_TEXT.rejectTitle;
}

/**
 * 反映の承認か却下の前の確認。どちらも取り消せないので、版、保護パス、判断の効果を並べ、フォーカスは取り消しに置く。
 * 承認は保護パスの変更を本番へ通す向きなので、確認のボタンを破壊的な操作の色にする。
 */
export function DeployDecideDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: DeployDecisionRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={request !== null}
      title={titleOf(request)}
      confirmLabel={
        request?.decision === "reject"
          ? DEPLOY_APPROVALS_TEXT.confirmReject
          : DEPLOY_APPROVALS_TEXT.confirmApprove
      }
      destructive={request?.decision === "approve"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {request === null ? null : (
        <>
          <dl className="flex flex-col gap-1">
            <div className="grid grid-cols-[6rem_1fr] gap-x-3">
              <dt className="text-small text-subtle">
                {DEPLOY_APPROVALS_TEXT.shaField}
              </dt>
              <dd
                dir="ltr"
                className="min-w-0 font-mono text-body break-all [unicode-bidi:isolate]"
              >
                {request.item.sha}
              </dd>
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-x-3">
              <dt className="text-small text-subtle">
                {DEPLOY_APPROVALS_TEXT.pathsField}
              </dt>
              <dd className="min-w-0 text-body">
                <ul className="flex flex-col gap-0.5">
                  {request.item.paths.map((path) => (
                    <li
                      key={path}
                      dir="ltr"
                      className="break-all [unicode-bidi:isolate]"
                    >
                      {path}
                    </li>
                  ))}
                </ul>
                {request.item.hiddenPathCount > 0
                  ? hiddenPathsText(request.item.hiddenPathCount)
                  : null}
              </dd>
            </div>
          </dl>
          <p className="text-body">
            {request.decision === "approve"
              ? DEPLOY_APPROVALS_TEXT.approveEffect
              : DEPLOY_APPROVALS_TEXT.rejectEffect}
          </p>
        </>
      )}
    </ConfirmDialog>
  );
}
