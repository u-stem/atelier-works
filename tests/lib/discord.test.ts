import { describe, expect, test } from "bun:test";
import {
  buildEmbed,
  capEmbedToDiscordLimits,
  DISCORD_RETRY_MAX_WAIT_MS,
  type NotifyDeps,
  type NotifyEvent,
  notify,
} from "../../f/factory/lib/discord.ts";
import type { Logger } from "../../f/factory/lib/log.ts";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const WEBHOOK_URL = "https://discord.example/webhooks/1/token";

const JOB_FAILED_EVENT: NotifyEvent = {
  kind: "job_failed",
  instance_name: "local",
  flow_path: "f/factory/poll_issues",
  job_id: "job-1",
  error: "boom",
};

type FakeDiscord = {
  readonly deps: NotifyDeps;
  readonly requestCount: () => number;
  readonly sleeps: number[];
  readonly warnings: string[];
};

/**
 * 応答を順に返す偽のDiscordを作る。
 * 待ちは実際には待たずに長さだけを記録し、warnのメッセージも記録する。
 * 応答を使い切った後は最後の応答を返し続ける。
 */
function fakeDiscord(responses: readonly (() => Response)[]): FakeDiscord {
  let count = 0;
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
  };
  const deps: NotifyDeps = {
    fetch: async () => {
      const next = responses[Math.min(count, responses.length - 1)];
      count += 1;
      if (next === undefined) throw new Error("no fake response configured");
      return next();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log,
  };
  return { deps, requestCount: () => count, sleeps, warnings };
}

const rateLimitedFor = (seconds: number) => () =>
  jsonResponse(
    429,
    { retry_after: seconds },
    { "retry-after": String(seconds) },
  );

const rateLimitedByBodyFor = (seconds: number) => () =>
  jsonResponse(429, { retry_after: seconds });

const ok = () => jsonResponse(204, {});

