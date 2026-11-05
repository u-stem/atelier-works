// 全停止の状態の解析と判定(テスト先行のためのスタブ)。
export const STOP_ALL_VARIABLE_PATH = "f/factory/stop_all";
export const STOP_ALL_REASON_MAX = 200;
export const STOP_ALL_ACTOR_MAX = 100;
export const STOP_ALL_CHECK_TIMEOUT_MS = 5_000;
export const STOP_ALL_VARIABLE_DESCRIPTION = "";
export const STOP_ALL_KEPT_SCHEDULES: readonly string[] = [];

export type StopAllState = {
  readonly placed_at: string;
  readonly placed_by: string;
  readonly reason: string;
};

export type StopAllStatus =
  | { readonly kind: "clear" }
  | { readonly kind: "active"; readonly state: StopAllState }
  | { readonly kind: "corrupt"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

export type StopAllReadIo = {
  readonly readVariable: () => Promise<string | null>;
};

export type StopAllBuild =
  | { readonly ok: true; readonly state: StopAllState }
  | {
      readonly ok: false;
      readonly problem: "invalid_reason" | "invalid_actor";
    };

export function isStopAllReason(_value: unknown): _value is string {
  return false;
}

export function parseStopAllValue(_raw: string | null): StopAllStatus {
  return { kind: "unreadable", reason: "stub" };
}

export async function readStopAll(_io: StopAllReadIo): Promise<StopAllStatus> {
  return { kind: "clear" };
}

export function stopsRuns(_status: StopAllStatus): boolean {
  return false;
}

export function holdsGate(_status: StopAllStatus): boolean {
  return false;
}

export function unlessStopped<T>(
  _status: StopAllStatus,
  _decide: () => readonly T[],
): readonly T[] {
  return [];
}

export function buildStopAllState(_input: {
  readonly reason: string;
  readonly actor: string;
  readonly now: Date;
}): StopAllBuild {
  return { ok: false, problem: "invalid_reason" };
}

export function serializeStopAll(_state: StopAllState): string {
  return "";
}

export function schedulesToStop(
  _schedules: readonly { readonly path: string }[],
): string[] {
  return [];
}

export function schedulesToRestart(
  _schedules: readonly { readonly path: string; readonly enabled: boolean }[],
  _frozen: ReadonlySet<string>,
): { readonly enable: string[]; readonly skip: string[] } {
  return { enable: [], skip: [] };
}

export function sdkStopAllReadIo(): StopAllReadIo {
  return { readVariable: async () => null };
}
