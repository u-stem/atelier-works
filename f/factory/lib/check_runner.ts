// `allowed_check_commands`の実行。
// 対象リポジトリの検査コマンドを、検査用の非特権uidに落として(`check_sandbox.ts`)、
// 許可リストの環境変数だけで実行する。
// 呼び出し側(`implement_verify`、`pr_fix_verify`)は、実行するコマンドのランナーを注入する。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECK_GITCONFIG_NAME,
  type CheckSandbox,
  checkEnv,
  checkGitConfig,
  checkTmpDir,
  type EscapingSymlinksReport,
} from "./check_sandbox.ts";
import { escapeReasonSeparator, maskSecrets } from "./log.ts";
import type { CommandRunner } from "./workspace.ts";

export type CheckCommandResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly outputTail: string;
  /**
   * stdoutとstderrを合わせた出力のうち、`CHECK_COMMAND_MAX_OUTPUT_BYTES`の範囲で
   * 残った全体を、秘密をマスクして持つ。implementフローはその先頭16KBを
   * `implement_rounds.check_output`に保存する(`truncateCheckOutput`)。
   * プロンプトに載せる抜粋は引き続き`outputTail`を使う。
   */
  readonly output: string;
};

const CHECK_OUTPUT_TAIL_CHARS = 2000;

/** `checkUnrunnableReason`が返す理由の先頭。回復の処理が、理由の先頭一致で保留に写す。 */
export const CHECK_UNRUNNABLE_REASON_PREFIX = "check command could not run: ";

/**
 * 検査コマンドを実行できなかった(環境の問題)ときの理由を返す(describeReasonが訳す)。
 * コマンドと詳細は`"; "`を含みうるので、別の理由に見えないよう置き換える。
 * 実装フローとPR修正のフローが共有する。
 */
export function checkUnrunnableReason(command: string, detail: string): string {
  return `${CHECK_UNRUNNABLE_REASON_PREFIX}${reasonText(command)}: ${reasonText(detail)}`;
}

/** 理由に入れる文字列の長さの上限(コードポイント数)。 */
const REASON_TEXT_MAX_CHARS = 200;

/**
 * 理由に入れる文字列を整える。ANSIのエスケープシーケンスと制御文字(NULを含む)を取り除き、
 * 秘密値をマスクし、`"; "`を置き換え、長さを切る。理由は`work_items.status_reason`に入り、PostgreSQLの`text`はNULを受け付けず、
 * 検査コマンドの出力はコードが決めるためである。
 */
function reasonText(text: string): string {
  const chars = [...text];
  let kept = "";
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? "";
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      // CSI(`ESC [`、パラメータとオプションの後に、0x40から0x7eの終端の1文字)を読み飛ばす。
      if (chars[i + 1] === "[") {
        i += 2;
        while (i < chars.length) {
          const next = chars[i]?.codePointAt(0) ?? 0;
          if (next >= 0x40 && next <= 0x7e) break;
          i += 1;
        }
      }
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    kept += char;
  }
  // 制御文字で分けられた秘密値が、取り除いた後につながるので、取り除いた後にマスクする。切る前にマスクして、秘密値を途中で切って残さない。
  return escapeReasonSeparator(
    [...maskSecrets(kept)].slice(0, REASON_TEXT_MAX_CHARS).join(""),
  );
}

/**
 * `setpriv`が検査コマンドの実行ファイルを起動できなかったときの終了コード。
 * 見つからない(ENOENT)が127、実行できない(EACCES)が126である。
 */
const SETPRIV_EXEC_FAILURE_EXIT_CODES: readonly number[] = [126, 127];
const SETPRIV_EXEC_FAILURE_PREFIX = "setpriv: failed to execute ";

/** 検査コマンドの結果のうち、実行できなかったかの判定に使う部分。 */
type CheckOutcome = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode?: number | undefined;
  readonly output: string;
};

