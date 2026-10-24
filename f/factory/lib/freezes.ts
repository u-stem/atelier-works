// スケジュールの凍結の純粋関数群。I/Oは持たない。
// 状態の読み書きは`./freeze_apply.ts`、人の端末のCLIは`scripts/freeze.ts`が行う。
//
// 凍結は「このスケジュールを`wmill sync push`で書き換えないで」を、期限つきで伝える。
// 同じ変数は、反映全体(push、migration、`deployed_sha`の更新)を待たせるdeployの保留も持つ。
// 止めるためだけに使い、凍結や保留があることが何かを許可することはない。
// 状態はsyncから外したWindmillの変数`f/factory/freezes`(JSON)に置く。
// deployの保留は別の配列`deploy_freezes`に置く。読み手は知らない最上位のキーを無視するので、
// この配列を知らない版の読み手と書き手が、スケジュールの凍結を従来どおり扱える。

export const FREEZE_VARIABLE_PATH = "f/factory/freezes";

/** 1件の凍結の期限の上限(置いた時刻から)。 */
export const FREEZE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * deployの保留を置くときの期限の上限。読み手の上限(`FREEZE_MAX_TTL_MS`)は変えない。
 * 手で書いた行が変数全体を壊さないよう、読み手は緩く、書き手は厳しくする。
 */
export const DEPLOY_FREEZE_MAX_TTL_MS = 120 * 60 * 1000;

/** 変数に持つ行の上限(2つの配列の合計)。置くときだけ検査する。 */
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
/** 制御文字に加え、表示の並びを偽装できる書式文字(双方向制御など)と行・段落の区切りを含める。 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_CHARS_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `placeFreeze`がidの衝突で返す理由。呼び出し側がidを作り直す判定に使う。 */
export const FREEZE_ID_IN_USE = "the freeze id is already in use";
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

/** deployの保留の行。対象は常に反映全体なので`target`を持たない。 */
export type DeployFreezeEntry = Omit<FreezeEntry, "target">;

export type FreezeState = {
  readonly version: 1;
  readonly freezes: readonly FreezeEntry[];
  readonly deploy_freezes: readonly DeployFreezeEntry[];
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
  return { version: 1, freezes: [], deploy_freezes: [] };
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

/** `target`以外の欄を、形と値の範囲を確かめて取り出す。 */
function parseDeployEntry(value: unknown): Outcome<DeployFreezeEntry> {
  if (!isRecord(value)) return fail("an entry is not an object");
  const { id, reason, holder_kind, holder } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return fail("an entry has a malformed id");
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
    reason,
    holder_kind,
    holder,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expires).toISOString(),
    released_at: releasedAt,
  });
}

/** スケジュールの凍結の行の1件を、形と値の範囲を確かめて取り出す。 */
function parseEntry(value: unknown): Outcome<FreezeEntry> {
  const base = parseDeployEntry(value);
  if (!base.ok) return base;
  const target = isRecord(value) ? value.target : undefined;
  if (typeof target !== "string" || !TARGET_PATTERN.test(target)) {
    return fail(`freeze ${base.value.id} has a malformed target`);
  }
  const { id, reason, holder_kind, holder, ...times } = base.value;
  // 書き出したJSONの欄の順を保つ(`target`は`id`の次)。
  return ok({ id, target, reason, holder_kind, holder, ...times });
}

/** 作成の時刻が現在より先でもよい幅。時計のずれを許す。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * 現在時刻に照らして、ありえない行なら理由を返す。
 * 作成が未来の行や、期限が遠い先の行は、手で書いた行か書き手の誤りで、有効な期間を延ばせてしまう。
 */
function impossibleTime(entry: DeployFreezeEntry, now: Date): string | null {
  if (Date.parse(entry.created_at) > now.getTime() + CLOCK_SKEW_MS) {
    return `freeze ${entry.id} was created in the future`;
  }
  if (Date.parse(entry.expires_at) - now.getTime() > FREEZE_MAX_TTL_MS) {
    return `freeze ${entry.id} expires too far ahead`;
  }
  return null;
}

/**
 * 変数の値を状態に変える。`null`は変数が無いと確かめられたときで、空の状態として扱う。
 * 構造が崩れていれば失敗にする(呼び出し側は反映しない)。知らないキーは無視する。
 * `deploy_freezes`が無ければ空として読む。idは2つの配列をまたいで一意でなければならない。
 * `now`を渡すと、作成が5分より先の行と、期限が24時間より先の行を失敗にする。
 */
