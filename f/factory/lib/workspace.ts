// 対象リポジトリとFactory自身のcloneについて、clone・fetch・worktreeを管理する。
// サブプロセスはすべて注入した`run`(`CommandRunner`)で実行するので、
// どの関数も偽のrunnerでテストできる。
// `CommandRunner`と`CommandResult`はここで定義し、同じ方法でコマンドを実行する
// `github.ts`と`claude.ts`も使う。

import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { jobTmpBase, jobTmpEnv } from "./job_tmp.ts";
import { escapeReasonSeparator, maskSecrets } from "./log.ts";
import {
  assertBranchName,
  assertGitHubName,
  assertSha,
  type GitIdentity,
  type ImplementDiffStat,
  isNumber,
  isRecord,
  isString,
} from "./types.ts";

// ---------------------------------------------------------------------------
// サブプロセスの実行(`github.ts`、`claude.ts`と共有)
// ---------------------------------------------------------------------------

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** 終了とプロセスグループの停止の後も出力パイプが閉じず、読み取りを打ち切った。別セッションへ抜けたプロセスが握っている場合に起き、そのプロセスは止められていない。打ち切っていなければ付かない。 */
  readonly outputAbandoned?: boolean;
};

export type CommandRunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /**
   * stdoutとstderrのそれぞれについて、保持するバイト数の上限。
   * 信頼できないコマンドの出力を、受け取った後の切り詰めだけに頼らないために使う。
   * パイプが詰まって子プロセスが止まらないよう、ストリームは最後まで読む。
   * 保持するのは先頭と末尾の半分ずつで、間を`omittedMarker`でつなぐ。
   * 指定しなければすべて保持する。
   */
  readonly maxOutputBytes?: number;
};

export type CommandRunner = (
  argv: readonly string[],
  options?: CommandRunOptions,
) => Promise<CommandResult>;

/**
 * プロセスを起動できなかったときに`CommandRunner`が投げる。
 * `Bun.spawn`の呼び出しだけを包むので、このエラーが出たなら、コマンドは1行も実行されていない。
 * 起動の後の失敗(出力の読み取りの失敗など)は含まれない。
 * 呼び出し側は、副作用が起きていないことの根拠にできる。
 * 元のエラーの`code`(`EAGAIN`、`ENOENT`など)、`errno`、`syscall`を引き継ぐ。
 */
export class SpawnError extends Error {
  readonly code: string | undefined;
  readonly errno: number | undefined;
  readonly syscall: string | undefined;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SpawnError";
    const fields = isRecord(cause) ? cause : {};
    this.code = isString(fields.code) ? fields.code : undefined;
    this.errno = isNumber(fields.errno) ? fields.errno : undefined;
    this.syscall = isString(fields.syscall) ? fields.syscall : undefined;
  }
}

/** `CommandRunner`に`timeoutMs`を渡さないときの、コマンド1回の上限(ミリ秒)。 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** setTimeoutが受け付ける上限(2^31-1ミリ秒)。超えると約1ミリ秒に丸められ、即時にタイムアウトしてしまう。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_OUTPUT_DRAIN_MS = 2_000;
const GROUP_POLL_MS = 50;
const POST_KILL_WAIT_MS = 1_000;

/**
 * 既定設定のランナーが、タイムアウトの発火から返るまでに上乗せしうる最大時間(ms)。
 * SIGKILLまでの猶予、終了後のグループ停止の猶予、SIGKILL後の待ち、出力待ちの合計。
 */
export const RUNNER_MAX_STOP_OVERHEAD_MS =
  DEFAULT_KILL_GRACE_MS * 2 + POST_KILL_WAIT_MS + DEFAULT_OUTPUT_DRAIN_MS;

export type BunCommandRunnerOptions = {
  /** タイムアウト時と、終了後に残ったプロセスを止めるときの、SIGTERMからSIGKILLまでの猶予。既定は5000ms。 */
  readonly killGraceMs?: number;
  /** 先頭プロセスの終了とグループの停止の後、出力の読み取り完了を待つ上限。超えたら読み取りを打ち切る。既定は2000ms。 */
  readonly outputDrainMs?: number;
};

/** 読み取りを打ち切ったときにstderrの末尾へ足す注記。 */
export const OUTPUT_ABANDONED_NOTE =
  "\n[factory: stopped reading output still held open by a process outside the command's process group]\n";

/**
 * `pid`のプロセスグループ全体に`signal`を送る。すでに終了していれば何もしない。
 * 直接起動したpidだけにシグナルを送っても、
 * タイムアウトしたコマンドが止まるとは限らない。
 * コマンドが自分で子プロセス(パイプラインを実行するシェルや
 * credential helperなど)を起動していると、その孫プロセスにはシグナルが届かず、
 * stdoutとstderrのパイプを開いたままにできる。
 * するとパイプの読み取りが孫プロセスの終了まで終わらず、
 * 気づかないうちにタイムアウトが効かなくなる。
 * `sh -c "trap '' TERM; sleep 5"`をpidだけでkillすると、
 * 5秒経つまで読み取りが終わらないことを確かめた。
 * そのため`detached: true`(POSIXの`setsid()`)で、
 * 子プロセスをプロセスグループのリーダーとして起動し、
 * `process.kill(-pid, signal)`でグループ全体に送る。
 * 先頭プロセスの終了後も、グループに残ったプロセスに使う(`reapProcessGroup`)。
 */
function killProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // すでに終了しているので、送る相手が無い。
  }
}

/** プロセスグループにメンバーが残っているかを返す。回収前のゾンビしか残っていない間もtrueを返す(workerはtiniが親を失った子をすぐ回収する)。 */
function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** グループが消えるまで、最大waitMsのあいだGROUP_POLL_MS刻みで待つ。消えればtrueを返す。 */
async function waitGroupGone(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await Bun.sleep(GROUP_POLL_MS);
    if (!processGroupAlive(pid)) return true;
  }
  return !processGroupAlive(pid);
}

/**
 * 先頭プロセスの終了後、グループに残ったプロセスを止める。誰も残っていなければ何もしない。
 * 残っていればSIGTERMを送り、graceMsのあいだ消えるのを待つ。残ればSIGKILLを送り、最大POST_KILL_WAIT_MS待ってから戻る。
 * SIGKILLの後も待つのは、戻った直後のロックの確かめや次のコマンドに、回収前のプロセスが見えないようにするためである。
 * メンバーが残っている間、グループIDは別のプロセスのPIDとして再利用されない。
 * ポーリングの間にメンバーが全員回収され、同じ番号を得たプロセスが自分でグループを作っていれば送信がそこへ届きうるが、
 * PIDはpid_maxまで順に払い出されるので数秒で戻るのは一周したときだけで、既存のタイムアウト時のSIGKILLタイマーと同じ水準の危険である。
 */
async function reapProcessGroup(pid: number, graceMs: number): Promise<void> {
  if (!processGroupAlive(pid)) return;
  killProcessGroup(pid, "SIGTERM");
  if (await waitGroupGone(pid, graceMs)) return;
  killProcessGroup(pid, "SIGKILL");
  await waitGroupGone(pid, POST_KILL_WAIT_MS);
}

/** promiseがms以内に確定すればtrueを返す。rejectも確定として扱う(結果は呼び出し側で改めてawaitする)。 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** signalが中断されたらreaderを取り消す(保留中のreadはdone: trueで返る)。戻り値は登録を外す関数。 */
function cancelOnAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return () => {};
  const cancel = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    cancel();
    return () => {};
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

/** streamを終わりまで(またはsignalが中断されるまで)読み、読めた分をUTF-8として返す。上限は無い。 */
export async function readStreamAll(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const release = cancelOnAbort(reader, signal);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    release();
  }
  const whole = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

const OMITTED_MARKER_PATTERN = /\[\.\.\. \d+ bytes omitted \.\.\.\]/;

/** `readStreamCapped`が、保持した先頭と末尾の間に入れる文字列を返す。 */
export function omittedMarker(bytes: number): string {
  return `\n[... ${String(bytes)} bytes omitted ...]\n`;
}

/**
 * `readStreamCapped`が間を捨てたときの`omittedMarker`の位置(文字数)を返す。無ければ-1。
 * 位置より前が、保持した先頭である。
 */
export function omittedMarkerIndex(text: string): number {
  return text.search(OMITTED_MARKER_PATTERN);
}

/**
 * `readStreamCapped`が`text`の途中を捨てたかを返す。
 * 途中を捨てた機械可読のレポートは解析してはいけない。
 */
export function isCappedOutput(text: string): boolean {
  return OMITTED_MARKER_PATTERN.test(text);
}

/**
 * `stream`を最後まで読み、先頭の`floor(maxBytes / 2)`バイトと、
 * 末尾の`maxBytes - floor(maxBytes / 2)`バイトだけを保持して文字列で返す。
 * 先頭は固定長のバッファ、末尾は固定長のリングバッファにコピーするので、
 * ストリームが長くてもメモリは増えない。
 * 間を捨てたときは、2つの部分を別々にデコードし、`omittedMarker(捨てたバイト数)`でつなぐ
 * (境界で切れたマルチバイト文字はU+FFFDになる)。
 * signalが中断されたら、それまでに保持した分で返す。
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const headLimit = Math.floor(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  const head = new Uint8Array(headLimit);
  let headSize = 0;
  const ring = new Uint8Array(tailLimit);
  let ringStart = 0;
  let ringSize = 0;
  let omitted = 0;

  const pushTail = (bytes: Uint8Array): void => {
    if (tailLimit === 0) {
      omitted += bytes.byteLength;
      return;
    }
    if (bytes.byteLength >= tailLimit) {
      omitted += ringSize + (bytes.byteLength - tailLimit);
      ring.set(bytes.subarray(bytes.byteLength - tailLimit), 0);
      ringStart = 0;
      ringSize = tailLimit;
      return;
    }
    const overflow = ringSize + bytes.byteLength - tailLimit;
    if (overflow > 0) {
      ringStart = (ringStart + overflow) % tailLimit;
      ringSize -= overflow;
      omitted += overflow;
    }
    const writeAt = (ringStart + ringSize) % tailLimit;
    const firstPart = Math.min(bytes.byteLength, tailLimit - writeAt);
    ring.set(bytes.subarray(0, firstPart), writeAt);
    ring.set(bytes.subarray(firstPart), 0);
    ringSize += bytes.byteLength;
  };

  const reader = stream.getReader();
  const release = cancelOnAbort(reader, signal);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      if (headSize < headLimit) {
        const take = Math.min(headLimit - headSize, value.byteLength);
        head.set(value.subarray(0, take), headSize);
        headSize += take;
        offset = take;
      }
      if (offset < value.byteLength) pushTail(value.subarray(offset));
    }
  } finally {
    release();
  }

  const tail = new Uint8Array(ringSize);
  const firstPart = Math.min(ringSize, tailLimit - ringStart);
  tail.set(ring.subarray(ringStart, ringStart + firstPart), 0);
  tail.set(ring.subarray(0, ringSize - firstPart), firstPart);
  const decoder = new TextDecoder();
  if (omitted === 0) {
    const whole = new Uint8Array(headSize + ringSize);
    whole.set(head.subarray(0, headSize), 0);
    whole.set(tail, headSize);
    return decoder.decode(whole);
  }
  return `${decoder.decode(head.subarray(0, headSize))}${omittedMarker(omitted)}${decoder.decode(tail)}`;
}

/**
 * タイマーに渡すミリ秒を、setTimeoutが正しく扱える範囲(0以上2^31-1以下)に収めて返す。
 * 上限を超える値は上限にそろえ、負の値は0にする。有限でない値は期限が不定になるので例外を投げる。
 */
export function boundedTimerMs(ms: number): number {
  if (!Number.isFinite(ms)) {
    throw new Error(`timer duration must be finite: ${String(ms)}`);
  }
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}

/** `Bun.spawn`の呼び出しだけを包み、起動の失敗を`SpawnError`にして投げる。 */
function spawnProcess(argv: readonly string[], runOptions: CommandRunOptions) {
  try {
    return Bun.spawn({
      cmd: [...argv],
      ...(runOptions.cwd !== undefined ? { cwd: runOptions.cwd } : {}),
      env: runOptions.env !== undefined ? { ...runOptions.env } : {},
      stdin: runOptions.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    throw new SpawnError(error);
  }
}

/**
 * `Bun.spawn`で新しいセッション(プロセスグループ)として起動する`CommandRunner`を作って返す。
 * タイムアウトしたらグループにSIGTERMを送り、`killGraceMs`後にSIGKILLを送る。
 * 先頭プロセスが終わったら、正常終了でもグループに残ったプロセスを止める(`reapProcessGroup`)。
 * 出力が`outputDrainMs`待っても閉じなければ読み取りを打ち切り、`outputAbandoned`を付ける。
 * 別セッションへ抜けたプロセスにはグループへのkillが届かず、パイプを握ったままだと読み取りもtimeoutも終わらないためである。
 */
export function createBunCommandRunner(
  options: BunCommandRunnerOptions = {},
): CommandRunner {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const outputDrainMs = options.outputDrainMs ?? DEFAULT_OUTPUT_DRAIN_MS;

  return async (argv, runOptions = {}) => {
    // 起動の前に確かめる。不正な値でプロセスを起動して取り残さないため。
    const timeoutMs = boundedTimerMs(
      runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const proc = spawnProcess(argv, runOptions);

    if (
      runOptions.stdin !== undefined &&
      proc.stdin !== undefined &&
      typeof proc.stdin !== "number"
    ) {
      proc.stdin.write(runOptions.stdin);
      proc.stdin.end();
    }

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(proc.pid, "SIGKILL");
      }, killGraceMs);
    }, timeoutMs);

    const abort = new AbortController();
    const readOutput = (stream: ReadableStream<Uint8Array>): Promise<string> =>
      runOptions.maxOutputBytes === undefined
        ? readStreamAll(stream, abort.signal)
        : readStreamCapped(stream, runOptions.maxOutputBytes, abort.signal);
    const outputs = Promise.all([
      readOutput(proc.stdout),
      readOutput(proc.stderr),
    ]);
    // 先頭プロセスの終了を待つ間にrejectしても未処理扱いにしない(結果は下で改めてawaitする)。
    outputs.catch(() => {});

    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    await reapProcessGroup(proc.pid, killGraceMs);
    const drained = await settlesWithin(outputs, outputDrainMs);
    if (!drained) abort.abort();
    const [stdout, stderr] = await outputs;

    if (drained) return { stdout, stderr, exitCode, timedOut };
    return {
      stdout,
      stderr: `${stderr}${OUTPUT_ABANDONED_NOTE}`,
      exitCode,
      timedOut,
      outputAbandoned: true,
    };
  };
}

/** 既定の`CommandRunner`。既定の設定の`createBunCommandRunner()`。 */
export const runCommand: CommandRunner = createBunCommandRunner();

// ---------------------------------------------------------------------------
// gitのargvと環境変数の組み立て
// ---------------------------------------------------------------------------

export type GitCommandOptions = {
  /**
   * リモートと通信する操作(clone、fetch、push)か。
   * `true`ならghのcredential helperを加え、環境変数に`GH_TOKEN`が要る。
   */
  readonly network?: boolean;
};

/**
 * 設定ファイルの値にかかわらず、すべてのgitの実行に固定する設定。
 * `-c`はコマンドラインの設定で、`.git/config`、`config.worktree`、
 * グローバル、システムのどの設定ファイルよりも優先される。
 * `extensions.worktreeConfig`は`-c`では無効にできず、`config.worktree`は
 * 有効にされると読まれる。だから、読まれて困る項目は設定ファイルの側ではなく、ここで固定する。
 * - `core.hooksPath`、`core.fsmonitor`、`core.askPass`:
 *   設定ファイルに書かれたプログラムを、gitに実行させない。
 *   `core.askPass`は空にすると、環境変数`SSH_ASKPASS`も読まれなくなる。
 * - `commit.gpgsign`、`push.gpgSign`: commitとpushの署名で、`gpg.program`に書かれたプログラムを実行させない。
 * - `core.symlinks`: worktreeの検証が前提にする値。
 *   `.git/config`や`config.worktree`で`true`に戻させない。
 * - `core.excludesFile`、`core.attributesFile`: `/dev/null`にして、
 *   `$HOME/.config/git/ignore`と`$HOME/.config/git/attributes`(設定が無いときの既定の置き場)を読ませない。
 *   `GIT_CONFIG_GLOBAL`では、この2つのファイルは止まらない。
 * - `credential.helper`: 空にして、設定ファイルのcredential helperを消す。
 */
export const FIXED_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.askPass", ""],
  ["core.symlinks", "false"],
  ["core.excludesFile", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["commit.gpgsign", "false"],
  ["push.gpgSign", "false"],
  ["credential.helper", ""],
];

