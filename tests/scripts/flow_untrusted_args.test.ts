// stepの間で渡す値が、Windmillの引数の解決の対象にならない形かを、すべてのflowの定義から確かめる。
// Windmillは、ジョブの引数の`$var:`や`$res:`で始まる文字列を、実行者の権限で解決する。
// 前のstepの結果(`results.<step>`)と失敗の`error`を式に持つ引数は、次のどちらかでなければならない。
// - 値全体をJSONの文字列にして渡す(`lib/untrusted_arg.ts`)。式は`JSON.stringify(...)`で始まり、`$`を置き換える呼び出しで終わる。
// - 下の`PLAIN`か`OPEN`に、flowとstepと引数の名前を挙げる。
// `PLAIN`は、値が数、真偽値、sha、git参照、GitHubの名前、作業用の置き場、固定の文など、
// `$var:`の形を取れない値であると確かめたもの。`OPEN`は、まだ包んでいない経路で、`docs/security.md`の表に理由を書く。
// 新しいflowやstepが、未確認の値を包まずに渡すと、このテストが落ちる。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sealUntrustedArg } from "../../f/factory/lib/untrusted_arg.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const FACTORY_DIR = join(REPO_ROOT, "f/factory");
const FLOW_DIR_SUFFIX = "__flow";

/** 値を包む式の終わり。`JSON`の文字列の`$`をすべて`$`に置き換える。 */
const SEAL_SUFFIX = '.replace(/\\$/g, "\\\\u0024")';

/** 値の中の`$`がどこにも残らないことを確かめる、解決の対象になる文字列。 */
const POISON = "$var:f/factory/github_token";

/**
 * 包まずに渡してよい引数。`flow/step`ごとに、引数の名前をコンマで並べる。
 * - 数、真偽値、作業項目やチェックのid
 * - git参照とsha(参照の名前にコロンは使えないので、`$var:`の形を取れない)
 * - GitHubのownerとrepoの名前(`$`は使えない)
 * - factoryが作る作業用の置き場と、`.git`の指し先
 * - stepが決める固定の文、検査を通した列挙値、先頭が固定の文字列
 */
const PLAIN: Readonly<Record<string, string>> = {
  "audit/audit_generate": "evidence_markdown,factory_clone_dir,metrics",
  "design/generate": "head_sha,worktree_dir",
  "investigate/investigate_prepare": "work_item_id",
  "investigate/investigate_generate":
    "factory_clone_dir,repo_dir,sha,work_item_id",
  "investigate/investigate_post": "comment_body,withheld,work_item_id",
  "manual_intake/register":
    "body,intake_key,issue_number,issue_url,owner,profile,repo,reused,title",
  "pipeline/generate": "worktree_dir",
  "pr_fix/pr_fix_collect": "owner,pr_number,repo",
  "pr_fix/pr_fix_apply":
    "attempt,base_sha,ci_check_id,conflict_check_id,factory_clone_dir,head_sha,owner,parent_work_item_id,pr_number,repo,worktree_dir,worktree_git_pointer",
  "pr_fix/pr_fix_verify":
    "apply_outcome,attempt,auto_tree_sha,base_sha,baseline_sha,branch,ci_check_id,conflict_check_id,factory_clone_dir,head_sha,owner,parent_work_item_id,pr_number,repo,worktree_dir,worktree_git_pointer",
  "pr_fix/pr_fix_finish":
    "auto_tree_sha,base_sha,baseline_sha,branch,ci_check_id,conflict_check_id,fix_round,head_sha,max_comment_id,max_review_comment_id,max_review_id,outcome,owner,parent_work_item_id,pr_number,repo,repo_dir,trigger_review_ids,verified_tree_sha,worktree_dir,worktree_git_pointer",
  "pr_review/pr_review_generate":
    "attempt,factory_clone_dir,owner,parent_work_item_id,pr_number,repo,review_sha,skip,worktree_dir",
  "pr_review/pr_review_post":
    "binary_unlisted_count,owner,pr_number,repo,repo_dir,review_sha,skip,worktree_dir",
};

/** まだ包んでいない経路。`docs/security.md`の表が、それぞれの扱いと理由を述べる。 */
const OPEN: Readonly<Record<string, string>> = {
  "dependabot/dependabot_assess": "prepare",
  "dependabot/dependabot_finish": "assess,prepare",
  "implement/implement_generate": "context",
  "implement/implement_verify": "context,first_round",
  "implement/implement_finish":
    "context,loop_result,prepare_outcome,prepare_reason",
  "audit/failure": "error",
  "dependabot/failure": "error",
  "design/failure": "error",
  "implement/failure": "error",
  "investigate/failure": "error",
  "manual_intake/failure": "error",
  "pipeline/failure": "error",
  "pr_fix/failure": "error",
  "pr_review/failure": "error",
};

/** 値全体を包む引数。flowとstepごとに、引数の名前を挙げる。 */
const SEALED: Readonly<Record<string, string>> = {
  "pr_fix/pr_fix_apply": "untrusted",
  "pr_fix/pr_fix_verify": "untrusted",
  "pr_fix/pr_fix_finish": "untrusted",
  "pr_review/pr_review_post": "untrusted",
};

