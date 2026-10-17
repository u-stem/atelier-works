/**
 * ホストの実行役の入口。`plan`だけを実装する。
 * 引数の`--repo`のリポジトリから、gitのオブジェクトを読み取り、判定をJSONで出力する。
 * 作業ツリーの変更とネットワークは使わない。
 * このファイルと`scripts/host_apply/`は、NodeとBunの組み込みと`scripts/host_apply/`の中だけをimportする。
 * 状態ディレクトリの`bin/`へコピーして、リポジトリの外で単独で動かすため。
 */

import { COMMAND_TIMEOUT_MS } from "./host_apply/constants.ts";
import { buildChildEnv } from "./host_apply/env.ts";
import { buildPlan, parsePlanArgs } from "./host_apply/plan.ts";
import { createPlanGit } from "./host_apply/plan_git.ts";

const USAGE =
  "usage: host-apply plan --repo <path> --applied <sha> --target <sha> [--approved <sha>]";

/** ステージングのルートの論理的なパス。パスの内外の判定にだけ使い、実在しなくてよい。 */
const LOGICAL_ROOT = "/staging";

type GitResult = { readonly code: number; readonly stdout: string };

/**
 * 読み取りだけのgitを`repo`で実行する。引数は配列で渡し、環境は許可リストで作る。
 * 上限を超えて止められたときは、失敗の結果ではなく例外にする。
 */
async function runGit(repo: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
    env: buildChildEnv("git", {
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? "/",
      values: {},
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: COMMAND_TIMEOUT_MS.git_read,
    killSignal: "SIGKILL",
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (proc.signalCode !== null) throw new Error("git command was killed");
  return { code, stdout };
}

/**
 * 実行役の入口。終了コードを返す。
 * 判定が出れば0、実行の失敗(コミットが無い、gitの失敗など)は1、使い方の誤りは2。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "plan") {
    console.error(USAGE);
    return 2;
  }
  const parsed = parsePlanArgs(rest);
  if (!parsed.ok) {
    console.error(`host-apply: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await buildPlan(
      createPlanGit((args) => runGit(parsed.args.repo, args)),
      {
        applied: parsed.args.applied,
        target: parsed.args.target,
        approved: parsed.args.approved,
        root: LOGICAL_ROOT,
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    console.error(
      `host-apply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
