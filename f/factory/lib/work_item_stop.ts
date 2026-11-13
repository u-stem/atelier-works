// 人が中止した作業項目を、動いているClaudeと検査から見つけて止める部品。
// 動いているClaude(`claude.ts`)と検査(`check_runner.ts`)は、全停止の確認とは別に、この確認を15秒ごとに呼ぶ。
// 失敗した実行の処理(`on_error_flow.ts`)は、この判定で、人が止めた作業項目の失敗を記録も通知もせずに終わる。
//
// 止めるのは、状態が取り消し(`cancelled`)で、取り消しへ移った最新の遷移の注記が人の中止の固定文のときだけである。
// 照合による取り消しなど、ほかの理由の取り消しは止めない。
// 読めない、時間内に読み終わらない、行が無い、は止めない扱いにする。DBの一時的な障害で、動いているジョブを壊さないためである。
// 時間切れの後に返った「止める」は覚えて、次の確認で使う。人の中止は終端で戻らないので、古い答えで誤って止めることは無い。
// 読めなかったときは、確認ごとに最初の1回だけ、秘密を伏せた警告をジョブのログに残す。
//
// DBの接続は、`db.ts`を読み込まず、Console用workerの記録の部品と同じ薄い形で作る。
// 書き込みの部品を読み込む経路を、読み取りだけのscriptの依存に増やさないため、その部品は読み込まず、形だけを持つ。
// 読むのは作業項目の表と遷移の記録の表だけで、書き込みは行わない。
// 確認を呼ぶたびに、呼び出しの中で接続を作る。組み立てでは作らず、投げない。

import * as wmill from "windmill-client@1.817.0";
import { errorMessage, type Logger, logger } from "./log.ts";
import { isOperatorCancelledNote } from "./operator_cancel.ts";
import {
  DESIGN_FLOW_PATH,
  INVESTIGATE_FLOW_PATH,
  PIPELINE_FLOW_PATH,
} from "./pipeline_lease.ts";
import {
  boundedCheckFrom,
  NEVER_STOPPED,
  type StopCheck,
} from "./stop_check.ts";
import { isRecord } from "./types.ts";

/** `wmill.datatable()`が返すタグ付きテンプレートのうち、使う部分の形。 */
export type DatatableTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  fetch(): Promise<unknown>;
};

/** タグ付きテンプレートの読み取りの接続。戻りの行は、オブジェクトの配列として検査する。 */
export type StopSqlClient = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  fetch(): Promise<Record<string, unknown>[]>;
};

/**
 * `wmill.datatable()`を開く関数から、読み取りの接続を作る。
 * 文ごとに開き直す。戻りが行の配列でなければ、読めなかったものとして例外にする。
 */
export function stopSqlClientFrom(open: () => DatatableTag): StopSqlClient {
  return (strings, ...values) => {
    const statement = open()(strings, ...values);
    return {
      fetch: async () => {
        const rows = await statement.fetch();
        if (!Array.isArray(rows)) {
          throw new Error("work item stop: the sql client did not return rows");
        }
        return rows.map((row: unknown) => {
          if (!isRecord(row)) {
            throw new Error("work item stop: a row is not an object");
          }
          return row;
        });
      },
    };
  };
}

/** 作業項目の状態と、取り消しへ移った最新の遷移の注記。取り消されていなければ注記は`null`である。 */
export type WorkItemStopState = {
  readonly status: string;
  readonly note: string | null;
};

/** 作業項目の状態を読む入出力。行が無いときは`null`を返し、読めなければ例外を投げる。 */
export type WorkItemStopReadIo = {
  readonly readState: () => Promise<WorkItemStopState | null>;
};

/** 人が中止した作業項目か。状態が取り消しで、注記が人の中止の固定文のときだけ真になる。 */
export function isWorkItemStopped(state: WorkItemStopState | null): boolean {
  return (
    state !== null &&
    state.status === "cancelled" &&
    isOperatorCancelledNote(state.note)
  );
}

/**
 * 作業項目を読む入出力を、注入したSQLの接続から作る。
 * 状態と注記を1つの文で読み、読む表は作業項目の表と遷移の記録の表だけにする。
 * 注記の並びは、遷移の記録を引く`latestStatusEvent`と同じである。
 */
