import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as github from "../../f/factory/lib/github.ts";

const ROOT = join(import.meta.dir, "../..");
const FACTORY_DIR = join(ROOT, "f/factory");

/** 検索を使わない5つのフロー。 */
const FLOWS = [
  "poll_issues.ts",
  "poll_prs.ts",
  "watch_pr_conflicts.ts",
  "watch_pr_ci.ts",
  "poll_dependabot.ts",
];

/** 実行時の拒否が、拒否する接頭辞を持つ定数の名前。この行だけが接頭辞の字面を書ける。 */
const GUARD_CONSTANT = "REJECTED_REST_ENDPOINT_PREFIX";
const GUARD_FILE = "lib/github.ts";

type Source = { readonly path: string; readonly text: string };

/** `f/factory`の、テストでも生成物でもないファイル。 */
function factorySources(): Source[] {
  return readdirSync(FACTORY_DIR, { recursive: true })
    .map(String)
    .filter(
      (path) =>
        !path.endsWith(".test.ts") &&
        !path.endsWith(".lock") &&
        !path.split("/").includes("node_modules"),
    )
    .sort()
    .flatMap((path) => {
      try {
        return [{ path, text: readFileSync(join(FACTORY_DIR, path), "utf8") }];
      } catch {
        return [];
      }
    });
}

function linesMatching(
  sources: readonly Source[],
  pattern: RegExp,
  allowed: (source: Source, line: string) => boolean = () => false,
): string[] {
  const found: string[] = [];
  for (const source of sources) {
    source.text.split("\n").forEach((line, index) => {
      if (pattern.test(line) && !allowed(source, line)) {
        found.push(`${source.path}:${String(index + 1)}`);
      }
    });
  }
  return found;
}

/** `github.ts`から読み込む名前を、別名と`type`を外して返す。 */
function namesImportedFromGithub(text: string): string[] {
  const names: string[] = [];
  const declaration =
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]*\/github\.ts"/g;
  for (const match of text.matchAll(declaration)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (name !== undefined && name !== "") names.push(name);
    }
  }
  return names;
}

describe("the Factory scripts never name the REST search API", () => {
  const sources = factorySources();

  test("scans the Factory scripts", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  test("no script spells the search issues endpoint", () => {
    expect(linesMatching(sources, /search\/issues/i)).toEqual([]);
  });

  test("no script spells a search prefix except the rejection guard", () => {
    const offenders = linesMatching(
      sources,
      /search\//i,
      (source, line) =>
        source.path === GUARD_FILE && line.includes(GUARD_CONSTANT),
    );

    expect(offenders).toEqual([]);
  });

  test("the rejection guard spells the prefix once", () => {
    const guard = sources.find((source) => source.path === GUARD_FILE);
    const lines = (guard?.text ?? "")
      .split("\n")
      .filter((line) => /search\//i.test(line));

    expect(lines).toHaveLength(1);
  });

  test("no script calls the gh search command", () => {
    expect(linesMatching(sources, /\bgh\s+search\b/i)).toEqual([]);
  });

  test("no script passes a search option to gh", () => {
    expect(linesMatching(sources, /--search\b/)).toEqual([]);
  });
});

describe("no Factory script reads a search function from github.ts", () => {
  const sources = factorySources();

  test("github.ts exports no name that starts with search", () => {
    expect(Object.keys(github).filter((name) => /^search/i.test(name))).toEqual(
      [],
    );
  });

  test("no script imports a name that starts with search from github.ts", () => {
    const offenders = sources
      .filter((source) => source.path.endsWith(".ts"))
      .flatMap((source) =>
        namesImportedFromGithub(source.text)
          .filter((name) => /^search/i.test(name))
          .map((name) => `${source.path}: ${name}`),
      );

    expect(offenders).toEqual([]);
  });

  for (const flow of FLOWS) {
    test(`${flow} is scanned and imports from github.ts`, () => {
      const source = sources.find((candidate) => candidate.path === flow);

      expect(
        namesImportedFromGithub(source?.text ?? "").length,
      ).toBeGreaterThan(0);
    });

    test(`${flow} imports no name that starts with search`, () => {
      const source = sources.find((candidate) => candidate.path === flow);
      const names = namesImportedFromGithub(source?.text ?? "");

      expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
    });
  }
});
