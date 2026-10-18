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
  type CommandRunner,
  CREATABLE_KINDS,
  type IssuedSpec,
} from "../../scripts/host_apply/command.ts";
import { COMMAND_TIMEOUT_MS } from "../../scripts/host_apply/constants.ts";
import {
  commitExistsArgs,
  diffNameStatusArgs,
  diffPatchArgs,
  isAncestorArgs,
  lsTreePathArgs,
  lsTreeRecursiveArgs,
  ORIGIN_MAIN_REF,
  resolveHeadArgs,
  revParseQueryArgs,
  showBlobArgs,
  showRefArgs,
} from "../../scripts/host_apply/git.ts";
import { bootId, processStart } from "../../scripts/host_apply/host_probe.ts";
import {
  fetchOrigin,
  remoteUrlSpec,
} from "../../scripts/host_apply/run_fetch.ts";
import { gitReadSpec } from "../../scripts/host_apply/run_git.ts";
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

/**
 * 実行役が使うNodeの組み込み。足すときは、このテストを直して人のレビューを通す。
 * `child_process`、`net`、`worker_threads`などは、ここに無いので使えない。
 */
const NODE_BUILTINS = ["node:crypto", "node:fs", "node:path", "node:readline"];

/**
 * 許可する指定子か。上の一覧のNodeの組み込みと、`scripts/host_apply/`の中だけ。
 * `bun`と`bun:*`は許さない。`import { $ } from "bun"`や`bun:ffi`は、外部コマンドの実行口を迂回できるため。
 */
function isAllowed(file: string, specifier: string): boolean {
  if (specifier.startsWith("node:")) return NODE_BUILTINS.includes(specifier);
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
    'import { $ } from "bun";',
    'import { spawn as s } from "bun";',
    'import { dlopen } from "bun:ffi";',
    'import { exec } from "node:child_process";',
    'import { Worker } from "node:worker_threads";',
    'import net from "node:net";',
  ])("flags %s", (source) => {
    expect(
      specifiers(source).filter((specifier) => !isAllowed(file, specifier)),
    ).not.toEqual([]);
  });

  test.each([
    'import { a } from "node:path";',
    'import { b } from "./ci.ts";',
    'import type { C } from "./target.ts";',
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
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
  "state.ts",
  "state_io.ts",
  "held_lock.ts",
  "lock.ts",
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
  const STORE_MODULES = [
    "secure_file.ts",
    "drain_store.ts",
    "state.ts",
    "state_io.ts",
    "held_lock.ts",
    "lock.ts",
  ].map((name) => join(HOST_APPLY_DIR, name));

  test("import only built-ins and scripts/host_apply/", () => {
    expect(violations(STORE_MODULES)).toEqual([]);
  });

  test("start no process and run no shell", () => {
    expect(
      STORE_MODULES.flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [/\bspawn\w*\s*\(/, /Bun\.\$/]
          .filter((pattern) => pattern.test(source))
          .map((pattern) => `${file}: ${pattern.source}`);
      }),
    ).toEqual([]);
  });

  test("read no environment variable", () => {
    expect(
      STORE_MODULES.flatMap((file) =>
        envReads(readFileSync(file, "utf8")).map((form) => `${file}: ${form}`),
      ),
    ).toEqual([]);
  });
});

/** 拡張子と`/index`の違いを除いた、モジュールの比較用のパス。 */
function moduleKey(path: string): string {
  return path.replace(/\.ts$/, "").replace(/\/index$/, "");
}

/** ファイルが`host_apply`の中のモジュールを読み込んでいるか。拡張子を省いた指定子も同じものとして扱う。 */
function importsModule(file: string, source: string, name: string): boolean {
  const wanted = moduleKey(join(HOST_APPLY_DIR, name));
  return specifiers(source).some(
    (specifier) =>
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      moduleKey(resolve(dirname(file), specifier)) === wanted,
  );
}

function importsSecureFile(file: string, source: string): boolean {
  return importsModule(file, source, "secure_file.ts");
}

/** 実行役と入口に加えて、`scripts/`の全体。別の場所から部品を取れないようにするため。 */
function scriptFiles(): string[] {
  return [...sourceFiles(), ...collectTs(join(REPO_ROOT, "scripts"))].filter(
    (file, index, all) => all.indexOf(file) === index,
  );
}

function relativeNames(files: string[]): string[] {
  return files.map((file) => file.slice(REPO_ROOT.length + 1)).sort();
}

describe("the importers of secure_file", () => {
  // 置き場のファイルを読み書きする経路を、この一覧に閉じる。増やすときはこのテストを直して、人のレビューを通す。
  const ALLOWED_IMPORTERS = [
    "scripts/host_apply/approved_io.ts",
    "scripts/host_apply/drain_store.ts",
    "scripts/host_apply/lock.ts",
    "scripts/host_apply/state_io.ts",
  ];

  function importers(): string[] {
    return relativeNames(
      scriptFiles().filter((file) =>
        importsSecureFile(file, readFileSync(file, "utf8")),
      ),
    );
  }

  test("are exactly the allowed modules", () => {
    expect(importers()).toEqual(ALLOWED_IMPORTERS);
  });

  test("the scanner finds a relative import of secure_file", () => {
    expect(
      importsSecureFile(
        join(HOST_APPLY_DIR, "x.ts"),
        'import { readSecureFile } from "./secure_file.ts";',
      ),
    ).toBe(true);
  });

  test("the scanner finds a dynamic import of secure_file", () => {
    expect(
      importsSecureFile(
        join(HOST_APPLY_DIR, "x.ts"),
        'const m = await import("./secure_file.ts");',
      ),
    ).toBe(true);
  });

  test("the scanner finds an import without the extension", () => {
    expect(
      importsSecureFile(
        join(HOST_APPLY_DIR, "x.ts"),
        'import { readSecureFile } from "./secure_file";',
      ),
    ).toBe(true);
  });

  test("the scanner finds an import from outside host_apply", () => {
    expect(
      importsSecureFile(
        join(REPO_ROOT, "scripts/x.ts"),
        'import { readSecureFile } from "./host_apply/secure_file";',
      ),
    ).toBe(true);
  });

  test("the scanner ignores an import of another module", () => {
    expect(
      importsSecureFile(
        join(HOST_APPLY_DIR, "x.ts"),
        'import { a } from "./state.ts";',
      ),
    ).toBe(false);
  });
});

describe("the state file", () => {
  const STATE_FILE_LITERAL = /state\.json/;

  /** ブロックコメントと行頭の行コメントを除く。説明文の中の名前を数えないため。 */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  function namesStateFile(source: string): boolean {
    return STATE_FILE_LITERAL.test(withoutComments(source));
  }

  test("is named only in secure_file.ts and state_io.ts", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          namesStateFile(readFileSync(file, "utf8")),
        ),
      ),
    ).toEqual([
      "scripts/host_apply/secure_file.ts",
      "scripts/host_apply/state_io.ts",
    ]);
  });

  test("the literal scanner finds a quoted name", () => {
    expect(namesStateFile('join(dir, "state.json")')).toBe(true);
  });

  test("the literal scanner finds a name in a template literal", () => {
    expect(namesStateFile("const n = `state.json`;")).toBe(true);
  });

  test("the literal scanner ignores a name in a line comment", () => {
    expect(namesStateFile("// the `state.json` is read here")).toBe(false);
  });

  test("the literal scanner ignores a name in a block comment", () => {
    expect(namesStateFile("/** the `state.json` is read here */")).toBe(false);
  });

  test("state_io exports exactly the five functions", async () => {
    const exported = await import("../../scripts/host_apply/state_io.ts");
    expect(Object.keys(exported).sort()).toEqual([
      "commitApplied",
      "createState",
      "readState",
      "reinit",
      "writeState",
    ]);
  });
});

