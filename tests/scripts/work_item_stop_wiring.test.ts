// 人が中止した作業項目を止める配線のテスト。
// - 失敗の処理(`on_error_flow.ts`)は保護の外にあるので、判定を保護したlibの関数だけに任せ、
//   早い戻りが失敗の記録より前の1か所にあることを、ソースの並びと振る舞いで固定する。
// - 動いているClaudeと検査を止める確認を、呼び出し側が差し替えられないことと、検査の呼び出しが作業項目を結ぶことを走査で固定する。
// - 人の中止の注記を書く文が、中止のscriptだけにあることと、取り消しへ移す呼び出しの注記が固定であることを走査で固定する。
// 検出は文字列の走査で、変数で組み立てた呼び出しなどは見つけられない。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { OPERATOR_CANCELLED_NOTE } from "../../f/factory/lib/operator_cancel.ts";
import type { FailureRecord, WorkItem } from "../../f/factory/lib/types.ts";
import {
  type FlowFailureDeps,
  type FlowFailureInput,
  handleFlowFailure,
} from "../../f/factory/on_error_flow.ts";

const ON_ERROR_FLOW = "f/factory/on_error_flow.ts";
const WORK_ITEM_STOP = "f/factory/lib/work_item_stop.ts";
const OPERATOR_CANCEL = "f/factory/lib/operator_cancel.ts";
const CANCEL_SCRIPT = "f/factory/console_work_item_cancel.ts";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

const F_FILES = listFiles("f");
const F_SOURCES = F_FILES.filter((path) => path.endsWith(".ts"));

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントと型を落としたJavaScript。変換できないソースは、元の文字列を返す。 */
function codeOf(source: string): string {
  try {
    return transpiler.transformSync(source);
  } catch {
    return source;
  }
}

function importSpecifiers(source: string): string[] {
  return transpiler
    .scanImports(source)
    .map((entry) => entry.path)
    .sort();
}

/** `needle`が最初に現れる位置。無ければ例外にして、テストの前提が崩れたことを知らせる。 */
function positionOf(text: string, needle: string): number {
  const position = text.indexOf(needle);
  if (position === -1) throw new Error(`not found in the source: ${needle}`);
  return position;
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** `open`の位置の開き括弧に対応する閉じ括弧の位置。文字列とテンプレートは読み飛ばす。 */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      i += 1;
      while (i < text.length && text[i] !== char) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parentheses");
}

