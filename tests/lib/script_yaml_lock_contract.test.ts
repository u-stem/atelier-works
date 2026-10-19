import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
// このリポジトリはどれも使っていないので、現れたら失敗させる。
//
// `f/`の外のYAMLとJSONを、wmillが同期して`!inline`を読むかは確かめていない。
// ルート直下、`dependencies/`、`migrations/`も同期するかもしれないので、
// 追跡するツリー全体を広めに調べる。調べ方は2段ある。
// 段A: 除外なしで、文字列としての`!inline`とその書き換え(エスケープ、BOM、指示子)を拒む。
// 段B: 解釈した後の値まで調べる。除外は`STAGE_B_EXCLUSIONS`の完全一致の3パスだけにする。

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

function runGit(root: string, args: readonly string[]): string {
  // gitのフックの中で走ると、親のリポジトリを指す`GIT_*`が環境に残る。一時リポジトリには引き継がない。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/** 追跡するパスの一覧。`-z`で`\0`で切るので、非ASCIIや引用の要る名前も欠けない。 */
function listTracked(root: string): string[] {
  return runGit(root, ["ls-files", "-z"])
    .split("\0")
    .filter((path) => path !== "");
}

type TrackedEntry = { readonly mode: string; readonly path: string };

/** 追跡するパスとmodeの一覧。modeは`120000`(symlink)や`160000`(submodule)などの6桁。 */
function listTrackedEntries(root: string): TrackedEntry[] {
  return runGit(root, ["ls-files", "-s", "-z"])
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => ({
      mode: entry.slice(0, entry.indexOf(" ")),
      path: entry.slice(entry.indexOf("\t") + 1),
    }));
}

function findSpecialEntries(entries: readonly TrackedEntry[]): string[] {
  return entries
    .filter(({ mode }) => mode === "120000" || mode === "160000")
    .map(({ path }) => path);
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
  if (content.includes("\uFEFF")) {
    violations.push("BOM is not allowed");
  }
  // wmillは`lock`の値を空白で区切ってパスを取るので、空白を含む名前は拒む。
  if (/\s/.test(definitionPath)) {
    violations.push("the definition path must not contain whitespace");
  }
  if (/^%/m.test(content)) {
    violations.push("YAML directives are not allowed");
  }
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

/** 値の頭にある`!`。`!==`は演算子として除く。 */
const YAML_TAG_TOKEN = /(^|[\s[{,])!(?!=)/m;

/** 解釈した後の値に、`!inline`で始まる文字列があるか。エスケープや行の継続も解く。 */
function hasInlineValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trimStart().startsWith("!inline");
  }
  if (Array.isArray(value)) {
    return value.some(hasInlineValue);
  }
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, child]) => hasInlineValue(key) || hasInlineValue(child),
    );
  }
  return false;
}

/**
 * script定義ではないデータファイル(flow、resource、appなど)の`!inline`を拒む(段B)。
 * このリポジトリには、そのような参照がない。
 * 文字列の検索に加えて、解釈した後の値も調べる。`"\x21inline ..."`のような
 * エスケープで、文字列に現れない`!inline`を作れるためである。
 * `%TAG`と`%YAML`の指示子は、タグの別名で`!inline`を作れるので拒む。
 * 解釈できないファイルは、読み手によって解釈が分かれうるので、違反として数える。
 */
function findInlineInDataFile(path: string, content: string): string[] {
  const violations: string[] = [];
  if (content.includes("!inline")) {
    violations.push("!inline is not allowed here");
  }
  // 先頭のBOMは、wmillが外してから読むので、`^%`の検査をすり抜けるのに使われる。
  if (content.includes("\uFEFF")) {
    violations.push("BOM is not allowed");
  }
  if (/^%/m.test(content)) {
    violations.push("YAML directives are not allowed");
  }
  const isJson = /\.json$/i.test(path);
  // wmillのパーサは、`!in%6Cine`のように%エスケープしたタグも`!inline`に解く。
  // Bunは解けないので、タグ自体を拒む。`!==`のような演算子は対象にしない。
  if (!isJson && YAML_TAG_TOKEN.test(content)) {
    violations.push("YAML tags are not allowed");
  }
  let parsed: unknown;
  try {
    parsed = isJson ? JSON.parse(content) : Bun.YAML.parse(content);
  } catch {
    violations.push(isJson ? "unparsable json" : "unparsable yaml");
    return violations;
  }
  if (hasInlineValue(parsed)) {
    violations.push("a value resolves to !inline");
  }
  return violations;
}

/**
 * 段A。除外なしの浅い検査で、文字列として`!inline`を作れる書き方を拒む。
 * 解釈できないファイルにも掛かる。
 */
