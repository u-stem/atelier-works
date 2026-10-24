import { useState } from "react";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import {
  deployFreezeItems,
  type HoldItem,
  otherActiveDeployCount,
  type ReleaseTarget,
} from "../../lib/holdsView.ts";
import { HOLDS_TEXT } from "../../lib/labels.ts";
import { HoldReleaseDialog } from "./HoldReleaseDialog.tsx";
import { HoldsPanel } from "./HoldsPanel.tsx";
import { SystemSection } from "./SystemSection.tsx";
import { useReleaseFreeze, useReleaseHold } from "./useRelease.ts";

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
 * システムの画面の「保留と凍結」の節。有効な保留と凍結を出し、人が確認のうえで解除できる。
 * この節だけが書き込みを持つ。解除は確認のダイアログを通し、実行中は同じ行を押せなくする。
 * 認可はWindmillのログインとフォルダの権限に任せ、この画面は操作者の名前を送らない。
 */
export function HoldsSection({
  holds,
}: {
  holds: SectionQuery<HoldsSnapshot>;
}) {
  const releaseHold = useReleaseHold();
  const releaseFreeze = useReleaseFreeze();
  const [chosen, setChosen] = useState<HoldItem | null>(null);

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
          <HoldsPanel
            data={data}
            now={now}
            isLocked={isLocked}
            onRequestRelease={setChosen}
            onRetry={() => {
              void holds.refetch();
            }}
            isFetching={holds.isFetching}
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
