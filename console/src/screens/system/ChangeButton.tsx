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
 */
export function ChangeButton({
  offer,
  locked,
  onChoose,
}: {
  offer: SwitchOrNumberOffer;
  locked: boolean;
  onChoose: (offer: ChangeOffer) => void;
}) {
  const verb = offer.kind === "stop" ? "止める" : "下げる";
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={locked}
      aria-label={`${safeText(offer.key)}を${verb}`}
      onClick={() => {
        onChoose(offer);
      }}
    >
      {verb}
    </Button>
  );
}
