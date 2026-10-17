// スケジュールの凍結の純粋関数群。I/Oは持たない。
// 状態の読み書きは`./freeze_apply.ts`、人の端末のCLIは`scripts/freeze.ts`が行う。
//
// 凍結は「このスケジュールを`wmill sync push`で書き換えないで」を、期限つきで伝える。
// 止めるためだけに使い、凍結があることが何かを許可することはない。
// 状態はsyncから外したWindmillの変数`f/factory/freezes`(JSON)に置く。

export const FREEZE_VARIABLE_PATH = "f/factory/freezes";

/** 1件の凍結の期限の上限(置いた時刻から)。 */
export const FREEZE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** 変数に持つ行の上限。 */
export const FREEZE_MAX_ENTRIES = 50;

/** 自己更新を担うスケジュール。凍結すると追従する本人が動かなくなるので置けない。 */
export const FREEZE_FORBIDDEN_TARGET = "f/factory/self_update";

/**
 * `wmill.yaml`の`excludes`に必ずある項目。`--excludes`は`wmill.yaml`の値を置き換えるので、
 * 和を作るときに落ちていないことを確かめ、欠けていれば反映しない。
 */
export const FREEZE_REQUIRED_EXCLUDES: readonly string[] = [
  "f/factory/factory_config.resource.yaml",
  "f/factory/deployed_sha.variable.yaml",
  "f/factory/freezes.variable.yaml",
];

const ID_PATTERN = /^[0-9a-f]{8}$/;
const TARGET_PATTERN = /^f\/[a-z0-9_]+(\/[a-z0-9_]+)*$/;
const CONTROL_CHARS = /\p{Cc}/u;
const CONTROL_CHARS_GLOBAL = /\p{Cc}/gu;
const REASON_MAX = 200;
const HOLDER_MAX = 100;

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

function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function fail<T>(reason: string): Outcome<T> {
  return { ok: false, reason };
}

export function emptyFreezeState(): FreezeState {
  return { version: 1, freezes: [] };
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHolderKind(value: unknown): value is FreezeHolderKind {
  return value === "session" || value === "human";
}

/** `new Date(text).toISOString()`と一致する形のときだけ、時刻を返す。 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString() === value ? time : null;
}

function validText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    !CONTROL_CHARS.test(value)
  );
}

/** 行の1件を、形と値の範囲を確かめて取り出す。 */
function parseEntry(value: unknown): Outcome<FreezeEntry> {
  if (!isRecord(value)) return fail("an entry is not an object");
  const { id, target, reason, holder_kind, holder } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return fail("an entry has a malformed id");
  }
  if (typeof target !== "string" || !TARGET_PATTERN.test(target)) {
    return fail(`freeze ${id} has a malformed target`);
  }
  if (!validText(reason, REASON_MAX)) {
    return fail(`freeze ${id} has an invalid reason`);
  }
  if (!isHolderKind(holder_kind)) {
    return fail(`freeze ${id} has an invalid holder_kind`);
  }
  if (!validText(holder, HOLDER_MAX)) {
    return fail(`freeze ${id} has an invalid holder`);
  }
  const created = parseTimestamp(value.created_at);
  const expires = parseTimestamp(value.expires_at);
  if (created === null || expires === null) {
    return fail(`freeze ${id} has an invalid timestamp`);
  }
  if (expires <= created || expires - created > FREEZE_MAX_TTL_MS) {
    return fail(`freeze ${id} has an expiry out of range`);
  }
  let releasedAt: string | null = null;
  const released = value.released_at;
  if (released !== null && released !== undefined) {
    if (typeof released !== "string" || parseTimestamp(released) === null) {
      return fail(`freeze ${id} has an invalid released_at`);
    }
    releasedAt = released;
  }
  return ok({
    id,
    target,
    reason,
    holder_kind,
    holder,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expires).toISOString(),
    released_at: releasedAt,
  });
}

/**
 * 変数の値を状態に変える。`null`は変数が無いと確かめられたときで、空の状態として扱う。
 * 構造が崩れていれば失敗にする(呼び出し側は反映しない)。知らないキーは無視する。
 */
