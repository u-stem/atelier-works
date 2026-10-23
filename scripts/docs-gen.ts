#!/usr/bin/env bun
// 設定ファイルから取れる事実を、文書の生成範囲に書き出す。
// 文書に手で同じ事実を書くと、設定を変えたときに文書だけが古くなるため。
//
// 生成範囲は`<!-- generated:名前 -->`と`<!-- /generated:名前 -->`の行で囲む。
// 名前ごとの中身は次のとおり。
// - schedules: `f/factory/*.schedule.yaml`の一覧(`docs/architecture.md`)
// - flows: `f/factory`のflowの一覧と起動元(`docs/architecture.md`)。
//   起動元は`scripts/launch-graph.ts`の表から作る
// - assets: `f/factory`のscriptとflowのpathとsummaryの一覧(`docs/architecture.md`)
// READMEのmiseタスクの表は日本語の説明を手で書くので生成せず、
// `mise.toml`のタスクと過不足が無いかだけを`--check`で確かめる。
//
// 使い方:
//   bun run scripts/docs-gen.ts          生成範囲を書き換える
//   bun run scripts/docs-gen.ts --check  書き換えが要るか、タスクの表に過不足があれば終了コード1

import { readFileSync, writeFileSync } from "node:fs";
import {
  describeOrigin,
  LAUNCH_EDGES,
  type LaunchEdge,
} from "./launch-graph.ts";

/** 生成範囲を持つ文書。 */
export const GENERATED_DOCS: readonly string[] = ["docs/architecture.md"];

/** miseタスクの表を持つ文書。 */
export const TASK_TABLE_DOC = "README.md";

const BLOCK_PATTERN =
  /(<!-- generated:([a-z-]+) -->\n)[\s\S]*?(<!-- \/generated:\2 -->)/g;

export type ScheduleEntry = {
  readonly name: string;
  readonly summary: string;
  readonly cron: string;
  readonly target: string;
  readonly description: string;
};

export type AssetEntry = {
  readonly path: string;
  readonly kind: "script" | "flow";
  readonly summary: string;
};

/** 表のセルに入れられるよう、改行と`|`を置き換える。 */
function cell(text: string): string {
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** スケジュールの一覧を表にする。並びは`name`の順。 */
export function renderSchedules(entries: readonly ScheduleEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (entry) =>
        `| ${entry.name} | \`${entry.cron}\` | \`${entry.target}\` | ${cell(entry.description)} |`,
    );
  return [
    "| スケジュール | cron(秒 分 時 日 月 曜日) | 実行するもの | 内容 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export type FlowEntry = {
  readonly name: string;
  readonly summary: string;
};

/**
 * flowと起動元の一覧を表にする。並びは、`[SF-2-1]`などの接頭辞を含むsummaryの順。
 * 内容の列は、summaryから接頭辞を除いたもの。
 * 起動元は`originLabel`の表記を昇順に並べ、無ければ「なし」と書く。
 */
export function renderFlows(
  flows: readonly FlowEntry[],
  edges: readonly LaunchEdge[],
  originLabel: (edge: LaunchEdge) => string,
): string {
  const rows = [...flows]
    .sort((a, b) => a.summary.localeCompare(b.summary, "en"))
    .map((flow) => {
      const origins = edges
        .filter((edge) => edge.to === flow.name)
        .map(originLabel)
        .sort((a, b) => a.localeCompare(b, "en"));
      const content = flow.summary.replace(/^\[[^\]]+\]\s*/, "");
      return `| \`${flow.name}\` | ${origins.length === 0 ? "なし" : origins.join("、")} | ${cell(content)} |`;
    });
  return ["| フロー | 起動元 | 内容 |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}

/** scriptとflowの一覧を表にする。並びはWindmillの画面と同じくsummaryの順。 */
export function renderAssets(entries: readonly AssetEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => a.summary.localeCompare(b.summary, "en"))
    .map(
      (entry) =>
        `| \`${entry.path}\` | ${entry.kind} | ${cell(entry.summary)} |`,
    );
  return ["| path | 種別 | summary |", "| --- | --- | --- |", ...rows].join(
    "\n",
  );
}

/**
 * `markdown`の生成範囲を`render(名前)`の結果で置き換えた文字列を返す。
 * 知らない名前の範囲があれば例外を投げる。
 */
export function replaceGeneratedBlocks(
  markdown: string,
  render: (name: string) => string | null,
): string {
  return markdown.replace(
    BLOCK_PATTERN,
    (_match, open: string, name: string, close: string) => {
      const content = render(name);
      if (content === null) {
        throw new Error(`unknown generated block: ${name}`);
      }
      return `${open}${content}\n${close}`;
    },
  );
}

/** READMEの表から`mise run <task>`のタスク名を、現れる順に返す。 */
export function taskNamesInTable(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(/^\| `mise run ([^`]+)` \|/gm)) {
    names.push(match[1] ?? "");
  }
  return names;
}

/** `mise.toml`のタスク名と表のタスク名を比べ、過不足を説明する文を返す(無ければ空)。 */
export function compareTaskNames(
  tomlNames: readonly string[],
  tableNames: readonly string[],
): string[] {
  const table = new Set(tableNames);
  const toml = new Set(tomlNames);
  return [
    ...tomlNames
      .filter((name) => !table.has(name))
      .map(
        (name) => `${TASK_TABLE_DOC}: task "${name}" is missing from the table`,
      ),
    ...tableNames
      .filter((name) => !toml.has(name))
      .map((name) => `${TASK_TABLE_DOC}: task "${name}" is not in mise.toml`),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readYaml(path: string): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path}: not a YAML mapping`);
  return parsed;
}

