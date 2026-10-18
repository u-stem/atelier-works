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

/** ディレクトリの下の`.ts`を、サブディレクトリも含めて集める。 */
function collectTs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectTs(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

function sourceFiles(): string[] {
  return [ENTRY, ...collectTs(HOST_APPLY_DIR)];
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

describe("collectTs", () => {
  test("includes files in subdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "collect-ts-"));
    try {
      mkdirSync(join(dir, "deep/er"), { recursive: true });
      writeFileSync(join(dir, "a.ts"), "");
      writeFileSync(join(dir, "deep/er/b.ts"), "");
      writeFileSync(join(dir, "deep/c.md"), "");
      expect(collectTs(dir).map((path) => path.slice(dir.length + 1))).toEqual([
        "a.ts",
        "deep/er/b.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        `--config=${join(stateDir, "empty.toml")}`,
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

describe("the bun code that the host scripts start", () => {
  // package.jsonの依存を解決したり、自動でinstallしたりする経路を持たないことを固定する。
  const sources = ["scripts/custom-tags.ts", "scripts/bootstrap.sh"];

  test.each(sources)("%s imports only built-ins", (path) => {
    const found = specifiers(readFileSync(join(REPO_ROOT, path), "utf8"));
    expect(
      found.filter(
        (specifier) =>
          !(
            specifier.startsWith("node:") ||
            specifier === "bun" ||
            specifier.startsWith("bun:")
          ),
      ),
    ).toEqual([]);
  });
});

/** 承認の道具のファイル。ネットワーク、外部の子プロセス、秘密値の読み取りを持たないことを固定する。 */
const APPROVAL_MODULES = [
  "approve.ts",
  "approved_io.ts",
  "approved_store.ts",
  "code_origin.ts",
  "secure_file.ts",
  "drain_store.ts",
].map((name) => join(HOST_APPLY_DIR, name));

const FORBIDDEN_BUILTINS =
  /^(?:node:)?(?:net|http|https|http2|tls|dns|dgram|child_process)(?:\/.*)?$/;

/** ソースに現れる、ネットワーク、外部の子プロセス、`mise.local`の読み取りの形。 */
function forbiddenForms(source: string): string[] {
  const found: string[] = [];
  if (/\bfetch\s*\(/.test(source)) found.push("fetch(");
  for (const word of [
    "WebSocket",
    "Bun.connect",
    "Bun.serve",
    "Bun.listen",
    "Bun.udpSocket",
    "Bun.$",
  ]) {
    if (source.includes(word)) found.push(word);
  }
  for (const specifier of specifiers(source)) {
    if (FORBIDDEN_BUILTINS.test(specifier)) found.push(`import ${specifier}`);
  }
  for (const match of source.matchAll(/\bspawn\w*\s*\(\s*([^\n]{0,40})/g)) {
    if (!/^\[\s*["']\/usr\/bin\/git["']/.test(match[1] ?? "")) {
      found.push(`spawn(${match[1] ?? ""}`);
    }
  }
  if (source.includes("mise.local")) found.push("mise.local");
  return found;
}

describe("the call checker for the approval modules", () => {
  test.each([
    'const r = await fetch("https://x");',
    "const s = new WebSocket(url);",
    "Bun.connect({ hostname: h });",
    "Bun.serve({ fetch });",
    "Bun.listen({ port: 1 });",
    "Bun.udpSocket({});",
    "await Bun.$`ls`;",
    'import net from "node:net";',
    'import { request } from "https";',
    'import { exec } from "node:child_process";',
    'import tls from "node:tls";',
    'import dns from "node:dns";',
    'import dgram from "node:dgram";',
    'import http from "node:http";',
    'Bun.spawn(["docker", "ps"]);',
    "Bun.spawn(cmd);",
    "spawnSync(bin, args);",
    'const f = ".../mise.local.toml";',
  ])("flags %s", (source) => {
    expect(forbiddenForms(source)).not.toEqual([]);
  });

  test.each([
    'Bun.spawn(["/usr/bin/git", ...args]);',
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    "const refetch = prefetch;",
    "const mise = 1;",
  ])("accepts %s", (source) => {
    expect(forbiddenForms(source)).toEqual([]);
  });
});

describe("the approval modules", () => {
  test("exist, so that the scan below is not empty", () => {
    const names = readdirSync(HOST_APPLY_DIR);
    expect(
      APPROVAL_MODULES.filter((file) =>
        names.includes(file.slice(HOST_APPLY_DIR.length + 1)),
      ),
    ).toEqual(APPROVAL_MODULES);
  });

  test("have no network call, no outside process and no mise.local", () => {
    expect(
      APPROVAL_MODULES.flatMap((file) =>
        forbiddenForms(readFileSync(file, "utf8")).map(
          (form) => `${file}: ${form}`,
        ),
      ),
    ).toEqual([]);
  });
});

/** ソースに現れる、環境変数の読み取りの形。 */
function envReads(source: string): string[] {
  return ["process.env", "Bun.env"].filter((form) => source.includes(form));
}

describe("the env checker", () => {
  test.each(["const v = process.env.HOME;", "const v = Bun.env.HOME;"])(
    "flags %s",
    (source) => {
      expect(envReads(source)).not.toEqual([]);
    },
  );

  test("accepts a source without env reads", () => {
    expect(envReads("const uid = process.getuid?.() ?? -1;")).toEqual([]);
  });
});

describe("the state store modules", () => {
  const STORE_MODULES = ["secure_file.ts", "drain_store.ts"].map((name) =>
    join(HOST_APPLY_DIR, name),
  );

  test("import only built-ins and scripts/host_apply/", () => {
    expect(violations(STORE_MODULES)).toEqual([]);
  });

  test("read no environment variable", () => {
    expect(
      STORE_MODULES.flatMap((file) =>
        envReads(readFileSync(file, "utf8")).map((form) => `${file}: ${form}`),
      ),
    ).toEqual([]);
  });
});
