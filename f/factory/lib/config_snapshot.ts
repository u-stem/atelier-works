// 設定(`factory_config`)のresourceを定期に読み、Consoleの外の経路(`wmill resource push`、Windmillの画面、ホストのCLI)で
// 変わった項目を、`factory.config_history`へ`out_of_band`として書く照合の部品。
// Consoleの経路は、変更の成功の後に、射影した値を自分で書く。照合は、resourceの今の値の射影を、項目ごとの履歴の最後の`after`と比べる。
// 射影が同じなら何も書かないので、Consoleの経路の変更は二重にならない。
//
// 値は、`lib/config_history.ts`の許可リストで射影してから扱う。コマンド、URL、身元に関わる項目の生の値は、
// 読んだ後すぐに射影に変え、ログにも履歴にも出さない。
// 参照(`$var:`、`$res:`)を含む項目は、参照の先を解決せず、値を見ずに`{ redacted: true }`にする。
// resourceへは書かない。履歴を書けなくても、投げずに数える。
//
// 保護パスの中の`lib/config_history.ts`と`lib/console_redact.ts`だけに頼る。入出力は呼び出し側が渡す。

import {
  type ConfigHistoryAppendResult,
  type ConfigProjection,
  type ConfigProjectionInput,
  isConfigItemKey,
  isMissingConfigHistoryObjectError,
  projectConfigValue,
} from "./config_history.ts";
import type { ActionSqlClient } from "./console_actions.ts";
import { holdsReference, isRecord } from "./console_redact.ts";

/** 照合が履歴に書くときの`actor`。人ではなく、照合のscriptである。 */
export const SNAPSHOT_ACTOR = "config_snapshot";

/** 1回の実行で書く行の上限。超えた分は、次の実行で書く。 */
export const SNAPSHOT_ROW_CAP = 100;

const REDACTED: ConfigProjection = { redacted: true };
const UNKNOWN: ConfigProjection = { kind: "unknown" };

/** 項目が設定から無くなったことを示す射影。値が`null`の項目(`null`の射影)とは区別する。 */
export const REMOVED_PROJECTION: ConfigProjection = { removed: true };

// ---------------------------------------------------------------------------
// 射影
// ---------------------------------------------------------------------------

/** resource全体の射影。 */
export type ConfigSnapshotProjection = {
  /** 項目名から射影への対応。履歴に書ける名前の項目だけを持つ。 */
  readonly items: ReadonlyMap<string, ConfigProjection>;
  /** 値が参照を含み、見ずに伏せた項目の数。 */
  readonly reference_keys: number;
  /** 履歴の項目名の形に合わず、飛ばした項目の数。 */
  readonly unnamed_keys: number;
};

/**
 * resourceの生の値の、すべての最上位の項目を射影する。
 * 項目の種類は`projectConfigValue`の許可リストで決め、表に無い項目は、値を入れずに`{ kind: "unknown" }`にする。
 * 値が参照を含む項目は、値を調べずに`{ redacted: true }`にする。
 * resourceがオブジェクトでなければ`null`を返す。
 */
export function projectConfigSnapshot(
  raw: unknown,
): ConfigSnapshotProjection | null {
  if (!isRecord(raw)) return null;
  const items = new Map<string, ConfigProjection>();
  let referenceKeys = 0;
  let unnamedKeys = 0;
  for (const key of Object.keys(raw).sort()) {
    if (!isConfigItemKey(key)) {
      unnamedKeys += 1;
      continue;
    }
    const value = raw[key];
    if (holdsReference(value)) {
      referenceKeys += 1;
      items.set(key, REDACTED);
      continue;
    }
    items.set(key, projectConfigValue(key, value));
  }
  return { items, reference_keys: referenceKeys, unnamed_keys: unnamedKeys };
}

// ---------------------------------------------------------------------------
// 比較
// ---------------------------------------------------------------------------

/**
 * 履歴の`after`(jsonbを読んだ値)を、射影として読む。形が射影に合わないときは`undefined`を返す。
 * 履歴の値は信頼しすぎず、形を確かめてから使う。
 */
export function parseStoredProjection(
  value: unknown,
): ConfigProjection | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.count === "number" && Number.isFinite(value.count)) {
    return { count: value.count };
  }
  if (typeof value.hash === "string") {
    return value.changed === true || value.changed === false
      ? { hash: value.hash, changed: value.changed }
      : { hash: value.hash };
  }
  if (value.redacted === true) return REDACTED;
  if (value.removed === true) return REMOVED_PROJECTION;
  if (value.kind === "unknown") return UNKNOWN;
  return undefined;
}

/**
 * 比べるための形にする。ハッシュの項目の`changed`は、変更の経路が前後の比較で付ける印なので、比べるときは外す。
 * 外さないと、Consoleが書いた行(`changed`が付く)と、今の値の射影(付かない)が、いつも違って見える。
 */
