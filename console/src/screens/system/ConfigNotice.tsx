import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/cn.ts";
import { safeText } from "../../lib/safeText.ts";
import type { ReleaseNotice } from "../../lib/writeNotices.ts";

/** 知らせの`id`。知らせが現れたとき、画面はここへ移動してフォーカスを置く。 */
export const CONFIG_NOTICE_ID = "config-notice";

const TITLE_TAILS: Readonly<Record<ReleaseNotice["tone"], string>> = {
  success: "の変更をしました",
  info: "の変更を断られました",
  warning: "の変更を確かめてください",
  error: "の変更に失敗しました",
};

/** 色は警告と失敗だけに付ける。断りは、中立の枠にする。枠の色を指定しないと、文字の色の枠になる。 */
const LOOKS = {
  success: { variant: "default", className: "border-border" },
  info: { variant: "default", className: "border-border" },
  warning: { variant: "warning", className: undefined },
  error: { variant: "destructive", className: undefined },
} as const;

/**
 * 設定の変更の結果のうち、読み手の操作が要るものを、閉じるまで残して出す。
 * 題は、どの項目の変更かと結果の種類を語で言う。色だけに頼らない。
 * 本文は何が起きたか、続けて、断りには次の操作を分けて書く。
 * 知らせ全体がフォーカスを受けられる(Tabの順には入れない)ので、現れたときに読み上げと位置をここへ移せる。
 * 項目と文はサーバー由来の文字を含みうるので、`safeText`を通して文字としてだけ描く。
 */
export function ConfigNotice({
  item,
  notice,
  onClose,
}: {
  item: string;
  notice: ReleaseNotice;
  onClose: () => void;
}) {
  return (
    <Alert
      id={CONFIG_NOTICE_ID}
      tabIndex={-1}
      variant={LOOKS[notice.tone].variant}
      className={cn(
        "max-w-3xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
        LOOKS[notice.tone].className,
      )}
    >
      <AlertTitle>{`${safeText(item)}${TITLE_TAILS[notice.tone]}`}</AlertTitle>
      <AlertDescription className="text-foreground">
        <p className="break-words">{safeText(notice.message)}</p>
        {notice.nextStep === undefined ? null : (
          <p className="break-words">
            <span className="font-medium">次の操作:</span>{" "}
            {safeText(notice.nextStep)}
          </p>
        )}
        <Button size="sm" variant="outline" onClick={onClose}>
          閉じる
        </Button>
      </AlertDescription>
    </Alert>
  );
}
