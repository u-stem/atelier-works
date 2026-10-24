// Claude CodeのPreToolUse(Bash)フック。マージと反映を、保留(hold)と凍結(freeze)が有効な間は止める。
// bunとnodeのどちらでも動く。
//
// 止めるのは次の操作である(見つけ方は`merge-targets.ts`)。
// - マージ(`gh pr merge`など): 対象のリポジトリのマージの保留が有効なとき。
//   対象が決まらないマージは、どのリポジトリの保留でも止める。
// - `wmill sync push`: deployの保留が有効なとき。スケジュールの凍結だけが有効なときも、除外を付けない手動のpushは止める。
// - `wmill datatable migrate up|down`: deployの保留が有効なとき。
//
// 対象に当たらないコマンドは、解析だけで許可する。DBも変数も読まず、読みの部品(`merge-read.ts`)も読み込まない。
// 対象に当たったときだけ、読みの部品を動的に読み込んで保留を読む。
// 読めないときは、すべて拒否する。表が無い、行が壊れている、`mise`や`docker`が無い、非ゼロで終わる、
// 例外、時間切れ、いずれも「保留なし」とは扱わない。クラウドのセッションは保留を読めないので、マージ系は拒否になる。
// 拒否の文言には、保留の`id`、検証した`target`、期限、`holder_kind`だけを載せる。
// `reason`と`holder`はDBに書ける主体が決める文字列なので、載せない。解除の手順も載せない。
//
// 主セッションとsubagentで判定は同じにし、文言だけ変える。
// ベストエフォートの規則で、境界ではない。人の端末の`!`、GitHubのMCP、Web UIでのマージは止められない。
// 使い方: scripts/claude-hooks/run.sh merge-guard(標準入力にフックの入力のJSONを渡す)

import type { HoldRow } from "../../f/factory/lib/holds.ts";
import {
  ALLOW,
  type BashToolInput,
  type Decision,
  deny,
  isEntryPoint,
  runHookMain,
} from "./hook-io.ts";
import type { FreezeReading, MergeHoldReading } from "./merge-read.ts";
import {
  findGuardedOperations,
  type GuardedOperation,
} from "./merge-targets.ts";

/** 保留と凍結を読む関数。対象に当たったときだけ読み込む。 */
export type GuardReaders = {
  readonly readMergeHolds: () => Promise<MergeHoldReading>;
  readonly readDeployFreezes: () => Promise<FreezeReading>;
};

/**
 * 読みの全体を待つ上限(ミリ秒)。読みの部品の上限(6秒)より少し長く、フックの上限(8秒)より短い。
 * 超えたら読めないものとして拒否する。
 */
export const GUARD_TIMEOUT_MS = 6500;

/** 拒否の文言に載せる保留の数の上限。 */
const LISTED_MAX = 5;

/** 文言に載せる文字列の長さの上限。 */
const REASON_MAX = 200;
const TARGET_MAX = 100;

/** 制御文字、書式文字、行と段落の区切り。表示の並びを偽装できる。 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** 保留の対象として載せてよい形(`owner/repo`)。 */
const SAFE_TARGET = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

type Readings = {
  readonly holds: MergeHoldReading | null;
  readonly freezes: FreezeReading | null;
};

function clean(text: string): string {
  return text.replace(UNSAFE_CHARS, " ").slice(0, REASON_MAX);
}

function describeError(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error));
}

function formatJst(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "an unknown time";
  const text = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(time));
  return `${text} JST`;
}

function displayTarget(target: string): string {
  if (!SAFE_TARGET.test(target)) return "<invalid target>";
  return target.length > TARGET_MAX
    ? `${target.slice(0, TARGET_MAX)}...`
    : target;
}

function describeHold(hold: HoldRow): string {
  return `merge hold ${String(hold.id)} (${displayTarget(hold.target)}, until ${formatJst(hold.expires_at)}, placed by ${hold.holder_kind})`;
}

function listHolds(holds: readonly HoldRow[]): string {
  const shown = holds.slice(0, LISTED_MAX).map(describeHold).join("; ");
  const more = holds.length - LISTED_MAX;
  return more > 0 ? `${shown}; and ${String(more)} more` : shown;
}

/** 読めなかった保留の文言。 */
function holdsUnreadable(
  failure: Extract<MergeHoldReading, { ok: false }>,
  subagent: boolean,
): string {
  if (subagent) {
    return "The merge holds could not be read, so the merge was stopped. Subagents do not merge. Report to the main session and finish.";
  }
  switch (failure.kind) {
    case "read_failed":
      return `The merge holds could not be read (${clean(failure.reason)}), so the merge was stopped. If the stack is not running, start it with mise run up and run the command again. If mise reports a missing tool, run mise install. If it still cannot be read here, ask a person to run the command with the ! prefix.`;
    case "missing_table":
      return "The holds table does not exist because its migration is not applied, so the merge was stopped. Check deployed_sha, and ask a person.";
    case "corrupt":
      return `A row of the holds table is malformed (${clean(failure.reason)}), so the merge was stopped. Check the holds with mise run hold:list, and ask a person.`;
  }
}

/** マージの保留の文言。止めないならnullを返す。 */
function mergeMessage(
  ops: readonly GuardedOperation[],
  reading: MergeHoldReading,
  subagent: boolean,
): string | null {
  if (!reading.ok) return holdsUnreadable(reading, subagent);
  const repos = ops.flatMap((op) => (op.kind === "merge" ? [op.repo] : []));
  const anyRepo = repos.includes(null);
  const held = reading.value.filter(
    (hold) => anyRepo || repos.includes(hold.target.toLowerCase()),
  );
  if (held.length === 0) return null;
  const stopped = `The merge was stopped by ${listHolds(held)}.`;
  return subagent
    ? `${stopped} Subagents do not merge. Report to the main session that a merge hold stopped the merge, and finish.`
    : `${stopped} See the holds with mise run hold:list, and ask a person before you merge.`;
}

