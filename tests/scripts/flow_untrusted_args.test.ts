// stepの間で渡す値が、Windmillの引数の解決の対象にならない形かを、すべてのflowの定義から確かめる。
// Windmillは、ジョブの引数の文字列が`$var:`、`$jsonvar:`、`$res:`、`$encrypted:`で始まるとき、ジョブの権限で解決する。
// 前のstepの結果を式に持つ引数(`results`、`previous_result`、`resume`、`flow_input.iter`、失敗の`error`)は、
// 次のどれかでなければならない。
// - 値全体をJSONの文字列にして渡す(`lib/untrusted_arg.ts`)。式は`JSON.stringify(...)`で始まり、`$`を置き換える呼び出しで終わる。
// - 下の`PLAIN`に、flowとstepと引数の名前を挙げる。参照の形を取れない値だけを挙げる。
// - 下の`ACCEPTED`に、flowとstepと引数の名前を挙げる。受け入れる根拠をテストで確かめる。
// 新しいflowやstepが、表にない値を包まずに渡すと、このテストが落ちる。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Guard } from "../../f/factory/lib/untrusted_arg.ts";
import { DEPENDABOT_ASSESS_UNTRUSTED } from "../../f/factory/steps/dependabot_assess.ts";
import { DEPENDABOT_FINISH_UNTRUSTED } from "../../f/factory/steps/dependabot_finish.ts";
import { IMPLEMENT_FINISH_UNTRUSTED } from "../../f/factory/steps/implement_finish.ts";
import { IMPLEMENT_GENERATE_UNTRUSTED } from "../../f/factory/steps/implement_generate.ts";
import { IMPLEMENT_VERIFY_UNTRUSTED } from "../../f/factory/steps/implement_verify.ts";
import { PR_FIX_APPLY_UNTRUSTED } from "../../f/factory/steps/pr_fix_apply.ts";
import { PR_FIX_FINISH_UNTRUSTED } from "../../f/factory/steps/pr_fix_finish.ts";
import { PR_FIX_VERIFY_UNTRUSTED } from "../../f/factory/steps/pr_fix_verify.ts";
import { PR_REVIEW_POST_UNTRUSTED } from "../../f/factory/steps/pr_review_post.ts";
import { SEAL_SUFFIX, sealUntrustedArg } from "../lib/untrustedArgSupport.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const FACTORY_DIR = join(REPO_ROOT, "f/factory");
const FLOW_DIR_SUFFIX = "__flow";

/** 値の中の`$`がどこにも残らないことを確かめる、解決の対象になる文字列。 */
const POISON = "$var:f/factory/github_token";

/**
 * 包まずに渡してよい引数。`flow/step`ごとに、引数の名前をコンマで並べる。
 * どれも、先頭が`$var:`などの形を取れない値である。
 * - 数、真偽値、作業項目やチェックのid、数だけを持つ集計(監査の`metrics`)
 * - git参照のsha
 * - GitHubのownerとrepoの名前(`$`を含められない)と、GitHubが返すURL(先頭が`https://`)
 * - factoryが作る作業用の置き場と、`.git`の指し先(先頭が`gitdir:`)
 * - 検査を通した列挙値と、検証した識別子(冪等キー、進め方)
 * - 先頭が固定の文字列(調査の本文は役割のタグ、証跡パックは注意書き)と、固定の2種類の符号
 */
