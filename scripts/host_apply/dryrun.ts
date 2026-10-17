/** `docker compose up --dry-run`の呼び出しの引数と、出力の解析。 */

import { join } from "node:path";

/**
 * 作り直しの集合とずれの検出から外すサービス。
 * `factory_state_init`はワンショットで、終了済みのコンテナがdry-runで作り直しに見える。
 * `caddy`は相対パスのbind mountを持ち、チェックアウトのパスが違うだけで作り直しに見える。
 */
export const DRYRUN_EXCLUDED_SERVICES: readonly string[] = [
  "factory_state_init",
  "caddy",
];

const PROJECT_NAME = "infra";

/**
 * composeを呼ぶときの共通の引数(`docker`の後ろ)。
 * プロジェクト名とプロジェクトのディレクトリを、常に明示する。
 * 呼び出し元のディレクトリや環境でプロジェクトが変わり、別のスタックを作るのを防ぐため。
 */
export function composeBaseArgs(input: {
  readonly stagingInfraDir: string;
}): string[] {
  return [
    "compose",
    "-p",
    PROJECT_NAME,
    "--project-directory",
    input.stagingInfraDir,
    "-f",
    join(input.stagingInfraDir, "docker-compose.yml"),
  ];
}

/**
 * 作り直しが要るかを調べるdry-runの引数。
 * `--pull never`が無いと、`pull_policy: always`のサービスが毎回作り直しに見える。
 * `--no-deps`が無いと、依存するサービスも一緒に出る。`--no-build`はbuildを走らせないため。
 */
export function dryRunArgs(
  input: { readonly stagingInfraDir: string },
  service: string,
): string[] {
  return [
    ...composeBaseArgs(input),
    "up",
    "-d",
    "--no-deps",
    "--no-build",
    "--pull",
    "never",
    "--dry-run",
    service,
  ];
}

export type DryRunParse =
  | { readonly kind: "running" }
  | { readonly kind: "recreate"; readonly states: readonly string[] }
  | { readonly kind: "failed"; readonly reason: string };

const LINE = /^\s*(\S+)\s+(\S+)\s+(\S+)\s*$/;
const RESOURCE_KINDS: readonly string[] = [
  "Container",
  "Network",
  "Volume",
  "Image",
];

/**
 * 1つのサービスのdry-runの出力を読む。
 * 各行は「資源の種類、名前、状態」の3列で、`Container <プロジェクト>-<サービス>-<番号>`の行だけを見る。
 * そのサービスのコンテナの状態がすべて`Running`なら収束済み、それ以外(`Recreate`、`Creating`、`Starting`など)なら作り直しが要る。
 * 読めない行がある、またはサービスのコンテナの行が無い出力は`failed`にする。
 */
export function parseDryRun(
  output: string,
  service: string,
  project: string = PROJECT_NAME,
): DryRunParse {
  const containerName = new RegExp(
    `^${escapeRegExp(project)}-${escapeRegExp(service)}-\\d+$`,
  );
  const states: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const match = LINE.exec(line);
    if (match === null) return { kind: "failed", reason: "unreadable line" };
    const [, kind, name, state] = match;
    if (kind === undefined || name === undefined || state === undefined) {
      return { kind: "failed", reason: "unreadable line" };
    }
    if (!RESOURCE_KINDS.includes(kind)) {
      return { kind: "failed", reason: "unknown resource kind" };
    }
    if (kind === "Container" && containerName.test(name)) states.push(state);
  }
  if (states.length === 0) {
    return { kind: "failed", reason: "no container line for the service" };
  }
  if (states.every((state) => state === "Running")) return { kind: "running" };
  return { kind: "recreate", states };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type DryRunClassification = {
  readonly recreate: readonly string[];
  readonly failed: readonly string[];
};

/**
 * サービスごとのdry-runの出力から、作り直しが要るサービスと、読めなかったサービスを分ける。
 * 除外するサービスは、どちらにも入れない。
 */
export function classifyDryRuns(
  outputs: Readonly<Record<string, string>>,
): DryRunClassification {
  const recreate: string[] = [];
  const failed: string[] = [];
  for (const [service, output] of Object.entries(outputs)) {
    if (DRYRUN_EXCLUDED_SERVICES.includes(service)) continue;
    const parsed = parseDryRun(output, service);
    if (parsed.kind === "recreate") recreate.push(service);
    else if (parsed.kind === "failed") failed.push(service);
  }
  return { recreate, failed };
}
