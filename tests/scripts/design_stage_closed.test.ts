// 設計工程の門を固定する。
// 設計フローを起動する配線(`startDesign`)は、`design_enabled`が真のときだけ非nullになる。
// 本番の設定の読み込みは、`design_enabled: true`でも`design_enabled_since`が無いか日時として読めないと、偽として読む。
// 門の判定は、`lib/design_gate.ts`の`resolveDesignGate`の呼び出しだけにある。
// このテストは保護パスに置く。実装フローの自動修正やPRの修正が門の条件を緩めて、
// このテストを書き換えると、黙って通るようになるためである。
//
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。変換できないファイルは失敗として扱う(fail-closed)。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。
// 関数の観測(下の「設計の入口」)と組み合わせて守る。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadyForImplement } from "../../f/factory/lib/approval_gate.ts";
import { loadConfig } from "../../f/factory/lib/config.ts";
import { resolveDesignGate } from "../../f/factory/lib/design_gate.ts";
import { decideDesignGapAction } from "../../f/factory/lib/implement_finish_support.ts";
import {
  type FixDesignDeps,
  loadParentDesignForFix,
} from "../../f/factory/lib/pr_fix_design.ts";
import type { FactoryConfig, WorkItem } from "../../f/factory/lib/types.ts";
import { computeRestartPlan } from "../../f/factory/retry_work_item.ts";
import {
  applyDesignApproved,
  applyDesignRejected,
} from "../../f/factory/steps/design_apply.ts";
import {
  type ApprovedBranchContext,
  type ApprovedBranchDeps,
  applyApprovedBranch,
  buildApprovedBranchDeps,
} from "../../f/factory/steps/requirements_apply.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントを落としたJavaScript。変換できないときは例外を投げる。 */
function codeOf(path: string): string {
  return transpiler.transformSync(
    readFileSync(join(FACTORY_DIR, path), "utf8"),
  );
}

/** `f/factory`の下の、テストを除くすべての`.ts`の相対パス。 */
function productionSources(): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort();
}

/**
 * `design_enabled`の出現。キー、`.design_enabled`の読み、文字列、省略記法、分割代入の別名を区別せずに数える。
 * 引用符付きのキーは、変換で引用符が落ちるのでキーと同じ形になる。
 * `design_enabled_ignored`のように識別子の続きになる綴りは数えない。
 */
const DESIGN_ENABLED_TOKEN = /(?<![\w$])design_enabled(?![\w$])/g;

/**
 * `design_enabled`が出てよい本番のファイルと、出る数。
 * 型の宣言(`lib/types.ts`の`design_enabled: boolean`、`Pick`の中の名前)は、変換で消える。
 * `lib/config.ts`の6つは、既定値、通知の本文の中の2つ、リソースの読み取りの名前と既定値の参照、門の結果の導出である。
 * `console_config.ts`の1つは、設定タブに出す効く値のために、生の値を門へ渡す読みである。
 * 残りは、設定の値を読む呼び出しの側の1つずつである。`steps/design_apply.ts`は、却下の再生成の分岐で入口が閉じているかを読む。
 * `steps/implement_finish.ts`と`steps/pr_fix_finish.ts`は、設計の不足を返した実装とPRの修正を設計へ戻すかの判定に渡す。
 * `steps/pr_fix_apply.ts`と`steps/pr_fix_verify.ts`は、PRの修正のレビュー回に設計書を渡すかの判定に渡す。
 * `lib/implement_finish_support.ts`と`steps/pr_workflow_support.ts`の1つずつは、設計工程が無効のときの理由の固定文に入る語である。
 * 呼び出しの側で`{ ...config, design_enabled: ... }`と上書きする迂回や、別の読み方を足す変更は、ここで数が増えて見つかる。
 */
const ALLOWED_DESIGN_ENABLED_TOKENS: Readonly<Record<string, number>> = {
  "auto_retry_stale_image.ts": 1,
  "console_config.ts": 1,
  "lib/config.ts": 6,
  "lib/implement_finish_support.ts": 1,
  "lib/self_update_support.ts": 1,
  "retry_work_item.ts": 1,
  "self_update.ts": 1,
  "steps/design_apply.ts": 1,
  "steps/implement_finish.ts": 1,
  "steps/implement_prepare.ts": 1,
  "steps/pr_fix_apply.ts": 1,
  "steps/pr_fix_finish.ts": 1,
  "steps/pr_fix_verify.ts": 1,
  "steps/pr_workflow_support.ts": 1,
  "steps/requirements_apply.ts": 1,
};