const PLAIN: Readonly<Record<string, string>> = {
  "audit/audit_generate": "evidence_markdown,factory_clone_dir,metrics",
  "design/generate": "head_sha,worktree_dir",
  "implement/implement_finish": "prepare_outcome",
  "investigate/investigate_prepare": "work_item_id",
  "investigate/investigate_generate":
    "factory_clone_dir,repo_dir,sha,work_item_id",
  "investigate/investigate_post": "comment_body,withheld,work_item_id",
  "manual_intake/register":
    "intake_key,issue_number,issue_url,owner,profile,repo,reused",
  "pipeline/generate": "worktree_dir",
  "pr_fix/pr_fix_collect": "owner,pr_number,repo",
  "pr_fix/pr_fix_apply":
    "attempt,base_sha,ci_check_id,conflict_check_id,factory_clone_dir,head_sha,owner,parent_work_item_id,pr_number,repo,worktree_dir,worktree_git_pointer",
  "pr_fix/pr_fix_verify":
    "apply_outcome,attempt,auto_tree_sha,base_sha,baseline_sha,ci_check_id,conflict_check_id,factory_clone_dir,head_sha,owner,parent_work_item_id,pr_number,repo,worktree_dir,worktree_git_pointer",
  "pr_fix/pr_fix_finish":
    "auto_tree_sha,base_sha,baseline_sha,ci_check_id,conflict_check_id,fix_round,head_sha,max_comment_id,max_review_comment_id,max_review_id,outcome,owner,parent_work_item_id,pr_number,repo,repo_dir,trigger_review_ids,verified_tree_sha,worktree_dir,worktree_git_pointer",
  "pr_review/pr_review_generate":
    "attempt,factory_clone_dir,owner,parent_work_item_id,pr_number,repo,review_sha,skip,worktree_dir",
  "pr_review/pr_review_post":
    "binary_unlisted_count,owner,pr_number,repo,repo_dir,review_sha,skip,worktree_dir",
};

/**
 * 包まずに受け入れる引数。
 * 運用者が自由に入力した文で、先頭が固定でない。入力するConsoleのscriptは、フォルダ`f/factory`の権限を持つ主体だけが実行でき、
 * 起動したflowも同じ主体の権限で動く(`on_behalf_of_email`を置かない)。入力した主体は、変数を直接読める主体と同じである。
 */
const ACCEPTED: Readonly<Record<string, string>> = {
  "manual_intake/register": "body,title",
};

/** 値全体を包む引数。flowとstepごとに、引数の名前を挙げる。 */
const SEALED: Readonly<Record<string, string>> = {
  "audit/failure": "error",
  "dependabot/dependabot_assess": "untrusted",
  "dependabot/dependabot_finish": "untrusted",
  "dependabot/failure": "error",
  "design/failure": "error",
  "implement/implement_finish": "untrusted",
  "implement/implement_generate": "untrusted",
  "implement/implement_verify": "untrusted",
  "implement/failure": "error",
  "investigate/failure": "error",
  "manual_intake/failure": "error",
  "pipeline/failure": "error",
  "pr_fix/failure": "error",
  "pr_fix/pr_fix_apply": "untrusted",
  "pr_fix/pr_fix_finish": "untrusted",
  "pr_fix/pr_fix_verify": "untrusted",
  "pr_review/failure": "error",
  "pr_review/pr_review_post": "untrusted",
};

/** 包んだ引数`untrusted`を戻すstepの型ガード。式のキーと、型ガードが確かめるキーが一致することを確かめる。 */
const SHAPES: Readonly<
  Record<string, Guard<unknown> & { readonly keys: readonly string[] }>
