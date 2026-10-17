// Discord webhookへの通知を組み立てて送る。
// テストで実際のHTTP通信や待機をしないよう、`fetch`と`sleep`は注入できる。

import { type CleanupCounts, summarizeCleanup } from "./cleanup_db_support.ts";
import { type Logger, logger, maskSecrets } from "./log.ts";
import type { GatedReviewReport, ImplementDiffStat } from "./types.ts";
import {
  describeWorkerLoad,
  type WorkerLoadReport,
} from "./worker_load_support.ts";

export type DiscordEmbedField = {
  name: string;
  value: string;
};

export type DiscordEmbed = {
  title: string;
  description: string;
  url: string | null;
  fields: DiscordEmbedField[];
};

/**
 * Factoryが送る通知の種類。
 * どの種類も`instance_name`と、対象のGitHubのオブジェクトを特定する値を持つ。
 * `buildEmbed`が他を引かずに、それだけで完結した埋め込みを作れるようにするため。
 */
export type NotifyEvent =
  | {
      kind: "issue_claimed";
      instance_name: string;
      owner: string;
      repo: string;
      issue_number: number;
      issue_url: string;
      title: string;
    }
  | {
      kind: "approval_requested";
      instance_name: string;
      owner: string;
      repo: string;
      issue_number: number;
      issue_url: string;
      title: string;
      /**
       * 承認依頼を選んだ状態の、ログインを求めるConsoleのURLだけを入れる
       * (`lib/approval_support.ts`の`buildApprovalConsoleUrl`)。
       * `getResumeUrls()`の署名付き`approvalPage`のURLは入れない。
       * そのURLを見た人は誰でも`approval_decide.ts`を通さずに停止中のフローを
       * 再開・取消でき、承認の記録が残らないため。
       */
      inbox_url: string;
    }
  | {
      kind: "requirements_approved";
      instance_name: string;
      owner: string;
      repo: string;
      issue_number: number;
      issue_url: string;
      title: string;
      /**
       * Consoleの要件定義ページへのリンク(`lib/approval_support.ts`の
       * `buildConsoleUrl`に作業項目と承認した試行を渡したもの)。
       * Discordから開いたときに承認済みの文書が表示されるよう、
       * 埋め込みのリンク先はIssueではなくこちらにする(Issueはフィールドに出す)。
       */
      console_url: string;
    }
  | {
      kind: "intake_refreshed";
      instance_name: string;
      owner: string;
      repo: string;
      issue_number: number;
      issue_url: string;
      title: string;
    }
  | {
      kind: "needs_human";
      instance_name: string;
      owner: string;
      repo: string;
      /** 対象へのリンク。リンクを作れないときは`null`にして、リンク無しで通知する。 */
      url: string | null;
      reason: string;
      /**
       * `needs_human`の通知には、何に対応が要るかと、何をすればよいかを必ず載せる。
       * タイトルとインスタンス・リポジトリだけでは、
       * 読み手が次に何をすべきか分からないため。
       * `target`はタイトルに出すPRまたはIssue。`next_action`
       * (`pr_workflow_support.ts`の`nextActionFor`)は具体的な1文の指示で、
       * 専用のフィールドに出す。
       */
      target: { kind: "pr" | "issue"; number: number };
      next_action: string;
    }
  | {
      kind: "main_ci_failed";
      instance_name: string;
      owner: string;
      repo: string;
      /** 失敗したコミットのsha先頭7文字。 */
      sha7: string;
      /** 失敗した実行へのリンク。検証済みのGitHubのURLだけを入れる(`parseRunUrl`)。 */
      url: string;
      /** 運用者がまず行う操作の1文。固定文を入れる。 */
      next_action: string;
    }
  | {
      kind: "pr_reviewed";
      instance_name: string;
      owner: string;
      repo: string;
      pr_number: number;
      pr_url: string;
      verdict: string;
      /**
       * 説明文には判定の原文ではなく、指摘件数とレビューの結果を出す。
       * 読み手が自分の対応が要るかを判断できるのはこちらのため。
       * `result`は`reviewResultFor`の判定をそのまま入れる。
       */
      finding_count: number;
      result: "changes_requested" | "reviewed" | "unverified";
    }
  | {
      kind: "pr_fixed";
      instance_name: string;
      owner: string;
      repo: string;
      pr_number: number;
      pr_url: string;
      outcome: string;
      /**
       * 単独の`needs_human`通知にするほどではない補足(現状は、再レビュー依頼の
       * API呼び出しが失敗したこと)。無ければ`null`。
       */
      note: string | null;
    }
  | {
      kind: "job_failed";
      instance_name: string;
      flow_path: string;
      job_id: string;
      error: string;
      /**
       * 運用者がまず行う操作の1文。再実行の案内が当たらないフロー(dependabot)だけが載せる。
       * 無ければ欄を出さない。
       */
      next_action?: string;
      /**
       * 失敗した作業項目のPR。人が対応するPRを示すフロー(dependabot)だけが載せる。
       * あればPRへのリンクと「対象」の欄を出す。
       */
      pr?: { owner: string; repo: string; number: number };
    }
  | {
      kind: "console_fetch_problem";
      instance_name: string;
      /** 取り込みが止まっている原因。分類したコードではなく、読める文にする。 */
      cause: string;
      /** 運用者がまず行う操作の1文(`console_status.ts`の`nextActionFor`)。 */
      next_action: string;
    }
  | {
      kind: "host_action_required";
      instance_name: string;
      /** 反映した版と、ホスト側の作業が要る理由。 */
      cause: string;
      /** 運用者がまず行う操作の1文。 */
      next_action: string;
    }
  | {
      kind: "console_worker_missing";
      instance_name: string;
      /** Console用のworkerがtag `console`のジョブを受けていないこと。 */
      cause: string;
      /** 運用者がまず行う操作の1文。 */
      next_action: string;
    }
  | {
      kind: "periodic_worker_missing";
      instance_name: string;
      /** 定期ジョブ用のworkerがtag `periodic`のジョブを受けていないこと。 */
      cause: string;
      /** 運用者がまず行う操作の1文。 */
      next_action: string;
    }
  | {
      kind: "default_worker_missing";
      instance_name: string;
      /** defaultのworkerがジョブを受けていないこと。 */
      cause: string;
      /** 運用者がまず行う操作の1文。 */
      next_action: string;
    }
  | {
      kind: "console_worker_check_failed";
      instance_name: string;
      /** Console用のworkerがジョブを受けているかを、続けて確かめられていないこと。 */
      cause: string;
      /** 運用者がまず行う操作の1文。 */
      next_action: string;
    }
  | {
      kind: "daily_summary";
      instance_name: string;
      day: string;
      run_count: number;
      total_cost_usd: number;
      failure_count: number;
      approved_count: number;
      rejected_count: number;
      /**
       * 集計の対象の日の`cleanup_db.ts`の実行結果。その日の実行記録が無いとき
       * (立ち上げ直後でまだ一度も動いていないときなど)は`null`。
       */
      cleanup: CleanupCounts | null;
      /**
       * 集計の対象の日のdefaultのworkerの負荷。集計、その日の記録が無いこと、
       * 集計を読めなかったことのどれかを表す。
       */
      worker_load: WorkerLoadReport;
      /**
       * `review_post_mode`が`gated`のときの、投稿しなかったレビューの期間と件数。
       * 投稿するモードのときは`off`で、欄を出さない。
       */
      gated_review: GatedReviewReport;
    }
  | {
      kind: "audit_completed";
      instance_name: string;
      period_label: string;
      proposal_count: number;
      console_url: string;
      work_item_id: number;
    }
  | {
      kind: "pr_opened";
      instance_name: string;
      owner: string;
      repo: string;
      pr_number: number;
      pr_url: string;
      issue_number: number;
      issue_url: string;
      /**
       * implementフローは保護パスの変更があっても止まらない。
       * 人が先に確認できるよう、変更された保護パスをここ(とPR本文)に並べる。
       */
      protected_changes: string[];
      /**
       * 検査に合格したら`"passed"`。今回のラウンドで検査コマンドを実行しなかったときは
       * その理由(保護パスが変更された、検査コマンドが設定されていない)。
       */
      checks: "passed" | { skipped: string };
      rounds: number;
      total_cost_usd: number;
      diff_stat: ImplementDiffStat | null;
      next_action: string;
      /** PRを新しく作らず、既存のPRのタイトルと本文を更新したときは`false`。 */
      created: boolean;
    };

