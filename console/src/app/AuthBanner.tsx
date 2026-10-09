import { LogIn } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { buildLoginUrl } from "../lib/loginUrl.ts";
import { useAuthState } from "./authState.ts";

function goToLogin(): void {
  window.location.assign(buildLoginUrl(window.location));
}

/**
 * ログインの有効期限が切れたときに画面の上部へ出す。
 * 自動ではログインへ移さない。入力途中の内容を残したまま、操作者が移すときを選べるようにする。
 */
export function AuthBanner() {
  const { unauthorized } = useAuthState();
  if (!unauthorized) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning/40 bg-warning/14 px-8 py-3"
    >
      <LogIn aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold">
          ログインの有効期限が切れました
        </p>
        <p className="text-small text-muted-foreground">
          最新の情報を取得できません。ログインし直すと、この画面に戻ります。
        </p>
      </div>
      <Button size="sm" onClick={goToLogin}>
        ログイン
      </Button>
    </div>
  );
}
