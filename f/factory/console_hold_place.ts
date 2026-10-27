// Consoleから、マージの保留、deployの保留、scheduleの凍結を1件置くscript。
//
// 置く主体は人(`human`)に固定し、引数から受けない。操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。
// 導けないときは何も置かずに断る。置いた主体の名前は保留の行に書けないので、操作者は操作の記録に残す。
// 期限は分で受け、置いた時刻からの上限を超えられない(マージの保留とscheduleの凍結は24時間、deployの保留は120分)。
// 理由は必須で、1文字以上200文字以下、制御文字を含めない。理由は保留の行にだけ置き、操作の記録には長さだけを入れる。
// 別の主体が置いた有効な同種の行があるときは置かない。同じ人が置いた有効な行があるときも、重ねて置かない。
// scheduleの凍結は、リポジトリが定義するscheduleのうち`self_update`以外に置ける。凍結はscheduleを止めない。
// 止める操作は別のscriptが行う。
//
// 操作の記録(`factory.console_actions`)は、置く前に`attempted`の行を入れ、後で結果を更新する。
// 行を入れられなければ、置かずに断る。更新に失敗しても置いた結果は戻さず、`action_audit`を`failed`にする。
// 置いた後に読み直し、置いた行が見えなければ、戻りの`verified`を偽にし、記録の結果を`partial`にする。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。
// 凍結の変数のパスはリテラルで、書くときに秘密の変数として作らない。走査が固定する。
// 保留の表は、保留のモジュールの関数だけが書く。

import * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { REPO_SCHEDULES } from "./lib/console_known_paths.ts";
import type * as Freezes from "./lib/freezes.ts";
import {
  activeDeployFreezes,
  activeFreezes,
  type DeployFreezeEntry,
  emptyFreezeState,
  FREEZE_ID_IN_USE,
  type FreezeEntry,
  type FreezeIo,
  type FreezeState,
  mutateFreezeStateVia,
  placeDeployFreeze,
  placeFreeze,
  readFreezeStateVia,
} from "./lib/freezes.ts";
import {
  HOLD_ALREADY_ACTIVE,
  type HoldReadOutcome,
  type HoldRow,
  listActiveHolds,
  type Outcome,
  placeHold,
  type RawPlaceInput,
  validatePlaceInput,
} from "./lib/holds.ts";

