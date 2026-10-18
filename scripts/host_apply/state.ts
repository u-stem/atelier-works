/**
 * `state.json`の型と、型ガードによる読み取り、純粋な遷移。ファイルには触れない。
 * 読めない、または未知の版は`state_unreadable`にする。
 * 自由文字列の欄は持たず、欄ごとに形を検査する。
 */

import { isDateTime } from "./drain_store.ts";
import { isSha40 } from "./git.ts";
import { NOTIFY_REASONS } from "./notify_text.ts";
import { isRecord, stableStringify } from "./stable.ts";
import type { RejectionKind } from "./target.ts";

export const STATE_SCHEMA = 2;

/** 状態ファイルの大きさの上限(バイト)。 */
export const MAX_STATE_BYTES = 256 * 1024;

const MAX_APPLIED_IMAGES = 2;
const MAX_CI = 20;
const MAX_REJECTED = 200;
const MAX_MANUAL_REQUIRED = 200;
const MAX_RULESET_CONTEXTS = 32;

export const PHASES = [
  "build",
  "drain",
  "apply",
  "switch",
  "post",
  "restore",
] as const;
export type Phase = (typeof PHASES)[number];

export const CASES = ["none", "A", "B", "C"] as const;
export type ConvergeCase = (typeof CASES)[number];

export const OUTCOME_KINDS = [
  "converged",
  "noop",
  "disabled",
  "pending",
  "pending_ci",
  "rate_limited",
  "pending_approval",
  "rejected",
  "failed",
  "needs_manual",
  "over_limit",
  "drain_not_started",
  "finished_manually",
  "recovered",
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type ImageEntry = {
  readonly image_id: string;
  readonly build_key: string;
};

/** 確認(`yes`か`--expect`の一致)の証拠。ビルドの前に見せた`candidates`を残す。 */
export type Confirmation = {
  readonly at: string;
  readonly sha: string;
  readonly candidates: readonly string[];
};

export type Converging = {
  readonly sha: string;
  readonly started_at: string;
  readonly executor_version: string;
  readonly phase: Phase;
  /** ケースはビルドの後に決まる。`build`の間だけ`null`でよい。 */
  readonly case: ConvergeCase | null;
  readonly forward_only: boolean;
  readonly candidates: readonly string[];
  readonly recreate: readonly string[];
  readonly tags_changed: boolean;
  readonly old_images: Readonly<Record<string, string>>;
  readonly new_images: Readonly<Record<string, string>>;
  /** ビルドするサービスの`:latest`のイメージID。ビルドの前にだけ`null`でよい。 */
  readonly latest_before: Readonly<Record<string, string>> | null;
  /** 作り直す前のコンテナのID。無かったサービスは`null`。 */
  readonly old_containers: Readonly<Record<string, string | null>>;
  /** `down`を確かめて、まだ作り直していないもの。 */
  readonly drained: readonly string[];
  /** 作り直しと準備の確認が済んだもの。値は新しいコンテナのID。 */
  readonly rolled: Readonly<Record<string, string>>;
  readonly confirmation: Confirmation;
};

export type HostApplyState = {
  readonly schema: 2;
  readonly applied_sha: string;
  readonly applied_images: Readonly<
    Record<string, Readonly<Record<string, ImageEntry>>>
  >;
  readonly converging: Converging | null;
  readonly prepared_sha: string | null;
  readonly last_target: string | null;
  readonly attempts: number;
  readonly first_seen_at: string | null;
  readonly rejected: Readonly<
    Record<
      string,
      {
        readonly kind: RejectionKind;
        readonly at: string;
        readonly executor_version: string;
      }
    >
  >;
  readonly manual_required: Readonly<
    Record<string, { readonly at: string; readonly executor_version: string }>
  >;
  readonly notified: Readonly<
    Record<string, { readonly last_at: string; readonly open: boolean }>
  >;
  readonly ci: Readonly<
    Record<string, { readonly verdict: "pass"; readonly at: string }>
  >;
  readonly ruleset: {
    readonly contexts: readonly string[];
    readonly at: string;
  } | null;
  readonly last_outcome: {
    readonly kind: OutcomeKind;
    readonly at: string;
  } | null;
};

export type StateRead =
  | { readonly kind: "ok"; readonly state: HostApplyState }
  | { readonly kind: "state_unreadable"; readonly reason: string };

const REJECTION_KINDS: readonly string[] = [
  "compose_forbidden",
  "mise_forbidden",
  "unknown_service",
  "caddy_invalid",
  "not_ff",
  "tree_forbidden",
  "ci_failed",
  "docker_version",
];

const STATE_KEYS: readonly string[] = [
  "schema",
  "applied_sha",
  "applied_images",
  "converging",
  "prepared_sha",
  "last_target",
  "attempts",
  "first_seen_at",
  "rejected",
  "manual_required",
  "notified",
  "ci",
  "ruleset",
  "last_outcome",
];
const CONVERGING_KEYS: readonly string[] = [
  "sha",
  "started_at",
  "executor_version",
  "phase",
  "case",
  "forward_only",
  "candidates",
  "recreate",
  "tags_changed",
  "old_images",
  "new_images",
  "latest_before",
  "old_containers",
  "drained",
  "rolled",
  "confirmation",
];

const SERVICE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const BUILD_KEY = /^[0-9A-Za-z:._-]{1,128}$/;
const CONTEXT_NAME = /^[A-Za-z0-9 ._:/-]{1,64}$/;

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function isOneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && list.some((item) => item === value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && isSha40(value);
}

function isShaOrNull(value: unknown): value is string | null {
  return value === null || isSha(value);
}

function isTime(value: unknown): value is string {
  return isDateTime(value, true);
}

function isTimeOrNull(value: unknown): value is string | null {
  return value === null || isTime(value);
}

function isService(value: unknown): value is string {
  return typeof value === "string" && SERVICE_NAME.test(value);
}

function isMatch(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.test(value);
}

/** 重複の無いサービス名の配列か。 */
function isServiceList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(isService) &&
    new Set(value).size === value.length
  );
}