/**
 * `design_enabled_since`の出現。`design_enabled`の数え方は、これに当たらない(`_since`が識別子の続きになる)ので、別に数える。
 * 型の宣言は、変換で消える。
 */
const DESIGN_ENABLED_SINCE_TOKEN = /(?<![\w$])design_enabled_since(?![\w$])/g;

/**
 * `design_enabled_since`が出てよい本番のファイルと、出る数。
 * `lib/config.ts`の6つは、既定値、生の値の読み、既定値の参照、読めた値の返却、通知の本文の中の2つである。
 * `console_config.ts`の1つは、設定タブに出す効く値のために、生の値を門へ渡す読みである。
 * `lib/self_update_support.ts`の1つは、警告の固定文に入る語である。
 */
const ALLOWED_DESIGN_ENABLED_SINCE_TOKENS: Readonly<Record<string, number>> = {
  "console_config.ts": 1,
  "lib/config.ts": 6,
  "lib/self_update_support.ts": 1,
};

/**
 * `design_enabled_since`に、null以外の値を書く字面。キーへの代入、引用符付きのキー、`=`での代入のうち、
 * 値が文字列、数値、`new Date`、`Date.`のもの。
 */
const SINCE_LITERAL =
  /(?<![\w$])design_enabled_since["'`]?\s*[:=]\s*(?:["'`]|\d|new\s+Date\b|Date\.)/g;

/** 要件定義の承認の反映の配線に、設定をそのまま渡す呼び出し。宣言は数えない。 */
const BUILDER_CALL = /(?<!\bfunction\s+)\bbuildApprovedBranchDeps\(config,/g;

/**
 * 実装の入口が、設定の`design_enabled`をそのまま読んで渡す形。
 * 値の直後が`,`か`}`でなければ数えない。`|| true`のような後ろの式で値を変える書き換えを、数の差で見つけるためである。
 */
const DESIGN_ENABLED_HANDOFF =
  /\bdesignEnabled:\s*config\.design_enabled(?=\s*[,}])/g;

/** 設定を渡す呼び出しの形と、ファイルごとの数。上書きした設定を渡す形にすると、数が減って見つかる。 */
const WIRING_CALLS: ReadonlyArray<
  readonly [string, RegExp, Readonly<Record<string, number>>]
> = [
  [
    "buildApprovedBranchDeps(config,",
    BUILDER_CALL,
    { "steps/requirements_apply.ts": 1 },
  ],
  [
    "designEnabled: config.design_enabled",
    DESIGN_ENABLED_HANDOFF,
    {
      "retry_work_item.ts": 1,
      "steps/implement_finish.ts": 1,
      "steps/implement_prepare.ts": 1,
      "steps/pr_fix_apply.ts": 1,
      "steps/pr_fix_finish.ts": 1,
      "steps/pr_fix_verify.ts": 1,
    },
  ],
];

function countOf(code: string, pattern: RegExp): number {
  return [...code.matchAll(pattern)].length;
}

/** パターンが出るファイルごとの出現の数(0は含めない)。 */
function scanCounts(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of productionSources()) {
    const n = countOf(codeOf(path), pattern);
    if (n > 0) found[path] = n;
  }
  return found;
}

const WORK_ITEM: WorkItem = {
  id: 7,
  cycle: 1,
  source: "issue",
  kind: "issue",
  owner: "octo",
  repo: "widgets",
  issue_number: 42,
  issue_url: "https://github.com/octo/widgets/issues/42",
  pr_number: null,
  title: "t",
  body: "b",
  status: "awaiting_approval",
  attempt: 1,
  claimed_by: null,
  flow_job_id: null,
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
  created_at: new Date("2026-10-26T00:00:00Z"),
  updated_at: new Date("2026-10-26T00:00:00Z"),
};