function findShallowViolations(content: string): string[] {
  const violations: string[] = [];
  if (content.includes("!inline")) {
    violations.push("!inline is not allowed");
  }
  // `!`を、YAMLの16進のエスケープ(\x、\U)とJSONの\uで書く形。
  if (/\\x21|\\u0021|\\U00000021/i.test(content)) {
    violations.push("an escape that spells ! is not allowed");
  }
  // wmillのパーサは、`!in%6Cine`のような%エスケープしたタグも`!inline`に解く。
  // エスケープは`!`の後ろのどこにでも置けるので、`!`に続く空白でない並びに`%`があれば拒む。
  if (/![^\s]*%/.test(content)) {
    violations.push("a percent-escaped tag is not allowed");
  }
  if (content.includes("\uFEFF")) {
    violations.push("BOM is not allowed");
  }
  if (/^%/m.test(content)) {
    violations.push("YAML directives are not allowed");
  }
  return violations;
}

/**
 * 段Bに掛けない3つのパス。生のパスの完全一致で比べ、ディレクトリやglobでは除外しない。
 * - `.github/workflows/ci.yml`: GitHub式の`${{ !cancelled() }}`が、YAMLのタグの検査に当たる。
 * - `tsconfig.json`、`tsconfig.wmill.json`: `tsc`が読むJSONCで、JSONとして解釈できない。
 * `wmill.yaml`の`includes`が`f/**`だけなら、この3つはwmillが項目として解釈しない名前である。
 * 段Aは、この3つにも掛ける。
 */
const STAGE_B_EXCLUSIONS: readonly string[] = [
  ".github/workflows/ci.yml",
  "tsconfig.json",
  "tsconfig.wmill.json",
];

/**
 * 段Aの対象。追跡するYAMLとJSONのうち、`f/`の下と、`findLockViolations`が検査する
 * 定義(`definitions`)を除く。名前の正規表現ではなく集合の差にするので、
 * `node_modules/`の下や大文字の拡張子の`.script.yaml`は、検査する定義でなければ対象に残る。
 */
function selectScanTargets(
  tracked: readonly string[],
  definitions: readonly string[],
): string[] {
  const checked = new Set(definitions);
  return tracked
    .filter((path) => /\.(ya?ml|json)$/i.test(path))
    .filter((path) => !path.startsWith("f/"))
    .filter((path) => !checked.has(path));
}

/** 段Bの対象。段Aの対象から、除外の3パスを引く。 */
function selectDeepTargets(stageATargets: readonly string[]): string[] {
  return stageATargets.filter((path) => !STAGE_B_EXCLUSIONS.includes(path));
}

const IGNORED = /^(node_modules|\.git|\.claude\/worktrees)\//;

/** `findLockViolations`で検査するscript定義の一覧。 */
function listDefinitions(): string[] {
  return (
    [
      ...new Glob("**/*.script.{yaml,json}").scanSync({
        cwd: ROOT,
        dot: true,
      }),
    ]
      // `f/`の下は、`node_modules`という名前のフォルダも例外にしない。
      // wmillは名前で除外せず、強制追加された定義も読むため。
      .filter(
        (path) =>
          !IGNORED.test(path) &&
          (path.startsWith("f/") || !path.includes("/node_modules/")),
      )
      .sort()
  );
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
    expect(
      findInlineInDataFile("f/factory/x.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("accepts a file without an inline reference", () => {
    expect(findInlineInDataFile("f/factory/x.yaml", "summary: x\n")).toEqual(
      [],
    );
  });
});