/**
 * `args`の前に共通の安全策のオプションを付けた、gitのargvを返す。
 * `FIXED_GIT_CONFIG`の設定を`-c`で固定する。
 * 悪意のあるcloneや検査コマンドが書いた設定で、任意のプログラムを実行させないため。
 * ネットワーク操作のときだけ、ghのcredential helperを加え直す。
 * システムとグローバルの設定は、`localGitEnv`の環境変数で読まない。
 *
 * このモジュールのgitの実行では、ほかに次を守る。
 * - `GH_TOKEN`は、ネットワーク操作(clone、fetch、push)の
 *   環境変数(`networkGitEnv`)にだけ入れる。
 *   ローカルだけの操作(rev-parse、status、add、commit、worktree、diff)は
 *   トークンを持たない`localGitEnv`を使う。
 * - 利用者に由来する位置引数(URL、ディレクトリ、sha、ブランチ)の前には`--`を置き、
 *   `-`で始まる値をオプションと誤読させない。例外は次の6つで、代わりに
 *   `assertSha`や`assertBranchName`の入力検証で、先頭が`-`の値を防ぐ。
 *   - `git rev-parse`: `-- <rev>`は他のサブコマンドと同じには動かない。
 *     `--verify`では「リビジョンが無い」扱いになり、`--verify`なしでは
 *     オプションの解釈を止めずに、出力の前に`--`の行をそのまま出す(実際に確かめた)。
 *   - `git gtr new`: core gitではない外部のサブコマンドで、`--`を扱える保証が無い。
 *   - `pushNewBranch`の`git ls-remote`: リモート名の後の`--`を区切りではなくパターンとして扱う
 *     (実際に確かめた)。パターンは`HEAD`と、`assertBranchName`で検証したブランチから作った`refs/heads/`で始まるrefである。
 *   - `readGitShowFile`の`git show <ref>:<path>`: `--`を付けてもエラーにならず、
 *     気づかないうちにgitが返す内容が変わる。`ref`を検証すれば、`path`も守られる
 *     (`path`は常に、検証済みで`:`を含まない`ref`と、こちらで入れた`:`に続くため)。
 *   - `createGtrWorktree`の`git reset --hard <ref>`(再利用時と、新しく作ったworktreeで
 *     プロセスを止めたとき): `--hard`はパスを取らず、
 *     `--`を付けるとエラーになる
 *     (「fatal: Cannot do hard reset with paths」、実際に確かめた)。
 *   - `ensureFactoryClone`の`git checkout -B <branch> refs/remotes/origin/<branch>`と、
 *     `createGtrWorktree`の`git checkout -f --no-track -B <branch> <ref>`: 起点の前に
 *     `--`を付けると、`checkout`は起点をrefではなく復元するパスとして扱う。
 *     `branch`は関数の先頭で`assertBranchName`により検証している。
 * - GitHubに由来する識別子(owner、repo、sha、branch)は、URL・ref・ディレクトリのパスに
 *   埋め込む前に`assertGitHubName`、`assertSha`、
 *   `assertBranchName`(`types.ts`)で検証する。
 * - `commitAndPush`は、gitを実行するworktreeが、
 *   想定のリポジトリに登録されたworktreeであることと、
 *   `.git`ファイルの`gitdir:`がそのリポジトリの`.git/worktrees/<name>/`の
 *   下を指すことを確かめる。
 *   `.git`ファイルの差し替えなどで別の場所に向けられたworktreeを操作しないため。
 */
export function buildGitArgv(
  args: readonly string[],
  options: GitCommandOptions = {},
): string[] {
  return [
    "git",
    ...FIXED_GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ...(options.network === true
      ? ["-c", "credential.helper=!gh auth git-credential"]
      : []),
    ...args,
  ];
}

const REMOTE_TRACKING_PREFIX = "refs/remotes/origin/";

/** `ensureRepo`のcloneが作る、`origin`の既定のブランチを指すシンボリックref。 */
const REMOTE_HEAD_REF = `${REMOTE_TRACKING_PREFIX}HEAD`;

/**
 * `origin`の`branch`の追跡refを、完全な名前で返す。
 * 短い名前の`origin/<branch>`は、検査コマンドが作る
 * `refs/heads/origin/<branch>`や`refs/tags/origin/<branch>`が先に解決されうるため、使わない。
 * `branch`は呼び出し側が`assertBranchName`で検証済みのものを渡す。
 */
function remoteTrackingRef(branch: string): string {
  return `${REMOTE_TRACKING_PREFIX}${branch}`;
}

/**
 * ネットワークを使わないgitの操作の環境変数を返す。`GH_TOKEN`は含めない。
 * 渡す環境変数は、ここで挙げるものとHOMEとPATH、ジョブの中ではジョブごとのTMPDIRだけである。
 * HOMEは、gitが起動するghなどの子プロセスと、gitの`~`の展開
 * (`.git/config`のパスの`~`、httpsの`$HOME/.netrc`)のために渡す。
 * workerのHOMEには`.netrc`を置かない前提である。
 * グローバルの設定としては、下の環境変数と`FIXED_GIT_CONFIG`で読ませない。
 * `pr_workflow_support.ts`も、gitの実行にこの関数と`buildGitArgv`を使う。
 */
export function localGitEnv(
  home?: string,
  path?: string,
  tmpDir?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    // `refs/replace/`で別のオブジェクトに差し替えられた内容を読まない。
    // 差し替えのrefは対象リポジトリの検査コマンドが作れ、gitが読む内容を検査の前提と食い違わせうるため。
    GIT_NO_REPLACE_OBJECTS: "1",
    // システムとグローバル(`$HOME/.gitconfig`、XDGの`git/config`)の設定と、システムのgitattributesを読まない。
    // 実行する環境ごとに値が違い、リポジトリの設定と検証の前提が食い違うため。
    // コミットのauthorは`GIT_AUTHOR_*`、認証は`GH_TOKEN`で渡すので、これらの設定は要らない。
    // `GIT_CONFIG_GLOBAL`を指定すると、`$HOME/.gitconfig`と`$XDG_CONFIG_HOME/git/config`の両方が読まれなくなる。
    // XDGの`ignore`と`attributes`は設定ファイルではないので止まらず、`FIXED_GIT_CONFIG`で止める。
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    // httpsだけを許す。`.git/config`の`protocol.<name>.allow`や`remote.origin.url`で、
    // `ext::`などの別の転送を使わせないため。この環境変数は`protocol.*`の設定より優先される。
    // `GH_TOKEN`や非公開のコミットを、`ext::`のコマンドに渡さない。
    GIT_ALLOW_PROTOCOL: "https",
  };
  const resolvedHome = home ?? process.env.HOME;
  if (resolvedHome !== undefined) env.HOME = resolvedHome;
  const resolvedPath = path ?? process.env.PATH;
  if (resolvedPath !== undefined) env.PATH = resolvedPath;
  const resolvedTmp = tmpDir ?? jobTmpEnv().TMPDIR;
  if (resolvedTmp !== undefined) env.TMPDIR = resolvedTmp;
  return env;
}

/**
 * clone・fetch・pushの環境変数を返す。ghのcredential helperのために`GH_TOKEN`を含める。
 */
function networkGitEnv(
  ghToken: string,
  home?: string,
  path?: string,
): Record<string, string> {
  return { ...localGitEnv(home, path), GH_TOKEN: ghToken };
}

/**
 * 失敗した`CommandResult`から、秘密を伏せた`Error`を作って返す。
 * このモジュールで投げる例外の形をそろえるため。
 */
function gitError(context: string, result: CommandResult): Error {
  return new Error(maskSecrets(`${context}: ${result.stderr.trim()}`));
}

/**
 * `ref`が今指すshaを、名前を完全に一致させて読む。無ければ`null`を返す。
 * `git show-ref --verify`は`refs/`で始まる完全な名前だけを引き、ほかのrefへ解決し直さない。
 * `rev-parse`は完全な名前でも、そのrefが無いと`refs/heads/<ref>`などへ解決し直す。
 * 対象リポジトリの検査コマンドは`refs/heads/refs/remotes/origin/<branch>`のようなrefを作れるので、
 * 追跡refが無いときに、別のcommitを追跡refの先頭として読んでしまう。
 * リモート追跡のrefは、この関数で読む(`scripts/lint-no-short-remote-ref.ts`が短い名前を止める)。
 * 読み取りだけのローカルの操作である。
 * 戻り値が`null`になるのは、gitが「有効なrefではない」と報告したときだけで、
 * それ以外の失敗(safe.directory、壊れたリポジトリ、ロックなど)はstderrつきで例外にする。
 * 失敗の理由を「refが無い」に潰さないためである。
 * メッセージの言語に左右されないよう`LC_ALL=C`で実行する。
 * `--`はrefの前に置く。`show-ref`は`--`を受け付ける。
 */
export async function readExactRef(opts: {
  readonly run: CommandRunner;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly ref: string;
}): Promise<string | null> {
  if (!opts.ref.startsWith("refs/")) {
    throw new Error(`not a full ref name: ${JSON.stringify(opts.ref)}`);
  }
  const result = await opts.run(
    buildGitArgv(["show-ref", "--verify", "--hash", "--", opts.ref]),
    { cwd: opts.cwd, env: { ...opts.env, LC_ALL: "C" } },
  );
  if (result.exitCode !== 0) {
    if (result.stderr.includes("not a valid ref")) return null;
    throw gitError(`git show-ref --verify ${opts.ref} failed`, result);
  }
  const sha = result.stdout.trim();
  if (sha === "") {
    throw new Error(`git show-ref --verify ${opts.ref} printed an empty sha`);
  }
  return sha;
}

/**
 * 出力を値として判断に使うコマンドで、出力の読み取りを打ち切っていれば(`outputAbandoned`)例外を投げる。
 * 打ち切った出力は途中で切れていることがあり、終了コードが0でも、検査や照合に使うと見落としになるため。
 * 対象は、秘密情報の検査に渡す差分とそのレポート、保護パス・symlink・`package.json`のscriptsの判定に使う変更の一覧と中身、
 * 差分の大きさ、検証したツリーの照合に使う`write-tree`、worktreeの一覧である。
 */
export function assertOutputComplete(
  context: string,
  result: CommandResult,
): void {
  if (result.outputAbandoned === true)
    throw new Error(`${context}: output was abandoned`);
}

/**
 * `dir`の設定に`core.symlinks false`を書き込む。失敗したら例外を投げる。
 * このモジュールのgitは`buildGitArgv`の`-c core.symlinks=false`で動くので、
 * ここで書く値は、このモジュールを通さずに実行されるgit
 * (worktreeの中でClaudeや検査コマンドが実行するもの)のための既定である。
 * 書かないと、そのgit(`git status`、`add -A`、`commit`、`reset --hard`)は、
 * gitの既定の`core.symlinks=true`で動く。
 * すると`reset --hard`がコミットされたシンボリックリンクを本物のリンクとして作り直し、
 * 次のコミットで`typechange`として現れる。
 * worktreeはどれもメインのcloneの`.git/config`を読むため、
 * メインのcloneに書けば全worktreeに効く。
 * `ensureRepo`がclone・fetchの成功のたびに呼ぶ。
 * `.git/config`や`config.worktree`の値は、`-c`が優先されるので、このモジュールのgitには効かない。
 */
async function persistNoSymlinksConfig(
  run: CommandRunner,
  dir: string,
  home?: string,
  path?: string,
): Promise<void> {
  const result = await run(buildGitArgv(["config", "core.symlinks", "false"]), {
    cwd: dir,
    env: localGitEnv(home, path),
  });
  if (result.exitCode !== 0) {
    throw gitError("git config core.symlinks false failed", result);
  }
}

/**
 * 1つのリポジトリのディレクトリ配下のgitの操作をすべて直列にするロックのパスを返す。
 * 配下とは、`ensureRepo`のメインのcloneと、同じ親の下のworktreeである。
 * `repoDir`は常に`<owner-repo-dir>/main`なので、その親は`ensureRepo`がロックする
 * `<baseDir>/<owner>/<repo>`と同じになる。
 * 同じリポジトリを触る並行のフローの間で`.git/index.lock`の競合を避けるため、
 * `addDetachedWorktree`、`createGtrWorktree`、`removeWorktree`、
 * `commitAndPush`で共有する。
 */
function repoLockPath(repoDir: string): string {
  return `${dirname(repoDir)}/main.lock`;
}

// ---------------------------------------------------------------------------
// ファイルの存在確認(テスト用に注入できる)
// ---------------------------------------------------------------------------

export type PathExists = (path: string) => Promise<boolean>;

export const pathExists: PathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// 要件定義のディレクトリを扱うファイル操作。
// `pipeline_generate.ts`が試行ごとのディレクトリを読み書きし、
// `cleanup_db.ts`が古いものを消す。
// テストで実際のファイルシステムに触れないよう、呼び出し側は引数で受け取り、
// 既定でここの実装を使う。
// ---------------------------------------------------------------------------

export type ReadDir = (path: string) => Promise<string[]>;

/**
 * ディレクトリ直下のエントリー名(ファイルとサブディレクトリの両方)を返す。再帰はしない。
 * `pipeline_generate.ts`が、
 * Claudeが`requirements.md`と並べて書いた`.drawio`を探すのに使う。
 */
export const readDirEntries: ReadDir = (path) => readdir(path);

export type ReadTextFile = (path: string) => Promise<string>;

export const readTextFile: ReadTextFile = (path) => readFile(path, "utf8");

export type WriteTextFile = (path: string, content: string) => Promise<void>;

export const writeTextFile: WriteTextFile = (path, content) =>
  writeFile(path, content);

export type CopyFile = (source: string, destination: string) => Promise<void>;

export const copyFileTo: CopyFile = (source, destination) =>
  copyFile(source, destination);

export type RemovePath = (path: string) => Promise<void>;

/** `path`(ファイルまたはディレクトリ)を再帰的に削除する。存在しなければ何もしない。 */
export const removePath: RemovePath = (path) =>
  rm(path, { recursive: true, force: true });

export type MakeDir = (path: string) => Promise<void>;

export const makeDir: MakeDir = async (path) => {
  await mkdir(path, { recursive: true });
};

export type EnsureEmptyDirOptions = {
  readonly exists?: PathExists;
  readonly remove?: RemovePath;
  readonly mkdir?: MakeDir;
};

/**
 * `dir`を空のディレクトリにする。すでにあれば再帰的に削除してから作り直す。
 * `pipeline_generate.ts`が要件定義の生成の試行のたびに最初に呼ぶ。
 * 再試行で、前の試行の`requirements.md`の編集や`.drawio`の残りを見せないため。
 */
export async function ensureEmptyDir(
  dir: string,
  opts: EnsureEmptyDirOptions = {},
): Promise<void> {
  const exists = opts.exists ?? pathExists;
  const remove = opts.remove ?? removePath;
  const mkdirFn = opts.mkdir ?? makeDir;
  if (await exists(dir)) {
    await remove(dir);
  }
  await mkdirFn(dir);
}

export type RemoveEmptyDir = (path: string) => Promise<boolean>;

/**
 * `path`が空のディレクトリのときだけ削除する。削除したら`true`を返す。
 * 空でないときと存在しないときは、どちらも「することが無い」として`false`を返し、
 * 例外は投げない。
 * `cleanup_db.ts`が、
 * 最後の`wi-<id>`を消した後の空の`issue-<N>`をできる範囲で片付けるのに使う。
 * 別の作業項目の`wi-<id>`が残っていれば消さない。
 */
