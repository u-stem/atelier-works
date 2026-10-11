// 検査コマンドを、workerのrootではなく非特権のuidで動かすための部品。
// argvと環境変数の組み立て、uidの枠の取得、worktreeの所有権の受け渡し、残ったプロセスの後始末を、
// 副作用の無い関数と、注入できる依存に分けて持つ。
// 検査コマンドは信頼できない対象リポジトリのコードなので、workerの秘密(環境変数、
// トークンのファイル)に届かず、書き込める場所をworktreeとそのHOMEと`/tmp`に限る。
// 並行して動く検査どうしが同じuidを共有しないよう、実行ごとにuidの枠を1つ取る。

import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { maskSecrets } from "./log.ts";
import { type CommandRunner, runCommand } from "./workspace.ts";

/** 枠の先頭のuid。`FACTORY_CHECK_UID`が無いときの値で、`infra/worker/Dockerfile`の既定と同じ。 */
export const DEFAULT_CHECK_UID = 10001;

/** 枠の数。`FACTORY_CHECK_POOL_SIZE`が無いときの値で、`infra/worker/Dockerfile`の既定と同じ。workerの`NUM_WORKERS`以上にする。 */
export const DEFAULT_POOL_SIZE = 8;
const MAX_POOL_SIZE = 64;

/** 先頭のuidを上書きする環境変数の名前。イメージのビルド引数と同じ名前で、`mise.toml`の`[env]`が値を持つ。 */
export const CHECK_UID_ENV_NAME = "FACTORY_CHECK_UID";

/** 枠の数を上書きする環境変数の名前。 */
export const CHECK_POOL_SIZE_ENV_NAME = "FACTORY_CHECK_POOL_SIZE";

/** イメージが作る、検査コマンド用のユーザーの名前の接頭辞。`factory-check-0`、`factory-check-1`、…が枠になる。 */
export const CHECK_USER_PREFIX = "factory-check-";

/** 一般のユーザーのuidの下限。rootやシステムのユーザーに切り替える設定を拒む。 */
const MIN_CHECK_UID = 1000;
/** uid_tの符号付き32ビットの上限。`-1`(uid_tの最大値)と区別できる範囲に収める。 */
const MAX_CHECK_UID = 2 ** 31 - 1;

/**
 * 実行ごとの目印にする補助グループのgidの範囲。実在するグループと重ならない大きな値にする。
 * 補助グループは子孫に受け継がれ、検査用のuidが自分では外せない(`CAP_SETGID`を落とす)。
 * 同じ枠の前の実行が残したプロセスと区別して、この実行のプロセスだけを止めるために使う。
 */
const TAG_GID_MIN = 1_000_000;
const TAG_GID_MAX = 2_000_000_000;

/** PATHに頼らず、絶対パスで呼ぶ道具。イメージでは`util-linux`と`findutils`、`coreutils`が入れる。 */
export const SETPRIV_PATH = "/usr/bin/setpriv";
export const FIND_PATH = "/usr/bin/find";
export const CHOWN_PATH = "/usr/bin/chown";
export const CHMOD_PATH = "/usr/bin/chmod";
export const FLOCK_PATH = "/usr/bin/flock";

/**
 * Windmillの実行時のディレクトリ。依存のキャッシュ(`cache`)とログ(`logs`)が、
 * 誰でも書き込める(0777)権限で作られる。
 * rootのworkerが後で実行するバンドルを検査用のuidに差し替えられないよう、
 * 検査の前に所有者以外が入れない権限にする。
 */
export const WINDMILL_TMP_DIR = "/tmp/windmill";

/**
 * 枠のロックファイルを置くディレクトリ。永続のボリューム(`/var/lib/factory`)の下で、rootだけが入れる。
 * 検査用のuidが読めると、ロックを握って枠を塞げてしまうため。
 */
export const SLOT_LOCK_DIR = "/var/lib/factory/check-slots";

