import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  type ChangeOffer,
  changeDialogLines,
  newValueMessage,
  parseNewNumber,
} from "../../lib/configChange.ts";
import { safeText } from "../../lib/safeText.ts";

const VALUE_INPUT_ID = "config-change-value";
const PROBLEM_ID = "config-change-problem";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd
        dir="ltr"
        className="min-w-0 text-body break-words [unicode-bidi:isolate]"
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * 設定の項目を、止める向きか下げる向きに変える前の確認。確認のボタンは破壊的な色にする。Consoleからは戻せないためである。
 * 対象の項目、現在の値、変更後の値、効く時期、元に戻す方法(人がWindmillで編集する)を並べる。
 * 数値の項目は、変更後の値を入力欄で受け、使えない値の間は確認のボタンを押せなくする。
 * 初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * 項目名はサーバー由来の文字列なので、`safeText`を通して文字としてだけ描く。
 */
export function ConfigChangeDialog({
  offer,
  text,
  onTextChange,
  onConfirm,
  onCancel,
}: {
  offer: ChangeOffer | null;
  text: string;
  onTextChange: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (offer === null) {
    return (
      <ConfirmDialog
        open={false}
        title=""
        confirmLabel=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        {null}
      </ConfirmDialog>
    );
  }
  const parsed = offer.kind === "lower" ? parseNewNumber(text, offer) : null;
  const problem =
    parsed !== null && !parsed.ok && parsed.reason !== "empty"
      ? newValueMessage(parsed.reason)
      : null;
  return (
    <ConfirmDialog
      open
      title={
        offer.kind === "stop"
          ? "この設定を止めますか"
          : "この設定の値を下げますか"
      }
      confirmLabel={offer.kind === "stop" ? "止める" : "下げる"}
      destructive
      busy={parsed !== null && !parsed.ok}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <dl className="flex flex-col gap-1">
        <Field label="項目" value={safeText(offer.key)} />
        <Field
          label="現在の値"
          value={offer.kind === "stop" ? "true" : String(offer.current)}
        />
        {offer.kind === "stop" ? (
          <Field label="変更後の値" value="false" />
        ) : null}
      </dl>
      {offer.kind === "lower" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={VALUE_INPUT_ID} className="text-small text-subtle">
            変更後の値
          </label>
          <Input
            id={VALUE_INPUT_ID}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : PROBLEM_ID}
            onChange={(event) => {
              onTextChange(event.target.value);
            }}
          />
          {problem === null ? null : (
            <p id={PROBLEM_ID} className="text-small text-destructive">
              {problem}
            </p>
          )}
        </div>
      ) : null}
      {changeDialogLines(offer).map((line) => (
        <p key={line} className="text-body">
          {line}
        </p>
      ))}
    </ConfirmDialog>
  );
}
