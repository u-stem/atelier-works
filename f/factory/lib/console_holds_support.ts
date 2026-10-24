// Consoleの保留と凍結の画面が使う、表示用の整形と解除の共通部品。
// 信頼できない文字列を無害化して切り詰め、読めない源の失敗を値で表し、解除の通知の文を作る。
// 保留のモジュールからは型だけを読み込み、凍結の変数は読むだけで書かない。

import { FREEZE_RECOVERY_HINT, type FreezePorts } from "./freeze_apply.ts";
import {
  activeDeployFreezes,
  activeFreezes,
  type DeployFreezeEntry,
  type FreezeEntry,
  type FreezeState,
  type Outcome,
  parseFreezeState,
  sanitizeForDisplay,
} from "./freezes.ts";
import type {
  HolderKind,
  HoldReadFailureKind,
  HoldReadOutcome,
  HoldRow,
  HoldScope,
} from "./holds.ts";
import type { NoticeRecord } from "./types.ts";

/** 画面に返す文字数の上限(コードポイント)。画面が同じ無害化をやり直すので、ここで先に落とす。 */
export const REASON_DISPLAY_MAX = 200;
export const HOLDER_DISPLAY_MAX = 100;
export const TARGET_DISPLAY_MAX = 200;
export const FAILURE_DISPLAY_MAX = 300;

export type HoldView = {
  readonly id: number;
  readonly scope: HoldScope;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: HolderKind;
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
};

export type FreezeView = {
  readonly id: string;
  readonly target: string;
  readonly reason: string;
  readonly holder_kind: "session" | "human";
  readonly holder: string;
  readonly created_at: string;
  readonly expires_at: string;
};

/** deployの保留の行。対象は常に反映全体なので`target`を持たない。 */
export type DeployFreezeView = Omit<FreezeView, "target">;

/** 保留の表の読み取り。失敗は「保留なし」と取り違えないよう、種類を保って返す。 */
export type HoldsReadView =
  | { readonly ok: true; readonly rows: readonly HoldView[] }
  | {
      readonly ok: false;
      readonly kind: HoldReadFailureKind;
      readonly reason: string;
    };

/** 凍結の変数の読み取り。 */
export type FreezesReadView =
  | {
      readonly ok: true;
      readonly schedule: readonly FreezeView[];
      readonly deploy: readonly DeployFreezeView[];
    }
  | { readonly ok: false; readonly reason: string };

export type HoldsSnapshot = {
  readonly holds: HoldsReadView;
  readonly freezes: FreezesReadView;
};

/** 解除の通知を残せたか。残せなくても解除は取り消さない。 */
export type ReleaseAudit = "recorded" | "failed";

/** 解除の通知の種類。 */
export const RELEASE_NOTICE_KIND = "hold_released";

/**
 * 解除の通知を残す。書けなくても解除は取り消さず、`failed`を返して警告に書く。
 * 警告には`reason`と`holder`を載せない。`script`は警告の接頭辞である。
 */