function comparable(projection: ConfigProjection): string {
  if (
    projection !== null &&
    typeof projection === "object" &&
    "hash" in projection
  ) {
    return JSON.stringify({ hash: projection.hash });
  }
  return JSON.stringify(projection);
}

/** 履歴に書く`before`にする。`changed`は、変更後の側だけに付く印なので外す。 */
function withoutChangedMark(projection: ConfigProjection): ConfigProjection {
  if (
    projection !== null &&
    typeof projection === "object" &&
    "hash" in projection
  ) {
    return { hash: projection.hash };
  }
  return projection;
}

/**
 * 照合が見つけた、履歴に書く変更1つ。
 * - baseline: 履歴にまだ無い項目の最初の値。`before`は`null`である。
 * - changed: 履歴の最後の`after`と、今の射影が違う。`before`は履歴の最後の`after`である。
 * - removed: 履歴にある項目が、今は無い。`after`は`{ removed: true }`である。
 */
export type SnapshotChange = {
  readonly key: string;
  readonly kind: "baseline" | "changed" | "removed";
  readonly before: ConfigProjection;
  readonly after: ConfigProjection;
};

/**
 * 項目ごとの履歴の最後の`after`(`latest`)と、今の射影(`current`)の差を、項目名の昇順で返す。
 * 履歴の最後の`after`が`{ removed: true }`で、項目がまだ無いときは、差とは見なさない。
 * 履歴の値が射影として読めないときは、`{ kind: "unknown" }`として比べる。
 */
export function diffSnapshot(
  latest: ReadonlyMap<string, unknown>,
  current: ReadonlyMap<string, ConfigProjection>,
): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  const keys = [...new Set([...latest.keys(), ...current.keys()])].sort();
  for (const key of keys) {
    const now = current.get(key);
    if (!latest.has(key)) {
      if (now !== undefined) {
        changes.push({ key, kind: "baseline", before: null, after: now });
      }
      continue;
    }
    // `null`は値が`null`の項目の射影なので、`??`で未知に置き換えない。
    const stored = parseStoredProjection(latest.get(key));
    const last = stored === undefined ? UNKNOWN : stored;
    if (now === undefined) {
      if (comparable(last) !== comparable(REMOVED_PROJECTION)) {
        changes.push({
          key,
          kind: "removed",
          before: withoutChangedMark(last),
          after: REMOVED_PROJECTION,
        });
      }
      continue;
    }
    if (comparable(last) !== comparable(now)) {
      changes.push({
        key,
        kind: "changed",
        before: withoutChangedMark(last),
        after: now,
      });
    }
  }
  return changes;
}

const REASON_OF_KIND = {
  baseline: "snapshot_baseline",
  changed: "out_of_band_change",
  removed: "out_of_band_removed",
} as const;

/** 変更を、履歴に書く入力にする。`source`は`out_of_band`、`actor`は`SNAPSHOT_ACTOR`である。 */
export function toAppendInput(change: SnapshotChange): ConfigProjectionInput {
  return {
    key: change.key,
    before: change.before,
    after: change.after,
    actor: SNAPSHOT_ACTOR,
    source: "out_of_band",
    reason: REASON_OF_KIND[change.kind],
  };
}

// ---------------------------------------------------------------------------
// 履歴の読み取り
// ---------------------------------------------------------------------------

/**
 * 項目ごとの、履歴の最後の`after`を読む。SQLの`NULL`は`null`として返す。
 * 表が無いときなどのエラーは、そのまま投げる。
 */
export async function loadLatestProjections(
  sql: ActionSqlClient,
): Promise<Map<string, unknown>> {
  const rows = await sql`
    SELECT DISTINCT ON (c.item_key) c.item_key, coalesce(c.after::text, 'null') AS after_json
    FROM factory.config_history c
    ORDER BY c.item_key, c.seq DESC
  `.fetch();
  const latest = new Map<string, unknown>();
  for (const row of rows) {
    if (typeof row.item_key !== "string") {
      throw new Error(
        "config_snapshot: a history row has a shape it cannot read",
      );
    }
    latest.set(row.item_key, readJson(row.after_json));
  }
  return latest;
}

/** JSONの文字列を読む。読めなければ、射影として読めない値(`undefined`)を返す。 */
function readJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * 照合の結果。件数だけを持ち、項目名も値も入れない。
 * `skipped_reason`が`null`でないときは、照合を終えられなかったので、ほかの件数は0である。
 * - resource_unreadable: resourceを読めなかった(時間切れを含む)。
 * - resource_not_object: resourceがオブジェクトでなかった。
 * - history_missing: 履歴の表か関数が無い(migrationが未反映)。
 * - history_unreadable: 履歴の最後の値を読めなかった。
 */
