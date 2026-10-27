// Console用workerは、リポジトリのファイルを読めない。リポジトリの定義(scriptの定義、フロー、スケジュール)から、
// Consoleが照合に使う定数のファイル`f/factory/lib/console_known_paths.ts`を生成する。
// 定数が定義と一致していることは、`tests/scripts/console_known_paths.test.ts`が固定する。
//
// 使い方: bun run scripts/gen-console-known-paths.ts

import { join } from "node:path";
import { Glob } from "bun";
import { WRITE_SCRIPTS_NAMED_ONLY_BY_THEMSELVES } from "./claude-hooks/console-scripts.ts";

export type RepoSchedule = {
  readonly path: string;
  readonly script_path: string;
  readonly is_flow: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly no_flow_overlap: boolean;
};

export type KnownPaths = {
  readonly scripts: readonly string[];
  readonly flows: readonly string[];
  readonly schedules: readonly RepoSchedule[];
  /** 履歴の絞り込みに出すscriptとフローのパス。並べ替え済み。 */
  readonly historyFilter: readonly string[];
};

const OUTPUT = "f/factory/lib/console_known_paths.ts";

async function scan(root: string, pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob(pattern).scan(root)) found.push(file);
  return found.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSchedule(root: string, file: string): Promise<RepoSchedule> {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(join(root, file)).text(),
  );
  if (!isRecord(parsed)) {
    throw new Error(`${file}: not a YAML mapping`);
  }
  const { schedule, timezone, script_path, is_flow, enabled, no_flow_overlap } =
    parsed;
  if (
    typeof schedule !== "string" ||
    typeof timezone !== "string" ||
    typeof script_path !== "string" ||
    typeof is_flow !== "boolean" ||
    typeof enabled !== "boolean"
  ) {
    throw new Error(`${file}: a schedule field is missing or has a wrong type`);
  }
  return {
    path: file.replace(/\.schedule\.yaml$/, ""),
    script_path,
    is_flow,
    schedule,
    timezone,
    enabled,
    no_flow_overlap: no_flow_overlap === true,
  };
}

/**
 * 定数に入れないscript。名前を`f/`の他のファイルに持たせない書き込みのscript(保留と凍結の解除、ジョブの取消)は、
 * Consoleの履歴の絞り込みに要らない。tag consoleのジョブは既定で一覧に出ない。
 * 名前を持たせない検査(`tests/scripts/hold_wiring.test.ts`)を、生成した定数が破らないようにするためでもある。
 */
const WITHHELD: readonly string[] = WRITE_SCRIPTS_NAMED_ONLY_BY_THEMSELVES.map(
  (name) => `f/factory/${name}`,
);

/**
 * 履歴の絞り込みに出さないscript。
 * フローのステップ(`f/factory/steps/`)と失敗ハンドラは、フローの中のジョブで、履歴に出ない。
 * 例外は承認のハンドラで、承認のscriptが起動するので親のジョブを持つが、フローのステップではなく、履歴に出る。
 * Consoleのworker(tag console)のscriptは、履歴に出さない既定である。選んでも常に0件になる。
 */
const HISTORY_FILTER_EXCLUDED: readonly string[] = ["f/factory/on_error_flow"];
const HISTORY_FILTER_EXCLUDED_PREFIX = "f/factory/steps/";
const APPROVAL_HANDLERS: readonly string[] = [
  "f/factory/steps/issue_proposal_apply",
  "f/factory/steps/requirements_apply",
];
const CONSOLE_TAG = "console";

async function readTag(root: string, path: string): Promise<string | null> {
  const parsed: unknown = Bun.YAML.parse(
    await Bun.file(join(root, `${path}.script.yaml`)).text(),
  );
  return isRecord(parsed) && typeof parsed.tag === "string" ? parsed.tag : null;
}

