// 検査コマンドを、workerのrootではなく非特権のuidで動かすための部品。
// argvと環境変数の組み立て、uidの枠の取得と回復、worktreeの所有権の受け渡し、残ったプロセスの後始末を、
// 副作用の無い関数と、注入できる依存に分けて持つ。
// 検査コマンドは信頼できない対象リポジトリのコードなので、workerの秘密(環境変数、
// トークンのファイル)に届かず、書き込める場所をworktreeとそのHOMEと共有の一時ディレクトリに限る。
// 並行して動く検査どうしが同じuidを共有しないよう、実行ごとにuidの枠を1つ取る。
// 枠は後の実行で別のリポジトリに使い回すので、枠を取るたびに前の実行の残り(プロセス、所有権、一時ファイル、IPC)を消す。

import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type Logger, logger, maskSecrets } from "./log.ts";
import { isRecord, isString } from "./types.ts";
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
 * 別のセッションに抜けたプロセスも、`/proc/<pid>/status`の`Groups`で、どの実行が起動したかを見分けられる。
 * 止めるときは目印ではなく枠のuidで選ぶ。枠のロックを持つ間、枠のuidのプロセスはこの実行のものだけだからである。
 */
const TAG_GID_MIN = 1_000_000;
const TAG_GID_MAX = 2_000_000_000;

/**
 * PATHに頼らず、絶対パスで呼ぶ道具。
 * イメージでは`util-linux`(`setpriv`、`prlimit`、`flock`、`ipcrm`)、`findutils`、`coreutils`、
 * `procps`(`kill`)、`acl`(`getfacl`、`setfacl`)が入れる。
 */
export const SETPRIV_PATH = "/usr/bin/setpriv";
export const PRLIMIT_PATH = "/usr/bin/prlimit";
export const FIND_PATH = "/usr/bin/find";
export const CHOWN_PATH = "/usr/bin/chown";
export const CHMOD_PATH = "/usr/bin/chmod";
export const FLOCK_PATH = "/usr/bin/flock";
export const RM_PATH = "/usr/bin/rm";
export const IPCRM_PATH = "/usr/bin/ipcrm";
export const KILL_PATH = "/usr/bin/kill";
export const GETFACL_PATH = "/usr/bin/getfacl";
export const SETFACL_PATH = "/usr/bin/setfacl";

/** 検査と後始末が呼ぶ道具の一覧。`prepare`は、1つでも無ければ何にも触れずに失敗する。 */
export const REQUIRED_TOOL_PATHS = [
  SETPRIV_PATH,
  PRLIMIT_PATH,
  FIND_PATH,
  CHOWN_PATH,
  CHMOD_PATH,
  FLOCK_PATH,
  RM_PATH,
  IPCRM_PATH,
  KILL_PATH,
  GETFACL_PATH,
  SETFACL_PATH,
] as const;

/**
 * 検査コマンドの枠のuidが同時に持てるプロセスの数(スレッドを含む)の上限。
 * 子を作り続ける検査が、workerのコンテナのpidsの上限(1024)を使い切り、ほかのジョブとWindmill本体を止めないようにする。
 * カーネルは実uidごとに数えるので、枠ごとの上限になる。
 * workerの同時実行数(`NUM_WORKERS`、3)の検査がそろって上限まで使っても、検査の外に256が残る。
 * 冷えたキャッシュの`go build`は12コアで約110まで増え、コア数とともに増えるので、それが収まる値にする。根拠は`docs/security.md`にある。
 */
export const CHECK_NPROC_LIMIT = 256;
/**
 * Windmillの実行時のディレクトリ。依存のキャッシュ(`cache`)とログ(`logs`)が、
 * 誰でも書き込める(0777)権限で作られる。
 * rootのworkerが後で実行するバンドルを検査用のuidに差し替えられないよう、
 * 検査の前に所有者以外が入れない権限にする。
 */
export const WINDMILL_TMP_DIR = "/tmp/windmill";

/**
 * 誰でも書き込める共有の一時ディレクトリ。POSIXの共有メモリとセマフォは`/dev/shm`に、
 * メッセージキューは`/dev/mqueue`に置かれる。
 * 枠を取るたびに、そのuidのものをここから消す。同じuidを次に使う実行が、前の実行の残したファイルを読めないようにするためである。
 */
export const SHARED_TMP_DIRS = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  "/dev/mqueue",
] as const;

/**
 * 枠のロックファイルと記録を置くディレクトリ。永続のボリューム(`/var/lib/factory`)の下で、rootだけが入れる。
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
/**
 * 道具を起動するディレクトリ。枠のuidで動く`find`は起動したディレクトリを開くので、
 * 誰でも入れる`/`にする。ジョブのディレクトリはrootだけが入れることがある。
 */
const TOOL_CWD = "/";

/**
 * 枠のuidのプロセスを止め続ける上限(ミリ秒)。止める間に子を作り続けるプロセス(fork爆弾)も、
 * 1回のシグナルで今あるものがすべて止まるので、普通は数回で尽きる。
 * 上限は、止まらないプロセス(D状態など)が残ったときに、待ち続けないためにある。
 */
export const REAP_MAX_WAIT_MS = 30_000;
const REAP_POLL_MS = 100;
const KILL_TIMEOUT_MS = 10_000;

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

/** 枠のuidとして動く前に、uidが一般のユーザーの範囲の整数であることを確かめる。rootやシステムのユーザーとして動かないためである。 */
function assertCheckUid(uid: number): void {
  if (!Number.isInteger(uid) || uid < MIN_CHECK_UID || uid > MAX_CHECK_UID) {
    throw new Error(`check sandbox: refusing to act as uid ${String(uid)}`);
  }
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
  assertCheckUid(identity.uid);
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
 * 検査コマンドの`argv`を、枠のuidのプロセス数を`CHECK_NPROC_LIMIT`に抑えたうえで、検査用のuidに落として実行するargvにする。
 * `prlimit`はrootのまま上限を付けてから`setpriv`を実行し、上限は検査コマンドとその子孫に受け継がれる。
 * 後始末の`kill`は上限を付けずに起動するので、上限に達した枠のプロセスも止められる。
 */
export function checkCommandArgv(
  identity: CheckIdentity,
  argv: readonly string[],
): string[] {
  const limit = String(CHECK_NPROC_LIMIT);
  return [
    PRLIMIT_PATH,
    `--nproc=${limit}:${limit}`,
    "--",
    ...setprivArgv(identity, argv),
  ];
}

/**
 * 検査コマンドに渡す環境変数の名前の許可リスト。
 * ここに無い変数は、workerがどれほど持っていても渡さない。
 */
export const CHECK_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
] as const;