export type SnapshotResult = {
  /** 射影した項目の数。 */
  readonly keys_checked: number;
  /** 基準として書いた行の数。 */
  readonly baseline: number;
  /** 値の変更として書いた行の数。 */
  readonly changed: number;
  /** 項目が無くなったとして書いた行の数。 */
  readonly removed: number;
  /** 書けなかった行の数。 */
  readonly failed: number;
  /** 上限を超え、次の実行に回した差の数。 */
  readonly deferred: number;
  /** 参照を含み、値を見ずに伏せた項目の数。 */
  readonly reference_keys: number;
  /** 履歴の項目名の形に合わず、飛ばした項目の数。 */
  readonly unnamed_keys: number;
  readonly skipped_reason:
    | null
    | "resource_unreadable"
    | "resource_not_object"
    | "history_missing"
    | "history_unreadable";
};

export type SnapshotLog = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
};

export type SnapshotPorts = {
  /** 補間しない生の値を返す。時間の区切りは、呼び出し側が付ける。 */
  readonly readRawConfig: () => Promise<unknown>;
  readonly loadLatest: () => Promise<Map<string, unknown>>;
  /** 履歴に1行足す。失敗しても投げず、結果で返す。 */
  readonly append: (
    input: ConfigProjectionInput,
  ) => Promise<ConfigHistoryAppendResult>;
  readonly log: SnapshotLog;
  /** 1回に書く行の上限。省くと`SNAPSHOT_ROW_CAP`。 */
  readonly cap?: number;
};

const EMPTY_COUNTS = {
  keys_checked: 0,
  baseline: 0,
  changed: 0,
  removed: 0,
  failed: 0,
  deferred: 0,
  reference_keys: 0,
  unnamed_keys: 0,
} as const;

function skipped(
  reason: NonNullable<SnapshotResult["skipped_reason"]>,
): SnapshotResult {
  return { ...EMPTY_COUNTS, skipped_reason: reason };
}

/** 注入された書き込みが投げても、失敗の結果にして返す。例外の文には値が入りうるので、捨てる。 */
async function appendWithoutThrowing(
  ports: SnapshotPorts,
  change: SnapshotChange,
): Promise<ConfigHistoryAppendResult> {
  try {
    return await ports.append(toAppendInput(change));
  } catch {
    return {
      recorded: false,
      kind: "write_failed",
      reason: "the append threw",
    };
  }
}

/**
 * resourceを読み、履歴との差を`out_of_band`として書く。投げない。
 * 差は項目名の昇順に、上限(`cap`)まで書く。残りは次の実行に回す。書かなければ差は残るので、2回続けて実行しても、2回目は何も書かない。
 * 1行の書き込みが失敗しても、残りを続ける。失敗した項目は、次の実行でもう一度差として見つかる。
 * ログには、件数と失敗の種類だけを出し、項目名と値は出さない。
 */
export async function runConfigSnapshot(
  ports: SnapshotPorts,
): Promise<SnapshotResult> {
  const cap = ports.cap ?? SNAPSHOT_ROW_CAP;
  let raw: unknown;
  try {
    raw = await ports.readRawConfig();
  } catch {
    ports.log.warn("config_snapshot: could not read the config resource");
    return skipped("resource_unreadable");
  }
  const projection = projectConfigSnapshot(raw);
  if (projection === null) {
    ports.log.warn("config_snapshot: the config resource is not an object");
    return skipped("resource_not_object");
  }

  let latest: Map<string, unknown>;
  try {
    latest = await ports.loadLatest();
  } catch (err) {
    if (isMissingConfigHistoryObjectError(err)) {
      ports.log.info("config_snapshot: the history table is not there yet");
      return skipped("history_missing");
    }
    ports.log.warn("config_snapshot: could not read the history");
    return skipped("history_unreadable");
  }

  const changes = diffSnapshot(latest, projection.items);
  const toWrite = changes.slice(0, cap);
  const deferred = changes.length - toWrite.length;
  if (deferred > 0) {
    ports.log.warn(
      "config_snapshot: more changes than the cap, the rest wait for the next run",
      {
        cap,
        deferred,
      },
    );
  }

  let baseline = 0;
  let changed = 0;
  let removed = 0;
  let failed = 0;
  for (const change of toWrite) {
    const result = await appendWithoutThrowing(ports, change);
    if (!result.recorded) {
      failed += 1;
      ports.log.warn("config_snapshot: could not write a row", {
        kind: result.kind,
      });
      continue;
    }
    if (change.kind === "baseline") baseline += 1;
    else if (change.kind === "changed") changed += 1;
    else removed += 1;
  }

  return {
    keys_checked: projection.items.size,
    baseline,
    changed,
    removed,
    failed,
    deferred,
    reference_keys: projection.reference_keys,
    unnamed_keys: projection.unnamed_keys,
    skipped_reason: null,
  };
}