/** `secure_file`から取った束縛の再exportがあるか。拡張子を省いた指定子も数える。 */
function reexportsSecureFile(file: string, source: string): boolean {
  const wanted = moduleKey(join(HOST_APPLY_DIR, "secure_file.ts"));
  return [...source.matchAll(/export\s[^;]*?from\s*["']([^"']+)["']/g)].some(
    (match) => moduleKey(resolve(dirname(file), match[1] ?? "")) === wanted,
  );
}

describe("the re-exports and the names of secure_file", () => {
  test("no module re-exports from secure_file", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          reexportsSecureFile(file, readFileSync(file, "utf8")),
        ),
      ),
    ).toEqual([]);
  });

  test("the re-export scanner finds a re-export", () => {
    expect(
      reexportsSecureFile(
        join(HOST_APPLY_DIR, "x.ts"),
        'export { writeSecureFile } from "./secure_file.ts";',
      ),
    ).toBe(true);
  });

  test("the re-export scanner finds a re-export without the extension", () => {
    expect(
      reexportsSecureFile(
        join(HOST_APPLY_DIR, "x.ts"),
        'export { writeSecureFile } from "./secure_file";',
      ),
    ).toBe(true);
  });

  test.each(["approved_io.ts", "drain_store.ts", "state_io.ts", "lock.ts"])(
    "%s exports none of the names of secure_file",
    async (name) => {
      const own = Object.keys(await import(join(HOST_APPLY_DIR, name)));
      const secure = Object.keys(
        await import("../../scripts/host_apply/secure_file.ts"),
      );
      expect(own.filter((key) => secure.includes(key))).toEqual([]);
    },
  );

  test("the list of file names is used only in secure_file.ts", () => {
    expect(
      sourceFiles()
        .filter((file) =>
          readFileSync(file, "utf8").includes("SECURE_FILE_NAMES"),
        )
        .map((file) => file.slice(HOST_APPLY_DIR.length + 1)),
    ).toEqual(["secure_file.ts"]);
  });
});

describe("the importers of state_io", () => {
  // 状態を書き換える関数を呼べるモジュールの閉じた一覧。今は呼ぶ実行役のコードが無い。
  // 初期化と後処理のサブコマンドを足すときは、この一覧を直して人のレビューを通す。
  const ALLOWED_IMPORTERS: string[] = [];

  test("are exactly the allowed modules", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          importsModule(file, readFileSync(file, "utf8"), "state_io.ts"),
        ),
      ),
    ).toEqual(ALLOWED_IMPORTERS);
  });
});

/** `import type`の文を除く。型だけの読み込みは、値としては数えない。 */
function withoutTypeImports(source: string): string {
  return source.replace(
    /(?:^|\n)\s*import\s+type\b[^;]*?from\s*["'][^"']+["'];?/g,
    "\n",
  );
}

/** `held_lock.ts`を値として読み込んでいるか。動的なimportと再exportも値として数える。 */
function importsHeldLockValue(file: string, source: string): boolean {
  return importsModule(file, withoutTypeImports(source), "held_lock.ts");
}

describe("the value importers of held_lock", () => {
  // フェンスを作れるモジュールの閉じた一覧。増やすときは、この一覧を直して人のレビューを通す。
  // 型としての読み込み(`import type`)は数えない。
  const ALLOWED_IMPORTERS: string[] = ["scripts/host_apply/lock.ts"];

  test("are exactly the allowed modules", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          importsHeldLockValue(file, readFileSync(file, "utf8")),
        ),
      ),
    ).toEqual(ALLOWED_IMPORTERS);
  });

  test("the scanner finds a value import", () => {
    expect(
      importsHeldLockValue(
        join(HOST_APPLY_DIR, "x.ts"),
        'import { HeldLock as L } from "./held_lock";',
      ),
    ).toBe(true);
  });

  test("the scanner finds a dynamic import", () => {
    expect(
      importsHeldLockValue(
        join(HOST_APPLY_DIR, "x.ts"),
        'const { HeldLock } = await import("./held_lock.ts");',
      ),
    ).toBe(true);
  });

  test("the scanner finds a re-export", () => {
    expect(
      importsHeldLockValue(
        join(HOST_APPLY_DIR, "x.ts"),
        'export { HeldLock } from "./held_lock";',
      ),
    ).toBe(true);
  });

  test("the scanner ignores a type import", () => {
    expect(
      importsHeldLockValue(
        join(HOST_APPLY_DIR, "x.ts"),
        'import type { HeldLock } from "./held_lock.ts";',
      ),
    ).toBe(false);
  });
});

/** 走査の結果。 */
type Scan = {
  /** コメントを除いたソース。文字列と正規表現の中身は残す。 */
  readonly code: string;
  /** コメントを除き、文字列と正規表現の中身を空にしたソース。テンプレートの置換の中のコードは残す。 */
  readonly bare: string;
  /** 文字列とテンプレートの本文。正規表現は含めない。 */
  readonly strings: readonly string[];
  /** 正規表現リテラルと読んだ本文。割り算を読み違えたとき、本物のコードがここに入る。 */
  readonly regexes: readonly string[];
  /** 読み違えた箇所。あれば、以降の検査を信用できないので違反として報告する。 */
  readonly problems: readonly string[];
};

/** 直前がこの語なら、続く`/`は正規表現の始まりとみなす。 */
const REGEX_KEYWORDS = [
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "void",
  "delete",
  "throw",
  "yield",
  "await",
  "instanceof",
];

/** 括弧の直後に正規表現が書ける、括弧の前の語。 */
const REGEX_AFTER_PAREN = ["if", "while", "for", "with"];

/**
 * ソースを字句に分けて走査する。コメントを除き、文字列、テンプレート、正規表現リテラルを読み分ける。
 * 文字列の中の`//`や`/*`をコメントの始まりと誤認すると、後ろの本物のコードを隠せるため。
 * 正規表現か除算かは、`/`の直前のトークンで決めるヒューリスティックである。
 * 迷う位置(記号の直後、`}`、括弧の後など)は正規表現に倒す。
 * 割り算を正規表現と読み違えても、本文を`regexes`に残して語の検査にかけるので、コードは隠れない。
 * 逆に正規表現を割り算と読むと、後ろの文字列が読み違えられて隠れうるので、割り算と読むのは
 * 直前が値(数値や名前、文字列、`]`、キーワードの括弧でない`)`)のときだけにする。
 * `.`の後ろの語は、`return`や`of`でも名前として扱う。
 * 閉じない文字列、テンプレート、コメント、正規表現は、`problems`に記録して先へ進む。
 */
