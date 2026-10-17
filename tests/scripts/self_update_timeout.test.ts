import { describe, expect, test } from "bun:test";
import { HOST_ACTION_RECONCILE_LIMIT } from "../../f/factory/lib/host_action.ts";
import { FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT } from "../../f/factory/lib/workspace.ts";
import {
  SELF_UPDATE_BOUNDED_CALL_COUNT,
  SELF_UPDATE_CLI_COMMAND_COUNT,
  SELF_UPDATE_FREEZE_PHASE_COUNT,
  SELF_UPDATE_GIT_COMMAND_COUNT,
  SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT,
  SELF_UPDATE_WORST_CASE_MS,
} from "../../f/factory/self_update.ts";

// ジョブの`timeout`は、全部が最悪のときの長さ以上にする。内側の上限より先に
// 外側で打ち切ると、子プロセスの実行中に当たって子が残りうる。
//
// 後半のテストは`self_update.ts`のソースの文字列照合である。構文は解析しないので、
// 呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。そのときは照合を直す。
// 目的は、区切りの無い呼び出しや、最悪の合計に数えていないコマンドの追加に気づくことである。

async function jobTimeoutMs(): Promise<number> {
  const yaml = await Bun.file("f/factory/self_update.script.yaml").text();
  const match = yaml.match(/^timeout: (\d+)$/m);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]) * 1000;
}

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

// `recordFailedDeployment(`の区切りが効くのは`record`だけで`onRecordError`には届かないので、`onRecordError`には外部呼び出しを足さない。
const WRAPPERS = [
  "withCallTimeout(",
  "readDeployedSha(",
  "setDeployedSha(",
  "recordSuccessDeployment(",
  "recordFailedDeployment(",
];
// `wmill.`のSDK呼び出しはすべて対象にする(`wmill.foo(`と`wmill.XxxService.foo(`)。
// 例外は`wmill.JobService.`で、Console用workerの確認(`watchConsoleWorker`)が
// 自前の上限(`CONSOLE_WORKER_CHECK_TIMEOUT_MS`)で区切る。
const UNBOUNDED_CALL =
  /\bwmill\.(?!JobService\.)[A-Za-z]+(?:\.[A-Za-z]+)*\(|\brecordDeployment\(|\baddNoticeUnlessUnresolved\(|\bnotifyBestEffort\(|\blistUnresolvedNoticesByKind\(|\bresolveNoticeIfUnresolved\(|\breadHostAppliedSha\(|\blistGhCollectFreshness\(|\bresolveUnresolvedNoticesByPrefix\(/g;
/** 区切りの呼び出しの開きから、その中の呼び出しまでの、最も長い距離。 */
const WRAPPER_REACH = 700;

describe("self_update timeout", () => {
  test("the job timeout covers the worst case", async () => {
    expect(await jobTimeoutMs()).toBeGreaterThanOrEqual(
      SELF_UPDATE_WORST_CASE_MS,
    );
  });

  test("every SDK, DB and notification call sits inside a bounded call", async () => {
    const source = await selfUpdateSource();
    const outside: string[] = [];
    for (const match of source.matchAll(UNBOUNDED_CALL)) {
      const at = match.index ?? 0;
      const before = source.slice(Math.max(0, at - WRAPPER_REACH), at);
      const opening = Math.max(...WRAPPERS.map((w) => before.lastIndexOf(w)));
      const between = opening < 0 ? ";" : before.slice(opening);
      if (opening < 0 || between.includes(";")) outside.push(match[0]);
    }

    expect(outside).toEqual([]);
  });

  test("the success record sits directly inside recordSuccessDeployment", async () => {
    const source = await selfUpdateSource();
    const openings: string[] = [];
    for (const match of source.matchAll(
      /\brecordDeployment\(\{[^}]*result: "success"/g,
    )) {
      const before = source.slice(0, match.index ?? 0);
      const opening = Math.max(...WRAPPERS.map((w) => before.lastIndexOf(w)));
      openings.push(
        WRAPPERS.find((w) => source.startsWith(w, opening)) ?? "none",
      );
    }

    expect(openings).toEqual(["recordSuccessDeployment("]);
  });

  test("the bounded call count matches the call sites", async () => {
    const source = await selfUpdateSource();
    const notify = count(source, /withCallTimeout\(\s*"notify"/g);
    // 通知の解決は、1か所の呼び出しが上限の数まで繰り返される。
    const resolveSites = count(
      source,
      /withCallTimeout\(\s*"resolve host action notice"/g,
    );
    // 凍結の段は、段ごとの1つの上限で包み、区切った呼び出しの数に数えない(最悪の長さに段の数を足す)。
    const freezePhases = count(source, /withCallTimeout\(\s*"freeze /g);
    const sites =
      count(source, /withCallTimeout\(/g) -
      notify -
      freezePhases +
      (HOST_ACTION_RECONCILE_LIMIT - 1) * resolveSites +
      2 * count(source, /readDeployedSha\(/g) +
      2 * count(source, /setDeployedSha\(/g) +
      count(source, /recordSuccessDeployment\(/g) +
      count(source, /recordFailedDeployment\(/g);

    expect(sites).toBe(SELF_UPDATE_BOUNDED_CALL_COUNT);
  });

  test("the CLI command count matches the call sites", async () => {
    const source = await selfUpdateSource();

    expect(count(source, /await runWmillCli\(/g)).toBe(
      SELF_UPDATE_CLI_COMMAND_COUNT,
    );
  });

  test("the git command count matches the call sites", async () => {
    const source = await selfUpdateSource();
    // 1か所あたりのgitの回数: cloneの更新は定数の回数、`mise.toml`の比較は最大2回、そのほかは1回。
    const cloneUpdate = count(source, /\brun: runCommand,/g);
    const miseCompare = count(
      source,
      /miseTomlHostSectionsChanged\(\s*runCommand,/g,
    );
    const single = count(
      source,
      /(readSelfCloneBranch|readSelfCloneHeadSha|resolveChangedPaths|listMergedPullRequests)\(\s*runCommand,/g,
    );
    // ホストの印の確認: コミットの有無は1回。祖先の確認と内容の比較は、
    // それぞれ通知の解決の上限の数と、この回の通知の判断の1回。
    const hostCommit = count(source, /isCommitInClone\(\s*runCommand,/g);
    const hostAncestor = count(source, /isAncestorSha\(\s*runCommand,/g);
    const hostContent = count(source, /listDifferingPaths\(\s*runCommand,/g);
    const passed = count(source, /\(\s*runCommand,/g);

    expect({
      passed,
      commands:
        FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT * cloneUpdate +
        2 * miseCompare +
        single,
      localCommands:
        hostCommit +
        (HOST_ACTION_RECONCILE_LIMIT + 1) * (hostAncestor + hostContent),
    }).toEqual({
      passed: miseCompare + single + hostCommit + hostAncestor + hostContent,
      commands: SELF_UPDATE_GIT_COMMAND_COUNT,
      localCommands: SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT,
    });
  });

  test("runCommand is called directly only from runWmillCli", async () => {
    const source = await selfUpdateSource();

    expect(count(source, /\brunCommand\(/g)).toBe(1);
  });

  test("the freeze phase count matches the call sites", async () => {
    const source = await selfUpdateSource();

    expect(count(source, /withCallTimeout\(\s*"freeze /g)).toBe(
      SELF_UPDATE_FREEZE_PHASE_COUNT,
    );
  });
});
