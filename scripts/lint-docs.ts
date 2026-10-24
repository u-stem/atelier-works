#!/usr/bin/env bun
// リポジトリのMarkdown文書を`docs/writing-guidelines.md`の規則で検査する。
// 次の4つをまとめて実行し、1つでも失敗すれば終了コード1で終わる。
// - このリポジトリの規則(`f/factory/lib/prose_check.ts`の`REPO_DOC_RULES`)
// - markdownlint(`.markdownlint-cli2.jsonc`)
// - textlint(`.textlintrc.json`)
// - 生成範囲とmiseタスクの表の確認(`scripts/docs-gen.ts --check`)
//
// 対象は、gitが追跡しているか無視していない`.md`のうち、`isTargetDoc`が選ぶもの。
// `wmill`が生成するファイルと外から取り込んだスキルは、自分で書き直さないので対象外にする。
//
// 使い方: bun run scripts/lint-docs.ts [file...]
// 引数があれば、そのうち対象のファイルだけを検査する(pre-commitで使う)。

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { checkProse, REPO_DOC_RULES } from "../f/factory/lib/prose_check.ts";
import { runDocsGen } from "./docs-gen.ts";

/** 自作のスキル。これ以外の`.claude/skills/`は`wmill`の管理スキルか取り込んだもの。 */
const OWN_SKILL_PATTERN =
  /^\.claude\/skills\/(factory-[a-z-]+|windmill-script|drawio-diagram|review-loop|hold)\//;

/** 自作のsubagentの定義。 */
const OWN_AGENT_PATTERN = /^\.claude\/agents\/[^/]+\.md$/;

const EXCLUDED_PREFIXES = [".agents/", "tests/fixtures/"];

const EXCLUDED_FILES = new Set(["AGENTS.wmill.md"]);

/**
 * スキルの`template.md`は、Factoryが生成する文書の雛形で、`<...>`の仮の文を含む。
 * 章立ては`requirements_doc.ts`と`audit_doc.ts`が検査するので、ここでは見ない。
 */
const TEMPLATE_PATTERN = /^\.claude\/skills\/[^/]+\/template\.md$/;

/** 検査の対象にする文書かを、パスだけで判定する。 */
export function isTargetDoc(path: string): boolean {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  if (!normalized.endsWith(".md")) return false;
  if (normalized.split("/").includes("node_modules")) return false;
  if (EXCLUDED_FILES.has(normalized)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (TEMPLATE_PATTERN.test(normalized)) return false;
  if (normalized.startsWith(".claude/")) {
    return (
      OWN_SKILL_PATTERN.test(normalized) || OWN_AGENT_PATTERN.test(normalized)
    );
  }
  return true;
}

/**
 * 先頭のYAMLのfrontmatterを、行の数を保ったまま空行にする。
 * スキルの`description`は1行が長いが、文書の本文ではないので検査しない。
 */
export function blankFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n/);
  if (match === null) return markdown;
  return (
    "\n".repeat(match[0].split("\n").length - 1) +
    markdown.slice(match[0].length)
  );
}

/** `markdown`をこのリポジトリの規則で検査し、`path:line: [rule] 内容`の形で返す。 */
export function lintDocText(path: string, markdown: string): string[] {
  return checkProse(blankFrontmatter(markdown), REPO_DOC_RULES).map(
    (issue) => `${path}:${issue.line}: [${issue.rule}] ${issue.message}`,
  );
}

/**
 * 外部の検査コマンドに渡すパスにする。
 * 相対パスに`./`を付け、`--fix.md`のような名前のファイルをオプションとして読ませない。
 */
export function toToolPath(path: string): string {
  if (isAbsolute(path) || path.startsWith("./")) return path;
  return `./${path}`;
}

function listCandidateDocs(): string[] {
  const result = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.md",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

/** 外部の検査コマンドを実行し、成功したかを返す。出力はそのまま端末に流す。 */
function runTool(argv: readonly string[]): boolean {
  const result = Bun.spawnSync([...argv], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode === 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  const candidates = argv.length > 0 ? argv : listCandidateDocs();
  const targets = [...new Set(candidates)]
    .filter((path) => isTargetDoc(path) && existsSync(path))
    .sort();

  const problems: string[] = [];
  for (const path of targets) {
    problems.push(...lintDocText(path, readFileSync(path, "utf8")));
  }
  for (const problem of problems) console.error(problem);

  let ok = problems.length === 0;
  if (targets.length > 0) {
    const toolPaths = targets.map(toToolPath);
    ok = runTool(["node_modules/.bin/markdownlint-cli2", ...toolPaths]) && ok;
    ok = runTool(["node_modules/.bin/textlint", ...toolPaths]) && ok;
  }

  const genProblems = runDocsGen(false);
  for (const problem of genProblems) console.error(problem);
  ok = genProblems.length === 0 && ok;

  if (!ok) process.exit(1);
}

if (import.meta.main) {
  main();
}
