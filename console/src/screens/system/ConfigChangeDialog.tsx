import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  type ChangeOffer,
  type CheckCommands,
  changeDialogLines,
  NO_CHECK_COMMANDS,
  newElementMessage,
  newValueMessage,
  parseNewElement,
  parseNewNumber,
} from "../../lib/configChange.ts";
import { safeText } from "../../lib/safeText.ts";

function FixedField({
  label,
  value,
  breakAnywhere = false,
}: {
  label: string;
  value: string;
  /** 区切りの無い長い文字列(URLなど)を、どこでも折る。 */
  breakAnywhere?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd
        dir="ltr"
        className={`min-w-0 text-body [unicode-bidi:isolate] ${
          breakAnywhere ? "break-all" : "break-words"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/** 追加する要素の入力欄の補足。項目ごとの要素の形の例である。形の検査はscriptが行う。 */
function newElementHint(key: string): string | undefined {
  switch (key) {
    case "repo_allowlist":
      return "例: https://github.com/owner/repo";
    case "dependabot_other_repos":
      return "例: owner/repo";
    case "default_reviewers":
      return "GitHubのログイン名";
    default:
      return undefined;
  }
}

const TITLES = {
  stop: "この設定を止めますか",
  lower: "この設定の値を下げますか",
  add: "この一覧に追加しますか",
  remove: "この一覧から削除しますか",
} as const;

const CONFIRM_LABELS = {
  stop: "止める",
  lower: "下げる",
  add: "追加",
  remove: "削除",
} as const;

/**
 * 入力欄の文字列が使えないかと、欄の下に出す理由。
 * 欄が空の間は、理由を出さずに確認のボタンだけを押せなくする。
 */
function inputState(
  offer: ChangeOffer,
  text: string,
): { blocked: boolean; problem: string | null } {
  if (offer.kind === "lower") {
    const parsed = parseNewNumber(text, offer);
    return {
      blocked: !parsed.ok,
      problem:
        !parsed.ok && parsed.reason !== "empty"
          ? newValueMessage(parsed.reason)
          : null,
    };
  }
  if (offer.kind === "add") {
    const parsed = parseNewElement(text);
    return {
      blocked: !parsed.ok,
      problem:
        !parsed.ok && parsed.reason !== "empty"
          ? newElementMessage(parsed.reason)
          : null,
    };
  }
  return { blocked: false, problem: null };
}

/** 変更の対象を示す行。止める・下げるは現在の値、追加は何も足さない、削除は除く要素。 */
function TargetFields({ offer }: { offer: ChangeOffer }) {
  return (
    <dl className="flex flex-col gap-1">
      <FixedField label="項目" value={safeText(offer.key)} />
      {offer.kind === "stop" ? (
        <>
          <FixedField label="現在の値" value="true" />
          <FixedField label="変更後の値" value="false" />
        </>
      ) : null}
      {offer.kind === "lower" ? (
        <FixedField label="現在の値" value={String(offer.current)} />
      ) : null}
      {offer.kind === "remove" ? (
        <FixedField
          label="削除する要素"
          value={safeText(offer.element)}
          breakAnywhere
        />
      ) : null}
    </dl>
  );
}

/**
 * 設定の項目を変える前の確認。止める向き、下げる向き、一覧への追加、一覧からの削除の4つを扱う。
 * 確認のボタンは破壊的な色にする。止めると下げるはConsoleから戻せず、追加は対象を広げ、削除は対象を外すためである。
 * 対象の項目と、止める・下げるは現在の値、削除は除く要素を示し、効く時期と元に戻す方法を並べる。
 * 数値の項目は変更後の値、追加は足す要素を入力欄で受ける。使えない値の間は確認のボタンを押せなくする。
 * 追加の要素の形式は、画面では検査しない。scriptの断りの文が伝える。
 * 初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * 項目名と要素はサーバー由来の文字列なので、`safeText`を通して文字としてだけ描く。
 * `checkCommands`は、`repo_allowlist`への追加の確認が、検査コマンドの及ぶ範囲を伝えるために使う。
 */
export function ConfigChangeDialog({
  offer,
  text,
  checkCommands = NO_CHECK_COMMANDS,
  onTextChange,
  onConfirm,
  onCancel,
}: {
  offer: ChangeOffer | null;
  text: string;
  checkCommands?: CheckCommands;
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
  const { blocked, problem } = inputState(offer, text);
  const typed = offer.kind === "lower" || offer.kind === "add";
  return (
    <ConfirmDialog
      open
      title={TITLES[offer.kind]}
      confirmLabel={CONFIRM_LABELS[offer.kind]}
      destructive
      confirmDisabled={blocked}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <TargetFields offer={offer} />
      {typed ? (
        <Field
          tone="filter"
          label={offer.kind === "add" ? "追加する要素" : "変更後の値"}
          hint={offer.kind === "add" ? newElementHint(offer.key) : undefined}
          problem={problem === null ? undefined : problem}
        >
          {(control) => (
            <Input
              {...control}
              type="text"
              inputMode={offer.kind === "lower" ? "decimal" : undefined}
              autoComplete="off"
              spellCheck={offer.kind === "add" ? false : undefined}
              value={text}
              onChange={(event) => {
                onTextChange(event.target.value);
              }}
            />
          )}
        </Field>
      ) : null}
      {changeDialogLines(offer, checkCommands).map((line) => (
        <p key={line} className="text-body">
          {line}
        </p>
      ))}
    </ConfirmDialog>
  );
}