function repoField(owner: string, repo: string): DiscordEmbedField {
  return { name: "リポジトリ", value: `${owner}/${repo}` };
}

function instanceField(instanceName: string): DiscordEmbedField {
  return { name: "インスタンス", value: instanceName };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `date`が属するJSTの日付を`YYYY-MM-DD`で返す(UTC+9固定)。 */
function jstDate(date: Date): string {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${String(shifted.getUTCFullYear())}-${month}-${day}`;
}

/** 日次のまとめの欄の文。投稿するモードのときは`null`で、欄を出さない。 */
function describeGatedReview(report: GatedReviewReport): string | null {
  switch (report.kind) {
    case "off":
      return null;
    case "read_failed":
      return "集計を読めませんでした(`wmill job list --script-path f/factory/notify_daily_summary`で直近のジョブを探し、ログの警告を確認)";
    case "on":
      if (report.since === null || report.elapsed_days === null) {
        return "gatedで有効。投稿しなかったレビューは0件";
      }
      return `gatedで有効。${jstDate(report.since)}から${String(report.elapsed_days)}日、投稿しなかったレビューは${String(report.unposted_count)}件`;
  }
}

/** 投稿するモードのときは空で、日次のまとめに欄を足さない。 */
function gatedReviewFields(report: GatedReviewReport): DiscordEmbedField[] {
  const text = describeGatedReview(report);
  return text === null ? [] : [{ name: "レビューの投稿", value: text }];
}

const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;
const FIELD_VALUE_MAX = 1024;
const TOTAL_MAX = 6000;

/**
 * `text`を`max`文字以内に切り詰めて返す。
 * 切ったときは末尾を省略記号にし、省略記号を含めてちょうど`max`文字にする。
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 0) {
    return "";
  }
  return `${text.slice(0, max - 1)}…`;
}

/**
 * 埋め込みをDiscordの上限に収めて返す。
 * まず項目ごとの上限(タイトル256、説明4096、フィールドの値1024)で切り、
 * 次に全体の上限6000文字(タイトル、説明、全フィールドの名前と値の合計)に収める。
 * 全体を削るときは説明から削る。エラーメッセージや差し戻し理由など、
 * 外部の影響を受けた長い文が入りやすいのが説明だからである。
 * 今の通知の種類はどれも項目ごとの上限だけで6000文字を超えないが、
 * 長いフィールドを複数持つ種類が増えたときの備えとして全体でも切る。
 */
export function capEmbedToDiscordLimits(embed: DiscordEmbed): DiscordEmbed {
  const title = truncate(embed.title, TITLE_MAX);
  let description = truncate(embed.description, DESCRIPTION_MAX);
  const fields = embed.fields.map((field) => ({
    name: field.name,
    value: truncate(field.value, FIELD_VALUE_MAX),
  }));

  const fieldsLength = fields.reduce(
    (sum, field) => sum + field.name.length + field.value.length,
    0,
  );
  const total = title.length + description.length + fieldsLength;
  if (total > TOTAL_MAX) {
    const overBy = total - TOTAL_MAX;
    description = truncate(
      description,
      Math.max(0, description.length - overBy),
    );
  }

  return { title, description, url: embed.url, fields };
}

/**
 * 通知1件分のDiscordの埋め込みを、Discordの上限に収めて返す。
 * どの通知にも、どのインスタンスからの通知かを示すフィールドを含める。
 */
export function buildEmbed(event: NotifyEvent): DiscordEmbed {
  return capEmbedToDiscordLimits(buildRawEmbed(event));
}

/**
 * PRレビュー完了の通知に出す状態。
 * `unverified`は、未解決の指摘を読めず、人のApprove待ちと言い切れないため、別の文にする。
 */
const PR_REVIEWED_STATE_TEXT = {
  changes_requested: "修正必須の指摘が未解決(要修正)",
  reviewed: "修正必須の指摘なし(人のApprove待ち)",
  unverified: "未解決の指摘を読み取れず未確認(人がPRで確かめる)",
} as const;

function buildRawEmbed(event: NotifyEvent): DiscordEmbed {
  switch (event.kind) {
    case "issue_claimed":
      return {
        title: `Issue着手: #${event.issue_number} ${event.title}`,
        description:
          "FactoryがこのIssueに着手し、要件定義の生成を開始しました。",
        url: event.issue_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    case "approval_requested":
      return {
        title: `承認待ち: #${event.issue_number} ${event.title}`,
        description: "要件定義ドラフトが確認待ちです。",
        url: event.inbox_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
          { name: "Issue", value: event.issue_url },
        ],
      };
    case "requirements_approved":
      return {
        title: `要件定義承認: #${event.issue_number} ${event.title}`,
        description: "要件定義ドラフトが承認され、Issueに投稿されました。",
        url: event.console_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
          { name: "Issue", value: event.issue_url },
        ],
      };
    case "intake_refreshed":
      return {
        title: `取り込み内容を更新: #${event.issue_number} ${event.title}`,
        description:
          "Issueが取り込み後に書き換えられたので、取り込み内容を現在のIssueで更新しました。Consoleの要対応で更新後の内容を確かめてから承認してください。",
        url: event.issue_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    case "needs_human": {
      const targetLabel = event.target.kind === "pr" ? "PR" : "Issue";
      return {
        title: `人による対応が必要です: ${targetLabel} #${String(event.target.number)}`,
        description: event.reason,
        url: event.url,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    }
    case "main_ci_failed":
      return {
        title: `mainのCIが失敗しました: ${event.owner}/${event.repo}@${event.sha7}`,
        description: `mainのコミット${event.sha7}でCIが失敗しました。`,
        url: event.url,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    case "pr_reviewed": {
      const stateText = PR_REVIEWED_STATE_TEXT[event.result];
      return {
        title: `PRレビュー完了: #${event.pr_number}`,
        description: `今回の指摘${String(event.finding_count)}件。状態: ${stateText}`,
        url: event.pr_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    }
    case "pr_fixed": {
      const fields = [
        instanceField(event.instance_name),
        repoField(event.owner, event.repo),
      ];
      if (event.note !== null) {
        fields.push({ name: "補足", value: event.note });
      }
      return {
        title: `PR修正適用: #${event.pr_number}`,
        description: "修正をpushし、再レビューを依頼しました。",
        url: event.pr_url,
        fields,
      };
    }
    case "job_failed":
      return {
        title: `ジョブ失敗: ${event.flow_path}`,
        description: event.error,
        url:
          event.pr === undefined
            ? null
            : `https://github.com/${event.pr.owner}/${event.pr.repo}/pull/${String(event.pr.number)}`,
        fields: [
          ...(event.next_action === undefined
            ? []
            : [{ name: "次の操作", value: event.next_action }]),
          ...(event.pr === undefined
            ? []
            : [
                {
                  name: "対象",
                  value: `${event.pr.owner}/${event.pr.repo}#${String(event.pr.number)}`,
                },
              ]),
          instanceField(event.instance_name),
          { name: "ジョブ", value: event.job_id },
        ],
      };
    case "console_fetch_problem":
      return {
        title: "Consoleの取り込みに問題があります",
        description: event.cause,
        url: null,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
        ],
      };
    case "host_action_required":
      return {
        title: "ホスト側の作業が必要です",
        description: event.cause,
        url: null,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
        ],
      };
    case "console_worker_missing":
      return {
        title: "Console用のworkerがジョブを受けていません",
        description: event.cause,
        url: null,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
        ],
      };
    case "periodic_worker_missing":
      return {
        title: "定期ジョブ用のworkerがジョブを受けていません",
        description: event.cause,
        url: null,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
        ],
      };
    case "default_worker_missing":
      return {
        title: "defaultのworkerがジョブを受けていません",
        description: event.cause,
        url: null,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
        ],
      };
    case "console_worker_check_failed":
      return {
        title: "Console用のworkerの動きを確かめられません",
        description: event.cause,
        url: null,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
        ],
      };
    case "daily_summary":
      return {
        title: `日次サマリー: ${event.day}`,
        description: `エージェント実行${event.run_count}件、$${event.total_cost_usd.toFixed(2)}消費。`,
        url: null,
        fields: [
          instanceField(event.instance_name),
          { name: "失敗", value: String(event.failure_count) },
          { name: "承認", value: String(event.approved_count) },
          { name: "却下", value: String(event.rejected_count) },
          {
            name: "DB掃除",
            value:
              event.cleanup === null
                ? "その日の掃除記録なし"
                : summarizeCleanup(event.cleanup),
          },
          {
            name: "workerの負荷",
            value: describeWorkerLoad(event.worker_load),
          },
          ...gatedReviewFields(event.gated_review),
        ],
      };
    case "audit_completed":
      return {
        title: `監査レポートができました(${event.period_label})`,
        description: `改善提案を${String(event.proposal_count)}件登録しました。`,
        url: event.console_url,
        fields: [
          {
            name: "次の操作",
            value: "Consoleの要対応で提案を承認または却下してください",
          },
          instanceField(event.instance_name),
          { name: "work_item_id", value: String(event.work_item_id) },
        ],
      };
    case "pr_opened": {
      const checksText =
        event.checks === "passed"
          ? "検査: 合格"
          : `検査未実施: ${event.checks.skipped}`;
      const diffText =
        event.diff_stat === null
          ? "(不明)"
          : `${String(event.diff_stat.files)}ファイル(+${String(event.diff_stat.added)} / -${String(event.diff_stat.deleted)})`;
      const verb = event.created ? "作成" : "更新";
      return {
        title: `PR${verb}: #${String(event.pr_number)}(Issue #${String(event.issue_number)})`,
        description: `実装をpushしてPRを${verb}しました。${checksText}`,
        url: event.pr_url,
        fields: [
          { name: "次の操作", value: event.next_action },
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
          { name: "Issue", value: event.issue_url },
          {
            name: "確認して欲しい点",
            value: event.protected_changes.join("\n") || "(なし)",
          },
          {
            name: "ラウンド / 費用",
            value: `${String(event.rounds)}回 / $${event.total_cost_usd.toFixed(2)}`,
          },
          { name: "差分", value: diffText },
        ],
      };
    }
  }
}

