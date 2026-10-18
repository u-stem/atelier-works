import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Glob } from "bun";

// すべてのscriptの定義(`*.script.yaml`、`*.script.json`)の`lock`は、
// 自分と同じ名前の`.script.lock`を指す、という契約を固定する。
//
// `wmill sync push`は、`lock: '!inline <パス>'`のパスを制限なしに読み、
// 中身をlockとしてワークスペースに保存する。パスには絶対パスや`..`も書ける。
// 保護の外の定義がlockの参照先を書き換えられると、workerやホストの任意のファイルが
// lockとして保存されうる。このテストが保護パスに入っていて、参照先を自分のlockに
// 固定している限り、その書き換えはマージの前に止まる。
//
// 同じ`!inline`は、flow、resource、app、モジュールフォルダの定義でも読まれ、
// `f/`の下のsymlinkは、symlinkを辿る環境でその先のファイルを読ませる。
// このリポジトリはどれも使っていないので、`f/`の下で現れたら失敗させる。

/** 定義のパスから、契約が求める`lock`の値を作る。 */
function expectedLock(definitionPath: string): string {
  const stem = definitionPath.replace(/\.script\.(yaml|json)$/, "");
  return `!inline ${stem}.script.lock`;
}

function parseDefinition(definitionPath: string, content: string): unknown {
  return definitionPath.endsWith(".json")
    ? JSON.parse(content)
    : Bun.YAML.parse(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 契約に反する定義の理由を返す。守っていれば空の配列を返す。
 * YAMLの`lock:`が重複すると、読み手によって採る値が変わるので、行の数も数える。
 */
function findLockViolations(definitionPath: string, content: string): string[] {
  const parsed = parseDefinition(definitionPath, content);
  if (!isRecord(parsed)) {
    return ["definition is not a mapping"];
  }
  const violations: string[] = [];
  if (parsed.lock !== expectedLock(definitionPath)) {
    violations.push(`lock must be exactly "${expectedLock(definitionPath)}"`);
  }
  if (definitionPath.endsWith(".yaml")) {
    // タグの形やキー名に`!inline`を混ぜる書き方を、パーサの差に頼らず拒む。
    const inlineLines = content
      .split("\n")
      .filter((line) => line.includes("!inline"));
    const allowed = `lock: '${expectedLock(definitionPath)}'`;
    if (inlineLines.some((line) => line.trimEnd() !== allowed)) {
      violations.push(`the only !inline line allowed is: ${allowed}`);
    }
    const lockKeyCount = content.match(/^["']?lock["']?\s*:/gm)?.length ?? 0;
    if (lockKeyCount !== 1) {
      violations.push(`lock key must appear once, found ${lockKeyCount}`);
    }
  }
  return violations;
}

/**
 * script定義ではないデータファイル(flow、resource、appなど)の`!inline`を拒む。
 * このリポジトリには、そのような参照がない。
 */
function findInlineInDataFile(content: string): string[] {
  return content.includes("!inline") ? ["!inline is not allowed here"] : [];
}

const PATH = "f/factory/example.script.yaml";
const VALID = `summary: example\nlock: '!inline ${PATH.replace(".script.yaml", ".script.lock")}'\nkind: script\n`;

describe("findLockViolations", () => {
  test("accepts a lock that points at the own .script.lock", () => {
    expect(findLockViolations(PATH, VALID)).toEqual([]);
  });

  test("rejects a lock that points at another script's lock", () => {
    const content = "lock: '!inline f/factory/other.script.lock'\n";
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects an absolute path", () => {
    const content = "lock: '!inline /etc/passwd'\n";
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects a path that climbs out of the directory", () => {
    const content =
      "lock: '!inline f/factory/../../../etc/passwd'\nsummary: x\n";
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects a lock with the own path followed by a suffix", () => {
    const content = "lock: '!inline f/factory/example.script.lock.bak'\n";
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects a definition without lock", () => {
    expect(findLockViolations(PATH, "summary: x\n").length).toBeGreaterThan(0);
  });

  test("rejects a lock written as a list", () => {
    const content = "lock:\n  - '!inline f/factory/example.script.lock'\n";
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects a lock key that appears twice even if the last one is valid", () => {
    const content = `lock: '!inline /etc/passwd'\n${VALID}`;
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects a quoted duplicate lock key", () => {
    const content = `"lock": '!inline /etc/passwd'\n${VALID}`;
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("checks the lock of a .script.json definition", () => {
    const content = JSON.stringify({ lock: "!inline /etc/passwd" });
    expect(
      findLockViolations("f/factory/example.script.json", content).length,
    ).toBeGreaterThan(0);
  });

  test("accepts a .script.json definition that points at its own lock", () => {
    const content = JSON.stringify({
      lock: "!inline f/factory/example.script.lock",
    });
    expect(
      findLockViolations("f/factory/example.script.json", content),
    ).toEqual([]);
  });
});

describe("findInlineInDataFile", () => {
  test("rejects an inline reference in a flow", () => {
    const content = "lock: '!inline ../../../proc/self/cmdline'\n";
    expect(findInlineInDataFile(content)).toHaveLength(1);
  });

  test("accepts a file without an inline reference", () => {
    expect(findInlineInDataFile("summary: x\n")).toEqual([]);
  });
});

describe("script definition lines", () => {
  test("rejects a tagged key that hides a second lock", () => {
    const content = `lock: '!inline /etc/passwd'\n!inline lock: '!inline f/factory/example.script.lock'\n`;
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });

  test("rejects the tag form of the lock value", () => {
    const content = "lock: !inline f/factory/example.script.lock\n";
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });
});

describe("the f directory", () => {
  const ROOT = new URL("../../", import.meta.url).pathname;
  const entries = readdirSync(`${ROOT}f`, {
    recursive: true,
    withFileTypes: true,
  });
  const relative = (entry: (typeof entries)[number]) =>
    `f/${entry.parentPath.slice(`${ROOT}f`.length + 1)}/${entry.name}`.replace(
      "f//",
      "f/",
    );

  test("has no symlink", () => {
    expect(
      entries.filter((entry) => entry.isSymbolicLink()).map(relative),
    ).toEqual([]);
  });

  test("has no module folder that wmill reads as a script", () => {
    expect(
      entries
        .filter((entry) => /__(mod|dbt|app|raw_app)$/.test(entry.name))
        .map(relative),
    ).toEqual([]);
  });

  test("has no inline reference outside script definitions", () => {
    const violations = entries
      .filter((entry) => entry.isFile())
      .map(relative)
      .filter((path) => /\.(ya?ml|json)$/.test(path))
      .filter((path) => !/\.script\.(yaml|json)$/.test(path))
      .filter(
        (path) =>
          findInlineInDataFile(readFileSync(`${ROOT}${path}`, "utf8")).length >
          0,
      );
    expect(violations).toEqual([]);
  });
});

describe("every script definition in the repository", () => {
  const ROOT = new URL("../../", import.meta.url).pathname;
  const IGNORED = /^(node_modules|\.git|\.claude\/worktrees)\//;
  const definitions = [
    ...new Glob("**/*.script.{yaml,json}").scanSync({ cwd: ROOT, dot: true }),
  ]
    .filter((path) => !IGNORED.test(path) && !path.includes("/node_modules/"))
    .sort();

  test("finds the definitions to check", () => {
    expect(definitions.length).toBeGreaterThan(100);
  });

  test("includes the self_update definition", () => {
    expect(definitions).toContain("f/factory/self_update.script.yaml");
  });

  test("all point their lock at their own .script.lock", () => {
    const violations = definitions.flatMap((path) =>
      findLockViolations(path, readFileSync(`${ROOT}${path}`, "utf8")).map(
        (reason) => `${path}: ${reason}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