export function sdkWorkItemStopReadIo(
  workItemId: number,
  sql: StopSqlClient,
): WorkItemStopReadIo {
  return {
    readState: async () => {
      const rows = await sql`
        SELECT w.status AS status,
          (
            SELECT e.note FROM factory.work_item_events e
            WHERE e.work_item_id = w.id AND e.to_status = 'cancelled'
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
          ) AS note
        FROM factory.work_items w
        WHERE w.id = ${workItemId}::bigint
      `.fetch();
      const row = rows[0];
      if (row === undefined) return null;
      const { status, note } = row;
      if (typeof status !== "string") {
        throw new Error("work item stop: the status is not a string");
      }
      if (note !== null && typeof note !== "string") {
        throw new Error("work item stop: the note is not a string");
      }
      return { status, note };
    },
  };
}

/**
 * 作業項目の確認の読み取りを、1回ごとに待つ上限(ミリ秒)。
 * `wmill.datatable()`のSQLは、接続先がlocalhost以外のとき、Windmillのプレビューのジョブとして実行されうる。
 * 混んだworkerでは、そのジョブがキューで待つので、全停止の変数の読み取り(5秒)より遅れうる。
 * 短いと、中止が確認に届かない。長いと、確認の監視が1回の読み取りを待つ間、次の回が飛ぶ。
 * 10〜15秒の範囲で、キュー待ちを見込み、15秒の確認の間隔を超えない値にする。
 * 時間切れの後に返った真は、確認が覚える(`boundedCheckFrom`の`keepLateTrue`)ので、これを超えて遅れても、中止は次の確認で届く。
 */
export const WORK_ITEM_STOP_CHECK_TIMEOUT_MS = 12_000;

/**
 * 読み取りを包み、失敗したときは、確認ごとに最初の1回だけ警告を残して、止めない扱いにする。
 * 読めない状態が続いても、ログが埋まらず、止まらない理由はジョブのログから分かる。
 */
function readOrWarnOnce(
  read: () => Promise<boolean>,
  log: Logger,
): () => Promise<boolean> {
  let warned = false;
  return async () => {
    try {
      return await read();
    } catch (err) {
      if (!warned) {
        warned = true;
        log.warn(
          "work item stop: could not read the work item, so the run is not stopped",
          { error: errorMessage(err) },
        );
      }
      return false;
    }
  };
}

/**
 * 作業項目の停止の確認を作る。読み取りを`timeoutMs`で区切り、読めない、時間切れ、行が無いは、止めない扱いにする。
 * 時間切れの後に読み取りが真を返したときは、その真を覚える。人の中止は終端で戻らないので、古い真で誤って止めることは無い。
 * 全停止の確認とは別の確認なので、待ちの管理を共有しない。
 * 読めなかったときは、確認ごとに最初の1回だけ、秘密を伏せた警告を`log`に残す。
 */
export function workItemStopCheckFrom(
  io: WorkItemStopReadIo,
  timeoutMs: number = WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
  now: () => number = Date.now,
  log: Logger = logger("work_item_stop"),
): StopCheck {
  return boundedCheckFrom(
    readOrWarnOnce(async () => isWorkItemStopped(await io.readState()), log),
    timeoutMs,
    now,
    { keepLateTrue: true },
  );
}

/**
 * 既定の作業項目の停止の確認。
 * Windmillのジョブの中(`WM_WORKSPACE`がある)で、作業項目のIDが正の整数のときだけ読む。外なら常に止めない。
 * DBの接続は、確認を呼ぶたびに、呼び出しの中で作る。作れなかった呼び出しは、読めなかったことになる。
 * `open`はData Tableを開く関数で、テストで差し替える。
 */
export function defaultWorkItemStopCheck(
  workItemId: number,
  workspace: string | undefined = process.env.WM_WORKSPACE,
  open: () => DatatableTag = () => wmill.datatable(),
  log: Logger = logger("work_item_stop"),
): StopCheck {
  if (workspace === undefined || workspace === "") return NEVER_STOPPED;
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) {
    return NEVER_STOPPED;
  }
  return boundedCheckFrom(
    readOrWarnOnce(async () => {
      const io = sdkWorkItemStopReadIo(workItemId, stopSqlClientFrom(open));
      return isWorkItemStopped(await io.readState());
    }, log),
    WORK_ITEM_STOP_CHECK_TIMEOUT_MS,
    Date.now,
    { keepLateTrue: true },
  );
}

// ---------------------------------------------------------------------------
// 失敗の処理を静かにする判定
// ---------------------------------------------------------------------------

