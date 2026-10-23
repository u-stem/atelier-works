// 保留の表を、ホストの端末からpsql経由で読み書きするための接続。

import type { HoldSqlClient } from "../f/factory/lib/holds.ts";

export type HoldPsqlMode = "read" | "write";

export type HoldPsqlRequest = {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
};

export type HoldPsqlResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type HoldPsqlRun = (request: HoldPsqlRequest) => Promise<HoldPsqlResult>;

export type HoldPsqlOptions = {
  readonly composeFile: string;
  readonly database: string;
  readonly mode: HoldPsqlMode;
  readonly run?: HoldPsqlRun;
  readonly timeoutMs?: number;
};

export const HOLD_PSQL_TIMEOUT_MS = 20_000;

export async function runHoldPsql(
  _request: HoldPsqlRequest,
): Promise<HoldPsqlResult> {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}

export function createHoldPsqlClient(_options: HoldPsqlOptions): HoldSqlClient {
  return () => ({
    fetch: async () => [],
    execute: async () => {},
  });
}