describe("buildEmbed", () => {
  test("always includes an instance field", () => {
    const embed = buildEmbed({
      kind: "job_failed",
      instance_name: "local",
      flow_path: "f/factory/poll_issues",
      job_id: "job-1",
      error: "boom",
    });
    expect(embed.fields).toContainEqual({
      name: "インスタンス",
      value: "local",
    });
  });

  test("sets the embed url from the event's primary link", () => {
    const embed = buildEmbed({
      kind: "issue_claimed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
    });
    expect(embed.url).toBe(
      "https://github.com/octo-owner/atelier-works/issues/42",
    );
  });

  test("summarizes daily_summary cost in the description", () => {
    const embed = buildEmbed({
      kind: "daily_summary",
      instance_name: "local",
      day: "2026-09-25",
      run_count: 3,
      total_cost_usd: 1.5,
      failure_count: 0,
      approved_count: 2,
      rejected_count: 1,
      cleanup: null,
    });
    expect(embed.description).toBe("エージェント実行 3 件、$1.50 消費。");
  });

  test("shows a 'no record' DB cleanup field when cleanup is null", () => {
    const embed = buildEmbed({
      kind: "daily_summary",
      instance_name: "local",
      day: "2026-09-25",
      run_count: 3,
      total_cost_usd: 1.5,
      failure_count: 0,
      approved_count: 2,
      rejected_count: 1,
      cleanup: null,
    });
    expect(embed.fields).toContainEqual({
      name: "DB 掃除",
      value: "前日の掃除記録なし",
    });
  });

  test("summarizes cleanup counts in the DB cleanup field when present", () => {
    const embed = buildEmbed({
      kind: "daily_summary",
      instance_name: "local",
      day: "2026-09-25",
      run_count: 3,
      total_cost_usd: 1.5,
      failure_count: 0,
      approved_count: 2,
      rejected_count: 1,
      cleanup: {
        work_items_deleted: 3,
        approval_requests_deleted: 5,
        job_failures_deleted: 12,
        deployments_deleted: 5,
        notices_deleted: 2,
        doc_dirs_deleted: 0,
      },
    });
    expect(embed.fields).toContainEqual({
      name: "DB 掃除",
      value:
        "work item 3件、失敗記録 12件、デプロイ記録 5件、通知 2件を削除しました",
    });
  });

  test("truncates a title longer than 256 characters", () => {
    const embed = buildEmbed({
      kind: "issue_claimed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "x".repeat(300),
    });
    expect(embed.title).toHaveLength(256);
  });

  test("truncates a description longer than 4096 characters", () => {
    const embed = buildEmbed({
      kind: "needs_human",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      url: "https://github.com/octo-owner/atelier-works/issues/42",
      reason: "x".repeat(5000),
      target: { kind: "issue", number: 42 },
      next_action: "Consoleで確認してください",
    });
    expect(embed.description).toHaveLength(4096);
  });

  test("names the target (kind and number) in the needs_human title", () => {
    const embed = buildEmbed({
      kind: "needs_human",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      url: "https://github.com/octo-owner/atelier-works/pull/7",
      reason: "PR head moved",
      target: { kind: "pr", number: 7 },
      next_action: "最新のheadを確認してください",
    });
    expect(embed.title).toBe("人による対応が必要です: PR #7");
  });

  test("includes a next-action field on the needs_human embed", () => {
    const embed = buildEmbed({
      kind: "needs_human",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      url: "https://github.com/octo-owner/atelier-works/issues/42",
      reason: "承認がタイムアウトしました",
      target: { kind: "issue", number: 42 },
      next_action: "Inboxで承認または却下してください",
    });
    expect(embed.fields).toContainEqual({
      name: "次の操作",
      value: "Inboxで承認または却下してください",
    });
  });

  test("names the issue target when the needs_human notification is about an issue", () => {
    const embed = buildEmbed({
      kind: "needs_human",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      url: "https://github.com/octo-owner/atelier-works/issues/42",
      reason: "承認がタイムアウトしました",
      target: { kind: "issue", number: 42 },
      next_action: "Inboxで承認または却下してください",
    });
    expect(embed.title).toBe("人による対応が必要です: Issue #42");
  });

  test("states the outcome in the pr_fixed description", () => {
    const embed = buildEmbed({
      kind: "pr_fixed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      outcome: "done",
      note: null,
    });
    expect(embed.description).toBe("修正をpushし、再レビューを依頼しました。");
  });

  test("includes an optional 補足 field on pr_fixed when a note is present", () => {
    const embed = buildEmbed({
      kind: "pr_fixed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      outcome: "done",
      note: "再レビュー依頼のAPI呼び出しに失敗しました: HTTP 500",
    });
    expect(embed.fields).toContainEqual({
      name: "補足",
      value: "再レビュー依頼のAPI呼び出しに失敗しました: HTTP 500",
    });
  });

  test("omits the 補足 field on pr_fixed when there is no note", () => {
    const embed = buildEmbed({
      kind: "pr_fixed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      outcome: "done",
      note: null,
    });
    expect(embed.fields.some((field) => field.name === "補足")).toBe(false);
  });

  test("states the finding count and result when changes are requested", () => {
    const embed = buildEmbed({
      kind: "pr_reviewed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      verdict: "request_changes",
      finding_count: 3,
      result: "changes_requested",
    });
    expect(embed.description).toBe("指摘3件。状態: 修正が必要な指摘あり");
  });

  test("states the finding count and result when no changes are requested", () => {
    const embed = buildEmbed({
      kind: "pr_reviewed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      verdict: "approve",
      finding_count: 0,
      result: "reviewed",
    });
    expect(embed.description).toBe("指摘0件。状態: 指摘なし(人のApprove待ち)");
  });

  test("truncates a field value longer than 1024 characters", () => {
    const embed = buildEmbed({
      kind: "job_failed",
      instance_name: "local",
      flow_path: "f/factory/some_flow",
      job_id: "j".repeat(2000),
      error: "boom",
    });
    const jobField = embed.fields.find((field) => field.name === "ジョブ");
    expect(jobField?.value).toHaveLength(1024);
  });

  test("sets the embed url to the inbox url, not a resume/cancel capability url", () => {
    const embed = buildEmbed({
      kind: "approval_requested",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      inbox_url: "http://127.0.0.1:8080/apps/get/f/factory/factory_console",
    });
    expect(embed.url).toBe(
      "http://127.0.0.1:8080/apps/get/f/factory/factory_console",
    );
  });

  test("still includes the issue url as a field on approval_requested", () => {
    const embed = buildEmbed({
      kind: "approval_requested",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      inbox_url: "http://127.0.0.1:8080/apps/get/f/factory/factory_console",
    });
    expect(embed.fields).toContainEqual({
      name: "Issue",
      value: "https://github.com/octo-owner/atelier-works/issues/42",
    });
  });

  test("sets the embed url to the Console deep link on requirements_approved", () => {
    const embed = buildEmbed({
      kind: "requirements_approved",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      console_url:
        "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7",
    });
    expect(embed.url).toBe(
      "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7",
    );
  });

  test("still includes the issue url as a field on requirements_approved", () => {
    const embed = buildEmbed({
      kind: "requirements_approved",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
      console_url:
        "http://127.0.0.1:8080/apps/get/f/factory/factory_console#requirements/7",
    });
    expect(embed.fields).toContainEqual({
      name: "Issue",
      value: "https://github.com/octo-owner/atelier-works/issues/42",
    });
  });

  test("audit_completed names the next action", () => {
    const embed = buildEmbed({
      kind: "audit_completed",
      instance_name: "local",
      period_label: "2026-09-22〜2026-09-28",
      proposal_count: 2,
      console_url:
        "http://127.0.0.1:8080/apps/get/f/factory/factory_console#audit/12",
      work_item_id: 12,
    });
    expect(embed.fields.map((f) => f.name)).toContain("次の操作");
  });

  const PR_OPENED_EVENT = {
    kind: "pr_opened" as const,
    instance_name: "local",
    owner: "octo-owner",
    repo: "atelier-works",
    pr_number: 9,
    pr_url: "https://github.com/octo-owner/atelier-works/pull/9",
    issue_number: 42,
    issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
    protected_changes: [],
    checks: "passed" as const,
    rounds: 2,
    total_cost_usd: 3.456,
    diff_stat: { files: 3, added: 120, deleted: 8 },
    next_action: "PRをレビューし、問題なければマージしてください",
    created: true,
  };

  test("names the PR and the parent issue in the pr_opened title", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.title).toBe("PR 作成: #9(Issue #42)");
  });

  test("says the PR was updated in the title of an existing PR", () => {
    const embed = buildEmbed({ ...PR_OPENED_EVENT, created: false });
    expect(embed.title).toBe("PR 更新: #9(Issue #42)");
  });

  test("says the PR was updated in the description of an existing PR", () => {
    const embed = buildEmbed({ ...PR_OPENED_EVENT, created: false });
    expect(embed.description).toBe(
      "実装をpushしてPRを更新しました。検査: 合格",
    );
  });

  test("links the pr_opened embed to the PR", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.url).toBe(
      "https://github.com/octo-owner/atelier-works/pull/9",
    );
  });

  test("states passed checks in the pr_opened description", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.description).toBe(
      "実装をpushしてPRを作成しました。検査: 合格",
    );
  });

  test("states the skip reason in the pr_opened description when checks were skipped", () => {
    const embed = buildEmbed({
      ...PR_OPENED_EVENT,
      checks: { skipped: "保護パスを変更したため" },
    });
    expect(embed.description).toBe(
      "実装をpushしてPRを作成しました。検査未実施: 保護パスを変更したため",
    );
  });

  test("puts the next action first among the pr_opened fields", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.fields[0]).toEqual({
      name: "次の操作",
      value: "PRをレビューし、問題なければマージしてください",
    });
  });

  test("includes the issue url as a field on pr_opened", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.fields).toContainEqual({
      name: "Issue",
      value: "https://github.com/octo-owner/atelier-works/issues/42",
    });
  });

  test("lists protected changes one per line on pr_opened", () => {
    const embed = buildEmbed({
      ...PR_OPENED_EVENT,
      protected_changes: [
        "保護パスを変更: infra/worker/Dockerfile",
        "package.jsonのscriptsを変更",
      ],
    });
    expect(embed.fields).toContainEqual({
      name: "確認して欲しい点",
      value:
        "保護パスを変更: infra/worker/Dockerfile\npackage.jsonのscriptsを変更",
    });
  });

  test("shows (なし) when there are no protected changes", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.fields).toContainEqual({
      name: "確認して欲しい点",
      value: "(なし)",
    });
  });

  test("shows rounds and cost on pr_opened", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.fields).toContainEqual({
      name: "ラウンド / 費用",
      value: "2回 / $3.46",
    });
  });

  test("summarizes the diff stat on pr_opened", () => {
    const embed = buildEmbed(PR_OPENED_EVENT);
    expect(embed.fields).toContainEqual({
      name: "差分",
      value: "3ファイル(+120 / -8)",
    });
  });

  test("shows (不明) for the diff when no diff stat was recorded", () => {
    const embed = buildEmbed({ ...PR_OPENED_EVENT, diff_stat: null });
    expect(embed.fields).toContainEqual({ name: "差分", value: "(不明)" });
  });
});

