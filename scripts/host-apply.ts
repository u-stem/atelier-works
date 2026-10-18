/**
 * ホストの実行役の入口。サブコマンドは`plan`と`approve`。
 * `plan`は、引数の`--repo`のリポジトリから、gitのオブジェクトを読み取り、判定をJSONで出力する。
 * `approve`は、人が端末で`origin/main`のコミットを承認し、承認の記録を書く。
 * どちらも、作業ツリーの変更と取得(fetch)の経路を持たない。子プロセスは読み取りのgitだけで、実行口を通す。
 * このファイルと`scripts/host_apply/`は、NodeとBunの組み込みと`scripts/host_apply/`の中だけをimportする。
 * 状態ディレクトリの`bin/`へコピーして、リポジトリの外で単独で動かすため。
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createApproveGit,
  EXIT_USAGE,
  type LimitedGitRunner,
  parseApproveArgs,
  runApprove,
} from "./host_apply/approve.ts";
import { readApproved, writeApproved } from "./host_apply/approved_io.ts";
import { checkCodeOrigin } from "./host_apply/code_origin.ts";
import { CommandError, type CommandRunner } from "./host_apply/command.ts";
import { buildPlan, parsePlanArgs } from "./host_apply/plan.ts";
import { createPlanGit, type GitRunner } from "./host_apply/plan_git.ts";
import { gitReadSpec } from "./host_apply/run_git.ts";
import { createRunner } from "./host_apply/spawn_runner.ts";
import { escapeDetail } from "./host_apply/stable.ts";

const USAGE = [
  "usage: host-apply plan --repo <path> --applied <sha> --target <sha> [--approved <sha> | --state-dir <abs path>]",
  "       bun --no-env-file ./scripts/host-apply.ts approve <sha> --applied <sha> [--state-dir <abs path>]",
].join("\n");

/** ステージングのルートの論理的なパス。パスの内外の判定にだけ使い、実在しなくてよい。 */
const LOGICAL_ROOT = "/staging";

/** 承認の記録の既定の置き場。`HOME`の下の、アプリケーションサポートの中。 */
const DEFAULT_STATE_DIR = "Library/Application Support/atelier-works-host";

/**
 * `git_read`の種類だけを通す実行口にする。
 * この入口が使うのは読み取りのgitだけなので、取得や`host_probe`の指定が紛れ込んでも起動しない。
 */
export function readOnlyRunner(runner: CommandRunner): CommandRunner {
  return async (spec, opts) => {
    if (spec.kind !== "git_read") throw new CommandError("invalid_spec");
    return runner(spec, opts);
  };
}

/**
 * 読み取りのgitを`cwd`で実行する関数にする。
 * 標準出力が上限を超えたときは、終了コードが0でも失敗にする。切れた出力を判定に使わないため。
 */
export function createGitRunner(runner: CommandRunner, cwd: string): GitRunner {
  return async (args) => {
    const result = await runner(gitReadSpec(args, { cwd }));
    if (result.kind === "truncated") throw new Error("git output is too large");
    // 読み取りは溢れたら止める種類だが、表が変わっても切れた出力を成功にしない。
    if (result.stdoutDropped) throw new Error("git output was cut short");
    return { code: result.code, stdout: result.stdout };
  };
}

/** 標準出力の上限を指定できる、読み取りのgitの実行。上限を超えたときは`truncated`で返す。 */
export function createLimitedRunner(
  runner: CommandRunner,
  cwd: string,
): LimitedGitRunner {
  return async (args, maxBytes) => {
    const result = await runner(
      gitReadSpec(args, { cwd, maxStdoutBytes: maxBytes }),
    );
    if (result.kind === "truncated") return { truncated: true };
    if (result.stdoutDropped) throw new Error("git output was cut short");
    return { truncated: false, code: result.code, stdout: result.stdout };
  };
}

/**
 * `plan`に渡す承認を決める。
 * `--state-dir`があれば、置き場の記録を読む。記録が無ければ承認なし、壊れていれば警告を出して承認なしにする。
 * 記録が使えるかは、記録の`applied`と`--applied`が一致するかで`buildPlan`が決める。
 */