const CONTEXT: ApprovedBranchContext = {
  workItem: WORK_ITEM,
  issueNumber: 42,
  attempt: 1,
  client: {
    run: async () => {
      throw new Error("the builder must not call GitHub");
    },
    ghToken: "token",
  },
  viewerLogin: "factory-bot",
  webhookUrl: "",
  log: { info() {}, warn() {}, error() {} },
};

const CONFIG = {
  implement_enabled: true,
  design_enabled: false,
  windmill_public_url: "http://127.0.0.1:8080",
  instance_name: "local",
};

const SINCE = "2026-11-01T00:00:00Z";
const INSTANCES = ["local", "production", "prod", "factory-1", "staging"];

const RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  windmill_public_url: "http://127.0.0.1:8080",
};

describe("the wiring of the design flow", () => {
  test("leaves the design flow unwired when design_enabled is false", () => {
    expect(buildApprovedBranchDeps(CONFIG, CONTEXT).startDesign).toBeNull();
  });

  test("wires the design flow when design_enabled is true", () => {
    const deps = buildApprovedBranchDeps(
      { ...CONFIG, design_enabled: true },
      CONTEXT,
    );
    expect(typeof deps.startDesign).toBe("function");
  });

  test.each(INSTANCES)(
    "leaves the design flow unwired after loadConfig with instance_name %p and design_enabled: true without a since",
    async (instanceName) => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        instance_name: instanceName,
        design_enabled: true,
      }));
      expect(buildApprovedBranchDeps(config, CONTEXT).startDesign).toBeNull();
    },
  );

  test.each(INSTANCES)(
    "wires the design flow after loadConfig with instance_name %p and design_enabled: true with a since",
    async (instanceName) => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        instance_name: instanceName,
        design_enabled: true,
        design_enabled_since: SINCE,
      }));
      expect(typeof buildApprovedBranchDeps(config, CONTEXT).startDesign).toBe(
        "function",
      );
    },
  );

  test("leaves the design flow unwired after loadConfig with the default setting", async () => {
    const config = await loadConfig(async () => RAW_CONFIG);
    expect(buildApprovedBranchDeps(config, CONTEXT).startDesign).toBeNull();
  });

  test("leaves the design flow unwired after loadConfig with a since but design_enabled: false", async () => {
    const config = await loadConfig(async () => ({
      ...RAW_CONFIG,
      design_enabled: false,
      design_enabled_since: SINCE,
    }));
    expect(buildApprovedBranchDeps(config, CONTEXT).startDesign).toBeNull();
  });
});

describe("the return from the implement flow to the design", () => {
  test.each(INSTANCES)(
    "does not reroute after loadConfig with instance_name %p and design_enabled: true without a since",
    async (instanceName) => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        instance_name: instanceName,
        design_enabled: true,
      }));
      const action = decideDesignGapAction({
        designEnabled: config.design_enabled,
        appliedRejections: 0,
        maxDesignAttempts: config.max_design_attempts,
      });
      expect(action).not.toBe("reroute");
    },
  );

  test.each(INSTANCES)(
    "reroutes after loadConfig with instance_name %p and design_enabled: true with a since",
    async (instanceName) => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        instance_name: instanceName,
        design_enabled: true,
        design_enabled_since: SINCE,
      }));
      const action = decideDesignGapAction({
        designEnabled: config.design_enabled,
        appliedRejections: 0,
        maxDesignAttempts: config.max_design_attempts,
      });
      expect(action).toBe("reroute");
    },
  );

  test("stops at disabled when design_enabled is false", () => {
    expect(
      decideDesignGapAction({
        designEnabled: false,
        appliedRejections: 0,
        maxDesignAttempts: 3,
      }),
    ).toBe("disabled");
  });
});

