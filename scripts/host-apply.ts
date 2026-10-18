/**
 * ホストの実行役の入口。サブコマンドは`plan`と`approve`。
 * `plan`は、引数の`--repo`のリポジトリから、gitのオブジェクトを読み取り、判定をJSONで出力する。
 * `approve`は、人が端末で`origin/main`のコミットを承認し、承認の記録を書く。
 * どちらも、作業ツリーの変更とネットワークは使わない。子プロセスは読み取りのgitだけ。
 * このファイルと`scripts/host_apply/`は、NodeとBunの組み込みと`scripts/host_apply/`の中だけをimportする。
 * 状態ディレクトリの`bin/`へコピーして、リポジトリの外で単独で動かすため。
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createApproveGit,
  EXIT_USAGE,
  parseApproveArgs,
  runApprove,
} from "./host_apply/approve.ts";
import { readApproved, writeApproved } from "./host_apply/approved_io.ts";
import { checkCodeOrigin } from "./host_apply/code_origin.ts";
import { COMMAND_TIMEOUT_MS } from "./host_apply/constants.ts";
import { buildChildEnv } from "./host_apply/env.ts";
import { approveGitEnv } from "./host_apply/git.ts";
import { buildPlan, parsePlanArgs } from "./host_apply/plan.ts";
import { createPlanGit, type GitRunner } from "./host_apply/plan_git.ts";

const USAGE = [
  "usage: host-apply plan --repo <path> --applied <sha> --target <sha> [--approved <sha> | --state-dir <abs path>]",
  "       bun --no-env-file ./scripts/host-apply.ts approve <sha> --applied <sha> [--state-dir <abs path>]",
].join("\n");

/** ステージングのルートの論理的なパス。パスの内外の判定にだけ使い、実在しなくてよい。 */
const LOGICAL_ROOT = "/staging";

/** `approve`が使うgitの絶対パス。`PATH`の偽物を拾わないため。 */
const APPROVE_GIT = "/usr/bin/git";

/** 差分以外のgitの出力の上限(バイト)。超えたら例外にする。 */
const RUN_OUTPUT_LIMIT = 64 * 1024 * 1024;

/** 承認の記録の既定の置き場。`HOME`の下の、アプリケーションサポートの中。 */
const DEFAULT_STATE_DIR = "Library/Application Support/atelier-works-host";

type GitSpec = {
  readonly bin: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
};

type GitOutput = {
  readonly code: number;
  readonly stdout: string;
  /** 標準出力が上限を超え、プロセスを止めたか。 */
  readonly truncated: boolean;
};

/**
 * gitを実行する。引数は配列で渡し、シェルを経由しない。
 * 標準出力が`maxBytes`を超えたら、プロセスを止めて`truncated`にする。
 * 時間切れなどで止められたときは、失敗の結果ではなく例外にする。
 */
async function spawnGit(
  spec: GitSpec,
  args: string[],
  maxBytes: number,
): Promise<GitOutput> {
  const proc = Bun.spawn([spec.bin, ...args], {
    cwd: spec.cwd,
    env: spec.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: COMMAND_TIMEOUT_MS.git_read,
    killSignal: "SIGKILL",
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of proc.stdout) {
    total += chunk.length;
    if (total > maxBytes) {
      truncated = true;
      proc.kill("SIGKILL");
      break;
    }
    chunks.push(chunk);
  }
  const code = await proc.exited;
  if (!truncated && proc.signalCode !== null) {
    throw new Error("git command was killed");
  }
  return { code, stdout: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** 読み取りだけのgitを`repo`で実行する。環境は許可リストで作る。 */
async function runGit(
  repo: string,
  args: string[],
): Promise<{ readonly code: number; readonly stdout: string }> {
  const { code, stdout } = await spawnGit(
    {
      bin: "git",
      cwd: repo,
      env: buildChildEnv("git", {
        path: process.env.PATH ?? "/usr/bin:/bin",
        home: process.env.HOME ?? "/",
        values: {},
      }),
    },
    args,
    Number.POSITIVE_INFINITY,
  );
  return { code, stdout };
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

export function formatFailure(error: unknown): string {
  return "host-apply: unknown error";
}

async function runPlan(rest: readonly string[]): Promise<number> {
  const parsed = parsePlanArgs(rest);
  if (!parsed.ok) {
    console.error(`host-apply: ${parsed.error}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  try {
    const approval = loadApproval(parsed.args.stateDir, parsed.args.approved);
    const result = await buildPlan(
      createPlanGit((args) => runGit(parsed.args.repo, args)),
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
    console.error(
      `host-apply: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

async function runApproveCommand(rest: readonly string[]): Promise<number> {
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
  const spec: GitSpec = {
    bin: APPROVE_GIT,
    cwd: repoRoot,
    env: approveGitEnv(),
  };
  const run: GitRunner = async (args) => {
    const output = await spawnGit(spec, args, RUN_OUTPUT_LIMIT);
    if (output.truncated) throw new Error("git output is too large");
    return { code: output.code, stdout: output.stdout };
  };
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
      git: createApproveGit(run, (args, maxBytes) =>
        spawnGit(spec, args, maxBytes),
      ),
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

/**
 * 実行役の入口。終了コードを返す。
 * 判定が出れば0、実行の失敗(コミットが無い、gitの失敗など)は1、使い方の誤りは2。
 * `approve`の終了コードは、承認しないときが3(`approve.ts`を参照)。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "plan") return runPlan(rest);
  if (command === "approve") return runApproveCommand(rest);
  console.error(USAGE);
  return EXIT_USAGE;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