/** 取り消しへ移った遷移の注記の読み取りの結果。読めなかったときは`unreadable`にする。 */
export type NoteRead =
  | { readonly kind: "read"; readonly note: string | null }
  | { readonly kind: "unreadable" };

/**
 * 失敗した実行が、作業項目の行の実行であるときに真を返す。
 * `rowFlowJobId`は行に最後に記録したフローのジョブID、`rootJobId`は失敗した実行のルートジョブIDである。
 * どちらも分かるときは、一致するときだけ真になる。`rootJobId`は小文字にして比べる。起動側が小文字にした値を記録するためである。
 * どちらかが無いときは、食い違う根拠が無いので真にする。
 * ただしpipeline、設計、調査のフローは、2つが一致するときだけ真にする。
 * pipelineと設計の差し戻しは、IDを空にしてから起動するので、空の間に、記録されていない古い実行の失敗を、新しい実行のものと取り違えないためである。
 * 調査は、IDを記録していない行を、この実行のものと確かめられないためである。
 * 失敗を作業項目の失敗にしてよいかの判定(`shouldMarkFailed`)が使う。静かにする判定(`shouldSilenceFailure`)は、これより厳しい。
 */
export function flowRunMatchesRow(
  rowFlowJobId: string | null,
  rootJobId: string | null,
  flowPath: string | null,
): boolean {
  const root = rootJobId?.toLowerCase() ?? null;
  if (
    flowPath === PIPELINE_FLOW_PATH ||
    flowPath === DESIGN_FLOW_PATH ||
    flowPath === INVESTIGATE_FLOW_PATH
  ) {
    return rowFlowJobId !== null && rowFlowJobId === root;
  }
  if (rowFlowJobId === null || root === null) return true;
  return rowFlowJobId === root;
}

/** `shouldSilenceFailure`が受ける、失敗した実行と作業項目の生の値。 */
export type SilenceInput = {
  /** 作業項目の状態。 */
  readonly status: string;
  /** 取り消しへ移った最新の遷移の注記。 */
  readonly note: NoteRead;
  /** 行に最後に記録したフローのジョブID。 */
  readonly rowFlowJobId: string | null;
  /** 失敗した実行のルートジョブID。 */
  readonly rootJobId: string | null;
};

/**
 * 失敗した実行の記録も通知も出さずに終わるか。
 * 次の3つをすべて満たすときだけ真にする。
 * 1. 作業項目の状態が取り消しである。
 * 2. 注記を読めて、人の中止の固定文である。
 * 3. 行のジョブIDと失敗した実行のルートジョブIDが、どちらも分かり、一致する。
 *    ルートジョブIDは小文字にして比べる。
 * 注記を読めないとき、どちらかのジョブIDが分からないときは、偽にして、通知する側へ進む。
 * 分からないまま静かにすると、別の実行の失敗の通知を落とすためである。
 */
export function shouldSilenceFailure(input: SilenceInput): boolean {
  const root = input.rootJobId?.toLowerCase() ?? null;
  return (
    input.status === "cancelled" &&
    input.note.kind === "read" &&
    isOperatorCancelledNote(input.note.note) &&
    input.rowFlowJobId !== null &&
    root !== null &&
    input.rowFlowJobId === root
  );
}

/**
 * 失敗の処理が、記録も通知も出さずに終わるかを決める。注記の読み取りから判定までを、1つにまとめる。
 * 作業項目が取り消されていなければ、注記を読まずに偽を返す。
 * 注記を読めなかったときは、秘密を伏せた警告を残し、偽を返す。
 * `readCancelNote`は、作業項目が取り消しへ移った最新の遷移の注記を読む。
 */
export async function isFailureSilenced(
  item: {
    readonly id: number;
    readonly status: string;
    readonly flow_job_id: string | null;
  },
  rootJobId: string | null,
  readCancelNote: (id: number) => Promise<string | null>,
  log: Logger,
): Promise<boolean> {
  if (item.status !== "cancelled") return false;
  let note: NoteRead = { kind: "unreadable" };
  try {
    note = { kind: "read", note: await readCancelNote(item.id) };
  } catch (err) {
    log.warn("failed to read the note of the cancel", {
      work_item_id: item.id,
      error: errorMessage(err),
    });
  }
  return shouldSilenceFailure({
    status: item.status,
    note,
    rowFlowJobId: item.flow_job_id,
    rootJobId,
  });
}
