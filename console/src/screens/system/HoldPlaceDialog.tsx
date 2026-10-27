import { useId } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select } from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import {
  checkPlaceForm,
  MAX_MINUTES,
  PLACE_KIND_LABELS,
  PLACE_KINDS,
  type PlaceForm,
  type PlaceKind,
  type PlaceProblem,
  placeEffectLines,
  placeProblemMessage,
  prepareDialogLines,
  REASON_MAX_LENGTH,
} from "../../lib/holdPlace.ts";
import { safeText } from "../../lib/safeText.ts";

type Variant = "any" | "stop_prepare";

type FieldName = "target" | "minutes" | "reason";

function fieldOf(problem: PlaceProblem): FieldName {
  if (problem.startsWith("target")) return "target";
  if (problem.startsWith("minutes")) return "minutes";
  return "reason";
}

/** 空の入力欄は、まだ入力していないだけなので、問題として出さない。 */
function visibleProblem(form: PlaceForm): PlaceProblem | null {
  const checked = checkPlaceForm(form);
  if (checked.ok || checked.problem.endsWith("_empty")) return null;
  return checked.problem;
}

function Problem({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className="text-small text-destructive">
      {text}
    </p>
  );
}

function FixedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-x-3">
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

function Fields({
  variant,
  form,
  problem,
  onChange,
}: {
  variant: Variant;
  form: PlaceForm;
  problem: PlaceProblem | null;
  onChange: (next: PlaceForm) => void;
}) {
  const id = useId();
  const kindId = `${id}-kind`;
  const targetId = `${id}-target`;
  const minutesId = `${id}-minutes`;
  const reasonId = `${id}-reason`;
  const problemId = `${id}-problem`;
  const failing = problem === null ? null : fieldOf(problem);
  const message =
    problem === null ? null : placeProblemMessage(problem, form.kind);
  const showTarget = variant === "any" && form.kind !== "deploy";
  const describedBy = (field: FieldName) =>
    failing === field ? problemId : undefined;

  return (
    <div className="flex flex-col gap-3">
      {variant === "stop_prepare" ? (
        <dl className="flex flex-col gap-1">
          <FixedField label="対象" value={safeText(form.target)} />
        </dl>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={kindId} className="text-small text-subtle">
            種類
          </label>
          <Select
            id={kindId}
            value={form.kind}
            onChange={(event) => {
              const next = PLACE_KINDS.find(
                (kind) => kind === event.target.value,
              );
              if (next !== undefined) onChange({ ...form, kind: next });
            }}
          >
            {PLACE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {PLACE_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </div>
      )}
      {showTarget ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={targetId} className="text-small text-subtle">
            対象
          </label>
          <Input
            id={targetId}
            type="text"
            autoComplete="off"
            placeholder={
              form.kind === "merge" ? "owner/repo" : "f/factory/名前"
            }
            value={form.target}
            aria-invalid={failing === "target"}
            aria-describedby={describedBy("target")}
            onChange={(event) => {
              onChange({ ...form, target: event.target.value });
            }}
          />
          {failing === "target" && message !== null ? (
            <Problem id={problemId} text={message} />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={minutesId} className="text-small text-subtle">
          期限(分)
        </label>
        <Input
          id={minutesId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={form.minutesText}
          aria-invalid={failing === "minutes"}
          aria-describedby={describedBy("minutes")}
          onChange={(event) => {
            onChange({ ...form, minutesText: event.target.value });
          }}
        />
        <p className="text-small text-subtle">
          {`最大${String(MAX_MINUTES[form.kind])}分`}
        </p>
        {failing === "minutes" && message !== null ? (
          <Problem id={problemId} text={message} />
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={reasonId} className="text-small text-subtle">
          理由
        </label>
        <Textarea
          id={reasonId}
          maxLength={REASON_MAX_LENGTH}
          value={form.reason}
          aria-invalid={failing === "reason"}
          aria-describedby={describedBy("reason")}
          onChange={(event) => {
            onChange({ ...form, reason: event.target.value });
          }}
        />
        {failing === "reason" && message !== null ? (
          <Problem id={problemId} text={message} />
        ) : null}
      </div>
    </div>
  );
}

function linesOf(variant: Variant, kind: PlaceKind, target: string) {
  return variant === "stop_prepare"
    ? prepareDialogLines(target)
    : placeEffectLines(kind);
}

/**
 * 保留や凍結を置く前の確認。確認のボタンは破壊的な色にしない。
 * 期限が来れば必ず終わり、解除でき、置き直せるためである。
 * 種類、対象、期限、理由を入力欄で受け、使えない値の間は確認のボタンを押せなくする。
 * 効果と、終わり方(期限と解除)を並べる。初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * `stop_prepare`は、scheduleを止める準備として凍結を置く確認で、対象を固定し、種類を選ばせない。
 * 対象の文字列は入力された値なので、固定の対象は`safeText`を通して文字としてだけ描く。
 */
export function HoldPlaceDialog({
  open,
  variant,
  form,
  onChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  variant: Variant;
  form: PlaceForm;
  onChange: (next: PlaceForm) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) {
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
  return (
    <ConfirmDialog
      open
      title={
        variant === "stop_prepare"
          ? "scheduleを止める準備をしますか"
          : "保留か凍結を置きますか"
      }
      confirmLabel={variant === "stop_prepare" ? "凍結を置く" : "置く"}
      confirmDisabled={!checkPlaceForm(form).ok}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <Fields
        variant={variant}
        form={form}
        problem={visibleProblem(form)}
        onChange={onChange}
      />
      {linesOf(variant, form.kind, form.target).map((line) => (
        <p key={line} className="text-body">
          {line}
        </p>
      ))}
    </ConfirmDialog>
  );
}

/** 保留や凍結を置く確認を開くボタン。書き込みは確認を通った後にだけ呼ぶ。 */
export function HoldPlaceButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      保留や凍結を置く
    </Button>
  );
}
