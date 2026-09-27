import { describe, expect, test } from "bun:test";
import {
  buildEmbed,
  capEmbedToDiscordLimits,
  notify,
} from "../../f/factory/lib/discord.ts";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

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
    });
    expect(embed.description).toBe("エージェント実行 3 件、$1.50 消費。");
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

  test("states the state label in the pr_fixed description", () => {
    const embed = buildEmbed({
      kind: "pr_fixed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      outcome: "done",
      state_label: "factory:rereview",
      note: null,
    });
    expect(embed.description).toBe(
      "修正をpushしました。状態ラベル: factory:rereview",
    );
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
      state_label: "factory:rereview",
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
      state_label: "factory:rereview",
      note: null,
    });
    expect(embed.fields.some((field) => field.name === "補足")).toBe(false);
  });

  test("states the finding count and state label in the pr_reviewed description", () => {
    const embed = buildEmbed({
      kind: "pr_reviewed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      verdict: "request_changes",
      finding_count: 3,
      state_label: "factory:changes-requested",
    });
    expect(embed.description).toBe(
      "指摘3件。状態ラベル: factory:changes-requested",
    );
  });

  test("truncates a field value longer than 1024 characters", () => {
    const embed = buildEmbed({
      kind: "deploy_action_needed",
      instance_name: "local",
      sha: "abc1234",
      changed_paths: Array.from(
        { length: 200 },
        (_, i) => `f/factory/file-${String(i)}.ts`,
      ),
    });
    const changedPathsField = embed.fields.find(
      (field) => field.name === "変更パス",
    );
    expect(changedPathsField?.value).toHaveLength(1024);
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
