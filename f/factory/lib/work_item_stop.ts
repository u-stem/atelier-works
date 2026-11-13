// 人が中止した作業項目を、動いているClaudeと検査から見つけて止める部品。
// 動いているClaude(`claude.ts`)と検査(`check_runner.ts`)は、全停止の確認とは別に、この確認を15秒ごとに呼ぶ。
// 失敗した実行の処理(`on_error_flow.ts`)は、この判定で、人が止めた作業項目の失敗を記録も通知もせずに終わる。
//
// 止めるのは、状態が取り消し(`cancelled`)で、取り消しへ移った最新の遷移の注記が人の中止の固定文のときだけである。
// 照合による取り消しなど、ほかの理由の取り消しは止めない。
// 読めない、時間内に読み終わらない、行が無い、は止めない扱いにする。DBの一時的な障害で、動いているジョブを壊さないためである。
//
// DBの接続は、`db.ts`を読み込まず、Console用workerの記録の部品と同じ薄い形で作る。
// 書き込みの部品を読み込む経路を、読み取りだけのscriptの依存に増やさないため、その部品は読み込まず、形だけを持つ。
// 読むのは作業項目の表と遷移の記録の表だけで、書き込みは行わない。
// 確認を呼ぶたびに、呼び出しの中で接続を作る。組み立てでは作らず、投げない。

import * as wmill from "windmill-client@1.817.0";
import { isOperatorCancelledNote } from "./operator_cancel.ts";
import {
  DESIGN_FLOW_PATH,
  INVESTIGATE_FLOW_PATH,
  PIPELINE_FLOW_PATH,
} from "./pipeline_lease.ts";
import { STOP_ALL_CHECK_TIMEOUT_MS } from "./stop_all.ts";
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
 * 作業項目の停止の確認を作る。読み取りを`timeoutMs`で区切り、読めない、時間切れ、行が無いは、止めない扱いにする。
 * 全停止の確認とは別の確認なので、待ちの管理を共有しない。
 */
export function workItemStopCheckFrom(
  io: WorkItemStopReadIo,
  timeoutMs: number = STOP_ALL_CHECK_TIMEOUT_MS,
  now: () => number = Date.now,
): StopCheck {
  return boundedCheckFrom(
    async () => isWorkItemStopped(await io.readState()),
    timeoutMs,
    now,
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
): StopCheck {
  if (workspace === undefined || workspace === "") return NEVER_STOPPED;
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) {
    return NEVER_STOPPED;
  }
  return boundedCheckFrom(async () => {
    const io = sdkWorkItemStopReadIo(workItemId, stopSqlClientFrom(open));
    return isWorkItemStopped(await io.readState());
  }, STOP_ALL_CHECK_TIMEOUT_MS);
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
  /** 失敗したフローのpath。 */
  readonly flowPath: string | null;
};

/**
 * 失敗した実行の記録も通知も出さずに終わるか。
 * 次の3つをすべて満たすときだけ真にする。
 * 1. 作業項目の状態が取り消しである。
 * 2. 注記を読めて、人の中止の固定文である。
 * 3. 失敗した実行が、その行の実行である(`flowRunMatchesRow`)。
 * 注記を読めないときは偽にして、通知する側へ進む。
 * 行にジョブIDがまだ記録されていないときの扱いは、`flowRunMatchesRow`による。
 */
export function shouldSilenceFailure(input: SilenceInput): boolean {
  return (
    input.status === "cancelled" &&
    input.note.kind === "read" &&
    isOperatorCancelledNote(input.note.note) &&
    flowRunMatchesRow(input.rowFlowJobId, input.rootJobId, input.flowPath)
  );
}
