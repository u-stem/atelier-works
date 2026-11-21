// 設定(`factory_config`)のresourceを定期に読み、Consoleの外の経路(`wmill resource push`、Windmillの画面、ホストのCLI)で
// 変わった項目を、`factory.config_history`へ`out_of_band`として書く照合の部品。
// Consoleの経路は、変更の成功の後に、射影した値を自分で書く。照合は、resourceの今の値の射影を、項目ごとの履歴の最後の`after`と比べる。
// 射影が同じなら何も書かないので、Consoleの経路の変更は二重にならない。
//
// 値は、`lib/config_history.ts`の許可リストで射影してから扱う。コマンド、URL、身元に関わる項目の生の値は、
// 読んだ後すぐに射影に変え、ログにも履歴にも出さない。
// 参照(`$var:`、`$res:`)を含む項目は、参照の先を解決せず、値を見ずに`{ redacted: true, hash }`にする。
// ハッシュは生の値をメモリの中でハッシュにしたもので、伏せた値の後の変更を見えなくしないために、比べるだけに使う。
// resourceへは書かない。履歴を書けなくても、投げずに数える。
//
// 履歴にまだ無い項目の扱いは、基準の印の行(`SNAPSHOT_BASELINE_MARKER_KEY`)の有無で決める。
// 印が無い間(基準の段階)は、履歴にまだ無い項目を基準(`snapshot_baseline`)として書く。基準の行は上限に数えない。
// すべての基準の行を書き終えた最後に、印を1行書く。時間が尽きるなどで基準を書き終えない実行は、印を書かず、次の実行が続ける。
// 印が書かれた後に、履歴にまだ無い項目が現れたら、足された項目(`out_of_band_added`)として、変更に数える。
//
// resource全体がオブジェクトでない値(`"$res:<path>"`の文字列など)に変わると、補間して読むほかの読み取りは参照先のオブジェクトを読み続け、
// 補間しないこの照合だけが文字列を見る。項目を読めないまま何も書かないと、参照先の変更が履歴に残らなくなる。
// そのため、予約の項目`config_snapshot_resource`に、値のハッシュを1行書く。同じ値の間は書かない。オブジェクトに戻ったら、戻った印を1行書く。
// オブジェクトでない間は、項目を比べられないので、結果を`resource_not_object`にして、呼び出し側がジョブを失敗させる。
//
// 行は、知っている項目の変更、知らない項目の変更、基準の行の順に書く。上限は、基準の行を除いて数える。
// resource全体の行は、上限に数えず、ほかの行より先に書く。
// 知らない項目の数に上限を置き、超えた項目は調べずに次の実行へ回す。多数の項目を足して、狙った変更を後ろへ押しやる手を封じる。
//
// 保護パスの中の`lib/config_history.ts`と`lib/console_redact.ts`だけに頼る。入出力は呼び出し側が渡す。

import {
  type ConfigHistoryAppendResult,
  type ConfigProjection,
  type ConfigProjectionInput,
  isConfigItemKey,
  isKnownConfigKey,
  isMissingConfigHistoryObjectError,
  isPlainHashProjection,
  projectConfigValue,
  projectNonObjectResource,
  SNAPSHOT_BASELINE_MARKER_KEY,
} from "./config_history.ts";
import type { ActionSqlClient } from "./console_actions.ts";
import { holdsReference, isRecord } from "./console_redact.ts";

/** 照合が履歴に書くときの`actor`。人ではなく、照合のscriptである。 */
export const SNAPSHOT_ACTOR = "config_snapshot";

/** 1回の実行で書く行の上限。基準の行を除く。超えた分は、次の実行で書く。 */
export const SNAPSHOT_ROW_CAP = 100;

/** 知らない項目を調べる数の上限。名前の昇順に、この数まで調べる。超えた項目は、調べずに次の実行へ回す。 */
export const SNAPSHOT_UNKNOWN_KEYS_LIMIT = 50;

/**
 * 知らない項目の数が上限を超えたことを示す項目名。設定の項目ではない。
 * 上限を超える間、知らない項目の総数(`{ count }`)を、この名前の項目として、ほかの項目と同じ規則で比べて書く。
 */
