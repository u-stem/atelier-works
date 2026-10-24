// `collect_github`の定義(script、スケジュール、secret変数)と、importでたどれる範囲を静的に確かめる。
// 定期ジョブ用workerの契約(許可するsecret、timeout、道具への依存)は
// `periodic_script_boundary.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  codeOf,
  relative,
  sourcesReachableFrom,
  yamlOf,
} from "./worker_boundary_scan.ts";

const SCRIPT = "f/factory/collect_github";
const SOURCE = readFileSync(`${SCRIPT}.ts`, "utf8");

const reached = () =>
  [...sourcesReachableFrom(SCRIPT).keys()].map(relative).sort();

describe("collect_github schedule", () => {
  test("runs at minute 1 of every fifth minute, away from the top of the hour", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).schedule).toBe(
      "0 1-59/5 * * * *",
    );
  });

  test("uses the Asia/Tokyo time zone", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).timezone).toBe(
      "Asia/Tokyo",
    );
  });

  test("does not overlap with its own previous run", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).no_flow_overlap).toBe(
      true,
    );
  });

  test("calls the script", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).script_path).toBe(SCRIPT);
  });

  test("is enabled, since the collection itself is off until the config turns it on", async () => {
    expect((await yamlOf(`${SCRIPT}.schedule.yaml`)).enabled).toBe(true);
  });
});

describe("collect_github script definition", () => {
  test("runs on the periodic worker", async () => {
    expect((await yamlOf(`${SCRIPT}.script.yaml`)).tag).toBe("periodic");
  });

  test("times out in 120 seconds", async () => {
    expect((await yamlOf(`${SCRIPT}.script.yaml`)).timeout).toBe(120);
  });

  test("takes no arguments", async () => {
    const schema = (await yamlOf(`${SCRIPT}.script.yaml`)).schema;
    expect(
      typeof schema === "object" && schema !== null && "properties" in schema
        ? schema.properties
        : null,
    ).toEqual({});
  });
});

describe("the github_read_tokens variable", () => {
  const VARIABLE = "f/factory/github_read_tokens.variable.yaml";

  test("is a secret", async () => {
    expect((await yamlOf(VARIABLE)).is_secret).toBe(true);
  });

  test("is empty in the repository", async () => {
    expect((await yamlOf(VARIABLE)).value).toBe("");
  });

  test("is described in Japanese", async () => {
    expect(String((await yamlOf(VARIABLE)).description)).toMatch(/[぀-ヿ一-鿿]/);
  });
});

describe("collect_github source", () => {
  test("reads the token variable by a literal path", () => {
    expect(codeOf(SOURCE)).toContain(
      'getVariable("f/factory/github_read_tokens")',
    );
  });

  test("does not read github_token", () => {
    expect(codeOf(SOURCE)).not.toContain("f/factory/github_token");
  });

  test("does not use the native runtime", () => {
    expect(SOURCE).not.toMatch(/^\/\/\s*native/m);
  });

  test("reads the config from the factory_config resource", () => {
    expect(codeOf(SOURCE)).toContain('getResource("f/factory/factory_config")');
  });
});

describe("what collect_github reaches by import", () => {
  test.each([
    "f/factory/lib/gh_collect.ts",
    "f/factory/lib/gh_collect_support.ts",
    "f/factory/lib/gh_graphql.ts",
    "f/factory/lib/owner_id_notice.ts",
    "f/factory/lib/db.ts",
    "f/factory/lib/config.ts",
    "f/factory/lib/log.ts",
    "f/factory/lib/types.ts",
  ])("reaches %s", (file) => {
    expect(reached()).toContain(file);
  });

  test.each([
    "f/factory/lib/github.ts",
    "f/factory/lib/workspace.ts",
    "f/factory/lib/job_tmp.ts",
    "f/factory/lib/poll_support.ts",
  ])("does not reach %s", (file) => {
    expect(reached()).not.toContain(file);
  });
});
