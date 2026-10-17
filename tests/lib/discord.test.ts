import { describe, expect, test } from "bun:test";
import {
  buildEmbed,
  capEmbedToDiscordLimits,
  DISCORD_RETRY_MAX_WAIT_MS,
  type NotifyDeps,
  type NotifyEvent,
  notify,
  notifyBestEffort,
} from "../../f/factory/lib/discord.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const WEBHOOK_URL = "https://discord.example/webhooks/1/super-secret-token";

const JOB_FAILED_EVENT: NotifyEvent = {
  kind: "job_failed",
  instance_name: "local",
  flow_path: "f/factory/poll_issues",
  job_id: "job-1",
  error: "boom",
};

type RecordedWarning = {
  readonly message: string;
  readonly fields: LogFields | undefined;
};

type FakeDiscord = {
  /** `fetch`・`sleep`・`log`をすべて偽にした依存。 */
  readonly deps: NotifyDeps;
  /** `log`を含まない依存。ロガーを別に渡す`notifyBestEffort`の検証に使う。 */
  readonly transport: NotifyDeps;
  readonly log: Logger;
  readonly requestCount: () => number;
  readonly sleeps: number[];
  readonly warnings: RecordedWarning[];
};

/**
 * 応答を順に返す偽のDiscordを作る。
 * 待ちは実際には待たずに長さだけを記録し、warnはメッセージとフィールドを記録する。
 * 応答を使い切った後は最後の応答を返し続ける。応答を作る関数が投げれば`fetch`も投げる。
 */
function fakeDiscord(responses: readonly (() => Response)[]): FakeDiscord {
  let count = 0;
  const sleeps: number[] = [];
  const warnings: RecordedWarning[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message, fields) => {
      warnings.push({ message, fields });
    },
    error: () => {},
  };
  const transport: NotifyDeps = {
    fetch: async () => {
      const next = responses[Math.min(count, responses.length - 1)];
      count += 1;
      if (next === undefined) throw new Error("no fake response configured");
      return next();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const deps: NotifyDeps = { ...transport, log };
  return {
    deps,
    transport,
    log,
    requestCount: () => count,
    sleeps,
    warnings,
  };
}

const rateLimitedWith = (
  headers: Record<string, string>,
  body: unknown,
): (() => Response) => {
  return () => jsonResponse(429, body, headers);
};

/** 偽の`fetch`が投げる例外。メッセージに実在する形式のwebhook URLを含める。 */
const networkFailure = () => {
  throw new Error(
    "connect failed: https://discord.com/api/webhooks/123/fake-webhook-token-value",
  );
};

const rateLimitedFor = (seconds: number) => () =>
  jsonResponse(
    429,
    { retry_after: seconds },
    { "retry-after": String(seconds) },
  );

const rateLimitedByBodyFor = (seconds: number) => () =>
  jsonResponse(429, { retry_after: seconds });

const ok = () => jsonResponse(204, {});

describe("buildEmbed host_action_required", () => {
  const event: NotifyEvent = {
    kind: "host_action_required",
    instance_name: "local",
    cause: "反映した版: abc。ホスト側の作業が要る変更を含みます",
    next_action: "mise run upを実行する",
  };

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe(
      "反映した版: abc。ホスト側の作業が要る変更を含みます",
    );
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "mise run upを実行する",
    });
  });

  test("includes the instance field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "インスタンス",
      value: "local",
    });
  });

  test("says the host needs work in the title", () => {
    expect(buildEmbed(event).title).toBe("ホスト側の作業が必要です");
  });
});

describe("buildEmbed job_failed", () => {
  test("shows the next action as a field when the event has one", () => {
    expect(
      buildEmbed({ ...JOB_FAILED_EVENT, next_action: "PRを確認してください" })
        .fields,
    ).toContainEqual({ name: "次の操作", value: "PRを確認してください" });
  });

  test("links the pull request when the event names one", () => {
    expect(
      buildEmbed({
        ...JOB_FAILED_EVENT,
        pr: { owner: "acme", repo: "widgets", number: 12 },
      }).url,
    ).toBe("https://github.com/acme/widgets/pull/12");
  });

  test("shows the pull request as the target when the event names one", () => {
    expect(
      buildEmbed({
        ...JOB_FAILED_EVENT,
        pr: { owner: "acme", repo: "widgets", number: 12 },
      }).fields,
    ).toContainEqual({ name: "対象", value: "acme/widgets#12" });
  });

  test("has no link when the event names no pull request", () => {
    expect(buildEmbed(JOB_FAILED_EVENT).url).toBeNull();
  });

  test("shows no target field when the event names no pull request", () => {
    expect(
      buildEmbed(JOB_FAILED_EVENT).fields.map((field) => field.name),
    ).not.toContain("対象");
  });

  test("shows no next action field when the event has none", () => {
    expect(
      buildEmbed(JOB_FAILED_EVENT).fields.map((field) => field.name),
    ).not.toContain("次の操作");
  });
});