/** 括弧の中身を、いちばん外側のカンマで分けた引数にする。 */
function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] ?? "";
    if (char === '"' || char === "'" || char === "`") {
      const start = i;
      i += 1;
      while (i < inner.length && inner[i] !== char) {
        if (inner[i] === "\\") i += 1;
        i += 1;
      }
      current += inner.slice(start, i + 1);
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

/** `name(`で始まる呼び出しの引数を、出てくる順にすべて返す。 */
function callsOf(text: string, name: RegExp): string[][] {
  const calls: string[][] = [];
  for (const match of text.matchAll(name)) {
    const open = match.index + match[0].length - 1;
    calls.push(splitArgs(text.slice(open + 1, closingParen(text, open))));
  }
  return calls;
}

describe("on_error_flow.ts", () => {
  const source = read(ON_ERROR_FLOW);
  const code = codeOf(source);
  const body = code.slice(code.indexOf("async function handleFlowFailure("));

  test("decides on a person's cancel only through shouldSilenceFailure", () => {
    expect(
      [
        "isOperatorCancelledNote",
        "OPERATOR_CANCELLED_NOTE",
        "isWorkItemStopped",
      ]
        .filter((name) => code.includes(name))
        .sort(),
    ).toEqual([]);
  });

  test("calls shouldSilenceFailure once", () => {
    expect(countOf(body, "shouldSilenceFailure(")).toBe(1);
  });

  test("leaves the log of the failure before the early return", () => {
    expect(positionOf(body, 'log.error("flow failed"')).toBeLessThan(
      positionOf(body, "shouldSilenceFailure("),
    );
  });

  test("returns early before the failure is recorded", () => {
    expect(positionOf(body, "shouldSilenceFailure(")).toBeLessThan(
      positionOf(body, "deps.recordFailure("),
    );
  });

  test("has one early return before the failure is recorded", () => {
    const before = body.slice(0, positionOf(body, "deps.recordFailure("));
    expect(countOf(before, "return")).toBe(1);
  });

  test("reads the note only for a cancelled work item", () => {
    expect(body).toMatch(/item\.status === "cancelled"/);
  });

  test("goes on to the notification when the note cannot be read", () => {
    expect(body).toContain('kind: "unreadable"');
  });

  test("hands the raw values to the judgement", () => {
    const [args] = callsOf(body, /shouldSilenceFailure\(/g);
    expect(args?.join("")).toMatch(/rowFlowJobId/);
  });
});

// ---- 失敗の処理の振る舞い ----

const DATE = new Date("2026-11-13T00:00:00Z");
const ROOT_JOB = "0191f1a2-0000-7000-8000-000000000001";
const OTHER_JOB = "0191f1a2-0000-7000-8000-000000000002";
const IMPLEMENT_PATH = "f/factory/implement";

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "acme",
    repo: "widgets",
    issue_number: 3,
    issue_url: null,
    pr_number: null,
    title: null,
    body: null,
    status: "cancelled",
    attempt: 1,
    claimed_by: null,
    flow_job_id: ROOT_JOB,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 0,
    profile: "standard",
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

type World = {
  readonly item?: WorkItem | null;
  readonly note?: () => Promise<string | null>;
};

function fakeDeps(world: World = {}) {
  const calls: string[] = [];
  const failures: FailureRecord[] = [];
  const events: NotifyEvent[] = [];
  const errors: string[] = [];
  const log: Logger = {
    info: () => {},
    warn: () => {},
    error: (message) => {
      errors.push(message);
    },
  };
  const deps: FlowFailureDeps = {
    getWorkItem: async () =>
      world.item === undefined ? workItem() : world.item,
    recordFailure: async (record) => {
      calls.push("recordFailure");
      failures.push(record);
    },
    updateStatusIfLeaseHolder: async () => {
      calls.push("updateStatus");
      return true;
    },
    hasSupersedingPrReview: async () => false,
    findInvestigationByFlowJobId: async () => null,
    readCancelNote: world.note ?? (async () => OPERATOR_CANCELLED_NOTE),
    readInstanceName: async () => "test-instance",
    readWebhookUrl: async () => "https://discord.example/x",
    notify: async (_url, event) => {
      calls.push("notify");
      events.push(event);
    },
    log,
  };
  return { deps, calls, failures, events, errors };
}

function input(overrides: Partial<FlowFailureInput> = {}): FlowFailureInput {
  return {
    error: { message: "step failed", step_id: "implement_generate" },
    workItemId: 7,
    path: IMPLEMENT_PATH,
    jobId: undefined,
    rootJobId: ROOT_JOB,
    currentJobId: null,
    ...overrides,
  };
}

describe("handleFlowFailure for a work item that a person cancelled", () => {
  test("records no failure and sends no notification", async () => {
    const fake = fakeDeps();
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toEqual([]);
  });

  test("leaves the failure in the log of the job", async () => {
    const fake = fakeDeps();
    await handleFlowFailure(fake.deps, input());
    expect(fake.errors).toEqual(["flow failed"]);
  });

  test("stays quiet for a pipeline run whose job id matches", async () => {
    const fake = fakeDeps();
    await handleFlowFailure(
      fake.deps,
      input({ path: "f/factory/pipeline", workItemId: 7 }),
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("handleFlowFailure for a work item that a person did not cancel", () => {
  test("records the failure of a work item that is still running", async () => {
    const fake = fakeDeps({ item: workItem({ status: "implementing" }) });
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toContain("recordFailure");
  });

  test("notifies the failure of a work item that is still running", async () => {
    const fake = fakeDeps({ item: workItem({ status: "implementing" }) });
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toContain("notify");
  });

  test("records and notifies when another cause cancelled the work item", async () => {
    const fake = fakeDeps({
      note: async () => "reconcile: pr_closed (actionable)",
    });
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toEqual(["recordFailure", "notify"]);
  });

  test("records and notifies when the note cannot be read", async () => {
    const fake = fakeDeps({
      note: async () => {
        throw new Error("db down");
      },
    });
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toEqual(["recordFailure", "notify"]);
  });

  test("records and notifies when the work item belongs to another run", async () => {
    const fake = fakeDeps({ item: workItem({ flow_job_id: OTHER_JOB }) });
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toEqual(["recordFailure", "notify"]);
  });

  test("records and notifies a pipeline run that the work item has not recorded", async () => {
    const fake = fakeDeps({ item: workItem({ flow_job_id: null }) });
    await handleFlowFailure(fake.deps, input({ path: "f/factory/pipeline" }));
    expect(fake.calls).toEqual(["recordFailure", "notify"]);
  });

  test("records and notifies when there is no work item row", async () => {
    const fake = fakeDeps({ item: null });
    await handleFlowFailure(fake.deps, input());
    expect(fake.calls).toEqual(["recordFailure", "notify"]);
  });
});

// ---- 動いているClaudeと検査を止める確認 ----

describe("the checks that stop a running Claude and a running check", () => {
  test("is not given by any file in f/ as workItemStopCheck", () => {
    const given = F_SOURCES.filter((path) =>
      /\bworkItemStopCheck\s*:/.test(codeOf(read(path))),
    );
    expect(given).toEqual([]);
  });

  test("is not given by any file in f/ as workItemCheck", () => {
    const given = F_SOURCES.filter((path) =>
      /\bworkItemCheck\s*:/.test(codeOf(read(path))),
    );
    expect(given).toEqual([]);
  });

  test("is made by runClaude from the work item id of its own options", () => {
    expect(codeOf(read("f/factory/lib/claude.ts"))).toContain(
      "defaultWorkItemStopCheck(opts.workItemId)",
    );
  });

  test("is made by the check runner from the work item id of its own options", () => {
    expect(codeOf(read("f/factory/lib/check_runner.ts"))).toContain(
      "defaultWorkItemStopCheck(stop.workItemId)",
    );
  });
});

// `workItemId: null`で呼んでよいファイル。作業項目に結ばない検査を、明示して使うときだけである。
const NULL_WORK_ITEM_ALLOWED: readonly string[] = [];

describe("the calls of runAllowedCheckCommands", () => {
  const callers = F_SOURCES.filter((path) => {
    if (path === "f/factory/lib/check_runner.ts") return false;
    return /\brunAllowedCheckCommands\b/.test(codeOf(read(path)));
  });

  test("are made only by the files that this test lists", () => {
    expect(callers).toEqual([
      "f/factory/steps/dependabot_prepare.ts",
      "f/factory/steps/implement_verify.ts",
      "f/factory/steps/pr_fix_verify.ts",
    ]);
  });

  test("pass the work item id in every direct call", () => {
    const withoutId = callers.flatMap((path) =>
      callsOf(codeOf(read(path)), /\brunAllowedCheckCommands\(/g)
        .filter((args) => !/\bworkItemId\b/.test(args.slice(7).join(",")))
        .map(() => path),
    );
    expect(withoutId).toEqual([]);
  });

  test("pass the work item id in the call through the installer deps", () => {
    const code = codeOf(read("f/factory/steps/dependabot_prepare.ts"));
    const calls = callsOf(code, /\brunChecks\(/g);
    expect(
      calls.filter((args) => !/\bworkItemId\b/.test(args.slice(7).join(","))),
    ).toEqual([]);
  });

  test("use workItemId: null only in the files that this test allows", () => {
    const using = F_SOURCES.filter((path) =>
      /\bworkItemId\s*:\s*null\b/.test(codeOf(read(path))),
    );
    expect(
      using.filter((path) => !NULL_WORK_ITEM_ALLOWED.includes(path)),
    ).toEqual([]);
  });
});

// ---- 人の中止の注記 ----

describe("the note of a cancel by a person", () => {
  test("is written as a string only in the library that owns it", () => {
    const writing = F_SOURCES.filter((path) =>
      read(path).includes("console: operator_cancelled"),
    );
    expect(writing).toEqual([OPERATOR_CANCEL]);
  });

  test("is put into a SQL template only by the script that cancels", () => {
    const interpolating = F_SOURCES.filter((path) =>
      /\$\{OPERATOR_CANCELLED_NOTE\}/.test(read(path)),
    );
    expect(interpolating).toEqual([CANCEL_SCRIPT]);
  });

  test("is a fixed text", () => {
    expect(OPERATOR_CANCELLED_NOTE).toBe("console: operator_cancelled");
  });
});

/** 取り消しへ移す呼び出しの、注記の式を、`ファイル: 式`の形で返す。 */
function cancelNoteExpressions(): string[] {
  const found: string[] = [];
  for (const path of F_SOURCES) {
    const code = codeOf(read(path));
    for (const args of callsOf(
      code,
      /\b(?:updateStatus\w*|moveFromDesigning)\(/g,
    )) {
      if (!args.some((arg) => arg === '"cancelled"')) continue;
      const note = args[args.length - 1] ?? "";
      found.push(`${path}: ${note.replace(/\s+/g, " ")}`);
    }
  }
  return found.sort();
}

describe("the calls that move a work item into the cancelled state", () => {
  // 注記が式(変数)の呼び出しは、その出どころが固定の文であることを、足すときに確かめる。
  test("are the ones that this test lists, each with a fixed note", () => {
    expect(cancelNoteExpressions()).toEqual([
      "f/factory/poll_issues.ts: note",
      "f/factory/steps/dependabot_finish.ts: note",
      "f/factory/steps/design_prepare.ts: ".concat(
        '"issue closed before design started"',
      ),
      "f/factory/steps/implement_finish.ts: note",
      "f/factory/steps/investigate_generate.ts: ".concat(
        '"investigation disabled"',
      ),
      "f/factory/steps/investigate_post.ts: note",
      "f/factory/steps/investigate_prepare.ts: ".concat(
        '"investigation disabled"',
      ),
      "f/factory/steps/pipeline_prepare.ts: ".concat(
        '"issue closed before pipeline started"',
      ),
    ]);
  });
});

// ---- 依存の境界 ----

describe("the library that reads the work item", () => {
  test("does not import the database module", () => {
    expect(
      importSpecifiers(read(WORK_ITEM_STOP)).filter((path) =>
        /(^|\/)db(\.[cm]?[jt]s)?$/.test(path),
      ),
    ).toEqual([]);
  });

  test("imports only the modules that this test lists", () => {
    expect(importSpecifiers(read(WORK_ITEM_STOP))).toEqual([
      "./operator_cancel.ts",
      "./pipeline_lease.ts",
      "./stop_all.ts",
      "./stop_check.ts",
      "./types.ts",
      "windmill-client@1.817.0",
    ]);
  });

  test("keeps the table of the cancellable states free of imports", () => {
    expect(importSpecifiers(read(OPERATOR_CANCEL))).toEqual([]);
  });

  test("is not imported by the script that cancels", () => {
    expect(
      importSpecifiers(read(CANCEL_SCRIPT)).filter((path) =>
        /work_item_stop|stop_check|(^|\/)db(\.[cm]?[jt]s)?$/.test(path),
      ),
    ).toEqual([]);
  });
});
