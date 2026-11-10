import { Link } from "react-router";
import type { ConfigItemView, DesignStageView } from "../../api/jobsQueries.ts";
import { Card } from "../../components/ui/card.tsx";
import type { ChangeOffer } from "../../lib/configChange.ts";
import {
  type SwitchRow,
  type SwitchState,
  switchRowsOf,
} from "../../lib/configSwitches.ts";
import { CONFIG_REFERENCE_LABEL } from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { systemSectionPath } from "../../lib/systemSections.ts";
import { ChangeButton } from "./ChangeButton.tsx";
import { KeyText } from "./ConfigText.tsx";
import { SwitchBadge } from "./SwitchBadge.tsx";

const HEADING_ID = "config-switches-heading";

/** 値を読めない状態の語。有効と無効の状態は、バッジで示す。 */
const UNREADABLE_WORDS: Readonly<
  Record<Exclude<SwitchState, "on" | "off">, string>
> = {
  hidden: CONFIG_REFERENCE_LABEL,
  unset: "未設定",
  not_boolean: "真偽ではない値",
};

function StateCell({ row }: { row: SwitchRow }) {
  if (row.state === "on" || row.state === "off") {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <SwitchBadge
          enabled={row.state === "on"}
          rawText={row.state === "on" ? "true" : "false"}
        />
        {row.stageNote === null ? null : (
          <span className="font-medium">{row.stageNote}</span>
        )}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">{UNREADABLE_WORDS[row.state]}</span>
  );
}

/**
 * 設定タブの先頭の「機能のスイッチ」の表。Consoleから止められる真偽の項目を、設定に無い項目も含めて1行ずつ並べる。
 * 状態は、グループの表と同じバッジで示す。`design_enabled`が無視中か判定できないときは、バッジの横に語を添える。
 * 理由の文は、グループの表の`design_enabled`の行と「設計」グループの先頭の行が持つので、ここでは繰り返さない。
 * 止めるボタンは、グループの表と同じ`onChoose`に候補を渡すので、同じ確認のダイアログを開く。
 * 全部を止める操作は、状態タブの全停止の区画にあるので、そこへのリンクだけを置く。
 * 表の列幅は、グループの表の広い幅の列と同じにして、操作の列を縦にそろえる。
 */
export function ConfigSwitchTable({
  items,
  designStage,
  onChoose,
  isLocked,
}: {
  items: readonly ConfigItemView[];
  designStage: DesignStageView | undefined;
  onChoose: (offer: ChangeOffer) => void;
  isLocked: (offer: ChangeOffer) => boolean;
}) {
  const rows = switchRowsOf(items, designStage);
  return (
    <div className="@container flex max-w-6xl flex-col gap-2">
      <h3 id={HEADING_ID} className="text-small font-semibold">
        機能のスイッチ
      </h3>
      <p className="text-small text-muted-foreground">
        全部を止めるときは、システムの「状態」タブの
        <Link
          to={systemSectionPath("stop-all")}
          className="rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          全停止
        </Link>
        を使います。
      </p>
      <Card className="overflow-hidden text-small">
        <table
          aria-labelledby={HEADING_ID}
          className="w-full border-collapse @min-[40rem]:table-fixed"
        >
          <colgroup>
            <col className="@min-[40rem]:w-56 @min-[48rem]:w-64 @min-[56rem]:w-76" />
            <col />
            <col className="@min-[40rem]:w-20" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">
                項目
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                状態
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className="px-4 py-2.5 text-left align-middle font-mono font-normal break-words"
                >
                  <KeyText text={safeText(row.key)} />
                </th>
                <td className="px-4 py-2.5 align-middle">
                  <StateCell row={row} />
                </td>
                <td className="px-2 py-1.5 align-middle">
                  {row.offer === null || row.offer.kind !== "stop" ? null : (
                    <ChangeButton
                      offer={row.offer}
                      locked={isLocked(row.offer)}
                      onChoose={onChoose}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
