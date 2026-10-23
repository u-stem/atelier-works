// Console(console/)の書き込みの呼び出しが、backendのscriptと食い違わないことを確かめる。
// 両者の型は別々に書かれているので、片方だけを変えたときにここで落とす。
// - 許可リストの行き先は、tag: consoleの実在するscriptである。
// - 型付きの呼び出しが送る引数は、scriptの入力(schema)の項目と必須の項目に合う。
// - 各scriptの戻りは、Consoleの型ガードを通る。
// - Consoleの画面は、許可リストを回避する生の呼び出しを使わない。

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import {
  AUDIT_SKIP_REASONS,
  type AuditSkipReason,
  isApprovalDecideResult,
  isAuditKickoffResult,
  isManualIntakeSubmitResult,
  isNoticeResolveResult,
  isRetryWorkItemResult,
  MANUAL_INTAKE_REFUSAL_REASONS,
  type ManualIntakeRefusalReason,
  type ManualIntakeSubmitResult,
  type NoticeResolveResult,
  type RetryWorkItemResult,
} from "../../console/src/api/guards/writeResults.ts";
import {
  type FetchLike,
  isScriptName,
  SCRIPT_PATHS,
} from "../../console/src/api/windmill.ts";
import * as consoleWrites from "../../console/src/api/writes.ts";
import { describeIntakeRefusal } from "../../console/src/lib/intakeRefusal.ts";
import * as approvalScript from "../../f/factory/approval_decide.ts";
import type * as auditKickoff from "../../f/factory/audit_kickoff.ts";
import {
  type AuditKickoffSkip,
  decideAuditKickoff,
} from "../../f/factory/lib/audit_support.ts";
import * as manualIntakeSupport from "../../f/factory/lib/manual_intake_support.ts";
import type { Notice } from "../../f/factory/lib/types.ts";
import * as manualIntakeSubmit from "../../f/factory/manual_intake_submit.ts";
import * as noticeResolve from "../../f/factory/notice_resolve.ts";
import * as retryScript from "../../f/factory/retry_work_item.ts";

type WriteScript =
  | "approval_decide"
  | "retry_work_item"
  | "audit_kickoff"
  | "manual_intake_submit"
  | "notice_resolve";

const WRITE_SCRIPTS: WriteScript[] = [
  "approval_decide",
  "retry_work_item",
  "audit_kickoff",
  "manual_intake_submit",
  "notice_resolve",
];

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ScriptSchema = {
  readonly properties: readonly string[];
  readonly required: readonly string[];
};

async function schemaOf(scriptPath: string): Promise<ScriptSchema> {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(`${scriptPath}.script.yaml`).text(),
  );
  if (!isRecord(parsed) || !isRecord(parsed.schema)) {
    throw new Error(`${scriptPath}: no schema`);
  }
  const { properties, required } = parsed.schema;
  return {
    properties: isRecord(properties) ? Object.keys(properties) : [],
    required: Array.isArray(required)
      ? required.filter((item): item is string => typeof item === "string")
      : [],
  };
}

type Sent = { readonly url: string; readonly body: Record<string, unknown> };

/** 型付きの呼び出しが、実際に送る行き先と引数を取り出す。結果は読まない。 */
async function sentBy(
  call: (fetchFn: FetchLike) => Promise<unknown>,
): Promise<Sent> {
  let sent: Sent | null = null;
  const fetchFn: FetchLike = (input, init) => {
    const body: unknown = JSON.parse(String(init.body));
    sent = { url: input, body: isRecord(body) ? body : {} };
    return Promise.resolve(new Response("null"));
  };
  await call(fetchFn).catch(() => undefined);
  if (sent === null) throw new Error("no request was sent");
  return sent;
}

const WRAPPER_CALLS: Readonly<
  Record<WriteScript, (fetchFn: FetchLike) => Promise<unknown>>
> = {
  approval_decide: (fetchFn) =>
    consoleWrites.decideApproval(
      { approvalRequestId: 3, decision: "approve", reason: "" },
      { fetchFn },
    ),
  retry_work_item: (fetchFn) => consoleWrites.retryWorkItem(7, { fetchFn }),
  audit_kickoff: (fetchFn) => consoleWrites.kickoffAudit({ fetchFn }),
  manual_intake_submit: (fetchFn) =>
    consoleWrites.submitManualIntake(
      {
        owner: "octo-owner",
        repo: "widgets",
        title: "Add a widget",
        body: "Add a widget.",
        acceptanceCriteria: "",
      },
      { fetchFn },
    ),
  notice_resolve: (fetchFn) => consoleWrites.resolveNotice(4, { fetchFn }),
};

