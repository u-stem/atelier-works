/** `state.json`の型と、型ガードによる読み取り。読めない、または未知の版は`state_unreadable`にする。 */

import { isSha40 } from "./git.ts";
import type { RejectionKind } from "./target.ts";

export const STATE_SCHEMA = 1;

export type HostApplyState = {
  readonly schema: 1;
  readonly applied_sha: string | null;
  readonly applied_images: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly converging: {
    readonly sha: string;
    readonly started_at: string;
    readonly drained: readonly string[];
  } | null;
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
  readonly drain: Readonly<
    Record<
      string,
      {
        readonly container_id: string;
        readonly started_at: string;
        readonly signaled_at: string;
      }
    >
  >;
  readonly notified: Readonly<
    Record<string, { readonly last_at: string; readonly open: boolean }>
  >;
  readonly last_outcome: { readonly kind: string; readonly at: string } | null;
};

export type StateRead =
  | { readonly kind: "ok"; readonly state: HostApplyState }
  | { readonly kind: "state_unreadable"; readonly reason: string };

/** 導入直後の状態。適用済みのshaが分かれば入れ、分からなければ`null`にする。 */
export function initialState(appliedSha: string | null): HostApplyState {
  return {
    schema: STATE_SCHEMA,
    applied_sha: appliedSha,
    applied_images: {},
    converging: null,
    prepared_sha: null,
    last_target: null,
    attempts: 0,
    first_seen_at: null,
    rejected: {},
    drain: {},
    notified: {},
    last_outcome: null,
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isShaOrNull(value: unknown): value is string | null {
  return value === null || (isString(value) && isSha40(value));
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value);
}

function everyValue(
  value: unknown,
  check: (entry: unknown) => boolean,
): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

function isConverging(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    isString(value.sha) &&
    isSha40(value.sha) &&
    isString(value.started_at) &&
    Array.isArray(value.drained) &&
    value.drained.every(isString)
  );
}

function isRejection(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.kind) &&
    REJECTION_KINDS.includes(value.kind) &&
    isString(value.at) &&
    isString(value.executor_version)
  );
}

function isDrainEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.container_id) &&
    isString(value.started_at) &&
    isString(value.signaled_at)
  );
}

function isNotified(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.last_at) &&
    typeof value.open === "boolean"
  );
}

function isImages(value: unknown): boolean {
  return everyValue(value, (images) => everyValue(images, isString));
}

function isLastOutcome(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) && isString(value.kind) && isString(value.at))
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `state.json`の中身の型ガード。形を1つずつ確かめ、足りない、または余計な型のものは通さない。 */
function isHostApplyState(value: unknown): value is HostApplyState {
  return (
    isRecord(value) &&
    value.schema === STATE_SCHEMA &&
    isShaOrNull(value.applied_sha) &&
    isImages(value.applied_images) &&
    isConverging(value.converging) &&
    isShaOrNull(value.prepared_sha) &&
    isShaOrNull(value.last_target) &&
    isCount(value.attempts) &&
    isStringOrNull(value.first_seen_at) &&
    everyValue(value.rejected, isRejection) &&
    everyValue(value.drain, isDrainEntry) &&
    everyValue(value.notified, isNotified) &&
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
