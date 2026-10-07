// Discord webhookへの通知を組み立てて送る。
// テストで実際のHTTP通信や待機をしないよう、`fetch`と`sleep`は注入できる。

import { type CleanupCounts, summarizeCleanup } from "./cleanup_db_support.ts";
import type { ImplementDiffStat } from "./types.ts";

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
       * 認証付きのAppのInboxのURLだけを入れる。
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
       * `buildConsoleUrl`に`{work_item_id}`を渡したもの)。
       * Discordから開いたときに承認済みの文書が表示されるよう、
       * 埋め込みのリンク先はIssueではなくこちらにする(Issueはフィールドに出す)。
       */
      console_url: string;
    }
  | {
      kind: "needs_human";
      instance_name: string;
      owner: string;
      repo: string;
      url: string;
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
      result: "changes_requested" | "reviewed";
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
      kind: "deploy_action_needed";
      instance_name: string;
      sha: string;
      changed_paths: string[];
    }
  | {
      kind: "job_failed";
      instance_name: string;
      flow_path: string;
      job_id: string;
      error: string;
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
       * 前日の`cleanup_db.ts`の実行結果。その日の実行記録が無いとき
       * (立ち上げ直後でまだ一度も動いていないときなど)は`null`。
       */
      cleanup: CleanupCounts | null;
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

function buildRawEmbed(event: NotifyEvent): DiscordEmbed {
  switch (event.kind) {
    case "issue_claimed":
      return {
        title: `Issue 着手: #${event.issue_number} ${event.title}`,
        description:
          "Factory がこの Issue に着手し、要件定義の生成を開始しました。",
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
        description: "要件定義ドラフトが承認され、Issue に投稿されました。",
        url: event.console_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
          { name: "Issue", value: event.issue_url },
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
    case "pr_reviewed": {
      const stateText =
        event.result === "changes_requested"
          ? "修正が必要な指摘あり"
          : "指摘なし(人のApprove待ち)";
      return {
        title: `PR レビュー完了: #${event.pr_number}`,
        description: `指摘${String(event.finding_count)}件。状態: ${stateText}`,
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
        title: `PR 修正適用: #${event.pr_number}`,
        description: "修正をpushし、再レビューを依頼しました。",
        url: event.pr_url,
        fields,
      };
    }
    case "deploy_action_needed":
      return {
        title: "自己更新にホスト操作が必要です",
        description: `commit ${event.sha} の反映には mise run deploy の実行が必要です。`,
        url: null,
        fields: [
          instanceField(event.instance_name),
          {
            name: "変更パス",
            value: event.changed_paths.join(", ") || "(なし)",
          },
        ],
      };
    case "job_failed":
      return {
        title: `ジョブ失敗: ${event.flow_path}`,
        description: event.error,
        url: null,
        fields: [
          instanceField(event.instance_name),
          { name: "ジョブ", value: event.job_id },
        ],
      };
    case "daily_summary":
      return {
        title: `日次サマリー: ${event.day}`,
        description: `エージェント実行 ${event.run_count} 件、$${event.total_cost_usd.toFixed(2)} 消費。`,
        url: null,
        fields: [
          instanceField(event.instance_name),
          { name: "失敗", value: String(event.failure_count) },
          { name: "承認", value: String(event.approved_count) },
          { name: "却下", value: String(event.rejected_count) },
          {
            name: "DB 掃除",
            value:
              event.cleanup === null
                ? "前日の掃除記録なし"
                : summarizeCleanup(event.cleanup),
          },
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
            value: "承認Inboxで提案を承認または却下してください",
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
        title: `PR ${verb}: #${String(event.pr_number)}(Issue #${String(event.issue_number)})`,
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
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 429応答の再試行までの待ち時間をミリ秒で返す。
 * `retry-after`ヘッダー(秒)を優先し、無ければJSON本文の`retry_after`を使い、
 * どちらも無ければ1秒とする。
 */
async function readRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  if (header !== null) {
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
 * `event`をDiscordの埋め込みにして`webhookUrl`へ送る。
 * 429応答なら、応答が示す時間だけ待って1回だけ再送する。
 * 最終的な応答が2xxでなければ例外を投げる。
 * webhookのURLのパスには秘密のトークンが入るため、
 * エラーメッセージに`webhookUrl`は含めない。
 */
export async function notify(
  webhookUrl: string,
  event: NotifyEvent,
  deps: NotifyDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const doSleep = deps.sleep ?? defaultSleep;
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
    await doSleep(retryAfterMs);
    response = await doFetch(webhookUrl, requestInit);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`discord webhook failed: HTTP ${String(response.status)}`);
  }
}