/** 検査コマンドの一時ディレクトリ。HOMEの下に置き、他の枠から読めない共有の`/tmp`を既定にさせない。 */
export function checkTmpDir(home: string): string {
  return join(home, "tmp");
}

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
    TMPDIR: checkTmpDir(input.home),
    LANG: "C.UTF-8",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: input.worktreeDir,
  };
}

/** 正規化された絶対パスで、最上位の1段ではないかを返す。 */
function isNestedAbsolutePath(dir: string): boolean {
  const segments = dir.split("/").filter((part) => part !== "");
  return isAbsolute(dir) && resolve(dir) === dir && segments.length >= 2;
}

/**
 * 所有権を変えてよいディレクトリかを確かめる。
 * 正規化された絶対パスで、最上位の1段ではないものに限る。`/`や`/workspaces`のような広い範囲を誤って渡さないためである。
 */
function assertChownableDir(dir: string): void {
  if (!isNestedAbsolutePath(dir)) {
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

/**
 * 取り戻しの1段目。rootで、`dir`の下のうち、枠のuidが所有していないディレクトリすべてと、
 * ほかの非rootのユーザー(並行して動く別の枠など)のもの、書き込みかsetidのビットが立ったrootの単独のファイルを、枠のuidに集める。
 * 権限のビットは次の段で枠のuidとして落とす。rootのまま`chmod`すると、差し替えられたsymlinkの先を変えうるためである。
 * ディレクトリをすべて集めるのは、次の段の`find`が枠のuidのまま全体に入れるようにするためである。
 */
export function gatherArgv(identity: CheckIdentity, dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "!",
    "-uid",
    String(identity.uid),
    "(",
    "-type",
    "d",
    "-o",
    "!",
    "-uid",
    "0",
    "-o",
    "(",
    "!",
    "-type",
    "l",
    "-links",
    "1",
    "-perm",
    "/6022",
    ")",
    ")",
    "-execdir",
    CHOWN_PATH,
    "-h",
    `${String(identity.uid)}:${String(identity.gid)}`,
    "{}",
    "+",
  ];
}

/**
 * 取り戻しの2段目。枠のuidとして、所有者が入れないディレクトリに入れるようにする。
 * 検査コマンドがディレクトリを0000などにしても、次の段の`find`が中に入れるようにするためである。
 * `-execdir ... ;`は、そのディレクトリに入る前に実行される。
 */
export function openDirsArgv(identity: CheckIdentity, dir: string): string[] {
  assertChownableDir(dir);
  return setprivArgv(identity, [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "-uid",
    String(identity.uid),
    "-type",
    "d",
    "!",
    "-perm",
    "-u=rwx",
    "-execdir",
    CHMOD_PATH,
    "u+rwx",
    "{}",
    ";",
  ]);
}

/**
 * 取り戻しの3段目。枠のuidとして、グループとその他の書き込みと、setuid・setgidのビットを落とす。
 * rootに戻した後に、他の枠の検査が書き込める状態を残さない。symlinkは対象にしない。
 * 枠のuidで動かすので、列挙と変更の間にsymlinkへ差し替えられても、枠のuidのもの以外は変わらない。
 */
export function dropWriteBitsArgv(
  identity: CheckIdentity,
  dir: string,
): string[] {
  assertChownableDir(dir);
  return setprivArgv(identity, [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "-uid",
    String(identity.uid),
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
  ]);
}

/** 取り戻しの4段目。rootで、`dir`の下のrootでないものをすべてrootに戻す。権限のビットは変えない。 */
export function reclaimArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "!",
    "-uid",
    "0",
    "-execdir",
    CHOWN_PATH,
    "-h",
    "0:0",
    "{}",
    "+",
  ];
}

/**
 * 取り戻しの確かめ。`dir`の下に、rootでないものか、書き込みかsetidのビットが立ったものが残っていれば、最初の1つのパスを出す。
 * 並行して動く別の枠のプロセスが、途中で書き足した場合に残る。
 * ハードリンクが2つ以上あるファイルは、worktreeの外のファイルでありうるので見ない。
 */
export function leftoverArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "(",
    "!",
    "-uid",
    "0",
    "-o",
    "(",
    "!",
    "-type",
    "l",
    "(",
    "-type",
    "d",
    "-o",
    "-links",
    "1",
    ")",
    "-perm",
    "/6022",
    ")",
    ")",
    "-print",
    "-quit",
  ];
}

/** `dir`の下に、rootでないものがあれば最初の1つのパスを出すargv。読めない枠の記録がそのworktreeを指していたかを推し量るのに使う。 */
export function notRootOwnedArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [FIND_PATH, "-P", dir, "-xdev", "!", "-uid", "0", "-print", "-quit"];
}

/**
 * 取り戻しの確かめ。`dir`の下に、拡張のACL(名前付きのエントリかデフォルトのACL)を持つものがあれば、その一覧を出す。
 * ACLは`chown`と`chmod`では消えない。枠のuidがディレクトリに付けたデフォルトのACLが残ると、
 * 後でrootが作るファイルに、他の枠が書ける権限が付くためである。
 * `-P`でsymlinkをたどらず、`-s`で基本のエントリだけのものを飛ばす。ACLの無いファイルシステムでは何も出さない。
 */
export function aclLeftoverArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [GETFACL_PATH, "-R", "-P", "-s", "-p", "--", dir];
}

/**
 * `dir`の下の、symlinkでないものすべてから拡張のACLを消すargv。rootで実行する。
 * 権限のビットは変わらない(グループのビットはマスクの値のまま残る)。
 * 取り戻しの確かめに通り、`dir`の下がすべてrootの所有で、グループとその他が書き込めない状態のときだけ呼ぶ。
 * その状態では、ほかのユーザーはエントリを差し替えられないので、rootの`-execdir`がworktreeの外に及ばない。
 */
export function removeAclArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "!",
    "-type",
    "l",
    "-execdir",
    SETFACL_PATH,
    "-b",
    "-k",
    "{}",
    "+",
  ];
}

