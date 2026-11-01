import type { ReactNode } from "react";

/** 入力欄に渡す、ラベルと補足とエラーへの結線。 */
type FieldControl = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
};

type FieldProps = {
  label: string;
  hint?: string | undefined;
  problem?: string | undefined;
  tone?: "form" | "filter";
  id?: string;
  className?: string;
  children: (control: FieldControl) => ReactNode;
};

function Field(_props: FieldProps) {
  return null;
}

export type { FieldControl, FieldProps };
export { Field };