describe("allowlist", () => {
  test("holds the query and the five write scripts", () => {
    expect(Object.keys(SCRIPT_PATHS).sort()).toEqual(
      ["console_query", ...WRITE_SCRIPTS].sort(),
    );
  });

  test.each(Object.entries(SCRIPT_PATHS))(
    "%s points at a script that has tag: console",
    async (_name, path) => {
      expect(await Bun.file(`${path}.script.yaml`).text()).toMatch(
        /^tag: console$/m,
      );
    },
  );

  test("rejects the name of every script that is not on the list", async () => {
    const listed = new Set<string>(Object.values(SCRIPT_PATHS));
    const accepted: string[] = [];
    for await (const file of new Glob("f/**/*.script.yaml").scan(".")) {
      const path = file.replace(/\.script\.yaml$/, "");
      const basename = path.split("/").pop() ?? path;
      if (!listed.has(path) && isScriptName(basename)) accepted.push(path);
    }
    expect(accepted).toEqual([]);
  });

  test("rejects the path of every script, because only names are accepted", async () => {
    const accepted: string[] = [];
    for await (const file of new Glob("f/**/*.script.yaml").scan(".")) {
      const path = file.replace(/\.script\.yaml$/, "");
      if (isScriptName(path)) accepted.push(path);
    }
    expect(accepted).toEqual([]);
  });

  test("the scan sees scripts outside the list", async () => {
    const listed = new Set<string>(Object.values(SCRIPT_PATHS));
    let outside = 0;
    for await (const file of new Glob("f/**/*.script.yaml").scan(".")) {
      if (!listed.has(file.replace(/\.script\.yaml$/, ""))) outside += 1;
    }
    expect(outside).toBeGreaterThan(10);
  });
});

describe("what the typed calls send", () => {
  test.each(WRITE_SCRIPTS)("%s goes to its own script", async (name) => {
    const sent = await sentBy(WRAPPER_CALLS[name]);
    expect(sent.url).toBe(
      `/api/w/factory/jobs/run_wait_result/p/${SCRIPT_PATHS[name]}`,
    );
  });

  test.each(WRITE_SCRIPTS)(
    "%s sends only inputs the script declares",
    async (name) => {
      const sent = await sentBy(WRAPPER_CALLS[name]);
      const { properties } = await schemaOf(SCRIPT_PATHS[name]);
      expect(
        Object.keys(sent.body).filter((key) => !properties.includes(key)),
      ).toEqual([]);
    },
  );

  test.each(WRITE_SCRIPTS)(
    "%s sends every input the script requires",
    async (name) => {
      const sent = await sentBy(WRAPPER_CALLS[name]);
      const { required } = await schemaOf(SCRIPT_PATHS[name]);
      expect(required.filter((key) => !(key in sent.body))).toEqual([]);
    },
  );

  test("approval_decide has no input that names the approver", async () => {
    const { properties } = await schemaOf(SCRIPT_PATHS.approval_decide);
    expect([...properties].sort()).toEqual([
      "approval_request_id",
      "decision",
      "note",
      "options",
      "reason",
    ]);
  });

  test("notice_resolve has no input that names the resolver", async () => {
    const { properties } = await schemaOf(SCRIPT_PATHS.notice_resolve);
    expect(properties).toEqual(["notice_id"]);
  });

  test("manual_intake_submit has no input that names the actor", async () => {
    const { properties } = await schemaOf(SCRIPT_PATHS.manual_intake_submit);
    expect([...properties].sort()).toEqual([
      "acceptance_criteria",
      "body",
      "owner",
      "repo",
      "title",
    ]);
  });

  test("manual_intake_submit requires the inputs the flow requires", async () => {
    const { required } = await schemaOf(SCRIPT_PATHS.manual_intake_submit);
    expect([...required].sort()).toEqual(["body", "owner", "repo", "title"]);
  });

  test("audit_kickoff runs as a manual run without force", async () => {
    const sent = await sentBy(WRAPPER_CALLS.audit_kickoff);
    expect(sent.body).toMatchObject({ force: false, source: "manual" });
  });
});