function scanSource(source: string): Scan {
  let code = "";
  let bare = "";
  const strings: string[] = [];
  const regexes: string[] = [];
  const problems: string[] = [];
  let i = 0;
  const n = source.length;

  const readString = (quote: string): void => {
    i += 1;
    let body = "";
    while (i < n) {
      const c = source[i] ?? "";
      if (c === "\\") {
        body += c + (source[i + 1] ?? "");
        i += 2;
      } else if (c === quote) {
        i += 1;
        strings.push(body);
        code += quote + body + quote;
        bare += quote + quote;
        return;
      } else if (c === "\n") {
        break;
      } else {
        body += c;
        i += 1;
      }
    }
    problems.push("a string is not closed");
    strings.push(body);
    code += quote + body;
    bare += quote;
  };

  const readTemplate = (): void => {
    i += 1;
    code += "`";
    bare += "`";
    let text = "";
    while (i < n) {
      const c = source[i] ?? "";
      if (c === "\\") {
        text += c + (source[i + 1] ?? "");
        i += 2;
      } else if (c === "`") {
        i += 1;
        strings.push(text);
        code += `${text}\``;
        bare += "`";
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        strings.push(text);
        code += text + INTERP;
        bare += INTERP;
        text = "";
        i += 2;
        readCode(true);
        code += "}";
        bare += "}";
      } else {
        text += c;
        i += 1;
      }
    }
    problems.push("a template is not closed");
    strings.push(text);
    code += text;
  };

  const readRegex = (): void => {
    i += 1;
    let inClass = false;
    let body = "";
    while (i < n) {
      const c = source[i] ?? "";
      if (c === "\n") break;
      if (c === "\\") {
        body += c + (source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        i += 1;
        let flags = "";
        while (/[a-z]/i.test(source[i] ?? "")) {
          flags += source[i];
          i += 1;
        }
        regexes.push(body);
        code += `/${body}/${flags}`;
        bare += "/ /";
        return;
      }
      body += c;
      i += 1;
    }
    problems.push("a regular expression is not closed");
    regexes.push(body);
    code += `/${body}`;
    bare += "/";
  };

  const readCode = (inInterpolation: boolean): void => {
    let depth = 0;
    let previous: "none" | "symbol" | "word" | "value" = "none";
    let previousText = "";
    let word = "";
    let wordAfterDot = false;
    let closedKeywordParen = false;
    const parens: boolean[] = [];
    // 直前のトークンから、`/`を正規表現の始まりと読むかを決める。
    const startsRegex = (): boolean => {
      if (previous === "none") return true;
      if (previous === "word") {
        return !wordAfterDot && REGEX_KEYWORDS.includes(previousText);
      }
      if (previous === "value") return false;
      if (previousText === "]") return false;
      if (previousText === ")") return closedKeywordParen;
      return true;
    };
    while (i < n) {
      const c = source[i] ?? "";
      const next = source[i + 1];
      if (c === "\n") {
        code += c;
        bare += c;
        i += 1;
        word = "";
      } else if (/\s/.test(c)) {
        code += c;
        bare += c;
        i += 1;
        word = "";
      } else if (c === "/" && next === "/") {
        while (i < n && source[i] !== "\n") i += 1;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end < 0) {
          problems.push("a block comment is not closed");
          i = n;
        } else {
          i = end + 2;
        }
        code += " ";
        bare += " ";
      } else if (c === "'" || c === '"') {
        readString(c);
        previous = "value";
        word = "";
      } else if (c === "`") {
        readTemplate();
        previous = "value";
        word = "";
      } else if (c === "/" && startsRegex()) {
        readRegex();
        previous = "value";
        word = "";
      } else if (inInterpolation && c === "}" && depth === 0) {
        i += 1;
        return;
      } else {
        if (inInterpolation && c === "{") depth += 1;
        if (inInterpolation && c === "}") depth -= 1;
        if (c === "(") {
          parens.push(
            previous === "word" &&
              !wordAfterDot &&
              REGEX_AFTER_PAREN.includes(previousText),
          );
        }
        if (c === ")") closedKeywordParen = parens.pop() ?? false;
        code += c;
        bare += c;
        i += 1;
        if (/[A-Za-z0-9_$]/.test(c)) {
          if (word === "") {
            wordAfterDot = previous === "symbol" && previousText === ".";
          }
          word += c;
          previous = "word";
          previousText = word;
        } else {
          word = "";
          previous = "symbol";
          previousText = c;
        }
      }
    }
    if (inInterpolation) problems.push("an interpolation is not closed");
  };

  readCode(false);
  return { code, bare, strings, regexes, problems };
}

/** コメントを除く。文字列の中身は残す。 */
function stripComments(source: string): string {
  return scanSource(source).code;
}

/** テンプレートリテラルの置換の開き。例の中に書くと、リンターが文字列の中の書き損じと誤認するため、分けて書く。 */
const INTERP = "$" + "{";

const ENTRY_NAME = "host-apply.ts";
const RUNNER_NAME = "spawn_runner.ts";

/** `process.`の後ろに書けるメンバー。ここに無いものは、環境、モジュールの読み込み、ネイティブの読み込みに通じる。 */
const PROCESS_MEMBERS = [
  "cwd",
  "stdout",
  "stderr",
  "stdin",
  "exit",
  "argv",
  "execArgv",
  "getuid",
];

/**
 * 実行役のソースに書けない字句の形。外部コマンドの実行口を迂回する経路と、環境変数、
 * 動的なコードの読み込みを塞ぐ。許す形を列挙し、列挙に無い形はすべて違反にする。
 * `name`はファイル名で、`spawn_runner.ts`と入口だけが許される形がある。
 */