describe("the return from the PR fix to the design", () => {
  const code = codeOf("steps/pr_fix_finish.ts");

  test("decides with the function that the implement flow also uses", () => {
    expect(code).toMatch(
      /import\s*\{\s*decideDesignGapAction\s*\}\s*from\s*"\.\.\/lib\/implement_finish_support\.ts"/,
    );
  });

  test("decides the action of a design gap once", () => {
    expect(countOf(code, /\bdecideDesignGapAction\(/g)).toBe(1);
  });

  /** 設計書を読みに行ったか。親の作業項目を読むかどうかで見分ける。 */
  async function readsParent(config: FactoryConfig): Promise<number[]> {
    const reads: number[] = [];
    const deps: FixDesignDeps = {
      getWorkItem: async (id) => {
        reads.push(id);
        return null;
      },
      hasNewerIssueCycle: async () => false,
      latestRequirementsApproval: async () => null,
      latestDesignApproval: async () => null,
      getDesignDraft: async () => null,
      warn: () => {},
    };
    await loadParentDesignForFix(deps, {
      designEnabled: config.design_enabled,
      reviewRound: true,
      parentWorkItemId: 7,
      pr: { owner: "octo", repo: "widgets", headRef: "factory/issue-7" },
    });
    return reads;
  }

  test.each(INSTANCES)(
    "hands no design to the PR fix after loadConfig with instance_name %p and design_enabled: true without a since",
    async (instanceName) => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        instance_name: instanceName,
        design_enabled: true,
      }));
      expect(await readsParent(config)).toEqual([]);
    },
  );

  test.each(INSTANCES)(
    "reads the parent design for the PR fix after loadConfig with instance_name %p and design_enabled: true with a since",
    async (instanceName) => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        instance_name: instanceName,
        design_enabled: true,
        design_enabled_since: SINCE,
      }));
      expect(await readsParent(config)).toEqual([7]);
    },
  );
});

describe("the literal that opens the design stage", () => {
  test("appears nowhere in the production code of f/factory", () => {
    const found = productionSources().filter((path) =>
      /\bdesign_enabled\b\s*:\s*true/.test(codeOf(path)),
    );
    expect(found).toEqual([]);
  });

  test("a value of design_enabled_since other than null appears nowhere in the production code", () => {
    expect(scanCounts(SINCE_LITERAL)).toEqual({});
  });

  test("the pattern of the value of design_enabled_since catches a string", () => {
    expect(
      countOf(
        transpiler.transformSync('const c = { design_enabled_since: "x" };'),
        SINCE_LITERAL,
      ),
    ).toBe(1);
  });

  test("the pattern of the value of design_enabled_since catches a new Date", () => {
    expect(
      countOf(
        transpiler.transformSync(
          "const c = { design_enabled_since: new Date() };",
        ),
        SINCE_LITERAL,
      ),
    ).toBe(1);
  });

  test("the pattern of the value of design_enabled_since catches an assignment", () => {
    expect(
      countOf(
        transpiler.transformSync('c.design_enabled_since = "x";'),
        SINCE_LITERAL,
      ),
    ).toBe(1);
  });

  test("the pattern of the value of design_enabled_since does not catch null", () => {
    expect(
      countOf(
        transpiler.transformSync("const c = { design_enabled_since: null };"),
        SINCE_LITERAL,
      ),
    ).toBe(0);
  });

  test("DESIGN_STAGE_OPENABLE appears nowhere in the production code of f/factory", () => {
    expect(scanCounts(/DESIGN_STAGE_OPENABLE/g)).toEqual({});
  });

  test("reads every production file", () => {
    expect(productionSources().length).toBeGreaterThan(100);
  });
});

describe("the handoff of design_enabled to the entrance of the implement flow", () => {
  test("counts the setting passed as it is, before a comma", () => {
    expect(
      countOf(
        "{ designEnabled: config.design_enabled, x }",
        DESIGN_ENABLED_HANDOFF,
      ),
    ).toBe(1);
  });

  test("counts the setting passed as it is, before a closing brace", () => {
    expect(
      countOf(
        "{ designEnabled: config.design_enabled }",
        DESIGN_ENABLED_HANDOFF,
      ),
    ).toBe(1);
  });

  test.each(["|| true", "?? true", "|| flag", "&& flag", ".valueOf()"])(
    "does not count the setting followed by %p",
    (tail) => {
      expect(
        countOf(
          `{ designEnabled: config.design_enabled ${tail}, x }`,
          DESIGN_ENABLED_HANDOFF,
        ),
      ).toBe(0);
    },
  );
});