type Transform = {
  readonly flow: string;
  readonly step: string;
  readonly arg: string;
  readonly expr: string;
  readonly scriptPath: string | null;
};

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** `value`の中のmoduleを、branchやloopの入れ子と`failure_module`も含めて、すべて返す。 */
function modulesIn(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const nested = Object.values(value).flatMap(modulesIn);
  const isModule =
    typeof field(value, "id") === "string" &&
    field(value, "value") !== undefined;
  return isModule ? [value, ...nested] : nested;
}

/** 前のstepの結果か失敗の`error`を式に持つ引数を、すべてのflowから集める。 */
const STEP_VALUES: readonly Transform[] = readdirSync(FACTORY_DIR)
  .filter((name) => name.endsWith(FLOW_DIR_SUFFIX))
  .sort()
  .flatMap((dir) => {
    const flow = dir.slice(0, -FLOW_DIR_SUFFIX.length);
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(join(FACTORY_DIR, dir, "flow.yaml"), "utf8"),
    );
    return modulesIn(parsed).flatMap((module) => {
      const value = field(module, "value");
      const transforms = field(value, "input_transforms");
      const scriptPath = field(value, "path");
      if (typeof transforms !== "object" || transforms === null) return [];
      return Object.entries(transforms).flatMap(([arg, transform]) => {
        const expr = field(transform, "expr");
        if (typeof expr !== "string") return [];
        if (!/\bresults\b|\berror\b/.test(expr)) return [];
        return [
          {
            flow,
            step: String(field(module, "id")),
            arg,
            expr: expr.trim(),
            scriptPath: typeof scriptPath === "string" ? scriptPath : null,
          },
        ];
      });
    });
  });

function isSealed(transform: Transform): boolean {
  return (
    transform.expr.startsWith("JSON.stringify(") &&
    transform.expr.endsWith(SEAL_SUFFIX)
  );
}

function keyOf(transform: Transform): string {
  return `${transform.flow}/${transform.step}/${transform.arg}`;
}

function keysOf(table: Readonly<Record<string, string>>): string[] {
  return Object.entries(table).flatMap(([where, args]) =>
    args.split(",").map((arg) => `${where}/${arg}`),
  );
}

const SEALED_VALUES = STEP_VALUES.filter(isSealed);
const PLAIN_KEYS = new Set(keysOf(PLAIN));
const OPEN_KEYS = new Set(keysOf(OPEN));

/** どの項目へ読んでも、解決の対象になる文字列を返す。`JSON.stringify`は`toJSON`を呼ぶ。 */
function poisonProbe(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, key) => (key === "toJSON" ? () => POISON : poisonProbe()),
  });
}

function evaluate(expr: string): unknown {
  const run = new Function(
    "results",
    "flow_input",
    "error",
    `return (${expr});`,
  );
  return run(poisonProbe(), poisonProbe(), poisonProbe());
}

describe("the arguments passed between the steps of the flows", () => {
  test("finds the arguments of the flows", () => {
    expect(STEP_VALUES.length).toBeGreaterThan(100);
  });

  test("passes no unreviewed value as a plain argument", () => {
    const unreviewed = STEP_VALUES.filter(
      (transform) =>
        !isSealed(transform) &&
        !PLAIN_KEYS.has(keyOf(transform)) &&
        !OPEN_KEYS.has(keyOf(transform)),
    ).map(keyOf);

    expect(unreviewed).toEqual([]);
  });

  test("lists no reviewed argument that the flows do not pass", () => {
    const passed = new Set(
      STEP_VALUES.filter((transform) => !isSealed(transform)).map(keyOf),
    );
    const stale = [...PLAIN_KEYS, ...OPEN_KEYS].filter(
      (key) => !passed.has(key),
    );

    expect(stale).toEqual([]);
  });

  test("lists no argument as both reviewed and open", () => {
    expect([...PLAIN_KEYS].filter((key) => OPEN_KEYS.has(key))).toEqual([]);
  });

  test("seals exactly the arguments that the sealed table names", () => {
    expect(SEALED_VALUES.map(keyOf).sort()).toEqual(keysOf(SEALED).sort());
  });
});

describe("the sealed arguments", () => {
  test.each(SEALED_VALUES.map((transform) => [keyOf(transform), transform]))(
    "%s leaves no dollar sign in the text",
    (_key, transform) => {
      const text = evaluate(transform.expr);

      expect(typeof text === "string" && text.includes("$")).toBe(false);
    },
  );

  test.each(SEALED_VALUES.map((transform) => [keyOf(transform), transform]))(
    "%s restores the values that it carries",
    (_key, transform) => {
      const text = evaluate(transform.expr);

      expect(typeof text === "string" && text.includes(POISON)).toBe(false);
      expect(
        typeof text === "string" && JSON.stringify(JSON.parse(text)),
      ).toContain(POISON);
    },
  );

  test.each(SEALED_VALUES.map((transform) => [keyOf(transform), transform]))(
    "%s is read by a main that declares the argument as a string",
    (_key, transform) => {
      const source = readFileSync(
        join(REPO_ROOT, `${transform.scriptPath ?? ""}.ts`),
        "utf8",
      );

      expect(source).toContain(`  ${transform.arg}: string,`);
    },
  );

  test("builds the text that the expressions build", () => {
    const value = { a: POISON, b: [POISON, 1, null] };
    const run = new Function("v", `return JSON.stringify(v)${SEAL_SUFFIX};`);

    expect(sealUntrustedArg(value)).toBe(run(value));
  });
});
