import { Button } from "../../components/ui/button.tsx";
import type { ChangeOffer } from "../../lib/configChange.ts";
import { safeText } from "../../lib/safeText.ts";

/** 操作の列とスイッチの表のボタンが持つ候補。止める向きか、下げる向き。 */
export type SwitchOrNumberOffer = Extract<
  ChangeOffer,
  { kind: "stop" | "lower" }
>;

/**
 * 止めるか下げるのボタン。押すと確認のダイアログを開く候補を渡すだけで、書き込みは呼ばない。
 * 名前に項目を含め、同じ語のボタンを見分けられるようにする。
 * 同じ項目のボタンが別の表にもあるときは、`labelPrefix`に表の名前を渡し、名前を区別する。名前は見える語(止める、下げる)を含む。
 */
export function ChangeButton({
  offer,
  locked,
  onChoose,
  labelPrefix = "",
}: {
  offer: SwitchOrNumberOffer;
  locked: boolean;
  onChoose: (offer: ChangeOffer) => void;
  labelPrefix?: string;
}) {
  const verb = offer.kind === "stop" ? "止める" : "下げる";
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={locked}
      aria-label={`${labelPrefix}${safeText(offer.key)}を${verb}`}
      onClick={() => {
        onChoose(offer);
      }}
    >
      {verb}
    </Button>
  );
}
