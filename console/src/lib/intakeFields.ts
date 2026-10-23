// 仮の実装。テストが失敗することを確かめるための値だけを返す。

export type IntakeFields = {
  readonly repo: string | null;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: string;
};

export const EMPTY_FIELDS: IntakeFields = {
  repo: "",
  title: "",
  body: "",
  acceptanceCriteria: "",
};

export function restoreFields(_session: {
  readonly form: unknown;
}): IntakeFields {
  return EMPTY_FIELDS;
}

export function fieldsAfterCount(
  current: IntakeFields,
  seenCount: number,
  _session: { readonly clearedCount: number },
): { readonly fields: IntakeFields; readonly seenCount: number } {
  return { fields: current, seenCount };
}
