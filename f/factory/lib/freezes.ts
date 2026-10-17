// スケジュールの凍結の純粋関数群。I/Oは持たない。
// 状態の読み書きは`./freeze_apply.ts`、人の端末のCLIは`scripts/freeze.ts`が行う。

export const FREEZE_VARIABLE_PATH = "f/factory/freezes";
export const FREEZE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const FREEZE_MAX_ENTRIES = 50;
export const FREEZE_REQUIRED_EXCLUDES: readonly string[] = [];

export type FreezeHolderKind = "session" | "human";

export type FreezeEntry = {
  readonly id: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: FreezeHolderKind;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
};

export type FreezeState = {
  readonly version: 1;
  readonly freezes: readonly FreezeEntry[];
};

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export function emptyFreezeState(): FreezeState {
  return { version: 1, freezes: [] };
}

export function parseFreezeState(_text: string | null): Outcome<FreezeState> {
  return { ok: false, reason: "not implemented" };
}

export function serializeFreezeState(_state: FreezeState): string {
  return "";
}

export function isActive(_entry: FreezeEntry, _now: Date): boolean {
  return false;
}

export function activeFreezes(
  _state: FreezeState,
  _now: Date,
): readonly FreezeEntry[] {
  return [];
}

export function endedFreezes(
  _state: FreezeState,
  _now: Date,
): readonly FreezeEntry[] {
  return [];
}

export function parseWmillExcludes(_yamlText: string): Outcome<string[]> {
  return { ok: false, reason: "not implemented" };
}

export function buildExcludes(
  _base: readonly string[],
  _targets: readonly string[],
): Outcome<string[]> {
  return { ok: false, reason: "not implemented" };
}

export function excludesArg(_patterns: readonly string[]): string {
  return "";
}

export type PlaceInput = {
  readonly id: string;
  readonly target: string;
  readonly minutes: number;
  readonly reason: string;
  readonly holder_kind: FreezeHolderKind;
  readonly holder: string;
};

export function placeFreeze(
  _state: FreezeState,
  _input: PlaceInput,
  _known: ReadonlySet<string>,
  _now: Date,
): Outcome<FreezeState> {
  return { ok: false, reason: "not implemented" };
}

export type FreezeActor = {
  readonly kind: FreezeHolderKind;
  readonly holder: string;
};

export function releaseFreeze(
  _state: FreezeState,
  _id: string,
  _actor: FreezeActor,
  _now: Date,
): Outcome<FreezeState> {
  return { ok: false, reason: "not implemented" };
}

export function removeFreezes(
  state: FreezeState,
  _ids: readonly string[],
): FreezeState {
  return state;
}

export function sanitizeForDisplay(_text: string): string {
  return "";
}

export function sessionHolderFromBranch(_branch: string): string {
  return "";
}
