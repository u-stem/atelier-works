import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type ApprovalDecideDeps,
  decideApproval,
  recordedDecisionRefusalMessage,
} from "../../f/factory/approval_decide.ts";
import {
  cancelStatement,
  cancelWorkItemFromConsole,
  readCancelTarget,
  WORK_ITEM_CANCEL_REFUSAL_REASONS,
  type WorkItemCancelPorts,
} from "../../f/factory/console_work_item_cancel.ts";
import type { ActionSqlClient } from "../../f/factory/lib/console_actions.ts";
import {
  OPERATOR_CANCEL_PR_ROW_KINDS,
  OPERATOR_CANCEL_WITHDRAWN_REQUEST_KINDS,
  OPERATOR_CANCELLED_NOTE,
  operatorCancellableStatuses,
} from "../../f/factory/lib/operator_cancel.ts";
import { FORBIDDEN_EXACT_PATHS } from "../../f/factory/lib/protected_paths.ts";
import type { ApprovalRequest } from "../../f/factory/lib/types.ts";
import { shouldProceed } from "../../f/factory/steps/requirements_apply.ts";
import {
  codeOf,
  datatableStringSql,
  envUses,
  escapeHatches,
  filesWithToolDependencies,
  relative,
  sdkViolationsReachableFrom,
  sourcesReachableFrom,
  writesSql,
} from "./worker_boundary_scan.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

type Call = { text: string; values: unknown[] };

function fakeSql(
  responses: readonly (Record<string, unknown>[] | Error)[],
  calls: Call[] = [],
  onCall: (call: Call) => void = () => undefined,
): ActionSqlClient {
  let index = 0;
  return (strings, ...values) => {
    const call = {
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    };
    calls.push(call);
    onCall(call);
    const response = responses[index] ?? [];
    index += 1;
    return {
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      execute: async () => {
        if (response instanceof Error) throw response;
      },
    };
  };
}

type Row = { id: number; kind: string; status: string };

type Harness = {
  readonly ports: WorkItemCancelPorts;
  readonly events: string[];
  readonly sqlCalls: Call[];
  readonly cancels: {
    id: number;
    kind: string;
    expected: string;
    allowed: readonly string[];
  }[];
};

function harness(
  options: {
    row?: Row | null;
    readError?: unknown;
    cancel?: { cancelled: boolean; withdrawn: number; newer?: boolean } | Error;
    sql?: readonly (Record<string, unknown>[] | Error)[];
    actor?: () => string;
  } = {},
): Harness {
  const events: string[] = [];
  const sqlCalls: Call[] = [];
  const cancels: Harness["cancels"] = [];
  const ports: WorkItemCancelPorts = {
    deriveActor: options.actor ?? (() => "operator"),
    readWorkItem: async (id) => {
      events.push(`read:${String(id)}`);
      if (options.readError !== undefined) throw options.readError;
      return options.row === undefined
        ? { id, kind: "issue", status: "awaiting_approval" }
        : options.row;
    },
    cancelIfCurrent: async (input) => {
      events.push("cancel");
      cancels.push({ ...input, allowed: [...input.allowed] });
      const outcome = options.cancel ?? { cancelled: true, withdrawn: 1 };
      if (outcome instanceof Error) throw outcome;
      return { newer: false, ...outcome };
    },
    sql: fakeSql(
      options.sql ?? [[{ id: 5 }], [{ id: 5 }]],
      sqlCalls,
      (call) => {
        events.push(call.text.startsWith("INSERT") ? "insert" : "update");
      },
    ),
  };
  return { ports, events, sqlCalls, cancels };
}

