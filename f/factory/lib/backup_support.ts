// 夜間のバックアップ(`f/factory/backup`)の判断の部分。
// 世代の名前と消す世代の選別、`factory_config`の参照の伏せ字、接続URLの解釈、
// `pg_dumpall`と`tar`の引数と環境変数、manifestと通知の本文を決める。
// 入出力を持たないので、偽物なしでテストできる。

import { isRecord } from "./types.ts";

/**
 * 控えを置くディレクトリ。名前付きvolume`factory_backups`のマウント先で、defaultのworkerだけが持つ。
 * `infra/worker/Dockerfile`がrootの0700で作り、`scripts/backup-export.sh`も同じパスを読む。
 */
export const BACKUP_ROOT = "/var/lib/factory-backups";

/** 控える`factory_state`のvolumeのマウント先。 */
export const FACTORY_STATE_DIR = "/var/lib/factory";

/**
 * 書きかけの世代のディレクトリ名の接頭辞。
 * 全部を書き終えてから世代の名前に改名するので、途中で止まった世代はこの名前のまま残り、次の実行が消す。
 */
export const PARTIAL_PREFIX = ".partial-";

/** 世代のディレクトリに置くファイルの名前。 */
export const BACKUP_FILES = {
  clusterSql: "cluster.sql",
  stateTar: "factory_state.tar",
  config: "factory_config.json",
  manifest: "manifest.json",
} as const;

/**
 * `factory_state`のうち控えないディレクトリ。
 * `claude/`と`gh/`は、人がworkerの中で手で使うときのログインの記録で、控えに秘密を増やさないため除く。
 * `check-slots/`は検査の枠のロックと記録で、戻すと存在しない実行の記録が残るため除く。
 */
export const STATE_TAR_EXCLUDES: readonly string[] = [
  "./claude",
  "./gh",
  "./check-slots",
];

/** `factory_config`の参照を置き換える文字列。 */
export const REDACTED = "<redacted>";

/**
 * workerのイメージが入れる、サーバー(`postgres:18`)と同じメジャー版の`pg_dumpall`。
 * PATHの`pg_dumpall`はDebianの切り替えの仕組みが版を選ぶので、絶対パスで版を固定する。
 */
export const PG_DUMPALL_BIN = "/usr/lib/postgresql/18/bin/pg_dumpall";

/** 失敗を知らせるときに名指しする段階。`docs/operations.md`の「バックアップ」の表と同じ名前にする。 */
export type BackupStage =
  | "prepare"
  | "pg_dumpall"
  | "tar"
  | "config"
  | "manifest"
  | "finalize"
  | "prune";

/** `pg_dumpall`の接続先。値は環境変数で渡し、引数には載せない。 */
export type PgConnection = {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
};

/** 世代ごとの`manifest.json`の中身。 */
export type BackupManifest = {
  readonly generation: string;
  readonly created_at: string;
  readonly deployed_sha: string | null;
  readonly files: Readonly<Record<string, number>>;
};

/** 失敗した外部コマンドの結果のうち、原因の説明に使う部分。 */
export type CommandFailure = {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stderr: string;
};

const GENERATION_NAME = /^\d{8}T\d{6}Z$/;
/** 参照を探す入れ子の深さの上限。超える値は中を見切れないので、丸ごと置き換える。 */
const REDACT_DEPTH_MAX = 32;
/** 通知の本文に載せる原因の文字数の上限。末尾を残す。コマンドのエラーは最後の行に原因が出るため。 */
const FAILURE_DETAIL_MAX_CHARS = 500;
/** libpqの接続のタイムアウト(秒)。DBが応答しないとき、コマンドの30分を待たずに失敗させる。 */
const PG_CONNECT_TIMEOUT_SEC = "30";

/** `now`(UTC)から、世代のディレクトリ名`YYYYMMDDTHHMMSSZ`を作る。 */
export function generationName(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** 完成した世代のディレクトリ名か。書きかけの`.partial-`と、ほかの名前は含まない。 */
export function isGenerationName(name: string): boolean {
  return GENERATION_NAME.test(name);
}

/** 書きかけの世代のディレクトリ名。 */
export function partialName(generation: string): string {
  return `${PARTIAL_PREFIX}${generation}`;
}

/** 前の実行が途中で止まって残した、書きかけの世代の名前を返す。 */
export function selectStalePartials(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith(PARTIAL_PREFIX));
}

/**
 * 完成した世代のうち、新しい方から`keep`個を残した残りを、古い順に返す。ほかの名前は返さない。
 * 名前は桁の決まったUTCの時刻なので、文字列の順が時刻の順になる。
 */
