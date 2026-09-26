// Discord webhook notifications (spec-cycle2.md §1, §3, §4).
//
// `notify` posts one embed per call. `fetch` and `sleep` are injected so
// tests never make a real HTTP call or actually wait; the default `fetch` is
// the global `fetch` and the default `sleep` is a real `setTimeout`-backed
// wait, used in production for the single 429 retry.

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
    }
  | {
      kind: "needs_human";
      instance_name: string;
      owner: string;
      repo: string;
      url: string;
      reason: string;
    }
  | {
      kind: "pr_reviewed";
      instance_name: string;
      owner: string;
      repo: string;
      pr_number: number;
      pr_url: string;
      verdict: string;
    }
  | {
      kind: "pr_fixed";
      instance_name: string;
      owner: string;
      repo: string;
      pr_number: number;
      pr_url: string;
      outcome: string;
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
        url: event.issue_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    case "needs_human":
      return {
        title: "人による対応が必要です",
        description: event.reason,
        url: event.url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    case "pr_reviewed":
      return {
        title: `PR レビュー完了: #${event.pr_number}`,
        description: `判定: ${event.verdict}`,
        url: event.pr_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
    case "pr_fixed":
      return {
        title: `PR 修正適用: #${event.pr_number}`,
        description: `結果: ${event.outcome}`,
        url: event.pr_url,
        fields: [
          instanceField(event.instance_name),
          repoField(event.owner, event.repo),
        ],
      };
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
        ],
      };
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
