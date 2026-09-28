// Discord webhook notifications (spec-cycle2.md §1, §3, §4).
//
// `notify` posts one embed per call. `fetch` and `sleep` are injected so
// tests never make a real HTTP call or actually wait; the default `fetch` is
// the global `fetch` and the default `sleep` is a real `setTimeout`-backed
// wait, used in production for the single 429 retry.

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
 * Every notification point named across spec-cycle2.md §3 (M5/M6) and §4
 * (M7). Each variant carries `instance_name` plus whatever identifies the
 * GitHub object involved, so `buildEmbed` can compose a self-contained embed
 * without any other lookup.
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
      // Security fix (M6 review round 1b): never the signed getResumeUrls()
      // "approvalPage" capability URL — that lets anyone who sees it
      // resume/cancel the suspended flow without going through
      // approval_decide.ts (so no factory.approvals row gets recorded).
      // Only the App's own (authenticated) Inbox URL belongs here.
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
      // Console's 要件定義 deep link (lib/approval_support.ts's
      // buildConsoleUrl with `{work_item_id}`) — the embed links here
      // instead of the Issue (still shown as a field) so clicking through
      // from Discord lands on the approved document, not just the Issue.
      console_url: string;
    }
  | {
      kind: "needs_human";
      instance_name: string;
      owner: string;
      repo: string;
      url: string;
      reason: string;
      // team-lead decision (2026-09-26): every needs_human notification
      // must name what needs attention and what to do about it — a bare
      // "人による対応が必要です" title with only instance/repo fields gave the
      // reader nothing to act on. `target` names the PR/Issue in the title;
      // `next_action` (pr_workflow_support.ts's `nextActionFor`) is a
      // concrete one-sentence instruction shown in its own field.
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
      // team-lead decision (2026-09-26): the description now states what
      // happened (finding count) and the review's outcome, rather than the
      // raw verdict text — that's what actually tells the reader whether
      // anything is needed from them. 2026-09-27 PR label cleanup: there is
      // no more state label to report (poll_prs.ts rediscovers PRs from the
      // DB now), so this carries the same reviewResultFor verdict directly.
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
      // `note` carries an optional supplementary fact (currently: the
      // re-review request's API call failing) that doesn't warrant its own
      // needs_human notification. 2026-09-27 PR label cleanup: there is no
      // more state label to report — `outcome` alone is enough context here.
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
      // DB cleanup addition (2026-09-27): the prior day's cleanup_db.ts run,
      // or null when no run is recorded for that day (e.g. the schedule
      // hasn't run yet on a freshly-bootstrapped instance).
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
      // 工程3 design §8: the implement flow never blocks on a protected-path
      // change — it lists them here (and in the PR body) so a human reviews
      // them first. `checks` is "passed", or the reason no check command
      // ran this round (protected paths changed / none configured).
      protected_changes: string[];
      checks: "passed" | { skipped: string };
      rounds: number;
      total_cost_usd: number;
      diff_stat: ImplementDiffStat | null;
      next_action: string;
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

/** Truncates `text` to at most `max` characters, marking any actual cut
 * with a trailing ellipsis (so the result is still exactly `max` chars,
 * not `max` chars of content plus an ellipsis). */
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
 * Caps an embed to Discord's field-level limits (title 256, description
 * 4096, field value 1024), then to its overall 6000-character budget
 * (title + description + every field's name + value combined), trimming
 * the description first since it is the field most likely to carry long,
 * externally-influenced text (an error message, a rejection reason). None
 * of the current NotifyEvent variants can exceed 6000 through the
 * per-field caps alone, but this is defense in depth for any future event
 * kind that combines several long fields.
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

/** Builds the Discord embed for one NotifyEvent, capped to Discord's size
 * limits. Always includes an "instance" field (spec-cycle2.md §1:
 * "instance_name を必ず含む"). */
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
      return {
        title: `PR 作成: #${String(event.pr_number)}(Issue #${String(event.issue_number)})`,
        description: `実装をpushしてPRを作成しました。${checksText}`,
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

/** A narrower shape than `typeof fetch` (which also carries a `preconnect`
 * static member in some lib.dom.d.ts versions) so a plain fake function
 * satisfies it in tests without an unrelated extra property. */
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

/** Reads a 429 response's retry delay: prefers the `retry-after` header
 * (seconds), falls back to a JSON `retry_after` body field, defaults to 1s. */
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
    // Non-JSON or already-consumed body: fall through to the default.
  }
  return 1000;
}

/**
 * Post `event` as a Discord embed to `webhookUrl`. On a 429 response, waits
 * once (per the response's retry delay) and retries exactly once more.
 * Throws if the final response is not 2xx — the error message never
 * includes `webhookUrl` itself, since its path carries the webhook's
 * secret token.
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
    // Untrusted text (an error message, a rejection reason) can end up in
    // an embed field; this stops it from ever pinging @everyone/@here/a role.
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