export const removeEmptyDir: RemoveEmptyDir = async (path) => {
  try {
    await rmdir(path);
    return true;
  } catch (err) {
    if (
      isErrnoLike(err) &&
      (err.code === "ENOTEMPTY" || err.code === "ENOENT")
    ) {
      return false;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// withRepoLock: ロックファイルによる排他
// ---------------------------------------------------------------------------

export type LockFs = {
  /** `content`を書いた`lockPath`をアトミックに作る。すでにあれば`false`を返す。 */
  readonly tryCreate: (lockPath: string, content: string) => Promise<boolean>;
  readonly read: (lockPath: string) => Promise<string | null>;
  /** ロックファイルのmtime(エポックからのミリ秒)。無ければ`null`。 */
  readonly mtimeMs: (lockPath: string) => Promise<number | null>;
  /** ロックを削除する(内部ではrenameしてからunlinkする)。すでに無ければ何もしない。 */
  readonly remove: (lockPath: string) => Promise<void>;
  /**
   * `lockPath`の親ディレクトリを作る(`mkdir -p`に当たる)。
   * 最初の`tryCreate`の前に1回呼ぶ。
   * コンテナの初回の実行では、cloneより前なので`ensureFactoryClone`のロックの親
   * (`/workspaces/factory/`など)がまだ無い。すると`tryCreate`の`open(path, "wx")`が
   * `ENOENT`で失敗するが、
   * `tryCreate`が「ロックされている」とみなすのは`EEXIST`だけである。
   * 省略できる。メモリ上の`Map`で作る偽の`LockFs`(多くのテストが使う)には作るべき
   * ディレクトリが無いので、省略すれば`withRepoLock`は呼び出しを飛ばす。
   */
  readonly ensureLockDir?: (lockPath: string) => Promise<void>;
};

type ErrnoLike = Error & { readonly code?: string };

function isErrnoLike(err: unknown): err is ErrnoLike {
  if (!(err instanceof Error)) return false;
  const maybeCode = (err as { code?: unknown }).code;
  return maybeCode === undefined || typeof maybeCode === "string";
}

export const defaultLockFs: LockFs = {
  ensureLockDir: async (lockPath) => {
    await mkdir(dirname(lockPath), { recursive: true });
  },
  tryCreate: async (lockPath, content) => {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if (isErrnoLike(err) && err.code === "EEXIST") {
        return false;
      }
      throw err;
    }
  },
  read: async (lockPath) => {
    try {
      return await readFile(lockPath, "utf8");
    } catch {
      return null;
    }
  },
  mtimeMs: async (lockPath) => {
    try {
      const info = await stat(lockPath);
      return info.mtimeMs;
    } catch {
      return null;
    }
  },
  remove: async (lockPath) => {
    // renameしてからunlinkする。ロックが他の誰かにすでに置き換えられたか消されていれば、
    // renameが`ENOENT`で失敗するので、今`lockPath`にある別のファイルを消さずに済む。
    const tempPath = `${lockPath}.removing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await rename(lockPath, tempPath);
    } catch (err) {
      if (isErrnoLike(err) && err.code === "ENOENT") return;
      throw err;
    }
    await unlink(tempPath);
  },
};

type LockFileContent = { readonly token: string };

/**
 * `value`がロックファイルの中身の形かを返す。
 * 述語の型は、その場のオブジェクトリテラルの型ではなく名前を付けた別名にする。
 * `scripts/lint-no-type-assertions.ts`は波括弧の深さで型ガードの範囲を推定するため、
 * リテラルの型だと、関数本体ではなくリテラルの`}`で型ガードの範囲が終わったと誤認する。
 */
function isLockFileContent(value: unknown): value is LockFileContent {
  if (typeof value !== "object" || value === null) return false;
  if (!("token" in value)) return false;
  return typeof (value as { token: unknown }).token === "string";
}

function parseLockToken(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isLockFileContent(parsed)) return null;
  return parsed.token;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `withRepoLock`がロックを取れるまで待つ上限(ミリ秒)の既定。 */
export const REPO_LOCK_MAX_WAIT_MS = 5 * 60_000;
/** `withRepoLock`がロックの空きを確かめる間隔(ミリ秒)の既定。 */
export const REPO_LOCK_POLL_MS = 200;

export type WithRepoLockOptions<T> = {
  readonly lockPath: string;
  readonly fn: () => Promise<T>;
  readonly lockFs?: LockFs;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * mtimeがこれより古いロックファイルは、異常終了した持ち主が残したものとみなす。
   * 既定は10分。
   */
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
};

/**
 * `lockPath`の排他ロックを持ったまま`fn`を実行し、その結果を返す。
 * 1つのworkerコンテナの中で、並行する呼び出し(同じリポジトリに`ensureRepo`を呼ぶ
 * 2つのフローなど)を直列にする。待っても取れなければ例外を投げる。
 *
 * `flock(2)`ではなく、ロックファイルで排他する(アトミックな排他的作成、mtimeによる
 * 古さの判定、取得ごとのトークン)。Bun・Nodeの標準にflockのバインディングが無く、
 * `flock(1)`のCLIでプロセス内の非同期コールバックを包むのは不安定なため。
 * 解放はトークンが一致するときだけ行うので、古いとみなされて他の持ち主に取り直された
 * ロックを消すことは無い。
 */
export async function withRepoLock<T>(
  opts: WithRepoLockOptions<T>,
): Promise<T> {
  const lockFs = opts.lockFs ?? defaultLockFs;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? REPO_LOCK_POLL_MS;
  // このロックは最初のclone・fetchだけでなく、リポジトリ配下のgitの操作すべて
  // (ensureRepo、addDetachedWorktree、createGtrWorktree、removeWorktree、commitAndPush)で
  // 共有するので、先に並んだ遅いclone・checkoutを待てるだけの余裕が要る。
  const maxWaitMs = opts.maxWaitMs ?? REPO_LOCK_MAX_WAIT_MS;
  const deadline = now().getTime() + maxWaitMs;
  const token = crypto.randomUUID();

  await lockFs.ensureLockDir?.(opts.lockPath);

  for (;;) {
    const created = await lockFs.tryCreate(
      opts.lockPath,
      JSON.stringify({ token }),
    );
    if (created) break;

    const mtimeMs = await lockFs.mtimeMs(opts.lockPath);
    if (mtimeMs !== null && now().getTime() - mtimeMs > staleMs) {
      await lockFs.remove(opts.lockPath);
      continue;
    }

    if (now().getTime() >= deadline) {
      throw new Error(
        `withRepoLock: timed out waiting for lock at ${opts.lockPath}`,
      );
    }
    await sleep(pollMs);
  }

  try {
    return await opts.fn();
  } finally {
    // ロックがまだ自分のものであるときだけ解放する。`fn()`が長引いて、
    // 待っていた他の呼び出しが古いとみなして取り直していれば、
    // ここで消すと新しい持ち主のロックを奪ってしまう。
    const current = await lockFs.read(opts.lockPath);
    const currentToken = current !== null ? parseLockToken(current) : null;
    if (currentToken === token) {
      await lockFs.remove(opts.lockPath);
    }
  }
}

// ---------------------------------------------------------------------------
// worktreeのgitdirの検証
// ---------------------------------------------------------------------------

export type VerifyWorktreeGitdirOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
};

/**
 * worktreeの`.git`ファイルが指す管理ディレクトリを、gitと同じ読み方で返す
 * (ちょうど`gitdir: `の後のバイト列から、末尾のLFかCRLFを1つ除いたもの)。
 * ただし`git worktree add`が書く正規の形
 * (前後に空白も制御文字も無い絶対パス)のときだけで、
 * それ以外(空白が2つ、タブ、末尾の空白、相対パス)は`null`を返す。
 * 正規でない形では、緩く解釈したディレクトリとgitが読むディレクトリが食い違うため。
 */
function parseCanonicalGitPointer(content: string): string | null {
  const body = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  const prefix = "gitdir: ";
  if (!body.startsWith(prefix)) return null;
  const path = body.slice(prefix.length);
  if (!path.startsWith("/")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するのが目的
  if (/[\x00-\x1f\x7f]/.test(path) || path !== path.trimEnd()) return null;
  return path;
}

/**
 * worktreeの中でgitを実行する前に、次をすべて確かめる。
 * どれかが成り立たなければ例外を投げる。
 * - `git worktree list`で、`repoDir`に登録されたworktreeである。
 * - `.git`ファイルの`gitdir:`の指す先が、`realpath(<repoDir>/.git/worktrees)`の直下にある
 *   (`..`やシンボリックリンクで別の場所へ向けられないよう、
 *   realpathで解決して比べる)。
 * - 管理ディレクトリの`gitdir`(`git worktree add`が書く逆向きの参照)が、
 *   `<realpath(dir)>/.git`を指す。
 * `.git`ファイルが別の場所へ向けられたworktreeを操作しないため。
 * 向け先のgitdirは独自の`config`を持ち込め、たとえば次の`git add`が実行する
 * `filter.<x>.clean`のコマンドを仕込める。
 */
export async function verifyWorktreeGitdir(
  opts: VerifyWorktreeGitdirOptions,
): Promise<void> {
  const entries = await listWorktrees({ run: opts.run, repoDir: opts.repoDir });
  const registered = entries.some((entry) => entry.path === opts.dir);
  if (!registered) {
    throw new Error(
      `worktree ${opts.dir} is not registered under ${opts.repoDir} (git worktree list)`,
    );
  }

  const readTextFile =
    opts.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const resolveReal = opts.realpath ?? ((path: string) => realpath(path));
  const target = parseCanonicalGitPointer(
    await readTextFile(`${opts.dir}/.git`),
  );
  const worktreesDir = `${opts.repoDir}/.git/worktrees`;
  const notUnder = new Error(
    `worktree ${opts.dir}: .git file does not point under ${worktreesDir}/`,
  );
  if (target === null) throw notUnder;
  let realTarget: string;
  let realWorktreesDir: string;
  try {
    realTarget = await resolveReal(target);
    realWorktreesDir = await resolveReal(worktreesDir);
  } catch {
    throw notUnder;
  }
  if (dirname(realTarget) !== realWorktreesDir) throw notUnder;

  const backPointer = (await readTextFile(`${realTarget}/gitdir`)).trim();
  const expectedBackPointer = `${await resolveReal(opts.dir)}/.git`;
  if (backPointer !== expectedBackPointer) {
    throw new Error(
      `worktree ${opts.dir}: the admin dir's gitdir back-pointer names ${backPointer}, not ${expectedBackPointer}`,
    );
  }
}

// ---------------------------------------------------------------------------
// worktreeの`.git`ファイルのスナップショット(implementフロー)
// ---------------------------------------------------------------------------

/** `readWorktreeGitPointer`が使う2つのファイル操作。テスト用に注入できる。 */
export type WorktreeGitPointerFs = {
  readonly lstat: (path: string) => Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readonly readFile: (path: string) => Promise<string>;
};

const defaultWorktreeGitPointerFs: WorktreeGitPointerFs = {
  lstat: (path) => lstat(path),
  readFile: (path) => readFile(path, "utf8"),
};

export const WORKTREE_GIT_POINTER_MODIFIED_MESSAGE =
  "worktree git pointer was modified";

/**
 * Claudeの実行がworktreeの`.git`ファイルを変更した(または置き換えた)ことを表す。
 * そのままだと、そこで次に実行するgitのコマンドが別のgitdirの設定とフックを読む。
 */
export class WorktreeGitPointerModifiedError extends Error {
  constructor() {
    super(WORKTREE_GIT_POINTER_MODIFIED_MESSAGE);
    this.name = "WorktreeGitPointerModifiedError";
  }
}

/**
 * `<worktreeDir>/.git`の中身を返す。
 * 通常のファイルでなければ(lstatで見てシンボリックリンクかディレクトリなら)例外を投げる。
 * `implement_prepare`が、worktreeの準備直後、Claudeを実行する前に記録する。
 */
export async function readWorktreeGitPointer(
  worktreeDir: string,
  fs: WorktreeGitPointerFs = defaultWorktreeGitPointerFs,
): Promise<{ readonly content: string }> {
  const path = `${worktreeDir}/.git`;
  const stats = await fs.lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`worktree ${worktreeDir}: .git is not a regular file`);
  }
  return { content: await fs.readFile(path) };
}

/**
 * `<worktreeDir>/.git`を読み直し、`expected`と1バイトでも違うとき、
 * 通常のファイルでなくなったとき、
 * 読めないときは`WorktreeGitPointerModifiedError`を投げる。
 * Claudeを実行するたびに、そのworktreeで最初のgitのコマンドを実行する前に呼ぶ。
 */
export async function assertWorktreeGitPointer(
  worktreeDir: string,
  expected: string,
  fs: WorktreeGitPointerFs = defaultWorktreeGitPointerFs,
): Promise<void> {
  let current: string;
  try {
    current = (await readWorktreeGitPointer(worktreeDir, fs)).content;
  } catch {
    throw new WorktreeGitPointerModifiedError();
  }
  if (current !== expected) throw new WorktreeGitPointerModifiedError();
}

/**
 * `<worktreeDir>/.git`が`expected`と一致する通常のファイルかを返す(`assertWorktreeGitPointer`)。
 * 一致しなければfalseを返し、例外は投げない。`runClaude`の`beforeRetry`に渡す。
 */
export async function worktreeGitPointerMatches(
  worktreeDir: string,
  expected: string,
  fs: WorktreeGitPointerFs = defaultWorktreeGitPointerFs,
): Promise<boolean> {
  try {
    await assertWorktreeGitPointer(worktreeDir, expected, fs);
    return true;
  } catch {
    return false;
  }
}

/**
 * `<dir>/.git`を1回だけ読み(`readWorktreeGitPointer`)、その中身で`verifyWorktreeGitdir`の検査をして、中身を返す。
 * 検証した値と記録する値を同じ1回の読み取りにするため、検証の中では`.git`を読み直さない。
 * 読み直すと、検証の後に書き換えられた値を基準値として記録しうる。
 * 検査に通らなければ`verifyWorktreeGitdir`と同じく例外を投げる。
 */
export async function readAndVerifyWorktreeGitPointer(
  opts: VerifyWorktreeGitdirOptions & {
    readonly pointerFs?: WorktreeGitPointerFs;
  },
): Promise<string> {
  const content = (
    await readWorktreeGitPointer(
      opts.dir,
      opts.pointerFs ?? defaultWorktreeGitPointerFs,
    )
  ).content;
  const pointerPath = `${opts.dir}/.git`;
  const readOther =
    opts.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  await verifyWorktreeGitdir({
    ...opts,
    readTextFile: (path) =>
      path === pointerPath ? Promise.resolve(content) : readOther(path),
  });
  return content;
}

// ---------------------------------------------------------------------------
// ensureRepo: /workspaces/<owner>/<repo>/mainの、fetchだけを行うメインのclone
// ---------------------------------------------------------------------------