/**
 * 検査コマンドの結果が、コードの失敗ではなく、実行ファイルを起動できなかったことを表すかを返す。
 * `setpriv`が起動に失敗すると、何も実行されず、出力は`setpriv`のその1行だけになる。
 * 検査コマンド自身が127を返した場合や、出力に同じ語を含むだけの場合は、Claudeが直せる失敗なので当てはまらない。
 * 先頭の語が相対パスで`/`を含むコマンドも当てはまらない。worktreeの中を指す実行ファイルを、
 * コードが消したか実行権を落とした失敗を、環境の問題と取り違えないためである。
 * 絶対パスは、worktreeの外のイメージの道具を指すので、当てはまる。
 */
export function isCheckUnrunnable(result: CheckOutcome): boolean {
  const program = result.command.trim().split(/\s+/)[0] ?? "";
  // 相対パスで`/`を含むものは、worktreeの中を指す。絶対パスは、worktreeの外のイメージの道具を指す。
  const insideWorktree = program.includes("/") && !program.startsWith("/");
  return (
    !result.ok &&
    !insideWorktree &&
    result.exitCode !== undefined &&
    SETPRIV_EXEC_FAILURE_EXIT_CODES.includes(result.exitCode) &&
    result.output.startsWith(SETPRIV_EXEC_FAILURE_PREFIX)
  );
}

/**
 * 結果のうち、最初に実行できなかった検査コマンドの理由を返す(`checkUnrunnableReason`)。
 * 無ければ`null`を返す。
 */
export function firstUnrunnableCheckReason(
  results: readonly CheckOutcome[],
): string | null {
  const unrunnable = results.find(isCheckUnrunnable);
  if (unrunnable === undefined) return null;
  return checkUnrunnableReason(
    unrunnable.command,
    unrunnable.output.split("\n", 1)[0] ?? "",
  );
}

export const CHECK_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 検査コマンドに渡す`PATH`。workerのPATHは引き継がず、この固定値を使う。
 * workerのPATHに、rootのホームや書き込める一時ディレクトリが入っていても、
 * そこに置かれた実行ファイルを検査コマンドが名前の解決で拾わないようにするため。
 * workerのイメージでは、bun・bunx(bunへのsymlink)・node・git・wmillが`/usr/bin`に、ghとgitleaksが`/usr/local/bin`に、
 * goが`/usr/local/go/bin`にある。どれもrootが所有する。
 * 値の説明は`docs/security.md`の「検査コマンドはフローが実行する」にある。
 */
export const CHECK_COMMAND_PATH =
  "/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin";

/** 検査コマンドのHOMEを作るディレクトリ。誰でも入れる(sticky付きの1777)、rootが所有するディレクトリである。 */
const CHECK_HOME_PARENT = "/tmp";

export type CheckHomeDir = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type CreateCheckHomeDir = (input: {
  readonly worktreeDir: string;
}) => Promise<CheckHomeDir>;

/** `createCheckHomeDir`が使うファイル操作。テストで失敗を差し込むために注入できる。 */
export type CheckHomeDirOps = {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly mkdir: (path: string, options: { mode: number }) => Promise<unknown>;
  readonly writeFile: (
    path: string,
    data: string,
    options: { mode: number },
  ) => Promise<void>;
  readonly rm: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
};