export const PLACE_KINDS = ["merge", "deploy", "freeze"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** 断る理由。画面は日本語の固定文に直す。 */
export const PLACE_REFUSAL_REASONS = [
  "invalid_kind",
  "invalid_target",
  "invalid_minutes",
  "invalid_reason",
  "target_not_allowed",
  "already_active",
  "other_holder_active",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type PlaceRefusalReason = (typeof PLACE_REFUSAL_REASONS)[number];

export type PlaceResult =
  | { readonly refused: true; readonly reason: PlaceRefusalReason }
  | {
      readonly refused: false;
      readonly kind: PlaceKind;
      /** 保留は数字、凍結とdeployの保留は8桁の16進。どちらも文字列で返す。 */
      readonly id: string;
      readonly target: string;
      readonly created_at: string;
      readonly expires_at: string;
      /** 置いた後に読み直して、置いた行が見えたか。 */
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

/** `placeFromConsole`が使う外部の操作。テストでは差し替える。 */
export type PlacePorts = {
  readonly now: () => Date;
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  /** `target`(小文字にそろえたowner/repo)の、有効なマージの保留。 */
  readonly listActiveHolds: (
    target: string,
  ) => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  readonly placeHold: (
    input: RawPlaceInput,
  ) => Promise<Outcome<{ readonly id: number }>>;
  readonly freeze: FreezeIo;
  readonly newFreezeId: () => string;
  readonly sql: ActionSqlClient;
};

const HUMAN = { holder_kind: "human", holder: "human" } as const;
const FREEZE_ID_ATTEMPTS = 5;
const MINUTE_MS = 60_000;

const KNOWN_SCHEDULES: ReadonlySet<string> = new Set(
  REPO_SCHEDULES.map((schedule) => schedule.path),
);

/** 検査を通った入力。`target`は、マージの保留では小文字にそろえ、deployの保留では空。 */
type Checked = {
  readonly kind: PlaceKind;
  readonly target: string;
  readonly minutes: number;
  readonly reason: string;
};

function isPlaceKind(value: unknown): value is PlaceKind {
  return PLACE_KINDS.some((kind) => kind === value);
}

function refused(reason: PlaceRefusalReason): PlaceResult {
  return { refused: true, reason };
}

type Check =
  | { readonly ok: true; readonly value: Checked }
  | { readonly ok: false; readonly reason: PlaceRefusalReason };

function failWith(reason: PlaceRefusalReason): Check {
  return { ok: false, reason };
}

/** 保留のモジュールが返す検査の失敗を、断る理由にする。 */
function holdProblem(text: string): PlaceRefusalReason {
  if (text.startsWith("target")) return "invalid_target";
  if (text.startsWith("reason")) return "invalid_reason";
  if (text.startsWith("minutes")) return "invalid_minutes";
  throw new Error(`unexpected validation failure: ${text}`);
}

/** 凍結の置き方が返す検査の失敗を、断る理由にする。 */
function freezeProblem(text: string): PlaceRefusalReason {
  if (text.startsWith("minutes")) return "invalid_minutes";
  if (text.includes("invalid reason")) return "invalid_reason";
  if (
    text.includes("cannot be frozen") ||
    text.includes("has no *.schedule.yaml")
  ) {
    return "target_not_allowed";
  }
  throw new Error(`unexpected validation failure: ${text}`);
}

/**
 * 入力を検査する。外部を読まず、何も書かない。
 * 凍結とdeployの保留の検査は、空の状態に置いてみて、置き方の検査をそのまま使う。
 */
function checkInput(
  kind: unknown,
  target: unknown,
  minutes: unknown,
  reason: unknown,
  now: Date,
): Check {
  if (!isPlaceKind(kind)) return failWith("invalid_kind");
  if (typeof target !== "string") return failWith("invalid_target");
  if (typeof reason !== "string") return failWith("invalid_reason");
  if (typeof minutes !== "number") return failWith("invalid_minutes");
  if (kind === "merge") {
    const checked = validatePlaceInput({
      scope: "merge",
      target,
      reason,
      ...HUMAN,
      minutes,
    });
    return checked.ok
      ? {
          ok: true,
          value: {
            kind,
            target: checked.value.target,
            minutes,
            reason,
          },
        }
      : failWith(holdProblem(checked.reason));
  }
  if (kind === "deploy") {
    if (target !== "") return failWith("invalid_target");
    const checked = placeDeployFreeze(
      emptyFreezeState(),
      { id: "00000000", minutes, reason, ...HUMAN },
      now,
    );
    return checked.ok
      ? { ok: true, value: { kind, target, minutes, reason } }
      : failWith(freezeProblem(checked.reason));
  }
  const checked = placeFreeze(
    emptyFreezeState(),
    { id: "00000000", target, minutes, reason, ...HUMAN },
    KNOWN_SCHEDULES,
    now,
  );
  return checked.ok
    ? { ok: true, value: { kind, target, minutes, reason } }
    : failWith(freezeProblem(checked.reason));
}

/** 操作の中身が返す値。断りは、記録した後の判定(別の主体の行、すでに有効な行)で出る。 */
type Placed =
  | { readonly kind: "refused"; readonly reason: PlaceRefusalReason }
  | {
      readonly kind: "placed";
      readonly id: string;
      readonly created_at: string;
      readonly expires_at: string;
      readonly verified: boolean;
    };

function failedOperation(
  reason: PlaceRefusalReason,
): RecordedOperation<Placed> {
  return {
    outcome: "failed",
    changes: { refusal: reason },
    value: { kind: "refused", reason },
  };
}

function placedOperation(
  placed: Extract<Placed, { kind: "placed" }>,
  id: string | number,
): RecordedOperation<Placed> {
  return {
    outcome: placed.verified ? "succeeded" : "partial",
    changes: { placed_id: id, verified: placed.verified },
    value: placed,
  };
}

/** 置いた時刻と期限。読み直せなかったときの代わりに、置いた時刻と分から求める。 */
function windowOf(now: Date, minutes: number) {
  return {
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + minutes * MINUTE_MS).toISOString(),
  };
}

async function placeMerge(
  input: Checked,
  ports: PlacePorts,
): Promise<RecordedOperation<Placed>> {
  const before = await ports.listActiveHolds(input.target);
  if (!before.ok) {
    throw new Error(`could not read the holds: ${before.reason}`);
  }
  if (before.value.some((row) => row.holder !== HUMAN.holder)) {
    return failedOperation("other_holder_active");
  }
  if (before.value.length > 0) return failedOperation("already_active");

  const placed = await ports.placeHold({
    scope: "merge",
    target: input.target,
    reason: input.reason,
    ...HUMAN,
    minutes: input.minutes,
  });
  if (!placed.ok) {
    if (placed.reason === HOLD_ALREADY_ACTIVE) {
      return failedOperation("already_active");
    }
    throw new Error(`hold place: ${placed.reason}`);
  }

  const after = await ports.listActiveHolds(input.target);
  const row = after.ok
    ? after.value.find((candidate) => candidate.id === placed.value.id)
    : undefined;
  return placedOperation(
    {
      kind: "placed",
      id: String(placed.value.id),
      ...(row === undefined
        ? windowOf(ports.now(), input.minutes)
        : { created_at: row.created_at, expires_at: row.expires_at }),
      verified: row !== undefined,
    },
    placed.value.id,
  );
}

/** 凍結かdeployの保留の行。`target`は凍結だけが持つ。 */
type Written = FreezeEntry | DeployFreezeEntry;

/**
 * 空いているidを選んで、操作を当てて書く。idの衝突は選び直す。
 * 断りは`observed`に残す。書けなかった理由が衝突でも断りでもなければ投げる。
 */
async function writeWithFreshId(
  ports: PlacePorts,
  observed: { refusal: PlaceRefusalReason | null },
  operation: (
    id: string,
  ) => (state: FreezeState, now: Date) => Freezes.Outcome<FreezeState>,
): Promise<string | null> {
  for (let attempt = 0; attempt < FREEZE_ID_ATTEMPTS; attempt += 1) {
    const id = ports.newFreezeId();
    const written = await mutateFreezeStateVia(ports.freeze, operation(id));
    if (written.ok) return id;
    if (observed.refusal !== null) return null;
    if (written.reason !== FREEZE_ID_IN_USE) {
      throw new Error(`freeze place: ${written.reason}`);
    }
  }
  throw new Error("freeze place: could not pick an unused freeze id");
}

/** 書いた後に読み直して、置いた行を探す。読めないときや見つからないときは`undefined`。 */
async function readPlaced(
  ports: PlacePorts,
  id: string,
  rowsOf: (state: FreezeState, now: Date) => readonly Written[],
): Promise<Written | undefined> {
  const state = await readFreezeStateVia(ports.freeze);
  if (!state.ok) return undefined;
  return rowsOf(state.value, ports.now()).find((row) => row.id === id);
}

async function placeFreezeRow(
  input: Checked,
  ports: PlacePorts,
): Promise<RecordedOperation<Placed>> {
  const observed: { refusal: PlaceRefusalReason | null } = { refusal: null };
  const id = await writeWithFreshId(
    ports,
    observed,
    (freshId) => (state, now) => {
      const existing = activeFreezes(state, now).filter(
        (entry) => entry.target === input.target,
      );
      if (existing.length > 0) {
        observed.refusal = existing.some(
          (entry) => entry.holder_kind !== HUMAN.holder_kind,
        )
          ? "other_holder_active"
          : "already_active";
        return { ok: false, reason: "refused" };
      }
      return placeFreeze(
        state,
        {
          id: freshId,
          target: input.target,
          minutes: input.minutes,
          reason: input.reason,
          ...HUMAN,
        },
        KNOWN_SCHEDULES,
        now,
      );
    },
  );
  if (id === null) {
    return failedOperation(observed.refusal ?? "already_active");
  }
  const row = await readPlaced(ports, id, activeFreezes);
  return placedOperation(
    {
      kind: "placed",
      id,
      ...(row === undefined
        ? windowOf(ports.now(), input.minutes)
        : { created_at: row.created_at, expires_at: row.expires_at }),
      verified: row !== undefined,
    },
    id,
  );
}

async function placeDeployRow(
  input: Checked,
  ports: PlacePorts,
): Promise<RecordedOperation<Placed>> {
  const observed: { refusal: PlaceRefusalReason | null } = { refusal: null };
  const id = await writeWithFreshId(
    ports,
    observed,
    (freshId) => (state, now) => {
      const existing = activeDeployFreezes(state, now);
      if (existing.length > 0) {
        observed.refusal = existing.some(
          (entry) => entry.holder_kind !== HUMAN.holder_kind,
        )
          ? "other_holder_active"
          : "already_active";
        return { ok: false, reason: "refused" };
      }
      return placeDeployFreeze(
        state,
        {
          id: freshId,
          minutes: input.minutes,
          reason: input.reason,
          ...HUMAN,
        },
        now,
      );
    },
  );
  if (id === null) {
    return failedOperation(observed.refusal ?? "already_active");
  }
  const row = await readPlaced(ports, id, activeDeployFreezes);
  return placedOperation(
    {
      kind: "placed",
      id,
      ...(row === undefined
        ? windowOf(ports.now(), input.minutes)
        : { created_at: row.created_at, expires_at: row.expires_at }),
      verified: row !== undefined,
    },
    id,
  );
}

const ACTION_NAMES: Readonly<Record<PlaceKind, string>> = {
  merge: "hold_place",
  deploy: "deploy_hold_place",
  freeze: "freeze_place",
};

/** 操作の記録の対象。`target`の欄は空白を含められないので、種類を前置きした識別子にする。 */
function recordTarget(input: Checked): string {
  switch (input.kind) {
    case "merge":
      return `merge:${input.target}`;
    case "deploy":
      return "deploy:all";
    case "freeze":
      return `schedule:${input.target}`;
  }
}

/**
 * 保留か凍結を1件置く。呼び出しの順序は、入力の検査、操作者の導出、記録(`attempted`)、
 * 別の主体の行の確認、書き込み、読み直し、記録(結果)に固定する。
 * 検査を通らない入力は、何も読まず、書かず、記録もせずに断る。
 * 読み取りと書き込みの失敗は、記録を`failed`にしてから投げる。
 */
export async function placeFromConsole(
  kind: unknown,
  target: unknown,
  minutes: unknown,
  reason: unknown,
  ports: PlacePorts,
): Promise<PlaceResult> {
  const checked = checkInput(kind, target, minutes, reason, ports.now());
  if (!checked.ok) return refused(checked.reason);
  const input = checked.value;

  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return refused("actor_unknown");
  }

  const recorded = await runRecordedAs(
    () => actor,
    {
      action: ACTION_NAMES[input.kind],
      target: recordTarget(input),
      changes: { minutes: input.minutes, reason_length: input.reason.length },
    },
    async (): Promise<RecordedOperation<Placed>> => {
      switch (input.kind) {
        case "merge":
          return await placeMerge(input, ports);
        case "deploy":
          return await placeDeployRow(input, ports);
        case "freeze":
          return await placeFreezeRow(input, ports);
      }
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) return refused("audit_unavailable");
  if (recorded.value.kind === "refused") {
    return refused(recorded.value.reason);
  }
  return {
    refused: false,
    kind: input.kind,
    id: recorded.value.id,
    target: input.target,
    created_at: recorded.value.created_at,
    expires_at: recorded.value.expires_at,
    verified: recorded.value.verified,
    action_audit: recorded.audit,
  };
}

function sdkPorts(): PlacePorts {
  const sql = actionSqlClientFrom(() => wmill.datatable());
  return {
    now: () => new Date(),
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    listActiveHolds: (target) =>
      listActiveHolds({ scope: "merge", target }, sql),
    placeHold: (input) => placeHold(input, sql),
    freeze: {
      now: () => new Date(),
      readVariable: () => wmill.getVariable("f/factory/freezes"),
      storeVariable: (text) =>
        wmill.setVariable(
          "f/factory/freezes",
          text,
          false,
          "スケジュールの凍結の状態です。mise run freeze:placeなどが書くため、通常は人が編集する必要はありません。",
        ),
    },
    newFreezeId: () => crypto.randomUUID().replaceAll("-", "").slice(0, 8),
    sql,
  };
}

/** Consoleから、保留か凍結を1件置く。置く主体は人に固定し、操作者はジョブの実行文脈から導く。 */
export async function main(
  kind: string,
  target: string,
  minutes: number,
  reason: string,
): Promise<PlaceResult> {
  return await placeFromConsole(kind, target, minutes, reason, sdkPorts());
}
