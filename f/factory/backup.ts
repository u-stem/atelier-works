// 毎日02:30(JST)に、Postgresのクラスタ全体、`factory_state`のvolume、`factory_config`を控えるscript。
// 判断は`./lib/backup_support.ts`にあり、このファイルは入出力をつなぐだけ。
// defaultのworkerで動かす。`factory_state`と`factory_backups`のvolumeを持つのがdefaultのworkerだけのため。
// defaultのworkerはジョブを1つずつ動かすので、手動の実行とscheduleの実行が同じ置き場を同時に書くことはない。
// 失敗したら`backup_failed`の通知を残し、例外を投げてジョブを失敗にする。
// ジョブの失敗は`detect_schedule_failures`がDiscordに知らせる。成功は知らせない。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { chmod, rename, stat } from "node:fs/promises";
import {
  BACKUP_FILES,
  BACKUP_ROOT,
  type BackupStage,
  backupFailureMessage,
  buildManifest,
  commandEnv,
  describeCommandFailure,
  failureDetailTail,
  generationName,
  keepGenerationsOf,
  parsePgConnection,
  partialName,
  pgDumpallArgv,
  pgDumpallEnv,
  redactReferences,
  selectGenerationsToDelete,
  selectStalePartials,
  stateTarArgv,
} from "./lib/backup_support.ts";
import { addNoticeUnlessUnresolved } from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";
import {
  type CommandResult,
  type CommandRunner,
  makeDir,
  readDirEntries,
  removePath,
  runCommand,
  writeTextFile,
} from "./lib/workspace.ts";

const DB_BACKUP_URL_PATH = "f/factory/db_backup_url";
const DEPLOYED_SHA_PATH = "f/factory/deployed_sha";
const CONFIG_PATH = "f/factory/factory_config";

/** `pg_dumpall`と`tar`の1回の上限。 */
export const BACKUP_COMMAND_TIMEOUT_MS = 30 * 60_000;
/** 外部コマンドの出力を保持する上限。控えはファイルに書くので、出力は失敗の理由だけである。 */
const COMMAND_OUTPUT_MAX_BYTES = 64 * 1024;
/**
 * GNUの`tar`が、読んでいる間にファイルが変わったか消えたときに返す終了コード。
 * アーカイブは書けているので失敗にせず、警告をログに残す。2以上は失敗にする。
 */
const TAR_WARNING_EXIT_CODE = 1;
/** 置き場と世代のディレクトリのモード。控えはDBの全体を含むので、検査用のユーザーに読ませない。 */
const PRIVATE_DIR_MODE = 0o700;

