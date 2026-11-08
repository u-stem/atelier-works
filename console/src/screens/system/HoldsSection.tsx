import { useState } from "react";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { deployApprovalsView } from "../../lib/deployApprovalsView.ts";
import {
  deployFreezeItems,
  type HoldItem,
  otherActiveDeployCount,
  type ReleaseTarget,
} from "../../lib/holdsView.ts";
import { HOLDS_TEXT } from "../../lib/labels.ts";
import {
  DeployApprovalsPanel,
  type DeployDecisionRequest,
} from "./DeployApprovalsPanel.tsx";
import { DeployDecideDialog } from "./DeployDecideDialog.tsx";
import { HoldPlaceButton, HoldPlaceDialog } from "./HoldPlaceDialog.tsx";
import { HoldReleaseDialog } from "./HoldReleaseDialog.tsx";
import { HoldsPanel } from "./HoldsPanel.tsx";
import { StopAllDialog, StopAllReleaseDialog } from "./StopAllDialog.tsx";
import { StopAllPanel } from "./StopAllPanel.tsx";
import { SystemSection } from "./SystemSection.tsx";
import { initialPlaceForm, usePlaceHold } from "./usePlacement.ts";
import {
  useDecideDeploy,
  useReleaseFreeze,
  useReleaseHold,
} from "./useRelease.ts";
import type { SectionArrival } from "./useSectionArrival.ts";
import { useReleaseStopAll, useStopAll } from "./useStopAll.ts";

function otherDeployCountOf(
  data: HoldsSnapshot | undefined,
  item: HoldItem | null,
  now: number,
): number {
  if (data === undefined || item === null || !data.freezes.ok) {
    return 0;
  }
  return otherActiveDeployCount(
    deployFreezeItems(data.freezes.deploy),
    item,
    now,
  );
}

/**
 * システムの画面の「保留と凍結」の節。全停止の区画、有効な保留と凍結を出し、人が確認のうえで置き、解除できる。
 * 置く操作と解除は確認のダイアログを通し、解除は実行中に同じ行を押せなくする。
 * scheduleを止める操作はジョブの画面のスケジュールのタブにあり、この節は凍結を置くところまでを持つ。
 * 全停止の区画は、この節の先頭に出す。次に、保護パスの変更の反映の承認待ちを出し、確認のダイアログを通して承認か却下を記録する。
 * 認可はWindmillのログインとフォルダの権限に任せ、この画面は操作者の名前を送らない。
 * 通知から区画へ移るとき、全停止、反映の承認待ち、保留の各区画が着地先になる。区画が描かれないときの着地先は、この節の見出しである。
 */
export function HoldsSection({
  holds,
  arrival,
  landingNote,
}: {
  holds: SectionQuery<HoldsSnapshot>;
  /** 通知などから区画へ移る受け取りと、強調の状態。 */
  arrival: SectionArrival;
  /** 反映の承認待ちが無いまま着地したときの、見出しの下の1文。無ければ`null`。 */
  landingNote: string | null;
}) {
  const releaseHold = useReleaseHold();
  const releaseFreeze = useReleaseFreeze();
  const place = usePlaceHold();
  const decideDeploy = useDecideDeploy();
  const [decision, setDecision] = useState<DeployDecisionRequest | null>(null);
  const [chosen, setChosen] = useState<HoldItem | null>(null);
  const stopAll = useStopAll();
  const releaseStopAll = useReleaseStopAll();
  const [stopDialog, setStopDialog] = useState<"stop" | "release" | null>(null);
  const [stopReason, setStopReason] = useState("");
  // 置く操作と解除は同じキーでロックするので、どちらで確かめても同じ答えになる。
  const stopLocked = stopAll.isLocked(stopReason);

  const confirmDecision = (): void => {
    if (decision === null) {
      return;
    }
    decideDeploy.submit({
      sha: decision.item.sha,
      decision: decision.decision,
    });
    setDecision(null);
  };

  const isLocked = (target: ReleaseTarget): boolean =>
    target.kind === "hold"
      ? releaseHold.isLocked(target.id)
      : releaseFreeze.isLocked(target.id);

  const confirm = (): void => {
    if (chosen === null) {
      return;
    }
    if (chosen.target.kind === "hold") {
      releaseHold.submit(chosen.target.id);
    } else {
      releaseFreeze.submit(chosen.target.id);
    }
    setChosen(null);
  };

  return (
    <SystemSection
      id="holds-heading"
      title={HOLDS_TEXT.sectionTitle}
      description={HOLDS_TEXT.sectionDescription}
      query={holds}
      loginHint="上のバナーからログインすると、保留と凍結を表示します。"
    >
      {(data, now) => (
        <>
          {landingNote === null ? null : (
            <p className="text-small text-muted-foreground">{landingNote}</p>
          )}
          <StopAllPanel
            view={data.stop_all}
            locked={stopLocked}
            arrival={arrival}
            onRequestStop={() => {
              setStopReason("");
              setStopDialog("stop");
            }}
            onRequestRelease={() => {
              setStopDialog("release");
            }}
          />
          <StopAllDialog
            open={stopDialog === "stop"}
            reason={stopReason}
            onReasonChange={setStopReason}
            onConfirm={() => {
              stopAll.submit(stopReason);
              setStopDialog(null);
            }}
            onCancel={() => {
              setStopDialog(null);
            }}
          />
          <StopAllReleaseDialog
            open={stopDialog === "release"}
            onConfirm={() => {
              releaseStopAll.submit(null);
              setStopDialog(null);
            }}
            onCancel={() => {
              setStopDialog(null);
            }}
          />
          <DeployApprovalsPanel
            view={deployApprovalsView(data)}
            now={now}
            isLocked={(sha) =>
              decideDeploy.isLocked({ sha, decision: "approve" })
            }
            onRequest={setDecision}
            arrival={arrival}
          />
          <DeployDecideDialog
            request={decision}
            onConfirm={confirmDecision}
            onCancel={() => {
              setDecision(null);
            }}
          />
          <div>
            <HoldPlaceButton
              onClick={() => {
                place.begin("any");
              }}
            />
          </div>
          <HoldPlaceDialog
            open={place.dialog !== null}
            variant={place.dialog?.variant ?? "any"}
            form={place.dialog?.form ?? initialPlaceForm("any")}
            onChange={place.change}
            onConfirm={place.confirm}
            onCancel={place.dismiss}
          />
          <HoldsPanel
            data={data}
            now={now}
            isLocked={isLocked}
            onRequestRelease={setChosen}
            onRetry={() => {
              void holds.refetch();
            }}
            isFetching={holds.isFetching}
            arrival={arrival}
          />
          <HoldReleaseDialog
            item={chosen}
            now={now}
            otherDeployCount={otherDeployCountOf(data, chosen, now)}
            busy={false}
            onConfirm={confirm}
            onCancel={() => {
              setChosen(null);
            }}
          />
        </>
      )}
    </SystemSection>
  );
}