describe("the files that mention design_enabled", () => {
  test("are exactly the files in the table", () => {
    expect(scanCounts(DESIGN_ENABLED_TOKEN)).toEqual(
      ALLOWED_DESIGN_ENABLED_TOKENS,
    );
  });

  test("catches an override that spreads the configuration", () => {
    const code = transpiler.transformSync(
      "const c = { ...config, design_enabled: true };",
    );
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(1);
  });

  test("catches a key that is written with a space before the colon", () => {
    const code = transpiler.transformSync("const c = { design_enabled : x };");
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(1);
  });

  test("catches a key that is quoted", () => {
    const code = transpiler.transformSync('const c = { "design_enabled": x };');
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(1);
  });

  test("catches a read through a property", () => {
    const code = transpiler.transformSync("const x = config.design_enabled;");
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(1);
  });

  test("catches a read through a string index", () => {
    const code = transpiler.transformSync(
      'const x = config["design_enabled"];',
    );
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(1);
  });

  test("catches a shorthand property", () => {
    const code = transpiler.transformSync(
      "const design_enabled = 1; const c = { design_enabled };",
    );
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(2);
  });

  test("catches a destructuring with an alias", () => {
    const code = transpiler.transformSync(
      "const { design_enabled: gate } = config;",
    );
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(1);
  });

  test("does not count design_enabled_ignored", () => {
    const code = transpiler.transformSync(
      "const x = config.design_enabled_ignored;",
    );
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(0);
  });

  test("does not count a type declaration, which the transpiler erases", () => {
    const code = transpiler.transformSync(
      "type T = { design_enabled: boolean };",
    );
    expect(countOf(code, DESIGN_ENABLED_TOKEN)).toBe(0);
  });
});

describe("the files that mention design_enabled_since", () => {
  test("are exactly the files in the table", () => {
    expect(scanCounts(DESIGN_ENABLED_SINCE_TOKEN)).toEqual(
      ALLOWED_DESIGN_ENABLED_SINCE_TOKENS,
    );
  });

  test("the pattern of design_enabled does not catch design_enabled_since", () => {
    expect(countOf("design_enabled_since", DESIGN_ENABLED_TOKEN)).toBe(0);
  });

  test("the pattern of design_enabled_since catches a key", () => {
    expect(
      countOf(
        "const c = { design_enabled_since: x };",
        DESIGN_ENABLED_SINCE_TOKEN,
      ),
    ).toBe(1);
  });

  test("the pattern of design_enabled_since catches a read through a property", () => {
    expect(
      countOf(
        "const x = raw.design_enabled_since;",
        DESIGN_ENABLED_SINCE_TOKEN,
      ),
    ).toBe(1);
  });

  test("the pattern of design_enabled_since catches a read through a string index", () => {
    expect(
      countOf(
        'const x = raw["design_enabled_since"];',
        DESIGN_ENABLED_SINCE_TOKEN,
      ),
    ).toBe(1);
  });

  test("the pattern of design_enabled_since does not catch a longer name", () => {
    expect(
      countOf("const x = design_enabled_since_x;", DESIGN_ENABLED_SINCE_TOKEN),
    ).toBe(0);
  });
});

describe("the calls that hand the configuration to the wiring", () => {
  test.each(WIRING_CALLS)(
    "%s appears in the files of the table",
    (_name, pattern, allowed) => {
      expect(scanCounts(pattern)).toEqual(allowed);
    },
  );

  test("counts a call of the builder with the configuration", () => {
    const code = transpiler.transformSync(
      "const d = buildApprovedBranchDeps(config, ctx);",
    );
    expect(countOf(code, BUILDER_CALL)).toBe(1);
  });

  test("does not count the declaration of the builder", () => {
    const code = transpiler.transformSync(
      "export function buildApprovedBranchDeps(config, ctx) { return 1; }",
    );
    expect(countOf(code, BUILDER_CALL)).toBe(0);
  });

  test("does not count a call of the builder with an overridden configuration", () => {
    const code = transpiler.transformSync(
      "const d = buildApprovedBranchDeps({ ...config, design_enabled: true }, ctx);",
    );
    expect(countOf(code, BUILDER_CALL)).toBe(0);
  });
});

