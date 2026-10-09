import { LogIn } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert.tsx";
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
    <Alert variant="warning" className="rounded-none border-x-0 border-t-0">
      <LogIn aria-hidden="true" />
      <AlertTitle>ログインの有効期限が切れました</AlertTitle>
      <AlertDescription>
        <p>
          最新の情報を取得できません。ログインし直すと、この画面に戻ります。
        </p>
        <Button size="sm" onClick={goToLogin}>
          ログイン
        </Button>
      </AlertDescription>
    </Alert>
  );
}
