// 隔離の合格の関門を固定する。
// 保護パスに置く。判定を緩める変更や、差し替え口つきの入口を本番が使う変更が、このテストを書き換えて通らないようにするため。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeArgvShapeHash,
  ISOLATION_FINGERPRINT,
  PROBE_JUDGE_VERSION,
  PROBE_SCRIPT_PATH,
} from "../../f/factory/lib/investigate_isolation.ts";
import {
  checkIsolationProof,
  checkIsolationProofWithDeps,
  ISOLATION_GATE_CODES,
  type IsolationGateDeps,
  IsolationGateError,
  PROBE_LOOKUP_PER_PAGE,
  PROOF_MISSING_NOTICE,
} from "../../f/factory/lib/investigate_isolation_gate.ts";
import { assertIsolationProof } from "../../f/factory/lib/isolation_proof.ts";

const WORKSPACE = "factory";
const VERSION = "2.1.282";
const FINGERPRINT = "f".repeat(64);
const ARGV_HASH = "a".repeat(64);

function probeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-new",
    job_kind: "script",
    script_path: PROBE_SCRIPT_PATH,
    tag: "bun",
    is_flow_step: false,
    success: true,
    started_at: "2026-11-03T00:00:00.000Z",
    ...overrides,
  };
}

function probeResult(overrides: Record<string, unknown> = {}) {
  return {
    passed: true,
    claudeVersion: VERSION,
    isolationFingerprint: FINGERPRINT,
    argvShapeHash: ARGV_HASH,
    probeJudgeVersion: PROBE_JUDGE_VERSION,
    pairs: [],
    ...overrides,
  };
}

type Scenario = {
  /** probeの`scriptPathExact`で絞った一覧の応答。 */
  readonly probeJobs?: unknown;
  /** 絞りなしの根の一覧の応答。 */
  readonly rootJobs?: unknown;
  readonly results?: Record<string, unknown>;
  readonly listThrows?: boolean;
  readonly resultThrows?: boolean;
  readonly deps?: Partial<IsolationGateDeps>;
};

function setup(scenario: Scenario = {}) {
  const queries: ListCompletedJobsData[] = [];
  const resultIds: string[] = [];
  const deps: IsolationGateDeps = {
    workspace: WORKSPACE,
    listCompletedJobs: async (query) => {
      queries.push(query);
      if (scenario.listThrows === true) throw new Error("secret-detail 403");
      return query.scriptPathExact === undefined
        ? (scenario.rootJobs ?? [probeJob({ script_path: "f/factory/other" })])
        : (scenario.probeJobs ?? [probeJob()]);
    },
    getCompletedJobResult: async (id) => {
      resultIds.push(id);
      if (scenario.resultThrows === true) throw new Error("secret-detail 500");
      return (scenario.results ?? { "job-new": probeResult() })[id];
    },
    claudeVersion: VERSION,
    isolationFingerprint: FINGERPRINT,
    argvShapeHash: ARGV_HASH,
    probeJudgeVersion: PROBE_JUDGE_VERSION,
    ...scenario.deps,
  };
  return { deps, queries, resultIds };
}

async function verdictOf(scenario: Scenario = {}) {
  return checkIsolationProofWithDeps(setup(scenario).deps);
}