/**
 * `dir`を中身ごと消すargv。GNUの`rm`は`openat`で降り、symlinkをたどらない。
 * 消している間に別の枠のプロセスがsymlinkへ差し替えても、外のファイルを消さないためである。
 */
export function removeTreeArgv(dir: string): string[] {
  assertChownableDir(dir);
  return [RM_PATH, "-rf", "--one-file-system", "--", dir];
}

/**
 * 共有の一時ディレクトリ`dir`の下の、枠のuidのディレクトリを中身ごと消すargv。
 * 中に別のユーザーのものがあっても消せるよう、rootの`rm -rf`を、親ディレクトリを起点にした`./名前`で呼ぶ。
 */
export function purgeDirsArgv(uid: number, dir: string): string[] {
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "-mindepth",
    "1",
    "-uid",
    String(uid),
    "-type",
    "d",
    "-prune",
    "-execdir",
    RM_PATH,
    "-rf",
    "--one-file-system",
    "--",
    "{}",
    "+",
  ];
}

/** 共有の一時ディレクトリ`dir`の下の、枠のuidのディレクトリ以外のものを消すargv。`-delete`は親のfdを起点に消す。 */
export function purgeFilesArgv(uid: number, dir: string): string[] {
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "-uid",
    String(uid),
    "!",
    "-type",
    "d",
    "-delete",
  ];
}

/** 共有の一時ディレクトリ`dir`の下に、枠のuidのものが残っていれば、最初の1つのパスを出すargv。 */
export function remainingOfUidArgv(uid: number, dir: string): string[] {
  return [
    FIND_PATH,
    "-P",
    dir,
    "-xdev",
    "-uid",
    String(uid),
    "-print",
    "-quit",
  ];
}

/** System VのIPCの1つ。`kind`は共有メモリ(`shm`)、セマフォ(`sem`)、メッセージキュー(`msg`)。 */
export type IpcEntry = {
  readonly kind: "shm" | "sem" | "msg";
  readonly id: number;
  /** 所有者のuid。 */
  readonly uid: number;
  /** 作成者のuid。所有者を他人に変えても、作成者は消せる。 */
  readonly cuid: number;
};

const IPC_ID_COLUMNS = { shm: "shmid", sem: "semid", msg: "msqid" } as const;

/**
 * `/proc/sysvipc/<kind>`の本文を解析する。列は見出しの名前で探す。
 * 見出しに必要な列が無いか、数でない欄がある行は飛ばす。
 */
export function parseSysvIpc(text: string, kind: IpcEntry["kind"]): IpcEntry[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const header = (lines[0] ?? "").trim().split(/\s+/);
  const idAt = header.indexOf(IPC_ID_COLUMNS[kind]);
  const uidAt = header.indexOf("uid");
  const cuidAt = header.indexOf("cuid");
  if (idAt < 0 || uidAt < 0 || cuidAt < 0) return [];
  const entries: IpcEntry[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    const values = [fields[idAt], fields[uidAt], fields[cuidAt]];
    if (!values.every((value) => value !== undefined && /^\d+$/.test(value)))
      continue;
    entries.push({
      kind,
      id: Number(values[0]),
      uid: Number(values[1]),
      cuid: Number(values[2]),
    });
  }
  return entries;
}

const IPCRM_FLAGS = { shm: "-m", sem: "-s", msg: "-q" } as const;

/** IPCを識別子で消す`ipcrm`のargv。 */
export function ipcrmArgv(entries: readonly IpcEntry[]): string[] {
  return [
    IPCRM_PATH,
    ...entries.flatMap((entry) => [IPCRM_FLAGS[entry.kind], String(entry.id)]),
  ];
}

/**
 * 枠の記録。枠を使う実行が、所有権を渡す前に書き、すべて取り戻したときだけ消す。
 * 取り消しやタイムアウトで後始末が走らなかった実行の残りを、次にその枠を取る実行が見つけて戻すために使う。
 */
export type SlotRecord = {
  readonly worktreeDir: string;
  readonly homeDir: string;
};

export function formatSlotRecord(record: SlotRecord): string {
  return `${JSON.stringify({ worktreeDir: record.worktreeDir, homeDir: record.homeDir })}\n`;
}

/** 枠の記録の本文を解析する。形が違うか、パスが正規化された2段以上の絶対パスでなければnullを返す。 */
export function parseSlotRecord(text: string): SlotRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { worktreeDir, homeDir } = parsed;
  if (!isString(worktreeDir) || !isString(homeDir)) return null;
  if (!isNestedAbsolutePath(worktreeDir) || !isNestedAbsolutePath(homeDir))
    return null;
  return { worktreeDir, homeDir };
}

/** 枠の記録の本文が読めない(形が違う)。`path`は記録のファイル。 */
export class UnreadableSlotRecordError extends Error {
  constructor(index: number, path: string) {
    super(
      `check sandbox: the record of slot ${String(index)} is unreadable: ${path}`,
    );
    this.name = "UnreadableSlotRecordError";
  }
}

/** イメージの前提を満たさないときの理由の先頭。運用者が取る操作(`mise run up`)を含める。 */
export const CHECK_IMAGE_STALE_REASON =
  "worker image is stale: run mise run up";

/**
 * workerのイメージが、検査を枠のuidで動かす前提(道具と`factory-check-N`のユーザー)を満たさない。
 * `f/`の変更がイメージの作り直しより先に反映されたときに起きる。検査の失敗ではなく、検査を実行できない環境の問題である。
 * 問題は`, `でつなぐ。理由の区切り(`; `)で別の理由に見えないようにするためである。
 */
export class CheckImageStaleError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`${CHECK_IMAGE_STALE_REASON}: ${problems.join(", ")}`);
    this.name = "CheckImageStaleError";
    this.problems = problems;
  }
}

/** worktreeに残った枠のuidの所有を、rootへ戻せなかった。メッセージに枠と理由が載る。 */
export class CheckOwnershipRestoreError extends Error {
  constructor(detail: string) {
    super(`check sandbox: ${detail}`);
    this.name = "CheckOwnershipRestoreError";
  }
}

/** 回復できずに飛ばした枠。 */
export type SlotSkip = {
  readonly index: number;
  readonly uid: number;
  readonly reason: string;
};

