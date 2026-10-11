// 却下による作り直しや再実行の前に、作業項目に取り込んだ題名と本文を現在のIssueの内容へ更新する。
// 更新したことは、作業項目の履歴(`work_item_events`)に残し、通知とPR本文の注記で承認者に伝える。

import { createHash } from "node:crypto";
import { INTAKE_REFRESHED_NOTE_PREFIX } from "./console_support.ts";
import { issueChangedSinceIntake } from "./implement_support.ts";
import { maskSecrets } from "./log.ts";

/** 取り込み直しを知らせるnoticeの種類。 */
export const INTAKE_REFRESHED_NOTICE_KIND = "intake_refreshed";

/**
 * 文字数と先頭のハッシュで、文字列を特定する短い表記を返す。副作用は無い。
 * Issueの内容は信頼できない入力なので、履歴にはそのまま入れず、後から更新の前後を照合するためのこの表記に留める。
 */
export function fingerprintText(text: string | null): string {
  const value = text ?? "";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${String(Array.from(value).length)} chars, sha256 ${digest}`;
}

/** 更新の前後の題名・本文の表記を並べた、履歴の`note`を作る。内容そのものは入れない。 */
export function buildIntakeRefreshNote(
  before: { readonly title: string | null; readonly body: string | null },
  after: { readonly title: string; readonly body: string },
): string {
  return [
    `${INTAKE_REFRESHED_NOTE_PREFIX};`,
    `before: title ${fingerprintText(before.title)}, body ${fingerprintText(before.body)};`,
    `after: title ${fingerprintText(after.title)}, body ${fingerprintText(after.body)}`,
  ].join(" ");
}

/** 取り込み直しを知らせるnoticeの本文。承認者が次にすることまで書く。 */
export function buildIntakeRefreshedNoticeMessage(target: {
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly work_item_id: number;
}): string {
  return `${target.owner}/${target.repo}#${String(target.issue_number)} (work item ${String(target.work_item_id)}): Issueが取り込み後に書き換えられたので、取り込み内容を現在のIssueで更新しました。新しいConsoleの要対応で更新後の内容を確かめてから承認してください`;
}

export type RefreshIntakeOutcome =
  | "updated"
  | "unchanged"
  | "fetch_failed"
  | "not_written"
  | "write_failed";

export type RefreshIntakeDeps = {
  /** 作業項目に保存されている、取り込み時点の題名と本文。 */
  readonly snapshot: {
    readonly title: string | null;
    readonly body: string | null;
  };
  /** GitHubから現在のIssueの題名と本文を取る。 */
  readonly getIssue: () => Promise<{
    readonly title: string;
    readonly body: string;
  }>;
  /**
   * `updateIntakeIfRegenerating`で、題名と本文と履歴の`note`を同じ文で書く。
   * 作業項目が先に動いていれば`false`を返す。
   */
  readonly writeIntake: (
    intake: { readonly title: string; readonly body: string },
    note: string,
  ) => Promise<boolean>;
  /** 更新できたときに、noticeとDiscordで承認者に知らせる。更新後の内容を受け取る。失敗しても更新は戻さない。 */
  readonly announce: (updated: {
    readonly title: string;
    readonly body: string;
  }) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

function messageOf(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * 作り直しの前に、作業項目の題名と本文を現在のIssueの内容に更新する。
 * 却下の理由が「Issueを書き換えた」ことのとき、作り直した要件定義が書き換え後の内容に基づき、
 * 次の承認の前の確認が通るようにするためである。
 * 承認者がConsoleで見る取り込み時点の内容は更新後の値で、実装のClaudeに渡る内容と一致する。
 *
 * 更新は、書き換え後の内容を承認者が見ないまま実装に渡さないよう、履歴に残して知らせる(`announce`)。
 * GitHubから取れなかったとき、書き込みに失敗したとき、作業項目が先に動いたときは、更新せずに
 * 元の値を保つ。例外は投げない。作り直しは元の値で進み、Issueが違えば次の承認が断られる。
 */
export async function refreshIntakeFromIssue(
  deps: RefreshIntakeDeps,
): Promise<RefreshIntakeOutcome> {
  let live: { readonly title: string; readonly body: string };
  try {
    live = await deps.getIssue();
  } catch (err) {
    deps.log("could not fetch the issue; keeping the intake content", {
      error: messageOf(err),
    });
    return "fetch_failed";
  }
  if (!issueChangedSinceIntake(deps.snapshot, live)) return "unchanged";
  try {
    const written = await deps.writeIntake(
      { title: live.title, body: live.body },
      buildIntakeRefreshNote(deps.snapshot, live),
    );
    if (!written) {
      deps.log("work item moved on; the intake content was not updated", {});
      return "not_written";
    }
  } catch (err) {
    deps.log("could not write the intake content", { error: messageOf(err) });
    return "write_failed";
  }
  try {
    await deps.announce({ title: live.title, body: live.body });
  } catch (err) {
    deps.log("could not announce the intake refresh", {
      error: messageOf(err),
    });
  }
  return "updated";
}