describe("buildEmbed main_ci_failed", () => {
  const event: Extract<NotifyEvent, { kind: "main_ci_failed" }> = {
    kind: "main_ci_failed",
    instance_name: "local",
    owner: "acme",
    repo: "widgets",
    sha7: "abc1234",
    url: "https://github.com/acme/widgets/actions/runs/9",
    next_action: "実行のログを確かめて、原因を直す",
  };

  test("names the repository and the commit in the title", () => {
    expect(buildEmbed(event).title).toBe(
      "mainのCIが失敗しました: acme/widgets@abc1234",
    );
  });

  test("links to the run", () => {
    expect(buildEmbed(event).url).toBe(
      "https://github.com/acme/widgets/actions/runs/9",
    );
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "実行のログを確かめて、原因を直す",
    });
  });

  test("includes the repository field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "リポジトリ",
      value: "acme/widgets",
    });
  });

  test("names the commit in the description", () => {
    expect(buildEmbed(event).description).toBe(
      "mainのコミットabc1234でCIが失敗しました。",
    );
  });
});

describe("buildEmbed console_worker_missing", () => {
  const event: NotifyEvent = {
    kind: "console_worker_missing",
    instance_name: "local",
    cause: "Console用のworkerが居ません",
    next_action: "mise run upで起動し直す",
  };

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe("Console用のworkerが居ません");
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "mise run upで起動し直す",
    });
  });

  test("includes the instance field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "インスタンス",
      value: "local",
    });
  });

  test("says the worker does not take jobs in the title", () => {
    expect(buildEmbed(event).title).toBe(
      "Console用のworkerがジョブを受けていません",
    );
  });
});

describe("buildEmbed periodic_worker_missing", () => {
  const event: NotifyEvent = {
    kind: "periodic_worker_missing",
    instance_name: "local",
    cause: "定期ジョブ用のworkerが居ません",
    next_action: "mise run upで起動し直す",
  };

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe(
      "定期ジョブ用のworkerが居ません",
    );
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "mise run upで起動し直す",
    });
  });

  test("includes the instance field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "インスタンス",
      value: "local",
    });
  });

  test("says the worker does not take jobs in the title", () => {
    expect(buildEmbed(event).title).toBe(
      "定期ジョブ用のworkerがジョブを受けていません",
    );
  });
});

describe("buildEmbed console_worker_check_failed", () => {
  const event: NotifyEvent = {
    kind: "console_worker_check_failed",
    instance_name: "local",
    cause: "1時間続けて確認できていません",
    next_action: "ジョブログを確かめる",
  };

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe("1時間続けて確認できていません");
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "ジョブログを確かめる",
    });
  });

  test("includes the instance field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "インスタンス",
      value: "local",
    });
  });

  test("says the worker's activity cannot be checked in the title", () => {
    expect(buildEmbed(event).title).toBe(
      "Console用のworkerの動きを確かめられません",
    );
  });
});