> = {
  "dependabot/dependabot_assess": DEPENDABOT_ASSESS_UNTRUSTED,
  "dependabot/dependabot_finish": DEPENDABOT_FINISH_UNTRUSTED,
  "implement/implement_finish": IMPLEMENT_FINISH_UNTRUSTED,
  "implement/implement_generate": IMPLEMENT_GENERATE_UNTRUSTED,
  "implement/implement_verify": IMPLEMENT_VERIFY_UNTRUSTED,
  "pr_fix/pr_fix_apply": PR_FIX_APPLY_UNTRUSTED,
  "pr_fix/pr_fix_finish": PR_FIX_FINISH_UNTRUSTED,
  "pr_fix/pr_fix_verify": PR_FIX_VERIFY_UNTRUSTED,
  "pr_review/pr_review_post": PR_REVIEW_POST_UNTRUSTED,
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

/** 前のstepの結果か失敗の`error`を式に持つ引数の判定。 */
const CARRIES_STEP_VALUE =
  /\b(?:results|error|previous_result|resume)\b|\bflow_input\.iter\b/;

/** 前のstepの結果を式に持つ引数を、すべてのflowから集める。 */
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
        if (!CARRIES_STEP_VALUE.test(expr)) return [];
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

function moduleOf(transform: Transform): string {
  return `${transform.flow}/${transform.step}`;
}

function keysOf(table: Readonly<Record<string, string>>): string[] {
  return Object.entries(table).flatMap(([where, args]) =>
    args.split(",").map((arg) => `${where}/${arg}`),
  );
}

const SEALED_VALUES = STEP_VALUES.filter(isSealed);
const PLAIN_KEYS = new Set(keysOf(PLAIN));
const ACCEPTED_KEYS = new Set(keysOf(ACCEPTED));

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
    "previous_result",
    "resume",
    `return (${expr});`,
  );
  return run(
    poisonProbe(),
    poisonProbe(),
    poisonProbe(),
    poisonProbe(),
    poisonProbe(),
  );
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
        !ACCEPTED_KEYS.has(keyOf(transform)),
    ).map(keyOf);

    expect(unreviewed).toEqual([]);
  });

  test("lists no reviewed argument that the flows do not pass", () => {
    const passed = new Set(
      STEP_VALUES.filter((transform) => !isSealed(transform)).map(keyOf),
    );
    const stale = [...PLAIN_KEYS, ...ACCEPTED_KEYS].filter(
      (key) => !passed.has(key),
    );

    expect(stale).toEqual([]);
  });

  test("lists no argument as both plain and accepted", () => {
    expect([...PLAIN_KEYS].filter((key) => ACCEPTED_KEYS.has(key))).toEqual([]);
  });

  test("seals exactly the arguments that the sealed table names", () => {
    expect(SEALED_VALUES.map(keyOf).sort()).toEqual(keysOf(SEALED).sort());
  });

  test("seals the failure of every flow", () => {
    const flows = readdirSync(FACTORY_DIR)
      .filter((name) => name.endsWith(FLOW_DIR_SUFFIX))
      .map((name) => name.slice(0, -FLOW_DIR_SUFFIX.length))
      .sort();

    expect(
      SEALED_VALUES.filter((transform) => transform.step === "failure")
        .map((transform) => transform.flow)
        .sort(),
    ).toEqual(flows.filter((flow) => flow !== "pr_review_intake"));
  });
});

/** 運用者が自由に入力した文を、包まずにflowへ渡すConsoleのscript。 */
const OPERATOR_INPUT_SCRIPTS = [
  "approval_decide.ts",
  "manual_intake_submit.ts",
  "pr_review_submit.ts",
];

describe("the accepted arguments", () => {
  test.each(OPERATOR_INPUT_SCRIPTS)(
    "%s starts the flow without running it on behalf of another user",
    (name) => {
      const source = readFileSync(join(FACTORY_DIR, name), "utf8");

      const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);

      expect(code).not.toContain("on_behalf_of_email");
    },
  );
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

describe("the keys of the sealed objects", () => {
  const OBJECT_VALUES = SEALED_VALUES.filter((transform) =>
    transform.expr.startsWith("JSON.stringify({"),
  );

  test("are all declared by a shape in the table", () => {
    expect(OBJECT_VALUES.map(moduleOf).sort()).toEqual(
      Object.keys(SHAPES).sort(),
    );
  });

  test.each(OBJECT_VALUES.map((transform) => [keyOf(transform), transform]))(
    "%s has the keys that the guard of the step checks",
    (_key, transform) => {
      const text = evaluate(transform.expr);
      const expressionKeys =
        typeof text === "string" ? Object.keys(JSON.parse(text)) : [];

      expect([...expressionKeys].sort()).toEqual(
        [...(SHAPES[moduleOf(transform)]?.keys ?? [])].sort(),
      );
    },
  );
});