export function parseFreezeState(
  text: string | null,
  now?: Date,
): Outcome<FreezeState> {
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
  const rawDeploy: unknown =
    parsed.deploy_freezes === undefined ? [] : parsed.deploy_freezes;
  if (!Array.isArray(rawDeploy)) {
    return fail("the freeze variable has a malformed deploy_freezes");
  }
  const freezes: FreezeEntry[] = [];
  const deploy: DeployFreezeEntry[] = [];
  const ids = new Set<string>();
  for (const raw of parsed.freezes) {
    const entry = parseEntry(raw);
    if (!entry.ok) return fail(entry.reason);
    const bad = now === undefined ? null : impossibleTime(entry.value, now);
    if (bad !== null) return fail(bad);
    if (ids.has(entry.value.id)) return fail("duplicate freeze id");
    ids.add(entry.value.id);
    freezes.push(entry.value);
  }
  for (const raw of rawDeploy) {
    const entry = parseDeployEntry(raw);
    if (!entry.ok) return fail(entry.reason);
    const bad = now === undefined ? null : impossibleTime(entry.value, now);
    if (bad !== null) return fail(bad);
    if (ids.has(entry.value.id)) return fail("duplicate freeze id");
    ids.add(entry.value.id);
    deploy.push(entry.value);
  }
  return ok({ version: 1, freezes, deploy_freezes: deploy });
}

/**
 * 状態を変数の値にする。deployの保留が無いときは`deploy_freezes`のキーを出さない。
 * キーを知らない版の読み手と、従来の形の変数を、そのまま保つためである。
 */
export function serializeFreezeState(state: FreezeState): string {
  const { deploy_freezes: deploy, ...schedule } = state;
  return JSON.stringify(deploy.length === 0 ? schedule : state);
}

// ---------------------------------------------------------------------------
// 有効の判定
// ---------------------------------------------------------------------------