function lexicalViolations(source: string, name: string): string[] {
  const scan = scanSource(source);
  // 文字列を残した版はimportの指定子を読むために、空にした版は字句の形を調べるために使う。
  // 正規表現リテラルの本文も加える。割り算を正規表現と読み違えたとき、本物のコードがそこに入るため。
  const hidden = scan.regexes.join("\n");
  const code = `${scan.code}\n${hidden}`;
  const bare = `${scan.bare}\n${hidden}`;
  const found: string[] = scan.problems.map(
    (problem) => `unreadable: ${problem}`,
  );
  for (const match of bare.matchAll(/\bBun\b/g)) {
    const rest = bare.slice((match.index ?? 0) + 3);
    const allowed =
      /^\.(?:YAML|TOML)\b/.test(rest) ||
      (name === RUNNER_NAME && /^\.spawn\s*\(/.test(rest));
    if (!allowed) found.push(`Bun${rest.slice(0, 8).split("\n")[0] ?? ""}`);
  }
  for (const specifier of specifiers(code)) {
    if (specifier === "<dynamic>") found.push("import(<expression>)");
    else if (specifier === "bun" || specifier.startsWith("bun:")) {
      found.push(`import ${specifier}`);
    } else if (
      specifier.startsWith("node:") &&
      !NODE_BUILTINS.includes(specifier)
    ) {
      found.push(`import ${specifier}`);
    }
  }
  // 語そのものを禁止する。呼び出しの形に限ると、`const e = eval; e(x)`や`(eval)(x)`をすり抜ける。
  const patterns: [string, RegExp][] = [
    ["eval", /\beval\b/],
    ["Function", /\bFunction\b/],
    ["require", /\brequire\b/],
    ["process.dlopen", /\bprocess\s*\.\s*dlopen\b/],
    ["process.binding", /\bprocess\s*\.\s*binding\b/],
    ["process[", /\bprocess\s*\[/],
    ["globalThis", /\bglobalThis\b/],
    ["createRequire", /\bcreateRequire\b/],
    ["import.meta", /\bimport\s*\.\s*meta\b(?!\s*\.\s*(?:dir|main)\b)/],
    ["bare process", /\bprocess\b(?!\s*\.)/],
    ["global", /\bglobal\b/],
    ["self", /\bself\b/],
    [".constructor", /\.\s*constructor\b/],
    ["a constructor key", /\bconstructor\s*:/],
    // 識別子のユニコードエスケープは、字句の検査をすり抜ける名前を作れる。文字列と正規表現の中の`\u`は数えない。
    ["\\u outside a string", /\\u/],
  ];
  for (const [label, pattern] of patterns) {
    // ユニコードエスケープは、正規表現の中では普通の書き方なので、本文を足さない版で調べる。
    const target = label === "\\u outside a string" ? scan.bare : bare;
    if (pattern.test(target)) found.push(label);
  }
  // `Worker`は型の位置だけを許す(`drain_store.ts`の型名)。`new Worker(`や値としての参照は拒否する。
  for (const match of bare.matchAll(/\bWorker\b/g)) {
    const before = bare.slice(0, match.index ?? 0);
    if (!/(?:\btype\s+|\bis\s+|\breadonly\s+|[<:]\s*)$/.test(before)) {
      found.push("Worker");
    }
  }
  // `constructor`は、メソッドの定義(後ろが`(`で、前が行頭、空白、`{`、`,`、`;`、`}`)だけを許す。
  for (const match of bare.matchAll(/\bconstructor\b/g)) {
    const index = match.index ?? 0;
    const before = bare.slice(0, index);
    const after = bare.slice(index + "constructor".length);
    const definition = /^\s*\(/.test(after) && /(?:^|[\s{,;}])$/.test(before);
    if (!definition) found.push("constructor");
  }
  for (const match of bare.matchAll(/\bprocess\s*\.\s*(\w+)/g)) {
    const member = match[1] ?? "";
    const allowed =
      PROCESS_MEMBERS.includes(member) ||
      (member === "env" && name === ENTRY_NAME) ||
      ((member === "kill" || member === "pid") && name === RUNNER_NAME);
    if (!allowed) found.push(`process.${member}`);
  }
  // 文字列の中身。モジュール名や起動の形を文字列で組み立てて、間接的に呼ぶ経路を塞ぐ。
  for (const text of scan.strings) {
    if (text === "bun" || text.startsWith("bun:")) found.push(`string ${text}`);
    if (text.startsWith("node:") && !NODE_BUILTINS.includes(text)) {
      found.push(`string ${text}`);
    }
    if (/\bBun\s*\.\s*(?:spawn|spawnSync|\$)|child_process/.test(text)) {
      found.push("a string names a form that starts a process");
    }
    if (text === "constructor") found.push('"constructor"');
    // 奇数個の円記号に続く`u`と`x`は、文字を作るエスケープになる。偶数個は円記号そのものを表す。
    if (/(?<!\\)(?:\\\\)*\\[ux]/.test(text)) {
      found.push("an escape in a string");
    }
  }
  for (const text of scan.regexes) {
    if (
      /child_process|\bbun:|\bnode:(?!crypto\b|fs\b|path\b|readline\b)/.test(
        text,
      )
    ) {
      found.push("a regular expression names a module");
    }
  }
  return found;
}

describe("the lexical checker", () => {
  test.each([
    ["Bun.spawn outside the runner", 'Bun.spawn(["x"]);', "x.ts"],
    ["Bun.spawnSync", 'Bun.spawnSync(["x"]);', "x.ts"],
    ["Bun.$", "await Bun.$`ls`;", "x.ts"],
    ["a computed Bun member", 'Bun["spawn"](["x"]);', "x.ts"],
    ["a destructured Bun", "const { spawn } = Bun;", "x.ts"],
    ["globalThis", "globalThis.Bun.spawn(x);", "x.ts"],
    ["Bun.env", "const v = Bun.env.HOME;", "x.ts"],
    ["Bun.file", 'Bun.file("x");', "x.ts"],
    ["a named import from bun", 'import { $ } from "bun";', "x.ts"],
    ["a renamed import from bun", 'import { spawn as s } from "bun";', "x.ts"],
    ["bun:ffi", 'import { dlopen } from "bun:ffi";', "x.ts"],
    ["bun:test", 'import { test } from "bun:test";', "x.ts"],
    ["child_process", 'import { exec } from "node:child_process";', "x.ts"],
    ["worker_threads", 'import { Worker } from "node:worker_threads";', "x.ts"],
    ["node:vm", 'import vm from "node:vm";', "x.ts"],
    ["a dynamic import of an expression", "await import(name);", "x.ts"],
    ["eval", 'eval("1");', "x.ts"],
    ["Function", 'new Function("return 1");', "x.ts"],
    ["new Worker", 'new Worker("x.js");', "x.ts"],
    ["process.dlopen", "process.dlopen(module, path);", "x.ts"],
    ["process.binding", 'process.binding("fs");', "x.ts"],
    ["a computed process member", 'process["env"].HOME;', "x.ts"],
    ["import.meta.env", "const v = import.meta.env.HOME;", "x.ts"],
    ["createRequire", "createRequire(import.meta.url);", "x.ts"],
    ["require", 'require("fs");', "x.ts"],
    [
      "process.env outside the entry point",
      "const v = process.env.HOME;",
      "x.ts",
    ],
    ["process.kill outside the runner", "process.kill(1, 9);", "x.ts"],
    ["process.pid outside the runner", "const p = process.pid;", "x.ts"],
    ["process.chdir", 'process.chdir("/");', "x.ts"],
    ["a bare process", "const p = process;", "x.ts"],
    [
      "a Bun call after a comment on the same line",
      "const a = 1; // x\nBun.spawn(y);",
      "x.ts",
    ],
    [
      "a Bun call after code on a comment line",
      "a(); // b\nBun.spawn(y); // c",
      "x.ts",
    ],
    [
      "a Bun call after a string that holds two slashes",
      'const s = " //"; Bun.spawn(["x"]);',
      "x.ts",
    ],
    [
      "a Bun call between strings that hold comment marks",
      'const a = "/*"; Bun.spawn(x); const b = "*/";',
      "x.ts",
    ],
    [
      "a Bun call after a template that holds two slashes",
      "const t = `a // b`; Bun.spawn(x);",
      "x.ts",
    ],
    [
      "a Bun call in a template interpolation",
      ["const t = `", INTERP, "Bun.spawn(x)}`;"].join(""),
      "x.ts",
    ],
    [
      "a Bun call in a nested template interpolation",
      ["const t = `a", INTERP, "`b", INTERP, "Bun.spawn(x)}`}`;"].join(""),
      "x.ts",
    ],
    [
      "a Bun call after a string with an escaped quote",
      'const s = "a\\" //"; Bun.spawn(x);',
      "x.ts",
    ],
    ["a unicode escape in an identifier", "Bun.sp\\u0061wn(x);", "x.ts"],
    ["a unicode escape in a member name", "const p = pro\\u0063ess;", "x.ts"],
    ["global", "global.process.env;", "x.ts"],
    ["self", "self.Bun.spawn(x);", "x.ts"],
    [
      "a constructor member",
      "x.constructor.constructor('return 1')();",
      "x.ts",
    ],
    ["a computed constructor member", 'x["constructor"]("y");', "x.ts"],
    ["eval as a value", "const e = eval; e(x);", "x.ts"],
    ["a parenthesized eval", "(eval)(x);", "x.ts"],
    ["an optional call of eval", "eval?.(x);", "x.ts"],
    ["require as a value", "const r = require;", "x.ts"],
    ["a parenthesized Worker", "new (Worker)(x);", "x.ts"],
    ["Function as a value", "const F = Function; F('return 1');", "x.ts"],
    ["a member of import.meta", "const r = import.meta.require;", "x.ts"],
    [
      "a destructured member of import.meta",
      "const { require: r } = import.meta;",
      "x.ts",
    ],
    ["a computed member of import.meta", 'import.meta["require"];', "x.ts"],
    ["import.meta itself", "const m = import.meta;", "x.ts"],
    [
      "a Bun call after a regular expression with an escaped slash",
      String.raw`const r = /\//; Bun.spawn(x);`,
      "x.ts",
    ],
    [
      "a Bun call after a regular expression with a comment mark in a class",
      "const r = /[/*]/; Bun.spawn(x); /* */",
      "x.ts",
    ],
    [
      "a Bun call after a regular expression with a backquote",
      "const r = /`/; Bun.spawn(x); const s = `a`;",
      "x.ts",
    ],
    [
      "a Bun call after a regular expression with a quote",
      "const r = /'/; Bun.spawn(x);",
      "x.ts",
    ],
    [
      "a Bun call after a regular expression with two escaped slashes",
      String.raw`const u = /https?:\/\//; Bun.spawn(x);`,
      "x.ts",
    ],
    [
      "a Bun call after a regular expression at the start of a line",
      "run(a,\n/'/); Bun.spawn(x);",
      "x.ts",
    ],
    [
      "a Bun call after a regular expression that follows return",
      "function f() { return /'/; } Bun.spawn(x);",
      "x.ts",
    ],
    ["a Bun call after a division", "const a = b / c; Bun.spawn(x);", "x.ts"],
    [
      "eval after a division at the start of a line",
      "const a = 1\n/ 2; eval(x) / 3\n",
      "x.ts",
    ],
    [
      "eval after a division by a member named return",
      "a.return / 1; eval(x) / 2",
      "x.ts",
    ],
    [
      "a Bun call after a division by a member named of",
      "[m.of / 2, Bun.write(p, d), 4 / 2]",
      "x.ts",
    ],
    [
      "a Bun call after a regular expression that follows an arrow",
      "const f = (x) => /'/.test(x); const { spawn: s } = Bun; s([cmd]); //'",
      "x.ts",
    ],
    [
      "a Bun call after a regular expression that follows an if",
      "if (a) /'/.test(x); Bun.spawn(y); //'",
      "x.ts",
    ],
    [
      "eval after a division that is read as a regular expression",
      "const a = b! / 2; eval(x); const c = d / 3;",
      "x.ts",
    ],
    [
      "eval after a division that follows a block",
      "if (a) {}\n/ 2; eval(x) / 3\n",
      "x.ts",
    ],
    ["eval after an increment and a division", "i++ / 2; eval(x) / 3;", "x.ts"],
    ["a name inside a regular expression", "const r = /Bun.spawn/;", "x.ts"],
    ["eval inside a regular expression", "const r = /a eval(x) b/;", "x.ts"],
    [
      "a process start named in a regular expression",
      "const r = /child_process/;",
      "x.ts",
    ],
    ["a string that a newline cuts", 'const s = "abc\nrun();', "x.ts"],
    ["a template that never closes", "const t = `abc", "x.ts"],
    ["a block comment that never closes", "run(); /* abc", "x.ts"],
    [
      "a regular expression that never closes",
      "const r = /abc\nrun();",
      "x.ts",
    ],
    [
      "an interpolation that never closes",
      ["const t = `a", INTERP, "b`;"].join(""),
      "x.ts",
    ],
    [
      "a unicode escape inside a string",
      String.raw`const s = "\u0041";`,
      "x.ts",
    ],
    ["a hex escape inside a string", String.raw`const s = "\x41";`, "x.ts"],
    [
      "a unicode escape after an escaped backslash inside a string",
      String.raw`const s = "\\\u0041";`,
      "x.ts",
    ],
    ["a unicode escape inside a template", "const t = `\\u0041`;", "x.ts"],
    [
      "a specifier of a forbidden module in a string",
      'r("node:child_process");',
      "x.ts",
    ],
    ["the name of the bun module in a string", 'r("bun");', "x.ts"],
    ["a bun scheme in a string", 'const m = "bun:ffi";', "x.ts"],
    ["Bun.spawn in a string", 'const s = "Bun.spawn";', "x.ts"],
    [
      "a destructured constructor",
      "const { constructor: F } = x; F('y');",
      "x.ts",
    ],
    ["a constructor key", "const o = { constructor: x };", "x.ts"],
    ["a constructor call on a member", "x.constructor('y');", "x.ts"],
  ])("flags %s", (_name, source, name) => {
    expect(lexicalViolations(source, name)).not.toEqual([]);
  });

  test.each([
    ["Bun.YAML", "const v = Bun.YAML.parse(text);", "x.ts"],
    ["Bun.TOML", "const v = Bun.TOML.parse(text);", "x.ts"],
    ["Bun.spawn in the runner", "Bun.spawn(cmd, opts);", RUNNER_NAME],
    ["a built-in listed", 'import { createHash } from "node:crypto";', "x.ts"],
    ["a literal dynamic import", 'await import("./a.ts");', "x.ts"],
    ["process.cwd", "const c = process.cwd();", "x.ts"],
    ["process.stdout", "process.stdout.write(s);", "x.ts"],
    ["process.getuid", "const u = process.getuid?.() ?? -1;", "x.ts"],
    [
      "process.env in the entry point",
      "const v = process.env.HOME;",
      ENTRY_NAME,
    ],
    ["process.kill in the runner", "process.kill(-pid, 9);", RUNNER_NAME],
    ["a name in a line comment", "// Bun.spawn is not used here\n", "x.ts"],
    ["a name in a block comment", "/** eval( and globalThis */\n", "x.ts"],
    [
      "a name after code on the same line",
      "const a = 1; // process.env\n",
      "x.ts",
    ],
    ["a type named Worker", 'type Worker = "windmill_worker";', "x.ts"],
    ["a name that contains a keyword", "const refetch = processStart;", "x.ts"],
    ["a url in a string", 'const u = "https://github.com/x/y";', "x.ts"],
    ["an escaped brace in a string", 'const e = "\\\\u{" + h;', "x.ts"],
    ["a unicode escape in a comment", "// pro\\u0063ess\n", "x.ts"],
    ["a constructor method of a class", "class A { constructor() {} }", "x.ts"],
    [
      "a word in a string that holds a comment mark",
      'const s = "// eval is a word"; run(s);',
      "x.ts",
    ],
    [
      "a word in a template text",
      ["const t = `eval ", INTERP, "a}`;"].join(""),
      "x.ts",
    ],
    ["a variable named like self", "const myself = 1;", "x.ts"],
    ["import.meta.dir", "const d = import.meta.dir;", "x.ts"],
    ["import.meta.main", "if (import.meta.main) run();", "x.ts"],
    ["a type declaration named Worker", 'type Worker = "a" | "b";', "x.ts"],
    ["a list of Worker", "const all: readonly Worker[] = [];", "x.ts"],
    [
      "Worker as a type argument",
      "type P = Partial<Record<Worker, number>>;",
      "x.ts",
    ],
    [
      "a type guard for Worker",
      "function f(v: string): v is Worker { return true; }",
      "x.ts",
    ],
    ["a constant named WORKERS", "const WORKERS = [];", "x.ts"],
    ["a function named requireSha", "requireSha(x);", "x.ts"],
    [
      "a method named constructor in an object",
      "const o = { constructor(a) {} };",
      "x.ts",
    ],
    [
      "a regular expression with a unicode escape",
      String.raw`const r = /\u0000/;`,
      "x.ts",
    ],
    [
      "a regular expression with a quote and a slash",
      String.raw`const r = /^["']\/$/; run(r);`,
      "x.ts",
    ],
    ["a division of two names", "const q = a / b; const w = c / d;", "x.ts"],
    ["a division after a parenthesis", "const q = (a + b) / 2;", "x.ts"],
    ["a division after a bracket", "const q = a[0] / 2;", "x.ts"],
    ["a division by a member named of", "const q = m.of / 2;", "x.ts"],
    [
      "a regular expression after an arrow",
      "const f = (x) => /a/.test(x);",
      "x.ts",
    ],
    ["a regular expression after an if", "if (a) /x/.test(b);", "x.ts"],
    [
      "a regular expression at the start of a line",
      "run(\n/x/.test(b));",
      "x.ts",
    ],
    [
      "a division inside an interpolation",
      ["const t = `", INTERP, "a / 1024}`;"].join(""),
      "x.ts",
    ],
    [
      "a string with an escaped backslash before u",
      String.raw`const s = "\\u{";`,
      "x.ts",
    ],
  ])("accepts %s", (_name, source, name) => {
    expect(lexicalViolations(source, name)).toEqual([]);
  });
});

describe("the lexical forms of the executor sources", () => {
  test("none is outside the allowed forms", () => {
    expect(
      sourceFiles().flatMap((file) =>
        lexicalViolations(
          readFileSync(file, "utf8"),
          file.slice(file.lastIndexOf("/") + 1),
        ).map((form) => `${file}: ${form}`),
      ),
    ).toEqual([]);
  });

  test("the words sync push are not named in code", () => {
    expect(
      sourceFiles().filter((file) =>
        stripComments(readFileSync(file, "utf8")).includes("sync push"),
      ),
    ).toEqual([]);
  });
});

describe("where processes can be started", () => {
  const SPAWN_FORMS = [
    /\bBun\s*\.\s*spawn(?:Sync)?\b/,
    /\bchild_process\b/,
    /\bBun\s*\.\s*\$/,
  ];

  test("only spawn_runner.ts names a form that starts a process", () => {
    expect(
      relativeNames(
        sourceFiles().filter((file) => {
          const code = stripComments(readFileSync(file, "utf8"));
          return SPAWN_FORMS.some((form) => form.test(code));
        }),
      ),
    ).toEqual(["scripts/host_apply/spawn_runner.ts"]);
  });

  test("only the entry point imports spawn_runner", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          importsModule(file, readFileSync(file, "utf8"), RUNNER_NAME),
        ),
      ),
    ).toEqual(["scripts/host-apply.ts"]);
  });

  test("only the entry point imports run_git", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          importsModule(file, readFileSync(file, "utf8"), "run_git.ts"),
        ),
      ),
    ).toEqual(["scripts/host-apply.ts"]);
  });

  // 取得の経路。入口は取得を持たない。取得を使う実行役の本体を足すときに、この一覧を直す。
  test.each(["run_fetch.ts", "host_probe.ts"])(
    "no module imports %s yet",
    (name) => {
      expect(
        relativeNames(
          scriptFiles().filter((file) =>
            importsModule(file, readFileSync(file, "utf8"), name),
          ),
        ),
      ).toEqual([]);
    },
  );

  test.each([
    "command.ts",
    "run_git.ts",
    "run_fetch.ts",
    "host_probe.ts",
    "spawn_runner.ts",
    "exec_paths.ts",
  ])("no approval module imports %s", (name) => {
    expect(
      APPROVAL_MODULES.filter((file) =>
        importsModule(file, readFileSync(file, "utf8"), name),
      ).map((file) => file.slice(HOST_APPLY_DIR.length + 1)),
    ).toEqual([]);
  });
});