export async function recordRelease(
  script: string,
  message: string,
  deps: {
    readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
    readonly warn: (message: string, fields?: Record<string, unknown>) => void;
  },
): Promise<ReleaseAudit> {
  try {
    await deps.addNotice({ kind: RELEASE_NOTICE_KIND, message });
    return "recorded";
  } catch (err) {
    deps.warn(`${script}: could not record the release notice`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

/**
 * Consoleの解除が名乗る主体。
 * 操作者の名前は`released_by`に書けないため固定し、操作者は通知とジョブの記録に残す。
 */
export const HUMAN_RELEASER = { kind: "human", holder: "human" } as const;

/** 解除の通知に載せる操作者名の上限。 */
const OPERATOR_NAME_MAX = 100;

/**
 * 制御文字と書式文字を空白にし、`max`コードポイントで切る。
 * 保留の行は、DBに書ける主体が決める信頼できない文字列である。
 */
export function clipDisplay(text: string, max: number): string {
  return Array.from(sanitizeForDisplay(text)).slice(0, max).join("");
}

function holdView(row: HoldRow): HoldView {
  return {
    id: row.id,
    scope: row.scope,
    target: clipDisplay(row.target, TARGET_DISPLAY_MAX),
    reason: clipDisplay(row.reason, REASON_DISPLAY_MAX),
    holder_kind: row.holder_kind,
    holder: clipDisplay(row.holder, HOLDER_DISPLAY_MAX),
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** `listActiveHolds`の結果を画面の形にする。失敗は種類と理由を保つ。 */
export function holdsReadView(
  outcome: HoldReadOutcome<readonly HoldRow[]>,
): HoldsReadView {
  if (!outcome.ok) {
    return {
      ok: false,
      kind: outcome.kind,
      reason: clipDisplay(outcome.reason, FAILURE_DISPLAY_MAX),
    };
  }
  return { ok: true, rows: outcome.value.map(holdView) };
}

function deployFreezeView(entry: DeployFreezeEntry): DeployFreezeView {
  return {
    id: entry.id,
    reason: clipDisplay(entry.reason, REASON_DISPLAY_MAX),
    holder_kind: entry.holder_kind,
    holder: clipDisplay(entry.holder, HOLDER_DISPLAY_MAX),
    created_at: entry.created_at,
    expires_at: entry.expires_at,
  };
}

function freezeView(entry: FreezeEntry): FreezeView {
  const { id, ...rest } = deployFreezeView(entry);
  return {
    id,
    target: clipDisplay(entry.target, TARGET_DISPLAY_MAX),
    ...rest,
  };
}

/**
 * 凍結の状態を画面の形にする。有効な行(未解除で期限が来ていない行)だけを返す。
 * 作成時刻は見ない。時計のずれで読み取りが失敗する場合は、`state`の側が失敗になっている。
 */
export function freezesReadView(
  state: Outcome<FreezeState>,
  now: Date,
): FreezesReadView {
  if (!state.ok) {
    return {
      ok: false,
      reason: clipDisplay(state.reason, FAILURE_DISPLAY_MAX),
    };
  }
  return {
    ok: true,
    schedule: activeFreezes(state.value, now).map(freezeView),
    deploy: activeDeployFreezes(state.value, now).map(deployFreezeView),
  };
}

/**
 * 凍結の変数を読んで解析する。時刻の検査(未来の作成、遠い期限)も行う。
 * 読めない、壊れているときは、回復の手順を含む理由で失敗を返す。例外は投げない。
 */
export async function readFreezeState(
  ports: FreezePorts,
): Promise<Outcome<FreezeState>> {
  let raw: string | null;
  try {
    raw = await ports.readVariable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `could not read the freeze variable: ${message}`,
    };
  }
  const parsed = parseFreezeState(raw, ports.now());
  return parsed.ok
    ? parsed
    : { ok: false, reason: `${parsed.reason} (${FREEZE_RECOVERY_HINT})` };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `date`をJSTの`YYYY-MM-DD HH:mm:ss`にする(UTC+9固定、夏時間なし)。 */
function formatJstSecond(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/**
 * 解除の通知の本文。誰が、いつ、何を解除したかだけを書き、`reason`と`holder`は載せない。
 * 未解決の通知は`(kind, message)`で重複が弾かれるので、秒までの時刻を含めて別の解除を区別する。
 */
export function releaseNoticeMessage(
  subject: string,
  actor: string,
  now: Date,
): string {
  const operator = clipDisplay(actor, OPERATOR_NAME_MAX);
  return `${subject}を${operator}が解除しました。(${formatJstSecond(now)} JST)`;
}

/**
 * 解除の前に有効だったかを確認できなかったときの通知の本文。
 * 解除の操作は行ったが、有効な保留を外したとは言い切れないので、「解除しました」とは書かない。
 */
export function releaseUnverifiedNoticeMessage(
  subject: string,
  actor: string,
  now: Date,
): string {
  const operator = clipDisplay(actor, OPERATOR_NAME_MAX);
  return `${subject}の解除の操作を${operator}が行いました。解除の前に有効だったかは確認できませんでした。(${formatJstSecond(now)} JST)`;
}

/** 保留の行を指す句。対象は行を読めたときだけ載せる。 */
export function holdSubject(
  row: Pick<HoldRow, "id" | "scope" | "target"> | null,
  id: number,
): string {
  if (row === null) return `保留(id ${String(id)})`;
  const target = clipDisplay(row.target, TARGET_DISPLAY_MAX);
  return `保留(${row.scope}、対象 ${target}、id ${String(row.id)})`;
}

/** 凍結かdeployの保留を指す句。`target`が`null`のときはdeployの保留である。 */
export function freezeSubject(id: string, target: string | null): string {
  if (target === null) return `deployの保留(id ${id})`;
  return `凍結(スケジュール ${clipDisplay(target, TARGET_DISPLAY_MAX)}、id ${id})`;
}