/** 止めた反映の操作を、文に入れる名前にする。 */
function deployNames(ops: readonly GuardedOperation[]): string {
  const names: string[] = [];
  if (ops.some((op) => op.kind === "deploy" && op.via === "sync_push")) {
    names.push("wmill sync push");
  }
  if (ops.some((op) => op.kind === "deploy" && op.via === "migrate")) {
    names.push("wmill datatable migrate");
  }
  return names.join(" and ");
}

/** deployの保留とスケジュールの凍結の文言。止めないならnullを返す。 */
function deployMessage(
  ops: readonly GuardedOperation[],
  reading: FreezeReading,
  subagent: boolean,
): string | null {
  const names = deployNames(ops);
  if (!reading.ok) {
    return subagent
      ? `The freezes could not be read, so ${names} was stopped. Subagents do not deploy. Report to the main session and finish.`
      : `The freeze variable could not be read (${clean(reading.reason)}), so ${names} was stopped. Check it with mise run freeze:list. If the variable is corrupt, a person can run mise run freeze:reset.`;
  }
  if (reading.deploy.length > 0) {
    const list = reading.deploy
      .slice(0, LISTED_MAX)
      .map((entry) => `${entry.id} (until ${formatJst(entry.expires_at)})`)
      .join(", ");
    const stopped = `${names} was stopped by deploy freeze ${list}.`;
    return subagent
      ? `${stopped} Subagents do not deploy. Report to the main session and finish.`
      : `${stopped} Wait until it ends, or ask the person who placed it. See the freezes with mise run freeze:list.`;
  }
  const pushes = ops.some(
    (op) => op.kind === "deploy" && op.via === "sync_push",
  );
  if (!pushes || reading.schedule === 0) return null;
  return subagent
    ? "wmill sync push was stopped because a schedule freeze is active. Subagents do not deploy. Report to the main session and finish."
    : "wmill sync push was stopped because a schedule freeze is active and a plain push would overwrite the frozen schedule. Use mise run push, which leaves the frozen schedules out.";
}

/** 読みの失敗を、必要な読みの分だけ作る。 */
function failedReadings(
  reason: string,
  wantsHolds: boolean,
  wantsFreezes: boolean,
): Readings {
  return {
    holds: wantsHolds ? { ok: false, kind: "read_failed", reason } : null,
    freezes: wantsFreezes ? { ok: false, reason } : null,
  };
}

async function readAll(
  load: () => Promise<GuardReaders>,
  wantsHolds: boolean,
  wantsFreezes: boolean,
): Promise<Readings> {
  let readers: GuardReaders;
  try {
    readers = await load();
  } catch (error) {
    return failedReadings(describeError(error), wantsHolds, wantsFreezes);
  }
  const [holds, freezes] = await Promise.all([
    wantsHolds
      ? readers.readMergeHolds().catch(
          (error: unknown): MergeHoldReading => ({
            ok: false,
            kind: "read_failed",
            reason: describeError(error),
          }),
        )
      : null,
    wantsFreezes
      ? readers.readDeployFreezes().catch(
          (error: unknown): FreezeReading => ({
            ok: false,
            reason: describeError(error),
          }),
        )
      : null,
  ]);
  return { holds, freezes };
}

/** `work`が`limitMs`のうちに終わらなければ、`fallback`を返す。待ちの後にタイマーを残さない。 */
async function withinTime<T>(
  work: Promise<T>,
  limitMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), limitMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bashのコマンド行を判定する。マージか反映の操作が無ければ、何も読まずに許可する。
 * `load`は、対象に当たったときだけ呼ぶ。
 */
export async function evaluateMergeGuard(
  input: BashToolInput,
  load: () => Promise<GuardReaders>,
  timeoutMs: number = GUARD_TIMEOUT_MS,
): Promise<Decision> {
  const ops = findGuardedOperations(input.command);
  if (ops.length === 0) return ALLOW;
  const wantsHolds = ops.some((op) => op.kind === "merge");
  const wantsFreezes = ops.some((op) => op.kind === "deploy");
  const readings = await withinTime(
    readAll(load, wantsHolds, wantsFreezes),
    timeoutMs,
    failedReadings(
      `the read did not finish in ${String(timeoutMs)} ms`,
      wantsHolds,
      wantsFreezes,
    ),
  );
  const subagent = input.agentId !== null;
  const messages: string[] = [];
  if (readings.holds !== null) {
    const message = mergeMessage(ops, readings.holds, subagent);
    if (message !== null) messages.push(message);
  }
  if (readings.freezes !== null) {
    const message = deployMessage(ops, readings.freezes, subagent);
    if (message !== null) messages.push(message);
  }
  return messages.length === 0 ? ALLOW : deny(messages.join(" "));
}

/** 実際の読み手を読み込む。読みの部品は、この呼び出しで初めて読み込む。 */
async function loadReaders(): Promise<GuardReaders> {
  const read = await import("./merge-read.ts");
  const options = read.defaultReadOptions(import.meta.url, process.env);
  return {
    readMergeHolds: () => read.readMergeHolds(options),
    readDeployFreezes: () => read.readDeployFreezes(options),
  };
}

if (isEntryPoint(import.meta.url)) {
  await runHookMain((input) => evaluateMergeGuard(input, loadReaders), {
    exitWhenDone: true,
  });
}