describe("the gate in config.ts", () => {
  const config = codeOf("lib/config.ts");

  test("declares the default of design_enabled as false exactly once", () => {
    expect([...config.matchAll(/\bdesign_enabled: false,/g)]).toHaveLength(1);
  });

  test("declares the default of design_enabled_since as the literal null exactly once", () => {
    expect([...config.matchAll(/\bdesign_enabled_since: null,/g)]).toHaveLength(
      1,
    );
  });

  test("declares the request of design_enabled exactly once, from the raw resource", () => {
    expect([
      ...config.matchAll(
        /\bconst designEnabledRequested = booleanField\(\s*raw,\s*"design_enabled",\s*DEFAULTS\.design_enabled,?\s*\);/g,
      ),
    ]).toHaveLength(1);
  });

  test("reads design_enabled_since from the raw resource exactly once", () => {
    expect([
      ...config.matchAll(
        /\bconst designEnabledSince =\s*raw\.design_enabled_since\s*\?\?\s*DEFAULTS\.design_enabled_since;/g,
      ),
    ]).toHaveLength(1);
  });

  test("mentions raw.design_enabled_since only in that read", () => {
    expect([...config.matchAll(/\braw\.design_enabled_since\b/g)]).toHaveLength(
      1,
    );
  });

  test("mentions the request in its declaration and the gate call only", () => {
    expect([...config.matchAll(/\bdesignEnabledRequested\b/g)]).toHaveLength(2);
  });

  test("calls resolveDesignGate exactly once, with the request and the since", () => {
    expect([
      ...config.matchAll(
        /\bconst designGate = resolveDesignGate\(\s*designEnabledRequested,\s*designEnabledSince,?\s*\);/g,
      ),
    ]).toHaveLength(1);
  });

  test("calls resolveDesignGate nowhere else in the file", () => {
    expect([...config.matchAll(/\bresolveDesignGate\(/g)]).toHaveLength(1);
  });

  test("imports resolveDesignGate from lib/design_gate.ts", () => {
    expect(config).toMatch(
      /import\s*\{[^}]*\bresolveDesignGate\b[^}]*\}\s*from\s*"\.\/design_gate\.ts"/,
    );
  });

  test("derives design_enabled from the gate only", () => {
    expect([
      ...config.matchAll(/\bdesign_enabled:\s*designGate\.enabled\s*,/g),
    ]).toHaveLength(1);
  });

  test("derives design_enabled_ignored from the gate only", () => {
    expect([
      ...config.matchAll(
        /\bdesign_enabled_ignored:\s*designGate\.ignored\s*,/g,
      ),
    ]).toHaveLength(1);
  });

  test("mentions the gate result in its declaration and the two derivations only", () => {
    expect([...config.matchAll(/\bdesignGate\b/g)]).toHaveLength(3);
  });

  test.each(["process.env", "Bun.env", "import.meta.env"])(
    "does not read %s",
    (reader) => {
      expect(config.includes(reader)).toBe(false);
    },
  );
});

describe("the gate in lib/design_gate.ts", () => {
  const gate = codeOf("lib/design_gate.ts");

  test("imports nothing", () => {
    expect(gate).not.toMatch(/\bimport\b/);
  });

  test.each(["process.env", "Bun.env", "import.meta.env", "Date.now"])(
    "does not read %s",
    (reader) => {
      expect(gate.includes(reader)).toBe(false);
    },
  );

  test("stays closed without a since", () => {
    expect(resolveDesignGate(true, null).enabled).toBe(false);
  });

  test("opens with a since", () => {
    expect(resolveDesignGate(true, SINCE).enabled).toBe(true);
  });

  test("stays closed when it is not requested, whatever the since is", () => {
    expect(resolveDesignGate(false, SINCE).enabled).toBe(false);
  });
});

/**
 * 設計の入口ごとの観測。設定から導いた`design_enabled`を実際に渡して、閉じた結果と開いた結果を返す。
 * 呼び出しの形は、上の表(`WIRING_CALLS`)がソースで固定する。
 */
type EntryProbe = {
  readonly name: string;
  readonly probe: (config: FactoryConfig) => Promise<string>;
  readonly closed: string;
  readonly open: string;
};

const APPROVED_REQUIREMENTS_ONLY = {
  latestRequirementsApproval: async () => ({
    status: "approved",
    attempt: 1,
    draft_id: 8,
  }),
  latestDesignApproval: async () => null,
};