/**
 * `command.ts`から取り込んでいる値の名前。型だけの名前は数えない。
 * 名前空間のimport、`export *`、`export {…} from`、動的import、副作用のimportは、名前の代わりに印を返す。
 */
function valueImports(
  file: string,
  source: string,
  moduleName: string,
): string[] {
  const wanted = moduleKey(join(HOST_APPLY_DIR, moduleName));
  const points = (specifier: string): boolean =>
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    moduleKey(resolve(dirname(file), specifier)) === wanted;
  const names: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    if (!points(match[4] ?? "") || match[2] !== undefined) continue;
    const clause = (match[3] ?? "").trim();
    if (match[1] === "export") {
      names.push(clause.startsWith("*") ? "<export *>" : "<re-export>");
    } else if (clause.startsWith("*")) names.push("<namespace>");
    else if (!clause.startsWith("{")) names.push("<default>");
    else {
      const inner = clause.slice(1, clause.lastIndexOf("}"));
      for (const part of inner.split(",")) {
        const text = part.trim();
        if (text === "" || text.startsWith("type ")) continue;
        names.push((text.split(/\s+as\s+/)[0] ?? "").trim());
      }
    }
  }
  for (const match of source.matchAll(
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    if (points(match[1] ?? "")) names.push("<dynamic>");
  }
  for (const match of source.matchAll(
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  )) {
    if (points(match[1] ?? "")) names.push("<side effect>");
  }
  return names.sort();
}