export const UNKNOWN_KEYS_ITEM_KEY = "config_snapshot_unknown_keys";

/**
 * resource全体の状態を示す項目名。設定の項目ではない。
 * resourceがオブジェクトでない間は`{ redacted: true, hash }`(値のハッシュ)、オブジェクトに戻ったら`{ kind: "object" }`を、変更として書く。
 * 証跡パックの集計は、基準の印の行と違い、この項目の行を変更に数える。
 */
export const RESOURCE_ITEM_KEY = "config_snapshot_resource";

/** 設定の項目として読まない名前。履歴の中で、照合が自分の行に使う。 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  SNAPSHOT_BASELINE_MARKER_KEY,
  UNKNOWN_KEYS_ITEM_KEY,
  RESOURCE_ITEM_KEY,
]);

/**
 * 実行全体で、行を書き始めてよい時間(ミリ秒)。ジョブのtimeout(60秒)より短くする。
 * 超えたら、残りは書かずに`deferred`に数える。最後の1回の書き込み(1回の上限は15秒)が、この時間を過ぎる前に始まっても、
 * ジョブのtimeoutの前に終わるよう、差を残す。
 */
export const SNAPSHOT_DEADLINE_MS = 40_000;

const UNKNOWN: ConfigProjection = { kind: "unknown" };
const MARKER: ConfigProjection = { kind: "marker" };
const OBJECT_MARK: ConfigProjection = { kind: "object" };

/** 項目が設定から無くなったことを示す射影。値が`null`の項目(`null`の射影)とは区別する。 */
export const REMOVED_PROJECTION: ConfigProjection = { removed: true };

// ---------------------------------------------------------------------------
// 射影
// ---------------------------------------------------------------------------

/** resource全体の射影。 */
export type ConfigSnapshotProjection = {
  /** 項目名から射影への対応。履歴に書ける名前の項目だけを持つ。調べなかった項目は入らない。 */
  readonly items: ReadonlyMap<string, ConfigProjection>;
  /** 調べた項目のうち、値が参照を含み、伏せた項目の数。 */
  readonly reference_keys: number;
  /** 履歴の項目名の形に合わず、または照合の予約の名前で、飛ばした項目の数。 */
  readonly unnamed_keys: number;
  /** 知らない項目の総数。調べなかった項目も数える。 */
  readonly unknown_keys: number;
  /** 知らない項目が上限を超えて、調べなかった項目の名前。名前はログにも結果にも出さない。 */
  readonly excluded: ReadonlySet<string>;
};

/**
 * resourceの生の値の、すべての最上位の項目を射影する。
 * 項目の種類は`projectConfigValue`の許可リストで決め、表に無い項目は、値を入れずに`{ kind: "unknown" }`にする。
 * 種類を知っている項目の、型に合わない値は、`{ kind: "unknown", hash }`にする。
 * 値が参照を含む項目は、値を調べずに`{ redacted: true, hash }`にする。
 * 知らない項目(`isKnownConfigKey`が偽の項目)は、名前の昇順に`unknownKeysLimit`まで調べる。
 * 超えたときは、超えた項目を調べず(`excluded`)、知らない項目の総数を`UNKNOWN_KEYS_ITEM_KEY`の項目に入れる。
 * resourceがオブジェクトでなければ`null`を返す。
 */