/** 飛ばした枠を知らせるnoticeの本文。 */
export function slotSkipNoticeText(skip: SlotSkip): string {
  return `検査の枠${CHECK_USER_PREFIX}${String(skip.index)}(uid ${String(skip.uid)})を、前の実行の残りを片付けられないため飛ばし、別の枠で検査しました。理由: ${skip.reason}。止まらないプロセスが残っているときは、workerを再起動してください。`;
}

/** 読めない記録を退避した枠を知らせるnoticeの本文。`path`は退避した先。 */
export function slotRecordUnreadableNoticeText(opts: {
  readonly index: number;
  readonly uid: number;
  readonly path: string;
}): string {
  return `検査の枠${CHECK_USER_PREFIX}${String(opts.index)}(uid ${String(opts.uid)})の記録が読めないため、${opts.path}へ退避して、この枠の片付けを続けました。記録の中身を確かめ、記録が指すworktreeが枠のuidの所有のまま残っていればrootに戻し、HOMEが残っていれば消してから、退避した記録を消してください。`;
}

/** 枠について運用者に知らせるnotice。`kind`は`factory.notices`の種類になる。 */
export type CheckSlotNotice = {
  readonly kind: "check_slot_skipped" | "check_slot_record_unreadable";
  readonly message: string;
};

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