/** 枠が空くのを待つ上限(ミリ秒)。同時実行が枠の数を超えても開発を止めず、短い間隔で取り直す。 */
export const SLOT_MAX_WAIT_MS = 5 * 60_000;
/** 残った所有権を戻すとき、その枠のロックを待つ上限(ミリ秒)。 */
export const RESTORE_MAX_WAIT_MS = 5_000;
export const SLOT_POLL_MS = 2_000;

/** 枠のロックを他が持っているときの、flockの終了コード。 */
const SLOT_BUSY_EXIT_CODE = 213;
const SLOT_RELEASE_WAIT_MS = 5_000;

/** 所有権の受け渡しにかける時間の上限(ミリ秒)。`node_modules`が大きいworktreeでも収まる値にする。 */
const CHOWN_TIMEOUT_MS = 300_000;
const CHOWN_MAX_OUTPUT_BYTES = 16 * 1024;
/**
 * 所有権の受け渡しに使う道具が見つかるPATH。実行ファイルは絶対パスで呼ぶ。
 * `find -execdir`は、PATHに相対のディレクトリ(`.`や空の要素)があると実行を拒むので、絶対パスだけにする。
 */
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

/** 枠の数の設定値を検証して返す。値が無いか空なら既定値を返す。1以上`MAX_POOL_SIZE`以下の整数に限る。 */
export function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_POOL_SIZE;
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > MAX_POOL_SIZE) {
    throw new Error(
      `${CHECK_POOL_SIZE_ENV_NAME} must be an integer between 1 and ${String(MAX_POOL_SIZE)}: ${raw}`,
    );
  }
  return Number(raw);
}

export type CheckIdentity = {
  readonly uid: number;
  /** 主グループ。uidと同じ値にする(イメージの`factory-check-N`のグループ)。 */
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
 * `-execdir`は、見つけたエントリの親ディレクトリのfdを起点に、`./名前`だけを渡して実行する。
 * 列挙と変更の間に親のパスがsymlinkに差し替えられても、worktreeの外を指さないためである。
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
    "-execdir",
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
    "-execdir",
    CHOWN_PATH,
    "-h",
    `--from=${String(identity.uid)}`,
    "0:0",
    "{}",
    "+",
  ];
}

/**
 * `dir`の下の、グループとその他の書き込みと、setuid・setgidのビットを落とすargv。
 * rootに戻した後に、他の枠の検査が書き込める状態を残さない。symlinkは対象にしない。
 */
export function dropWriteBitsArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "!",
    "-type",
    "l",
    "-perm",
    "/6022",
    "-execdir",
    CHMOD_PATH,
    "go-w,ug-s",
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

async function matchingPids(
  match: (status: ProcStatus) => boolean,
  deps: ReapDeps,
): Promise<number[]> {
  const found: number[] = [];
  for (const pid of await deps.listPids()) {
    const text = await deps.readStatus(pid);
    const status = text === null ? null : parseProcStatus(text);
    if (status !== null && match(status)) found.push(pid);
  }
  return found;
}

/**
 * `match`に当たるプロセスをすべてSIGKILLで止め、止まらずに残ったpidを返す。
 * 殺す直前にもう一度状態を読み、pidが別のプロセスに再利用されていないことを確かめる。
 * 止めた直後に子孫が増えうるので、何も見つからなくなるまで最大`REAP_ROUNDS`回くり返す。
 */
async function reapMatching(
  match: (status: ProcStatus) => boolean,
  deps: ReapDeps,
): Promise<number[]> {
  for (let round = 0; round < REAP_ROUNDS; round += 1) {
    const pids = await matchingPids(match, deps);
    if (pids.length === 0) return [];
    for (const pid of pids) {
      const text = await deps.readStatus(pid);
      const status = text === null ? null : parseProcStatus(text);
      if (status !== null && match(status)) deps.kill(pid);
    }
    await deps.sleep(REAP_POLL_MS);
  }
  return matchingPids(match, deps);
}