export function selectGenerationsToDelete(
  names: readonly string[],
  keep: number,
): string[] {
  const generations = names.filter(isGenerationName).sort();
  return generations.slice(0, Math.max(0, generations.length - keep));
}

function isReference(value: string): boolean {
  return value.startsWith("$var:") || value.startsWith("$res:");
}

/**
 * 補間していない`factory_config`の値から、変数(`$var:`)とresource(`$res:`)への参照を`REDACTED`に置き換えた複製を返す。
 * Windmillが補間するのは、この2つで始まる文字列だけである。
 * 控えから戻した設定が、戻し先の秘密を黙って読みに行かないよう、参照のあった箇所だけを印で残す。
 */
export function redactReferences(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return isReference(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return depth >= REDACT_DEPTH_MAX
      ? REDACTED
      : value.map((item) => redactReferences(item, depth + 1));
  }
  if (isRecord(value)) {
    return depth >= REDACT_DEPTH_MAX
      ? REDACTED
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            redactReferences(item, depth + 1),
          ]),
        );
  }
  return value;
}

/**
 * `postgres://<user>:<password>@<host>[:<port>]/<database>`の形のURLを読む。
 * userinfoとデータベース名の百分率符号化を戻す。形に合わないときと、符号化が壊れているときは`null`を返す。
 */
export function parsePgConnection(url: string): PgConnection | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return null;
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (
    parsed.hostname === "" ||
    parsed.username === "" ||
    database === "" ||
    database.includes("/")
  ) {
    return null;
  }
  try {
    return {
      host: parsed.hostname,
      port: parsed.port === "" ? "5432" : parsed.port,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(database),
    };
  } catch {
    return null;
  }
}

/**
 * 外部コマンドに渡す環境変数。workerの`CommandRunner`は環境変数を引き継がないので、PATHを明示して渡す。
 */
export function commandEnv(path: string | undefined): Record<string, string> {
  return path === undefined ? {} : { PATH: path };
}

/** `pg_dumpall`の引数。接続先は環境変数で渡すので、引数に秘密は載らない。 */
export function pgDumpallArgv(outputFile: string): string[] {
  return [PG_DUMPALL_BIN, "--no-password", `--file=${outputFile}`];
}

/**
 * `pg_dumpall`の環境変数。接続先をlibpqの環境変数で渡す。
 * 引数に載せると、`/proc/<pid>/cmdline`から検査用のユーザーにも読めるためである。
 */
export function pgDumpallEnv(
  connection: PgConnection,
  path: string | undefined,
): Record<string, string> {
  return {
    ...commandEnv(path),
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGCONNECT_TIMEOUT: PG_CONNECT_TIMEOUT_SEC,
  };
}

/** `factory_state`を控える`tar`の引数。除外は`STATE_TAR_EXCLUDES`。 */
export function stateTarArgv(outputFile: string): string[] {
  return [
    "tar",
    "-C",
    FACTORY_STATE_DIR,
    "-cf",
    outputFile,
    ...STATE_TAR_EXCLUDES.map((dir) => `--exclude=${dir}`),
    ".",
  ];
}

/** 世代の`manifest.json`の中身を作る。 */
export function buildManifest(input: {
  readonly generation: string;
  readonly createdAt: Date;
  readonly deployedSha: string | null;
  readonly files: Readonly<Record<string, number>>;
}): BackupManifest {
  return {
    generation: input.generation,
    created_at: input.createdAt.toISOString(),
    deployed_sha: input.deployedSha,
    files: input.files,
  };
}

/** 失敗した外部コマンドの原因を、例外のメッセージにする1行の英語で返す。 */
export function describeCommandFailure(result: CommandFailure): string {
  const reason = result.timedOut
    ? "timed out"
    : `exited with ${String(result.exitCode)}`;
  const stderr = result.stderr.trim();
  return stderr === "" ? reason : `${reason}: ${stderr}`;
}

/**
 * `backup_failed`の通知の本文。段階と、原因の末尾を載せる。
 * 時刻は載せない。同じ原因が続く間、未解決の通知を1件にまとめるためである。
 * `detail`は、呼び出し側が秘密値を伏せてから渡す。
 */
export function backupFailureMessage(
  stage: BackupStage,
  detail: string,
): string {
  const trimmed = detail.trim();
  const tail =
    trimmed.length > FAILURE_DETAIL_MAX_CHARS
      ? trimmed.slice(-FAILURE_DETAIL_MAX_CHARS)
      : trimmed;
  const head = `夜間のバックアップが失敗しました。段階: ${stage}。`;
  return tail === "" ? head : `${head}原因: ${tail}`;
}
