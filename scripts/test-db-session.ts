// `mise run test:db`のscriptが、1本のpsqlのセッションを使い回して文を流すための補助。

import type { SqlClient } from "../f/factory/lib/db.ts";
import type { PsqlTarget } from "./test-db-sql.ts";

export type PsqlFormat = "plain" | "csv";

export type PsqlSessionOptions = {
  readonly argv?: (
    containerId: string,
    database: string,
    format: PsqlFormat,
  ) => string[];
  readonly containerId?: (composeFile: string) => string;
  readonly terminate?: (
    pid: number,
    startedAt: string,
    target: PsqlTarget,
  ) => void;
  readonly exit?: (code: number) => never;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type PsqlSessions = {
  client(target: PsqlTarget): SqlClient;
  exec(target: PsqlTarget, sql: string): Promise<string>;
  close(): Promise<void>;
};

export function terminateStatement(_pid: number, _startedAt: string): string {
  return "";
}

export function createPsqlSessions(
  _options: PsqlSessionOptions = {},
): PsqlSessions {
  return {
    client: () => () => ({
      fetch: async () => [],
      execute: async () => {},
    }),
    exec: async () => "",
    close: async () => {},
  };
}

const defaultSessions = createPsqlSessions();

export function createPsqlSessionClient(target: PsqlTarget): SqlClient {
  return defaultSessions.client(target);
}

export async function execPsqlAsync(
  target: PsqlTarget,
  sql: string,
): Promise<void> {
  await defaultSessions.exec(target, sql);
}

export async function closePsqlSessions(): Promise<void> {
  await defaultSessions.close();
}
