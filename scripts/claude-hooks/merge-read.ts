// 暫定の実装。型に合う誤った値を返す。

import type { HoldReadOutcome, HoldRow } from "../../f/factory/lib/holds.ts";
import type {
  HoldPsqlRequest,
  HoldPsqlResult,
  HoldPsqlRun,
} from "../hold_psql.ts";

export const READ_TIMEOUT_MS = 0;

export type ReadOptions = {
  readonly root: string;
  readonly mise: string | null;
  readonly run: HoldPsqlRun;
  readonly now?: () => Date;
};

export type FreezeReading =
  | {
      readonly ok: true;
      readonly deploy: readonly {
        readonly id: string;
        readonly expires_at: string;
      }[];
      readonly schedule: number;
    }
  | { readonly ok: false; readonly reason: string };

export function findMise(
  _env: Readonly<Record<string, string | undefined>>,
  _isExecutable: (path: string) => boolean,
): string | null {
  return null;
}

export function buildChildEnv(
  _env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {};
}

export function rootOf(_moduleUrl: string): string {
  return "";
}

export type ChildRequest = HoldPsqlRequest & {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export function runChild(_request: ChildRequest): Promise<HoldPsqlResult> {
  return Promise.resolve({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
}

export function readMergeHolds(
  _options: ReadOptions,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  return Promise.resolve({ ok: true, value: [] });
}

export function readDeployFreezes(
  _options: ReadOptions,
): Promise<FreezeReading> {
  return Promise.resolve({ ok: true, deploy: [], schedule: 0 });
}