describe("cancelWorkItemFromConsole", () => {
  test("cancels a work item that waits for an approval", async () => {
    const { ports } = harness();
    expect(await cancelWorkItemFromConsole(7, ports)).toEqual({
      found: true,
      refused: false,
      work_item_id: 7,
      from_status: "awaiting_approval",
      withdrawn_approval_requests: 1,
      action_audit: "recorded",
    });
  });

  test("reads the row, records, cancels and records the outcome, in that order", async () => {
    const { ports, events } = harness();
    await cancelWorkItemFromConsole(7, ports);
    expect(events).toEqual(["read:7", "insert", "cancel", "update"]);
  });

  test("compares against the state it read and the states the kind allows", async () => {
    const { ports, cancels } = harness({
      row: { id: 7, kind: "pr_fix", status: "failed" },
    });
    await cancelWorkItemFromConsole(7, ports);
    expect(cancels).toEqual([
      {
        id: 7,
        kind: "pr_fix",
        expected: "failed",
        allowed: [...operatorCancellableStatuses("pr_fix")],
      },
    ]);
  });

  test("records the work item, its kind and the state it left", async () => {
    const { ports, sqlCalls } = harness({
      row: { id: 7, kind: "pr_fix", status: "failed" },
    });
    await cancelWorkItemFromConsole(7, ports);
    expect(sqlCalls[0]?.values.slice(0, 4)).toEqual([
      "operator",
      "work_item_cancel",
      "work_item:7",
      JSON.stringify({
        work_item_id: 7,
        kind: "pr_fix",
        from_status: "failed",
      }),
    ]);
  });

  test("records how many approval requests it withdrew", async () => {
    const { ports, sqlCalls } = harness({
      cancel: { cancelled: true, withdrawn: 2 },
    });
    await cancelWorkItemFromConsole(7, ports);
    expect(sqlCalls[1]?.values.slice(0, 2)).toEqual([
      "succeeded",
      JSON.stringify({ withdrawn_approval_requests: 2 }),
    ]);
  });

  test("answers that there is no such work item when the row is missing", async () => {
    const { ports } = harness({ row: null });
    expect(await cancelWorkItemFromConsole(7, ports)).toEqual({
      found: false,
    });
  });

  test("does not record or cancel when the row is missing", async () => {
    const { ports, events } = harness({ row: null });
    await cancelWorkItemFromConsole(7, ports);
    expect(events).toEqual(["read:7"]);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "answers that there is no such work item for the id %p without reading",
    async (id) => {
      const { ports, events } = harness();
      const result = await cancelWorkItemFromConsole(id, ports);
      expect([result, events]).toEqual([{ found: false }, []]);
    },
  );

  test("refuses a work item whose state is not on the table", async () => {
    const { ports } = harness({
      row: { id: 7, kind: "issue", status: "implementing" },
    });
    expect(await cancelWorkItemFromConsole(7, ports)).toEqual({
      found: true,
      refused: true,
      reason: "not_cancellable",
    });
  });

  test("refuses a work item that is already cancelled", async () => {
    const { ports } = harness({
      row: { id: 7, kind: "issue", status: "cancelled" },
    });
    expect(await cancelWorkItemFromConsole(7, ports)).toMatchObject({
      reason: "not_cancellable",
    });
  });

  test("refuses a kind it does not know", async () => {
    const { ports } = harness({
      row: { id: 7, kind: "something", status: "failed" },
    });
    expect(await cancelWorkItemFromConsole(7, ports)).toMatchObject({
      reason: "not_cancellable",
    });
  });

  test("does not record or cancel a work item that is not on the table", async () => {
    const { ports, events } = harness({
      row: { id: 7, kind: "pr_fix", status: "fixing" },
    });
    await cancelWorkItemFromConsole(7, ports);
    expect(events).toEqual(["read:7"]);
  });

  test("refuses when the operator cannot be determined, without recording or cancelling", async () => {
    const { ports, events } = harness({
      actor: () => {
        throw new Error("no operator");
      },
    });
    const result = await cancelWorkItemFromConsole(7, ports);
    expect([result, events]).toEqual([
      { found: true, refused: true, reason: "actor_unknown" },
      ["read:7"],
    ]);
  });

  test("refuses when the record cannot be written, without cancelling", async () => {
    const { ports, events } = harness({ sql: [new Error("db down")] });
    const result = await cancelWorkItemFromConsole(7, ports);
    expect([result, events]).toEqual([
      { found: true, refused: true, reason: "audit_unavailable" },
      ["read:7", "insert"],
    ]);
  });

  test("refuses when the state changed after it was read", async () => {
    const { ports } = harness({ cancel: { cancelled: false, withdrawn: 0 } });
    expect(await cancelWorkItemFromConsole(7, ports)).toEqual({
      found: true,
      refused: true,
      reason: "status_changed",
    });
  });

  test("records a lost compare as a failure", async () => {
    const { ports, sqlCalls } = harness({
      cancel: { cancelled: false, withdrawn: 0 },
    });
    await cancelWorkItemFromConsole(7, ports);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("marks the record as failed and throws when the cancel throws", async () => {
    const boom = new Error("db down");
    const { ports, sqlCalls } = harness({ cancel: boom });
    await expect(cancelWorkItemFromConsole(7, ports)).rejects.toBe(boom);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("still cancels when the outcome cannot be recorded, and says so", async () => {
    const { ports } = harness({ sql: [[{ id: 5 }], new Error("db down")] });
    expect(await cancelWorkItemFromConsole(7, ports)).toMatchObject({
      refused: false,
      action_audit: "failed",
    });
  });

  test("throws a failure to read the row", async () => {
    const boom = new Error("db down");
    const { ports } = harness({ readError: boom });
    await expect(cancelWorkItemFromConsole(7, ports)).rejects.toBe(boom);
  });

  test("refuses a row of a pull request that has a newer work item", async () => {
    const { ports } = harness({
      cancel: { cancelled: false, withdrawn: 0, newer: true },
    });
    expect(await cancelWorkItemFromConsole(7, ports)).toEqual({
      found: true,
      refused: true,
      reason: "newer_work_item",
    });
  });

  test("records the refusal of a row that is not the newest as a failure", async () => {
    const { ports, sqlCalls } = harness({
      cancel: { cancelled: false, withdrawn: 0, newer: true },
    });
    await cancelWorkItemFromConsole(7, ports);
    expect(sqlCalls[1]?.values[0]).toBe("failed");
  });

  test("lists every reason it refuses with", () => {
    expect([...WORK_ITEM_CANCEL_REFUSAL_REASONS].sort()).toEqual([
      "actor_unknown",
      "audit_unavailable",
      "newer_work_item",
      "not_cancellable",
      "status_changed",
    ]);
  });
});

describe("readCancelTarget", () => {
  test("reads the id, the kind and the state of the row", () => {
    expect(
      readCancelTarget({ id: "7", kind: "issue", status: "approved" }),
    ).toEqual({ id: 7, kind: "issue", status: "approved" });
  });

  // 行があるのに読めないときは、存在しない作業項目と取り違えないように投げる。
  test("throws on a row whose shape it cannot read", () => {
    expect(() =>
      readCancelTarget({ id: 7, kind: null, status: "approved" }),
    ).toThrow("console_work_item_cancel: the work item row has a shape");
  });
});

describe("cancelStatement", () => {
  const input = {
    id: 7,
    kind: "issue",
    expected: "awaiting_approval",
    allowed: operatorCancellableStatuses("issue"),
  };

  function statementOf(): Call {
    const calls: Call[] = [];
    // 文の形だけを見るので、空の結果を読めない例外は捨てる。
    cancelStatement(fakeSql([[]], calls), input, {
      job_id: JOB,
      root_job_id: null,
    }).catch(() => undefined);
    const first = calls[0];
    if (first === undefined) throw new Error("no statement");
    return first;
  }

  test("compares the state against the one it read", () => {
    expect(statementOf().text).toContain("status = ?");
  });

  test("compares the state against the table of the kind", () => {
    expect(statementOf().text).toContain("status = ANY(?)");
  });

  test("passes the table of the kind as a value", () => {
    expect(statementOf().values).toContainEqual([
      ...operatorCancellableStatuses("issue"),
    ]);
  });

  test("withdraws only the pending approval requests of the work item", () => {
    expect(statementOf().text).toMatch(
      /UPDATE factory\.approval_requests SET status = 'expired', decided_at = now\(\) WHERE work_item_id IN \(SELECT id FROM updated\) AND status = 'pending' AND kind = ANY\(\?\)/,
    );
  });

  test("passes the kinds of the requests it withdraws as a value", () => {
    expect(statementOf().values).toContainEqual([
      ...OPERATOR_CANCEL_WITHDRAWN_REQUEST_KINDS,
    ]);
  });

  test("does not cancel a row of a pull request that has a newer work item", () => {
    expect(statementOf().text).toMatch(
      /AND NOT \(w\.kind = ANY\(\?\) AND EXISTS \(SELECT 1 FROM factory\.work_items AS n WHERE n\.id <> w\.id AND n\.pr_number = w\.pr_number AND lower\(n\.owner\) = lower\(w\.owner\) AND lower\(n\.repo\) = lower\(w\.repo\) AND \(n\.created_at, n\.id\) > \(w\.created_at, w\.id\)\)\)/,
    );
  });

  test("passes the kinds that are rows of a pull request as a value", () => {
    expect(statementOf().values).toContainEqual([
      ...OPERATOR_CANCEL_PR_ROW_KINDS,
    ]);
  });

  test("reads whether a newer work item kept the row from being cancelled", async () => {
    const result = await cancelStatement(
      fakeSql([[{ cancelled: 0, withdrawn: 0, newer: true }]]),
      input,
      { job_id: null, root_job_id: null },
    );
    expect(result).toEqual({ cancelled: false, withdrawn: 0, newer: true });
  });

  test("writes the fixed note of a cancel by a person", () => {
    expect(statementOf().values).toContain(OPERATOR_CANCELLED_NOTE);
  });

  test("records the job that cancelled the work item", () => {
    expect(statementOf().values).toContain(JOB);
  });

  test("moves the work item to cancelled", () => {
    expect(statementOf().text).toContain("SET status = 'cancelled'");
  });

  test("reads the result of the statement as whether it cancelled and how many it withdrew", async () => {
    const result = await cancelStatement(
      fakeSql([[{ cancelled: "1", withdrawn: "2", newer: false }]]),
      input,
      { job_id: null, root_job_id: null },
    );
    expect(result).toEqual({ cancelled: true, withdrawn: 2, newer: false });
  });

  test("reads no updated row as a lost compare", async () => {
    const result = await cancelStatement(
      fakeSql([[{ cancelled: 0, withdrawn: 0, newer: false }]]),
      input,
      { job_id: null, root_job_id: null },
    );
    expect(result).toEqual({ cancelled: false, withdrawn: 0, newer: false });
  });

  test("throws on a result it cannot read", async () => {
    await expect(
      cancelStatement(fakeSql([[{ cancelled: "x" }]]), input, {
        job_id: null,
        root_job_id: null,
      }),
    ).rejects.toThrow();
  });
});

// 中止と同じ文で期限切れにした承認依頼に、後から判断が来ても、作業項目は動かない。
describe("an approval that comes after the cancel", () => {
  const EXPIRED: ApprovalRequest = {
    id: 3,
    kind: "requirements",
    work_item_id: 7,
    subject_id: 11,
    status: "expired",
    payload: { attempt: 1 },
    decision_options: {},
    requested_at: new Date("2026-11-01T00:00:00.000Z"),
    expires_at: new Date("2026-11-08T00:00:00.000Z"),
    decided_at: new Date("2026-11-02T00:00:00.000Z"),
    decided_by: null,
    reason: null,
  };

  function decideDeps(events: string[]): ApprovalDecideDeps {
    return {
      getApprovalRequest: async () => EXPIRED,
      assertIssueMatchesIntake: async () => {
        events.push("issue_check");
      },
      deriveApprover: () => "operator",
      decideIfPending: async () => {
        events.push("record");
        return false;
      },
      runHandler: async () => {
        events.push("handler");
        return JOB;
      },
    };
  }

  const CALL = {
    approval_request_id: 3,
    decision: "approve" as const,
    reason: "",
    note: "",
    options: {},
  };

  test("is refused, because the request has expired", async () => {
    await expect(decideApproval(decideDeps([]), CALL)).rejects.toThrow(
      recordedDecisionRefusalMessage(3, "expired", "approved"),
    );
  });

  test("records nothing and starts no handler", async () => {
    const events: string[] = [];
    await decideApproval(decideDeps(events), CALL).catch(() => undefined);
    expect(events).toEqual([]);
  });

  // 判断が中止より先に記録されていたときは、処理先が作業項目を読み直し、取り消しを見て何もしない。
  test("does not move a cancelled work item in the requirements handler", () => {
    expect(shouldProceed("cancelled")).toBe(false);
  });
});

// Console用workerで動く書き込みなので、届く範囲を、このscriptに固有の検査で狭く固定する。
// どれも、共通の境界テスト(`console_worker_boundary.test.ts`)の許可表を広げずに足す、上乗せの検査である。
describe("what the work item cancel script reaches", () => {
  const SCRIPT = "f/factory/console_work_item_cancel";

  function templatesOf(source: string): string[] {
    return [...codeOf(source).matchAll(/`((?:[^`\\]|\\.)*)`/g)].map(
      (match) => match[1] ?? "",
    );
  }

  // 共通の境界テストと同じ数え方で、小文字の`insert into`、`update … set`、`delete from`も数える。
  const WRITE_WORDS = { test: writesSql };

  const OWN_SOURCE = readFileSync(`${SCRIPT}.ts`, "utf8");

  test("calls nothing of the SDK but the datatable", () => {
    expect(
      sdkViolationsReachableFrom(SCRIPT, {
        services: [],
        members: ["datatable"],
      }),
    ).toEqual([]);
  });

  test("reaches only files that are protected paths", () => {
    const unprotected = [...sourcesReachableFrom(SCRIPT).keys()]
      .map(relative)
      .filter((file) => !FORBIDDEN_EXACT_PATHS.includes(file));
    expect(unprotected).toEqual([]);
  });

  test("reaches no file or process tool", () => {
    expect(filesWithToolDependencies([SCRIPT])).toEqual([]);
  });

  test("reaches no escape hatch", () => {
    const offenders: string[] = [];
    for (const [file, source] of sourcesReachableFrom(SCRIPT)) {
      for (const found of escapeHatches(source)) {
        offenders.push(`${relative(file)}: ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("gives no SQL to the datatable as a string", () => {
    const offenders: string[] = [];
    for (const [file, source] of sourcesReachableFrom(SCRIPT)) {
      for (const found of datatableStringSql(source)) {
        offenders.push(`${relative(file)}: ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("reads no process environment but the operator and the job ids, and only in itself", () => {
    const allowed = [
      "WM_USERNAME",
      "WM_EMAIL",
      "WM_JOB_ID",
      "WM_ROOT_FLOW_JOB_ID",
    ];
    const offenders: string[] = [];
    for (const [file, source] of sourcesReachableFrom(SCRIPT)) {
      const found = envUses(source);
      const own = relative(file) === `${SCRIPT}.ts`;
      for (const problem of found.problems) {
        offenders.push(`${relative(file)}: ${problem}`);
      }
      for (const key of found.keys) {
        if (!own || !allowed.includes(key)) {
          offenders.push(`${relative(file)}: ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("names only the work item, approval request and transition tables in its own SQL", () => {
    const tables = templatesOf(OWN_SOURCE)
      .flatMap((text) => [...text.matchAll(/factory\.(\w+)/g)])
      .map((match) => match[1]);
    expect([...new Set(tables)].sort()).toEqual([
      "approval_requests",
      "work_item_events",
      "work_items",
    ]);
  });

  test("has a single statement of its own that writes", () => {
    expect(
      templatesOf(OWN_SOURCE).filter((text) => WRITE_WORDS.test(text)),
    ).toHaveLength(1);
  });

  test("counts a lowercase write as a write", () => {
    expect(
      [
        "insert into factory.x (a) values (1)",
        "update factory.x set a = 1",
        "delete from factory.x",
      ].filter((text) => WRITE_WORDS.test(text)),
    ).toHaveLength(3);
  });

  // 中止は行を消さず、表の形も権限も変えない。書く語は更新と挿入だけである。
  test("has no delete, schema change, grant, copy or call in its own SQL", () => {
    expect(
      templatesOf(OWN_SOURCE).filter((text) =>
        /\b(?:DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COPY|CALL)\b/i.test(text),
      ),
    ).toEqual([]);
  });

  test("writes through no file but itself and the record of the operations", () => {
    const writers = [...sourcesReachableFrom(SCRIPT).entries()]
      .filter(([, source]) =>
        templatesOf(source).some((text) => WRITE_WORDS.test(text)),
      )
      .map(([file]) => relative(file))
      .sort();
    expect(writers).toEqual([
      "f/factory/console_work_item_cancel.ts",
      "f/factory/lib/console_actions.ts",
    ]);
  });
});