describe("what the modules take from command.ts", () => {
  // 外部コマンドの指定を発行できるのは、run_git・run_fetch・host_probeだけ。
  // issueSpecUncheckedは、どの本番のモジュールも取り込まない。増やすときは、このテストを直して人のレビューを通す。
  const ALLOWED: Record<string, string[]> = {
    "scripts/host-apply.ts": ["CommandError"],
    "scripts/host_apply/spawn_runner.ts": ["CommandError", "isIssued"],
    "scripts/host_apply/run_git.ts": ["issueSpec"],
    "scripts/host_apply/run_fetch.ts": ["issueSpec"],
    "scripts/host_apply/host_probe.ts": ["HOST_PROBE_ENV", "issueSpec"],
  };

  test("are exactly the allowed names of the allowed modules", () => {
    const actual: Record<string, string[]> = {};
    for (const file of scriptFiles()) {
      const names = valueImports(
        file,
        readFileSync(file, "utf8"),
        "command.ts",
      );
      if (names.length > 0) actual[file.slice(REPO_ROOT.length + 1)] = names;
    }
    expect(actual).toEqual(ALLOWED);
  });

  test.each([
    ["a name", 'import { issueSpec } from "./command.ts";', ["issueSpec"]],
    [
      "a renamed name",
      'import { issueSpec as i } from "./command";',
      ["issueSpec"],
    ],
    [
      "a type-only name",
      'import { type CommandRunner } from "./command.ts";',
      [],
    ],
    ["a type import", 'import type { CommandRunner } from "./command.ts";', []],
    ["a namespace", 'import * as c from "./command.ts";', ["<namespace>"]],
    ["a default import", 'import c from "./command.ts";', ["<default>"]],
    ["an export star", 'export * from "./command.ts";', ["<export *>"]],
    [
      "a re-export",
      'export { issueSpec } from "./command.ts";',
      ["<re-export>"],
    ],
    ["a dynamic import", 'await import("./command.ts");', ["<dynamic>"]],
    ["a side effect import", 'import "./command.ts";', ["<side effect>"]],
    ["another module", 'import { a } from "./stable.ts";', []],
  ])("the scanner reads %s", (_name, source, expected) => {
    expect(
      valueImports(join(HOST_APPLY_DIR, "x.ts"), source, "command.ts"),
    ).toEqual(expected);
  });
});