export function projectConfigSnapshot(
  raw: unknown,
  unknownKeysLimit: number = SNAPSHOT_UNKNOWN_KEYS_LIMIT,
): ConfigSnapshotProjection | null {
  if (!isRecord(raw)) return null;
  const items = new Map<string, ConfigProjection>();
  const excluded = new Set<string>();
  let referenceKeys = 0;
  let unnamedKeys = 0;
  let unknownKeys = 0;
  for (const key of Object.keys(raw).sort()) {
    if (!isConfigItemKey(key) || RESERVED_KEYS.has(key)) {
      unnamedKeys += 1;
      continue;
    }
    if (!isKnownConfigKey(key)) {
      unknownKeys += 1;
      if (unknownKeys > unknownKeysLimit) {
        excluded.add(key);
        continue;
      }
    }
    const value = raw[key];
    if (holdsReference(value)) referenceKeys += 1;
    items.set(key, projectConfigValue(key, value));
  }
  if (unknownKeys > unknownKeysLimit) {
    items.set(UNKNOWN_KEYS_ITEM_KEY, { count: unknownKeys });
  }
  return {
    items,
    reference_keys: referenceKeys,
    unnamed_keys: unnamedKeys,
    unknown_keys: unknownKeys,
    excluded,
  };
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
    return typeof value.hash === "string"
      ? { count: value.count, hash: value.hash }
      : { count: value.count };
  }
  if (value.redacted === true) {
    return typeof value.hash === "string"
      ? { redacted: true, hash: value.hash }
      : { redacted: true };
  }
  // `kind`を持つ形は、`hash`を持っても、`{ hash }`の形ではないので、先に読む。
  if (value.kind === "unknown") {
    return typeof value.hash === "string"
      ? { kind: "unknown", hash: value.hash }
      : UNKNOWN;
  }
  if (value.kind === "marker") return MARKER;
  if (value.kind === "object") return OBJECT_MARK;
  if (typeof value.hash === "string") {
    return value.changed === true || value.changed === false
      ? { hash: value.hash, changed: value.changed }
      : { hash: value.hash };
  }
  if (value.removed === true) return REMOVED_PROJECTION;
  return undefined;
}

/**
 * 比べるための形にする。ハッシュの項目の`changed`は、変更の経路が前後の比較で付ける印なので、比べるときは外す。
 * 外さないと、Consoleが書いた行(`changed`が付く)と、今の値の射影(付かない)が、いつも違って見える。
 * 一覧、伏せた項目、型に合わない値の印は、ハッシュも比べる。ハッシュの無い行(ハッシュを足す前に書いた行)は、ハッシュのある射影と違う値として比べる。
 */
function comparable(projection: ConfigProjection): string {
  if (projection !== null && typeof projection === "object") {
    if ("redacted" in projection) {
      return JSON.stringify({
        redacted: true,
        hash: projection.hash ?? null,
      });
    }
    if ("count" in projection) {
      return JSON.stringify({
        count: projection.count,
        hash: projection.hash ?? null,
      });
    }
    if ("kind" in projection && projection.kind === "unknown") {
      return JSON.stringify({
        kind: "unknown",
        hash: projection.hash ?? null,
      });
    }
    if ("hash" in projection) {
      return JSON.stringify({ hash: projection.hash });
    }
  }
  return JSON.stringify(projection);
}

/** 履歴に書く`before`にする。`changed`は、変更後の側だけに付く印なので外す。 */
function withoutChangedMark(projection: ConfigProjection): ConfigProjection {
  return isPlainHashProjection(projection)
    ? { hash: projection.hash }
    : projection;
}

/**
 * 照合が見つけた、履歴に書く変更1つ。
 * - baseline: 基準の段階で、履歴にまだ無い項目の最初の値。`before`は`null`である。
 * - added: 基準の印が書かれた後に、履歴にまだ無い項目が現れた。`before`は`null`、`after`は今の射影である。
 * - changed: 履歴の最後の`after`と、今の射影が違う。`before`は履歴の最後の`after`である。
 * - removed: 履歴にある項目が、今は無い。`after`は`{ removed: true }`である。
 */
export type SnapshotChange = {
  readonly key: string;
  readonly kind: "baseline" | "added" | "changed" | "removed";
  readonly before: ConfigProjection;
  readonly after: ConfigProjection;
};