/**
 * `runAllowedCheckCommands`の1回の呼び出し用に、新しい非公開の一時ディレクトリを作る。
 * 検査コマンドは信頼できない対象リポジトリのコードを、コンテナの分離なしに実行する。
 * 全実行で共有する固定の`/tmp/factory-home`だと、ある実行の検査ツールが残した
 * キャッシュファイルや仕込まれた設定が残り、別のPRやリポジトリに対する
 * 後の実行に読まれうる。
 * `claude.ts`の`buildSystemPrompt` / `WriteTempFile`と同じく、
 * mkdtempと後始末の形にしている。
 * 中に検査コマンドの`TMPDIR`(`checkTmpDir`、0700)も作る。共有の`/tmp`に置かれたファイルは、
 * 同じuidを次に使う別のリポジトリの検査から読めるためである。
 * 置き場所は`os.tmpdir()`(`TMPDIR`)ではなく、固定の`/tmp`にする。
 * ジョブの`TMPDIR`は検査用のuidが入れない0700の下を指し、そこに作るとHOMEにたどり着けないためである。
 * 直下に、worktreeだけを`safe.directory`にする`.gitconfig`(`checkGitConfig`)を置く。
 * 検査コマンドの中のテストが`GIT_`の環境変数を外してgitを起動しても、検査用のuidがrootの所有のmain cloneの`.git`を読めるようにするためである。
 * 本文はrootが書き、実行の前の受け渡しで検査用のuidの所有になる。
 * 本文を作れないパスは、HOMEを作る前に拒み、消し残しを作らない。
 */
const defaultHomeDirOps: CheckHomeDirOps = { mkdtemp, mkdir, writeFile, rm };

export async function createCheckHomeDir(
  { worktreeDir }: { readonly worktreeDir: string },
  ops: CheckHomeDirOps = defaultHomeDirOps,
): Promise<CheckHomeDir> {
  const gitConfig = checkGitConfig(worktreeDir);
  const dir = await ops.mkdtemp(join(CHECK_HOME_PARENT, "factory-check-home-"));
  try {
    await ops.mkdir(checkTmpDir(dir), { mode: 0o700 });
    await ops.writeFile(join(dir, CHECK_GITCONFIG_NAME), gitConfig, {
      mode: 0o600,
    });
  } catch (error) {
    // 掃除の失敗で、元のエラーを隠さない。
    await ops.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: dir,
    cleanup: async () => {
      await ops.rm(dir, { recursive: true, force: true });
    },
  };
}

const defaultCreateCheckHomeDir: CreateCheckHomeDir = (input) =>
  createCheckHomeDir(input);

const ESCAPING_SYMLINKS_COMMAND = "check sandbox: symlink scan";
const ESCAPING_SYMLINKS_LISTED = 20;

/** 検出が不完全だったことと、追跡されているsymlinkが書き換えられたことを、失敗した検査として表す。 */
function escapingSymlinksResult(
  report: EscapingSymlinksReport,
): CheckCommandResult {
  const listed = report.problems.slice(0, ESCAPING_SYMLINKS_LISTED).join("\n");
  const more =
    report.problems.length > ESCAPING_SYMLINKS_LISTED
      ? `\n... and ${String(report.problems.length - ESCAPING_SYMLINKS_LISTED)} more`
      : "";
  const removed =
    report.removed.length > 0
      ? `\n${String(report.removed.length)} symlinks pointing outside the worktree were also removed.`
      : "";
  const output = maskSecrets(
    `the symlink scan after the check found a problem:\n${listed}${more}${removed}`,
  );
  return {
    command: ESCAPING_SYMLINKS_COMMAND,
    ok: false,
    exitCode: 1,
    timedOut: false,
    outputTail: output.slice(-CHECK_OUTPUT_TAIL_CHARS),
    output,
  };
}

