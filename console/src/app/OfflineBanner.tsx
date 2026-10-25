import { WifiOff } from "lucide-react";
import { useConnectionState } from "./connectionState.ts";

/**
 * Windmillに届かないときの帯の表示。
 * 取得は失敗し、接続が戻ると、次の取得が自動で取り直す。
 */
export function OfflineBannerView({ unreachable }: { unreachable: boolean }) {
  if (!unreachable) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-warning/40 bg-warning/7 px-4 py-2 md:px-8"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <p className="text-small">
        <span className="font-semibold">Windmillに接続できません。</span>
        <span className="text-muted-foreground">
          接続が戻ると、自動で取り直します。
        </span>
      </p>
    </div>
  );
}

/**
 * 帯の元は、Windmillを呼ぶ`runScript`の結果だけである(`connectionState.ts`)。
 * 直近の呼び出しが届かなかった失敗(ネットワークの失敗、転送が返す502と503)なら出し、次に応答を得たら消す。
 * ブラウザの接続状態は見ない。他のネットワークが切れていても、同じ端末のWindmillには届くためである。
 * 帯が消えるとき、失敗した取得は読み直される(`watchConnectionRecovery`)。
 */
export function OfflineBanner() {
  return <OfflineBannerView unreachable={useConnectionState().unreachable} />;
}
