/** 人が`origin/main`のコミットを承認する道具の本体。 */

import type { ReadApprovedResult } from "./approved_io.ts";
import type { ApprovedRecord } from "./approved_store.ts";
import type { OriginCheck } from "./code_origin.ts";
import type { PlanGit } from "./plan.ts";
import type { GitRunner } from "./plan_git.ts";
import { createPlanGit } from "./plan_git.ts";

/** 差分の標準出力の上限(バイト)。 */
export const MAX_DIFF_BYTES = 512 * 1024;

/** 差分を一度に表示する行数。 */
export const PAGE_SIZE = 40;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export type ApproveArgs = {
  readonly sha: string;
  readonly applied: string;
  readonly stateDir: string | null;
};

export type ParsedApproveArgs =
  | { readonly ok: true; readonly args: ApproveArgs }
  | { readonly ok: false; readonly error: string };

export type DiffPatch = { readonly text: string; readonly truncated: boolean };

/** `approve`が使うgitの読み取り。 */
export type ApproveGit = PlanGit & {
  resolveCommit(input: string): Promise<string | null>;
  originMainTip(): Promise<string | null>;
  diffPatch(
    base: string,
    target: string,
    files: readonly string[],
  ): Promise<DiffPatch>;
};

export type LimitedGitRunner = (
  args: string[],
  maxBytes: number,
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly truncated: boolean;
}>;

export type PagerIo = {
  print(line: string): void;
  readLine(): Promise<string | null>;
};

export type ApprovalIo = PagerIo & { error(line: string): void };

export type ApproveDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly isTerminal: () => boolean;
  readonly checkOrigin: () => Promise<OriginCheck>;
  readonly git: ApproveGit;
  readonly readRecord: () => ReadApprovedResult;
  readonly writeRecord: (record: ApprovedRecord) => void;
  readonly now: () => Date;
  readonly io: ApprovalIo;
};

export function isAgentSuspected(
  _env: Readonly<Record<string, string | undefined>>,
): boolean {
  return false;
}

export function isAllowedCodePoint(_codePoint: number): boolean {
  return false;
}

export function escapeForDisplay(_text: string): string {
  return "";
}

export function addedLines(_diff: string): string[] {
  return [];
}

export type AddedViolation = { readonly line: string };

export function findAddedViolations(_diff: string): AddedViolation[] {
  return [];
}

export function confirmationPhrase(_target: string): string {
  return "";
}

export function parseApproveArgs(_argv: readonly string[]): ParsedApproveArgs {
  return { ok: false, error: "not implemented" };
}

export async function showPaged(
  _lines: readonly string[],
  _io: PagerIo,
  _pageSize: number = PAGE_SIZE,
): Promise<"done" | "quit"> {
  return "done";
}

export function createApproveGit(
  run: GitRunner,
  _runLimited: LimitedGitRunner,
): ApproveGit {
  return {
    ...createPlanGit(run),
    async resolveCommit() {
      return null;
    },
    async originMainTip() {
      return null;
    },
    async diffPatch() {
      return { text: "", truncated: false };
    },
  };
}

export async function runApprove(
  _args: ApproveArgs,
  _deps: ApproveDeps,
): Promise<number> {
  return EXIT_FAILED;
}