describe("capEmbedToDiscordLimits", () => {
  test("caps the total character budget (title + description + fields) to 6000", () => {
    const capped = capEmbedToDiscordLimits({
      title: "x".repeat(256),
      description: "y".repeat(4096),
      url: null,
      fields: [
        { name: "a", value: "z".repeat(1024) },
        { name: "b", value: "z".repeat(1024) },
      ],
    });
    const total =
      capped.title.length +
      capped.description.length +
      capped.fields.reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0,
      );
    expect(total).toBeLessThanOrEqual(6000);
  });

  test("trims the description (not the title or fields) to make room under the total budget", () => {
    const capped = capEmbedToDiscordLimits({
      title: "x".repeat(256),
      description: "y".repeat(4096),
      url: null,
      fields: [
        { name: "a", value: "z".repeat(1024) },
        { name: "b", value: "z".repeat(1024) },
      ],
    });
    expect(capped.title).toHaveLength(256);
  });

  test("leaves a small embed untouched", () => {
    const embed = {
      title: "short",
      description: "also short",
      url: null,
      fields: [{ name: "a", value: "b" }],
    };
    const capped = capEmbedToDiscordLimits(embed);
    expect(capped).toEqual(embed);
  });
});

describe("notify", () => {
  test("posts one request with an embeds array to the webhook URL", async () => {
    const calls: { url: string | URL; init: RequestInit | undefined }[] = [];
    const fakeFetch = async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url, init });
      return jsonResponse(200, {});
    };

    await notify(
      "https://discord.example/webhooks/1/token",
      {
        kind: "job_failed",
        instance_name: "local",
        flow_path: "f/factory/poll_issues",
        job_id: "job-1",
        error: "boom",
      },
      { fetch: fakeFetch },
    );

    expect(calls).toHaveLength(1);
  });

  test("sends the built embed as the request body", async () => {
    let sentBody: string | undefined;
    const fakeFetch = async (
      _url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      sentBody = typeof init?.body === "string" ? init.body : undefined;
      return jsonResponse(200, {});
    };

    await notify(
      "https://discord.example/webhooks/1/token",
      {
        kind: "job_failed",
        instance_name: "local",
        flow_path: "f/factory/poll_issues",
        job_id: "job-1",
        error: "boom",
      },
      { fetch: fakeFetch },
    );

    const parsed: unknown = JSON.parse(sentBody ?? "{}");
    expect(parsed).toMatchObject({
      embeds: [{ title: "ジョブ失敗: f/factory/poll_issues" }],
    });
  });

  test("retries exactly once after a 429 response", async () => {
    let callCount = 0;
    const fakeFetch = async (): Promise<Response> => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse(429, { retry_after: 0.01 })
        : jsonResponse(200, {});
    };

    await notify(
      "https://discord.example/webhooks/1/token",
      {
        kind: "job_failed",
        instance_name: "local",
        flow_path: "f/factory/poll_issues",
        job_id: "job-1",
        error: "boom",
      },
      { fetch: fakeFetch, sleep: async () => {} },
    );

    expect(callCount).toBe(2);
  });

  test("waits using the retry-after value from the 429 response before retrying", async () => {
    const sleptMs: number[] = [];
    let callCount = 0;
    const fakeFetch = async (): Promise<Response> => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse(429, { retry_after: 2.5 })
        : jsonResponse(200, {});
    };

    await notify(
      "https://discord.example/webhooks/1/token",
      {
        kind: "job_failed",
        instance_name: "local",
        flow_path: "f/factory/poll_issues",
        job_id: "job-1",
        error: "boom",
      },
      {
        fetch: fakeFetch,
        sleep: async (ms) => {
          sleptMs.push(ms);
        },
      },
    );

    expect(sleptMs).toEqual([2500]);
  });

  test("throws when the final response is not 2xx", async () => {
    const fakeFetch = async (): Promise<Response> =>
      jsonResponse(400, { message: "bad request" });

    await expect(
      notify(
        "https://discord.example/webhooks/1/token",
        {
          kind: "job_failed",
          instance_name: "local",
          flow_path: "f/factory/poll_issues",
          job_id: "job-1",
          error: "boom",
        },
        { fetch: fakeFetch },
      ),
    ).rejects.toThrow("discord webhook failed: HTTP 400");
  });

  test("does not include the webhook URL in the thrown error message", async () => {
    const fakeFetch = async (): Promise<Response> =>
      jsonResponse(401, { message: "unauthorized" });

    await expect(
      notify(
        "https://discord.example/webhooks/1/super-secret-token",
        {
          kind: "job_failed",
          instance_name: "local",
          flow_path: "f/factory/poll_issues",
          job_id: "job-1",
          error: "boom",
        },
        { fetch: fakeFetch },
      ),
    ).rejects.not.toThrow(/super-secret-token/);
  });

  test("does not throw when the final response after a 429 retry is 2xx", async () => {
    let callCount = 0;
    const fakeFetch = async (): Promise<Response> => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse(429, { retry_after: 0.01 })
        : jsonResponse(204, {});
    };

    await expect(
      notify(
        "https://discord.example/webhooks/1/token",
        {
          kind: "job_failed",
          instance_name: "local",
          flow_path: "f/factory/poll_issues",
          job_id: "job-1",
          error: "boom",
        },
        { fetch: fakeFetch, sleep: async () => {} },
      ),
    ).resolves.toBeUndefined();
  });

  test("sets allowed_mentions to parse nothing", async () => {
    let sentBody: string | undefined;
    const fakeFetch = async (
      _url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      sentBody = typeof init?.body === "string" ? init.body : undefined;
      return jsonResponse(200, {});
    };

    await notify(
      "https://discord.example/webhooks/1/token",
      {
        kind: "job_failed",
        instance_name: "local",
        flow_path: "f/factory/poll_issues",
        job_id: "job-1",
        error: "boom",
      },
      { fetch: fakeFetch },
    );

    const parsed: unknown = JSON.parse(sentBody ?? "{}");
    expect(parsed).toMatchObject({ allowed_mentions: { parse: [] } });
  });
});