function isServiceMap(
  value: unknown,
  isValue: (entry: unknown) => boolean,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => isService(key) && isValue(entry),
    )
  );
}

function isImageId(value: unknown): boolean {
  return isMatch(IMAGE_ID, value);
}

function isContainerId(value: unknown): boolean {
  return isMatch(CONTAINER_ID, value);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function isSubset(a: readonly string[], b: readonly string[]): boolean {
  return a.every((item) => b.includes(item));
}

function isImageEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["image_id", "build_key"]) &&
    isImageId(value.image_id) &&
    isMatch(BUILD_KEY, value.build_key)
  );
}

function isAppliedImages(value: unknown, appliedSha: string): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > MAX_APPLIED_IMAGES) return false;
  if (!keys.includes(appliedSha)) return false;
  return Object.entries(value).every(
    ([sha, images]) =>
      isSha(sha) &&
      isServiceMap(images, isImageEntry) &&
      Object.keys(images).length > 0,
  );
}

function isConfirmation(value: unknown): value is Confirmation {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["at", "sha", "candidates"]) &&
    isTime(value.at) &&
    isSha(value.sha) &&
    isServiceList(value.candidates)
  );
}

/** `converging`の欄ごとの形。欄どうしの規則は`isConsistent`が見る。 */
function hasConvergingShape(
  value: Record<string, unknown>,
): value is Converging {
  return (
    isSha(value.sha) &&
    isTime(value.started_at) &&
    isSha(value.executor_version) &&
    isOneOf(PHASES, value.phase) &&
    (value.case === null || isOneOf(CASES, value.case)) &&
    typeof value.forward_only === "boolean" &&
    isServiceList(value.candidates) &&
    isServiceList(value.recreate) &&
    typeof value.tags_changed === "boolean" &&
    isServiceMap(value.old_images, isImageId) &&
    isServiceMap(value.new_images, isImageId) &&
    (value.latest_before === null ||
      isServiceMap(value.latest_before, isImageId)) &&
    isServiceMap(
      value.old_containers,
      (entry) => entry === null || isContainerId(entry),
    ) &&
    isServiceList(value.drained) &&
    isServiceMap(value.rolled, isContainerId) &&
    isConfirmation(value.confirmation)
  );
}

