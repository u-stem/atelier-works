// 手動投入の検証とIssue本文の組み立て。
// 今は仮の実装で、テストが失敗することを確かめるための戻り値だけを返す。

import type { FactoryConfig } from "./types.ts";

export const MANUAL_INTAKE_REFUSAL_REASONS: readonly string[] = [];

export type ManualIntakeRefusalReason = string;

export type ManualIntakeIssueInput = {
  readonly body: string;
  readonly acceptance_criteria: string;
};

export type ManualIntakeFields = ManualIntakeIssueInput & {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
};

export type ManualIntakeValidation =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: ManualIntakeRefusalReason };

export function buildManualIntakeIssueBody(
  _input: ManualIntakeIssueInput,
): string {
  return "";
}

export function validateManualIntake(
  _input: ManualIntakeFields,
  _config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
): ManualIntakeValidation {
  return { ok: false, reason: "invalid_owner" };
}
