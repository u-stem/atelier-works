// コマンドを実行するlibモジュール(`github.ts`、`workspace.ts`、`claude.ts`)の
// smallテストで共有するフェイク。テスト専用で、Windmillにはデプロイしない。

import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";

export type FakeCall = {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
};

export type FakeCommandRunner = {
  readonly run: CommandRunner;
  readonly calls: FakeCall[];
};

/**
 * 呼び出し1回ごとに`responses`を順に返す偽の`CommandRunner`を作る。
 * 応答が`Error`のときは、その例外を投げる。
 * プロセスの起動失敗を表すには`SpawnError`を渡す。
 * 検証のため、各呼び出しのargvとoptionsを`calls`に記録する。
 * 用意した応答が尽きたあとに呼ばれると例外を投げる。
 */
export function createFakeCommandRunner(
  responses: readonly (CommandResult | Error)[],
): FakeCommandRunner {
  const calls: FakeCall[] = [];
  let index = 0;
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    const result = responses[index];
    index += 1;
    if (result === undefined) {
      throw new Error(
        `createFakeCommandRunner: no canned response for call #${index} (${argv.join(" ")})`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

export function ok(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0, timedOut: false };
}

export function fail(stderr: string, exitCode = 1): CommandResult {
  return { stdout: "", stderr, exitCode, timedOut: false };
}

export function timeout(stderr = ""): CommandResult {
  return { stdout: "", stderr, exitCode: 137, timedOut: true };
}

/**
 * `gh api -i`の標準出力と同じ形の文字列を作る。
 * ステータス行、CRLFで区切ったヘッダー、空行、本文の順に並べる。
 * 形は実際の`gh api -i`の出力を採取して合わせた。
 * 用意する`CommandResult.stdout`として使う。
 */
export function ghApiStdout(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): string {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const headerLines = Object.entries(headers).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return [`HTTP/2.0 ${status} Status`, ...headerLines, "", bodyText].join(
    "\r\n",
  );
}

export function ghApiOk(
  body: unknown,
  headers: Record<string, string> = {},
): CommandResult {
  return ok(ghApiStdout(200, body, headers));
}

/**
 * 付与者の確認のGraphQL(`timelineItems`の`LABELED_EVENT` / `UNLABELED_EVENT`)の
 * 応答のノード1件。形は本物のAPIの応答から採った。
 * `login`が`null`のときは`actor`が無い。
 */
export function labelEventNode(
  kind: "labeled" | "unlabeled",
  login: string | null,
  label: string,
  createdAt = "2026-09-28T03:13:41Z",
  actorType = "User",
  databaseId?: unknown,
) {
  const prefix = kind === "labeled" ? "LE" : "UNLE";
  return {
    __typename: kind === "labeled" ? "LabeledEvent" : "UnlabeledEvent",
    id: `${prefix}_${createdAt}_${label}`,
    createdAt,
    actor:
      login === null
        ? null
        : {
            login,
            __typename: actorType,
            ...(databaseId === undefined ? {} : { databaseId }),
          },
    label: { name: label },
  };
}

/**
 * 付与者の確認のGraphQLの応答。
 * `hasPreviousPage`は、読んだ範囲より古いラベルのイベントが残っているか。
 */
export function labelEventsOk(
  nodes: readonly unknown[],
  hasPreviousPage = false,
): CommandResult {
  return ghApiOk({
    data: {
      repository: {
        issueOrPullRequest: {
          timelineItems: { pageInfo: { hasPreviousPage }, nodes },
        },
      },
    },
  });
}