describe("findInlineInDataFile escapes", () => {
  test("rejects a hex escape that spells !inline", () => {
    const content = 'value:\n  content: "\\x21inline mise.local.toml"\n';
    expect(
      findInlineInDataFile("f/factory/x.resource.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("rejects a line continuation that spells !inline", () => {
    const content = 'content: "!\\\n  inline mise.local.toml"\n';
    expect(
      findInlineInDataFile("f/factory/x.resource.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("rejects a TAG directive", () => {
    const content = "%TAG !w! !in\n---\ncontent: !w!line x\n";
    expect(
      findInlineInDataFile("f/factory/x.resource.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("rejects a TAG directive in a script definition", () => {
    const content = `%TAG !w! !in\n---\n${VALID}`;
    expect(findLockViolations(PATH, content).length).toBeGreaterThan(0);
  });
});

describe("findInlineInDataFile tags and json", () => {
  test("rejects a percent-escaped tag", () => {
    const content = "content: !in%6Cine ../../../mise.local.toml\n";
    expect(
      findInlineInDataFile("f/factory/x.resource.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("accepts the !== operator in an expression", () => {
    const content = 'expr: results.a.outcome !== "proceed"\n';
    expect(
      findInlineInDataFile("f/factory/x__flow/flow.yaml", content),
    ).toEqual([]);
  });

  test("rejects an inline reference in a json definition", () => {
    const content = '{"value":{"content":"\\u0021inline mise.local.toml"}}';
    expect(
      findInlineInDataFile("f/factory/x.resource.json", content).length,
    ).toBeGreaterThan(0);
  });
});

describe("findInlineInDataFile bom and unicode escapes", () => {
  test("rejects a BOM before a TAG directive", () => {
    const content = "\uFEFF%TAG !w! !in\n---\ncontent: !w!line x\n";
    expect(
      findInlineInDataFile("f/factory/x.resource.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("rejects a long unicode escape that spells !inline", () => {
    const content = 'content: "\\U00000021inline mise.local.toml"\n';
    expect(
      findInlineInDataFile("f/factory/x.resource.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("rejects a definition path with whitespace", () => {
    const path = "f/factory/a b.script.yaml";
    const content = "lock: '!inline f/factory/a b.script.lock'\n";
    expect(findLockViolations(path, content).length).toBeGreaterThan(0);
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

describe("stage A", () => {
  test("stage A rejects !inline in a tracked file outside f", () => {
    const content = "lock: '!inline ../../../proc/self/cmdline'\n";
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A targets a yaml file outside f", () => {
    expect(selectScanTargets(["dependencies/x.yaml"], [])).toEqual([
      "dependencies/x.yaml",
    ]);
  });

  test("stage A rejects an escaped exclamation mark", () => {
    const content = 'content: "\\x21inline mise.local.toml"\n';
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A rejects a unicode escape of an exclamation mark", () => {
    const content = '{"content":"\\u0021inline mise.local.toml"}';
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A rejects a long unicode escape of an exclamation mark", () => {
    const content = 'content: "\\U00000021inline mise.local.toml"\n';
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A rejects a percent-escaped tag", () => {
    const content = "content: !in%6Cine ../../../mise.local.toml\n";
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A rejects a percent escape of the first letter of inline", () => {
    const content = "content: !%69nline ../../../mise.local.toml\n";
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A rejects a percent escape in the middle of a tag", () => {
    const content = "content: !i%6Eline ../../../mise.local.toml\n";
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A accepts a percent sign that is not part of a tag", () => {
    const content = "content: !cancelled 100% done\n";
    expect(findShallowViolations(content)).toEqual([]);
  });

  test("stage A rejects a BOM in the middle of a file", () => {
    expect(findShallowViolations("a: 1\n\uFEFFb: 2\n").length).toBeGreaterThan(
      0,
    );
  });

  test("stage A rejects a directive at the start of a line", () => {
    const content = "a: 1\n%TAG !w! !in\n";
    expect(findShallowViolations(content).length).toBeGreaterThan(0);
  });

  test("stage A accepts a GitHub expression with a negation", () => {
    const content = `if: $${"{{ !cancelled() }}"}\n`;
    expect(findShallowViolations(content)).toEqual([]);
  });

  test("stage A scans the excluded ci.yml", () => {
    const targets = selectScanTargets([".github/workflows/ci.yml"], []);
    expect(targets).toContain(".github/workflows/ci.yml");
  });

  test("stage A scans the excluded tsconfig.json", () => {
    expect(selectScanTargets(["tsconfig.json"], [])).toContain("tsconfig.json");
  });

  test("a tracked script definition outside definitions is still scanned", () => {
    const tracked = ["console/node_modules/x/a.script.yaml", "UP.SCRIPT.YAML"];
    expect(selectScanTargets(tracked, [])).toEqual(tracked);
  });

  test("a script definition that findLockViolations checks is not scanned twice", () => {
    expect(
      selectScanTargets(
        ["migrations/a.script.yaml"],
        ["migrations/a.script.yaml"],
      ),
    ).toEqual([]);
  });

  test("stage A does not scan files under f", () => {
    expect(selectScanTargets(["f/factory/x.yaml"], [])).toEqual([]);
  });
});

describe("stage B", () => {
  test("stage B rejects an escape that spells !inline", () => {
    const content = 'content: "\\x21inline mise.local.toml"\n';
    expect(
      findInlineInDataFile("migrations/x.yaml", content).length,
    ).toBeGreaterThan(0);
  });

  test("stage B rejects an unparsable json", () => {
    expect(
      findInlineInDataFile("migrations/x.json", "{not json").length,
    ).toBeGreaterThan(0);
  });

  test("stage B rejects an unparsable yaml", () => {
    expect(
      findInlineInDataFile("migrations/x.yaml", "key: [unclosed\n").length,
    ).toBeGreaterThan(0);
  });

  test("the exclusions are exactly three exact paths", () => {
    expect(STAGE_B_EXCLUSIONS).toEqual([
      ".github/workflows/ci.yml",
      "tsconfig.json",
      "tsconfig.wmill.json",
    ]);
  });

  test("stage B skips the excluded ci.yml", () => {
    const stageA = selectScanTargets([".github/workflows/ci.yml"], []);
    expect(selectDeepTargets(stageA)).not.toContain(".github/workflows/ci.yml");
  });

  test("stage B skips the excluded tsconfig.json", () => {
    const stageA = selectScanTargets(["tsconfig.json"], []);
    expect(selectDeepTargets(stageA)).not.toContain("tsconfig.json");
  });

  test("stage B does not exclude a similar path in another directory", () => {
    const similar = ["sub/tsconfig.json", ".github/workflows/other.yml"];
    expect(selectDeepTargets(similar)).toEqual(similar);
  });

  test("stage B does not exclude the path by case", () => {
    expect(selectDeepTargets(["TSCONFIG.JSON"])).toEqual(["TSCONFIG.JSON"]);
  });
});

describe("the tracked tree", () => {
  const tracked = listTracked(ROOT);
  const definitions = listDefinitions();
  const stageA = selectScanTargets(tracked, definitions).filter((path) =>
    existsSync(`${ROOT}${path}`),
  );
  const stageB = selectDeepTargets(stageA);
  const violationsOf = (
    targets: readonly string[],
    check: (path: string, content: string) => string[],
  ) =>
    targets.flatMap((path) =>
      check(path, readFileSync(`${ROOT}${path}`, "utf8")).map(
        (reason) => `${path}: ${reason}`,
      ),
    );

  test("lists the tracked files", () => {
    expect(tracked.length).toBeGreaterThan(100);
  });

  test("the scanned list contains wmill.yaml", () => {
    expect(stageA).toContain("wmill.yaml");
  });

  test("the scanned list contains c_factory_config.resource-type.yaml", () => {
    expect(stageA).toContain("c_factory_config.resource-type.yaml");
  });

  test("the scanned list contains the schema under migrations", () => {
    expect(stageA).toContain(
      "migrations/datatable/main/requirement_drafts.diagrams.schema.json",
    );
  });

  test("stage A still scans the excluded paths", () => {
    expect(stageA).toEqual(expect.arrayContaining(STAGE_B_EXCLUSIONS));
  });

  test("stage B does not scan the excluded paths", () => {
    expect(stageB.filter((path) => STAGE_B_EXCLUSIONS.includes(path))).toEqual(
      [],
    );
  });

  test("the tracked tree passes stage A", () => {
    expect(
      violationsOf(stageA, (_path, content) => findShallowViolations(content)),
    ).toEqual([]);
  });

  test("the tracked tree passes stage B", () => {
    expect(violationsOf(stageB, findInlineInDataFile)).toEqual([]);
  });

  // wmillは`f/`の外でも、`dependencies/`、`migrations/`、ルート直下のファイルを
  // 同期するかもしれず、symlinkを辿って読む。追跡するツリー全体で拒む。
  test("has no symlink or submodule", () => {
    expect(findSpecialEntries(listTrackedEntries(ROOT))).toEqual([]);
  });
});

describe("git ls-files -z in a temporary repository", () => {
  let repo = "";
  let tracked: string[] = [];
  let entries: TrackedEntry[] = [];

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "contract-"));
    runGit(repo, ["init", "-q"]);
    mkdirSync(join(repo, "日本語"));
    writeFileSync(join(repo, "日本語", '設定 "x".yaml'), "a: 1\n");
    symlinkSync("target", join(repo, "リンク"));
    runGit(repo, ["add", "-A"]);
    runGit(repo, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"a".repeat(40)},サブ`,
    ]);
    tracked = listTracked(repo);
    entries = listTrackedEntries(repo);
  });

  afterAll(() => {
    if (repo !== "") rmSync(repo, { recursive: true, force: true });
  });

  test("the list keeps non-ascii paths", () => {
    expect(tracked).toContain('日本語/設定 "x".yaml');
  });

  test("the entry list keeps non-ascii paths", () => {
    expect(entries.map(({ path }) => path)).toContain('日本語/設定 "x".yaml');
  });

  test("the symlink check finds a symlink with a non-ascii name", () => {
    expect(findSpecialEntries(entries)).toContain("リンク");
  });

  test("the symlink check finds a submodule with a non-ascii name", () => {
    expect(findSpecialEntries(entries)).toContain("サブ");
  });

  test("every mode that was read has six digits", () => {
    expect(entries.filter(({ mode }) => !/^\d{6}$/.test(mode))).toEqual([]);
  });
});

describe("the f directory", () => {
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
          findInlineInDataFile(path, readFileSync(`${ROOT}${path}`, "utf8"))
            .length > 0,
      );
    expect(violations).toEqual([]);
  });
});

describe("every script definition in the repository", () => {
  const definitions = listDefinitions();

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