/**
 * この実行の目印を持つプロセスをすべて止め、止まらずに残ったpidを返す。
 * 検査のコマンドは新しいセッションに抜けても補助グループを受け継ぐので、
 * プロセスグループへのkillが届かない子孫も止められる。
 */
export function reapCheckProcesses(
  identity: CheckIdentity,
  deps: ReapDeps,
): Promise<number[]> {
  return reapMatching((status) => isTaggedProcess(status, identity), deps);
}

/**
 * 枠のuidで動くプロセスをすべて止め、止まらずに残ったpidを返す。
 * 枠のロックを持っている間だけ呼ぶ。ロックが空いている枠のuidのプロセスは、終わった実行が残したものだけだからである。
 */
export function reapUidProcesses(
  uid: number,
  deps: ReapDeps,
): Promise<number[]> {
  return reapMatching(
    (status) => status.state !== "Z" && status.uid === uid,
    deps,
  );
}

/**
 * `/etc/passwd`の本文から、`<prefix><番号>`という名前のユーザーを、番号の順に返す。
 * uidが数でない行は飛ばす。
 */
export function parsePasswdUsers(
  passwd: string,
  prefix: string,
): { readonly index: number; readonly uid: number }[] {
  const found: { index: number; uid: number }[] = [];
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    const name = fields[0] ?? "";
    const uid = fields[2] ?? "";
    if (!name.startsWith(prefix) || !/^\d+$/.test(uid)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    found.push({ index: Number(suffix), uid: Number(uid) });
  }
  return found.sort((left, right) => left.index - right.index);
}

/**
 * 枠のuidの一覧を決める。環境変数`FACTORY_CHECK_UID`があれば、それから`FACTORY_CHECK_POOL_SIZE`個の連続したuidにする。
 * 無ければ、イメージが作った`factory-check-N`のuidを`/etc/passwd`から読み、それも無ければ既定の範囲を使う。
 * Windmillのジョブには、workerの環境変数がほとんど渡らない(`WM_*`、`PATH`、`HOME`など)ので、
 * イメージのビルドで決まるuidは、passwdから読んで同じ値にそろえる。
 * 値が不正(rootを含む)なら例外を投げ、rootのまま検査を実行することはしない。
 */
export function resolveCheckPool(
  env: Readonly<Record<string, string | undefined>>,
  readPasswd: () => string,
): number[] {
  const configured = env[CHECK_UID_ENV_NAME];
  const range = (base: number, size: number): number[] => {
    parseCheckUid(String(base + size - 1));
    return Array.from({ length: size }, (_, index) => base + index);
  };
  if (configured !== undefined && configured !== "") {
    return range(
      parseCheckUid(configured),
      parsePoolSize(env[CHECK_POOL_SIZE_ENV_NAME]),
    );
  }
  let users: { index: number; uid: number }[] = [];
  try {
    users = parsePasswdUsers(readPasswd(), CHECK_USER_PREFIX);
  } catch {
    // workerのイメージの外(開発機)では、passwdにユーザーが無い。
  }
  if (users.length === 0) return range(DEFAULT_CHECK_UID, DEFAULT_POOL_SIZE);
  return users.map((user) => parseCheckUid(String(user.uid)));
}

export type CheckDirs = {
  /** 検査を実行するworktree。 */
  readonly worktreeDir: string;
  /** 検査コマンドのHOME。実行ごとに新しく作る非公開のディレクトリ。 */
  readonly homeDir: string;
};

/** 取った枠。`release`で手放す。 */
export type SlotHandle = {
  readonly index: number;
  readonly release: () => Promise<void>;
};