/** 期限が来ておらず、解除されていない。期限切れは書き込みに頼らず、時刻で無効と数える。 */
export function isActive(
  entry: Pick<DeployFreezeEntry, "expires_at" | "released_at">,
  now: Date,
): boolean {
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

/** 有効なdeployの保留。 */
export function activeDeployFreezes(
  state: FreezeState,
  now: Date,
): readonly DeployFreezeEntry[] {
  return state.deploy_freezes.filter((entry) => isActive(entry, now));
}

export type ActiveFreezeCounts = {
  readonly schedule: number;
  readonly deploy: number;
};

/** 有効なスケジュールの凍結とdeployの保留の件数。`hold:list`が表示に使う。 */
export function countActiveFreezes(
  state: FreezeState,
  now: Date,
): ActiveFreezeCounts {
  return {
    schedule: activeFreezes(state, now).length,
    deploy: activeDeployFreezes(state, now).length,
  };
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

export type DeployPlaceInput = {
  readonly id: string;
  readonly minutes: number;
  readonly reason: string;
  readonly holder_kind: FreezeHolderKind;
  readonly holder: string;
};

/** 終わってからこの時間が過ぎた行は、追従の機会を過ぎたものとして、置くときに捨てる。 */
const STALE_ENDED_MS = FREEZE_MAX_TTL_MS;

function endedWithin(
  entry: Pick<DeployFreezeEntry, "expires_at" | "released_at">,
  now: Date,
): boolean {
  const released =
    entry.released_at === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(entry.released_at);
  const ended = Math.min(Date.parse(entry.expires_at), released);
  return now.getTime() - ended <= STALE_ENDED_MS;
}

function idInUse(state: FreezeState, id: string): boolean {
  return (
    state.freezes.some((e) => e.id === id) ||
    state.deploy_freezes.some((e) => e.id === id)
  );
}

/** 有効な行と、終わってから間もない行だけを残す。 */
function sweep<T extends Pick<DeployFreezeEntry, "expires_at" | "released_at">>(
  rows: readonly T[],
  now: Date,
): T[] {
  return rows.filter((e) => isActive(e, now) || endedWithin(e, now));
}

function validMinutes(minutes: number, limitMs: number): boolean {
  return (
    Number.isInteger(minutes) && minutes >= 1 && minutes * 60_000 <= limitMs
  );
}

/**
 * 凍結を足した状態を返す。`known`は実在する`*.schedule.yaml`のパス(拡張子なし)。
 * 期限は呼び出し側の時刻でなく、分と`now`から作る。
 * idの衝突と行数の上限は、deployの保留も含めて数える。
 */
export function placeFreeze(
  state: FreezeState,
  input: PlaceInput,
  known: ReadonlySet<string>,
  now: Date,
): Outcome<FreezeState> {
  if (!validMinutes(input.minutes, FREEZE_MAX_TTL_MS)) {
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
  if (idInUse(state, input.id)) {
    return fail(FREEZE_ID_IN_USE);
  }
  if (activeFreezes(state, now).some((e) => e.target === input.target)) {
    return fail("the target already has an active freeze");
  }
  const kept = sweep(state.freezes, now);
  const keptDeploy = sweep(state.deploy_freezes, now);
  if (kept.length + keptDeploy.length >= FREEZE_MAX_ENTRIES) {
    return fail("too many freezes");
  }
  return ok({
    version: 1,
    freezes: [...kept, entry.value],
    deploy_freezes: keptDeploy,
  });
}

/**
 * deployの保留を足した状態を返す。期限は分と`now`から作り、120分を超えられない。
 * 同じ主体(`holder_kind`と`holder`)の有効な保留は1件までで、別の主体は重ねられる。
 * idの衝突と行数の上限は、スケジュールの凍結も含めて数える。
 */
export function placeDeployFreeze(
  state: FreezeState,
  input: DeployPlaceInput,
  now: Date,
): Outcome<FreezeState> {
  if (!validMinutes(input.minutes, DEPLOY_FREEZE_MAX_TTL_MS)) {
    return fail(
      `minutes must be an integer between 1 and ${DEPLOY_FREEZE_MAX_TTL_MS / 60_000}`,
    );
  }
  const entry = parseDeployEntry({
    id: input.id,
    reason: input.reason,
    holder_kind: input.holder_kind,
    holder: input.holder,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + input.minutes * 60_000).toISOString(),
    released_at: null,
  });
  if (!entry.ok) return fail(entry.reason);
  if (idInUse(state, input.id)) return fail(FREEZE_ID_IN_USE);
  if (
    activeDeployFreezes(state, now).some(
      (e) => e.holder_kind === input.holder_kind && e.holder === input.holder,
    )
  ) {
    return fail("the holder already has an active deploy freeze");
  }
  const kept = sweep(state.freezes, now);
  const keptDeploy = sweep(state.deploy_freezes, now);
  if (kept.length + keptDeploy.length >= FREEZE_MAX_ENTRIES) {
    return fail("too many freezes");
  }
  return ok({
    version: 1,
    freezes: kept,
    deploy_freezes: [...keptDeploy, entry.value],
  });
}

export type FreezeActor = {
  readonly kind: FreezeHolderKind;
  readonly holder: string;
};

/**
 * 有効な凍結かdeployの保留を解除した状態を返す。`session`は自分の`holder`の行だけ解除できる。
 * 持ち主を問わない解除は`human`(端末での確認は呼び出し側が行う)に限る。
 */
export function releaseFreeze(
  state: FreezeState,
  id: string,
  actor: FreezeActor,
  now: Date,
): Outcome<FreezeState> {
  const target =
    state.freezes.find((entry) => entry.id === id) ??
    state.deploy_freezes.find((entry) => entry.id === id);
  if (target === undefined) return fail("no freeze has that id");
  if (!isActive(target, now)) return fail("the freeze is no longer active");
  if (actor.kind === "session" && target.holder !== actor.holder) {
    return fail("a session can release only its own freeze");
  }
  const release = <T extends DeployFreezeEntry>(entry: T): T =>
    entry.id === id ? { ...entry, released_at: now.toISOString() } : entry;
  return ok({
    version: 1,
    freezes: state.freezes.map(release),
    deploy_freezes: state.deploy_freezes.map(release),
  });
}

/** 追従が済んだスケジュールの凍結の行を消す。deployの保留には触れない。 */
export function removeFreezes(
  state: FreezeState,
  ids: readonly string[],
): FreezeState {
  return {
    ...state,
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