describe("what the scripts return", () => {
  const NOTICE: Notice = {
    id: 4,
    kind: "cleanup_db_failed",
    message: "m",
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    created_at: new Date("2026-10-01T00:00:00.000Z"),
  };

  function noticeDeps(notice: Notice): noticeResolve.NoticeResolveDeps {
    return {
      deriveApprover: () => "operator",
      getNoticeById: () => Promise.resolve(notice),
      resolveNoticeIfUnresolved: () => Promise.resolve(true),
    };
  }

  test("notice_resolve resolving a notice passes the guard", async () => {
    const result = await noticeResolve.resolveNotice(4, noticeDeps(NOTICE));
    expect(isNoticeResolveResult(result)).toBe(true);
  });

  test("notice_resolve on a resolved notice passes the guard", async () => {
    const result = await noticeResolve.resolveNotice(
      4,
      noticeDeps({ ...NOTICE, resolved: true }),
    );
    expect(isNoticeResolveResult(result)).toBe(true);
  });

  test("retry_work_item recording the job passes the guard", () => {
    expect(
      isRetryWorkItemResult(retryScript.retryResult("implementing", JOB, true)),
    ).toBe(true);
  });

  test("retry_work_item that lost the lease passes the guard", () => {
    expect(
      isRetryWorkItemResult(
        retryScript.retryResult("implementing", JOB, false),
      ),
    ).toBe(true);
  });

  test.each(["approve", "reject"] as const)(
    "approval_decide's result for %s passes the guard",
    (decision) => {
      expect(
        isApprovalDecideResult(
          approvalScript.buildApprovalDecideResult(decision, JOB),
        ),
      ).toBe(true);
    },
  );

  function skipReasonsOfDecide(): AuditKickoffSkip[] {
    const period = {
      start: new Date("2026-10-01T00:00:00.000Z"),
      end: new Date("2026-10-08T00:00:00.000Z"),
      unaudited_gap_days: 0,
    };
    const base = {
      activeAuditCount: 0,
      period,
      force: false,
      counts: null,
      budgetExceeded: false,
    };
    const decisions = [
      decideAuditKickoff({ ...base, activeAuditCount: 1 }),
      decideAuditKickoff({ ...base, period: null }),
      decideAuditKickoff({ ...base, budgetExceeded: true }),
      decideAuditKickoff(base),
    ];
    return decisions.flatMap((decision) =>
      decision.action === "skip" ? [decision.reason] : [],
    );
  }

  test("every skip reason of the audit decision passes the guard", () => {
    expect(
      skipReasonsOfDecide().every((reason) =>
        isAuditKickoffResult({ skipped: true, reason }),
      ),
    ).toBe(true);
  });

  test("the audit decision yields all the skip reasons but the race", () => {
    expect(skipReasonsOfDecide().sort()).toEqual(
      AUDIT_SKIP_REASONS.filter(
        (reason) => reason !== "concurrent_kickoff",
      ).sort(),
    );
  });

  test("the console refusal reasons are the backend refusal reasons", () => {
    expect([...MANUAL_INTAKE_REFUSAL_REASONS]).toEqual([
      ...manualIntakeSupport.MANUAL_INTAKE_REFUSAL_REASONS,
    ]);
  });

  test.each(manualIntakeSupport.MANUAL_INTAKE_REFUSAL_REASONS)(
    "the refusal %s passes the guard",
    (reason) => {
      expect(isManualIntakeSubmitResult({ refused: true, reason })).toBe(true);
    },
  );

  test.each(manualIntakeSupport.MANUAL_INTAKE_REFUSAL_REASONS)(
    "the refusal %s has a Japanese sentence",
    (reason) => {
      expect(describeIntakeRefusal(reason)).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    },
  );

  test("a refusal from the real validation passes the guard", async () => {
    const result = await manualIntakeSubmit.submitManualIntake(
      {
        owner: "stranger",
        repo: "widgets",
        title: "t",
        body: "b",
        acceptance_criteria: "",
      },
      {
        loadConfig: () =>
          Promise.resolve({
            owners: [],
            repo_allowlist: [],
            factory_repo: "https://github.com/octo-owner/atelier-works",
          }),
        deriveActor: () => "alice",
        runFlow: () => Promise.resolve(JOB),
        log: { info: () => undefined },
      },
    );
    expect(isManualIntakeSubmitResult(JSON.parse(JSON.stringify(result)))).toBe(
      true,
    );
  });

  test("a started flow passes the guard", async () => {
    const result = await manualIntakeSubmit.submitManualIntake(
      {
        owner: "octo-owner",
        repo: "widgets",
        title: "t",
        body: "b",
        acceptance_criteria: "",
      },
      {
        loadConfig: () =>
          Promise.resolve({
            owners: [{ name: "octo-owner", kind: "user" }],
            repo_allowlist: [],
            factory_repo: "https://github.com/octo-owner/atelier-works",
          }),
        deriveActor: () => "alice",
        runFlow: () => Promise.resolve(JOB),
        log: { info: () => undefined },
      },
    );
    expect(isManualIntakeSubmitResult(JSON.parse(JSON.stringify(result)))).toBe(
      true,
    );
  });

  test("a started audit passes the guard", () => {
    const started: auditKickoff.AuditKickoffResult = {
      skipped: false,
      work_item_id: 12,
      flow_job_id: JOB,
      period_label: "2026-10-01〜2026-10-07",
    };
    expect(isAuditKickoffResult(started)).toBe(true);
  });
});

