// 仮の実装。テストが失敗することを確かめるための値だけを返す。

export type IntakeTarget = {
  readonly owner: string;
  readonly repo: string;
};

export function isIntakeTargets(_value: unknown): _value is IntakeTarget[] {
  return false;
}
