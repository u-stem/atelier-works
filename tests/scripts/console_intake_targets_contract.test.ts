// console_queryの"intake_targets"ビューが返す、手動投入の候補を確かめる。
// 候補は、選べば必ず通るリポジトリだけである。設定の他の値は返さない。

import { describe, expect, test } from "bun:test";
import { isIntakeTargets } from "../../console/src/api/guards/intakeTargets.ts";
import type { FactoryConfig } from "../../f/factory/lib/types.ts";
import { main, runIntakeTargets } from "../../f/factory/steps/console_query.ts";

type AllowConfig = Pick<
  FactoryConfig,
  "owners" | "repo_allowlist" | "factory_repo"
>;

const CONFIG: AllowConfig = {
  owners: [{ name: "octo-owner", kind: "user" }],
  repo_allowlist: [],
  factory_repo: "https://github.com/octo-owner/atelier-works",
};

function targets(config: AllowConfig) {
  return runIntakeTargets(() => Promise.resolve(config));
}

describe("intake_targets", () => {
  test("is only the factory repo when repo_allowlist is empty", async () => {
    expect(await targets(CONFIG)).toEqual([
      { owner: "octo-owner", repo: "atelier-works" },
    ]);
  });

  test("lists the repo_allowlist entries after the factory repo", async () => {
    const config = {
      ...CONFIG,
      repo_allowlist: [
        "https://github.com/octo-owner/widgets.git",
        "https://github.com/octo-owner/gadgets",
      ],
    };
    expect(await targets(config)).toEqual([
      { owner: "octo-owner", repo: "atelier-works" },
      { owner: "octo-owner", repo: "widgets" },
      { owner: "octo-owner", repo: "gadgets" },
    ]);
  });

  test("leaves out an entry whose owner is not in owners", async () => {
    const config = {
      ...CONFIG,
      repo_allowlist: [
        "https://github.com/stranger/widgets",
        "https://github.com/octo-owner/gadgets",
      ],
    };
    expect(await targets(config)).toEqual([
      { owner: "octo-owner", repo: "atelier-works" },
      { owner: "octo-owner", repo: "gadgets" },
    ]);
  });

  test("keeps the factory repo even when its owner is not in owners", async () => {
    const config = { ...CONFIG, owners: [] };
    expect(await targets(config)).toEqual([
      { owner: "octo-owner", repo: "atelier-works" },
    ]);
  });

  test("lists a repo once whatever its case", async () => {
    const config = {
      ...CONFIG,
      repo_allowlist: ["https://github.com/Octo-Owner/Atelier-Works"],
    };
    expect(await targets(config)).toEqual([
      { owner: "octo-owner", repo: "atelier-works" },
    ]);
  });

  test("skips an entry that is not a GitHub repository URL", async () => {
    const config = { ...CONFIG, repo_allowlist: ["not a url"] };
    expect(await targets(config)).toEqual([
      { owner: "octo-owner", repo: "atelier-works" },
    ]);
  });

  test("returns nothing but owner and repo for each entry", async () => {
    const config = {
      ...CONFIG,
      repo_allowlist: ["https://github.com/octo-owner/widgets"],
    };
    const keys = (await targets(config)).map((entry) =>
      Object.keys(entry).sort(),
    );
    expect(keys).toEqual([
      ["owner", "repo"],
      ["owner", "repo"],
    ]);
  });
});

describe("the console guard", () => {
  test("accepts the targets as Windmill delivers them", async () => {
    const config = {
      ...CONFIG,
      repo_allowlist: ["https://github.com/octo-owner/widgets"],
    };
    expect(
      isIntakeTargets(JSON.parse(JSON.stringify(await targets(config)))),
    ).toBe(true);
  });
});

describe("the view list", () => {
  test("names intake_targets when console_query refuses an unknown view", async () => {
    const message = await main("not-a-view").then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(message).toContain("intake_targets");
  });
});