/**
 * 形が合った`converging`が、ケースに依らない段階の規則を満たすか。
 * ケースごとの規則(何を作り直せるか、何を排水できるか)は、そのケースの状態を書くPRで足す。
 * 書き手のいないケースの規則を先に置くと、後から書く側の正当な状態を拒否して実行役が止まるため。
 */
function isConsistent(c: Converging, appliedSha: string): boolean {
  const rolledKeys = Object.keys(c.rolled);
  if (c.sha === appliedSha) return false;
  if (c.confirmation.sha !== c.sha) return false;
  if (!sameSet(c.confirmation.candidates, c.candidates)) return false;
  if (!isSubset(c.recreate, c.candidates)) return false;
  if (c.phase === "build") {
    if (c.drained.length > 0 || rolledKeys.length > 0) return false;
  } else {
    if (c.latest_before === null || c.case === null) return false;
    if (!sameSet(Object.keys(c.old_containers), c.recreate)) return false;
  }
  // 前進しかできない状態は、ビルドの間と巻き戻しの間には無い。どのケースで立てるかは、そのケースを書く段階が決める。
  if (c.forward_only && (c.phase === "build" || c.phase === "restore")) {
    return false;
  }
  return true;
}

function isConverging(value: unknown, appliedSha: string): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !hasExactKeys(value, CONVERGING_KEYS)) return false;
  return hasConvergingShape(value) && isConsistent(value, appliedSha);
}

function isRejection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "at", "executor_version"]) &&
    isOneOf(REJECTION_KINDS, value.kind) &&
    isTime(value.at) &&
    isSha(value.executor_version)
  );
}

function isManualRequired(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["at", "executor_version"]) &&
    isTime(value.at) &&
    isSha(value.executor_version)
  );
}

function isNotified(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["last_at", "open"]) &&
    isTime(value.last_at) &&
    typeof value.open === "boolean"
  );
}

function isCiVerdict(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["verdict", "at"]) &&
    value.verdict === "pass" &&
    isTime(value.at)
  );
}

function isRuleset(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ["contexts", "at"]) &&
    Array.isArray(value.contexts) &&
    value.contexts.length <= MAX_RULESET_CONTEXTS &&
    value.contexts.every((name) => isMatch(CONTEXT_NAME, name)) &&
    isTime(value.at)
  );
}

function isLastOutcome(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "at"]) &&
    isOneOf(OUTCOME_KINDS, value.kind) &&
    isTime(value.at)
  );
}

function isShaMap(
  value: unknown,
  limit: number,
  isValue: (entry: unknown) => boolean,
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length <= limit &&
    Object.entries(value).every(([sha, entry]) => isSha(sha) && isValue(entry))
  );
}

function isNotifiedMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([reason, entry]) => isOneOf(NOTIFY_REASONS, reason) && isNotified(entry),
    )
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `state.json`の中身の型ガード。形を1つずつ確かめ、足りない、または余計なものは通さない。 */
export function isHostApplyState(value: unknown): value is HostApplyState {
  if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)) return false;
  const appliedSha = value.applied_sha;
  if (value.schema !== STATE_SCHEMA || !isSha(appliedSha)) return false;
  return (
    isAppliedImages(value.applied_images, appliedSha) &&
    isConverging(value.converging, appliedSha) &&
    isShaOrNull(value.prepared_sha) &&
    isShaOrNull(value.last_target) &&
    isCount(value.attempts) &&
    isTimeOrNull(value.first_seen_at) &&
    isShaMap(value.rejected, MAX_REJECTED, isRejection) &&
    isShaMap(value.manual_required, MAX_MANUAL_REQUIRED, isManualRequired) &&
    isNotifiedMap(value.notified) &&
    isShaMap(value.ci, MAX_CI, isCiVerdict) &&
    isRuleset(value.ruleset) &&
    isLastOutcome(value.last_outcome)
  );
}