async function readiness(config: FactoryConfig): Promise<string> {
  const ready = await isReadyForImplement(
    WORK_ITEM,
    config.design_enabled,
    APPROVED_REQUIREMENTS_ONLY,
  );
  return ready ? "ready" : "not ready";
}

function gapAction(config: FactoryConfig): string {
  return decideDesignGapAction({
    designEnabled: config.design_enabled,
    appliedRejections: 0,
    maxDesignAttempts: config.max_design_attempts,
  });
}

async function parentRead(config: FactoryConfig): Promise<string> {
  const seen: number[] = [];
  await loadParentDesignForFix(
    {
      getWorkItem: async (id) => {
        seen.push(id);
        return null;
      },
      hasNewerIssueCycle: async () => false,
      latestRequirementsApproval: async () => null,
      latestDesignApproval: async () => null,
      getDesignDraft: async () => null,
      warn: () => {},
    },
    {
      designEnabled: config.design_enabled,
      reviewRound: true,
      parentWorkItemId: 7,
      pr: { owner: "octo", repo: "widgets", headRef: "factory/issue-7" },
    },
  );
  return seen.length === 0 ? "no read" : "reads the parent";
}

async function rejectionOutcome(config: FactoryConfig): Promise<string> {
  const result = await applyDesignRejected(
    {
      config,
      ctx: {
        workItem: WORK_ITEM,
        issueNumber: 42,
        webhookUrl: "",
        log: { info() {}, warn() {}, error() {} },
      },
      moveToNeedsHuman: async () => true,
      notifyNeedsHuman: async () => {},
      casToDesigning: async () => false,
      requirementsRelaunchDeps: () => {
        throw new Error("the rejection must not return to requirements");
      },
      log: () => {},
    },
    {
      issue: "unchanged",
      appliedRejections: 0,
      maxDesignAttempts: 3,
      feedback: "f",
    },
  );
  return result.outcome;
}

const ENTRY_PROBES: readonly EntryProbe[] = [
  {
    name: "requirements_apply",
    probe: async (config) =>
      buildApprovedBranchDeps(config, CONTEXT).startDesign === null
        ? "not wired"
        : "wired",
    closed: "not wired",
    open: "wired",
  },
  {
    name: "design_apply",
    probe: rejectionOutcome,
    closed: "needs_human",
    open: "no_op",
  },
  {
    name: "implement_prepare",
    probe: readiness,
    closed: "ready",
    open: "not ready",
  },
  {
    name: "auto_retry_stale_image",
    probe: readiness,
    closed: "ready",
    open: "not ready",
  },
  {
    name: "implement_finish",
    probe: async (config) => gapAction(config),
    closed: "disabled",
    open: "reroute",
  },
  {
    name: "pr_fix_finish",
    probe: async (config) => gapAction(config),
    closed: "disabled",
    open: "reroute",
  },
  {
    name: "pr_fix_apply",
    probe: parentRead,
    closed: "no read",
    open: "reads the parent",
  },
  {
    name: "pr_fix_verify",
    probe: parentRead,
    closed: "no read",
    open: "reads the parent",
  },
  {
    name: "retry_work_item",
    probe: async (config) =>
      computeRestartPlan(
        { ...WORK_ITEM, status: "failed", design_attempt: 1 },
        {
          implementReady: true,
          implementEnabled: true,
          designEnabled: config.design_enabled,
          designApproved: false,
          stop: "other",
          feedback: null,
          designFeedback: null,
          carriesGap: false,
        },
      ).flowPath,
    closed: "f/factory/implement",
    open: "f/factory/design",
  },
];