export function parseFreezeState(text: string | null): Outcome<FreezeState> {
  if (text === null) return ok(emptyFreezeState());
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("the freeze variable is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    return fail("the freeze variable has an unsupported version");
  }
  if (!Array.isArray(parsed.freezes)) {
    return fail("the freeze variable has no freezes array");
  }
  const freezes: FreezeEntry[] = [];
  const ids = new Set<string>();
  for (const raw of parsed.freezes) {
    const entry = parseEntry(raw);
    if (!entry.ok) return fail(entry.reason);
    if (ids.has(entry.value.id)) return fail("duplicate freeze id");
    ids.add(entry.value.id);
    freezes.push(entry.value);
  }
  return ok({ version: 1, freezes });
}

export function serializeFreezeState(state: FreezeState): string {
  return JSON.stringify(state);
}

// ---------------------------------------------------------------------------
// 有効の判定
// ---------------------------------------------------------------------------

/** 期限が来ておらず、解除されていない。期限切れは書き込みに頼らず、時刻で無効と数える。 */
export function isActive(entry: FreezeEntry, now: Date): boolean {
  return (
    entry.released_at === null && Date.parse(entry.expires_at) > now.getTime()
  );
}

export function activeFreezes(
  state: FreezeState,
  now: Date,
): readonly FreezeEntry[] {
  return state.freezes.filter((entry) => isActive(entry, now));
}

/** 解除されたか期限が切れた行。除いて反映した設定を戻すpushの対象になる。 */
export function endedFreezes(
  state: FreezeState,
  now: Date,
): readonly FreezeEntry[] {
  return state.freezes.filter((entry) => !isActive(entry, now));
}

// ---------------------------------------------------------------------------
// 除外の和
// ---------------------------------------------------------------------------

/**
 * `wmill.yaml`の`excludes`の項目を取り出す。読み間違えると除外が落ちるので、
 * 読めない行があれば失敗にする。
 */
export function parseWmillExcludes(yamlText: string): Outcome<string[]> {
  const lines = yamlText.split("\n");
  const start = lines.findIndex((line) => /^excludes:\s*(#.*)?$/.test(line));
  if (start < 0) {
    return /^excludes:\s*\[\s*\]\s*(#.*)?$/m.test(yamlText)
      ? ok([])
      : fail("wmill.yaml has no excludes key");
  }
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const match = /^\s+-\s+(\S.*?)\s*$/.exec(line);
    const raw = match?.[1];
    if (raw === undefined) {
      return fail("wmill.yaml excludes has an unreadable line");
    }
    const quoted = /^"([^"\\]*)"$/.exec(raw);
    if (quoted?.[1] !== undefined) {
      items.push(quoted[1]);
    } else if (/^[^"'#:\s\\]+$/.test(raw)) {
      items.push(raw);
    } else {
      return fail("wmill.yaml excludes has an unreadable entry");
    }
  }
  return ok(items);
}

function validExcludePattern(pattern: string): boolean {
  return (
    pattern.length > 0 &&
    !pattern.includes(",") &&
    !pattern.includes("\n") &&
    !pattern.startsWith("-")
  );
}

/**
 * `wmill.yaml`の`excludes`と、凍結中のスケジュールのファイルの和を返す。
 * `wmill sync push --excludes`は`wmill.yaml`の値を置き換えるので、和を1つの値で渡す。
 */
export function buildExcludes(
  base: readonly string[],
  targets: readonly string[],
): Outcome<string[]> {
  for (const required of FREEZE_REQUIRED_EXCLUDES) {
    if (!base.includes(required)) {
      return fail(`wmill.yaml excludes is missing ${required}`);
    }
  }
  for (const pattern of base) {
    if (!validExcludePattern(pattern)) {
      return fail("wmill.yaml excludes has a pattern that cannot be passed");
    }
  }
  const files: string[] = [];
  for (const target of targets) {
    if (!TARGET_PATTERN.test(target)) {
      return fail("a freeze target is malformed");
    }
    const file = `${target}.schedule.yaml`;
    if (!base.includes(file) && !files.includes(file)) files.push(file);
  }
  return ok([...base, ...files]);
}

/** `wmill sync push`へ渡す、1要素の`--excludes=<値>`。 */
export function excludesArg(patterns: readonly string[]): string {
  return `--excludes=${patterns.join(",")}`;
}

// ---------------------------------------------------------------------------
// 状態の遷移
// ---------------------------------------------------------------------------

export type PlaceInput = {
  readonly id: string;
  readonly target: string;
  readonly minutes: number;
  readonly reason: string;
  readonly holder_kind: FreezeHolderKind;
  readonly holder: string;
};

/** 終わってからこの時間が過ぎた行は、追従の機会を過ぎたものとして、置くときに捨てる。 */
const STALE_ENDED_MS = FREEZE_MAX_TTL_MS;

function endedWithin(entry: FreezeEntry, now: Date): boolean {
  const released =
    entry.released_at === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(entry.released_at);
  const ended = Math.min(Date.parse(entry.expires_at), released);
  return now.getTime() - ended <= STALE_ENDED_MS;
}

/**
 * 凍結を足した状態を返す。`known`は実在する`*.schedule.yaml`のパス(拡張子なし)。
 * 期限は呼び出し側の時刻でなく、分と`now`から作る。
 */
export function placeFreeze(
  state: FreezeState,
  input: PlaceInput,
  known: ReadonlySet<string>,
  now: Date,
): Outcome<FreezeState> {
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < 1 ||
    input.minutes * 60_000 > FREEZE_MAX_TTL_MS
  ) {
    return fail(
      `minutes must be an integer between 1 and ${FREEZE_MAX_TTL_MS / 60_000}`,
    );
  }
  if (input.target === FREEZE_FORBIDDEN_TARGET) {
    return fail("the self_update schedule cannot be frozen");
  }
  if (!known.has(input.target)) {
    return fail("the target has no *.schedule.yaml in the repository");
  }
  const expires = new Date(
    now.getTime() + input.minutes * 60_000,
  ).toISOString();
  const entry = parseEntry({
    id: input.id,
    target: input.target,
    reason: input.reason,
    holder_kind: input.holder_kind,
    holder: input.holder,
    created_at: now.toISOString(),
    expires_at: expires,
    released_at: null,
  });
  if (!entry.ok) return fail(entry.reason);
  if (state.freezes.some((e) => e.id === input.id)) {
    return fail("the freeze id is already in use");
  }
  if (activeFreezes(state, now).some((e) => e.target === input.target)) {
    return fail("the target already has an active freeze");
  }
  const kept = state.freezes.filter(
    (e) => isActive(e, now) || endedWithin(e, now),
  );
  if (kept.length >= FREEZE_MAX_ENTRIES) {
    return fail("too many freezes");
  }
  return ok({ version: 1, freezes: [...kept, entry.value] });
}