async function historyFilterOf(
  root: string,
  scripts: readonly string[],
  flows: readonly string[],
): Promise<string[]> {
  const roots: string[] = [];
  for (const path of scripts) {
    if (
      path.startsWith(HISTORY_FILTER_EXCLUDED_PREFIX) &&
      !APPROVAL_HANDLERS.includes(path)
    ) {
      continue;
    }
    if (HISTORY_FILTER_EXCLUDED.includes(path)) continue;
    if ((await readTag(root, path)) === CONSOLE_TAG) continue;
    roots.push(path);
  }
  return [...roots, ...flows].sort();
}

/**
 * `root`の下のscriptの定義(libと除外を除く)、フロー、スケジュールを集める。
 * フローのパスは、`<名前>__flow`のディレクトリから`f/factory/<名前>`と導く。
 */
export async function collectKnownPaths(root: string): Promise<KnownPaths> {
  const scripts = (await scan(root, "f/factory/**/*.script.yaml"))
    .map((file) => file.replace(/\.script\.yaml$/, ""))
    .filter((path) => !path.startsWith("f/factory/lib/"))
    .filter((path) => !WITHHELD.includes(path));
  const flows = (await scan(root, "f/factory/*__flow/flow.yaml")).map((file) =>
    file.replace(/__flow\/flow\.yaml$/, ""),
  );
  const schedules: RepoSchedule[] = [];
  for (const file of await scan(root, "f/factory/*.schedule.yaml")) {
    schedules.push(await readSchedule(root, file));
  }
  return {
    scripts,
    flows,
    schedules,
    historyFilter: await historyFilterOf(root, scripts, flows),
  };
}

function stringList(name: string, values: readonly string[]): string {
  const body = values.map((value) => `  ${JSON.stringify(value)},\n`).join("");
  return `export const ${name}: readonly string[] = [\n${body}];\n`;
}

function scheduleList(schedules: readonly RepoSchedule[]): string {
  const body = schedules
    .map(
      (item) =>
        `  {\n` +
        `    path: ${JSON.stringify(item.path)},\n` +
        `    script_path: ${JSON.stringify(item.script_path)},\n` +
        `    is_flow: ${String(item.is_flow)},\n` +
        `    schedule: ${JSON.stringify(item.schedule)},\n` +
        `    timezone: ${JSON.stringify(item.timezone)},\n` +
        `    enabled: ${String(item.enabled)},\n` +
        `    no_flow_overlap: ${String(item.no_flow_overlap)},\n` +
        `  },\n`,
    )
    .join("");
  return `export const REPO_SCHEDULES: readonly RepoSchedule[] = [\n${body}];\n`;
}

/** 定数のファイルの本文を作る。同じ入力には同じ文字列を返す。 */
export function renderKnownPaths(known: KnownPaths): string {
  return [
    "// 生成物。手で直さない。`bun run scripts/gen-console-known-paths.ts`で作り直す。\n" +
      "// リポジトリのscriptの定義、フロー、スケジュールから導いた定数で、Console用workerが照合に使う。\n" +
      "// Console用workerはリポジトリのファイルを読めないため、定義の代わりにこの定数を読む。\n",
    stringList("KNOWN_SCRIPT_PATHS", known.scripts),
    stringList("KNOWN_FLOW_PATHS", known.flows),
    "export type RepoSchedule = {\n" +
      "  readonly path: string;\n" +
      "  readonly script_path: string;\n" +
      "  readonly is_flow: boolean;\n" +
      "  readonly schedule: string;\n" +
      "  readonly timezone: string;\n" +
      "  readonly enabled: boolean;\n" +
      "  readonly no_flow_overlap: boolean;\n" +
      "};\n",
    scheduleList(known.schedules),
    stringList("HISTORY_FILTER_PATHS", known.historyFilter),
  ].join("\n");
}

if (import.meta.main) {
  const text = renderKnownPaths(await collectKnownPaths("."));
  await Bun.write(OUTPUT, text);
  console.log(`wrote ${OUTPUT}`);
}