/**
 * `state.json`の本文を読む。
 * 読めない、または未知の版のときは、空の状態とみなさず`state_unreadable`にする。
 * 空とみなすと、拒否の控えと排水の記録が消え、排水中のworkerを二重に止めるため。
 * 理由に本文は含めない。
 */
export function parseState(text: string): StateRead {
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    return { kind: "state_unreadable", reason: "too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "state_unreadable", reason: "not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { kind: "state_unreadable", reason: "not an object" };
  }
  if (parsed.schema !== STATE_SCHEMA) {
    return { kind: "state_unreadable", reason: "unknown schema version" };
  }
  if (!isHostApplyState(parsed)) {
    return { kind: "state_unreadable", reason: "unexpected shape" };
  }
  return { kind: "ok", state: parsed };
}

/** 状態をファイルの本文にする。形の合わない状態と上限を超える本文は、書く前に止めるため例外にする。 */
export function serializeState(state: HostApplyState): string {
  if (!isHostApplyState(state)) throw new Error("invalid state");
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    throw new Error("state is too large");
  }
  return text;
}

/** 導入直後の状態。`init`が動いているコンテナから集めた適用済みのイメージを入れる。 */
export function newState(
  appliedSha: string,
  appliedImages: Readonly<Record<string, ImageEntry>>,
): HostApplyState {
  return {
    schema: STATE_SCHEMA,
    applied_sha: appliedSha,
    applied_images: { [appliedSha]: appliedImages },
    converging: null,
    prepared_sha: null,
    last_target: null,
    attempts: 0,
    first_seen_at: null,
    rejected: {},
    manual_required: {},
    notified: {},
    ci: {},
    ruleset: null,
    last_outcome: null,
  };
}

export type CommitInput = {
  /** 新しい`applied_sha`のサービスごとのイメージ。 */
  readonly images: Readonly<Record<string, ImageEntry>>;
  readonly outcome: "converged" | "finished_manually";
  readonly now: string;
};

/**
 * 後処理まで済んだ収束を、適用済みにする。`phase`が`post`の`converging`が要る。
 * 適用済みのイメージは、新しいshaと前のshaの最新2件だけ残す。
 * 記録した新しいイメージIDと食い違う`images`は、別のイメージを適用済みとして残すことになるので拒否する。
 */
export function applyCommit(
  state: HostApplyState,
  input: CommitInput,
): HostApplyState {
  const { converging } = state;
  if (converging === null || converging.phase !== "post") {
    throw new Error("no convergence is ready to commit");
  }
  // `images`のキーは、記録した新しいイメージのキーと等しい。空の記録を確定させない。
  if (
    Object.keys(converging.new_images).length === 0 ||
    !sameSet(Object.keys(input.images), Object.keys(converging.new_images))
  ) {
    throw new Error("images do not match the recorded new images");
  }
  for (const [service, imageId] of Object.entries(converging.new_images)) {
    if (input.images[service]?.image_id !== imageId) {
      throw new Error("images do not match the recorded new images");
    }
  }
  const previous = state.applied_images[state.applied_sha];
  const next: HostApplyState = {
    ...state,
    applied_sha: converging.sha,
    applied_images: {
      ...(previous === undefined ? {} : { [state.applied_sha]: previous }),
      [converging.sha]: input.images,
    },
    converging: null,
    attempts: 0,
    first_seen_at: null,
    last_outcome: { kind: input.outcome, at: input.now },
  };
  if (!isHostApplyState(next)) throw new Error("invalid state after commit");
  return next;
}

/** 時刻の新しい順に`limit`件だけ残す。同じ時刻はキーの逆順で決める。 */
function keepNewest<T extends { readonly at: string }>(
  entries: Readonly<Record<string, T>>,
  limit: number,
): Record<string, T> {
  const sorted = Object.entries(entries).sort(([keyA, a], [keyB, b]) =>
    Date.parse(a.at) === Date.parse(b.at)
      ? keyB.localeCompare(keyA)
      : Date.parse(b.at) - Date.parse(a.at),
  );
  return Object.fromEntries(sorted.slice(0, limit));
}

