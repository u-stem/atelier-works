import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CIの`metadata`ジョブがメタデータを作り直すときだけ起動するworkerの構成を、静的に確かめる。
// 作り直しはPRのブランチの依存を入れるので、使い捨てであること、秘密を持たないこと、
// install scriptを動かさないことが境界の要になる。
const REPO_ROOT = join(import.meta.dir, "../..");

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function services(file: string): Json {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(REPO_ROOT, "infra", file), "utf8"),
  );
  if (!isRecord(parsed) || !isRecord(parsed.services)) {
    return {};
  }
  return parsed.services;
}

function worker(): Json {
  const found = services("docker-compose.ci.yml").windmill_worker_ci;
  return isRecord(found) ? found : {};
}

function stringList(key: string): string[] {
  const value = worker()[key];
  if (value === undefined) {
    return [];
  }
  if (!isStringArray(value)) {
    throw new Error(`${key} must be a string array`);
  }
  return value;
}

describe("windmill_worker_ci", () => {
  test("is defined only in the CI overlay", () => {
    expect("windmill_worker_ci" in services("docker-compose.yml")).toBe(false);
  });

  test("uses the upstream image at the pinned Windmill version", () => {
    expect(worker().image).toBe(
      "ghcr.io/windmill-labs/windmill:${WM_VERSION:?run via mise}",
    );
  });

  test("runs as a worker", () => {
    expect(stringList("environment")).toContain("MODE=worker");
  });

  test("joins the default worker group, which takes the dependency jobs", () => {
    expect(stringList("environment")).toContain("WORKER_GROUP=default");
  });

  test("asks npm to skip install scripts", () => {
    expect(stringList("environment")).toContain(
      "NPM_CONFIG_IGNORE_SCRIPTS=true",
    );
  });

  test("lets that variable through the child process filter", () => {
    expect(stringList("environment")).toContain(
      "WHITELIST_ENVS=NPM_CONFIG_IGNORE_SCRIPTS",
    );
  });

  test("mounts the bunfig that disables install scripts, read-only", () => {
    expect(stringList("volumes")).toEqual([
      "./ci-worker-bunfig.toml:/root/.bunfig.toml:ro",
    ]);
  });

  test("publishes no port", () => {
    expect("ports" in worker()).toBe(false);
  });

  test("carries no secret except the throwaway database password", () => {
    const names = stringList("environment")
      .map((entry) => entry.split("=")[0] ?? "")
      .sort();

    expect(names).toEqual([
      "DATABASE_URL",
      "MODE",
      "NPM_CONFIG_IGNORE_SCRIPTS",
      "NUM_WORKERS",
      "WHITELIST_ENVS",
      "WORKER_GROUP",
    ]);
  });

  test("waits for the database to be healthy", () => {
    const dependsOn = worker().depends_on;

    expect(isRecord(dependsOn) && dependsOn.db).toEqual({
      condition: "service_healthy",
    });
  });
});

describe("ci-worker-bunfig.toml", () => {
  test("turns off the install scripts of every dependency", () => {
    const parsed: unknown = Bun.TOML.parse(
      readFileSync(join(REPO_ROOT, "infra", "ci-worker-bunfig.toml"), "utf8"),
    );

    expect(isRecord(parsed) && parsed.install).toEqual({ ignoreScripts: true });
  });
});