export type SlotDeps = {
  /** 枠`index`のロックを待たずに取る。他が持っていればnullを返す。 */
  readonly tryAcquire: (index: number) => Promise<SlotHandle | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

/** 枠が`maxWaitMs`の間に空かなかった。同時実行が枠の数を超え続けている。 */
export class CheckSlotsBusyError extends Error {
  constructor(waitedMs: number) {
    super(
      `no check slot became free within ${String(Math.round(waitedMs / 1000))}s`,
    );
    this.name = "CheckSlotsBusyError";
  }
}

/**
 * `indices`のうち空いている枠を1つ取る。全部埋まっていれば`pollMs`おきに取り直し、
 * `maxWaitMs`を超えたら`CheckSlotsBusyError`を投げる。
 * 待つのは、同時実行が枠の数を超えても開発を止めないためで、実行を直列にはしない。
 */
export async function acquireSlot(
  indices: readonly number[],
  deps: SlotDeps,
  opts: { readonly maxWaitMs: number; readonly pollMs: number },
): Promise<SlotHandle> {
  const startedAt = deps.now();
  for (;;) {
    for (const index of indices) {
      const handle = await deps.tryAcquire(index);
      if (handle !== null) return handle;
    }
    const waited = deps.now() - startedAt;
    if (waited >= opts.maxWaitMs) throw new CheckSlotsBusyError(waited);
    await deps.sleep(opts.pollMs);
  }
}

export type CheckSandboxDeps = {
  /** rootで実行するコマンドのランナー。所有権の受け渡しに使う。ロックは付けない。 */
  readonly run: CommandRunner;
  readonly reap: ReapDeps;
  readonly slots: SlotDeps;
  /** Windmillの実行時のディレクトリに、所有者以外が入れないようにする。 */
  readonly lockDownRuntimeDir: (dir: string) => Promise<void>;
  /** `path`が、symlinkでない実在のディレクトリであることを確かめる。違えば例外を投げる。 */
  readonly assertDirectory: (path: string) => Promise<void>;
  /** `path`(symlinkはたどらない)の所有者のuid。無ければnull。 */
  readonly ownerOf: (path: string) => Promise<number | null>;
  /** カーネルの設定`/proc/sys/...`の値。読めなければnull。 */
  readonly readSysctl: (name: string) => string | null;
};

export type CheckSandbox = {
  /** 検査コマンドのargvを、取った枠のuidで実行するargvにする。`prepare`の後に呼ぶ。 */
  readonly wrap: (argv: readonly string[]) => string[];
  /**
   * 検査の前に1回。Windmillの実行時のディレクトリを閉じ、空いている枠を取り、
   * 前の実行が残したその枠のプロセスを止め、worktreeとHOMEを枠のuidに渡す。
   */
  readonly prepare: (dirs: CheckDirs) => Promise<void>;
  /** コマンド1つの後に。目印を持つプロセスを止める。止められなければ例外を投げる。 */
  readonly settle: () => Promise<void>;
  /**
   * 検査の後に1回。`prepare`が途中で投げた後にも呼ぶ。
   * 残りを止め、止まったことを確かめてから所有権をrootに戻し、枠を手放す。
   */
  readonly release: (dirs: CheckDirs) => Promise<void>;
  /** ホストのカーネルの設定が前提を満たさないときの警告。空なら前提を満たす。 */
  readonly kernelWarnings: () => string[];
};

async function runTool(
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

function stoppedOrThrow(remaining: readonly number[]): void {
  if (remaining.length > 0) {
    throw new Error(
      `check sandbox: processes of the check user could not be stopped: pid ${remaining.join(", ")}`,
    );
  }
}

/** `dir`を枠のuidからrootに戻し、グループとその他の書き込みとsetuid・setgidのビットを落とす。 */
async function takeBack(
  deps: CheckSandboxDeps,
  identity: CheckIdentity,
  dir: string,
  what: string,
): Promise<void> {
  await runTool(deps, chownBackArgv(identity, dir), `taking ${what} back`);
  await runTool(
    deps,
    dropWriteBitsArgv(dir),
    `dropping write bits from ${what}`,
  );
}

const KERNEL_PROTECTIONS = [
  "fs/protected_hardlinks",
  "fs/protected_symlinks",
] as const;

/** noticeに添える、カーネルの設定の警告の文。警告が無ければ空の文字列を返す。 */
export function kernelWarningText(warnings: readonly string[]): string {
  return warnings.length === 0
    ? ""
    : `警告: ${warnings.join("。")}。検査は続けますが、ホストのカーネルの設定を確かめてください。`;
}

/**
 * 検査用のuidで実行するための部品をまとめて返す。
 * `uids`が枠で、実行(`prepare`から`release`まで)ごとに空いている1つを取る。
 * 所有権の受け渡しは`prepare`と`release`の対で行い、`release`はプロセスが残っている間は
 * 所有権を戻さない(生きている検査のプロセスが、戻した後のworktreeを書き換えうるため)。
 * 1つの部品は、同時に1つの実行だけに使う。
 */
export function createCheckSandbox(opts: {
  readonly uids: readonly number[];
  readonly deps?: CheckSandboxDeps;
  readonly random?: () => number;
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
}): CheckSandbox {
  const deps = opts.deps ?? defaultSandboxDeps();
  const indices = opts.uids.map((_, index) => index);
  let active: { identity: CheckIdentity; handle: SlotHandle } | null = null;
  const current = (): CheckIdentity => {
    if (active === null) {
      throw new Error("check sandbox: no slot is held; call prepare first");
    }
    return active.identity;
  };
  return {
    wrap: (argv) => setprivArgv(current(), argv),
    prepare: async (dirs) => {
      await deps.lockDownRuntimeDir(WINDMILL_TMP_DIR);
      await deps.assertDirectory(dirs.worktreeDir);
      const handle = await acquireSlot(indices, deps.slots, {
        maxWaitMs: opts.maxWaitMs ?? SLOT_MAX_WAIT_MS,
        pollMs: opts.pollMs ?? SLOT_POLL_MS,
      });
      const uid = opts.uids[handle.index];
      if (uid === undefined) {
        await handle.release();
        throw new Error("check sandbox: slot index out of range");
      }
      const identity = newCheckIdentity(uid, opts.random);
      active = { identity, handle };
      // ロックを持つ間、この枠のuidのプロセスは、終わった実行が残したものだけである。
      stoppedOrThrow(await reapUidProcesses(uid, deps.reap));
      await runTool(
        deps,
        chownToArgv(identity, dirs.worktreeDir),
        "handing the worktree over",
      );
      await runTool(
        deps,
        chownToArgv(identity, dirs.homeDir),
        "handing the home directory over",
      );
    },
    settle: async () => {
      stoppedOrThrow(await reapCheckProcesses(current(), deps.reap));
    },
    release: async (dirs) => {
      if (active === null) return;
      const { identity, handle } = active;
      active = null;
      try {
        stoppedOrThrow(await reapCheckProcesses(identity, deps.reap));
        await takeBack(deps, identity, dirs.worktreeDir, "the worktree");
        await runTool(
          deps,
          chownBackArgv(identity, dirs.homeDir),
          "taking the home directory back",
        );
      } finally {
        await handle.release();
      }
    },
    kernelWarnings: () =>
      KERNEL_PROTECTIONS.filter((name) => deps.readSysctl(name) !== "1").map(
        (name) =>
          `${name} is not 1 on the host, so a check command may link or follow files it does not own`,
      ),
  };
}

/**
 * worktreeが検査用のuidの所有のまま残っていれば、rootに戻す。戻したらtrueを返す。
 * 検査を実行したジョブが、取り消しやタイムアウトで後始末の前に止められると、所有権が残る。
 * そのままだとrootのgitが所有者の違いで実行を拒み、次の作業項目が止まる。
 * 所有者の枠のロックを取れれば、その枠のプロセス(終わった実行が残したもの)を止めてから戻す。
 * `maxWaitMs`待ってもロックを取れなければ(その枠で別の検査が動いている)、プロセスは止めず、所有権だけ戻す。
 * 戻すのはrootへの変更なので、動いている別の検査が競合しても、worktreeの外のファイルは検査用のuidの所有にならない。
 * 戻した後は、グループとその他の書き込みも落とすので、残ったプロセスはworktreeを書き換えられない。
 * worktreeが無いか、所有者が枠のuidでなければ、何もせずfalseを返す。
 */
export async function restoreCheckOwnership(
  dir: string,
  uids: readonly number[],
  deps: CheckSandboxDeps,
  maxWaitMs: number = RESTORE_MAX_WAIT_MS,
): Promise<boolean> {
  const owner = await deps.ownerOf(dir);
  const index = owner === null ? -1 : uids.indexOf(owner);
  if (owner === null || index < 0) return false;
  let handle: SlotHandle | null = null;
  try {
    handle = await acquireSlot([index], deps.slots, {
      maxWaitMs,
      pollMs: SLOT_POLL_MS,
    });
  } catch (error) {
    if (!(error instanceof CheckSlotsBusyError)) throw error;
  }
  try {
    if (handle !== null) {
      stoppedOrThrow(await reapUidProcesses(owner, deps.reap));
    }
    await takeBack(deps, newCheckIdentity(owner), dir, "the worktree");
    return true;
  } finally {
    await handle?.release();
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * 枠のロックを`flock`で取る。ロックを持つ子プロセス(`flock`と、その下で標準入力が閉じるまで待つ`cat`)を
 * 起動し、持っている間は標準入力のパイプを開けておく。
 * 手放すにはパイプを閉じる。ジョブのプロセスが殺されても、カーネルがパイプを閉じてロックを放すので、枠は塞がったままにならない。
 */
function flockSlotDeps(lockDir: string): SlotDeps {
  return {
    tryAcquire: async (index) => {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await chmod(lockDir, 0o700);
      const proc = Bun.spawn({
        cmd: [
          FLOCK_PATH,
          "--nonblock",
          "--conflict-exit-code",
          String(SLOT_BUSY_EXIT_CODE),
          join(lockDir, `slot-${String(index)}.lock`),
          "/bin/sh",
          "-c",
          "echo held; exec cat >/dev/null",
        ],
        env: { PATH: TOOL_PATH },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      const reader = proc.stdout.getReader();
      const first = await reader.read();
      const held =
        !first.done && new TextDecoder().decode(first.value).startsWith("held");
      reader.releaseLock();
      if (!held) {
        const code = await proc.exited;
        if (code === SLOT_BUSY_EXIT_CODE) return null;
        throw new Error(
          `check sandbox: flock for slot ${String(index)} failed (exit ${String(code)})`,
        );
      }
      return {
        index,
        release: async () => {
          proc.stdin.end();
          const stopped = await Promise.race([
            proc.exited.then(() => true),
            Bun.sleep(SLOT_RELEASE_WAIT_MS).then(() => false),
          ]);
          if (!stopped) {
            proc.kill("SIGKILL");
            await proc.exited;
          }
        },
      };
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
  };
}

export function defaultSandboxDeps(
  lockDir: string = SLOT_LOCK_DIR,
): CheckSandboxDeps {
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
    slots: flockSlotDeps(lockDir),
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
    ownerOf: async (path) => {
      try {
        return (await lstat(path)).uid;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    readSysctl: (name) => {
      try {
        return readFileSync(`/proc/sys/${name}`, "utf8").trim();
      } catch {
        return null;
      }
    },
  };
}

const readPasswd = (): string => readFileSync("/etc/passwd", "utf8");

/** 本番の検査用の部品を作る。枠のuidは`resolveCheckPool`で決める。 */
export function checkSandboxFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CheckSandbox {
  return createCheckSandbox({ uids: resolveCheckPool(env, readPasswd) });
}

/** 本番の設定で、worktreeに残った検査用のuidの所有を戻す。`restoreCheckOwnership`を参照。 */
export function restoreCheckOwnershipFromEnv(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  return restoreCheckOwnership(
    dir,
    resolveCheckPool(env, readPasswd),
    defaultSandboxDeps(),
  );
}
