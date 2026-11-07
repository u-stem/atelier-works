export type RestoreRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export type RestoreWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type RestoreStore = {
  readonly readStopAll: () => Promise<RestoreRead<string | null>>;
  readonly readRecord: () => Promise<RestoreRead<string | null>>;
  readonly readConfig: () => Promise<RestoreRead<unknown>>;
  readonly writeConfig: (
    value: Record<string, unknown>,
  ) => Promise<RestoreWrite>;
  readonly clearRecord: () => Promise<RestoreWrite>;
};

export type RestoreIo = RestoreStore & {
  readonly now: () => Date;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly print: (line: string) => void;
};

export type RestoreSkipReason =
  | "already_on"
  | "missing"
  | "not_boolean"
  | "invalid_combination"
  | "excepted";

export type RestorePlan = {
  readonly next: Record<string, unknown>;
  readonly restore: readonly string[];
  readonly since: readonly string[];
  readonly skip: readonly {
    readonly name: string;
    readonly reason: RestoreSkipReason;
  }[];
};

export type ExceptParse =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function parseExceptNames(_text: string): ExceptParse {
  return { ok: true, names: [] };
}

export function planRestore(input: {
  readonly config: Record<string, unknown>;
  readonly recorded: readonly string[];
  readonly except: readonly string[];
  readonly now: Date;
}): RestorePlan {
  return { next: input.config, restore: [], since: [], skip: [] };
}

export async function runRestore(
  _except: readonly string[],
  _io: RestoreIo,
): Promise<number> {
  return 0;
}