describe("what the modules take from spawn_runner.ts", () => {
  // 実行口を作れる値は、入口が取る`createRunner`だけにする。
  // 既定の部品(`Bun.spawn`を包む関数)を取れると、発行の登録簿と種類の表を迂回して起動できる。
  const ALLOWED: Record<string, string[]> = {
    "scripts/host-apply.ts": ["createRunner"],
  };

  test("are exactly the allowed names of the allowed modules", () => {
    const actual: Record<string, string[]> = {};
    for (const file of scriptFiles()) {
      const names = valueImports(file, readFileSync(file, "utf8"), RUNNER_NAME);
      if (names.length > 0) actual[file.slice(REPO_ROOT.length + 1)] = names;
    }
    expect(actual).toEqual(ALLOWED);
  });

  test("an import of the default parts is not among the allowed names", () => {
    const names = valueImports(
      join(REPO_ROOT, "scripts/host-apply.ts"),
      'import { createRunner, defaultRunnerDeps } from "./host_apply/spawn_runner.ts";',
      RUNNER_NAME,
    );
    expect(names).not.toEqual(ALLOWED["scripts/host-apply.ts"]);
  });

  test("a type import of the runner dependencies is not counted", () => {
    expect(
      valueImports(
        join(REPO_ROOT, "scripts/host-apply.ts"),
        'import { createRunner, type RunnerDeps } from "./host_apply/spawn_runner.ts";',
        RUNNER_NAME,
      ),
    ).toEqual(["createRunner"]);
  });

  test("a namespace import is flagged", () => {
    expect(
      valueImports(
        join(REPO_ROOT, "scripts/host-apply.ts"),
        'import * as r from "./host_apply/spawn_runner.ts";',
        RUNNER_NAME,
      ),
    ).toEqual(["<namespace>"]);
  });

  test("the module exports no object that holds the real spawn", async () => {
    const exported = await import("../../scripts/host_apply/spawn_runner.ts");
    expect(Object.keys(exported).sort()).toEqual([
      "createKillGroup",
      "createRunner",
      "defaultKillGroup",
    ]);
  });

  test("the default killGroup is frozen", async () => {
    const { defaultKillGroup } = await import(
      "../../scripts/host_apply/spawn_runner.ts"
    );
    expect(Object.isFrozen(defaultKillGroup)).toBe(true);
  });
});

describe("the unchecked entry of the runner", () => {
  test("no executor source turns acceptUnchecked on", () => {
    expect(
      scriptFiles().filter((file) =>
        /\bacceptUnchecked\s*[:=]\s*true\b/.test(
          stripComments(readFileSync(file, "utf8")),
        ),
      ),
    ).toEqual([]);
  });

  test("the entry point does not name acceptUnchecked", () => {
    expect(
      stripComments(readFileSync(ENTRY, "utf8")).includes("acceptUnchecked"),
    ).toBe(false);
  });

  test("no executor source takes issueSpecUnchecked", () => {
    expect(
      scriptFiles()
        .filter((file) =>
          stripComments(readFileSync(file, "utf8")).includes(
            "issueSpecUnchecked",
          ),
        )
        .map((file) => file.slice(REPO_ROOT.length + 1)),
    ).toEqual(["scripts/host_apply/command.ts"]);
  });
});

