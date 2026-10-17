import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createFixtureRepo,
  type FixtureRepo,
  fixtureGitEnv,
} from "../fixtures/host_apply_repo.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const HOST_APPLY_DIR = join(REPO_ROOT, "scripts/host_apply");
const ENTRY = join(REPO_ROOT, "scripts/host-apply.ts");

/** ソースに現れるimportとrequireの指定子。動的な指定子は`<dynamic>`として返す。 */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const fromPattern =
    /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  const sideEffect = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  const call = /\b(?:import|require)\s*\(\s*(["'][^"']+["']|[^)]*)\)/g;
  for (const match of source.matchAll(fromPattern)) found.push(match[1] ?? "");
  for (const match of source.matchAll(sideEffect)) found.push(match[1] ?? "");
  for (const match of source.matchAll(call)) {
    const arg = match[1] ?? "";
    found.push(/^["'][^"']+["']$/.test(arg) ? arg.slice(1, -1) : "<dynamic>");
  }
  return found;
}

/** 許可する指定子か。NodeとBunの組み込みと、`scripts/host_apply/`の中だけ。 */
function isAllowed(file: string, specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (specifier === "bun" || specifier.startsWith("bun:")) return true;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const target = resolve(dirname(file), specifier);
  return target.startsWith(`${HOST_APPLY_DIR}/`);
}

function sourceFiles(): string[] {
  const inDir = readdirSync(HOST_APPLY_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(HOST_APPLY_DIR, name));
  return [ENTRY, ...inDir];
}

function violations(files: string[]): string[] {
  const bad: string[] = [];
  for (const file of files) {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (!isAllowed(file, specifier)) bad.push(`${file}: ${specifier}`);
    }
  }
  return bad;
}

describe("the import checker", () => {
  const file = join(HOST_APPLY_DIR, "x.ts");

  test.each([
    'import { a } from "../../f/factory/lib/x.ts";',
    'import { a } from "../host-apply.ts";',
    'import x from "windmill-client";',
    'export * from "./../../f/y.ts";',
    'const m = await import("../../f/z.ts");',
    'const r = require("left-pad");',
    'import "../../f/side.ts";',
    "const m = await import(name);",
  ])("flags %s", (source) => {
    expect(
      specifiers(source).filter((specifier) => !isAllowed(file, specifier)),
    ).not.toEqual([]);
  });

  test.each([
    'import { a } from "node:path";',
    'import { b } from "./ci.ts";',
    'import type { C } from "./target.ts";',
    'import { spawn } from "bun";',
    'import { t } from "bun:test";',
    'import {\n  a,\n  b,\n} from "./constants.ts";',
  ])("accepts %s", (source) => {
    expect(
      specifiers(source).filter((specifier) => !isAllowed(file, specifier)),
    ).toEqual([]);
  });
});

describe("the executor sources", () => {
  test("include the entry point and every module", () => {
    expect(sourceFiles().length).toBeGreaterThan(12);
  });

  test("import only built-ins and scripts/host_apply/", () => {
    expect(violations(sourceFiles())).toEqual([]);
  });

  test("never import from f/", () => {
    const text = sourceFiles()
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(text).not.toMatch(/from\s*["'][^"']*\/f\/|["']\/f\//);
  });
});

describe("the executor runs on its own once copied", () => {
  const cleanups: (() => void)[] = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  test("a copy outside the repository answers a plan", () => {
    const repo: FixtureRepo = createFixtureRepo();
    cleanups.push(() => repo.cleanup());
    const applied = repo.commit(
      {
        "mise.toml": readFileSync(join(REPO_ROOT, "mise.toml"), "utf8"),
        "infra/docker-compose.yml": readFileSync(
          join(REPO_ROOT, "infra/docker-compose.yml"),
          "utf8",
        ),
      },
      "base",
    );
    const target = repo.commit({ "docs/a.md": "x\n" }, "docs");

    const stateDir = mkdtempSync(join(tmpdir(), "host-apply-bin-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const bin = join(stateDir, "bin");
    mkdirSync(bin);
    cpSync(ENTRY, join(bin, "host-apply.ts"));
    cpSync(HOST_APPLY_DIR, join(bin, "host_apply"), { recursive: true });
    writeFileSync(join(stateDir, "empty.toml"), "");

    const result = Bun.spawnSync(
      [
        "bun",
        "--no-env-file",
        "--config",
        join(stateDir, "empty.toml"),
        join(bin, "host-apply.ts"),
        "plan",
        "--repo",
        repo.dir,
        "--applied",
        applied,
        "--target",
        target,
      ],
      { cwd: stateDir, env: fixtureGitEnv(stateDir) },
    );
    expect(JSON.parse(result.stdout.toString()).decision).toBe(
      "would_converge",
    );
  });
});