/** 配線が使う入出力。テストでは偽物に差し替える。 */
export type BackupIo = {
  readonly now: () => Date;
  /** 外部コマンドに渡すPATH。 */
  readonly path: string | undefined;
  readonly run: CommandRunner;
  readonly listDir: (path: string) => Promise<string[]>;
  readonly makeDir: (path: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly writeTextFile: (path: string, content: string) => Promise<void>;
  readonly fileSize: (path: string) => Promise<number>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly removePath: (path: string) => Promise<void>;
  readonly getVariable: (path: string) => Promise<string>;
  /** 補間しない`factory_config`の値。控えに書き、残す世代の数もここから読む。 */
  readonly getRawConfig: () => Promise<unknown>;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

export type BackupResult = {
  readonly generation: string;
  /** 控えたファイルの名前とバイト数。 */
  readonly files: Readonly<Record<string, number>>;
  /** 数を超えて消した世代。 */
  readonly deleted: readonly string[];
};

/** バックアップが失敗した。`stage`は失敗した段階で、メッセージは秘密値を伏せてある。 */
export class BackupError extends Error {
  readonly stage: BackupStage;
  constructor(stage: BackupStage, detail: string) {
    super(`backup failed at ${stage}: ${detail}`);
    this.name = "BackupError";
    this.stage = stage;
  }
}

/**
 * 1つの世代を書き、数を超えた古い世代を消す。
 * 書きかけの世代は`.partial-<時刻>`に置き、全部を書き終えてから`<時刻>`に改名する。
 * 失敗したら書きかけを消し、原因をログに残し、段階だけを載せた`backup_failed`の通知を残して`BackupError`を投げる。
 */
export async function runBackup(io: BackupIo): Promise<BackupResult> {
  const startedAt = io.now();
  const generation = generationName(startedAt);
  const partialDir = `${BACKUP_ROOT}/${partialName(generation)}`;
  const secrets: string[] = [];
  let stage: BackupStage = "prepare";
  try {
    await io.makeDir(BACKUP_ROOT);
    // 既にあるvolumeには、イメージのディレクトリのモードが写らないので、毎回直す。
    await io.chmod(BACKUP_ROOT, PRIVATE_DIR_MODE);
    for (const stale of selectStalePartials(await io.listDir(BACKUP_ROOT))) {
      await io.removePath(`${BACKUP_ROOT}/${stale}`);
    }
    await io.makeDir(partialDir);
    await io.chmod(partialDir, PRIVATE_DIR_MODE);
    const connection = parsePgConnection(
      await io.getVariable(DB_BACKUP_URL_PATH),
    );
    if (connection === null) {
      throw new Error(`${DB_BACKUP_URL_PATH} is not a postgres URL`);
    }
    secrets.push(connection.password);

    stage = "pg_dumpall";
    await runChecked(
      io,
      pgDumpallArgv(`${partialDir}/${BACKUP_FILES.clusterSql}`),
      pgDumpallEnv(connection, io.path),
    );

    stage = "tar";
    const tar = await runChecked(
      io,
      stateTarArgv(`${partialDir}/${BACKUP_FILES.stateTar}`),
      commandEnv(io.path),
      [TAR_WARNING_EXIT_CODE],
    );
    if (tar.exitCode === TAR_WARNING_EXIT_CODE) {
      io.log.warn("backup: tar saw files change while it read them", {
        stderr: failureDetailTail(maskSecrets(tar.stderr, secrets)),
      });
    }

    stage = "config";
    const rawConfig = await io.getRawConfig();
    const config = redactReferences(rawConfig);
    await io.writeTextFile(
      `${partialDir}/${BACKUP_FILES.config}`,
      `${JSON.stringify(config, null, 2)}\n`,
    );

    stage = "manifest";
    const files: Record<string, number> = {};
    for (const name of [
      BACKUP_FILES.clusterSql,
      BACKUP_FILES.stateTar,
      BACKUP_FILES.config,
    ]) {
      files[name] = await io.fileSize(`${partialDir}/${name}`);
    }
    const manifest = buildManifest({
      generation,
      createdAt: startedAt,
      deployedSha: await readDeployedSha(io),
      files,
    });
    await io.writeTextFile(
      `${partialDir}/${BACKUP_FILES.manifest}`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    stage = "finalize";
    await io.rename(partialDir, `${BACKUP_ROOT}/${generation}`);

    stage = "prune";
    // `config`の段階で読んだ値から、`backup_keep_generations`だけを検証して使う。
    // 控えを書き終えた後に、関係のない項目の誤りでジョブを失敗にしないため。
    const keep = keepGenerationsOf(rawConfig);
    const deleted = selectGenerationsToDelete(
      await io.listDir(BACKUP_ROOT),
      keep,
    );
    for (const name of deleted) {
      await io.removePath(`${BACKUP_ROOT}/${name}`);
    }
    io.log.info("backup: wrote a generation", { generation, files, deleted });
    return { generation, files, deleted };
  } catch (err) {
    const detail = maskSecrets(
      err instanceof Error ? err.message : String(err),
      secrets,
    );
    await reportFailure(io, stage, partialDir, detail);
    throw new BackupError(stage, detail);
  }
}

/**
 * コマンドを実行して結果を返す。
 * タイムアウトしたときと、0と`tolerated`以外の終了コードで終わったときは例外を投げる。
 */
async function runChecked(
  io: BackupIo,
  argv: readonly string[],
  env: Record<string, string>,
  tolerated: readonly number[] = [],
): Promise<CommandResult> {
  const result = await io.run(argv, {
    env,
    timeoutMs: BACKUP_COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_MAX_BYTES,
  });
  if (
    result.timedOut ||
    (result.exitCode !== 0 && !tolerated.includes(result.exitCode))
  ) {
    throw new Error(describeCommandFailure(result));
  }
  return result;
}

/** 反映済みの版を読む。読めないときと空のときは`null`にし、控えは止めない。 */
async function readDeployedSha(io: BackupIo): Promise<string | null> {
  try {
    const value = await io.getVariable(DEPLOYED_SHA_PATH);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * 書きかけを消し、`backup_failed`の通知を残す。
 * どちらの失敗も握りつぶしてログに残す。呼び出し元が元の失敗でジョブを失敗にするためである。
 */
async function reportFailure(
  io: BackupIo,
  stage: BackupStage,
  partialDir: string,
  detail: string,
): Promise<void> {
  io.log.error("backup: failed", { stage, error: failureDetailTail(detail) });
  try {
    await io.removePath(partialDir);
  } catch (err) {
    io.log.warn("backup: could not remove the partial generation", {
      path: partialDir,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
  try {
    await io.addNotice({
      kind: "backup_failed",
      message: backupFailureMessage(stage),
    });
  } catch (err) {
    io.log.error("backup: could not record the backup_failed notice", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

export async function main(): Promise<BackupResult> {
  const workspace = wmillDefault.getWorkspace();
  return await runBackup({
    now: () => new Date(),
    path: process.env.PATH,
    run: runCommand,
    listDir: readDirEntries,
    makeDir,
    chmod: (path, mode) => chmod(path, mode),
    writeTextFile,
    fileSize: async (path) => (await stat(path)).size,
    rename: (from, to) => rename(from, to),
    removePath,
    getVariable: (path) => wmill.getVariable(path),
    // 補間する`getResource`は`$var:`を秘密の値に解決するので、補間しない読み取りを使う。
    getRawConfig: () =>
      wmill.ResourceService.getResourceValue({ workspace, path: CONFIG_PATH }),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    log: logger("backup"),
  });
}
