import { Check, Minus } from "lucide-react";
import { Badge } from "../../components/ui/badge.tsx";

/**
 * 真偽。語(有効、無効)と記号(チェック、ハイフン)で示し、色だけに頼らない。
 * 有効は強調した枠、無効は薄い枠にする。成功や警告の色は使わない。
 * 慎重に入れる項目も同じ見た目になるので、有効を健全な状態と読ませないためである。
 * 書かれた値(true、false)は、読み上げにだけ残す。
 */
export function SwitchBadge({
  enabled,
  rawText,
}: {
  enabled: boolean;
  rawText: string;
}) {
  const Mark = enabled ? Check : Minus;
  return (
    <Badge
      variant="outline"
      className={enabled ? "border-foreground/60 text-foreground" : undefined}
    >
      <Mark aria-hidden="true" />
      {enabled ? "有効" : "無効"}
      <span className="sr-only">({rawText})</span>
    </Badge>
  );
}