/**
 * 注入する`fetch`の型。
 * `typeof fetch`は`lib.dom.d.ts`の版によって静的メンバー`preconnect`を持つため、
 * テストのただの偽関数でも満たせるよう、それより狭い型にする。
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type NotifyDeps = {
  fetch?: FetchLike;
  /**
   * 429応答で1回だけ再送する前の待機。既定は`setTimeout`による実際の待機。
   * 待つ時間は`DISCORD_RETRY_MAX_WAIT_MS`を超えない。
   */
  sleep?: (ms: number) => Promise<void>;
  /** 通知を諦めたときにwarnを残す先。既定は`logger("discord")`。 */
  log?: Logger;
};

/**
 * 429応答の再送までに待つ時間の上限(ミリ秒)。
 * Discordの`retry-after`はふつう数秒なので、通常の429はこの範囲で待てる。
 * これより長い待ちは、チャンネルやアカウント全体の制限に当たっているときで、
 * 待っても再送が通る見込みが薄いので、通知を諦める。
 * 最も短いstepのtimeout(pr_fixの指摘の収集の600秒)より十分に短くし、
 * 1つのstepで何度か通知しても打ち切られないようにする。
 */
export const DISCORD_RETRY_MAX_WAIT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 429応答の再試行までの待ち時間をミリ秒で返す。
 * `retry-after`ヘッダー(秒)を優先し、無ければJSON本文の`retry_after`を使い、
 * どちらも無ければ1秒とする。
 * 空や空白だけのヘッダーは、`Number`が0と読んで待たずに再送してしまうので、無いものとして扱う。
 * 数として読めないヘッダーも同じく無視する。
 */
