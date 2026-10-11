// `allowed_check_commands`の実行。
// 対象リポジトリの検査コマンドを、検査用の非特権uidに落として(`check_sandbox.ts`)、
// 許可リストの環境変数だけで実行する。
// 呼び出し側(`implement_verify`、`pr_fix_verify`)は、実行するコマンドのランナーを注入する。

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckSandbox, checkEnv, checkTmpDir } from "./check_sandbox.ts";
import { maskSecrets } from "./log.ts";
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

export const CHECK_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 検査コマンドに渡す`PATH`。workerのPATHは引き継がず、この固定値を使う。
 * workerのPATHに、rootのホームや書き込める一時ディレクトリが入っていても、
 * そこに置かれた実行ファイルを検査コマンドが名前の解決で拾わないようにするため。
 * workerのイメージでは、bun・node・git・wmillが`/usr/bin`に、ghとgitleaksが`/usr/local/bin`に、
 * goが`/usr/local/go/bin`にある。どれもrootが所有する。
 * 値の説明は`docs/security.md`の「検査コマンドはフローが実行する」にある。
 */
export const CHECK_COMMAND_PATH =
  "/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin";

export type CheckHomeDir = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type CreateCheckHomeDir = () => Promise<CheckHomeDir>;

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
 */
const defaultCreateCheckHomeDir: CreateCheckHomeDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-check-home-"));
  await mkdir(checkTmpDir(dir), { mode: 0o700 });
  return {
    path: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/**
 * `allowed_check_commands`の各項目を、`cwd`で順に実行する。
 * 環境変数は許可リスト(`checkEnv`。固定のPATH(`CHECK_COMMAND_PATH`)、新しい非公開のHOMEとその下のTMPDIR、ロケール、
 * worktreeだけを信頼するgitの設定)で作り、workerの秘密は引き継がない。
 * 終わったらHOMEのディレクトリを消す。`docs/internals/pr-workflow.md`の「検査コマンドの実行」に書く。
 * `sandbox`があれば、コマンドを検査用の非特権uidに落として実行する(`setpriv`)。
 * 実行の前にworktreeとHOMEをそのuidに渡し、コマンドごとに残ったプロセスを止め、
 * 実行の後(失敗しても)所有権をrootに戻してからHOMEを消す。
 * 戻すのに失敗したときはHOMEを消さない。止まらないプロセスが書き換えている木をrootでたどらないためで、
 * HOMEは枠の記録に残り、次にその枠を取る実行が片付ける。
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
  const homeDir = await createHomeDir();
  const dirs = { worktreeDir: cwd, homeDir: homeDir.path };
  let released = true;
  try {
    try {
      if (sandbox !== null) await sandbox.prepare(dirs);
      const env = checkEnv({ path, home: homeDir.path, worktreeDir: cwd });

      const results: CheckCommandResult[] = [];
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
      return results;
    } finally {
      if (sandbox !== null) {
        released = false;
        await sandbox.release(dirs);
        released = true;
      }
    }
  } finally {
    if (released) await homeDir.cleanup();
  }
}