export type EnsureRepoOptions = {
  readonly run: CommandRunner;
  readonly owner: string;
  readonly repo: string;
  readonly ghToken: string;
  /** 既定は`"/workspaces"`。 */
  readonly baseDir?: string;
  readonly home?: string;
  readonly path?: string;
  readonly exists?: PathExists;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type EnsureRepoResult = {
  readonly dir: string;
  readonly action: "cloned" | "fetched";
};

/**
 * `<baseDir>/<owner>/<repo>/main`に`owner/repo`のcloneを用意し、すでにあればfetchする。
 * clone・fetchに失敗したら例外を投げる。
 * ここには作業ツリーをcheckoutしない。ファイルを読むときは、detachedのworktree
 * (`addDetachedWorktree`)か`git gtr`のworktree(`createGtrWorktree`)を使う。
 */
export async function ensureRepo(
  opts: EnsureRepoOptions,
): Promise<EnsureRepoResult> {
  assertGitHubName(opts.owner);
  assertGitHubName(opts.repo);

  const baseDir = opts.baseDir ?? "/workspaces";
  const parentDir = `${baseDir}/${opts.owner}/${opts.repo}`;
  const dir = `${parentDir}/main`;
  const exists = opts.exists ?? pathExists;

  await opts.run(["mkdir", "-p", parentDir]);

  return withRepoLock({
    lockPath: repoLockPath(dir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      if (await exists(dir)) {
        const result = await opts.run(
          buildGitArgv(["fetch", "--", "origin"], { network: true }),
          {
            cwd: dir,
            env: networkGitEnv(opts.ghToken, opts.home, opts.path),
          },
        );
        if (result.exitCode !== 0) {
          throw gitError(
            `git fetch failed for ${opts.owner}/${opts.repo}`,
            result,
          );
        }
        await persistNoSymlinksConfig(opts.run, dir, opts.home, opts.path);
        return { dir, action: "fetched" as const };
      }

      const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
      const result = await opts.run(
        buildGitArgv(["clone", "--no-checkout", "--", url, dir], {
          network: true,
        }),
        { env: networkGitEnv(opts.ghToken, opts.home, opts.path) },
      );
      if (result.exitCode !== 0) {
        throw gitError(
          `git clone failed for ${opts.owner}/${opts.repo}`,
          result,
        );
      }
      await persistNoSymlinksConfig(opts.run, dir, opts.home, opts.path);
      return { dir, action: "cloned" as const };
    },
  });
}

/**
 * `repoDir`の`ensureRepo`のcloneで、`refs/remotes/origin/HEAD`が指すsha
 * (対象リポジトリの既定のブランチの先頭)を返す。解決できなければ例外を投げる。
 * 読み取りだけのローカルの操作で、`GH_TOKEN`は要らない。
 * 呼ぶ前に`ensureRepo`が`origin`をfetchしているので、
 * `refs/remotes/origin/HEAD`はローカルで解決できる。
 * 短い名前の`origin/HEAD`は、`refs/heads/origin/HEAD`などが先に解決されうるため使わない(`readExactRef`)。
 */
export async function resolveDefaultBranchHeadSha(
  run: CommandRunner,
  repoDir: string,
): Promise<string> {
  const sha = await readExactRef({
    run,
    cwd: repoDir,
    env: localGitEnv(),
    ref: REMOTE_HEAD_REF,
  });
  if (sha === null) {
    throw new Error(`${REMOTE_HEAD_REF} does not exist in ${repoDir}`);
  }
  return sha;
}

/**
 * メインのcloneで`git fetch origin -- pull/<prNumber>/head`を実行する。
 * 失敗したら例外を投げる。
 * PRの今の先頭のコミットは、ブランチの先頭と違って、取得済みのどのrefからも
 * 辿れないことがある。それでもshaで取り出せるようにするため。
 * `prNumber`は`number`型で、`pull/`の後に埋め込むので`-`で始まることは無いが、
 * このモジュールの他のネットワーク操作とそろえ、将来の呼び出し側が検証の緩い値を
 * 渡したときの備えとして、refspecは`--`の後に置く。
 */
export async function fetchPrHeadRef(
  run: CommandRunner,
  repoDir: string,
  prNumber: number,
  ghToken: string,
  home?: string,
  path?: string,
): Promise<void> {
  const result = await run(
    buildGitArgv(["fetch", "origin", "--", `pull/${prNumber}/head`], {
      network: true,
    }),
    { cwd: repoDir, env: networkGitEnv(ghToken, home, path) },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git fetch origin pull/${prNumber}/head failed in ${repoDir}`,
      result,
    );
  }
}

/**
 * `dir`で`git show <ref>:<path>`を実行し、`ref`の時点のファイルの中身を返す。
 * ファイルが無いとき、`ref`が検証を通らないとき、その他のエラーのときは`null`を返す。
 * 「HEADにこのファイルがあるか」を、例外を投げずに確かめるのに使う。
 * ただし出力の読み取りを打ち切ったときは例外を投げる。途中で切れた中身を、ファイルの中身としても無いこととしても扱えないため。
 *
 * `<ref>:<path>`には`--`を付けない(`buildGitArgv`の例外を参照)。
 * `git show -- HEAD:file.txt`はエラーにならず、
 * ファイルの中身ではなく空の出力を返すことを確かめた。
 * `--`の後では、gitは`ref:path`を、
 * オブジェクトの参照ではなくパスの絞り込みとして解釈するためである。
 * これは`--`で防ごうとする問題より悪い。
 * `path`は常に`ref`と、同じ引数の中の`:`に続くので、信頼できない`path`だけでは
 * 引数を`-`で始めることも、refとパスの区切りをずらすこともできない
 * (区切るのはこちらで入れた`:`である)。
 * 危険なのは`ref`が`-`で始まるか`:`を含むときだけなので、`assertBranchName`で検証する
 * (先頭の`-`、`..`、制御文字・空白、`:`などを拒否する)。
 * 例外を投げない契約を守るため、検証の例外は捕まえて`null`を返す。
 */
export async function readGitShowFile(
  run: CommandRunner,
  dir: string,
  ref: string,
  path: string,
  home?: string,
  envPath?: string,
): Promise<string | null> {
  try {
    assertBranchName(ref);
  } catch {
    return null;
  }
  const result = await run(buildGitArgv(["show", `${ref}:${path}`]), {
    cwd: dir,
    env: localGitEnv(home, envPath),
  });
  assertOutputComplete(`git show ${ref} in ${dir}`, result);
  return result.exitCode === 0 ? result.stdout : null;
}

// ---------------------------------------------------------------------------
// ensureFactoryClone: スキルを読むための、checkout済みのFactory自身のclone
// ---------------------------------------------------------------------------

const DEFAULT_FACTORY_CLONE_DIR = "/workspaces/factory/atelier-works";

export type EnsureFactoryCloneOptions = {
  readonly run: CommandRunner;
  readonly repoUrl: string;
  readonly ghToken: string;
  /** 既定は`"/workspaces/factory/atelier-works"`。 */
  readonly dir?: string;
  /**
   * checkoutし、cloneを保つブランチ(`factory_config.factory_branch`)。
   * 必須で、既定値は無い。
   * 呼び出し側はすべて`config.factory_branch`を明示して渡す。
   * 既定値があると、渡し忘れた呼び出し側が、気づかないうちに共有のcloneを
   * 既定値のブランチに固定してしまう。
   */
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
  readonly exists?: PathExists;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type EnsureFactoryCloneResult = {
  readonly dir: string;
  readonly action: "cloned" | "pulled";
};

/**
 * 既存のcloneを更新するとき、`ensureFactoryClone`が走らせるgitの回数。
 * fetch、reset、追跡refの確認(show-ref)、checkoutの4回。
 * `self_update`のジョブの上限の見積もりが使う。gitの呼び出しを増減したら、この値も直す
 * (`tests/lib/workspace.test.ts`が、更新での呼び出しの回数と一致することを確かめる)。
 */
export const FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT = 4;

/**
 * `dir`にあるFactory自身のcloneを守るロックのパス(隣の`<dir>.lock`)を返す。
 * `ensureRepo`の`<baseDir>/<owner>/<repo>/main`と違い、同じリポジトリのものを
 * まとめる共通の親ディレクトリが無く、守る対象は`dir`そのものだけである。
 * Factory自身のcloneに対する他のgitの操作(`audit_generate`のスナップショットの
 * worktreeの追加・削除)が`ensureFactoryClone`と同じロックを取れるよう、exportする。
 * worktreeの関数がロックするのは別のファイル`repoLockPath(dir)`なので、
 * この外側のロックが無いと`self_update`の`reset --hard`と`worktree add`が競合しうる。
 */
export function factoryCloneLockPath(dir: string): string {
  return `${dir}.lock`;
}

/**
 * Factory自身のclone(checkout済みの作業ツリー付き)を用意し、
 * `opts.branch`の最新に合わせる。
 * gitの操作に失敗したら例外を投げる。
 * `ensureRepo`と違い、このcloneはファイルを直接読む(`claude.ts`の`buildSystemPrompt`が
 * `.claude/skills/<name>/SKILL.md`を読む)ため、作業ツリーが要る。どのフローも最初に呼ぶ。
 *
 * 初回のcloneに限らず毎回、`opts.branch`をfetchして`checkout -B <branch> refs/remotes/origin/<branch>`で
 * 強制的に切り替え、前に何がcheckoutされていても、そのブランチのリモートの今の状態に合わせる
 * (必要なら切り替え、同じブランチならhard resetする)。
 * `git pull --ff-only`は今checkoutしているブランチを進めるだけで、ブランチを切り替えず、
 * 設定したブランチと食い違っていても気づかないので使わない。
 * このcloneはfetchして読むだけで、その場で編集しないので、強制的に合わせても失うものは無い。
 *
 * `factoryCloneLockPath(dir)`のロックの下で直列に実行する。
 * `NUM_WORKERS`が2以上だと、各フローの最初のステップと`poll_issues`が同じ`dir`に対して
 * 同時に呼ぶ。ロックが無いと、同じ作業ツリーで競合した`git fetch`・`git checkout`・
 * `git clone`が`.git/index.lock`で失敗する。
 */
export async function ensureFactoryClone(
  opts: EnsureFactoryCloneOptions,
): Promise<EnsureFactoryCloneResult> {
  const dir = opts.dir ?? DEFAULT_FACTORY_CLONE_DIR;
  const branch = opts.branch;
  assertBranchName(branch);
  const exists = opts.exists ?? pathExists;
  const env = networkGitEnv(opts.ghToken, opts.home, opts.path);

  return withRepoLock({
    lockPath: factoryCloneLockPath(dir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      if (await exists(dir)) {
        const fetchResult = await opts.run(
          buildGitArgv(["fetch", "origin", "--", branch], { network: true }),
          {
            cwd: dir,
            env,
          },
        );
        if (fetchResult.exitCode !== 0) {
          throw gitError(
            `git fetch origin ${branch} failed for factory clone`,
            fetchResult,
          );
        }
        // 先にローカルの変更をすべて捨てる。Factoryはこのcloneを読むだけだが、
        // 作業ツリーに変更が残ると`checkout -B`が切り替えを拒み
        // (「Your local changes ... would be overwritten」)、`self_update`が進まなくなる。
        const resetResult = await opts.run(buildGitArgv(["reset", "--hard"]), {
          cwd: dir,
          env: localGitEnv(opts.home, opts.path),
        });
        if (resetResult.exitCode !== 0) {
          throw gitError(
            "git reset --hard failed for factory clone",
            resetResult,
          );
        }
        // 追跡refが完全な名前で存在することを確かめてから切り替える。
        // 無いまま名前を渡すと、別のrefへ解決し直されうる。
        // 名前のまま渡すのは、上流の設定を残すためである。
        const tracked = await readExactRef({
          run: opts.run,
          cwd: dir,
          env: localGitEnv(opts.home, opts.path),
          ref: remoteTrackingRef(branch),
        });
        if (tracked === null) {
          throw new Error(
            `${remoteTrackingRef(branch)} does not exist in factory clone`,
          );
        }
        // ここでは`--`を付けない(`buildGitArgv`の例外を参照)。
        // `checkout -B <branch> <start-point>`は起点の前の`--`を受け付けない。
        // `--`を付けると`checkout`は「パスを復元する」動作になり、
        // 起点をrefではなくパスとして解釈する。
        // 代わりに`branch`を上の`assertBranchName`で検証している
        // (先頭の`-`、`..`、制御文字・空白を拒否する)。
        const checkoutResult = await opts.run(
          buildGitArgv(["checkout", "-B", branch, remoteTrackingRef(branch)]),
          {
            cwd: dir,
            env: localGitEnv(opts.home, opts.path),
          },
        );
        if (checkoutResult.exitCode !== 0) {
          throw gitError(
            `git checkout -B ${branch} ${remoteTrackingRef(branch)} failed for factory clone`,
            checkoutResult,
          );
        }
        return { dir, action: "pulled" as const };
      }

      const result = await opts.run(
        buildGitArgv(
          [
            "clone",
            "--branch",
            branch,
            "--single-branch",
            "--",
            opts.repoUrl,
            dir,
          ],
          { network: true },
        ),
        {
          env,
        },
      );
      if (result.exitCode !== 0) {
        throw gitError("git clone failed for factory clone", result);
      }
      return { dir, action: "cloned" as const };
    },
  });
}

// ---------------------------------------------------------------------------
// detachedのworktree(pr_review、要件定義の生成)
// ---------------------------------------------------------------------------

export type AddDetachedWorktreeOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly sha: string;
  readonly dir: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

/**
 * `sha`をfetchしてから、`git worktree add --detach <dir> <sha>`を実行する。
 * 失敗したら例外を投げる。
 * `ensureRepo`がこのリポジトリに使うのと同じ、
 * `repoLockPath(repoDir)`のロックの下で実行する。
 */
export async function addDetachedWorktree(
  opts: AddDetachedWorktreeOptions,
): Promise<{ readonly dir: string }> {
  assertSha(opts.sha);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const fetchResult = await opts.run(
        buildGitArgv(["fetch", "origin", "--", opts.sha], { network: true }),
        {
          cwd: opts.repoDir,
          env: networkGitEnv(opts.ghToken, opts.home, opts.path),
        },
      );
      if (fetchResult.exitCode !== 0) {
        throw gitError(`git fetch ${opts.sha} failed`, fetchResult);
      }

      // `buildGitArgv`の`-c core.symlinks=false`が効くので、
      // コミットされたシンボリックリンク(`/proc/self/environ`などworktreeの外を指すもの)は、
      // 本物のリンクではなく、リンク先のパスを書いたただのテキストファイルとしてcheckoutされる。
      const addResult = await opts.run(
        buildGitArgv(["worktree", "add", "--detach", "--", opts.dir, opts.sha]),
        { cwd: opts.repoDir, env: localGitEnv(opts.home, opts.path) },
      );
      if (addResult.exitCode !== 0) {
        throw gitError("git worktree add --detach failed", addResult);
      }

      return { dir: opts.dir };
    },
  });
}

/**
 * `.git`ファイルの検査(`verifyWorktreeGitdir`)と、検査に通らないworktreeを
 * ファイル操作だけで削除するときに使うファイル操作。テスト用に注入できる。
 */
export type WorktreeFsDeps = {
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
  /** `rm -rf`に当たる操作。既定は`rm(path, { recursive: true, force: true })`。 */
  readonly removeDir?: (path: string) => Promise<void>;
};

/** `dir`の`.git`ファイルが`verifyWorktreeGitdir`の検査を通るかを返す。 */
async function worktreePointerVerified(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly fs: WorktreeFsDeps | undefined;
}): Promise<boolean> {
  try {
    await verifyWorktreeGitdir({
      run: opts.run,
      repoDir: opts.repoDir,
      dir: opts.dir,
      ...(opts.fs?.readTextFile !== undefined
        ? { readTextFile: opts.fs.readTextFile }
        : {}),
      ...(opts.fs?.realpath !== undefined
        ? { realpath: opts.fs.realpath }
        : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `.git`ファイルが検証を通らなかったworktreeを、その中でgitを実行せずに削除する。
 * 別の場所へ向けられた`.git`ファイルは独自の設定(cleanフィルターなど)を持ち込めるため。
 * ファイル操作で`rm -rf`してから、`repoDir`で`git worktree prune`を実行する。
 * 削除するのは、`repoDir`での`git worktree list`に出るメインのclone以外のパスで、
 * かつリポジトリの作業ディレクトリ
 * (`dirname(repoDir)`、例: `/workspaces/<owner>/<repo>`)の下にあるものだけで、
 * それ以外は例外を投げる。リポジトリのロックの下で呼ぶ。
 */
async function discardUnverifiedWorktree(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly home?: string;
  readonly path?: string;
  readonly fs: WorktreeFsDeps | undefined;
}): Promise<void> {
  const entries = await listWorktrees({
    run: opts.run,
    repoDir: opts.repoDir,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
  if (
    opts.dir === opts.repoDir ||
    !entries.some((entry) => entry.path === opts.dir)
  ) {
    throw new Error(
      `refusing to delete ${opts.dir}: not a registered worktree of ${opts.repoDir}`,
    );
  }
  const root = dirname(opts.repoDir);
  if (resolve(opts.dir) !== opts.dir || !opts.dir.startsWith(`${root}/`)) {
    throw new Error(
      `refusing to delete ${opts.dir}: outside the repository's workspace dir ${root}`,
    );
  }
  const removeDir =
    opts.fs?.removeDir ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  await removeDir(opts.dir);
  const prune = await opts.run(buildGitArgv(["worktree", "prune"]), {
    cwd: opts.repoDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (prune.exitCode !== 0) {
    throw gitError("git worktree prune failed", prune);
  }
}

export type RemoveWorktreeOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly force?: boolean;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly fs?: WorktreeFsDeps;
};

/**
 * worktreeを削除する。失敗したら例外を投げる。
 * `ensureRepo`がこのリポジトリに使うのと同じ、
 * `repoLockPath(repoDir)`のロックの下で実行する。
 * `git worktree remove`はworktreeの中を調べるので、`.git`ファイルが
 * `verifyWorktreeGitdir`の検査を通ったときだけ実行する。
 * 通らなければ、ファイル操作でディレクトリを削除する(`discardUnverifiedWorktree`)。
 */
export async function removeWorktree(
  opts: RemoveWorktreeOptions,
): Promise<void> {
  await withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      if (
        !(await worktreePointerVerified({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: opts.dir,
          fs: opts.fs,
        }))
      ) {
        await discardUnverifiedWorktree({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: opts.dir,
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          fs: opts.fs,
        });
        return;
      }
      const args = [
        "worktree",
        "remove",
        ...(opts.force === true ? ["--force"] : []),
        "--",
        opts.dir,
      ];
      const result = await opts.run(buildGitArgv(args), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
      if (result.exitCode !== 0) {
        throw gitError("git worktree remove failed", result);
      }
      await opts.run(buildGitArgv(["worktree", "prune"]), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
    },
  });
}

export type PruneWorktreesOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

/**
 * `repoDir`で`git worktree prune`だけを実行する。失敗したら例外を投げる。
 * gitの外で消されたなど、もうディスクに無い作業ツリーの管理情報を消す。
 * 特定のworktreeを消すのではない一括の掃除(`cleanup_workspaces.ts`)に使う
 * (`removeWorktree`は削除のたびにpruneする)。
 * このモジュールでworktreeを変更する他の関数と同じ、
 * `repoLockPath(repoDir)`のロックの下で実行する。
 */
export async function pruneWorktrees(
  opts: PruneWorktreesOptions,
): Promise<void> {
  await withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const result = await opts.run(buildGitArgv(["worktree", "prune"]), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
      if (result.exitCode !== 0) {
        throw gitError("git worktree prune failed", result);
      }
    },
  });
}

export type WorktreeEntry = {
  readonly path: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
};

/**
 * `entry`が、PR番号`prNumber`のレビューのworktree(`buildReviewWorktreeDir`が作るパス)かを返す。
 * `repoDir`と同じ親の直下にある`review-<PR番号>-<sha7>`というdetachedのworktreeだけを対象にする。
 * パスの一部が一致しただけで選ぶと、別の場所のdirectoryやブランチのworktreeまで消しうるためである。
 * パスは文字列の前方一致で比べるので、列挙されたパスと`repoDir`が同じ綴りでなければ、
 * 何も選ばれない。workerの`/workspaces`はボリュームのマウント先そのものでsymlinkを挟まないので、
 * `/workspaces/<owner>/<repo>/main`のcloneのworktreeは、同じ綴りで列挙される。
 */
export function isReviewWorktreeOf(
  repoDir: string,
  prNumber: number,
  entry: Pick<WorktreeEntry, "path" | "detached">,
): boolean {
  if (!entry.detached) return false;
  const prefix = `${repoDir.replace(/\/main$/, "")}/`;
  if (!entry.path.startsWith(prefix)) return false;
  const name = entry.path.slice(prefix.length);
  return new RegExp(`^review-${String(prNumber)}-[0-9a-f]{7}$`).test(name);
}

/**
 * `git worktree list --porcelain -z`の出力を読む。
 * -zの形式は、各行をNULで終え、各レコードの後にもう1つNULを置く。
 * 改行はレコードの区切りにならないので、改行を含むパスを1つのパスとして読める。
 * 出力が空(worktreeが無い)でない限り、末尾が完全なレコードの終わりでなければ、
 * 途中で切れた出力として例外を投げる。
 * 使用中のworktreeを読み落とすと、別のworktreeが使うブランチを確かめずに通してしまうため。
 */
function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  if (stdout === "") return [];

  const fields = stdout.split("\0");
  // NULで終わる出力を分けると、最後に空の要素が残る。残らなければ、最後の行が終わっていない。
  if (fields.pop() !== "") {
    throw new Error(
      "unexpected 'git worktree list --porcelain -z' output: truncated",
    );
  }

  const entries: WorktreeEntry[] = [];
  let lines: string[] = [];
  for (const field of fields) {
    if (field !== "") {
      lines.push(field);
      continue;
    }
    if (lines.length === 0) {
      throw new Error(
        "unexpected 'git worktree list --porcelain -z' output: empty record",
      );
    }
    entries.push(parseWorktreeRecord(lines));
    lines = [];
  }
  // 最後のレコードを終えるNULが無い。
  if (lines.length > 0) {
    throw new Error(
      "unexpected 'git worktree list --porcelain -z' output: truncated",
    );
  }
  return entries;
}

