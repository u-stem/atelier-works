import { cva } from "class-variance-authority";
import { type ReactNode, useId } from "react";
import { cn } from "../../lib/cn.ts";

/** 入力欄に渡す、ラベルと補足とエラーへの結線。入力欄に展開して使う。 */
type FieldControl = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
};

// ラベルの段は2つに絞る。縦に並ぶ入力の項目は`form`、絞り込みの行やダイアログの小さな入力は`filter`。
const fieldVariants = cva("flex flex-col", {
  variants: {
    tone: {
      form: "gap-1.5",
      filter: "gap-1",
    },
  },
  defaultVariants: { tone: "form" },
});

const LABEL_CLASSES = {
  form: "text-body font-medium",
  filter: "text-small text-muted-foreground",
} as const;

type FieldProps = {
  label: string;
  /** 入力の前に読む補足。入力欄の説明として読み上げに結ぶ。 */
  hint?: string | undefined;
  /** 入力の誤り。入力欄を不正と示し、説明として読み上げに結ぶ。 */
  problem?: string | undefined;
  /** 字数などの追加の説明。入力欄の説明として読み上げに結ぶ。 */
  counter?: string | undefined;
  tone?: "form" | "filter";
  /** 入力欄の`id`。省くと自動で決める。 */
  id?: string;
  className?: string;
  /** 入力欄を描く。受け取った`control`を入力欄に展開すると、ラベルと補足とエラーが結ばれる。 */
  children: (control: FieldControl) => ReactNode;
};

/**
 * ラベルと入力欄と補足とエラーの組。
 * ラベルを入力欄に結び、補足とエラーを`aria-describedby`で入力欄に結ぶ。結線は入力欄ごとに書かない。
 */
function Field({
  label,
  hint,
  problem,
  tone = "form",
  id,
  className,
  children,
}: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const problemId = `${controlId}-problem`;
  const described = [
    hint === undefined ? null : hintId,
    problem === undefined ? null : problemId,
  ].filter((value) => value !== null);
  return (
    <div data-slot="field" className={cn(fieldVariants({ tone }), className)}>
      <label htmlFor={controlId} className={LABEL_CLASSES[tone]}>
        {label}
      </label>
      {children({
        id: controlId,
        "aria-describedby":
          described.length === 0 ? undefined : described.join(" "),
        "aria-invalid": problem === undefined ? undefined : true,
      })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-small text-muted-foreground">
          {hint}
        </p>
      )}
      {problem === undefined ? null : (
        <p id={problemId} className="text-small text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

export type { FieldControl, FieldProps };
export { Field };
