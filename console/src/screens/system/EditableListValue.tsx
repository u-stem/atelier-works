import type { ConfigItemView } from "../../api/jobsQueries.ts";
import { Button } from "../../components/ui/button.tsx";
import { type ChangeOffer, LAST_ELEMENT_NOTE } from "../../lib/configChange.ts";
import { describeConfigValue } from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { EmptyValue, TextValue } from "./ConfigText.tsx";

type ListOffer = Extract<ChangeOffer, { kind: "add" | "remove" }>;

/**
 * 一覧の追加か削除のボタン。確認のダイアログを開くだけで、書き込みは確認を通った後にだけ呼ぶ。
 * 操作中(`locked`)は押せない。名前に項目と要素を含め、同じ語のボタンを見分けられるようにする。
 */
export function ListChangeButton({
  offer,
  locked,
  onChoose,
}: {
  offer: ListOffer;
  locked: boolean;
  onChoose: (offer: ChangeOffer) => void;
}) {
  const key = safeText(offer.key);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={locked}
      aria-label={
        offer.kind === "add"
          ? `${key}に追加`
          : `${key}から${safeText(offer.element)}を削除`
      }
      onClick={() => {
        onChoose(offer);
      }}
    >
      {offer.kind === "add" ? "追加" : "削除"}
    </Button>
  );
}

/**
 * 1要素ずつ追加と削除ができる一覧。各要素の行に削除、一覧の下に追加のボタンを置く。
 * 削除の候補が無い要素(`repo_allowlist`の最後の1件)には、その行の下に理由を1文で添える。
 * 要素と空の注記は、`describeConfigValue`が`safeText`を通した文字列で、文字としてだけ描く。
 */
export function EditableListValue({
  item,
  offers,
  isLocked,
  onChoose,
}: {
  item: ConfigItemView;
  offers: readonly ChangeOffer[];
  isLocked: (offer: ChangeOffer) => boolean;
  onChoose: (offer: ChangeOffer) => void;
}) {
  const value = describeConfigValue(item);
  const removals = new Map<number, Extract<ListOffer, { kind: "remove" }>>();
  let add: Extract<ListOffer, { kind: "add" }> | undefined;
  for (const offer of offers) {
    if (offer.kind === "remove") removals.set(offer.index, offer);
    if (offer.kind === "add") add = offer;
  }
  return (
    <div className="flex flex-col gap-2">
      {value.kind === "list" ? (
        <ul className="flex w-fit max-w-full flex-col gap-1.5 text-small">
          {value.items.map((text, index) => {
            const removal = removals.get(index);
            return (
              // 要素は重なりうるので、位置を含めて見分ける。並びは変わらない。
              // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字列の要素が並びうる。
              <li key={`${index}:${text}`} className="flex flex-col gap-0.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 font-mono break-words">
                    <TextValue text={text} />
                  </span>
                  {removal === undefined ? null : (
                    <ListChangeButton
                      offer={removal}
                      locked={isLocked(removal)}
                      onChoose={onChoose}
                    />
                  )}
                </div>
                {removal === undefined ? (
                  <p className="text-muted-foreground">{LAST_ELEMENT_NOTE}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyValue note={value.kind === "empty" ? value.note : null} />
      )}
      {add === undefined ? null : (
        <div>
          <ListChangeButton
            offer={add}
            locked={isLocked(add)}
            onChoose={onChoose}
          />
        </div>
      )}
    </div>
  );
}