function parseWorktreeRecord(lines: readonly string[]): WorktreeEntry {
  let path: string | null = null;
  let headSha: string | null = null;
  let branch: string | null = null;
  let bare = false;
  let detached = false;

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      headSha = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "bare") {
      bare = true;
    } else if (line === "detached") {
      detached = true;
    }
  }

  if (path === null) {
    throw new Error(
      `unexpected 'git worktree list --porcelain -z' record: ${lines.join(" | ")}`,
    );
  }
  return { path, headSha, branch, bare, detached };
}

/**
 * `repoDir`の`git worktree list --porcelain -z`を読む。
 * -zはgit 2.36以上が要る。失敗したときと、出力が途中で切れたときは例外を投げる。
 */
export async function listWorktrees(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly home?: string;
  readonly path?: string;
}): Promise<WorktreeEntry[]> {
  const result = await opts.run(
    buildGitArgv(["worktree", "list", "--porcelain", "-z"]),
    {
      cwd: opts.repoDir,
      env: localGitEnv(opts.home, opts.path),
    },
  );
  if (result.exitCode !== 0) {
    throw gitError("git worktree list failed", result);
  }
  assertOutputComplete("git worktree list", result);
  return parseWorktreeListPorcelain(result.stdout);
}

// ---------------------------------------------------------------------------
// git gtrのworktree(pr_fix)
// ---------------------------------------------------------------------------

export type GtrWorktree = {
  readonly path: string;
  readonly branch: string;
  readonly hookStatus: string;
};

function parseGtrPorcelain(stdout: string): GtrWorktree {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) continue;
    fields.set(line.slice(0, tabIndex), line.slice(tabIndex + 1));
  }

  const path = fields.get("path");
  const branch = fields.get("branch");
  if (path === undefined || branch === undefined) {
    throw new Error(`unexpected 'git gtr new --porcelain' output: ${stdout}`);
  }
  // `hook_status`は参考の情報なので、無くても失敗させない。
  return { path, branch, hookStatus: fields.get("hook_status") ?? "unknown" };
}

/**
 * `dir`以外のworktreeが`refs/heads/<branch>`をcheckoutしていれば例外を投げる。
 * `dir`はworktreeの一覧に出るため、パスをrealpathで解決して自分自身を除く。
 * HEADを読んでから一覧を取るまでの間に、生き残りが`dir`のHEADを対象のブランチへ移すことがあり、そのとき`dir`自身を誤って止めないためである。
 * 解決できないパスは、そのままの文字列で比べる。
 * 大文字小文字は正規化しない。大文字小文字を区別しない環境で同じパスが別の綴りで並ぶと、自分自身を他のworktreeと見て止まるが、止まる側なので安全である。
 * 一覧を取れないときも例外にし、呼び出し側をresetに進ませない。
 */
async function assertBranchFreeInOtherWorktrees(opts: {
  readonly run: CommandRunner;
  readonly dir: string;
  readonly branch: string;
  readonly context: string;
  readonly home?: string;
  readonly path?: string;
  readonly realpath?: (path: string) => Promise<string>;
}): Promise<void> {
  const entries = await listWorktrees({
    run: opts.run,
    repoDir: opts.dir,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
  const resolveReal = opts.realpath ?? ((path: string) => realpath(path));
  const resolveOrSelf = async (path: string): Promise<string> => {
    try {
      return await resolveReal(path);
    } catch {
      return path;
    }
  };
  const self = await resolveOrSelf(opts.dir);
  for (const entry of entries) {
    if (entry.branch !== opts.branch) continue;
    if (entry.path === opts.dir || (await resolveOrSelf(entry.path)) === self) {
      continue;
    }
    throw new Error(
      maskSecrets(
        `branch ${opts.branch} is checked out in another worktree ${entry.path} (${opts.context})`,
      ),
    );
  }
}

/**
 * worktree`dir`のHEADが`refs/heads/<branch>`を指すようにする。`createGtrWorktree`が`reset --hard`の直前に呼ぶ。
 * `reset --hard`はHEADが指すブランチを動かす。生き残ったプロセスが別のブランチをcheckoutしていると、
 * そのブランチを動かしてしまい、対象のブランチは戻らないため。
 * 指していなければ(別のブランチかdetached)、`checkout -f --no-track -B <branch> <ref>`でHEADを対象のブランチへ移し、`ref`に合わせる。
 * `checkout -B`は、それまでHEADが指していたブランチを動かさない。
 * gitの版によっては、`checkout -B`は他のworktreeがcheckoutしているブランチを黙って付け替える。
 * そのため、切り替えの前に`git worktree list`で`dir`以外のworktreeを確かめ、
 * 対象のブランチをcheckoutしているものがあれば例外を投げる。パスは、realpathで解決した値で比べる。
 * 別のworktreeがrebaseやbisectの途中でHEADがdetachedのものと、確認とcheckoutの間の競合は、このmoduleでは防げず、2.44以降のgitの拒否に任せる。
 * 途中のrebaseとbisectを拒否することは、git 2.54.0で確かめた。
 * worktreeを作り直さないのは、作り直しにも生き残りの確かめとポインタの検証がもう一度要り、
 * 再利用するworktreeでは対象リポジトリが無視しているファイル(`node_modules/`など)まで失うためである。
 * `--no-track`は、`ref`が追跡ref(`refs/remotes/origin/<branch>`)の名前のときに上流の設定をメインのcloneの`.git/config`へ書かないために付ける。
 * HEADを読めないとき、worktreeの一覧を取れないとき、他のworktreeが対象のブランチを使っているとき、
 * 切り替えに失敗したとき、切り替えた後もHEADが指していないときは例外を投げ、resetに進ませない。
 * `branch`は`assertBranchName`で、`ref`は検証済みの値から作ったものを渡す。
 */
export async function ensureHeadOnBranch(opts: {
  readonly run: CommandRunner;
  readonly dir: string;
  readonly branch: string;
  readonly ref: string;
  /** 例外のメッセージに付ける、呼び出した経路の名前。 */
  readonly context: string;
  readonly home?: string;
  readonly path?: string;
  readonly realpath?: (path: string) => Promise<string>;
}): Promise<void> {
  const expected = `refs/heads/${opts.branch}`;
  const env = localGitEnv(opts.home, opts.path);
  const readHead = async (): Promise<string | null> => {
    const result = await opts.run(
      buildGitArgv(["symbolic-ref", "-q", "HEAD"]),
      { cwd: opts.dir, env },
    );
    if (result.exitCode === 0) return result.stdout.trim();
    // `-q`は、HEADがdetachedのときだけ何も出さずに終了コード1を返す。それ以外の失敗はHEADを読めていない。
    if (result.exitCode === 1 && !result.timedOut) return null;
    throw gitError(`git symbolic-ref HEAD failed (${opts.context})`, result);
  };
  if ((await readHead()) === expected) return;
  await assertBranchFreeInOtherWorktrees(opts);
  // 起点の前に`--`を付けない(`buildGitArgv`の例外を参照)。
  const checkout = await opts.run(
    buildGitArgv(["checkout", "-f", "--no-track", "-B", opts.branch, opts.ref]),
    { cwd: opts.dir, env },
  );
  if (checkout.exitCode !== 0) {
    throw gitError(
      `git checkout -f -B ${opts.branch} ${opts.ref} failed (${opts.context})`,
      checkout,
    );
  }
  const after = await readHead();
  if (after !== expected) {
    throw new Error(
      maskSecrets(
        `HEAD is not ${expected} after checkout (${opts.context}): ${after ?? "detached"}`,
      ),
    );
  }
}

export type CreateGtrWorktreeOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly fs?: WorktreeFsDeps;
  /**
   * worktreeに触れる前に呼ぶ確かめ。前の実行のプロセスがまだworktreeを使っていれば例外を投げる。
   * 止めたプロセスがあればtrue、何も止めなければfalseを返す。
   * 呼び出し側は`ensureWorktreeLockFree`(`lib/process_lock.ts`)を渡す。
   * 実装フローは同じ作業項目の前のジョブのプロセスを止め、pr_fixは何も止めない。渡し忘れを型で防ぐため必須にする。
   */
  readonly assertProcessesIdle: (worktreeDir: string) => Promise<boolean>;
};

/**
 * `git gtr new`が`branch`を作った先頭として正しいshaを、完全な名前で読んで返す。
 * リモートにブランチがあれば`refs/remotes/origin/<branch>`、無ければ既定のブランチの先頭(`refs/remotes/origin/HEAD`)である。
 * どちらも読めなければ例外を投げる。
 */
async function expectedGtrNewSha(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
}): Promise<string> {
  const env = localGitEnv(opts.home, opts.path);
  const tracking = await readExactRef({
    run: opts.run,
    cwd: opts.repoDir,
    env,
    ref: remoteTrackingRef(opts.branch),
  });
  const sha =
    tracking ??
    (await readExactRef({
      run: opts.run,
      cwd: opts.repoDir,
      env,
      ref: REMOTE_HEAD_REF,
    }));
  if (sha === null) {
    throw new Error(`${REMOTE_HEAD_REF} does not exist (gtr new)`);
  }
  assertSha(sha);
  return sha;
}

/**
 * `git gtr new <branch> --porcelain --yes --no-hooks`で`branch`のworktreeを作って返す。
 * gtrのpostCreateフックは動かさない。誤ったcommitのtreeの中でフックを実行させないためである。
 * `git worktree prune`の後の`git worktree list`に`branch`のworktreeがすでにあれば、それを再利用する。
 * gitの操作に失敗したら例外を投げる。
 * `ensureRepo`がこのリポジトリに使うのと同じ、
 * `repoLockPath(repoDir)`のロックの下で実行する。
 * 再利用するworktreeは、
 * 中でgitを実行する前に`.git`ファイルを検証する(`verifyWorktreeGitdir`)。
 * 通らなければファイル操作で削除し(`discardUnverifiedWorktree`)、
 * `git gtr new`で作り直す。
 * worktreeに触れる前(既存なら検証より前、新規なら`git gtr new`の直後)に`assertProcessesIdle`を呼ぶ。
 * 新しく作ったworktreeは、作ったブランチの先頭を、完全な名前で読んだ値(`expectedGtrNewSha`)と照合する。
 * `git gtr new`が短い名前の`origin/...`から作るので、違う先頭になっていることがあるためである。
 * 照合で違ったときと、確かめが何かを止めたときは、`.git`ファイルを検証してから、
 * 照合したshaへ`reset --hard`し、`clean -fd`する。止まる前に書き込まれたものを捨てるためである。
 * 再利用と、何かを止めた新しいworktreeのどちらでも、`reset --hard`の前にHEADを対象のブランチへそろえる(`ensureHeadOnBranch`)。
 */
export async function createGtrWorktree(
  opts: CreateGtrWorktreeOptions,
): Promise<GtrWorktree> {
  assertBranchName(opts.branch);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      // ディレクトリが消えたworktreeを一覧から除く。親ディレクトリごと消えたものが残ると、
      // 確かめ(assertProcessesIdle)がロックファイルのパスを作れず、作り直しに進めないため。
      const prune = await opts.run(buildGitArgv(["worktree", "prune"]), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
      if (prune.exitCode !== 0) {
        throw gitError("git worktree prune failed", prune);
      }
      const existing = await listWorktrees({
        run: opts.run,
        repoDir: opts.repoDir,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
      });
      const found = existing.find((entry) => entry.branch === opts.branch);
      // 取り消された実行のClaudeや検査が生き残っていれば、ポインタの検証・破棄・reset・cleanのどれもしない。
      if (found !== undefined) await opts.assertProcessesIdle(found.path);
      const reused =
        found !== undefined &&
        (await worktreePointerVerified({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: found.path,
          fs: opts.fs,
        }))
          ? found
          : undefined;
      if (found !== undefined && reused === undefined) {
        await discardUnverifiedWorktree({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: found.path,
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          fs: opts.fs,
        });
      }
      if (reused !== undefined) {
        // 前のラウンドでタイムアウトしたか取り消されたClaudeの実行が、再利用する
        // worktreeに編集を残していることがある。
        // ブランチのリモートの今の状態に戻さないと、
        // 残った編集が次のラウンドの`git add -A`(`commitAndPush`)に入り込む。
        // さらに人がブランチに直接pushしていれば、古いローカルの履歴のせいで
        // 次のpushがfast-forwardでなくなる。
        // そのため、渡す前にfetch、hard reset、cleanを行い、
        // `refs/remotes/origin/<branch>`のままの状態に戻す。
        // 下の`git gtr new`で作る新しいworktreeは、照合で別に扱う。
        const fetchResult = await opts.run(
          buildGitArgv(["fetch", "origin", "--", opts.branch], {
            network: true,
          }),
          {
            cwd: opts.repoDir,
            env: networkGitEnv(opts.ghToken, opts.home, opts.path),
          },
        );
        if (fetchResult.exitCode !== 0) {
          throw gitError(
            `git fetch origin ${opts.branch} failed (gtr worktree reuse)`,
            fetchResult,
          );
        }

        // 追跡refのshaを完全な名前で読み、以降はこのshaに合わせる。
        // 名前のまま渡すと、追跡refが無いときに別のrefへ解決し直されうる。
        const trackingSha = await readExactRef({
          run: opts.run,
          cwd: opts.repoDir,
          env: localGitEnv(opts.home, opts.path),
          ref: remoteTrackingRef(opts.branch),
        });
        if (trackingSha === null) {
          throw new Error(
            `${remoteTrackingRef(opts.branch)} does not exist (gtr worktree reuse)`,
          );
        }
        assertSha(trackingSha);

        await ensureHeadOnBranch({
          run: opts.run,
          dir: reused.path,
          branch: opts.branch,
          ref: trackingSha,
          context: "gtr worktree reuse",
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          ...(opts.fs?.realpath !== undefined
            ? { realpath: opts.fs.realpath }
            : {}),
        });

        // ここでは`--`を付けない(`buildGitArgv`の例外を参照)。
        // `--hard`はパスを受け付けず、`git reset --hard -- <ref>`は
        // 「fatal: Cannot do hard reset with paths」で失敗することを確かめた。
        // `opts.branch`は上の`assertBranchName`で検証済みである。
        const resetResult = await opts.run(
          buildGitArgv(["reset", "--hard", trackingSha]),
          { cwd: reused.path, env: localGitEnv(opts.home, opts.path) },
        );
        if (resetResult.exitCode !== 0) {
          throw gitError(
            `git reset --hard ${trackingSha} failed (gtr worktree reuse)`,
            resetResult,
          );
        }

        // `-fdx`ではなく`-fd`にする。
        // このworktreeは任意の対象リポジトリのもので、その`.gitignore`が、
        // 作り直しに時間のかかる大きな生成物(`node_modules/`やビルドの出力など)を
        // 正当に除外していることがある。
        // 取り消された実行が作ったものではないので、
        // `-x`で再利用のたびに消しても、正しさの面で得るものが無い。
        // 本当の危険は、取り消された実行が残した未追跡・変更済みのファイルが、
        // 次のラウンドの`git add -A`に入ることである。
        // これは、未追跡のファイルの削除と、
        // 追跡中のファイルの変更を捨てる上のhard resetで防げている。
        const cleanResult = await opts.run(buildGitArgv(["clean", "-fd"]), {
          cwd: reused.path,
          env: localGitEnv(opts.home, opts.path),
        });
        if (cleanResult.exitCode !== 0) {
          throw gitError(
            "git clean -fd failed (gtr worktree reuse)",
            cleanResult,
          );
        }

        return { path: reused.path, branch: opts.branch, hookStatus: "reused" };
      }

      // `--no-hooks`で、gtrのpostCreateフックを動かさない。
      // 下の照合で作り直す前の、誤ったcommitのtreeの中で、フックのコマンドを実行させないためである。
      // gtrのコピーはメインのcloneから読むので、そのtreeは読まない。
      // ここでは`--`を付けない。`git gtr`はcore gitではない外部のサブコマンドで、
      // core gitのように`--`を扱える保証が無い。
      // 先頭の`-`は上の`assertBranchName`ですでに拒否している。
      const result = await opts.run(
        buildGitArgv(
          ["gtr", "new", opts.branch, "--porcelain", "--yes", "--no-hooks"],
          { network: true },
        ),
        {
          cwd: opts.repoDir,
          // `buildGitArgv`の`-c`は、環境変数`GIT_CONFIG_PARAMETERS`で`git-gtr`の子のgitにも渡る。
          env: networkGitEnv(opts.ghToken, opts.home, opts.path),
        },
      );
      if (result.exitCode !== 0) {
        throw gitError(`git gtr new ${opts.branch} failed`, result);
      }
      const created = parseGtrPorcelain(result.stdout);
      // 作った時点のブランチの先頭。確かめより前にworktreeでgitを実行しないよう、メインのcloneで読む。
      // 完全な名前を一致させて読み、別のrefへ解決し直さない(`readExactRef`)。`opts.branch`は検証済みである。
      const createdSha = await readExactRef({
        run: opts.run,
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
        ref: `refs/heads/${opts.branch}`,
      });
      if (createdSha === null) {
        throw new Error(`refs/heads/${opts.branch} does not exist (gtr new)`);
      }
      assertSha(createdSha);
      // `git gtr new`は、リモートにあるブランチを短い名前の`origin/<branch>`から、
      // 無いブランチを短い名前の`origin/<既定のブランチ>`から作る(gtr 2.11.1のソースで確かめた)。
      // 短い名前は`refs/heads/origin/...`などが先に解決されうるので、
      // 作った先頭を、完全な名前で読んだ値と照合する。
      // 違えば、検証したshaへ作り直す(下の止めた場合と同じ復元の経路)。
      // すでにあったローカルのブランチが追跡refと違うときも、使い回しの経路と同じく追跡refへそろえる。
      // gtrは既定のブランチを設定から取ることがあるが、照合は常に`refs/remotes/origin/HEAD`と比べる。
      // 削除されたworktreeの中で生き残ったClaudeは同じ絶対パスに書き込みうるので、新しく作った場合も確かめる。
      const stopped = await opts.assertProcessesIdle(created.path);
      const verifiedSha = await expectedGtrNewSha({
        run: opts.run,
        repoDir: opts.repoDir,
        branch: opts.branch,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
      });
      const misplaced = createdSha !== verifiedSha;
      if (!stopped && !misplaced) return created;
      // 止めたプロセスは、止まるまでにworktreeへ書き込んだり`.git`ファイルを書き換えたりしえた。
      // 中でgitを実行する前にポインタを検証し、検証したshaの状態に戻す。
      // コミットしてブランチを進めていても、checkout中のブランチごと戻るので、refを別に戻す必要は無い。
      // 別のブランチをcheckoutしていれば、resetの前に対象のブランチへ戻す(`ensureHeadOnBranch`)。
      await verifyWorktreeGitdir({
        run: opts.run,
        repoDir: opts.repoDir,
        dir: created.path,
        ...(opts.fs?.readTextFile !== undefined
          ? { readTextFile: opts.fs.readTextFile }
          : {}),
        ...(opts.fs?.realpath !== undefined
          ? { realpath: opts.fs.realpath }
          : {}),
      });
      await ensureHeadOnBranch({
        run: opts.run,
        dir: created.path,
        branch: opts.branch,
        ref: verifiedSha,
        context: "gtr new restore",
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(opts.fs?.realpath !== undefined
          ? { realpath: opts.fs.realpath }
          : {}),
      });
      const resetResult = await opts.run(
        buildGitArgv(["reset", "--hard", verifiedSha]),
        { cwd: created.path, env: localGitEnv(opts.home, opts.path) },
      );
      if (resetResult.exitCode !== 0) {
        throw gitError(
          `git reset --hard ${verifiedSha} failed (gtr new restore)`,
          resetResult,
        );
      }
      // 先頭を作り直したときは、`-x`も付ける。
      // 誤ったcommitのtreeに置かれたファイルのうち、検証したtreeの.gitignoreが除外するもの
      // (`node_modules/`など)は、`-fd`では消えずに残るためである。
      // プロセスを止めただけのときは、対象リポジトリの生成物を残すため`-fd`にする。
      const cleanFlags = misplaced ? "-fdx" : "-fd";
      const cleanResult = await opts.run(buildGitArgv(["clean", cleanFlags]), {
        cwd: created.path,
        env: localGitEnv(opts.home, opts.path),
      });
      if (cleanResult.exitCode !== 0) {
        throw gitError(
          `git clean ${cleanFlags} failed (gtr new restore)`,
          cleanResult,
        );
      }
      return created;
    },
  });
}