describe("checkIsolationProofWithDeps", () => {
  describe("the pass", () => {
    test("passes when every item matches", async () => {
      expect(await verdictOf()).toEqual({ ok: true });
    });

    test("returns only the verdict, never a proof", async () => {
      expect(Object.keys(await verdictOf())).toEqual(["ok"]);
    });
  });

  describe("the query for the probe jobs", () => {
    test("asks for the completed script jobs of the probe without a parent, newest first", async () => {
      const { deps, queries } = setup();
      await checkIsolationProofWithDeps(deps);
      expect(queries[0]).toMatchObject({
        workspace: WORKSPACE,
        scriptPathExact: PROBE_SCRIPT_PATH,
        jobKinds: "script",
        hasNullParent: true,
        orderDesc: true,
      });
    });

    test("asks for a small page", async () => {
      const { deps, queries } = setup();
      await checkIsolationProofWithDeps(deps);
      expect(queries[0]?.perPage).toBe(PROBE_LOOKUP_PER_PAGE);
    });

    test("keeps the page small", () => {
      expect(PROBE_LOOKUP_PER_PAGE).toBeLessThanOrEqual(10);
    });

    test("fetches the result of the newest job only", async () => {
      const { deps, resultIds } = setup({
        probeJobs: [
          probeJob({ id: "job-old", started_at: "2026-11-01T00:00:00.000Z" }),
          probeJob(),
        ],
        results: {
          "job-new": probeResult(),
          "job-old": probeResult(),
        },
      });
      await checkIsolationProofWithDeps(deps);
      expect(resultIds).toEqual(["job-new"]);
    });
  });

  describe("the job that is taken", () => {
    test("takes the newest job by the start time whatever the order of the list", async () => {
      const verdict = await verdictOf({
        probeJobs: [
          probeJob({ id: "job-old", started_at: "2026-11-01T00:00:00.000Z" }),
          probeJob({ success: false }),
        ],
        results: { "job-new": probeResult(), "job-old": probeResult() },
      });
      expect(verdict).toEqual({ ok: false, code: "proof_failed" });
    });

    test("closes when the newest job failed although an older one passed", async () => {
      const verdict = await verdictOf({
        probeJobs: [
          probeJob({ success: false }),
          probeJob({ id: "job-old", started_at: "2026-11-01T00:00:00.000Z" }),
        ],
        results: { "job-new": probeResult(), "job-old": probeResult() },
      });
      expect(verdict).toEqual({ ok: false, code: "proof_failed" });
    });

    test("does not fetch the result of a failed job", async () => {
      const { deps, resultIds } = setup({
        probeJobs: [probeJob({ success: false })],
      });
      await checkIsolationProofWithDeps(deps);
      expect(resultIds).toEqual([]);
    });

    const NOT_THE_PROBE: readonly [string, Record<string, unknown>][] = [
      ["a preview", { job_kind: "preview" }],
      ["a flow", { job_kind: "flow" }],
      ["a step of a flow", { is_flow_step: true }],
      ["a job with a parent", { parent_job: "job-parent" }],
      ["a job of another script", { script_path: "f/factory/other" }],
      ["a job with another tag", { tag: "console" }],
      ["a job without a start time", { started_at: undefined }],
      ["a job without an id", { id: undefined }],
    ];

    test.each(NOT_THE_PROBE)("does not take %s", async (_name, overrides) => {
      const verdict = await verdictOf({
        probeJobs: [probeJob(overrides)],
      });
      expect(verdict).toEqual({ ok: false, code: "proof_missing" });
    });

    test("does not take an entry that is not an object", async () => {
      const verdict = await verdictOf({ probeJobs: ["job-new", null, 7] });
      expect(verdict).toEqual({ ok: false, code: "proof_missing" });
    });

    test("skips a job that is not the probe and takes an older one that is", async () => {
      const verdict = await verdictOf({
        probeJobs: [
          probeJob({
            job_kind: "preview",
            started_at: "2026-11-02T00:00:00.000Z",
          }),
          probeJob({ id: "job-old", started_at: "2026-11-01T00:00:00.000Z" }),
        ],
        results: { "job-old": probeResult() },
      });
      expect(verdict).toEqual({ ok: true });
    });
  });

  describe("no probe job", () => {
    test("reports proof_missing when other jobs are visible but the probe never ran", async () => {
      expect(await verdictOf({ probeJobs: [] })).toEqual({
        ok: false,
        code: "proof_missing",
      });
    });

    test("reports proof_unreadable when no job at all is visible", async () => {
      expect(await verdictOf({ probeJobs: [], rootJobs: [] })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("looks at one root job without narrowing by the path", async () => {
      const { deps, queries } = setup({ probeJobs: [] });
      await checkIsolationProofWithDeps(deps);
      expect(queries[1]).toEqual({
        workspace: WORKSPACE,
        hasNullParent: true,
        perPage: 1,
      });
    });

    test("does not look at the root jobs when a probe job was found", async () => {
      const { deps, queries } = setup();
      await checkIsolationProofWithDeps(deps);
      expect(queries).toHaveLength(1);
    });
  });

  describe("what cannot be read", () => {
    test("reports proof_unreadable when the list fails", async () => {
      expect(await verdictOf({ listThrows: true })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("reports proof_unreadable when the list is not an array", async () => {
      expect(await verdictOf({ probeJobs: { message: "denied" } })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("reports proof_unreadable when the root list is not an array", async () => {
      expect(await verdictOf({ probeJobs: [], rootJobs: "denied" })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("reports proof_unreadable when the result cannot be fetched", async () => {
      expect(await verdictOf({ resultThrows: true })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("reports proof_unreadable when the result is not an object", async () => {
      expect(await verdictOf({ results: { "job-new": "passed" } })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("reports proof_unreadable when the result is missing", async () => {
      expect(await verdictOf({ results: {} })).toEqual({
        ok: false,
        code: "proof_unreadable",
      });
    });

    test("keeps the text of an error out of the verdict", async () => {
      expect(
        JSON.stringify(await verdictOf({ listThrows: true })),
      ).not.toContain("secret-detail");
    });
  });

  describe("a probe that did not pass", () => {
    test("reports proof_failed when the job failed", async () => {
      expect(
        await verdictOf({ probeJobs: [probeJob({ success: false })] }),
      ).toEqual({ ok: false, code: "proof_failed" });
    });

    test("reports proof_failed when the judgement is not a pass", async () => {
      expect(
        await verdictOf({
          results: { "job-new": probeResult({ passed: false }) },
        }),
      ).toEqual({ ok: false, code: "proof_failed" });
    });

    test("reports proof_failed when the result does not say whether it passed", async () => {
      expect(
        await verdictOf({
          results: { "job-new": probeResult({ passed: "true" }) },
        }),
      ).toEqual({ ok: false, code: "proof_failed" });
    });
  });

  describe("a change since the probe", () => {
    test("reports version_changed when the version of claude differs", async () => {
      expect(
        await verdictOf({
          results: { "job-new": probeResult({ claudeVersion: "2.1.300" }) },
        }),
      ).toEqual({ ok: false, code: "version_changed" });
    });

    test("reports version_changed when the version of the probe is empty", async () => {
      expect(
        await verdictOf({
          results: { "job-new": probeResult({ claudeVersion: "" }) },
          deps: { claudeVersion: "" },
        }),
      ).toEqual({ ok: false, code: "version_changed" });
    });

    test("reports version_changed when the version of the worker is unknown", async () => {
      expect(await verdictOf({ deps: { claudeVersion: undefined } })).toEqual({
        ok: false,
        code: "version_changed",
      });
    });

    test("reports version_changed when the version of the probe is not a string", async () => {
      expect(
        await verdictOf({
          results: { "job-new": probeResult({ claudeVersion: 2 }) },
        }),
      ).toEqual({ ok: false, code: "version_changed" });
    });

    test("reports isolation_changed when the isolation fingerprint differs", async () => {
      expect(
        await verdictOf({
          results: {
            "job-new": probeResult({ isolationFingerprint: "0".repeat(64) }),
          },
        }),
      ).toEqual({ ok: false, code: "isolation_changed" });
    });

    test("reports isolation_changed when the shape of the invocation differs", async () => {
      expect(
        await verdictOf({
          results: {
            "job-new": probeResult({ argvShapeHash: "0".repeat(64) }),
          },
        }),
      ).toEqual({ ok: false, code: "isolation_changed" });
    });

    test("reports isolation_changed when the version of the judge differs", async () => {
      expect(
        await verdictOf({
          results: {
            "job-new": probeResult({
              probeJudgeVersion: PROBE_JUDGE_VERSION + 1,
            }),
          },
        }),
      ).toEqual({ ok: false, code: "isolation_changed" });
    });

    test("reports isolation_changed when the result has no version of the judge", async () => {
      expect(
        await verdictOf({
          results: { "job-new": probeResult({ probeJudgeVersion: undefined }) },
        }),
      ).toEqual({ ok: false, code: "isolation_changed" });
    });
  });

  describe("the codes", () => {
    test("names the five reasons the gate closes", () => {
      expect([...ISOLATION_GATE_CODES].sort()).toEqual(
        [
          "isolation_changed",
          "proof_failed",
          "proof_missing",
          "proof_unreadable",
          "version_changed",
        ].sort(),
      );
    });

    test("carries the code in the error", () => {
      expect(new IsolationGateError("proof_failed").code).toBe("proof_failed");
    });

    test("tells the person to run the probe when the proof is missing", () => {
      expect(PROOF_MISSING_NOTICE).toBe(
        "investigate_isolation_probeを実行してください。実行済みなら、実行した主体の権限を確かめてください。",
      );
    });
  });
});

describe("checkIsolationProof", () => {
  test("closes with proof_unreadable outside Windmill, without a workspace", async () => {
    const saved = process.env.WM_WORKSPACE;
    Reflect.deleteProperty(process.env, "WM_WORKSPACE");
    let error: unknown;
    try {
      await checkIsolationProof();
    } catch (caught) {
      error = caught;
    } finally {
      if (saved !== undefined) process.env.WM_WORKSPACE = saved;
    }
    expect(error).toMatchObject({ code: "proof_unreadable" });
  });
});

describe("checkIsolationProof against a fake Windmill client", () => {
  let savedVersion: string | undefined;
  let savedWorkspace: string | undefined;

  beforeAll(() => {
    savedVersion = process.env.CLAUDE_VERSION;
    savedWorkspace = process.env.WM_WORKSPACE;
  });

  afterAll(() => {
    if (savedVersion === undefined)
      Reflect.deleteProperty(process.env, "CLAUDE_VERSION");
    else process.env.CLAUDE_VERSION = savedVersion;
    if (savedWorkspace === undefined)
      Reflect.deleteProperty(process.env, "WM_WORKSPACE");
    else process.env.WM_WORKSPACE = savedWorkspace;
    mock.restore();
  });

  test("returns a proof that the entry accepts, when the stored result matches the current isolation", async () => {
    process.env.CLAUDE_VERSION = VERSION;
    process.env.WM_WORKSPACE = WORKSPACE;
    const stored = probeResult({
      isolationFingerprint: ISOLATION_FINGERPRINT,
      argvShapeHash: computeArgvShapeHash(),
    });
    const real = await import("windmill-client@1.817.0");
    mock.module("windmill-client@1.817.0", () => ({
      ...real,
      default: { ...real.default, getWorkspace: () => WORKSPACE },
      JobService: {
        listCompletedJobs: async () => [probeJob()],
        getCompletedJobResult: async () => stored,
      },
    }));
    const gate = await import(
      `../../f/factory/lib/investigate_isolation_gate.ts?fake=${Date.now()}`
    );
    const proof: unknown = await gate.checkIsolationProof();
    expect(() => assertIsolationProof(proof)).not.toThrow();
  });
});

// 差し替え口つきの入口は、テスト専用である。
// 本番のファイルが参照すると、偽の入力で関門を通せる。
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。
describe("the entry that takes injected dependencies", () => {
  const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const DEFINING_FILE = "lib/investigate_isolation_gate.ts";
  const ENTRY = /(?<![\w$])checkIsolationProofWithDeps(?![\w$])/g;

  function countIn(code: string): number {
    return [...code.matchAll(ENTRY)].length;
  }

  function countInFile(path: string): number {
    return countIn(
      transpiler.transformSync(readFileSync(join(FACTORY_DIR, path), "utf8")),
    );
  }

  function productionSources(): string[] {
    return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
      .filter((path) => !path.endsWith(".test.ts"))
      .sort();
  }

  test("is named by no production file other than the one that defines it", () => {
    const found = productionSources().filter(
      (path) => path !== DEFINING_FILE && countInFile(path) > 0,
    );
    expect(found).toEqual([]);
  });

  test("is named in the defining file by its definition and by the public function only", () => {
    expect(countInFile(DEFINING_FILE)).toBe(2);
  });

  test("counts an import under another name", () => {
    const code = transpiler.transformSync(
      'import { checkIsolationProofWithDeps as check } from "./investigate_isolation_gate.ts"; check();',
    );
    expect(countIn(code)).toBe(1);
  });

  test("does not count a longer name", () => {
    const code = transpiler.transformSync(
      "const x = checkIsolationProofWithDepsX;",
    );
    expect(countIn(code)).toBe(0);
  });
});
