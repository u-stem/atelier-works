#!/usr/bin/env bun
// ソースの中の節記号(U+00A7)を禁止する。コメントに設計文書の章番号を書くと、
// 文書の改訂で参照先が分からなくなるため、章番号は書かずに契約と理由を書く。
//
// 判定は、対象ファイルに節記号が現れるかだけで行う。コメントか文字列かは
// 区別しない(単純で誤検知が少ない)。
// 対象は拡張子が`.ts` `.tsx` `.js` `.mjs` `.sh` `.yaml` `.yml` `.toml` `.sql`の
// ファイルと、Dockerfile・Caddyfile。次は対象外にする。
// - `.md`: 規約の文書が、この記号そのものを説明に使うため。
// - `migrations/`: 適用済みの履歴で、書き換えられないため。
// - `.claude/` `.agents/` `node_modules/`: 管理外または生成物。
// - `*.lock` `wmill-lock.yaml` `tests/fixtures/`: 生成物とテストの入力。
//
// 使い方: bun run scripts/lint-no-section-sign.ts [file...]
// 引数が無ければ`git ls-files`の全ファイルを対象にする。
// 見つかった位置を`path:line:column`で出力して終了コード1、無ければ0。

import { existsSync, readFileSync } from "node:fs";

export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

const SECTION_SIGN = String.fromCodePoint(0xa7);

const TARGET_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".sh",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
]);
const EXCLUDED_PREFIXES = [
  "migrations/",
  ".claude/",
  ".agents/",
  "tests/fixtures/",
];

function normalize(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(baseName: string): string {
  const dot = baseName.lastIndexOf(".");
  return dot <= 0 ? "" : baseName.slice(dot).toLowerCase();
}

/** 検査の対象にするファイルかを、パスだけで判定する。 */
export function isTargetFile(path: string): boolean {
  const normalized = normalize(path);
  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (normalized.split("/").includes("node_modules")) return false;
  const baseName = baseNameOf(normalized);
  if (baseName === "wmill-lock.yaml" || baseName.endsWith(".lock")) {
    return false;
  }
  if (
    baseName === "Dockerfile" ||
    baseName.startsWith("Dockerfile.") ||
    baseName === "Caddyfile"
  ) {
    return true;
  }
  return TARGET_EXTENSIONS.has(extensionOf(baseName));
}

/** `sourceText`の中の節記号を、出現の位置ごとに返す。 */
export function findSectionSigns(
  fileName: string,
  sourceText: string,
): Finding[] {
  const findings: Finding[] = [];
  const lines = sourceText.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(SECTION_SIGN, from);
      if (at === -1) break;
      findings.push({
        file: fileName,
        line: index + 1,
        column: at + 1,
        message:
          "Unexpected section sign. Describe the contract and the reason instead of citing a document section number.",
      });
      from = at + 1;
    }
  }
  return findings;
}

function collectTrackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"]);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

function main(): void {
  const argv = process.argv.slice(2);
  const candidates = argv.length > 0 ? argv : collectTrackedFiles();
  // 作業ツリーで削除済みのファイルは、git ls-filesに残っていても読めない。
  const targets = candidates.filter(
    (path) => isTargetFile(path) && existsSync(path),
  );

  const allFindings: Finding[] = [];
  for (const file of targets) {
    allFindings.push(...findSectionSigns(file, readFileSync(file, "utf8")));
  }

  if (allFindings.length > 0) {
    for (const finding of allFindings) {
      console.error(
        `${finding.file}:${finding.line}:${finding.column} ${finding.message}`,
      );
    }
    console.error(`\nFound ${allFindings.length} disallowed section sign(s).`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
