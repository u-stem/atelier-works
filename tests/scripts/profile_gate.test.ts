// 進め方(profile)ごとの承認の要否を固定する。
// 承認を省く進め方の判定は、`lib/profile.ts`の`requiredApprovals`の1か所にある。
// 受け付ける進め方の一覧(`ACCEPTED_PROFILES`)に無い値は、すべて要件定義と設計の承認を要る側に倒す。
// このテストは保護パスに置く。実装フローの自動修正やPRの修正が表を緩めたり、関門が表を通さなくしたりして、
// このテストを書き換えると、承認を省く進め方が黙って通るようになるためである。
//
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。変換できないファイルは失敗として扱う(fail-closed)。
// 追えない形がある。関数を別名で取り込む、または識別子を連結で組み立てる呼び出しは数えられない。
// 関数の観測と組み合わせて守る。
//
// 設計工程の中のファイル(`design_prepare`、`design_generate`、`design_apply_support`、`pr_fix_design`)は、
// 通常の進め方(`standard`)だけを扱うので、進め方を関門に渡さない。
// 受け付ける進め方を広げるときは、この表から外して関門に進め方を渡す。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  ACCEPTED_PROFILES,
  requiredApprovals,
} from "../../f/factory/lib/profile.ts";
import { WORK_ITEM_PROFILES } from "../../f/factory/lib/types.ts";

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

const BOTH_REQUIRED = { requirements: true, design: true };

describe("requiredApprovals", () => {
  test("requires the requirements approval for the standard profile", () => {
    expect(requiredApprovals("standard").requirements).toBe(true);
  });

  test("requires the design approval for the standard profile", () => {
    expect(requiredApprovals("standard").design).toBe(true);
  });

  const NOT_STANDARD = WORK_ITEM_PROFILES.filter(
    (profile) => profile !== "standard",
  );

  test("the database allows at least one profile besides standard", () => {
    expect(NOT_STANDARD.length).toBeGreaterThan(0);
  });

  test.each(NOT_STANDARD)(
    "requires both approvals for %s, which is not accepted",
    (profile) => {
      expect(requiredApprovals(profile)).toEqual(BOTH_REQUIRED);
    },
  );

  test.each([
    "",
    "Standard",
    " standard",
    "standard\n",
    "unknown",
    "constructor",
    "toString",
    "hasOwnProperty",
    "__proto__",
  ])("requires both approvals for the unknown value %j", (profile) => {
    expect(requiredApprovals(profile)).toEqual(BOTH_REQUIRED);
  });
});

describe("ACCEPTED_PROFILES", () => {
  test("is exactly standard", () => {
    expect([...ACCEPTED_PROFILES]).toEqual(["standard"]);
  });

  test("is written as that literal", () => {
    expect(codeOf("lib/profile.ts")).toMatch(
      /\bACCEPTED_PROFILES\s*=\s*\[\s*"standard"\s*\]\s*;/,
    );
  });

  test.each(WORK_ITEM_PROFILES.filter((profile) => profile !== "standard"))(
    "does not list %s",
    (profile) => {
      expect(ACCEPTED_PROFILES).not.toContain(profile);
    },
  );
});

describe("lib/profile.ts", () => {
  test("imports nothing, so that no other file changes the table", () => {
    expect(codeOf("lib/profile.ts")).not.toMatch(/\bimport\b/);
  });

  test("decides by the accepted list, not by a comparison with standard", () => {
    expect(codeOf("lib/profile.ts")).not.toMatch(/[=!]==?\s*"standard"/);
  });
});

// ---------------------------------------------------------------------------
// 表の定義と取り込み
// ---------------------------------------------------------------------------

const TABLE_NAMES = ["requiredApprovals", "ACCEPTED_PROFILES"] as const;
const TABLE_NAME_PATTERN = TABLE_NAMES.join("|");
const TABLE_MODULE = "lib/profile.ts";

/** 表の名前の宣言、代入、別名での再束縛。 */
const TABLE_DEFINITION = new RegExp(
  `\\bfunction\\s+(?:${TABLE_NAME_PATTERN})\\b` +
    `|\\b(?:const|let|var)\\s+(?:${TABLE_NAME_PATTERN})\\b` +
    `|\\b(?:${TABLE_NAME_PATTERN})\\s*=(?!=)` +
    `|\\bas\\s+(?:${TABLE_NAME_PATTERN})\\b`,
);