export type ReapDeps = {
  /** `/proc`の下のpidの一覧。 */
  readonly listPids: () => Promise<readonly number[]>;
  /** `/proc/<pid>/status`の本文。プロセスが無ければnull。 */
  readonly readStatus: (pid: number) => Promise<string | null>;
  /** `uid`のプロセスすべてにSIGKILLを送る(`killAllArgv`)。対象が無いときの失敗は無視する。 */
  readonly killAll: (uid: number) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

/**
 * `uid`として、そのuidのプロセスすべてにSIGKILLを送るargv。`kill -1`は、送り手が送れるすべてのプロセスに送り、送り手自身には送らない。
 * 枠のuidとして送るので、rootのプロセスや別の枠のプロセスには届かない。
 * pidを1つずつ選んで送る形と違い、1回のシグナルで、その時点で生きているものすべてが止まる。止める間に子を作り続けるプロセスにも追い越されない。
 * procps-ngの`kill`は、`-1`を`--`の後に置かないとオプションとして読み、送らずに失敗する。
 */
export function killAllArgv(uid: number): string[] {
  // rootとして`kill -1`を送ると、コンテナのすべてのプロセスが止まる。
  assertCheckUid(uid);
  return [
    SETPRIV_PATH,
    `--reuid=${String(uid)}`,
    `--regid=${String(uid)}`,
    "--clear-groups",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--no-new-privs",
    "--",
    KILL_PATH,
    "-9",
    "--",
    "-1",
  ];
}

/** 実uidが`uid`の、生きた(ゾンビでない)プロセスのpidを返す。 */
async function livePidsOf(uid: number, deps: ReapDeps): Promise<number[]> {
  const found: number[] = [];
  for (const pid of await deps.listPids()) {
    const text = await deps.readStatus(pid);
    const status = text === null ? null : parseProcStatus(text);
    if (status !== null && status.state !== "Z" && status.uid === uid)
      found.push(pid);
  }
  return found;
}

/**
 * 枠のuidで動くプロセスをすべて止め、止まらずに残ったpidを返す。
 * 枠のuidのプロセスが見つからなくなるまで、枠のuidとして`kill -1`を送り続ける。
 * `maxWaitMs`を過ぎても残れば、そのpidを返す。
 * 枠のロックを持っている間だけ呼ぶ。枠を取るときに前の実行の残りを止めるので、ロックを持つ間の枠のuidのプロセスは、
 * ロックを持つ実行が起動したものか、終わった実行が残したものだけだからである。
 */
export async function reapUidProcesses(
  uid: number,
  deps: ReapDeps,
  maxWaitMs: number = REAP_MAX_WAIT_MS,
): Promise<number[]> {
  const startedAt = deps.now();
  for (;;) {
    const pids = await livePidsOf(uid, deps);
    if (pids.length === 0) return [];
    if (deps.now() - startedAt >= maxWaitMs) return pids;
    await deps.killAll(uid);
    await deps.sleep(REAP_POLL_MS);
  }
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

/** イメージの前提を確かめるための読み取り。 */
export type ImageDeps = {
  /** `path`が実行できるファイルかを返す。 */
  readonly isExecutable: (path: string) => Promise<boolean>;
  /** `/etc/passwd`の本文。読めなければ例外を投げる。 */
  readonly readPasswd: () => Promise<string>;
};

/**
 * workerのイメージが、`uids`の枠で検査を動かす前提を満たすかを確かめ、満たさない点を返す。空なら満たす。
 * 前提は、`REQUIRED_TOOL_PATHS`の道具がすべて実行できることと、`uids`のどれにも`factory-check-N`のユーザーがあることである。
 * 古いイメージには、番号の無い`factory-check`のユーザーしか無く、`acl`も入っていない。
 */
export async function checkImageProblems(
  uids: readonly number[],
  deps: ImageDeps,
): Promise<string[]> {
  const problems: string[] = [];
  for (const path of REQUIRED_TOOL_PATHS) {
    if (!(await deps.isExecutable(path))) problems.push(`${path} is missing`);
  }
  let passwd = "";
  try {
    passwd = await deps.readPasswd();
  } catch {
    problems.push("/etc/passwd is unreadable");
  }
  const known = new Set(
    parsePasswdUsers(passwd, CHECK_USER_PREFIX).map((user) => user.uid),
  );
  const absent = uids.filter((uid) => !known.has(uid));
  if (absent.length > 0) {
    problems.push(
      `no ${CHECK_USER_PREFIX}N user for uid ${absent.map(String).join(", ")}`,
    );
  }
  return problems;
}

/**
 * 検査コマンドがあるときだけ、workerのイメージが検査の前提を満たすかを`problems`で確かめる。
 * 満たさなければ`CheckImageStaleError`を`report`で1回知らせ、そのメッセージを止める理由として返す。満たせばnullを返す。
 * 実装とPR修正の準備が、Claudeを動かす前に呼ぶ。古いイメージのまま進むと、Claudeの1回分の実行が検査の前に無駄になるためである。
 * 検査コマンドが無ければイメージを見ない。検査の無いリポジトリは、古いイメージでも止めない。
 */
export async function checkImageGate(
  hasCheckCommands: boolean,
  deps: {
    readonly problems: () => Promise<readonly string[]>;
    readonly report: (error: CheckImageStaleError) => Promise<void>;
  },
): Promise<string | null> {
  if (!hasCheckCommands) return null;
  const problems = await deps.problems();
  if (problems.length === 0) return null;
  const error = new CheckImageStaleError(problems);
  await deps.report(error);
  return error.message;
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

/** 枠の記録の読み書き。枠のロックを持っている間だけ、書くか消すか退避する。 */
export type SlotRecordDeps = {
  /** 記録が無ければnullを返す。形が違えば`UnreadableSlotRecordError`を、読めなければその例外を投げる。 */
  readonly read: (index: number) => Promise<SlotRecord | null>;
  readonly write: (index: number, record: SlotRecord) => Promise<void>;
  readonly clear: (index: number) => Promise<void>;
  /** 記録を、同じディレクトリの別の名前へ移し、移した先のパスを返す。 */
  readonly setAside: (index: number) => Promise<string>;
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

/** worktreeを指す記録の枠を、別の実行が持っている。その実行が、worktreeを使っているか片付けている。 */
export class CheckSlotInUseError extends Error {
  constructor(index: number, uid: number) {
    super(
      `check slot ${CHECK_USER_PREFIX}${String(index)} (uid ${String(uid)}) that recorded the worktree is held by another run`,
    );
    this.name = "CheckSlotInUseError";
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

export type CheckSandboxDeps = ImageDeps & {
  /** rootで実行するコマンドのランナー。所有権の受け渡しに使う。ロックは付けない。 */
  readonly run: CommandRunner;
  readonly reap: ReapDeps;
  readonly slots: SlotDeps;
  readonly slotRecords: SlotRecordDeps;
  /** System VのIPCの一覧。 */
  readonly listIpc: () => Promise<readonly IpcEntry[]>;
  /** Windmillの実行時のディレクトリに、所有者以外が入れないようにする。 */
  readonly lockDownRuntimeDir: (dir: string) => Promise<void>;
  /** `path`が、symlinkでない実在のディレクトリであることを確かめる。違えば例外を投げる。 */
  readonly assertDirectory: (path: string) => Promise<void>;
  /** `path`(symlinkはたどらない)の種類。 */
  readonly pathKind: (
    path: string,
  ) => Promise<"missing" | "directory" | "other">;
  /** カーネルの設定`/proc/sys/...`の値。読めなければnull。 */
  readonly readSysctl: (name: string) => string | null;
};

export type CheckSandbox = {
  /** 検査コマンドのargvを、取った枠のuidで実行するargvにする。`prepare`の後に呼ぶ。 */
  readonly wrap: (argv: readonly string[]) => string[];
  /**
   * 検査の前に1回。最初にイメージの前提を確かめ、満たさなければ何にも触れずに`CheckImageStaleError`を投げる。
   * 続けてWindmillの実行時のディレクトリを閉じ、空いている枠を取り、
   * 前の実行が残したその枠のものを片付け、枠の記録を書いてから、worktreeとHOMEを枠のuidに渡す。
   * 片付けられない枠は手放して次の枠を試す。
   */
  readonly prepare: (dirs: CheckDirs) => Promise<void>;
  /** コマンド1つの後に。枠のuidのプロセスを止める。止められなければ例外を投げる。 */
  readonly settle: () => Promise<void>;
  /**
   * 検査の後に1回。`prepare`が途中で投げた後にも呼ぶ。
   * 残りを止め、止まったことを確かめてから所有権をrootに戻し、HOMEを消す。
   * 共有の一時ディレクトリとIPCから枠のuidのものを消し、枠の記録を消して、枠を手放す。
   * 取り戻しが途中で失敗したときは記録を残し、次にその枠を取る実行に片付けを任せる。
   * 共有の一時ディレクトリとIPCを消し切れないときは、ログに残すだけで失敗にしない。次にその枠を取る実行が消し直すためである。
   */
  readonly release: (dirs: CheckDirs) => Promise<void>;
  /** ホストのカーネルの設定が前提を満たさないときの警告。空なら前提を満たす。 */
  readonly kernelWarnings: () => string[];
};

async function runToolOutput(
  deps: CheckSandboxDeps,
  argv: string[],
  what: string,
  opts?: { readonly ignoreExitCode?: boolean },
): Promise<string> {
  const result = await deps.run(argv, {
    cwd: TOOL_CWD,
    env: { PATH: TOOL_PATH },
    timeoutMs: CHOWN_TIMEOUT_MS,
    maxOutputBytes: CHOWN_MAX_OUTPUT_BYTES,
  });
  if (!result.timedOut && (result.exitCode === 0 || opts?.ignoreExitCode))
    return result.stdout;
  const detail = maskSecrets(result.stderr.trim());
  throw new Error(
    `check sandbox: ${what} failed (exit ${String(result.exitCode)}${result.timedOut ? ", timed out" : ""}): ${detail}`,
  );
}

async function runTool(
  deps: CheckSandboxDeps,
  argv: string[],
  what: string,
): Promise<void> {
  await runToolOutput(deps, argv, what);
}

function stoppedOrThrow(remaining: readonly number[]): void {
  if (remaining.length > 0) {
    throw new Error(
      `check sandbox: processes of the check user could not be stopped: pid ${remaining.join(", ")}`,
    );
  }
}

/** 出力の最初の1行を、秘密をマスクして返す。 */
function firstLine(output: string): string {
  return maskSecrets(output.split("\n")[0] ?? "");
}

/** `dir`の下に、rootでないものか書き込めるものが残っていれば例外を投げる。 */
async function assertNoLeftover(
  deps: CheckSandboxDeps,
  dir: string,
): Promise<void> {
  const leftover = await runToolOutput(
    deps,
    leftoverArgv(dir),
    `checking ${dir}`,
  );
  if (leftover.trim() !== "") {
    throw new Error(
      `check sandbox: entries owned by others or writable by others remain: ${firstLine(leftover)}`,
    );
  }
}

/** `dir`の下で拡張のACLを持つものの一覧を返す。無ければ空の文字列を返す。 */
async function aclLeftover(
  deps: CheckSandboxDeps,
  dir: string,
): Promise<string> {
  return (
    await runToolOutput(deps, aclLeftoverArgv(dir), `checking ACLs in ${dir}`)
  ).trim();
}

/**
 * `dir`を枠のuidからrootに戻す。枠のuidのプロセスが止まった後に呼ぶ。
 * 権限のビットは枠のuidとして落とし、rootは`chown -h`だけを行う。
 * 戻した後、rootでないものか書き込めるものが残っていれば例外を投げる。
 * 拡張のACLが残っていれば、rootで消してから、もう一度確かめる。
 * rootが消すのは、すべてrootの所有で書き込めない状態を確かめた後なので、ほかのユーザーがエントリを差し替えられない。
 * 消した後もACLか書き込めるものが残っていれば例外を投げる。
 */
async function takeBack(
  deps: CheckSandboxDeps,
  identity: CheckIdentity,
  dir: string,
): Promise<void> {
  await runTool(deps, gatherArgv(identity, dir), `gathering ${dir}`);
  await runTool(deps, openDirsArgv(identity, dir), `opening ${dir}`);
  await runTool(
    deps,
    dropWriteBitsArgv(identity, dir),
    `dropping write bits in ${dir}`,
  );
  await runTool(deps, reclaimArgv(dir), `taking ${dir} back`);
  await assertNoLeftover(deps, dir);
  if ((await aclLeftover(deps, dir)) === "") return;
  await runTool(deps, removeAclArgv(dir), `removing ACLs in ${dir}`);
  await assertNoLeftover(deps, dir);
  const remaining = await aclLeftover(deps, dir);
  if (remaining !== "") {
    throw new Error(
      `check sandbox: entries with an ACL remain: ${firstLine(remaining)}`,
    );
  }
}

/** worktreeがあれば取り戻し、HOMEを消す。どちらも、枠のuidのプロセスが止まった後に呼ぶ。 */
async function takeBackDirs(
  deps: CheckSandboxDeps,
  identity: CheckIdentity,
  dirs: SlotRecord,
): Promise<void> {
  if ((await deps.pathKind(dirs.worktreeDir)) === "directory") {
    await takeBack(deps, identity, dirs.worktreeDir);
  }
  await runTool(deps, removeTreeArgv(dirs.homeDir), `removing ${dirs.homeDir}`);
}

/**
 * 共有の一時ディレクトリとIPCから、枠のuidのものを消す。消し切れなければ例外を投げる。
 * IPCは枠のuidとして消す。workerのrootは`CAP_IPC_OWNER`を持たず、他人のIPCを消せないためである。
 */
async function purgeShared(
  deps: CheckSandboxDeps,
  identity: CheckIdentity,
): Promise<void> {
  const uid = identity.uid;
  for (const dir of SHARED_TMP_DIRS) {
    // 他の実行が同時に消したファイルを読みかけると`find`は0以外で終わるので、終了コードは見ず、残りで判断する。
    await runToolOutput(deps, purgeDirsArgv(uid, dir), `purging ${dir}`, {
      ignoreExitCode: true,
    });
    await runToolOutput(deps, purgeFilesArgv(uid, dir), `purging ${dir}`, {
      ignoreExitCode: true,
    });
    const remaining = await runToolOutput(
      deps,
      remainingOfUidArgv(uid, dir),
      `checking ${dir}`,
      { ignoreExitCode: true },
    );
    if (remaining.trim() !== "") {
      throw new Error(
        `check sandbox: files of uid ${String(uid)} remain: ${firstLine(remaining)}`,
      );
    }
  }
  const ofUid = (entries: readonly IpcEntry[]) =>
    entries.filter((entry) => entry.uid === uid || entry.cuid === uid);
  const owned = ofUid(await deps.listIpc());
  if (owned.length === 0) return;
  await runToolOutput(
    deps,
    setprivArgv(identity, ipcrmArgv(owned)),
    "removing IPC objects",
    { ignoreExitCode: true },
  );
  const left = ofUid(await deps.listIpc());
  if (left.length > 0) {
    throw new Error(
      `check sandbox: IPC objects of uid ${String(uid)} remain: ${left.map((entry) => `${entry.kind} ${String(entry.id)}`).join(", ")}`,
    );
  }
}

/**
 * 枠の記録を読む。形が違って読めない記録は退避し、`notify`で1回知らせてから、記録が無いものとして扱う。
 * 読めない記録を残すと、その枠を取るたびに片付けが失敗し、枠をずっと使えなくなるためである。
 * 記録が指していたworktreeは取り戻せないので、noticeで運用者に任せる。
 */
async function readOrSetAside(
  deps: CheckSandboxDeps,
  index: number,
  uid: number,
  notify: (notice: CheckSlotNotice) => Promise<void>,
): Promise<SlotRecord | null> {
  try {
    return await deps.slotRecords.read(index);
  } catch (error) {
    if (!(error instanceof UnreadableSlotRecordError)) throw error;
  }
  const path = await deps.slotRecords.setAside(index);
  await notify({
    kind: "check_slot_record_unreadable",
    message: slotRecordUnreadableNoticeText({ index, uid, path }),
  });
  return null;
}

/**
 * 枠のロックを持った状態で、前の実行が残したものを片付ける。
 * 枠のuidのプロセスを止め、記録があればそのworktreeを取り戻してHOMEを消し、記録を消す。
 * 最後に共有の一時ディレクトリとIPCから枠のuidのものを消す。
 */
async function recoverSlot(
  deps: CheckSandboxDeps,
  index: number,
  uid: number,
  random: (() => number) | undefined,
  notify: (notice: CheckSlotNotice) => Promise<void>,
): Promise<void> {
  stoppedOrThrow(await reapUidProcesses(uid, deps.reap));
  const identity = newCheckIdentity(uid, random);
  const record = await readOrSetAside(deps, index, uid, notify);
  if (record !== null) {
    await takeBackDirs(deps, identity, record);
    await deps.slotRecords.clear(index);
  }
  await purgeShared(deps, identity);
}

/** 記録に書けるパス(正規化された2段以上の絶対パス)でなければ例外を投げる。読み直せない記録を書かないためである。 */
function assertRecordable(record: SlotRecord): void {
  if (parseSlotRecord(formatSlotRecord(record)) === null) {
    throw new Error(
      `check sandbox: the directories cannot be recorded: ${record.worktreeDir}, ${record.homeDir}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return maskSecrets(error instanceof Error ? error.message : String(error));
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
 * 枠を片付けられなかったときと、読めない枠の記録を退避したときは`onNotice`で知らせる。
 * 知らせるのに失敗しても、検査は止めずに`log`へ残す。
 * 1つの部品は、同時に1つの実行だけに使う。
 */
export function createCheckSandbox(opts: {
  readonly uids: readonly number[];
  readonly deps?: CheckSandboxDeps;
  readonly random?: () => number;
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
  readonly onNotice?: (notice: CheckSlotNotice) => Promise<void>;
  readonly log?: Logger;
}): CheckSandbox {
  const deps = opts.deps ?? defaultSandboxDeps();
  const log = opts.log ?? logger("check_sandbox");
  const indices = opts.uids.map((_, index) => index);
  let active: { identity: CheckIdentity; handle: SlotHandle } | null = null;
  // 動いているコンテナのイメージは変わらないので、前提を満たした結果は部品の寿命の間覚える。
  let imageReady = false;
  const assertImageReady = async (): Promise<void> => {
    if (imageReady) return;
    const problems = await checkImageProblems(opts.uids, deps);
    if (problems.length > 0) throw new CheckImageStaleError(problems);
    imageReady = true;
  };
  const notify = async (notice: CheckSlotNotice): Promise<void> => {
    if (opts.onNotice === undefined) return;
    try {
      await opts.onNotice(notice);
    } catch (error) {
      log.warn("check slot notice could not be recorded", {
        kind: notice.kind,
        notice: notice.message,
        error: errorMessage(error),
      });
    }
  };
  const current = (): CheckIdentity => {
    if (active === null) {
      throw new Error("check sandbox: no slot is held; call prepare first");
    }
    return active.identity;
  };
  /** 片付けまで済んだ枠を1つ取る。片付けられない枠は手放して飛ばす。 */
  const takeUsableSlot = async (): Promise<{
    handle: SlotHandle;
    uid: number;
  }> => {
    const skipped = new Set<number>();
    let lastReason = "";
    for (;;) {
      const candidates = indices.filter((index) => !skipped.has(index));
      if (candidates.length === 0) {
        throw new Error(
          `check sandbox: no check slot could be used: ${lastReason}`,
        );
      }
      const handle = await acquireSlot(candidates, deps.slots, {
        maxWaitMs: opts.maxWaitMs ?? SLOT_MAX_WAIT_MS,
        pollMs: opts.pollMs ?? SLOT_POLL_MS,
      });
      const uid = opts.uids[handle.index];
      if (uid === undefined) {
        await handle.release();
        throw new Error("check sandbox: slot index out of range");
      }
      try {
        await recoverSlot(deps, handle.index, uid, opts.random, notify);
        return { handle, uid };
      } catch (error) {
        await handle.release();
        skipped.add(handle.index);
        lastReason = errorMessage(error);
        await notify({
          kind: "check_slot_skipped",
          message: slotSkipNoticeText({
            index: handle.index,
            uid,
            reason: lastReason,
          }),
        });
      }
    }
  };
  return {
    wrap: (argv) => checkCommandArgv(current(), argv),
    prepare: async (dirs) => {
      // 記録を書く前、所有権に触れる前に確かめる。古いイメージで記録だけが残ると、次の準備も同じ例外で止まるためである。
      await assertImageReady();
      const record: SlotRecord = {
        worktreeDir: dirs.worktreeDir,
        homeDir: dirs.homeDir,
      };
      assertRecordable(record);
      await deps.lockDownRuntimeDir(WINDMILL_TMP_DIR);
      await deps.assertDirectory(dirs.worktreeDir);
      const { handle, uid } = await takeUsableSlot();
      const identity = newCheckIdentity(uid, opts.random);
      active = { identity, handle };
      // 渡す前に記録する。後始末が走らなくても、次にこの枠を取る実行が戻せるようにするためである。
      await deps.slotRecords.write(handle.index, record);
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
    // 枠のロックを持つ間なので、枠のuidのプロセスはすべてこの実行のものである。
    settle: async () => {
      stoppedOrThrow(await reapUidProcesses(current().uid, deps.reap));
    },
    release: async (dirs) => {
      if (active === null) return;
      const { identity, handle } = active;
      active = null;
      try {
        stoppedOrThrow(await reapUidProcesses(identity.uid, deps.reap));
        await takeBackDirs(deps, identity, dirs);
        // 枠の数が同時実行数より多いと、番号の大きい枠は次に使われるまで長く空く。その間、共有の一時ディレクトリに検査の残りを置かない。
        try {
          await purgeShared(deps, identity);
        } catch (error) {
          log.warn("shared files of the check slot remain", {
            slot: handle.index,
            uid: identity.uid,
            error: errorMessage(error),
          });
        }
        await deps.slotRecords.clear(handle.index);
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
 * 枠の記録が`dir`を指していれば、その枠のロックを取って片付ける。片付けたらtrueを返す。
 * 検査を実行したジョブが、取り消しやタイムアウトで後始末の前に止められると、所有権が残る。
 * そのままだとrootのgitが所有者の違いで実行を拒み、次の作業項目が止まる。
 * ロックを取れた枠は、その枠のuidのプロセスを止め、worktreeを取り戻し、HOMEを消し、記録を消す。
 * 記録はロックを取った後に読み直し、まだ`dir`を指すときだけ片付ける。
 * `maxWaitMs`待ってもロックを取れなければ、記録を読み直す。
 * もう`dir`を指さなければ、ロックを持つ実行が片付けを終えたので先へ進む。まだ指していれば`CheckSlotInUseError`を投げる。
 * ロックを持つのは、そのworktreeで検査している実行か、その枠を取って片付けている実行なので、worktreeに触れずに引き返すためである。
 * プロセスを止められないか、worktreeを取り戻せないときは、枠と理由を載せた`CheckOwnershipRestoreError`を投げる。
 * 読めない記録(`UnreadableSlotRecordError`)は、どのworktreeを指すか分からないので飛ばす。その枠を次に取る実行が退避して知らせる。
 * ただし、読めない記録があり、`dir`の下にrootでないものが残っていれば、その記録が`dir`を指していたとみなし、記録のパスを載せた`CheckOwnershipRestoreError`を投げる。
 * rootでないものが残ったworktreeでは、rootのgitが所有者の違いで実行を拒み、理由の分からない失敗になるためである。
 * 記録の読み取りのそれ以外の失敗は、そのまま投げる。
 * 記録がworktreeを指すと分かったら、枠のロックを取る前にイメージの前提(`checkImageProblems`)を確かめる。
 * 満たさなければ、所有権にも記録にも触れずに`CheckImageStaleError`を投げる。
 * 古いイメージには取り戻しの道具が無く、途中で失敗すると取り戻しの失敗に見えるためである。記録は残るので、イメージを作り直した後の準備が取り戻す。
 */
export async function restoreCheckOwnership(
  dir: string,
  uids: readonly number[],
  deps: CheckSandboxDeps,
  maxWaitMs: number = RESTORE_MAX_WAIT_MS,
): Promise<boolean> {
  const unreadable = new Map<number, UnreadableSlotRecordError>();
  const readRecord = async (index: number): Promise<SlotRecord | null> => {
    try {
      return await deps.slotRecords.read(index);
    } catch (error) {
      if (!(error instanceof UnreadableSlotRecordError)) throw error;
      unreadable.set(index, error);
      return null;
    }
  };
  const pointsHere = (record: SlotRecord | null): boolean =>
    record !== null && record.worktreeDir === dir;
  let imageReady = false;
  const assertImageReady = async (): Promise<void> => {
    if (imageReady) return;
    const problems = await checkImageProblems(uids, deps);
    if (problems.length > 0) throw new CheckImageStaleError(problems);
    imageReady = true;
  };
  let restored = false;
  for (const [index, uid] of uids.entries()) {
    if (!pointsHere(await readRecord(index))) continue;
    await assertImageReady();
    let handle: SlotHandle;
    try {
      handle = await acquireSlot([index], deps.slots, {
        maxWaitMs,
        pollMs: SLOT_POLL_MS,
      });
    } catch (error) {
      if (!(error instanceof CheckSlotsBusyError)) throw error;
      if (!pointsHere(await readRecord(index))) continue;
      throw new CheckSlotInUseError(index, uid);
    }
    try {
      const held = await readRecord(index);
      if (held === null || held.worktreeDir !== dir) continue;
      try {
        stoppedOrThrow(await reapUidProcesses(uid, deps.reap));
        await takeBackDirs(deps, newCheckIdentity(uid), held);
      } catch (error) {
        throw new CheckOwnershipRestoreError(
          `the worktree recorded by slot ${CHECK_USER_PREFIX}${String(index)} (uid ${String(uid)}) could not be taken back: ${errorMessage(error)}`,
        );
      }
      await deps.slotRecords.clear(index);
      restored = true;
    } finally {
      await handle.release();
    }
  }
  if (unreadable.size > 0 && (await deps.pathKind(dir)) === "directory") {
    const foreign = await runToolOutput(
      deps,
      notRootOwnedArgv(dir),
      `checking ${dir}`,
    );
    if (foreign.trim() !== "") {
      const records = [...unreadable.values()]
        .map((error) => error.message)
        .join(", ");
      throw new CheckOwnershipRestoreError(
        `an entry not owned by root remains (${firstLine(foreign)}) and no readable slot record names the worktree: ${records}`,
      );
    }
  }
  return restored;
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

/**
 * 枠の記録を、ロックファイルの隣の`slot-N.state`(0600)に置く。
 * 書くときは一時ファイルに書いてから置き換え、途中で止まっても壊れた記録を残さない。
 * 退避した記録は`slot-N.state.corrupt-<時刻>-<乱数>`になり、退避を重ねても前のものを上書きしない。
 */
function fileSlotRecordDeps(lockDir: string): SlotRecordDeps {
  const pathOf = (index: number): string =>
    join(lockDir, `slot-${String(index)}.state`);
  return {
    read: async (index) => {
      let text: string;
      try {
        text = await readFile(pathOf(index), "utf8");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const record = parseSlotRecord(text);
      if (record === null)
        throw new UnreadableSlotRecordError(index, pathOf(index));
      return record;
    },
    setAside: async (index) => {
      const destination = `${pathOf(index)}.corrupt-${String(Date.now())}-${randomUUID().slice(0, 8)}`;
      await rename(pathOf(index), destination);
      return destination;
    },
    write: async (index, record) => {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      const temporary = `${pathOf(index)}.tmp`;
      await writeFile(temporary, formatSlotRecord(record), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, pathOf(index));
    },
    clear: async (index) => {
      await rm(pathOf(index), { force: true });
    },
  };
}

/** `/proc/sysvipc`の3つの表を読む。無い表(IPCの無いカーネル)は空とみなす。 */
async function listSysvIpc(): Promise<IpcEntry[]> {
  const entries: IpcEntry[] = [];
  for (const kind of ["shm", "sem", "msg"] as const) {
    try {
      entries.push(
        ...parseSysvIpc(await readFile(`/proc/sysvipc/${kind}`, "utf8"), kind),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return entries;
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
      killAll: async (uid) => {
        // 送る先が1つも無いと`kill`は0以外で終わるので、終了コードは見ない。止まったかは呼び出し側が`/proc`で確かめる。
        await runCommand(killAllArgv(uid), {
          cwd: TOOL_CWD,
          env: { PATH: TOOL_PATH },
          timeoutMs: KILL_TIMEOUT_MS,
          maxOutputBytes: CHOWN_MAX_OUTPUT_BYTES,
        });
      },
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
    },
    slots: flockSlotDeps(lockDir),
    slotRecords: fileSlotRecordDeps(lockDir),
    listIpc: listSysvIpc,
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
    pathKind: async (path) => {
      try {
        return (await lstat(path)).isDirectory() ? "directory" : "other";
      } catch (error) {
        if (isNotFound(error)) return "missing";
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
    isExecutable: async (path) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readPasswd: () => readFile("/etc/passwd", "utf8"),
  };
}

const readPasswd = (): string => readFileSync("/etc/passwd", "utf8");

/** 本番の検査用の部品を作る。枠のuidは`resolveCheckPool`で決める。 */
export function checkSandboxFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  onNotice?: (notice: CheckSlotNotice) => Promise<void>,
): CheckSandbox {
  return createCheckSandbox({
    uids: resolveCheckPool(env, readPasswd),
    ...(onNotice === undefined ? {} : { onNotice }),
  });
}

/** 本番の設定の枠とイメージで、`checkImageProblems`を呼ぶ。 */
export function checkImageProblemsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> {
  return checkImageProblems(
    resolveCheckPool(env, readPasswd),
    defaultSandboxDeps(),
  );
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