describe("notify rate limit wait cap", () => {
  test("keeps the wait cap well below the shortest flow step timeout of 600s", () => {
    expect(DISCORD_RETRY_MAX_WAIT_MS).toBeLessThanOrEqual(60_000);
  });

  test("waits exactly the cap when retry-after equals the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([DISCORD_RETRY_MAX_WAIT_MS]);
  });

  test("resends after waiting exactly the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.requestCount()).toBe(2);
  });

  test("does not sleep when retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([]);
  });

  test("does not resend when retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.requestCount()).toBe(1);
  });

  test("resolves without throwing when retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await expect(
      notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps),
    ).resolves.toBeUndefined();
  });

  test("logs a warning when giving up because retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.warnings).toEqual([
      "discord notify skipped: rate limit wait exceeds cap",
    ]);
  });

  test("applies the cap to retry_after in the body when the header is missing", async () => {
    const discord = fakeDiscord([
      rateLimitedByBodyFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([]);
  });

  test("does not log a warning when the wait is within the cap", async () => {
    const discord = fakeDiscord([rateLimitedFor(2), ok]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.warnings).toEqual([]);
  });

  test("throws when the retry is rate limited again", async () => {
    const discord = fakeDiscord([rateLimitedFor(1), rateLimitedFor(1)]);

    await expect(
      notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps),
    ).rejects.toThrow("discord webhook failed: HTTP 429");
  });

  test("does not send a third request when the retry is rate limited again", async () => {
    const discord = fakeDiscord([rateLimitedFor(1), rateLimitedFor(1), ok]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps).catch(() => {});

    expect(discord.requestCount()).toBe(2);
  });
});