async function readRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header !== null && header.trim().length > 0) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  try {
    const body: unknown = await response.clone().json();
    if (
      typeof body === "object" &&
      body !== null &&
      "retry_after" in body &&
      typeof body.retry_after === "number"
    ) {
      return body.retry_after * 1000;
    }
  } catch {
    // 本文がJSONでないか読み終えているときは、既定値を使う。
  }
  return 1000;
}

/**
 * `notify`の結果。`rate_limit_skipped`は、429応答が示す待ちが上限を超えたため、
 * 送らずに諦めたことを表す。
 */
export type NotifyOutcome = "sent" | "rate_limit_skipped";

/**
 * `event`をDiscordの埋め込みにして`webhookUrl`へ送る。
 * 429応答なら、応答が示す時間だけ待って1回だけ再送する。
 * 示された待ちが`DISCORD_RETRY_MAX_WAIT_MS`を超えるときは、待たず再送もせずに
 * warnを残して`rate_limit_skipped`を返す。待ちがstepのtimeoutより長引いて
 * 打ち切られることを防ぐため。
 * それ以外で最終的な応答が2xxでなければ(再送も429なら含めて)例外を投げる。
 * 通知の失敗でフローを止めない呼び出し側は、`notifyBestEffort`を使う。
 * webhookのURLのパスには秘密のトークンが入るため、
 * エラーメッセージとログに`webhookUrl`は含めない。
 */
