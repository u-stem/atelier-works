// 検査コマンドを、workerのrootではなく非特権のuidで動かすための部品。
// argvと環境変数の組み立て、worktreeの所有権の受け渡し、残ったプロセスの後始末を、
// 副作用の無い関数と、注入できる依存に分けて持つ。
// 検査コマンドは信頼できない対象リポジトリのコードなので、workerの秘密(環境変数、
// トークンのファイル)に届かず、書き込める場所をworktreeとそのHOMEと`/tmp`に限る。

import { readFileSync } from "node:fs";
import { chmod, lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { maskSecrets } from "./log.ts";
import { type CommandRunner, runCommand } from "./workspace.ts";

/** イメージの`factory-check`のuid。`FACTORY_CHECK_UID`が無いときの値で、`infra/worker/Dockerfile`の既定と同じ。 */
export const DEFAULT_CHECK_UID = 10001;

/** 検査用のuidを上書きする環境変数の名前。イメージのビルド引数と同じ名前で、`mise.toml`の`[env]`が値を持つ。 */
export const CHECK_UID_ENV_NAME = "FACTORY_CHECK_UID";

/** イメージが作る、検査コマンド用のユーザーの名前。 */
export const CHECK_USER_NAME = "factory-check";

/** 一般のユーザーのuidの下限。rootやシステムのユーザーに切り替える設定を拒む。 */
const MIN_CHECK_UID = 1000;
/** uid_tの符号付き32ビットの上限。`-1`(uid_tの最大値)と区別できる範囲に収める。 */
const MAX_CHECK_UID = 2 ** 31 - 1;

/**
 * 実行ごとの目印にする補助グループのgidの範囲。実在するグループと重ならない大きな値にする。
 * 補助グループは子孫に受け継がれ、検査用のuidが自分では外せない(`CAP_SETGID`を落とす)。
 * 同じuidの別の実行と区別して、この実行のプロセスだけを止めるために使う。
 */
const TAG_GID_MIN = 1_000_000;
const TAG_GID_MAX = 2_000_000_000;

/** PATHに頼らず、絶対パスで呼ぶ道具。イメージでは`util-linux`と`findutils`、`coreutils`が入れる。 */
export const SETPRIV_PATH = "/usr/bin/setpriv";
export const FIND_PATH = "/usr/bin/find";
export const CHOWN_PATH = "/usr/bin/chown";

/**
 * Windmillの実行時のディレクトリ。依存のキャッシュ(`cache`)とログ(`logs`)が、
 * 誰でも書き込める(0777)権限で作られる。
 * rootのworkerが後で実行するバンドルを検査用のuidに差し替えられないよう、
 * 検査の前に所有者以外が入れない権限にする。
 */
export const WINDMILL_TMP_DIR = "/tmp/windmill";

/** 所有権の受け渡しにかける時間の上限(ミリ秒)。`node_modules`が大きいworktreeでも収まる値にする。 */
const CHOWN_TIMEOUT_MS = 300_000;
const CHOWN_MAX_OUTPUT_BYTES = 16 * 1024;
/** 所有権の受け渡しに使う道具が見つかるPATH。実行ファイルは絶対パスで呼ぶので、`find -exec`の補助でしかない。 */
const TOOL_PATH = "/usr/bin:/bin";

const REAP_ROUNDS = 5;
const REAP_POLL_MS = 100;

/**
 * 検査用のuidの設定値を検証して返す。値が無いか空なら既定値を返す。
 * 10進の整数で、1000以上、符号付き32ビットの範囲に限る。rootへの切り替えを許さないためである。
 */
export function parseCheckUid(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CHECK_UID;
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new Error(`${CHECK_UID_ENV_NAME} must be a decimal integer: ${raw}`);
  }
  const uid = Number(raw);
  if (uid < MIN_CHECK_UID || uid > MAX_CHECK_UID) {
    throw new Error(
      `${CHECK_UID_ENV_NAME} must be between ${String(MIN_CHECK_UID)} and ${String(MAX_CHECK_UID)}: ${raw}`,
    );
  }
  return uid;
}

export type CheckIdentity = {
  readonly uid: number;
  /** 主グループ。uidと同じ値にする(イメージの`factory-check`のグループ)。 */
  readonly gid: number;
  /** この実行の補助グループ。プロセスの目印で、実行ごとに違う値にする。 */
  readonly tagGid: number;
};

/** 検査用のuidに、この実行の目印のgidを付けた識別子を作る。 */
export function newCheckIdentity(
  uid: number,
  random: () => number = Math.random,
): CheckIdentity {
  const span = TAG_GID_MAX - TAG_GID_MIN;
  return {
    uid,
    gid: uid,
    tagGid: TAG_GID_MIN + Math.floor(random() * span),
  };
}

