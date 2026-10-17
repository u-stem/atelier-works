/** `plan`の判定。gitの読み取りは`PlanGit`として注入し、この関数は何も実行しない。 */

import type { ChangedFile } from "./approval.ts";
import type { RejectionKind } from "./target.ts";

export type PlanGit = {
  commitExists(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  changedFiles(base: string, target: string): Promise<ChangedFile[]>;
  readBlob(sha: string, path: string): Promise<string | null>;
};

export type PlanInput = {
  readonly applied: string;
  readonly target: string;
  readonly approved: string | null;
  /** パスの内外の判定に使う、ステージングのルートの論理的な絶対パス。実在しなくてよい。 */
  readonly root: string;
};

export type PlanResult =
  | {
      readonly decision: "noop";
      readonly applied: string;
      readonly target: string;
    }
  | {
      readonly decision: "rejected";
      readonly kind: RejectionKind;
      readonly detail: string;
      readonly applied: string;
      readonly target: string;
    }
  | {
      readonly decision: "pending_approval";
      readonly base: string;
      readonly files: readonly string[];
      readonly applied: string;
      readonly target: string;
    }
  | {
      readonly decision: "would_converge";
      readonly ci: "not_checked";
      readonly applied: string;
      readonly target: string;
    };

export async function buildPlan(
  _git: PlanGit,
  input: PlanInput,
): Promise<PlanResult> {
  return { decision: "noop", applied: input.applied, target: input.target };
}

export type PlanArgs = {
  readonly repo: string;
  readonly applied: string;
  readonly target: string;
  readonly approved: string | null;
};

export type ParsedPlanArgs =
  | { readonly ok: true; readonly args: PlanArgs }
  | { readonly ok: false; readonly error: string };

export function parsePlanArgs(_argv: readonly string[]): ParsedPlanArgs {
  return { ok: false, error: "stub" };
}