function loadApproval(
  stateDir: string | null,
  approved: string | null,
): { approved: string | null; approvedFrom?: string } {
  if (stateDir === null) return { approved };
  const read = readApproved(stateDir);
  if (read.kind === "found") {
    return { approved: read.record.sha, approvedFrom: read.record.applied };
  }
  if (read.kind === "invalid") {
    console.error(
      `host-apply: warning: approved.json is not usable (${read.reason}); treating the change as not approved`,
    );
  }
  return { approved: null };
}

/**
 * 失敗の文言を標準エラーに出す形にする。
 * 例外の文言に制御文字が入っていても、端末を操作されないよう`\uXXXX`で書く。
 */
export function formatFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : "unknown error";
  return `host-apply: ${escapeDetail(reason)}`;
}

async function runPlan(
  rest: readonly string[],
  runner: CommandRunner,
): Promise<number> {
  const parsed = parsePlanArgs(rest);
  if (!parsed.ok) {
    console.error(`host-apply: ${parsed.error}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  try {
    const approval = loadApproval(parsed.args.stateDir, parsed.args.approved);
    // 相対パスのままでは、実行口が絶対パスの作業ディレクトリを要求して失敗する。
    const repo = resolve(process.cwd(), parsed.args.repo);
    const result = await buildPlan(
      createPlanGit(createGitRunner(runner, repo)),
      {
        applied: parsed.args.applied,
        target: parsed.args.target,
        ...approval,
        root: LOGICAL_ROOT,
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    console.error(formatFailure(error));
    return 1;
  }
}

async function runApproveCommand(
  rest: readonly string[],
  runner: CommandRunner,
): Promise<number> {
  const parsed = parseApproveArgs(rest);
  if (!parsed.ok) {
    console.error(`host-apply: ${parsed.error}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  const home = process.env.HOME ?? "";
  const stateDir =
    parsed.args.stateDir ??
    (home.startsWith("/") ? resolve(home, DEFAULT_STATE_DIR) : null);
  if (stateDir === null) {
    console.error("host-apply: HOME is not an absolute path; use --state-dir");
    return EXIT_USAGE;
  }

  // スクリプト自身のリポジトリ。差分もここから読む。
  const repoRoot = resolve(import.meta.dir, "..");
  const run = createGitRunner(runner, repoRoot);
  const lines = createInterface({ input: process.stdin })[
    Symbol.asyncIterator
  ]();
  try {
    return await runApprove(parsed.args, {
      env: process.env,
      execArgv: process.execArgv,
      isTerminal: () =>
        process.stdin.isTTY === true && process.stdout.isTTY === true,
      checkOrigin: () => checkCodeOrigin({ run, repoRoot, cwd: process.cwd() }),
      git: createApproveGit(run, createLimitedRunner(runner, repoRoot)),
      readRecord: () => readApproved(stateDir),
      writeRecord: (record) => writeApproved(stateDir, record),
      now: () => new Date(),
      io: {
        print: (line) => {
          process.stdout.write(`${line}\n`);
        },
        error: (line) => {
          process.stderr.write(`${line}\n`);
        },
        readLine: async () => {
          const next = await lines.next();
          return next.done === true ? null : next.value;
        },
      },
    });
  } finally {
    await lines.return?.();
  }
}

/** 入口に注入できるもの。テストが偽の実行口を渡す。 */
export type MainDeps = { readonly runner?: CommandRunner };

/**
 * 実行役の入口。終了コードを返す。
 * 判定が出れば0、実行の失敗(コミットが無い、gitの失敗など)は1、使い方の誤りは2。
 * `approve`の終了コードは、承認しないときが3(`approve.ts`を参照)。
 */
export async function main(
  argv: readonly string[],
  deps: MainDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  const runner = readOnlyRunner(deps.runner ?? createRunner());
  if (command === "plan") return runPlan(rest, runner);
  if (command === "approve") return runApproveCommand(rest, runner);
  console.error(USAGE);
  return EXIT_USAGE;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