/**
 * `argv`を、検査用のuidに落として実行するargvにする。
 * uidとgidを切り替え、補助グループを目印の1つだけにし、ケーパビリティの上限と継承を空にし、
 * `no_new_privs`を立てる。setuidのバイナリやファイルのケーパビリティで特権を戻せなくするためである。
 * `--`の後は`setpriv`のオプションとして解釈されない。
 */
export function setprivArgv(
  identity: CheckIdentity,
  argv: readonly string[],
): string[] {
  return [
    SETPRIV_PATH,
    `--reuid=${String(identity.uid)}`,
    `--regid=${String(identity.gid)}`,
    `--groups=${String(identity.tagGid)}`,
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--no-new-privs",
    "--",
    ...argv,
  ];
}

/**
 * 検査コマンドに渡す環境変数の名前の許可リスト。
 * ここに無い変数は、workerがどれほど持っていても渡さない。
 */
export const CHECK_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
] as const;

/**
 * 検査コマンドの環境変数を、許可リストから組み立てる。workerの環境変数は読まない。
 * gitはworktreeの所有者が自分と違うと実行を拒むので、検査用のuidが読む`.git`が
 * rootのままでも動くよう、そのworktreeだけを`safe.directory`にする。
 * コマンドラインと同じ階層の設定で、リポジトリの設定ファイルには書けない。
 */
export function checkEnv(input: {
  readonly path: string;
  readonly home: string;
  readonly worktreeDir: string;
}): Record<string, string> {
  return {
    PATH: input.path,
    HOME: input.home,
    LANG: "C.UTF-8",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: input.worktreeDir,
  };
}

/**
 * 所有権を変えてよいディレクトリかを確かめる。
 * 正規化された絶対パスで、最上位の1段ではないものに限る。`/`や`/workspaces`のような広い範囲を誤って渡さないためである。
 */
function assertChownableDir(dir: string): void {
  const segments = dir.split("/").filter((part) => part !== "");
  if (!isAbsolute(dir) || resolve(dir) !== dir || segments.length < 2) {
    throw new Error(`refusing to change ownership of: ${dir}`);
  }
}

/**
 * `dir`の下の、rootが所有するものを検査用のuidに渡すargv。
 * `find -P`はsymlinkをたどらず、`chown -h`はsymlink自身を変える。リンクの先の所有者は変わらない。
 * `-xdev`でほかのマウントに入らない。`--from=0:0`でrootのものだけを変える。
 * ハードリンクが2つ以上あるファイルは渡さない。worktreeの外へのリンクが、
 * 検査用のuidの所有に変わらないようにするためである。
 */
export function chownToArgv(identity: CheckIdentity, dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "(",
    "-type",
    "d",
    "-o",
    "-links",
    "1",
    ")",
    "-exec",
    CHOWN_PATH,
    "-h",
    "--from=0:0",
    `${String(identity.uid)}:${String(identity.gid)}`,
    "{}",
    "+",
  ];
}

/** `dir`の下の、検査用のuidが所有するものをrootに戻すargv。検査の間にできたファイルもすべて戻す。 */
export function chownBackArgv(identity: CheckIdentity, dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "-exec",
    CHOWN_PATH,
    "-h",
    `--from=${String(identity.uid)}`,
    "0:0",
    "{}",
    "+",
  ];
}

export type ProcStatus = {
  /** プロセスの状態の1文字(`R` / `S` / `Z`など)。 */
  readonly state: string;
  /** 実uid。 */
  readonly uid: number;
  /** 補助グループ。主グループは含まない。 */
  readonly groups: readonly number[];
};

/**
 * `/proc/<pid>/status`を解析する。このファイルは所有者以外も読める。
 * `Uid`の行が無いか形が違えばnullを返す。
 */
export function parseProcStatus(text: string): ProcStatus | null {
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(text)?.[1];
  const uidField = field("Uid")?.split(/\s+/)[0];
  if (uidField === undefined || !/^\d+$/.test(uidField)) return null;
  const state = field("State")?.trim().charAt(0) ?? "";
  const groupsField = field("Groups")?.trim() ?? "";
  const groups =
    groupsField === ""
      ? []
      : groupsField.split(/\s+/).map((part) => Number(part));
  if (groups.some((group) => !Number.isInteger(group))) return null;
  return { state, uid: Number(uidField), groups };
}

