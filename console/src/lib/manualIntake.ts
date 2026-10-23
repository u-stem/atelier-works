// 仮の実装。テストが失敗することを確かめるための値だけを返す。

import type { IntakeTarget } from "../api/guards/intakeTargets.ts";

export const INTAKE_TITLE_MAX_CHARS = 0;

export type IntakeForm = {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: string;
};

export type IntakeProblem =
  | "repo_invalid"
  | "title_empty"
  | "title_too_long"
  | "body_empty";

export type IntakeBuild =
  | {
      readonly ok: true;
      readonly input: {
        readonly owner: string;
        readonly repo: string;
        readonly title: string;
        readonly body: string;
        readonly acceptanceCriteria: string;
      };
    }
  | { readonly ok: false; readonly problems: readonly IntakeProblem[] };

export function parseRepoRef(
  _text: string,
): { owner: string; repo: string } | null {
  return null;
}

export function repoOptionLabel(_target: IntakeTarget): string {
  return "";
}

export function defaultRepoText(_targets: readonly IntakeTarget[]): string {
  return "";
}

export function titleLength(_title: string): number {
  return 0;
}

export function buildIntakeInput(_form: IntakeForm): IntakeBuild {
  return { ok: false, problems: [] };
}

export function describeIntakeProblem(_problem: IntakeProblem): string {
  return "";
}