/**
 * `path`が`name`を取り込む(再エクスポートを含む)モジュールの、`f/factory`からの相対パス。
 * 取り込む形は`{ name }`だけを見る。別名は左側の名前で数える。
 */
function modulesProviding(path: string, name: string): string[] {
  const modules: string[] = [];
  const statements = codeOf(path).matchAll(
    /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g,
  );
  for (const [, names, specifier] of statements) {
    const imported = (names ?? "")
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0]);
    if (imported.includes(name) && specifier !== undefined) {
      modules.push(posix.join(posix.dirname(path), specifier));
    }
  }
  return modules;
}

describe("the table of approvals", () => {
  test("is defined only in lib/profile.ts", () => {
    const definers = productionSources().filter(
      (path) => path !== TABLE_MODULE && TABLE_DEFINITION.test(codeOf(path)),
    );
    expect(definers).toEqual([]);
  });

  test("is imported only from lib/profile.ts", () => {
    const elsewhere = productionSources().flatMap((path) =>
      TABLE_NAMES.flatMap((name) =>
        modulesProviding(path, name)
          .filter((module) => module !== TABLE_MODULE)
          .map((module) => `${path}: ${name} from ${module}`),
      ),
    );
    expect(elsewhere).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 関門を呼ぶ場所
// ---------------------------------------------------------------------------

const GATE_FUNCTIONS = [
  "designGate",
  "isReadyForImplement",
  "isRequirementsApprovedForAttempt",
] as const;

type GateFunction = (typeof GATE_FUNCTIONS)[number];

/** `path`の本番のコードが呼ぶ、承認の関門の関数。宣言は数えない。 */
function gateFunctionsCalledIn(path: string): GateFunction[] {
  const code = codeOf(path);
  return GATE_FUNCTIONS.filter((name) =>
    new RegExp(`(?<!\\bfunction\\s+)(?<![\\w$])${name}\\(`).test(code),
  );
}

/**
 * 関門に進め方を渡す呼び出し元。キーは`f/factory`からの相対パス。
 * `implement_prepare`と再実行は、`requiredApprovals`を通して要件定義の承認の要否を決める。
 * 自動再開と自己更新は、候補の行(進め方を含む)を`isReadyForImplement`に渡す。
 */
const PROFILE_AWARE_CALLERS: Readonly<Record<string, readonly GateFunction[]>> =
  {
    "auto_retry_stale_image.ts": ["isReadyForImplement"],
    "retry_work_item.ts": ["isRequirementsApprovedForAttempt"],
    "self_update.ts": ["isReadyForImplement"],
    "steps/implement_prepare.ts": [
      "designGate",
      "isRequirementsApprovedForAttempt",
    ],
  };

/**
 * 進め方を渡さない呼び出し元。設計工程の中で、通常の進め方だけを扱う。
 * 受け付ける進め方を広げるときに見直す。
 */
const STANDARD_ONLY_CALLERS: Readonly<Record<string, readonly GateFunction[]>> =
  {
    "lib/design_apply_support.ts": ["isRequirementsApprovedForAttempt"],
    "lib/pr_fix_design.ts": ["designGate", "isRequirementsApprovedForAttempt"],
    "steps/design_generate.ts": ["isRequirementsApprovedForAttempt"],
    "steps/design_prepare.ts": ["isRequirementsApprovedForAttempt"],
  };

describe("the callers of the approval gate", () => {
  test("are exactly the files in the two tables", () => {
    const observed: Record<string, readonly GateFunction[]> = {};
    for (const path of productionSources()) {
      if (path === "lib/approval_gate.ts") continue;
      const called = gateFunctionsCalledIn(path);
      if (called.length > 0) observed[path] = called;
    }
    expect(observed).toEqual({
      ...PROFILE_AWARE_CALLERS,
      ...STANDARD_ONLY_CALLERS,
    });
  });

  test("do not appear in both tables", () => {
    const both = Object.keys(PROFILE_AWARE_CALLERS).filter(
      (path) => path in STANDARD_ONLY_CALLERS,
    );
    expect(both).toEqual([]);
  });

  test.each(
    Object.entries(PROFILE_AWARE_CALLERS).filter(([, called]) =>
      called.includes("isRequirementsApprovedForAttempt"),
    ),
  )(
    "%s decides the requirements approval through requiredApprovals",
    (path) => {
      expect(codeOf(path)).toMatch(
        /\brequiredApprovals\(\s*workItem\.profile\s*\)/,
      );
    },
  );

  test.each(
    Object.entries(PROFILE_AWARE_CALLERS).filter(([, called]) =>
      called.includes("isReadyForImplement"),
    ),
  )(
    "%s hands the candidate row, which has the profile, to the gate",
    (path) => {
      expect(codeOf(path)).toMatch(
        /\bisReadyForImplement\(\s*candidate,\s*config\.design_enabled,/,
      );
    },
  );

  test.each([
    "lib/approval_gate.ts",
    ...Object.entries(PROFILE_AWARE_CALLERS)
      .filter(([, called]) =>
        called.includes("isRequirementsApprovedForAttempt"),
      )
      .map(([path]) => path),
  ])("%s imports requiredApprovals from lib/profile.ts", (path) => {
    expect(modulesProviding(path, "requiredApprovals")).toEqual([TABLE_MODULE]);
  });

  test("lib/pr_fix_design.ts hands the standard profile to the gate explicitly", () => {
    expect(codeOf("lib/pr_fix_design.ts")).toMatch(
      /\bworkItem:\s*\{\s*\.\.\.parent,\s*profile:\s*"standard"\s*\}/,
    );
  });

  test("the candidate query selects the profile", () => {
    expect(codeOf("lib/db.ts")).toMatch(
      /SELECT w\.id, w\.kind, w\.status, w\.owner, w\.repo, w\.pr_url, w\.attempt, w\.design_attempt, w\.profile,/,
    );
  });
});

describe("lib/approval_gate.ts", () => {
  /** 関数宣言の本体。先頭の字下げの無い閉じ括弧までを返す。 */
  function bodyOf(name: string): string {
    const code = codeOf("lib/approval_gate.ts");
    const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`).exec(code);
    if (match === null) throw new Error(`${name} was not found`);
    return match[0];
  }

  test("isReadyForImplement reads the table by the profile of the item", () => {
    expect(bodyOf("isReadyForImplement")).toMatch(
      /\brequiredApprovals\(\s*item\.profile\s*\)/,
    );
  });

  test("designGate reads the table by the profile of the work item", () => {
    expect(bodyOf("designGate")).toMatch(
      /\brequiredApprovals\(\s*workItem\.profile\s*\)/,
    );
  });

  test("imports the table from lib/profile.ts", () => {
    expect(codeOf("lib/approval_gate.ts")).toMatch(/from\s*"\.\/profile\.ts"/);
  });
});

// ---------------------------------------------------------------------------
// 要件定義の生成へ戻す更新
// ---------------------------------------------------------------------------

/**
 * `UPDATE factory.work_items`が書く`SET`の節。
 * 承認を省く進め方の作業項目が要件定義の生成へ移るときは、同じ文で進め方を通常の進め方に戻す。
 * 戻さないと、人が承認した要件定義ではなく、承認を省く経路の入力で実装が進む。
 */
function workItemSetClauses(path: string): string[] {
  return [
    ...codeOf(path).matchAll(
      /UPDATE\s+factory\.work_items\s+SET\s+([\s\S]*?)\s+WHERE\b/g,
    ),
  ].map((match) => match[1] ?? "");
}

const WRITES_REQUIREMENTS_GENERATING =
  /\bstatus\s*=\s*'requirements_generating'/;
const SETS_STANDARD_PROFILE = /\bprofile\s*=\s*'standard'/;

describe("the updates that move a work item to requirements_generating", () => {
  test("exist in lib/db.ts", () => {
    const writers = workItemSetClauses("lib/db.ts").filter((clause) =>
      WRITES_REQUIREMENTS_GENERATING.test(clause),
    );
    expect(writers.length).toBeGreaterThanOrEqual(3);
  });

  test("all set the profile to standard in the same statement", () => {
    const offenders = productionSources().flatMap((path) =>
      workItemSetClauses(path)
        .filter(
          (clause) =>
            WRITES_REQUIREMENTS_GENERATING.test(clause) &&
            !SETS_STANDARD_PROFILE.test(clause),
        )
        .map((clause) => `${path}: ${clause}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the implement preparation", () => {
  test("skips the approvals only when the table does not require the requirements", () => {
    expect(
      /\brequirementsRequired:\s*requiredApprovals\(\s*workItem\.profile\s*\)\.requirements\b/.test(
        codeOf("steps/implement_prepare.ts"),
      ),
    ).toBe(true);
  });
});