export async function notify(
  webhookUrl: string,
  event: NotifyEvent,
  deps: NotifyDeps = {},
): Promise<NotifyOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const doSleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? logger("discord");
  const embed = buildEmbed(event);
  const payload = JSON.stringify({
    embeds: [embed],
    // 埋め込みにはエラーメッセージや差し戻し理由など信頼できない文が入りうるため、
    // @everyone、@here、ロールへのメンションを一切発生させない。
    allowed_mentions: { parse: [] },
  });
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  };

  let response = await doFetch(webhookUrl, requestInit);
  if (response.status === 429) {
    const retryAfterMs = await readRetryAfterMs(response);
    if (retryAfterMs > DISCORD_RETRY_MAX_WAIT_MS) {
      log.warn("discord notify skipped: rate limit wait exceeds cap", {
        kind: event.kind,
        retry_after_ms: retryAfterMs,
        max_wait_ms: DISCORD_RETRY_MAX_WAIT_MS,
      });
      return "rate_limit_skipped";
    }
    await doSleep(retryAfterMs);
    response = await doFetch(webhookUrl, requestInit);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`discord webhook failed: HTTP ${String(response.status)}`);
  }
  return "sent";
}

/**
 * `notifyBestEffort`の結果。`not_sent`の`reason`は秘密情報をマスク済みで、
 * そのままログやConsoleのnoticeに載せてよい。
 */
