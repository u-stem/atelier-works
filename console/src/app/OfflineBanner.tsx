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
 * 帯の元は、Windmillへの取得の結果だけである(`connectionState.ts`)。
 * 直近の取得がネットワークの失敗なら出し、次の取得の成功で消す。
 * ブラウザの接続状態は見ない。他のネットワークが切れていても、同じ端末のWindmillには届くためである。
 * 取り直しは、ウィンドウに戻ったときの取得(`refetchOnWindowFocus`)と、各取得の再試行に任せる。
 */
export function OfflineBanner() {
  return <OfflineBannerView unreachable={useConnectionState().unreachable} />;
}
