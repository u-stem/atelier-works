// merge-guardが、保留の表と凍結の変数を読む部品。
// 読むのは、有効なマージの保留と、deployの保留・スケジュールの凍結(変数`f/factory/freezes`)だけで、
// 書き込む関数は読み込まない。
// 依存はすべて保護パスに置く。保護の外のモジュール(ログの部品など)には依存せず、必要な最小の処理は、ここに持つ。
//
// 読む経路は、リポジトリの根の`mise exec -C <根> --`で包んだ子プロセスである。
// composeが`mise`の環境変数(`DB_PASSWORD`など)を要し、`wmill`も`mise`のツールだからである。
// 子の環境では、`mise`のツールの自動インストールを止める。読みのためにネットワークへ出ないためで、
// ツールが入っていなければコマンドが見つからず、読めないものとして扱われる。
//
// 子プロセスは新しいプロセスグループで起動し、上限に達したらグループごと終了する。
// `mise`と`docker`の孫が標準出力を握り続けても、子が終われば、またはグループを終了すれば、結果を返す。
// bunとnodeのどちらでも動くよう、`Bun.*`と`import.meta.dir`は使わない。

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActiveDeployFreeze } from "../../f/factory/lib/freeze_apply.ts";
import {
  activeDeployFreezes,
  activeFreezes,
  parseFreezeState,
} from "../../f/factory/lib/freezes.ts";
import {
  type HoldReadOutcome,
  type HoldRow,
  listActiveHolds,
} from "../../f/factory/lib/holds.ts";
import { wmillCliPorts } from "../freeze.ts";
import { HOLD_DATABASE } from "../hold.ts";
import {
  createHoldPsqlClient,
  type HoldPsqlRequest,
  type HoldPsqlResult,
  type HoldPsqlRun,
} from "../hold_psql.ts";

/** 読み1回の全体の上限(ミリ秒)。 */
export const READ_TIMEOUT_MS = 6000;

/**
 * 起動してまだ終わっていない子のプロセスグループ。
 * フックはプロセスを終了する前に、これらを終了する。読みが終わる前に拒否を決めても、子を残さないためである。
 */
const liveGroups = new Set<number>();

process.on("exit", () => {
  for (const group of liveGroups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // グループがすでに無ければ、止める相手がいない。
    }
  }
});

/** 子が終わってから、標準出力と標準エラーが閉じるのを待つ時間(ミリ秒)。 */
const STREAM_GRACE_MS = 250;

/** `mise`を探す場所。PATHに無いときの備えで、GUIから起動したセッションはPATHが短いことがある。 */
const HOMEBREW_MISE = "/opt/homebrew/bin/mise";
const USR_LOCAL_MISE = "/usr/local/bin/mise";

/** 子のPATHに足す場所。`docker`が入る場所を、PATHが短い環境でも見つけられるようにする。 */
const EXTRA_PATH_DIRS: readonly string[] = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
];

/** 子の環境で止める、`mise`のツールの自動インストール。 */
const AUTO_INSTALL_SETTINGS: readonly string[] = [
  "MISE_AUTO_INSTALL",
  "MISE_EXEC_AUTO_INSTALL",
  "MISE_NOT_FOUND_AUTO_INSTALL",
  "MISE_TASK_RUN_AUTO_INSTALL",
];

/**
 * 形式だけで見分けられる秘密値(GitHubとAnthropicのトークン、DiscordのWebhook URL)。
 * 子の標準エラーは拒否の文言に載りうるので、載せる前に伏せる。
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  /sk-ant-oat[A-Za-z0-9_-]{10,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
];

/** 名前に`PASSWORD`、`TOKEN`、`SECRET`、`KEY`を含む代入(`=`と`:`、空白、引用符つきの値を含む)。値を伏せる。 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi;

/** 制御文字、書式文字、行と段落の区切り。 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function maskSecrets(text: string): string {
  let masked = text.replace(SECRET_ASSIGNMENT, "$1=***");
  for (const pattern of TOKEN_PATTERNS) masked = masked.replace(pattern, "***");
  return masked;
}

const MISE_MISSING =
  "mise was not found, so the holds cannot be read; install mise or start the session from a shell that has it";

export type ReadOptions = {
  /** リポジトリの根。`mise exec -C`の対象で、composeのファイルの置き場でもある。 */
  readonly root: string;
  /** `mise`の実行ファイル。見つからなければnull。 */
  readonly mise: string | null;
  /** 子プロセスを起動する関数。引数の先頭はすでに`mise exec`で包んである。 */
  readonly run: HoldPsqlRun;
  readonly now?: () => Date;
};

export type MergeHoldReading = HoldReadOutcome<readonly HoldRow[]>;

export type FreezeReading =
  | {
      readonly ok: true;
      readonly deploy: readonly ActiveDeployFreeze[];
      /** 有効なスケジュールの凍結の件数。 */
      readonly schedule: number;
    }
  | { readonly ok: false; readonly reason: string };