/** この実行が起動した検査用のプロセス(実uidが検査用で、目印のgidを持つ生きたもの)かを返す。 */
export function isTaggedProcess(
  status: ProcStatus,
  identity: CheckIdentity,
): boolean {
  return (
    status.state !== "Z" &&
    status.uid === identity.uid &&
    status.groups.includes(identity.tagGid)
  );
}

export type ReapDeps = {
  /** `/proc`の下のpidの一覧。 */
  readonly listPids: () => Promise<readonly number[]>;
  /** `/proc/<pid>/status`の本文。プロセスが無ければnull。 */
  readonly readStatus: (pid: number) => Promise<string | null>;
  /** SIGKILLを送る。既に無いプロセスへの失敗は呼び出し側で無視する。 */
  readonly kill: (pid: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
};

async function taggedPids(
  identity: CheckIdentity,
  deps: ReapDeps,
): Promise<number[]> {
  const found: number[] = [];
  for (const pid of await deps.listPids()) {
    const text = await deps.readStatus(pid);
    const status = text === null ? null : parseProcStatus(text);
    if (status !== null && isTaggedProcess(status, identity)) found.push(pid);
  }
  return found;
}

/**
 * この実行の目印を持つプロセスをすべてSIGKILLで止め、止まらずに残ったpidを返す。
 * 検査のコマンドは新しいセッションに抜けても補助グループを受け継ぐので、
 * プロセスグループへのkillが届かない子孫も止められる。
 * 検査用のuidの全プロセスを止める`pkill -u`と違い、並行して動く別の実行の検査を巻き込まない。
 * 殺す直前にもう一度状態を読み、pidが別のプロセスに再利用されていないことを確かめる。
 * 止めた直後に子孫が増えうるので、何も見つからなくなるまで最大`REAP_ROUNDS`回くり返す。
 */
export async function reapCheckProcesses(
  identity: CheckIdentity,
  deps: ReapDeps,
): Promise<number[]> {
  for (let round = 0; round < REAP_ROUNDS; round += 1) {
    const pids = await taggedPids(identity, deps);
    if (pids.length === 0) return [];
    for (const pid of pids) {
      const text = await deps.readStatus(pid);
      const status = text === null ? null : parseProcStatus(text);
      if (status !== null && isTaggedProcess(status, identity)) deps.kill(pid);
    }
    await deps.sleep(REAP_POLL_MS);
  }
  return taggedPids(identity, deps);
}

export type CheckDirs = {
  /** 検査を実行するworktree。 */
  readonly worktreeDir: string;
  /** 検査コマンドのHOME。実行ごとに新しく作る非公開のディレクトリ。 */
  readonly homeDir: string;
};

export type CheckSandboxDeps = {
  /** rootで実行するコマンドのランナー。所有権の受け渡しに使う。ロックは付けない。 */
  readonly run: CommandRunner;
  readonly reap: ReapDeps;
  /** Windmillの実行時のディレクトリに、所有者以外が入れないようにする。 */
  readonly lockDownRuntimeDir: (dir: string) => Promise<void>;
  /** `path`が、symlinkでない実在のディレクトリであることを確かめる。違えば例外を投げる。 */
  readonly assertDirectory: (path: string) => Promise<void>;
};

export type CheckSandbox = {
  readonly identity: CheckIdentity;
  /** 検査コマンドのargvを、検査用のuidで実行するargvにする。 */
  readonly wrap: (argv: readonly string[]) => string[];
  /** 検査の前に1回。Windmillの実行時のディレクトリを閉じ、worktreeとHOMEを検査用のuidに渡す。 */
  readonly prepare: (dirs: CheckDirs) => Promise<void>;
  /** コマンド1つの後に。目印を持つプロセスを止める。止められなければ例外を投げる。 */
  readonly settle: () => Promise<void>;
  /** 検査の後に1回。残りを止め、止まったことを確かめてから所有権をrootに戻す。 */
  readonly release: (dirs: CheckDirs) => Promise<void>;
};

async function runChown(
  deps: CheckSandboxDeps,
  argv: string[],
  what: string,
): Promise<void> {
  const result = await deps.run(argv, {
    env: { PATH: TOOL_PATH },
    timeoutMs: CHOWN_TIMEOUT_MS,
    maxOutputBytes: CHOWN_MAX_OUTPUT_BYTES,
  });
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail = maskSecrets(result.stderr.trim());
  throw new Error(
    `check sandbox: ${what} failed (exit ${String(result.exitCode)}${result.timedOut ? ", timed out" : ""}): ${detail}`,
  );
}

async function reapOrThrow(
  identity: CheckIdentity,
  deps: CheckSandboxDeps,
): Promise<void> {
  const remaining = await reapCheckProcesses(identity, deps.reap);
  if (remaining.length > 0) {
    throw new Error(
      `check sandbox: processes of the check user could not be stopped: pid ${remaining.join(", ")}`,
    );
  }
}

/**
 * 検査用のuidで実行するための部品をまとめて返す。
 * 所有権の受け渡しは`prepare`と`release`の対で行い、`release`はプロセスが残っている間は
 * 所有権を戻さない(生きている検査のプロセスが、戻した後のworktreeを書き換えうるため)。
 */
export function createCheckSandbox(opts: {
  readonly uid: number;
  readonly deps?: CheckSandboxDeps;
  readonly random?: () => number;
}): CheckSandbox {
  const deps = opts.deps ?? defaultSandboxDeps();
  const identity = newCheckIdentity(opts.uid, opts.random);
  return {
    identity,
    wrap: (argv) => setprivArgv(identity, argv),
    prepare: async (dirs) => {
      await deps.lockDownRuntimeDir(WINDMILL_TMP_DIR);
      await deps.assertDirectory(dirs.worktreeDir);
      await runChown(
        deps,
        chownToArgv(identity, dirs.worktreeDir),
        "handing the worktree over",
      );
      await runChown(
        deps,
        chownToArgv(identity, dirs.homeDir),
        "handing the home directory over",
      );
    },
    settle: () => reapOrThrow(identity, deps),
    release: async (dirs) => {
      await reapOrThrow(identity, deps);
      await runChown(
        deps,
        chownBackArgv(identity, dirs.worktreeDir),
        "taking the worktree back",
      );
      await runChown(
        deps,
        chownBackArgv(identity, dirs.homeDir),
        "taking the home directory back",
      );
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function defaultSandboxDeps(): CheckSandboxDeps {
  return {
    run: runCommand,
    reap: {
      listPids: async () =>
        (await readdir("/proc"))
          .filter((name) => /^\d+$/.test(name))
          .map((name) => Number(name)),
      readStatus: async (pid) => {
        try {
          return await readFile(`/proc/${String(pid)}/status`, "utf8");
        } catch {
          return null;
        }
      },
      kill: (pid) => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 既に終わっている。
        }
      },
      sleep: (ms) => Bun.sleep(ms),
    },
    lockDownRuntimeDir: async (dir) => {
      try {
        await chmod(dir, 0o700);
      } catch (error) {
        // workerのイメージの外(開発機)では、ディレクトリが無い。
        if (!isNotFound(error)) throw error;
      }
    },
    assertDirectory: async (path) => {
      const found = await lstat(path);
      if (!found.isDirectory()) {
        throw new Error(`check sandbox: not a plain directory: ${path}`);
      }
    },
  };
}

/**
 * `/etc/passwd`の本文から、`name`のユーザーのuidを返す。無いか、uidが数でなければnullを返す。
 */
export function parsePasswdUid(passwd: string, name: string): number | null {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name) continue;
    const uid = fields[2];
    return uid !== undefined && /^\d+$/.test(uid) ? Number(uid) : null;
  }
  return null;
}