// 型の食い違いは、実行より前に型検査で落ちる。
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describe("types", () => {
  test("the console skip reasons are the backend skip reasons", () => {
    const equal: Equal<
      AuditSkipReason,
      Extract<auditKickoff.AuditKickoffResult, { skipped: true }>["reason"]
    > = true;
    expect(equal).toBe(true);
  });

  test("the console refusal reasons are the backend refusal reasons as types", () => {
    const equal: Equal<
      ManualIntakeRefusalReason,
      manualIntakeSupport.ManualIntakeRefusalReason
    > = true;
    expect(equal).toBe(true);
  });

  test("the console manual intake result is the backend result", () => {
    const equal: Equal<
      ManualIntakeSubmitResult,
      manualIntakeSubmit.ManualIntakeSubmitResult
    > = true;
    expect(equal).toBe(true);
  });

  test("the console notice result is the backend notice result", () => {
    const equal: Equal<NoticeResolveResult, noticeResolve.NoticeResolveResult> =
      true;
    expect(equal).toBe(true);
  });

  test("a backend retry result is a console retry result", () => {
    const backend: retryScript.RetryWorkItemResult = retryScript.retryResult(
      "implementing",
      JOB,
      true,
    );
    const consoleSide: RetryWorkItemResult = backend;
    expect(isRetryWorkItemResult(consoleSide)).toBe(true);
  });
});

async function consoleSourcesOutsideApi(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of new Glob("console/src/**/*.{ts,tsx}").scan(".")) {
    if (!file.startsWith("console/src/api/")) files.push(file);
  }
  return files.sort();
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

/**
 * src/apiの外でfetchを呼んでよいファイル。Windmillのscriptの呼び出しではない。
 * 検出するのは、fetch()、globalThis.fetch、window.fetch、self.fetch、XMLHttpRequest、sendBeaconである。
 * 見ないもの: fetchを別名に代入してから呼ぶ形、動的に組み立てた識別子、WebSocketとEventSource。
 */
const FETCH_LIKE =
  /(?<![.\w])fetch\s*\(|\b(?:globalThis|window|self)\s*\.\s*fetch\b|XMLHttpRequest|sendBeacon/;

const FETCH_OUTSIDE_API = ["console/src/useReleaseWatch.ts"];

describe("api boundary", () => {
  test("only src/api imports the raw script runner", async () => {
    const importers: string[] = [];
    for (const file of await consoleSourcesOutsideApi()) {
      const source = await Bun.file(file).text();
      if (/from\s+["'][^"']*\/windmill(?:\.ts)?["']/.test(source)) {
        importers.push(file);
      }
    }
    expect(importers).toEqual([]);
  });

  test("nothing outside src/api writes the run_wait_result path by hand", async () => {
    const offenders: string[] = [];
    for (const file of await consoleSourcesOutsideApi()) {
      if (isTestFile(file)) continue;
      const source = await Bun.file(file).text();
      if (/run_wait_result|["'`]\/api\/w\//.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("nothing outside src/api calls fetch, except the listed files", async () => {
    const offenders: string[] = [];
    for (const file of await consoleSourcesOutsideApi()) {
      if (isTestFile(file) || FETCH_OUTSIDE_API.includes(file)) continue;
      const source = await Bun.file(file).text();
      if (FETCH_LIKE.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("the listed fetch callers exist", async () => {
    const present = await Promise.all(
      FETCH_OUTSIDE_API.map((file) => Bun.file(file).exists()),
    );
    expect(present.every(Boolean)).toBe(true);
  });

  test("nothing re-exports the runner or the allowlist", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("console/src/**/*.{ts,tsx}").scan(".")) {
      if (isTestFile(file) || file === "console/src/api/windmill.ts") continue;
      const source = await Bun.file(file).text();
      const reexport =
        /export\s+(?:type\s+)?\*\s+from\s+["'][^"']*\/windmill/.test(source) ||
        /export\s+(?:type\s+)?\{[^}]*\b(?:runScript|SCRIPT_PATHS)\b[^}]*\}/.test(
          source,
        ) ||
        /export\s+(?:const|let|var)\s+\w+\s*=\s*(?:runScript|SCRIPT_PATHS)\b/.test(
          source,
        );
      if (reexport) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
