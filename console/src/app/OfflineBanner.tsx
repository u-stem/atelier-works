import { onlineManager } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";

/**
 * 接続が切れているときの帯の表示。
 * 取得は止まり、接続が戻ると、TanStack Queryが自動で取り直す。
 */
export function OfflineBannerView({ online }: { online: boolean }) {
  if (online) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-warning/40 bg-warning/7 px-4 py-2 md:px-8"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <p className="text-small">
        <span className="font-semibold">オフラインです。</span>
        <span className="text-muted-foreground">
          接続が戻ると、自動で取り直します。
        </span>
      </p>
    </div>
  );
}

/**
 * 接続の状態は、TanStack Queryの`onlineManager`だけを見る。
 * 取得を止めるか再開するかを決めるのも`onlineManager`なので、帯と取得の状態がずれない。
 * `navigator.onLine`は読まない。復帰時の取り直しも、既定の`refetchOnReconnect`に任せる。
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    (onChange) => onlineManager.subscribe(onChange),
    () => onlineManager.isOnline(),
    () => onlineManager.isOnline(),
  );
  return <OfflineBannerView online={online} />;
}
