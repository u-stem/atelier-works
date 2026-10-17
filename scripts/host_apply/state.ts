/** `state.json`の型と、型ガードによる読み取り。読めない、または未知の版は`state_unreadable`にする。 */

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
    Record<string, { readonly kind: RejectionKind; readonly at: string }>
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

export function initialState(_appliedSha: string | null): HostApplyState {
  return {
    schema: 1,
    applied_sha: "stub",
    applied_images: {},
    converging: null,
    prepared_sha: null,
    last_target: null,
    attempts: -1,
    first_seen_at: null,
    rejected: {},
    drain: {},
    notified: {},
    last_outcome: null,
  };
}

export function parseState(_text: string): StateRead {
  return { kind: "state_unreadable", reason: "stub" };
}