/** CIの通過を覚える。最新の20件だけ残す。 */
export function withCiPass(
  state: HostApplyState,
  sha: string,
  at: string,
): HostApplyState {
  return {
    ...state,
    ci: keepNewest({ ...state.ci, [sha]: { verdict: "pass", at } }, MAX_CI),
  };
}

/** 拒否を控える。件数の上限を超えないよう、新しい200件だけ残す。 */
export function withRejection(
  state: HostApplyState,
  sha: string,
  record: HostApplyState["rejected"][string],
): HostApplyState {
  return {
    ...state,
    rejected: keepNewest({ ...state.rejected, [sha]: record }, MAX_REJECTED),
  };
}

/** 人の手が要る版を控える。件数の上限を超えないよう、新しい200件だけ残す。 */
export function withManualRequired(
  state: HostApplyState,
  sha: string,
  record: HostApplyState["manual_required"][string],
): HostApplyState {
  return {
    ...state,
    manual_required: keepNewest(
      { ...state.manual_required, [sha]: record },
      MAX_MANUAL_REQUIRED,
    ),
  };
}

const FORWARD_RANK: Readonly<Record<Phase, number>> = {
  build: 0,
  drain: 1,
  apply: 2,
  switch: 3,
  post: 4,
  restore: -1,
};

/** 段階の遷移が許されるか。前進は同じ段階か次の段階へ(飛ばさない)、巻き戻しは`drain`か`apply`から、巻き戻しの後は前進に戻らない。 */
function isAllowedPhaseMove(from: Phase, to: Phase): boolean {
  if (from === "restore") return to === "restore";
  if (to === "restore") return from === "drain" || from === "apply";
  const step = FORWARD_RANK[to] - FORWARD_RANK[from];
  return step === 0 || step === 1;
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * 収束の記録の更新が、前の記録から見て許されるか。
 * 型ガードは1つの状態の形しか見ないので、再開で書き換えてはならない欄と、戻れない段階をここで守る。
 * - 新しく始めるのは`build`から。
 * - `sha`、開始時刻、`candidates`、`confirmation`は変えない。
 * - `latest_before`は一度書いたら変えない。`recreate`、`old_containers`、`old_images`、`new_images`は、`build`を出た後は変えない。
 * - `forward_only`は真になったら戻らない。`case`は決まったら変えず、`tags_changed`は`build`を出たら変えない。
 * - 消せるのは、`build`か`restore`のときだけ。段階は1つずつ進め、飛ばさない。
 * - `rolled`は、巻き戻しの外では減らさず、値も変えない。
 */
export function isAllowedTransition(
  prev: HostApplyState,
  next: HostApplyState,
): boolean {
  const before = prev.converging;
  const after = next.converging;
  if (after === null) {
    // 排水以降は、止めたworkerを戻す情報を持つので、巻き戻しを経ずに消さない。
    return (
      before === null || before.phase === "build" || before.phase === "restore"
    );
  }
  if (before === null) return after.phase === "build";
  if (
    before.sha !== after.sha ||
    before.started_at !== after.started_at ||
    before.executor_version !== after.executor_version ||
    !same(before.candidates, after.candidates) ||
    !same(before.confirmation, after.confirmation)
  ) {
    return false;
  }
  if (!isAllowedPhaseMove(before.phase, after.phase)) return false;
  if (before.forward_only && !after.forward_only) return false;
  if (before.case !== null && before.case !== after.case) return false;
  if (before.phase !== "build" && before.tags_changed !== after.tags_changed) {
    return false;
  }
  if (
    before.latest_before !== null &&
    !same(before.latest_before, after.latest_before)
  ) {
    return false;
  }
  if (
    before.phase !== "build" &&
    (!same(before.recreate, after.recreate) ||
      !same(before.old_containers, after.old_containers) ||
      !same(before.old_images, after.old_images) ||
      !same(before.new_images, after.new_images))
  ) {
    return false;
  }
  if (before.phase !== "restore" && after.phase !== "restore") {
    return Object.entries(before.rolled).every(
      ([service, id]) => after.rolled[service] === id,
    );
  }
  return true;
}