/**
 * 項目ごとの履歴の最後の`after`(`latest`)と、今の射影(`current`)の差を、項目名の昇順で返す。
 * 履歴にまだ無い項目は、`baselineDone`が偽(基準の印がまだ無い)なら`baseline`、真なら`added`にする。省くと偽である。
 * 履歴の最後の`after`が`{ removed: true }`で、項目がまだ無いときは、差とは見なさない。
 * 履歴の最後の`after`が`null`で、項目がまだ無いときも、差とは見なさない。
 * Consoleの経路は、読み直しで値が見つからなかった項目の`after`を`null`で書くためである。
 * 値が`null`の項目を消したときの`removed`は、この規則のために書かれない。
 * 履歴の値が射影として読めないときは、`{ kind: "unknown" }`として比べる。
 * 基準の印の行は、呼び出し側が`latest`から除く。
 */
export function diffSnapshot(
  latest: ReadonlyMap<string, unknown>,
  current: ReadonlyMap<string, ConfigProjection>,
  baselineDone = false,
): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  const keys = [...new Set([...latest.keys(), ...current.keys()])].sort();
  for (const key of keys) {
    const now = current.get(key);
    if (!latest.has(key)) {
      if (now !== undefined) {
        changes.push({
          key,
          kind: baselineDone ? "added" : "baseline",
          before: null,
          after: now,
        });
      }
      continue;
    }
    // `null`は値が`null`の項目の射影なので、`??`で未知に置き換えない。
    const stored = parseStoredProjection(latest.get(key));
    const last = stored === undefined ? UNKNOWN : stored;
    if (now === undefined) {
      if (
        last !== null &&
        comparable(last) !== comparable(REMOVED_PROJECTION)
      ) {
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

/**
 * resource全体の状態の変更を返す。履歴の最後の値と今の状態が同じなら`null`を返す。
 * - オブジェクトでないとき: 今の状態は値のハッシュ(`{ redacted: true, hash }`)で、履歴の最後の値と違えば変更である。
 * - オブジェクトのとき: 履歴にこの項目の行が無いか、最後の値が`{ kind: "object" }`なら変更ではない。
 *   最後の値がそれ以外(オブジェクトでない値の印、読めない形)なら、オブジェクトに戻った印を書く。
 * `before`は履歴の最後の値で、行が無ければ`null`である。
 */
export function resourceStateChange(
  raw: unknown,
  isObject: boolean,
  latest: ReadonlyMap<string, unknown>,
): SnapshotChange | null {
  const now = isObject ? OBJECT_MARK : projectNonObjectResource(raw);
  if (!latest.has(RESOURCE_ITEM_KEY)) {
    return isObject
      ? null
      : { key: RESOURCE_ITEM_KEY, kind: "changed", before: null, after: now };
  }
  const stored = parseStoredProjection(latest.get(RESOURCE_ITEM_KEY));
  const last = stored === undefined ? UNKNOWN : stored;
  if (comparable(last) === comparable(now)) return null;
  return {
    key: RESOURCE_ITEM_KEY,
    kind: "changed",
    before: withoutChangedMark(last),
    after: now,
  };
}

/** 書く順の群。知っている項目、知らない項目、基準の行の順である。 */
function groupOf(change: SnapshotChange): 0 | 1 | 2 {
  if (change.kind === "baseline") return 2;
  return isKnownConfigKey(change.key) || change.key === UNKNOWN_KEYS_ITEM_KEY
    ? 0
    : 1;
}

/**
 * 書く順に並べる。知っている項目の変更、知らない項目の変更、基準の行の順で、同じ群の中は項目名の昇順である。
 * 知らない項目が名前の順で先に並び、上限を使い切っても、知っている項目の変更は先に書かれる。
 * 知らない項目の総数の項目(`UNKNOWN_KEYS_ITEM_KEY`)は、知っている項目の群に入れる。
 */
export function orderChanges(
  changes: readonly SnapshotChange[],
): SnapshotChange[] {
  return [...changes].sort((a, b) => {
    const byGroup = groupOf(a) - groupOf(b);
    if (byGroup !== 0) return byGroup;
    if (a.key < b.key) return -1;
    return a.key > b.key ? 1 : 0;
  });
}

const REASON_OF_KIND = {
  baseline: "snapshot_baseline",
  added: "out_of_band_added",
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
 * `skipped_reason`が`null`でないときは、照合を終えられなかったので、ほかの件数は0である(`resource_not_object`の`changed`と`failed`を除く)。
 * - resource_unreadable: resourceを読めなかった(時間切れを含む)。
 * - resource_not_object: resourceがオブジェクトでなかった。この結果だけは、resource全体の行を書いた数を`changed`に、書けなかった数を`failed`に持つ。
 *   呼び出し側は、この結果でジョブを失敗させる(`resourceProblem`)。
 * - history_missing: 履歴の表か関数が無い(migrationが未反映)。
 * - history_unreadable: 履歴の最後の値を読めなかった。
 */
export type SnapshotResult = {
  /** 射影した項目の数。 */
  readonly keys_checked: number;
  /** 基準として書いた行の数。基準の印の行は含まない。 */
  readonly baseline: number;
  /** 基準の印が書かれた後に足された項目として書いた行の数。 */
  readonly added: number;
  /** 値の変更として書いた行の数。 */
  readonly changed: number;
  /** 項目が無くなったとして書いた行の数。 */
  readonly removed: number;
  /** 書けなかった行の数。 */
  readonly failed: number;
  /**
   * 行の上限、実行全体の時間の区切り、知らない項目の数の上限のどれかで、書かずに次の実行に回した差の数。
   * 知らない項目の数の上限を超えた項目は、上限を超える間、毎回数える。
   */
  readonly deferred: number;
  /** 参照を含み、値を見ずに伏せた項目の数。 */
  readonly reference_keys: number;
  /** 履歴の項目名の形に合わず、または照合の予約の名前で、飛ばした項目の数。 */
  readonly unnamed_keys: number;
  /** 知らない項目の総数。 */
  readonly unknown_keys: number;
  /** 基準の印の行を書いたら1、書かなかったら0。 */
  readonly marker_written: number;
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
  /** 基準の行を除いて、1回に書く行の上限。省くと`SNAPSHOT_ROW_CAP`。 */
  readonly cap?: number;
  /** 知らない項目を調べる数の上限。省くと`SNAPSHOT_UNKNOWN_KEYS_LIMIT`。 */
  readonly unknownKeysLimit?: number;
  /** 現在時刻(ミリ秒)を返す。省くと`Date.now`。実行全体の時間の区切りを数える。 */
  readonly now?: () => number;
  /** 実行の開始からこの時間を過ぎたら、残りの行を書かずに次の実行に回す。省くと`SNAPSHOT_DEADLINE_MS`。 */
  readonly deadlineMs?: number;
};

const EMPTY_COUNTS = {
  keys_checked: 0,
  baseline: 0,
  added: 0,
  changed: 0,
  removed: 0,
  failed: 0,
  deferred: 0,
  reference_keys: 0,
  unnamed_keys: 0,
  unknown_keys: 0,
  marker_written: 0,
} as const;

function skipped(
  reason: NonNullable<SnapshotResult["skipped_reason"]>,
): SnapshotResult {
  return { ...EMPTY_COUNTS, skipped_reason: reason };
}

/**
 * 書き残しがあるときの、ジョブを失敗させる文。書き残しが無い、または照合を終えられなかった実行では`null`を返す。
 * 書き残しが続くと、ジョブの失敗が続き、scheduleの連続失敗の検知が要対応の通知にする。
 * 文は件数だけで、項目名も値も入れない。
 */
export function deferralProblem(result: SnapshotResult): string | null {
  if (result.skipped_reason !== null || result.deferred === 0) return null;
  return `config_snapshot: ${result.deferred} change(s) were not written in this run and wait for the next run`;
}

/**
 * resourceがオブジェクトでないときの、ジョブを失敗させる文。そうでなければ`null`を返す。
 * オブジェクトでない間は、項目を1つも比べられないので、失敗を続けて、scheduleの連続失敗の検知が要対応の通知にする。
 * resourceと履歴が読めなかった実行(`resource_unreadable`、`history_unreadable`)では`null`を返し、失敗にしない。
 * 文は固定で、値も項目名も入れない。
 */
export function resourceProblem(result: SnapshotResult): string | null {
  if (result.skipped_reason !== "resource_not_object") return null;
  return "config_snapshot: the config resource is not an object, the job fails until it is an object again";
}

/** 注入された書き込みが投げても、失敗の結果にして返す。例外の文には値が入りうるので、捨てる。 */
async function appendWithoutThrowing(
  ports: SnapshotPorts,
  input: ConfigProjectionInput,
): Promise<ConfigHistoryAppendResult> {
  try {
    return await ports.append(input);
  } catch {
    return {
      recorded: false,
      kind: "write_failed",
      reason: "the append threw",
    };
  }
}

/** 基準の段階が終わったことを示す、印の行の入力。 */
const MARKER_INPUT: ConfigProjectionInput = {
  key: SNAPSHOT_BASELINE_MARKER_KEY,
  before: null,
  after: MARKER,
  actor: SNAPSHOT_ACTOR,
  source: "out_of_band",
  reason: "snapshot_baseline",
};

/**
 * resourceがオブジェクトでないときの、終わりの処理。resource全体の行があれば1行書き、結果を返す。
 * 書けなくても投げない。書けなかった行は、次の実行で、同じ差としてもう一度見つかる。
 */
async function finishNotObject(
  ports: SnapshotPorts,
  change: SnapshotChange | null,
): Promise<SnapshotResult> {
  if (change === null) return skipped("resource_not_object");
  const result = await appendWithoutThrowing(ports, toAppendInput(change));
  if (result.recorded) {
    return {
      ...EMPTY_COUNTS,
      changed: 1,
      skipped_reason: "resource_not_object",
    };
  }
  ports.log.warn("config_snapshot: could not write the row of the resource", {
    kind: result.kind,
  });
  return { ...EMPTY_COUNTS, failed: 1, skipped_reason: "resource_not_object" };
}

/**
 * 履歴の最後の値とresourceをこの順に読み、差を`out_of_band`として書く。投げない。
 * 差は、知っている項目、知らない項目、基準の行の順に、実行全体の時間(`deadlineMs`)まで書く。
 * 基準の行を除く行は、上限(`cap`)まで書く。残りは次の実行に回す。書かなければ差は残るので、2回続けて実行しても、2回目は何も書かない。
 * resourceがオブジェクトでないときは、resource全体の行を1行だけ書き(同じ値の間は書かない)、項目は比べずに終える。
 * オブジェクトに戻ったときは、戻った印の行を、ほかの行より先に書く。この行は、行の上限に数えない。
 * 基準の段階(印が無い間)に、基準の行をすべて書き終えたら、最後に印の行を書く。書き終えなければ、印は書かず、次の実行が続ける。
 * 1行の書き込みが失敗しても、残りを続ける。失敗した項目は、次の実行でもう一度差として見つかる。
 * ログには、件数と失敗の種類だけを出し、項目名と値は出さない。
 */
export async function runConfigSnapshot(
  ports: SnapshotPorts,
): Promise<SnapshotResult> {
  const cap = ports.cap ?? SNAPSHOT_ROW_CAP;
  const now = ports.now ?? Date.now;
  const deadlineMs = ports.deadlineMs ?? SNAPSHOT_DEADLINE_MS;
  const unknownKeysLimit =
    ports.unknownKeysLimit ?? SNAPSHOT_UNKNOWN_KEYS_LIMIT;
  const startedAt = now();

  // 履歴を先に読み、resourceを後で読む。
  // Consoleが、resourceを書いた後に自分の行を書く間に、2つを読んでも、古い履歴と新しいresourceの組になる。
  // その組では、正しい値で、経路の記録だけが違う重複の行が1つ増える。
  // 順を逆にすると、新しい履歴と古いresourceの組になり、古い値へ戻した偽の行が2つ増える。
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

  let raw: unknown;
  try {
    raw = await ports.readRawConfig();
  } catch {
    ports.log.warn("config_snapshot: could not read the config resource");
    return skipped("resource_unreadable");
  }
  const projection = projectConfigSnapshot(raw, unknownKeysLimit);
  const resourceChange = resourceStateChange(raw, projection !== null, latest);
  if (projection === null) {
    ports.log.warn("config_snapshot: the config resource is not an object");
    return await finishNotObject(ports, resourceChange);
  }

  // 印の行は設定の項目ではないので、比べない。基準の段階が終わったかは、印の行の有無で決める。
  // 調べなかった項目は、履歴に行があっても、今の射影に無いので、除かないと無くなった項目に見える。
  const baselineDone = latest.has(SNAPSHOT_BASELINE_MARKER_KEY);
  const compared = new Map(
    [...latest].filter(
      ([key]) =>
        key !== SNAPSHOT_BASELINE_MARKER_KEY &&
        key !== RESOURCE_ITEM_KEY &&
        !projection.excluded.has(key),
    ),
  );
  const ordered = orderChanges(
    diffSnapshot(compared, projection.items, baselineDone),
  );
  const baselineChanges = ordered.filter(
    (change) => change.kind === "baseline",
  );
  const otherChanges = ordered.filter((change) => change.kind !== "baseline");
  const cappedChanges = otherChanges.slice(0, cap);
  const toWrite = [
    ...(resourceChange === null ? [] : [resourceChange]),
    ...cappedChanges,
    ...baselineChanges,
  ];

  const capDeferred = otherChanges.length - cappedChanges.length;
  let deferred = capDeferred + projection.excluded.size;
  if (capDeferred > 0) {
    ports.log.warn(
      "config_snapshot: more changes than the cap, the rest wait for the next run",
      { cap, deferred: capDeferred },
    );
  }
  if (projection.excluded.size > 0) {
    ports.log.warn(
      "config_snapshot: more unknown keys than the limit, the rest are not checked",
      {
        limit: unknownKeysLimit,
        unknown_keys: projection.unknown_keys,
        excluded: projection.excluded.size,
      },
    );
  }

  let baseline = 0;
  let added = 0;
  let changed = 0;
  let removed = 0;
  let failed = 0;
  // 基準の行を1つでも書けなかった、または書かずに残したら、基準の段階は終わっていない。
  let baselineLeft = false;
  for (const [index, change] of toWrite.entries()) {
    // 実行全体の時間が尽きたら、残りは書かずに、次の実行に回す。差は残るので、次の実行がもう一度見つける。
    if (now() - startedAt >= deadlineMs) {
      const rest = toWrite.slice(index);
      deferred += rest.length;
      baselineLeft = baselineLeft || rest.some((c) => c.kind === "baseline");
      ports.log.warn(
        "config_snapshot: the deadline of the run passed, the rest wait for the next run",
        { deadline_ms: deadlineMs, left: rest.length },
      );
      break;
    }
    const result = await appendWithoutThrowing(ports, toAppendInput(change));
    if (!result.recorded) {
      failed += 1;
      if (change.kind === "baseline") baselineLeft = true;
      ports.log.warn("config_snapshot: could not write a row", {
        kind: result.kind,
      });
      continue;
    }
    if (change.kind === "baseline") baseline += 1;
    else if (change.kind === "added") added += 1;
    else if (change.kind === "changed") changed += 1;
    else removed += 1;
  }

  // 基準の行をすべて書き終えた最後に、印を書く。時間が尽きていたら、次の実行が書く。
  let markerWritten = 0;
  if (!baselineDone && !baselineLeft) {
    if (now() - startedAt >= deadlineMs) {
      ports.log.warn(
        "config_snapshot: the deadline of the run passed before the marker of the baseline",
        { deadline_ms: deadlineMs },
      );
    } else {
      const result = await appendWithoutThrowing(ports, MARKER_INPUT);
      if (result.recorded) {
        markerWritten = 1;
      } else {
        failed += 1;
        ports.log.warn("config_snapshot: could not write the marker row", {
          kind: result.kind,
        });
      }
    }
  }

  return {
    keys_checked: projection.items.size,
    baseline,
    added,
    changed,
    removed,
    failed,
    deferred,
    reference_keys: projection.reference_keys,
    unnamed_keys: projection.unnamed_keys,
    unknown_keys: projection.unknown_keys,
    marker_written: markerWritten,
    skipped_reason: null,
  };
}