describe("buildEmbed console_fetch_problem", () => {
  const event: NotifyEvent = {
    kind: "console_fetch_problem",
    instance_name: "local",
    cause: "トークンの期限が切れています",
    next_action: "トークンを再発行して投入する",
  };

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe("トークンの期限が切れています");
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "トークンを再発行して投入する",
    });
  });

  test("includes the instance field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "インスタンス",
      value: "local",
    });
  });

  test("has no link", () => {
    expect(buildEmbed(event).url).toBeNull();
  });

  test("names the console in the title", () => {
    expect(buildEmbed(event).title).toContain("Console");
  });
});

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
      worker_load: { kind: "no_record" },
      gated_review: { kind: "off" },
    });
    expect(embed.description).toBe("エージェント実行3件、$1.50消費。");
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
      worker_load: { kind: "no_record" },
      gated_review: { kind: "off" },
    });
    expect(embed.fields).toContainEqual({
      name: "DB掃除",
      value: "その日の掃除記録なし",
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
        info_notices_resolved: 0,
        main_ci_runs_deleted: 0,
        worker_samples_deleted: 0,
        pr_ci_checks_deleted: 0,
        doc_dirs_deleted: 0,
      },
      worker_load: { kind: "no_record" },
      gated_review: { kind: "off" },
    });
    expect(embed.fields).toContainEqual({
      name: "DB掃除",
      value:
        "work item 3件、失敗記録12件、デプロイ記録5件、通知2件を削除しました",
    });
  });

  test("shows no gated review field when reviews are posted", () => {
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
      worker_load: { kind: "no_record" },
      gated_review: { kind: "off" },
    });
    expect(embed.fields.map((f) => f.name)).not.toContain("レビューの投稿");
  });

  test("shows the unposted review count when the mode is gated", () => {
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
      worker_load: { kind: "no_record" },
      gated_review: {
        kind: "on",
        since: new Date("2026-09-22T03:00:00Z"),
        unposted_count: 4,
        elapsed_days: 3,
      },
    });
    expect(embed.fields).toContainEqual({
      name: "レビューの投稿",
      value: "gatedで有効。2026-09-22から3日、投稿しなかったレビューは4件",
    });
  });

  test("dates the unposted period by the JST day, not the UTC day", () => {
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
      worker_load: { kind: "no_record" },
      // 2026-09-21T20:00Zは、JSTでは2026-09-22の05:00
      gated_review: {
        kind: "on",
        since: new Date("2026-09-21T20:00:00Z"),
        unposted_count: 4,
        elapsed_days: 3,
      },
    });
    expect(embed.fields).toContainEqual({
      name: "レビューの投稿",
      value: "gatedで有効。2026-09-22から3日、投稿しなかったレビューは4件",
    });
  });

  test("shows no date while nothing was left unposted", () => {
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
      worker_load: { kind: "no_record" },
      gated_review: {
        kind: "on",
        since: null,
        unposted_count: 0,
        elapsed_days: null,
      },
    });
    expect(embed.fields).toContainEqual({
      name: "レビューの投稿",
      value: "gatedで有効。投稿しなかったレビューは0件",
    });
  });

  test("shows how to look into a failure to read the unposted reviews", () => {
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
      worker_load: { kind: "no_record" },
      gated_review: { kind: "read_failed" },
    });
    expect(
      embed.fields.find((f) => f.name === "レビューの投稿")?.value,
    ).toContain("読めませんでした");
  });

  test("shows a 'no record' worker load field when there is no record", () => {
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
      worker_load: { kind: "no_record" },
      gated_review: { kind: "off" },
    });
    expect(embed.fields).toContainEqual({
      name: "workerの負荷",
      value: "その日の記録なし(sample_worker_loadのスケジュールを確かめる)",
    });
  });

  test("shows a 'read failed' worker load field when the summary could not be read", () => {
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
      worker_load: { kind: "read_failed" },
      gated_review: { kind: "off" },
    });
    expect(embed.fields).toContainEqual({
      name: "workerの負荷",
      value:
        "集計を読めませんでした(`wmill job list --script-path f/factory/notify_daily_summary`で直近のジョブを探し、ログの警告を確認)",
    });
  });

  test("summarizes the worker load in its own field when present", () => {
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
      worker_load: {
        kind: "summary",
        summary: {
          sample_count: 700,
          expected_count: 720,
          lag_max_seconds: 5,
          lag_over_count: 0,
          lag_over_total_seconds: 0,
          gap_count: 0,
          gap_longest_seconds: null,
          gap_longest_from: null,
          gap_longest_to: null,
          running_jobs_max: 1,
          slots_max: 3,
          mem_anon_max_bytes: 100 * 1024 * 1024,
          mem_anon_max_ratio: 0.025,
          mem_working_set_max_bytes: 200 * 1024 * 1024,
          mem_oom_increase: 0,
          mem_oom_kill_increase: 0,
          max_wait_max_seconds: 0,
        },
      },
      gated_review: { kind: "off" },
    });
    expect(embed.fields).toContainEqual({
      name: "workerの負荷",
      value: [
        "記録700/720件(欠け3%)",
        "遅れ: 最大5秒、30秒以上0件(計0秒)",
        "空白: 4分超なし",
        "他のジョブの枠の使用: 最大1件(記録の枠を除く、上限2)",
        "メモリ: anon最大100MiB(上限の3%)、working set最大200MiB、OOMなし",
        "待ちの最長: 0秒以上",
      ].join("\n"),
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
      next_action: "Consoleの要対応で承認または却下してください",
    });
    expect(embed.fields).toContainEqual({
      name: "次の操作",
      value: "Consoleの要対応で承認または却下してください",
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
      next_action: "Consoleの要対応で承認または却下してください",
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
    expect(embed.description).toBe(
      "今回の指摘3件。状態: 修正必須の指摘が未解決(要修正)",
    );
  });

  test("states unresolved must findings even when this round has no findings", () => {
    const embed = buildEmbed({
      kind: "pr_reviewed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      verdict: "request_changes",
      finding_count: 0,
      result: "changes_requested",
    });
    expect(embed.description).toBe(
      "今回の指摘0件。状態: 修正必須の指摘が未解決(要修正)",
    );
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
    expect(embed.description).toBe(
      "今回の指摘0件。状態: 修正必須の指摘なし(人のApprove待ち)",
    );
  });

  test("states that unresolved findings could not be checked when the threads were unreadable", () => {
    const embed = buildEmbed({
      kind: "pr_reviewed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      verdict: "approve",
      finding_count: 0,
      result: "unverified",
    });
    expect(embed.description).toBe(
      "今回の指摘0件。状態: 未解決の指摘を読み取れず未確認(人がPRで確かめる)",
    );
  });

  test("does not call the state no-findings when non-blocking findings exist", () => {
    const embed = buildEmbed({
      kind: "pr_reviewed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      pr_number: 7,
      pr_url: "https://github.com/octo-owner/atelier-works/pull/7",
      verdict: "approve",
      finding_count: 1,
      result: "reviewed",
    });
    expect(embed.description).toBe(
      "今回の指摘1件。状態: 修正必須の指摘なし(人のApprove待ち)",
    );
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
      inbox_url: "http://127.0.0.1:8080/console/?approval=9",
    });
    expect(embed.url).toBe("http://127.0.0.1:8080/console/?approval=9");
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
      inbox_url: "http://127.0.0.1:8080/console/?approval=9",
    });
    expect(embed.fields).toContainEqual({
      name: "Issue",
      value: "https://github.com/octo-owner/atelier-works/issues/42",
    });
  });

  test("links the intake_refreshed embed to the issue and asks for a check", () => {
    const embed = buildEmbed({
      kind: "intake_refreshed",
      instance_name: "local",
      owner: "octo-owner",
      repo: "atelier-works",
      issue_number: 42,
      issue_url: "https://github.com/octo-owner/atelier-works/issues/42",
      title: "Add feature",
    });
    expect([embed.url, embed.description]).toEqual([
      "https://github.com/octo-owner/atelier-works/issues/42",
      "Issueが取り込み後に書き換えられたので、取り込み内容を現在のIssueで更新しました。Consoleの要対応で更新後の内容を確かめてから承認してください。",
    ]);
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
      console_url: "http://127.0.0.1:8080/console/items/7/requirements",
    });
    expect(embed.url).toBe(
      "http://127.0.0.1:8080/console/items/7/requirements",
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
      console_url: "http://127.0.0.1:8080/console/items/7/requirements",
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
      console_url: "http://127.0.0.1:8080/console/reports/audit/12",
      work_item_id: 12,
    });
    expect(embed.fields.map((f) => f.name)).toContain("次の操作");
  });

  test("audit_completed points to the inbox of the Console", () => {
    const embed = buildEmbed({
      kind: "audit_completed",
      instance_name: "local",
      period_label: "2026-09-22〜2026-09-28",
      proposal_count: 2,
      console_url: "http://127.0.0.1:8080/console/reports/audit/12",
      work_item_id: 12,
    });
    expect(embed.fields).toContainEqual({
      name: "次の操作",
      value: "Consoleの要対応で提案を承認または却下してください",
    });
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
    expect(embed.title).toBe("PR作成: #9(Issue #42)");
  });

  test("says the PR was updated in the title of an existing PR", () => {
    const embed = buildEmbed({ ...PR_OPENED_EVENT, created: false });
    expect(embed.title).toBe("PR更新: #9(Issue #42)");
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

  test("returns sent when the final response after a 429 retry is 2xx", async () => {
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
    ).resolves.toBe("sent");
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

  test("does not sleep when retry-after exceeds the cap by a fraction of a second", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 0.001),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([]);
  });

  test("waits a fractional retry-after in milliseconds", async () => {
    const discord = fakeDiscord([rateLimitedFor(0.5), ok]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([500]);
  });

  test("does not resend when retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.requestCount()).toBe(1);
  });

  test("returns rate_limit_skipped without throwing when retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await expect(
      notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps),
    ).resolves.toBe("rate_limit_skipped");
  });

  test("logs a warning when giving up because retry-after exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.warnings.map((warning) => warning.message)).toEqual([
      "discord notify skipped: rate limit wait exceeds cap",
    ]);
  });

  test("logs the event kind, the requested wait and the cap when giving up", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.warnings[0]?.fields).toEqual({
      kind: "job_failed",
      retry_after_ms: DISCORD_RETRY_MAX_WAIT_MS + 1000,
      max_wait_ms: DISCORD_RETRY_MAX_WAIT_MS,
    });
  });

  test("keeps the webhook URL and its token out of the warning fields", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(JSON.stringify(discord.warnings[0]?.fields)).not.toMatch(
      /discord\.example|super-secret-token/,
    );
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

describe("notify retry-after precedence", () => {
  test("prefers the retry-after header over retry_after in the body", async () => {
    const discord = fakeDiscord([
      rateLimitedWith({ "retry-after": "1" }, { retry_after: 100 }),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([1000]);
  });

  test("falls back to retry_after in the body when the header is not a number", async () => {
    const discord = fakeDiscord([
      rateLimitedWith({ "retry-after": "soon" }, { retry_after: 2 }),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([2000]);
  });

  test("falls back to retry_after in the body when the header is empty", async () => {
    const discord = fakeDiscord([
      rateLimitedWith({ "retry-after": "" }, { retry_after: 2 }),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([2000]);
  });

  test("falls back to retry_after in the body when the header is only whitespace", async () => {
    const discord = fakeDiscord([
      rateLimitedWith({ "retry-after": "   " }, { retry_after: 2 }),
      ok,
    ]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([2000]);
  });

  test("waits 1000ms when neither the header nor the body gives a wait", async () => {
    const discord = fakeDiscord([rateLimitedWith({}, {}), ok]);

    await notify(WEBHOOK_URL, JOB_FAILED_EVENT, discord.deps);

    expect(discord.sleeps).toEqual([1000]);
  });
});

describe("notifyBestEffort", () => {
  test("does not send anything when the webhook URL is empty", async () => {
    const discord = fakeDiscord([ok]);

    await notifyBestEffort("", JOB_FAILED_EVENT, discord.log, discord.deps);

    expect(discord.requestCount()).toBe(0);
  });

  test("returns no_webhook when the webhook URL is empty", async () => {
    const discord = fakeDiscord([ok]);

    const result = await notifyBestEffort(
      "",
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(result).toEqual({ status: "no_webhook" });
  });

  test("returns sent when Discord accepts the notification", async () => {
    const discord = fakeDiscord([ok]);

    const result = await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(result).toEqual({ status: "sent" });
  });

  test("does not throw when fetch throws", async () => {
    const discord = fakeDiscord([networkFailure]);

    await expect(
      notifyBestEffort(
        WEBHOOK_URL,
        JOB_FAILED_EVENT,
        discord.log,
        discord.deps,
      ),
    ).resolves.toMatchObject({ status: "not_sent" });
  });

  test("returns not_sent when Discord answers with a non-2xx status", async () => {
    const discord = fakeDiscord([() => jsonResponse(500, {})]);

    const result = await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(result).toEqual({
      status: "not_sent",
      reason: "Error: discord webhook failed: HTTP 500",
    });
  });

  test("returns not_sent when the retry is rate limited again", async () => {
    const discord = fakeDiscord([rateLimitedFor(1), rateLimitedFor(1)]);

    const result = await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(result).toEqual({
      status: "not_sent",
      reason: "Error: discord webhook failed: HTTP 429",
    });
  });

  test("returns not_sent when the rate limit wait exceeds the cap", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
    ]);

    const result = await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(result).toEqual({
      status: "not_sent",
      reason: "discord rate limit wait exceeds the 30s cap",
    });
  });

  test("logs the rate limit skip warning to the given logger", async () => {
    const discord = fakeDiscord([
      rateLimitedFor(DISCORD_RETRY_MAX_WAIT_MS / 1000 + 1),
    ]);

    await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.transport,
    );

    expect(discord.warnings.map((warning) => warning.message)).toEqual([
      "discord notify skipped: rate limit wait exceeds cap",
    ]);
  });

  test("logs a warning when the notification fails", async () => {
    const discord = fakeDiscord([networkFailure]);

    await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(discord.warnings.map((warning) => warning.message)).toEqual([
      "discord notify failed",
    ]);
  });

  test("masks secrets in the logged error", async () => {
    const discord = fakeDiscord([networkFailure]);

    await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(JSON.stringify(discord.warnings[0]?.fields)).not.toContain(
      "fake-webhook-token-value",
    );
  });

  test("masks secrets in the returned reason", async () => {
    const discord = fakeDiscord([networkFailure]);

    const result = await notifyBestEffort(
      WEBHOOK_URL,
      JOB_FAILED_EVENT,
      discord.log,
      discord.deps,
    );

    expect(JSON.stringify(result)).not.toContain("fake-webhook-token-value");
  });
});