/**
 * `allowed_check_commands`の各項目を、`cwd`で順に実行する。
 * 環境変数は許可リスト(`checkEnv`。固定のPATH(`CHECK_COMMAND_PATH`)、新しい非公開のHOMEとその下のTMPDIR、ロケール、
 * worktreeだけを信頼するgitの設定)で作り、workerの秘密は引き継がない。
 * HOMEの`.gitconfig`にも、同じgitの設定を書く。
 * 終わったらHOMEのディレクトリを消す。`docs/internals/pr-workflow.md`の「検査コマンドの実行」に書く。
 * `sandbox`があれば、コマンドを検査用の非特権uidに落として実行する(`setpriv`)。
 * 実行の前にworktreeとHOMEをそのuidに渡し、コマンドごとに残ったプロセスを止め、
 * 実行の後(失敗しても)所有権をrootに戻してからHOMEを消す。
 * 戻すのに失敗したときはHOMEを消さない。止まらないプロセスが書き換えている木をrootでたどらないためで、
 * HOMEは枠の記録に残り、次にその枠を取る実行が片付ける。
 * 取り戻しの後に、検査が置いたworktreeの外を指すsymlinkを調べて消す。
 * 検出が不完全だったときと、追跡されているsymlinkが書き換えられたときだけ、失敗した検査として結果に足す。
 * `sandbox`が無いと、コマンドはworkerのuidのまま動く。本番の呼び出し(`implement_verify`、`pr_fix_verify`)は必ず渡す。
 * miseの設定の信頼(trust)は決して与えない(`MISE_TRUSTED_CONFIG_PATHS`も
 * `mise --yes trust`も使わない)。信頼が無いと動かない検査コマンド
 * (信頼されていない対象リポジトリの`mise.toml`に対する`mise run check`など)は、
 * 他の0以外の終了と同じく失敗し、呼び出し側は通常の検査の失敗として扱う
 * (Claudeの再試行を1回してから`blocked`)。
 * これで、コマンドを解析して「`mise.toml`に依存するか」を推測する事前確認をしなくても、
 * 「信頼が要るものは実行しない」という同じ結果になる。
 * コマンドはシェルを使わず、空白で区切ってargvにする。
 * `allowed_check_commands`は対象リポジトリの内容ではなく、
 * 運用者が書く設定(`factory_config`)だから。
 * 出力の読み取りを打ち切ったコマンド(`outputAbandoned`)は、終了コードに関わらず失敗にする。
 * 別セッションへ抜けたプロセスがworkerに残ったことを検査結果に出すためである。
 */
export async function runAllowedCheckCommands(
  run: CommandRunner,
  cwd: string,
  commands: readonly string[],
  timeoutMs: number,
  createHomeDir: CreateCheckHomeDir = defaultCreateCheckHomeDir,
  path: string = CHECK_COMMAND_PATH,
  sandbox: CheckSandbox | null = null,
): Promise<CheckCommandResult[]> {
  const homeDir = await createHomeDir({ worktreeDir: cwd });
  const dirs = { worktreeDir: cwd, homeDir: homeDir.path };
  const results: CheckCommandResult[] = [];
  let released = true;
  try {
    try {
      if (sandbox !== null) await sandbox.prepare(dirs);
      const env = checkEnv({ path, home: homeDir.path, worktreeDir: cwd });

      for (const command of commands) {
        const argv = command
          .trim()
          .split(/\s+/)
          .filter((token) => token.length > 0);
        if (argv.length === 0) continue;
        const result = await run(sandbox === null ? argv : sandbox.wrap(argv), {
          cwd,
          env,
          timeoutMs,
          maxOutputBytes: CHECK_COMMAND_MAX_OUTPUT_BYTES,
        });
        if (sandbox !== null) await sandbox.settle();
        const masked = maskSecrets(`${result.stdout}\n${result.stderr}`.trim());
        results.push({
          command,
          ok:
            !result.timedOut &&
            result.exitCode === 0 &&
            result.outputAbandoned !== true,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          outputTail: masked.slice(-CHECK_OUTPUT_TAIL_CHARS),
          output: masked,
        });
      }
    } finally {
      if (sandbox !== null) {
        released = false;
        await sandbox.release(dirs);
        released = true;
      }
    }
    // 取り戻しの後に調べる。片付けの中で失敗させると、取り戻しの記録が残って次の実行を止めるためである。
    if (sandbox !== null) {
      const report = await sandbox.escapingSymlinks(dirs);
      if (report.problems.length > 0) {
        results.push(escapingSymlinksResult(report));
      }
    }
    return results;
  } finally {
    if (released) await homeDir.cleanup();
  }
}