// ---------------------------------------------------------------------------
// commitAndPush(pr_fix)
// ---------------------------------------------------------------------------

export type CommitAndPushOptions = {
  readonly run: CommandRunner;
  /**
   * このworktreeが属するメインのcloneのディレクトリ(`ensureRepo`を参照)。
   * 中でgitを実行する前に`dir`が本当に登録されたworktreeかを確かめるのと、
   * リポジトリごとの共有のロックを決めるのに使う。
   */
  readonly repoDir: string;
  readonly dir: string;
  readonly message: string;
  /**
   * Factoryのインスタンス名。
   * コミットの`Generated-By`トレーラーに入れる(`withCommitTrailers`を参照)。
   */
  readonly instanceName: string;
  /** 呼び出し側が作業を始めたときに見た、PRのブランチのリモートの先頭のsha。 */
  readonly expectedHeadSha: string;
  /**
   * `git commit`のauthorとcommitter。その1回の実行だけに、環境変数
   * `GIT_AUTHOR_*`・`GIT_COMMITTER_*`で渡し、gitの設定には書き込まない
   * (docs/security.md「PR修正の安全策」)。
   * 呼び出し側は、PATの持ち主から`gitIdentityForViewer`(`github.ts`)で作る。
   */
  readonly author: GitIdentity;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly verifyWorktree?: (
    opts: VerifyWorktreeGitdirOptions,
  ) => Promise<void>;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /**
   * trueなら、`git add -A`の前にローカルのHEADが`expectedHeadSha`であることを確かめる。
   * 違えば何もステージせずに`CommitBlockedError`を投げる。
   * pr_fixとimplementフローが使う。検査コマンドがローカルでcommitすると、そのcommitの変更は作業ツリーの変更として見えず、
   * 保護パスの判定や秘密の検査を経ずにpushされるため。
   */
  readonly requireLocalHeadAtExpected?: boolean;
  /**
   * 渡されたら、fetchの前に`git symbolic-ref -q HEAD`が`refs/heads/<このブランチ>`であることを確かめる。
   * 違うとき(detachedの`HEAD`を含む)は何もせずに`CommitBlockedError`を投げる。
   * pr_fixとimplementフローが使う。検査コマンドがブランチを切り替えると、pushする先が準備ステップの見たブランチでなくなるため。
   */
  readonly expectedBranch?: string;
  /**
   * `git add -A`の後、commitの前に、ステージした内容を調べて止める理由を返す。
   * 理由があれば`git reset -q`でステージを戻し、commitせずに`CommitBlockedError`を投げる。
   * pr_fixが、検証ステップの後にworktreeが変わっていないことを、commitする内容そのもので確かめるために使う。
   */
  readonly inspectStaged?: () => Promise<readonly string[]>;
  /**
   * 渡されたら、commitの後、pushの前に、作ったcommitのツリーがこのshaであることを確かめる。
   * 違えば`git reset -q`でcommitを取り消し(変更はworktreeに残る)、pushせずに`CommitBlockedError`を投げる。
   * 戻す先は、`requireLocalHeadAtExpected`があれば`expectedHeadSha`、無ければ作ったcommitの親である。
   * 呼び出し側は、gitleaksが検査したツリーかループで検証したツリーを渡し、検査していない内容をpushしない。
   * `requireLocalHeadAtExpected`と組み合わせる前提である。無いと、検査コマンドがcommitした履歴まで、
   * ツリーだけ確かめてpushしうる。
   */
  readonly expectedTreeSha?: string;
};

/** `git symbolic-ref HEAD`が、HEADがローカルのブランチにあるときに返すrefの接頭辞。 */
const LOCAL_BRANCH_REF_PREFIX = "refs/heads/";

export const COMMITTED_TREE_CHANGED_REASON =
  "committed tree differs from the inspected tree";

/**
 * `commitAndPush`が、ローカルのHEADかステージした内容の確かめに通らず、commitしなかったことを表す。
 * messageは止めた理由(`"; "`でつないだ一覧)で、そのまま状態の理由に使う。
 */
export class CommitBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CommitBlockedError";
  }
}

export type CommitAndPushResult =
  | { readonly outcome: "pushed"; readonly newSha: string }
  | { readonly outcome: "head_changed"; readonly currentSha: string }
  | { readonly outcome: "nothing_to_commit" };

/**
 * リモートが進んだために失敗したとき、gitのstderrに出る文字列。
 * 「[rejected]」「(non-fast-forward)」「hint: ... fetch first」などの
 * 言い回しに対応する。
 * 大文字と小文字を区別せずに探す。
 * 単独の「rejected」は意図して含めない。サーバー側の拒否(「! [remote rejected] ...
 * (refusing to allow a Personal Access Token to create or update workflow ...)」や、
 * pre-receiveフックによる拒否)にも含まれ、競合とみなすと、恒久的な失敗を報告せずに
 * `head_changed`として扱ってしまうため。
 */
const PUSH_REJECTED_SUBSTRINGS = [
  "[rejected]",
  "non-fast-forward",
  "fetch first",
];

/**
 * 「[remote rejected]」の行は、サーバーが独自の理由で更新を拒否したことを表す。
 * 同じstderrに上の文字列が含まれていても、fast-forwardでないことによる競合ではない。
 */
const REMOTE_REJECTED_SUBSTRING = "[remote rejected]";

function isNonFastForwardRejection(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  if (lower.includes(REMOTE_REJECTED_SUBSTRING)) {
    return false;
  }
  return PUSH_REJECTED_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/** Factoryが作るコミットにはすべて、Claudeが書いたことを示すトレーラーを付ける。 */
const CLAUDE_COAUTHOR_TRAILER =
  "Co-Authored-By: Claude <noreply@anthropic.com>";

function generatedByTrailer(instanceName: string): string {
  return `Generated-By: Software Factory (${instanceName})`;
}

/**
 * `author`から、環境変数`GIT_AUTHOR_NAME`・`GIT_AUTHOR_EMAIL`・`GIT_COMMITTER_NAME`・
 * `GIT_COMMITTER_EMAIL`を作って返す。
 * `git commit`の実行の環境変数にだけ混ぜる(`CommitAndPushOptions.author`を参照)。
 * gitの設定には書き込まないので、このモジュールの他のgitの実行には影響しない。
 */
function commitIdentityEnv(author: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

/**
 * `message`の末尾に、Claudeの共同作者のトレーラーと
 * `Generated-By: Software Factory (<instanceName>)`のトレーラーを付けて返す。
 * gitのトレーラーの慣習どおり、本文との間は空行で区切る。
 * `message`にすでに共同作者のトレーラーがあれば、そのまま返す
 * (冪等で、2回呼んでもトレーラーは重ならない)。
 * authorとcommitterは別に、`CommitAndPushOptions.author`で設定する。
 */
export function withCommitTrailers(
  message: string,
  instanceName: string,
): string {
  if (message.includes(CLAUDE_COAUTHOR_TRAILER)) {
    return message;
  }
  return `${message}\n\n${CLAUDE_COAUTHOR_TRAILER}\n${generatedByTrailer(instanceName)}`;
}

/**
 * 作業ツリーの変更をすべてコミットしてpushし、結果を返す。
 * まず`dir`が`repoDir`の本当のworktreeであることを確かめ(`verifyWorktreeGitdir`)、
 * fetchして、リモートのブランチの先頭がまだ`expectedHeadSha`であることを確かめる
 * (Claudeが編集している間に他の誰かがpushしたかもしれないため)。
 * 先頭が変わっていれば`head_changed`、変更が無ければ`nothing_to_commit`を返す。
 * pushがfast-forwardでないとして拒否されたとき(先頭の確認をすり抜けた競合)も、
 * 例外を投げず、fetchし直して`head_changed`を返す。それ以外の失敗では例外を投げる。
 * `expectedBranch`・`requireLocalHeadAtExpected`・`inspectStaged`の確かめに通らなければ、commitせずに`CommitBlockedError`を投げる。
 * `expectedBranch`が無くても、HEADがローカルのブランチに無ければ(detachedを含む)、fetchの前に例外を投げる。
 * `inspectStaged`が例外を投げたときも、ステージを戻してからその例外を投げ直す。
 * `expectedTreeSha`があれば、作ったcommitのツリーがそれと違うときにcommitを取り消し、pushせずに`CommitBlockedError`を投げる。
 * pushは`HEAD`ではなく作ったcommitのshaを`refs/heads/<branch>`へ送る。commitの後にHEADが動いても、確かめたcommitだけを送るため。
 * fetchはサブモジュールに降りない(`--no-recurse-submodules`)。worktreeの`.gitmodules`や設定で、別のリポジトリを取りに行かせないため。
 * トークンはリモートのURLに入れない。
 * 認証は`-c credential.helper='!gh auth git-credential'`と
 * サブプロセスの環境変数の`GH_TOKEN`で行い、fetchとpushのときだけ渡す。
 * `ensureRepo`がこのリポジトリに使うのと同じ、
 * `repoLockPath(repoDir)`のロックの下で実行する。
 */
export async function commitAndPush(
  opts: CommitAndPushOptions,
): Promise<CommitAndPushResult> {
  assertSha(opts.expectedHeadSha);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const verify = opts.verifyWorktree ?? verifyWorktreeGitdir;
      await verify({ run: opts.run, repoDir: opts.repoDir, dir: opts.dir });

      const local = localGitEnv(opts.home, opts.path);
      const network = networkGitEnv(opts.ghToken, opts.home, opts.path);

      // ブランチは`symbolic-ref`で完全なref名として読む。
      // `rev-parse --abbrev-ref`は、同じ名前のタグがあると`heads/<branch>`を返し、照合を誤らせるため。
      const headRefResult = await opts.run(
        buildGitArgv(["symbolic-ref", "-q", "HEAD"]),
        { cwd: opts.dir, env: local },
      );
      // `-q`は、HEADがdetachedのときだけ何も出さずに終了コード1を返す。それ以外の失敗はHEADを読めていない。
      const detached = headRefResult.exitCode === 1 && !headRefResult.timedOut;
      if (headRefResult.exitCode !== 0 && !detached) {
        throw gitError("git symbolic-ref -q HEAD failed", headRefResult);
      }
      const headRef = detached ? "" : headRefResult.stdout.trim();
      const branch = headRef.startsWith(LOCAL_BRANCH_REF_PREFIX)
        ? headRef.slice(LOCAL_BRANCH_REF_PREFIX.length)
        : null;
      if (opts.expectedBranch !== undefined && branch !== opts.expectedBranch) {
        throw new CommitBlockedError(
          `local HEAD is not on branch ${opts.expectedBranch}`,
        );
      }
      if (branch === null) {
        throw new Error(
          maskSecrets(
            `local HEAD is not on a branch: ${detached ? "detached" : headRef}`,
          ),
        );
      }
      // 以降の`rev-parse`には`--`を付けない(`buildGitArgv`の例外を参照)。
      // `git rev-parse -- <rev>`は、`--verify`では「Needed a single revision」で失敗し、
      // `--verify`なしでは`--`の行をそのまま出すことを確かめた。
      // 先頭の`-`は、ここの`assertBranchName`で防ぐ。
      assertBranchName(branch);

      const fetchResult = await opts.run(
        buildGitArgv(
          ["fetch", "--no-recurse-submodules", "origin", "--", branch],
          { network: true },
        ),
        { cwd: opts.dir, env: network },
      );
      if (fetchResult.exitCode !== 0) {
        throw gitError(`git fetch origin ${branch} failed`, fetchResult);
      }

      const remoteSha = await readExactRef({
        run: opts.run,
        cwd: opts.dir,
        env: local,
        ref: remoteTrackingRef(branch),
      });
      if (remoteSha === null) {
        throw new Error(`${remoteTrackingRef(branch)} does not exist`);
      }
      if (remoteSha !== opts.expectedHeadSha) {
        return { outcome: "head_changed" as const, currentSha: remoteSha };
      }

      if (opts.requireLocalHeadAtExpected === true) {
        const localShaResult = await opts.run(
          buildGitArgv(["rev-parse", "--verify", "HEAD"]),
          { cwd: opts.dir, env: local },
        );
        if (localShaResult.exitCode !== 0) {
          throw gitError("git rev-parse --verify HEAD failed", localShaResult);
        }
        const localSha = localShaResult.stdout.trim();
        if (localSha !== opts.expectedHeadSha) {
          throw new CommitBlockedError(
            `local HEAD ${localSha} is not the PR head ${opts.expectedHeadSha}`,
          );
        }
      }

      const addResult = await opts.run(buildGitArgv(["add", "-A"]), {
        cwd: opts.dir,
        env: local,
      });
      if (addResult.exitCode !== 0) {
        throw gitError("git add -A failed", addResult);
      }

      const statusResult = await opts.run(
        buildGitArgv(["status", "--porcelain"]),
        { cwd: opts.dir, env: local },
      );
      if (statusResult.stdout.trim().length === 0) {
        return { outcome: "nothing_to_commit" as const };
      }

      if (opts.inspectStaged !== undefined) {
        const unstage = async (): Promise<void> => {
          const resetResult = await opts.run(buildGitArgv(["reset", "-q"]), {
            cwd: opts.dir,
            env: local,
          });
          if (resetResult.exitCode !== 0) {
            throw gitError("git reset -q failed", resetResult);
          }
        };
        let reasons: readonly string[];
        try {
          reasons = await opts.inspectStaged();
        } catch (err) {
          // 検査できなかった内容をステージしたまま残さない。
          await unstage();
          throw err;
        }
        if (reasons.length > 0) {
          await unstage();
          // 理由に埋め込まれたファイル名などが、区切りで別の理由に見えないようにする。
          throw new CommitBlockedError(
            reasons.map(escapeReasonSeparator).join("; "),
          );
        }
      }

      const commitResult = await opts.run(
        buildGitArgv([
          "commit",
          "-m",
          withCommitTrailers(opts.message, opts.instanceName),
        ]),
        {
          cwd: opts.dir,
          env: { ...local, ...commitIdentityEnv(opts.author) },
        },
      );
      if (commitResult.exitCode !== 0) {
        throw gitError("git commit failed", commitResult);
      }

      const newShaResult = await opts.run(
        buildGitArgv(["rev-parse", "--verify", "HEAD"]),
        { cwd: opts.dir, env: local },
      );
      if (newShaResult.exitCode !== 0) {
        throw gitError("git rev-parse --verify HEAD failed", newShaResult);
      }
      const newSha = newShaResult.stdout.trim();
      assertSha(newSha);

      if (opts.expectedTreeSha !== undefined) {
        const treeResult = await opts.run(
          buildGitArgv(["rev-parse", "--verify", `${newSha}^{tree}`]),
          { cwd: opts.dir, env: local },
        );
        if (treeResult.exitCode !== 0) {
          throw gitError(
            `git rev-parse --verify ${newSha}^{tree} failed`,
            treeResult,
          );
        }
        if (treeResult.stdout.trim() !== opts.expectedTreeSha) {
          // 確かめていない内容のcommitをローカルにも残さない。変更はworktreeに残る。
          // 戻す先は`HEAD`からたどらずに明示する。残ったプロセスがHEADを動かしても、別のcommitへ戻さないため。
          const parent =
            opts.requireLocalHeadAtExpected === true
              ? opts.expectedHeadSha
              : `${newSha}~1`;
          const undoResult = await opts.run(
            buildGitArgv(["reset", "-q", parent, "--"]),
            { cwd: opts.dir, env: local },
          );
          if (undoResult.exitCode !== 0) {
            throw gitError(`git reset -q ${parent} failed`, undoResult);
          }
          throw new CommitBlockedError(COMMITTED_TREE_CHANGED_REASON);
        }
      }

      const pushResult = await opts.run(
        buildGitArgv(
          ["push", "origin", "--", `${newSha}:refs/heads/${branch}`],
          { network: true },
        ),
        { cwd: opts.dir, env: network },
      );
      if (pushResult.exitCode !== 0) {
        if (isNonFastForwardRejection(pushResult.stderr)) {
          const refetchResult = await opts.run(
            buildGitArgv(
              ["fetch", "--no-recurse-submodules", "origin", "--", branch],
              { network: true },
            ),
            { cwd: opts.dir, env: network },
          );
          if (refetchResult.exitCode !== 0) {
            throw gitError(
              `git fetch origin ${branch} failed (after push rejection)`,
              refetchResult,
            );
          }
          const currentSha = await readExactRef({
            run: opts.run,
            cwd: opts.dir,
            env: local,
            ref: remoteTrackingRef(branch),
          });
          if (currentSha === null) {
            throw new Error(
              `${remoteTrackingRef(branch)} does not exist (after push rejection)`,
            );
          }
          return { outcome: "head_changed" as const, currentSha };
        }
        throw gitError("git push failed", pushResult);
      }

      return { outcome: "pushed" as const, newSha };
    },
  });
}