describe("the modules of the external commands", () => {
  const COMMAND_MODULES = [
    "command.ts",
    "exec_paths.ts",
    "git_grammar.ts",
    "run_git.ts",
    "run_fetch.ts",
    "host_probe.ts",
  ].map((name) => join(HOST_APPLY_DIR, name));

  test("import only built-ins and scripts/host_apply/", () => {
    expect(violations(COMMAND_MODULES)).toEqual([]);
  });

  test("read no environment variable", () => {
    expect(
      COMMAND_MODULES.flatMap((file) =>
        envReads(stripComments(readFileSync(file, "utf8"))).map(
          (form) => `${file}: ${form}`,
        ),
      ),
    ).toEqual([]);
  });

  test("call no network and read no mise.local", () => {
    expect(
      [...COMMAND_MODULES, join(HOST_APPLY_DIR, RUNNER_NAME)].flatMap((file) =>
        forbiddenForms(stripComments(readFileSync(file, "utf8")))
          .filter((form) => !form.startsWith("spawn("))
          .map((form) => `${file}: ${form}`),
      ),
    ).toEqual([]);
  });

  test("the runner reads no environment variable", () => {
    expect(
      envReads(
        stripComments(readFileSync(join(HOST_APPLY_DIR, RUNNER_NAME), "utf8")),
      ),
    ).toEqual([]);
  });

  test("the pure modules start no process", () => {
    expect(
      ["state.ts", "git.ts", "state_io.ts", "drain_store.ts", "secure_file.ts"]
        .map((name) => join(HOST_APPLY_DIR, name))
        .filter((file) =>
          /\bspawn\w*\s*\(|Bun\s*\.\s*\$|child_process/.test(
            stripComments(readFileSync(file, "utf8")),
          ),
        ),
    ).toEqual([]);
  });
});

describe("the specifications that every table builds", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const URL = "https://github.com/example/repo.git";
  const FORBIDDEN_ENV = /^(?:DOCKER_|COMPOSE_|LD_|DYLD_)|^GIT_EXEC_PATH$/;

  async function specs(): Promise<IssuedSpec[]> {
    const built: IssuedSpec[] = [
      gitReadSpec(showBlobArgs(SHA, "a"), { cwd: "/r" }),
      gitReadSpec(diffNameStatusArgs(SHA, SHA), { cwd: "/r" }),
      gitReadSpec(isAncestorArgs(SHA, SHA), { cwd: "/r" }),
      gitReadSpec(commitExistsArgs(SHA), { cwd: "/r" }),
      gitReadSpec(lsTreeRecursiveArgs(SHA), { cwd: "/r" }),
      gitReadSpec(lsTreePathArgs(SHA, "a"), { cwd: "/r" }),
      gitReadSpec(diffPatchArgs(SHA, SHA, ["a"]), { cwd: "/r" }),
      gitReadSpec(resolveHeadArgs(), { cwd: "/r" }),
      gitReadSpec(revParseQueryArgs("git-dir"), { cwd: "/r" }),
      gitReadSpec(showRefArgs(ORIGIN_MAIN_REF), { cwd: "/r" }),
      remoteUrlSpec("/r.git"),
    ];
    const recorder: CommandRunner = async (spec) => {
      built.push(spec);
      return {
        kind: "done",
        code: 0,
        stdout: `${URL}\n`,
        stderr: "",
        stdoutDropped: false,
        stderrDropped: false,
      };
    };
    await fetchOrigin(recorder, {
      repoGit: "/r.git",
      recordedUrl: URL,
      token: "tok",
    });
    await processStart(recorder, 1).catch(() => {});
    await bootId(recorder).catch(() => {});
    return built;
  }

  test("run an absolute executable", async () => {
    expect((await specs()).filter((spec) => !spec.bin.startsWith("/"))).toEqual(
      [],
    );
  });

  test("run in an absolute directory", async () => {
    expect((await specs()).filter((spec) => !spec.cwd.startsWith("/"))).toEqual(
      [],
    );
  });

  test("pass no environment variable of docker, compose or the loader", async () => {
    expect(
      (await specs()).flatMap((spec) =>
        Object.keys(spec.env).filter((key) => FORBIDDEN_ENV.test(key)),
      ),
    ).toEqual([]);
  });

  test("take the timeout of the table", async () => {
    expect(
      (await specs()).filter(
        (spec) => spec.timeoutMs !== COMMAND_TIMEOUT_MS[spec.kind],
      ),
    ).toEqual([]);
  });

  test("only create kinds that the table lists as creatable", async () => {
    expect(
      (await specs()).filter((spec) => !CREATABLE_KINDS.includes(spec.kind)),
    ).toEqual([]);
  });

  test("cover every creatable kind", async () => {
    expect(
      [...new Set((await specs()).map((spec) => spec.kind))].sort(),
    ).toEqual([...CREATABLE_KINDS].sort());
  });
});

/** 指定子のimportで取り込んでいる名前(`import type`と`type`つきの名前は数えない)。 */
function namesImportedFrom(source: string, specifier: string): string[] {
  const names: string[] = [];
  const statement =
    /(?:^|\n)\s*import\s+(type\s+)?([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    if (match[3] !== specifier || match[1] !== undefined) continue;
    const clause = (match[2] ?? "").trim();
    if (!clause.startsWith("{")) {
      names.push("<non-named>");
      continue;
    }
    for (const part of clause.slice(1, clause.lastIndexOf("}")).split(",")) {
      const text = part.trim();
      if (text === "" || text.startsWith("type ")) continue;
      names.push((text.split(/\s+as\s+/)[0] ?? "").trim());
    }
  }
  return names.sort();
}

/** 文字列とテンプレートの本文に、ファイル名`lock`の要素があるか。パスの区切りで分けて数える。 */
function namesLockFile(source: string): boolean {
  return scanSource(source).strings.some((text) =>
    text.split("/").some((part) => part === "lock"),
  );
}

describe("the lock module", () => {
  const LOCK_FILE = join(HOST_APPLY_DIR, "lock.ts");

  test("is imported by no module under scripts/ because nothing is wired", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          importsModule(file, readFileSync(file, "utf8"), "lock.ts"),
        ),
      ),
    ).toEqual([]);
  });

  test("exports exactly the production and test entries", async () => {
    const exported = await import("../../scripts/host_apply/lock.ts");
    expect(Object.keys(exported).sort()).toEqual([
      "acquireLock",
      "acquireLockForTest",
      "resetOwnerRecord",
      "resetOwnerRecordForTest",
    ]);
  });

  test("takes only the directory checks from secure_file", () => {
    expect(
      valueImports(
        LOCK_FILE,
        readFileSync(LOCK_FILE, "utf8"),
        "secure_file.ts",
      ),
    ).toEqual(["inspectStateDir", "normalizeStateDir"]);
  });

  test("takes a fixed set of names from node:fs", () => {
    expect(
      namesImportedFrom(readFileSync(LOCK_FILE, "utf8"), "node:fs"),
    ).toEqual([
      "closeSync",
      "constants",
      "fstatSync",
      "ftruncateSync",
      "lstatSync",
      "openSync",
      "readSync",
      "writeSync",
    ]);
  });

  test("reaches node:fs through one static import and no dynamic one", () => {
    expect(
      specifiers(readFileSync(LOCK_FILE, "utf8")).filter(
        (specifier) => specifier === "node:fs" || specifier === "<dynamic>",
      ),
    ).toEqual(["node:fs"]);
  });

  test("the scanner reads the named imports and skips type names", () => {
    expect(
      namesImportedFrom(
        'import { type BigIntStats, closeSync as c } from "node:fs";',
        "node:fs",
      ),
    ).toEqual(["closeSync"]);
  });

  test("the kernel entries of the test hooks are named only in lock.ts", () => {
    expect(
      relativeNames(
        scriptFiles().filter((file) =>
          /\b(?:acquireLockForTest|resetOwnerRecordForTest|openLocked|closeLocked|afterOpen)\b/.test(
            stripComments(readFileSync(file, "utf8")),
          ),
        ),
      ),
    ).toEqual(["scripts/host_apply/lock.ts"]);
  });

  test("the lock file name is written only in lock.ts", () => {
    expect(
      relativeNames(
        sourceFiles().filter((file) =>
          namesLockFile(readFileSync(file, "utf8")),
        ),
      ),
    ).toEqual(["scripts/host_apply/lock.ts"]);
  });

  test.each([
    ["a quoted name", 'join(dir, "lock")'],
    ["a path in a string", 'const p = "state/lock";'],
    ["a name in a template literal", "const p = `${dir}/lock`;"],
  ])("the file name scanner finds %s", (_name, source) => {
    expect(namesLockFile(source)).toBe(true);
  });

  test("the file name scanner ignores an identifier", () => {
    expect(namesLockFile("const lock = acquire();")).toBe(false);
  });
});

describe("the importers of node:fs", () => {
  // ファイルを直接読み書きできるモジュールの閉じた一覧。増やすときは、このテストを直して人のレビューを通す。
  test("are exactly the allowed modules", () => {
    expect(
      relativeNames(
        sourceFiles().filter((file) =>
          specifiers(withoutTypeImports(readFileSync(file, "utf8"))).includes(
            "node:fs",
          ),
        ),
      ),
    ).toEqual([
      "scripts/host_apply/code_origin.ts",
      "scripts/host_apply/lock.ts",
      "scripts/host_apply/secure_file.ts",
    ]);
  });
});