export type ChildRequest = HoldPsqlRequest & {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** `mise`の実行ファイルを探す。PATH、次に決まった場所、`$HOME/.local/bin`の順に見る。 */
export function findMise(
  env: Readonly<Record<string, string | undefined>>,
  isExecutable: (path: string) => boolean,
): string | null {
  const home = env.HOME;
  const candidates = [
    ...(env.PATH ?? "")
      .split(":")
      .filter((dir) => dir !== "")
      .map((dir) => join(dir, "mise")),
    HOMEBREW_MISE,
    ...(home === undefined || home === ""
      ? []
      : [join(home, ".local/bin/mise")]),
    USR_LOCAL_MISE,
  ];
  return candidates.find(isExecutable) ?? null;
}

/** 実行できる通常のファイルなら真。 */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 子に渡す環境変数。PATHに`docker`の置き場所を足し、`mise`の自動インストールを止める。 */
export function buildChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const dirs = (env.PATH ?? "").split(":").filter((dir) => dir !== "");
  for (const dir of EXTRA_PATH_DIRS) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  const stopped = Object.fromEntries(
    AUTO_INSTALL_SETTINGS.map((name) => [name, "0"]),
  );
  return { ...env, PATH: dirs.join(":"), ...stopped };
}

/** このモジュールのURLから、リポジトリの根を求める(`scripts/claude-hooks/`の2つ上)。 */
export function rootOf(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}

/**
 * 子プロセスを起動して、標準入力を渡し、終了を待つ。
 * 子は新しいプロセスグループに入れ、`timeoutMs`に達したか、結果が決まったら、グループごと終了する。
 * 結果は、子の終了の後に標準出力と標準エラーが閉じるのを短く待って返す。孫が出力を握り続けても、`close`は待たない。
 * 起動できなければ(`ENOENT`など)例外を投げる。標準エラーは、秘密値を伏せて返す。
 */
export function runChild(request: ChildRequest): Promise<HoldPsqlResult> {
  return new Promise((settle, fail) => {
    const [program, ...args] = request.argv;
    if (program === undefined) {
      fail(new Error("no program to run"));
      return;
    }
    const child = spawn(program, args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.env === undefined ? {} : { env: request.env }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let exitCode: number | null | undefined;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    if (child.pid !== undefined) liveGroups.add(child.pid);
    const stopGroup = (): void => {
      if (child.pid === undefined) return;
      liveGroups.delete(child.pid);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // グループがすでに無ければ、止める相手がいない。
      }
    };
    const collect = (): HoldPsqlResult => ({
      exitCode: exitCode ?? null,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: maskSecrets(Buffer.concat(err).toString("utf8")),
      timedOut: false,
    });
    const finish = (outcome: HoldPsqlResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      stopGroup();
      settle(outcome);
    };
    timer = setTimeout(() => {
      finish({ ...collect(), exitCode: null, timedOut: true });
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.on("error", () => {
      // 子が入力を読まずに終わっても、結果は終了コードで決まる。
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      stopGroup();
      fail(error);
    });
    child.on("exit", (code) => {
      exitCode = code;
      grace = setTimeout(() => finish(collect()), STREAM_GRACE_MS);
    });
    child.on("close", (code) => {
      exitCode = code;
      finish(collect());
    });
    child.stdin.end(request.stdin);
  });
}

function misePrefix(options: ReadOptions): readonly string[] {
  return [options.mise ?? "", "exec", "-C", options.root, "--"];
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(UNSAFE_CHARS, " ").slice(0, 200);
}

/**
 * 有効なマージの保留を、すべて読む。リポジトリでの絞り込みは呼び出し側が行う。
 * 失敗は、保留なしにせず、失敗の種類つきで返す。
 */
export async function readMergeHolds(
  options: ReadOptions,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  if (options.mise === null) {
    return { ok: false, kind: "read_failed", reason: MISE_MISSING };
  }
  const prefix = misePrefix(options);
  const client = createHoldPsqlClient({
    composeFile: join(options.root, "infra/docker-compose.yml"),
    database: HOLD_DATABASE,
    mode: "read",
    timeoutMs: READ_TIMEOUT_MS,
    run: (request) =>
      options.run({ ...request, argv: [...prefix, ...request.argv] }),
  });
  return await listActiveHolds({ scope: "merge" }, client);
}

/**
 * 凍結の変数を読み、有効なdeployの保留と、有効なスケジュールの凍結の件数を返す。
 * 変数が無いと確かめられたときだけ、凍結なしとする。読めない、壊れているときは失敗を返す。
 * 取得に失敗すると一覧も呼ぶので、2回の呼び出しの合計が上限に収まるようにする。
 */
export async function readDeployFreezes(
  options: ReadOptions,
): Promise<FreezeReading> {
  if (options.mise === null) return { ok: false, reason: MISE_MISSING };
  const prefix = misePrefix(options);
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const ports = wmillCliPorts(async (argv) => {
    const remaining = READ_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error("wmill timed out");
    const finished = await options.run({
      argv: [...prefix, ...argv],
      stdin: "",
      timeoutMs: remaining,
    });
    if (finished.timedOut) throw new Error("wmill timed out");
    return {
      exitCode: finished.exitCode ?? -1,
      stdout: finished.stdout,
      stderr: finished.stderr,
    };
  }, now);
  try {
    const state = parseFreezeState(await ports.readVariable(), now());
    if (!state.ok) return { ok: false, reason: describeError(state.reason) };
    return {
      ok: true,
      deploy: activeDeployFreezes(state.value, now()).map(
        ({ id, expires_at }) => ({ id, expires_at }),
      ),
      schedule: activeFreezes(state.value, now()).length,
    };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

/** 実際のプロセスを起動する読みの設定。`moduleUrl`は呼び出し側のモジュールのURL(`import.meta.url`)である。 */
export function defaultReadOptions(
  moduleUrl: string,
  env: Readonly<Record<string, string | undefined>>,
): ReadOptions {
  const root = rootOf(moduleUrl);
  const childEnv = buildChildEnv(env);
  return {
    root,
    mise: findMise(env, isExecutableFile),
    run: (request) => runChild({ ...request, cwd: root, env: childEnv }),
  };
}