// ---------------------------------------------------------------------------
// pushNewBranch(implementフロー): 実装ブランチを既定のブランチの先頭で公開する
// ---------------------------------------------------------------------------

export type PushNewBranchOptions = {
  readonly run: CommandRunner;
  /**
   * メインのcloneのディレクトリ(`ensureRepo`を参照)。
   * リポジトリごとの共有のロックを決めるのに使い、gitの実行もすべてここで行う。
   * worktreeはrefをメインのcloneと共有するので、ここでローカルのブランチを動かせば、
   * `createGtrWorktree`が作ったworktreeのブランチも動く。
   */
  readonly repoDir: string;
  readonly branch: string;
  /**
   * 既定のブランチの名前(`resolveDefaultBranchName`)。
   * ローカルの`refs/remotes/origin/HEAD`から読んだ値なので、リモートの`HEAD`と照合してから使う。
   */
  readonly baseBranch: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type PushNewBranchResult = {
  readonly pushed: boolean;
  /**
   * リモートに問い合わせて確かめた、既定のブランチの先頭のsha。
   * 呼び出し側は比較の基準をこのshaから求め(`mergeBaseSha`)、ローカルの短い名前`origin/<base>`を引き直さない。
   */
  readonly baseSha: string;
};

/** `git ls-remote --symref`の出力を読んだもの。キーはどちらも完全なref名である。 */
type LsRemoteRefs = {
  /** シンボリックrefの名前から、指す先のref名へ(`ref: <target>\t<name>`の行)。 */
  readonly symrefs: ReadonlyMap<string, string>;
  /** refの名前から、そのsha(`<sha>\t<name>`の行)。 */
  readonly shas: ReadonlyMap<string, string>;
};

const LS_REMOTE_SYMREF_PREFIX = "ref: ";

/**
 * `git ls-remote --symref`の標準出力を読む。
 * パターンはrefの末尾で一致し、`refs/heads/x/refs/heads/main`のような別のrefも返るので、
 * 呼び出し側は完全なref名で引く。形の合わない行は無視する。shaの検証は呼び出し側が行う。
 */
function parseLsRemoteSymref(stdout: string): LsRemoteRefs {
  const symrefs = new Map<string, string>();
  const shas = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const left = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (left.startsWith(LS_REMOTE_SYMREF_PREFIX)) {
      symrefs.set(name, left.slice(LS_REMOTE_SYMREF_PREFIX.length));
    } else {
      shas.set(name, left);
    }
  }
  return { symrefs, shas };
}

/**
 * リモートに`branch`が無ければ、リモートの既定のブランチの先頭で公開する。
 * まず`git ls-remote --symref origin HEAD refs/heads/<branch> refs/heads/<baseBranch>`の1回で、
 * リモートの`HEAD`の指す先、ブランチの有無、既定のブランチの先頭を読む。
 * 次のどれかに当たれば例外を投げ、ローカルのブランチを動かさず、何もpushしない。
 * - リモートの`HEAD`が`refs/heads/<baseBranch>`でない。
 * - リモートに`refs/heads/<baseBranch>`が無い。
 * - ローカルの追跡ref(`refs/remotes/origin/<baseBranch>`)が、リモートの既定のブランチの先頭と違う。
 * ローカルの`origin/HEAD`と追跡refは、検査コマンドが別のuidで動き書けない前提が崩れても、書き換えを検出するためである。
 * `--prune`なしのfetchは、書き換えられた`origin/HEAD`を直さない。
 * 照合は、リモートにブランチがあるときもする。返す`baseSha`から準備が比較の基準を求めるので、
 * そのcommitがローカルにあり(追跡refと同じ)、検査コマンドに差し替えられていないことを確かめるためである。
 *
 * リモートに`branch`があれば(push済みの後の再試行)、ブランチを動かさず`pushed: false`を返す。
 * ローカルの`origin/<branch>`を信じずにリモートへ問い合わせるのは、`ensureRepo`が`--prune`なしでfetchするので、
 * 人がGitHubでブランチを消した後に残った古い追跡refのせいでpushを飛ばしてはいけないためである。
 *
 * 無ければ、ローカルの`branch`を先頭へ`update-ref --no-deref`で向け直し、
 * ローカルのブランチではなく先頭のshaを`refs/heads/<branch>`へpushする。
 * ローカルのブランチには、検査コマンドが作ったcommitなど、検査していない履歴が残りうるためである
 * (リモートのブランチだけが消えた後の再実行)。
 * 削除して作り直さずに向け直すのは、checkout中のブランチも1回の操作で動かせ、worktreeを消さずに済むためである。
 * `--no-deref`は、ローカルのブランチがシンボリックrefにされていても、指す先の別のブランチを動かさないために付ける。
 * 向け直しはworktreeの中身を動かさないので、呼び出し側は公開の後にworktreeを`origin/<branch>`へそろえる(`prepareImplementWorktree`)。
 * 向け直しの後でpushに失敗したときは、ローカルのブランチが先頭を指し、worktreeには古いファイルが残る。
 * リモートにはまだブランチが無いので、次の実行がもう一度向け直してpushし、再利用の経路でworktreeを`origin/<branch>`へ戻す。
 *
 * ブランチを(空でも)公開しておけば、後のステップは`commitAndPush`
 * (`origin/<branch>`をfetchして`expectedHeadSha`と比べる)をそのまま使える。
 * このリポジトリの他のネットワーク操作と同じく、
 * `repoLockPath(repoDir)`のロックの下で実行する。
 */
export async function pushNewBranch(
  opts: PushNewBranchOptions,
): Promise<PushNewBranchResult> {
  assertBranchName(opts.branch);
  assertBranchName(opts.baseBranch);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const network = networkGitEnv(opts.ghToken, opts.home, opts.path);
      const local = localGitEnv(opts.home, opts.path);
      const branchRef = `refs/heads/${opts.branch}`;
      const remoteBaseRef = `refs/heads/${opts.baseBranch}`;
      const remote = await opts.run(
        buildGitArgv(
          ["ls-remote", "--symref", "origin", "HEAD", branchRef, remoteBaseRef],
          { network: true },
        ),
        { cwd: opts.repoDir, env: network },
      );
      assertOutputComplete(`git ls-remote origin in ${opts.repoDir}`, remote);
      if (remote.exitCode !== 0) {
        throw gitError(`git ls-remote origin ${opts.branch} failed`, remote);
      }
      const refs = parseLsRemoteSymref(remote.stdout);
      const remoteHead = refs.symrefs.get("HEAD");
      if (remoteHead !== remoteBaseRef) {
        throw new Error(
          maskSecrets(
            `origin HEAD is ${remoteHead ?? "unknown"}, not ${remoteBaseRef}`,
          ),
        );
      }
      const baseSha = refs.shas.get(remoteBaseRef);
      if (baseSha === undefined) {
        throw new Error(`origin has no ${remoteBaseRef}`);
      }
      assertSha(baseSha);

      // 完全なref名を一致させて読み、`origin/<baseBranch>`という名前のタグなどと取り違えない。
      const trackingRef = remoteTrackingRef(opts.baseBranch);
      const trackingSha = await readExactRef({
        run: opts.run,
        cwd: opts.repoDir,
        env: local,
        ref: trackingRef,
      });
      if (trackingSha === null) {
        throw new Error(`${trackingRef} does not exist`);
      }
      if (trackingSha !== baseSha) {
        throw new Error(
          maskSecrets(
            `${trackingRef} (${trackingSha}) does not match origin's ${remoteBaseRef} (${baseSha})`,
          ),
        );
      }

      if (refs.shas.has(branchRef)) {
        return { pushed: false, baseSha };
      }

      const moveResult = await opts.run(
        buildGitArgv([
          "update-ref",
          "--no-deref",
          "-m",
          "factory: publish the branch at the base",
          "--",
          branchRef,
          baseSha,
        ]),
        { cwd: opts.repoDir, env: local },
      );
      if (moveResult.exitCode !== 0) {
        throw gitError(
          `git update-ref ${branchRef} ${baseSha} failed`,
          moveResult,
        );
      }

      const refspec = `${baseSha}:${branchRef}`;
      const pushResult = await opts.run(
        buildGitArgv(["push", "origin", "--", refspec], { network: true }),
        { cwd: opts.repoDir, env: network },
      );
      if (pushResult.exitCode !== 0) {
        throw gitError(`git push origin ${refspec} failed`, pushResult);
      }
      return { pushed: true, baseSha };
    },
  });
}

// ---------------------------------------------------------------------------
// deleteRemoteBranch / currentRemoteHeadSha(implementフロー)
// ---------------------------------------------------------------------------

export type DeleteRemoteBranchOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type DeleteRemoteBranchResult = { readonly deleted: boolean };

/**
 * `push --delete`で、リモートにもう無いブランチを指定したときにgitが出す文言
 * (「error: unable to delete '<b>': remote ref does not exist」)。
 */
const REMOTE_REF_MISSING_SUBSTRING = "remote ref does not exist";

/**
 * メインのcloneから`git push --delete origin <branch>`を実行する。
 * PRが無いまま`requirements_gap`で終わるときに、空か作りかけのブランチを消し、
 * 再承認後の実装をきれいな状態から始めるために使う。
 * リモートのrefがすでに無ければ、例外を投げず`deleted: false`を返す。
 * それ以外の失敗では例外を投げる。
 */
export async function deleteRemoteBranch(
  opts: DeleteRemoteBranchOptions,
): Promise<DeleteRemoteBranchResult> {
  assertBranchName(opts.branch);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const result = await opts.run(
        buildGitArgv(["push", "--delete", "origin", "--", opts.branch], {
          network: true,
        }),
        {
          cwd: opts.repoDir,
          env: networkGitEnv(opts.ghToken, opts.home, opts.path),
        },
      );
      if (result.exitCode === 0) return { deleted: true };
      if (result.stderr.toLowerCase().includes(REMOTE_REF_MISSING_SUBSTRING)) {
        return { deleted: false };
      }
      throw gitError(`git push --delete origin ${opts.branch} failed`, result);
    },
  });
}

export type CurrentRemoteHeadShaOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
};

/**
 * `repoDir`で`refs/remotes/origin/<branch>`が今指すshaを返す(`readExactRef`)。
 * リモート追跡のrefがローカルに無いときは`null`を返す
 * (一度もfetchしていない、ブランチが消された)。
 * `resolveDefaultBranchHeadSha`と同じく読み取りだけのローカルの操作で、
 * リモートの今の状態が要るときは呼び出し側が先にfetchする。
 * 結果は`commitAndPush`の`expectedHeadSha`に渡るので、ここで`assertSha`で検証する。
 */
export async function currentRemoteHeadSha(
  opts: CurrentRemoteHeadShaOptions,
): Promise<string | null> {
  assertBranchName(opts.branch);
  const sha = await readExactRef({
    run: opts.run,
    cwd: opts.repoDir,
    env: localGitEnv(opts.home, opts.path),
    ref: remoteTrackingRef(opts.branch),
  });
  if (sha === null) return null;
  assertSha(sha);
  return sha;
}

// ---------------------------------------------------------------------------
// resolveDefaultBranchName / mergeBaseSha / deleteLocalBranch(implementフロー)
// ---------------------------------------------------------------------------

/**
 * `ensureRepo`のcloneのシンボリックref`refs/remotes/origin/HEAD`から、
 * 対象リポジトリの既定のブランチ名を返す
 * (`--no-checkout`のcloneで`refs/remotes/origin/main`になることを確かめた)。
 * `--short`は付けない。`refs/heads/origin/main`があると、
 * `--short`は曖昧さを避けて`remotes/origin/main`を返し、ブランチ名を読み違えるため。
 * implementフローがPRのbaseにし、
 * `git gtr new`が新しいworktreeの分岐元にするブランチである。
 * ローカルだけの操作で、先に`ensureRepo`を実行しておく必要がある。
 */
export async function resolveDefaultBranchName(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly home?: string;
  readonly path?: string;
}): Promise<string> {
  const result = await opts.run(
    buildGitArgv(["symbolic-ref", REMOTE_HEAD_REF]),
    {
      cwd: opts.repoDir,
      env: localGitEnv(opts.home, opts.path),
    },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git symbolic-ref ${REMOTE_HEAD_REF} failed in ${opts.repoDir}`,
      result,
    );
  }
  const ref = result.stdout.trim();
  if (!ref.startsWith(REMOTE_TRACKING_PREFIX)) {
    throw new Error(
      `unexpected ${REMOTE_HEAD_REF} target: ${JSON.stringify(ref)}`,
    );
  }
  const branch = ref.slice(REMOTE_TRACKING_PREFIX.length);
  assertBranchName(branch);
  return branch;
}

export type WorktreeGitOptions = {
  readonly run: CommandRunner;
  readonly worktreeDir: string;
  readonly home?: string;
  readonly path?: string;
};

/**
 * 実装用のworktreeで`git merge-base -- <baseSha> HEAD`を実行し、
 * ブランチが既定のブランチから分かれた点のshaを返す。失敗したら例外を投げる。
 * `baseSha`には、`pushNewBranch`がリモートと照合した既定のブランチの先頭を渡す。
 * 短い名前の`origin/<base>`は、検査コマンドが作る`refs/heads/origin/<base>`や`refs/tags/origin/<base>`が先に解決されうるため、引き直さない。
 * implementフローは毎ラウンドこれと比べるので、ブランチに以前コミットした変更
 * (`needs_human`での途中のpush、既存のPR)も差分に含まれる。
 * このモジュールの規則どおりリビジョンの前に`--`を置く
 * (`git merge-base -- <a> <b>`は`--`なしと同じに解決する)。
 * `baseSha`は`assertSha`で検証する。
 */
export async function mergeBaseSha(
  opts: WorktreeGitOptions & { readonly baseSha: string },
): Promise<string> {
  assertSha(opts.baseSha);
  const result = await opts.run(
    buildGitArgv(["merge-base", "--", opts.baseSha, "HEAD"]),
    {
      cwd: opts.worktreeDir,
      env: localGitEnv(opts.home, opts.path),
    },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git merge-base ${opts.baseSha} HEAD failed in ${opts.worktreeDir}`,
      result,
    );
  }
  const sha = result.stdout.trim();
  assertSha(sha);
  return sha;
}

export type DeleteLocalBranchOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type DeleteLocalBranchResult = { readonly deleted: boolean };

/**
 * 無いブランチに`branch -D`したときにgitが出す文言
 * (「error: branch '<b>' not found」、終了コード1になることを確かめた)。
 */
const LOCAL_BRANCH_MISSING_SUBSTRING = "not found";