export type NotifyBestEffortResult =
  | { readonly status: "sent" }
  | { readonly status: "no_webhook" }
  | { readonly status: "not_sent"; readonly reason: string };

/**
 * `notify`で送り、失敗しても例外を投げない。
 * webhookのURLが空なら何もしない(通知を設定していないインスタンス)。
 * 送信の失敗(例外、2xx以外の応答、再送も429)はwarnを残して`not_sent`を返す。
 * 待ちが上限を超えて諦めたときも、`notify`が`log`にwarnを残し、`not_sent`を返す。
 * 通知はDB・GitHubへの副作用の後に送ることが多く、通知の失敗でstepが止まると、
 * 済んだ副作用の続き(次のフローの起動や状態の遷移)が行われないままになるため。
 * 届かなかったことを人に知らせる必要がある呼び出し側は、戻り値で判断する。
 */
export async function notifyBestEffort(
  webhookUrl: string,
  event: NotifyEvent,
  log: Logger,
  deps: NotifyDeps = {},
): Promise<NotifyBestEffortResult> {
  if (webhookUrl.length === 0) return { status: "no_webhook" };
  let outcome: NotifyOutcome;
  try {
    outcome = await notify(webhookUrl, event, { ...deps, log });
  } catch (err) {
    const reason = maskSecrets(String(err));
    log.warn("discord notify failed", { kind: event.kind, error: reason });
    return { status: "not_sent", reason };
  }
  if (outcome === "rate_limit_skipped") {
    return {
      status: "not_sent",
      reason: `discord rate limit wait exceeds the ${String(DISCORD_RETRY_MAX_WAIT_MS / 1000)}s cap`,
    };
  }
  return { status: "sent" };
}