describe("every entry of the design stage", () => {
  test("is listed for the nine scripts", () => {
    expect(ENTRY_PROBES.map((entry) => entry.name)).toEqual([
      "requirements_apply",
      "design_apply",
      "implement_prepare",
      "auto_retry_stale_image",
      "implement_finish",
      "pr_fix_finish",
      "pr_fix_apply",
      "pr_fix_verify",
      "retry_work_item",
    ]);
  });

  describe.each(ENTRY_PROBES)("$name", (entry) => {
    test("stays closed after loadConfig with design_enabled: true and no since", async () => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        design_enabled: true,
      }));
      expect(await entry.probe(config)).toBe(entry.closed);
    });

    test("stays closed after loadConfig with design_enabled: true and an unreadable since", async () => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        design_enabled: true,
        design_enabled_since: "2026-11-01",
      }));
      expect(await entry.probe(config)).toBe(entry.closed);
    });

    test("stays closed after loadConfig with the default setting", async () => {
      const config = await loadConfig(async () => RAW_CONFIG);
      expect(await entry.probe(config)).toBe(entry.closed);
    });

    test("opens after loadConfig with design_enabled: true and a since", async () => {
      const config = await loadConfig(async () => ({
        ...RAW_CONFIG,
        design_enabled: true,
        design_enabled_since: SINCE,
      }));
      expect(await entry.probe(config)).toBe(entry.open);
    });
  });
});

describe("the three entries to the implement flow when the design is enabled", () => {
  test("starts the implement flow when design_apply accepts an approval", async () => {
    const started: string[] = [];
    await applyDesignApproved(
      {
        moveToNeedsHuman: async () => true,
        notifyNeedsHuman: async () => {},
        casToApproved: async () => true,
        startImplement: async () => {
          started.push("implement");
          return "started";
        },
        log: () => {},
      },
      {
        workItem: { attempt: 2, design_attempt: 3 },
        requirementsApproval: { status: "approved", attempt: 2, draft_id: 8 },
        designApproval: {
          approval_request_id: 11,
          design_draft_id: 5,
          status: "approved",
          payload_attempt: 2,
          payload_design_attempt: 3,
          reason: null,
          draft: { design_attempt: 3, requirement_draft_id: 8 },
        },
      },
    );
    expect(started).toEqual(["implement"]);
  });

  test("does not start the implement flow when the approval of requirements goes to the design", async () => {
    const started: string[] = [];
    const deps: ApprovedBranchDeps = {
      casToApproved: async () => true,
      casToDesigning: async () => true,
      commentIssue: async () => {},
      addCommentFailedNotice: async () => {},
      notifyApproved: async () => {},
      removeWorktree: async () => {},
      startImplement: async () => {
        started.push("implement");
        return "started";
      },
      startDesign: async () => "started",
      log: () => {},
    };
    await applyApprovedBranch(deps);
    expect(started).toEqual([]);
  });

  test("moves the approval of requirements to designing when the design flow is wired", async () => {
    const moves: string[] = [];
    const deps: ApprovedBranchDeps = {
      casToApproved: async () => {
        moves.push("approved");
        return true;
      },
      casToDesigning: async () => {
        moves.push("designing");
        return true;
      },
      commentIssue: async () => {},
      addCommentFailedNotice: async () => {},
      notifyApproved: async () => {},
      removeWorktree: async () => {},
      startImplement: async () => "started",
      startDesign: async () => "started",
      log: () => {},
    };
    await applyApprovedBranch(deps);
    expect(moves).toEqual(["designing"]);
  });

  const UNAPPROVED_DESIGN = {
    implementReady: true,
    implementEnabled: true,
    designEnabled: true,
    designApproved: false,
    stop: "other",
    feedback: null,
    designFeedback: null,
    carriesGap: false,
  } as const;

  test("restarts at the design flow when the design is unapproved", () => {
    const plan = computeRestartPlan(
      { ...WORK_ITEM, status: "failed", design_attempt: 1 },
      UNAPPROVED_DESIGN,
    );
    expect(plan.flowPath).toBe("f/factory/design");
  });

  test("does not restart the implement flow when the design is unapproved", () => {
    const plan = computeRestartPlan(
      { ...WORK_ITEM, status: "failed", design_attempt: 1 },
      UNAPPROVED_DESIGN,
    );
    expect(plan.flowPath).not.toBe("f/factory/implement");
  });

  test("is not ready for the implement flow when the design is unapproved", async () => {
    const ready = await isReadyForImplement(WORK_ITEM, true, {
      latestRequirementsApproval: async () => ({
        status: "approved",
        attempt: 1,
        draft_id: 8,
      }),
      latestDesignApproval: async () => null,
    });
    expect(ready).toBe(false);
  });
});