/**
 * メインのcloneで`git branch -D -- <branch>`を実行する。
 * ブランチが無ければ`deleted: false`を返し、それ以外の失敗では例外を投げる。
 * `removeWorktree`はローカルのブランチを残すので、PRが無いまま`requirements_gap`で
 * 終わるときはブランチも消す。消さないと、再承認後の実装が古いブランチから始まる。
 * checkout中のブランチはgitが削除を拒むので、先にworktreeを削除しておく。
 */
export async function deleteLocalBranch(
  opts: DeleteLocalBranchOptions,
): Promise<DeleteLocalBranchResult> {
  assertBranchName(opts.branch);
  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const result = await opts.run(
        buildGitArgv(["branch", "-D", "--", opts.branch]),
        {
          cwd: opts.repoDir,
          env: localGitEnv(opts.home, opts.path),
        },
      );
      if (result.exitCode === 0) return { deleted: true };
      if (result.stderr.toLowerCase().includes(LOCAL_BRANCH_MISSING_SUBSTRING))
        return { deleted: false };
      throw gitError(`git branch -D ${opts.branch} failed`, result);
    },
  });
}

// ---------------------------------------------------------------------------
// worktreeFingerprint / runGitleaksOnWorktree(implementフローの検証ループ)
// ---------------------------------------------------------------------------

async function stageAll(opts: WorktreeGitOptions): Promise<void> {
  const result = await opts.run(buildGitArgv(["add", "-A"]), {
    cwd: opts.worktreeDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (result.exitCode !== 0)
    throw gitError(`git add -A failed in ${opts.worktreeDir}`, result);
}

/**
 * 実装用のworktreeで`git clean -fdX`を実行し、無視されたファイルだけを消す。
 * 失敗したら例外を投げる。
 * 大文字の`X`なので、無視されていない未追跡のファイル(Claudeの作業)は残る。
 * 毎ラウンドの検査コマンドの前に実行し、前のコマンドが無視されたパス(`node_modules/`、
 * ビルドの出力、キャッシュ)に残したもの(Claudeの以前のコードの影響を受けうる)を
 * 次の実行に持ち越さない。検査コマンドは依存を自分でインストールする。
 */
export async function removeIgnoredFiles(
  opts: WorktreeGitOptions,
): Promise<void> {
  const result = await opts.run(buildGitArgv(["clean", "-fdX"]), {
    cwd: opts.worktreeDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (result.exitCode !== 0)
    throw gitError(`git clean -fdX failed in ${opts.worktreeDir}`, result);
}

function countOrZero(text: string | undefined): number {
  if (text === undefined || text === "-") return 0;
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/**
 * `git diff --numstat`の出力を集計して返す。空でない1行を1ファイルと数える。
 * バイナリファイルの`-`は行数を0として足す(ファイル数には数える)。
 */
export function parseNumstatTotals(stdout: string): ImplementDiffStat {
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const [addedText, deletedText] = line.split("\t");
    files += 1;
    added += countOrZero(addedText);
    deleted += countOrZero(deletedText);
  }
  return { files, added, deleted };
}

export type WorktreeFingerprint = {
  /**
   * worktreeをすべてステージした状態の`git write-tree`。
   * worktreeの内容(未追跡のファイルを含む)が同じときに限り、同じ値になる。
   */
  readonly treeSha: string;
  /** ステージした状態と`baseSha`の差分。`files === 0`ならbaseとの違いは無い。 */
  readonly diffStat: ImplementDiffStat;
};

/**
 * すべての変更をステージ(`git add -A`)し、その`git write-tree`を返す。
 * 今コミットしたら記録されるツリーに当たる。
 * `implement_finish`がコミットの前に、ループで検証した`verified_tree_sha`と比べる。
 */
export async function stagedTreeSha(opts: WorktreeGitOptions): Promise<string> {
  await stageAll(opts);
  return indexTreeSha(opts);
}

/**
 * ステージし直さずに、今の索引の`git write-tree`を返す。
 * `commitAndPush`の`inspectStaged`から呼び、commitする索引そのものを調べるのに使う。
 */
export async function indexTreeSha(opts: WorktreeGitOptions): Promise<string> {
  const tree = await opts.run(buildGitArgv(["write-tree"]), {
    cwd: opts.worktreeDir,
    env: localGitEnv(opts.home, opts.path),
  });
  assertOutputComplete(`git write-tree in ${opts.worktreeDir}`, tree);
  if (tree.exitCode !== 0)
    throw gitError(`git write-tree failed in ${opts.worktreeDir}`, tree);
  const treeSha = tree.stdout.trim();
  assertSha(treeSha);
  return treeSha;
}

export const WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON =
  "worktree changed after the secret scan";

/**
 * 今ステージしてある内容(`git write-tree`)が、秘密の検査をしたツリー`scannedTreeSha`と違えば止める理由を返す(同じなら空)。
 * ステージし直さない。`commitAndPush`の`inspectStaged`から呼び、commitする索引そのものを比べるため。
 * 検査とcommitの間に、残ったプロセスがworktreeを書き換えても、検査していない内容をpushしない。
 */
export async function scannedTreeStopReasons(
  opts: WorktreeGitOptions & { readonly scannedTreeSha: string },
): Promise<string[]> {
  return (await indexTreeSha(opts)) === opts.scannedTreeSha
    ? []
    : [WORKTREE_CHANGED_AFTER_SECRET_SCAN_REASON];
}

/**
 * すべての変更をステージし、その状態の指紋と`baseSha`との差分の大きさを返す。
 * ステージ(`git add -A`)は、後でもう一度ステージする`commitAndPush`の邪魔にならない。
 * 指紋は`git write-tree`で取り、進展が止まったことの検出に使う
 * (ただの`git diff`では新しいファイルを見落とすため)。
 * 差分の大きさは`git diff --cached --numstat`で測り、`implement_rounds.diff_stat`と
 * 差分の大きさの上限の検査に使う。
 */
export async function worktreeFingerprint(
  opts: WorktreeGitOptions & { readonly baseSha: string },
): Promise<WorktreeFingerprint> {
  assertSha(opts.baseSha);
  const treeSha = await stagedTreeSha(opts);
  const env = localGitEnv(opts.home, opts.path);
  const numstat = await opts.run(
    buildGitArgv([
      "diff",
      "--cached",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      opts.baseSha,
      "--",
    ]),
    { cwd: opts.worktreeDir, env },
  );
  assertOutputComplete(
    `git diff --cached --numstat in ${opts.worktreeDir}`,
    numstat,
  );
  if (numstat.exitCode !== 0) {
    throw gitError(
      `git diff --cached --numstat failed in ${opts.worktreeDir}`,
      numstat,
    );
  }
  return { treeSha, diffStat: parseNumstatTotals(numstat.stdout) };
}

export type GitleaksResult = { readonly ok: boolean; readonly output: string };

/**
 * `runGitleaksOnWorktree`の結果。`treeSha`は検査した差分の変更後のツリー(`git write-tree`)。
 * commitの直前に`scannedTreeStopReasons`で比べ、検査した内容だけをpushするために使う。
 */
export type GitleaksScan = GitleaksResult & { readonly treeSha: string };

export type GitleaksConfigDir = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

const GITLEAKS_CONFIG_FILE = "gitleaks.toml";

/**
 * gitleaksの組み込みの規則だけを使う設定。`--config`で強制する。
 * 対象リポジトリの`.gitleaks.toml`(Claudeが書いたかもしれない)に何も許可させず、
 * 壊れた`.gitleaks.toml`で検査を中断させないため。
 * 同じ専用のディレクトリを`--gitleaks-ignore-path`(と検査のcwd)にしてリポジトリの
 * `.gitleaksignore`を読ませず、
 * `--ignore-gitleaks-allow`で行内の`gitleaks:allow`を無効にする。
 * 検査をリポジトリの設定から独立させるため。
 */
export const GITLEAKS_DEFAULT_ONLY_CONFIG = "[extend]\nuseDefault = true\n";

const GITLEAKS_LEAKS_EXIT_CODE = 1;
const GITLEAKS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * gitleaksに渡すステージ済みの差分の大きさの上限。
 * 上限で切った差分は途中が検査されないので、上限に達したら検査を失敗にする。
 */
const GITLEAKS_MAX_DIFF_BYTES = 32 * 1024 * 1024;

const defaultCreateGitleaksConfigDir = async (): Promise<GitleaksConfigDir> => {
  const dir = await mkdtemp(join(jobTmpBase(), "factory-gitleaks-"));
  try {
    await writeFile(
      join(dir, GITLEAKS_CONFIG_FILE),
      GITLEAKS_DEFAULT_ONLY_CONFIG,
      { mode: 0o600 },
    );
  } catch (err) {
    // 呼び出し側のtry/finallyはこの関数が返ってから始まるので、
    // 書き込みに失敗したら、作ったばかりのディレクトリをここで消す。
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    path: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

type GitleaksFinding = {
  readonly RuleID: string;
  readonly File: string;
  readonly StartLine: number;
};

function isGitleaksFinding(value: unknown): value is GitleaksFinding {
  return (
    isRecord(value) &&
    isString(value.RuleID) &&
    isString(value.File) &&
    isNumber(value.StartLine)
  );
}

const C_QUOTE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * gitがC言語風に引用したパス(引用符の間の文字列)を元に戻して返す。
 * `\t \n \" \\`などの1文字のエスケープと、`\NNN`の8進数のバイト
 * (まとめてUTF-8としてデコードする)を戻す。エスケープが不正なら`null`を返す。
 */
function unquoteCStyle(quoted: string): string | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < quoted.length; i += 1) {
    const char = quoted.charAt(i);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = quoted.charAt(i + 1);
    const octal = quoted.slice(i + 1, i + 4);
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    const escaped = C_QUOTE_ESCAPES[next];
    if (escaped === undefined) return null;
    bytes.push(escaped);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * `+++ `で始まるファイルのヘッダー行から、変更後のパスを返す。
 * `+++ b/<path>`ならそのパスを返す(空白を含む名前にgitが付ける末尾のタブ1つは除く)。
 * C言語風に引用された`+++ "b/<path>"`なら、エスケープを戻したパスを返す。
 * `+++ /dev/null`(削除)なら`null`、それ以外の行なら`undefined`を返す。
 */
function newPathFromHeader(line: string): string | null | undefined {
  const text = line.endsWith("\t") ? line.slice(0, -1) : line;
  if (text === "+++ /dev/null") return null;
  if (text.startsWith("+++ b/")) return text.slice("+++ b/".length);
  if (text.startsWith('+++ "b/') && text.endsWith('"') && text.length > 7) {
    const path = unquoteCStyle(text.slice('+++ "b/'.length, -1));
    return path ?? undefined;
  }
  return undefined;
}

/**
 * `git diff`の文字列の`line`行目(1始まり)が属するファイルのパスを返す。
 * 同じファイルの区画で、直前にある`+++ b/<path>`のヘッダーのパスである。
 * gitleaksの`stdin`の検出結果にはファイル名が無く、この行番号しか無いため。
 * ヘッダーは`diff --git`の行と最初の`@@`のハンクの間でだけ読むので、
 * ハンクの中のヘッダーに見える追加行(`+++ b/x`)をヘッダーとみなすことは無い。
 * どのヘッダーより前と、削除されたファイルの区画(`+++ /dev/null`)では`null`を返す。
 */
export function mapDiffLineToFile(
  diffText: string,
  line: number,
): string | null {
  const lines = diffText.split("\n");
  let file: string | null = null;
  let inHeader = false;
  for (const text of lines.slice(0, Math.max(0, line))) {
    if (text.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (!inHeader) continue;
    if (text.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    const path = newPathFromHeader(text);
    if (path !== undefined) file = path;
  }
  return file;
}

/**
 * `diffText`から、ハンクの中の削除行(`-`)を除いて返す。
 * 削除行はbaseにすでにあるので、`gitleaks git`と同じく、
 * ブランチが追加するものだけを検査する。
 * ファイルのヘッダー(`--- a/<path>`)はハンクの外にあるので残る。
 */
export function dropRemovedDiffLines(diffText: string): string {
  let inHunk = false;
  const kept: string[] = [];
  for (const text of diffText.split("\n")) {
    if (text.startsWith("diff --git ")) {
      inHunk = false;
    } else if (!inHunk && text.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && text.startsWith("-")) {
      continue;
    }
    kept.push(text);
  }
  return kept.join("\n");
}

/**
 * gitleaksの`stdin`のJSONのレポートを、検出1件につき`- <rule>: <file>`の1行にして返す。
 * ファイルは、検出の行番号から`diffText`で引く(`mapDiffLineToFile`)。
 * 差分の中の行番号は読み手にとって意味が無いので出さない。
 * 一致した文字列は、伏せたものでも決して出さない。
 * `stdout`がJSONの配列でなければ`null`を返す。
 */
export function formatGitleaksReport(
  stdout: string,
  diffText: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const lines = parsed
    .filter(isGitleaksFinding)
    .map(
      (finding) =>
        `- ${finding.RuleID}: ${mapDiffLineToFile(diffText, finding.StartLine) ?? "(unknown file)"}`,
    );
  const unexpected = parsed.length - lines.length;
  if (unexpected > 0)
    lines.push(
      `- (${String(unexpected)} more finding(s) in an unexpected shape)`,
    );
  return lines.join("\n");
}

/**
 * 固定の秘密情報の検査(workerのイメージのgitleaks 8.30.1)を実行する。implementフローとpr_fixが使う。
 * すべての変更をステージしてそのツリーを`git write-tree`で記録し、`baseSha`とそのツリーの差分を取り、削除行を除いて、
 * 専用の一時ディレクトリで動く`gitleaks stdin`に渡す。
 * 差分は`git diff --text --no-ext-diff --no-textconv -U0 <baseSha> <tree>`で取る。
 * 索引ではなく記録したツリーと比べるのは、返す`treeSha`が検査した内容とちょうど一致するようにするため。
 * `.gitattributes`のbinary・`-diff`・textconvの設定で内容を隠させず、
 * 毎ラウンド、merge-base以降のブランチ全体を検査するため。
 * リポジトリの中のもの(ignoreファイル、attributes、設定)はgitleaksに届かない。
 * 終了コード0なら`ok: true`を返す。終了コード1で完全なJSONのレポートがあれば、
 * 検出1件につき1行(伏せ字済み)の`ok: false`を返す。どちらも検査したツリーの`treeSha`を添える。
 * 差分かレポートが上限で切れたとき、どれかの出力の読み取りを打ち切ったとき、終了コード1でJSONが無いとき、
 * それ以外の終了コード(不明なオプションなら126)、タイムアウトのときは例外を投げ、「漏洩なし」とはみなさない。
 */
export async function runGitleaksOnWorktree(
  opts: WorktreeGitOptions & {
    readonly baseSha: string;
    readonly timeoutMs: number;
    readonly createConfigDir?: () => Promise<GitleaksConfigDir>;
  },
): Promise<GitleaksScan> {
  assertSha(opts.baseSha);
  const treeSha = await stagedTreeSha(opts);
  const diff = await opts.run(
    buildGitArgv([
      "diff",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U0",
      opts.baseSha,
      treeSha,
      "--",
    ]),
    {
      cwd: opts.worktreeDir,
      env: localGitEnv(opts.home, opts.path),
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: GITLEAKS_MAX_DIFF_BYTES,
    },
  );
  if (diff.timedOut)
    throw new Error(
      `git diff of the staged tree timed out after ${String(opts.timeoutMs)}ms`,
    );
  assertOutputComplete(
    `git diff of the staged tree in ${opts.worktreeDir}`,
    diff,
  );
  if (diff.exitCode !== 0)
    throw gitError(
      `git diff of the staged tree failed in ${opts.worktreeDir}`,
      diff,
    );
  if (isCappedOutput(diff.stdout))
    throw new Error("the staged diff exceeded the scan cap");
  const scanned = dropRemovedDiffLines(diff.stdout);
  const configDir = await (
    opts.createConfigDir ?? defaultCreateGitleaksConfigDir
  )();
  try {
    const result = await opts.run(
      [
        "gitleaks",
        "stdin",
        "--redact",
        "--no-banner",
        "--no-color",
        "--log-level",
        "error",
        "--exit-code",
        String(GITLEAKS_LEAKS_EXIT_CODE),
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--config",
        join(configDir.path, GITLEAKS_CONFIG_FILE),
        "--gitleaks-ignore-path",
        configDir.path,
        "--ignore-gitleaks-allow",
      ],
      {
        cwd: configDir.path,
        env: localGitEnv(opts.home, opts.path),
        stdin: scanned,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: GITLEAKS_MAX_OUTPUT_BYTES,
      },
    );
    if (result.timedOut)
      throw new Error(`gitleaks timed out after ${String(opts.timeoutMs)}ms`);
    assertOutputComplete("gitleaks", result);
    if (result.exitCode === 0) return { ok: true, output: "", treeSha };
    if (result.exitCode === GITLEAKS_LEAKS_EXIT_CODE) {
      if (isCappedOutput(result.stdout))
        throw new Error("gitleaks report exceeded the output cap");
      const report = formatGitleaksReport(result.stdout, scanned);
      if (report !== null) {
        return {
          ok: false,
          output: maskSecrets(
            report.length === 0 ? "gitleaks reported a leak" : report,
          ),
          treeSha,
        };
      }
    }
    throw new Error(
      maskSecrets(
        `gitleaks failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
      ),
    );
  } finally {
    await configDir.cleanup();
  }
}