/**
 * 検査用のuidを決める。環境変数`FACTORY_CHECK_UID`があればそれを使い、無ければ
 * イメージが作った`factory-check`のuidを`/etc/passwd`から読み、それも無ければ既定値を使う。
 * Windmillのジョブには、workerの環境変数がほとんど渡らない(`WM_*`、`PATH`、`HOME`など)ので、
 * イメージのビルドで決まるuidは、passwdから読んで同じ値にそろえる。
 * 値が不正(rootを含む)なら例外を投げ、rootのまま検査を実行することはしない。
 */
export function resolveCheckUid(
  env: Readonly<Record<string, string | undefined>>,
  readPasswd: () => string,
): number {
  const configured = env[CHECK_UID_ENV_NAME];
  if (configured !== undefined && configured !== "") {
    return parseCheckUid(configured);
  }
  let found: number | null = null;
  try {
    found = parsePasswdUid(readPasswd(), CHECK_USER_NAME);
  } catch {
    // workerのイメージの外(開発機)では、passwdにユーザーが無い。
  }
  return found === null ? DEFAULT_CHECK_UID : parseCheckUid(String(found));
}

/** 本番の検査用の部品を作る。uidは`resolveCheckUid`で決める。 */
export function checkSandboxFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CheckSandbox {
  return createCheckSandbox({
    uid: resolveCheckUid(env, () => readFileSync("/etc/passwd", "utf8")),
  });
}