function listFiles(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync(".")].sort();
}

function loadSchedules(): ScheduleEntry[] {
  return listFiles("f/factory/*.schedule.yaml").map((path) => {
    const yaml = readYaml(path);
    return {
      name: path.replace(/^f\/factory\//, "").replace(/\.schedule\.yaml$/, ""),
      summary: stringField(yaml, "summary"),
      cron: stringField(yaml, "schedule"),
      target: stringField(yaml, "script_path"),
      description: stringField(yaml, "description"),
    };
  });
}

function loadFlows(): FlowEntry[] {
  return listFiles("f/factory/*__flow/flow.yaml").map((path) => ({
    name: path.replace(/^f\/factory\//, "").replace(/__flow\/flow\.yaml$/, ""),
    summary: stringField(readYaml(path), "summary"),
  }));
}

function loadAssets(): AssetEntry[] {
  const scripts = listFiles("f/factory/**/*.script.yaml").map((path) => ({
    path: path.replace(/\.script\.yaml$/, ""),
    kind: "script" as const,
    summary: stringField(readYaml(path), "summary"),
  }));
  const flows = listFiles("f/factory/*__flow/flow.yaml").map((path) => ({
    path: path.replace(/__flow\/flow\.yaml$/, ""),
    kind: "flow" as const,
    summary: stringField(readYaml(path), "summary"),
  }));
  return [...scripts, ...flows];
}

function loadMiseTaskNames(): string[] {
  const parsed: unknown = Bun.TOML.parse(readFileSync("mise.toml", "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.tasks)) return [];
  return Object.keys(parsed.tasks);
}

/** 生成範囲の名前から中身を作る。知らない名前ならnull。 */
function renderBlock(name: string): string | null {
  if (name === "schedules") return renderSchedules(loadSchedules());
  if (name === "flows") {
    return renderFlows(loadFlows(), LAUNCH_EDGES, describeOrigin);
  }
  if (name === "assets") return renderAssets(loadAssets());
  return null;
}

/**
 * 生成範囲とタスクの表を確かめ、問題を説明する文を返す(無ければ空)。
 * `write`が真なら、生成範囲が古い文書を書き換える(その文書は問題に数えない)。
 */
export function runDocsGen(write: boolean): string[] {
  const problems: string[] = [];
  for (const path of GENERATED_DOCS) {
    const current = readFileSync(path, "utf8");
    const next = replaceGeneratedBlocks(current, renderBlock);
    if (next === current) continue;
    if (write) {
      writeFileSync(path, next);
    } else {
      problems.push(
        `${path}: generated blocks are stale (run \`mise run docs:gen\`)`,
      );
    }
  }
  problems.push(
    ...compareTaskNames(
      loadMiseTaskNames(),
      taskNamesInTable(readFileSync(TASK_TABLE_DOC, "utf8")),
    ),
  );
  return problems;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const problems = runDocsGen(!check);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
}
