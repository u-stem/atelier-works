import type { DesignStageView } from "../../api/jobsQueries.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  type ChangeOffer,
  type CheckCommands,
  changeDialogConclusion,
  changeDialogDetails,
  lowerHint,
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
  reader,
}: {
  label: string;
  value: string;
  /** 画面には出さず、読み上げにだけ添える補足。書かれた値(true、false)を残す。 */
  reader?: string;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd
        dir="ltr"
        className="min-w-0 text-body break-words [unicode-bidi:isolate]"
      >
        {value}
        {reader === undefined ? null : (
          <span className="sr-only">{reader}</span>
        )}
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

/**
 * 止める向きの、項目と「有効 → 無効」の行。結論が項目も値も言わないので、ここで示す。
 * 書かれた値(true、false)は、読み上げにだけ残す。
 * 下げる、追加、削除は、結論が項目と値か要素を言うので、行を置かない。
 */
function StopFields({
  offer,
}: {
  offer: Extract<ChangeOffer, { kind: "stop" }>;
}) {
  return (
    <dl className="flex flex-col gap-1">
      <FixedField label="項目" value={safeText(offer.key)} />
      <FixedField label="値" value="有効 → 無効" reader="(true → false)" />
    </dl>
  );
}

/**
 * 設定の項目を変える前の確認。止める向き、下げる向き、一覧への追加、一覧からの削除の4つを扱う。
 * 確認のボタンは破壊的な色にする。止めると下げるはConsoleから戻せず、追加は対象を広げ、削除は対象を外すためである。
 * 先頭に、重大な結果を言う1つの結論を強調して出す。止める向きだけ、結論の後に項目と値の行を置く。最後に、効く時期と元に戻す方法を箇条書きで並べる。
 * 設計工程が無視されているときは、`design_enabled`を止めても動きが変わらないことを結論が言う。
 * 数値の項目は変更後の値、追加は足す要素を入力欄で受ける。使えない値の間は確認のボタンを押せなくする。
 * 追加の要素の形式は、画面では検査しない。scriptの断りの文が伝える。
 * 初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * 項目名と要素はサーバー由来の文字列なので、`safeText`を通して文字としてだけ描く。
 * `checkCommands`は、`repo_allowlist`への追加の確認が、検査コマンドの及ぶ範囲を伝えるために使う。
 * `designStage`は、設計工程が実際に効いているか。backendが返さない間は渡さない。
 */
export function ConfigChangeDialog({
  offer,
  text,
  checkCommands = NO_CHECK_COMMANDS,
  designStage,
  onTextChange,
  onConfirm,
  onCancel,
}: {
  offer: ChangeOffer | null;
  text: string;
  checkCommands?: CheckCommands;
  designStage?: DesignStageView | undefined;
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
  const hint =
    offer.kind === "add"
      ? newElementHint(offer.key)
      : offer.kind === "lower"
        ? lowerHint(offer)
        : undefined;
  const context = { text, designStage };
  const details = changeDialogDetails(offer, checkCommands, context);
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
      <p className="text-body font-semibold">
        {changeDialogConclusion(offer, context)}
      </p>
      {offer.kind === "stop" ? <StopFields offer={offer} /> : null}
      {typed ? (
        <Field
          tone="filter"
          label={offer.kind === "add" ? "追加する要素" : "変更後の値"}
          hint={hint}
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
      {details.length === 0 ? null : (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body marker:text-muted-foreground">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  );
}