export type FreezeActor = {
  readonly kind: FreezeHolderKind;
  readonly holder: string;
};

/**
 * 有効な凍結を解除した状態を返す。`session`は自分の`holder`の凍結だけ解除できる。
 * 持ち主を問わない解除は`human`(端末での確認は呼び出し側が行う)に限る。
 */
export function releaseFreeze(
  state: FreezeState,
  id: string,
  actor: FreezeActor,
  now: Date,
): Outcome<FreezeState> {
  const target = state.freezes.find((entry) => entry.id === id);
  if (target === undefined) return fail("no freeze has that id");
  if (!isActive(target, now)) return fail("the freeze is no longer active");
  if (actor.kind === "session" && target.holder !== actor.holder) {
    return fail("a session can release only its own freeze");
  }
  return ok({
    version: 1,
    freezes: state.freezes.map((entry) =>
      entry.id === id ? { ...entry, released_at: now.toISOString() } : entry,
    ),
  });
}

/** 追従が済んだ行を消す。 */
export function removeFreezes(
  state: FreezeState,
  ids: readonly string[],
): FreezeState {
  return {
    version: 1,
    freezes: state.freezes.filter((entry) => !ids.includes(entry.id)),
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

/** 信頼できない文字列を表示するときに、制御文字を空白にする。 */
export function sanitizeForDisplay(text: string): string {
  return text.replace(CONTROL_CHARS_GLOBAL, " ");
}

/** ブランチ名から`holder`を作る。detached HEADなどで空のときは`detached`にする。 */
export function sessionHolderFromBranch(branch: string): string {
  const cleaned = branch.trim().replace(/[^A-Za-z0-9._/-]/g, "-");
  const name = cleaned.length === 0 ? "detached" : cleaned;
  return `session:${name}`.slice(0, HOLDER_MAX);
}
