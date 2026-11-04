// 保護パスに触れた変更の反映を、人の承認まで止める判定。
//
// `self_update`が、反映する範囲(`deployed_sha..HEAD`)の変更と、承認の表の読み書きと、通知を注入して呼ぶ。
// 判定はこのファイルにあり、読み込むのは保護パスの一覧(`protected_paths.ts`)と承認の表の部品(`deploy_approvals.ts`)だけにする。
// どちらも保護パスで、保護の外のモジュールを書き換えて判定を緩められないようにするためである。
// 通知の形とログの形は、`lib/discord.ts`と`lib/log.ts`を読み込まずに、ここで構造として持つ。
// importの連鎖がすべて保護パスに入っていることは、`tests/lib/protected_paths.test.ts`が確かめる。

import {
  DEPLOY_APPROVAL_NOTICE_KIND,
  type DeployApproval,
  deployApprovalNoticePrefix,
} from "./deploy_approvals.ts";
import {
  type ChangedPath,
  type ChangedPathStatus,
  isNewShellScript,
  matchesImplementProtectedPath,
} from "./protected_paths.ts";

/** `--name-status`の1文字の状態。改名と複製は`--no-renames`で出ないので持たない。 */
const NAME_STATUS: ReadonlyMap<string, ChangedPathStatus> = new Map([
  ["A", "added"],
  ["M", "modified"],
  ["D", "deleted"],
  ["T", "typechange"],
]);

/**
 * `git diff --name-status --no-renames -z`の出力を、変更の一覧にする。
 * 出力は「状態、NUL、パス、NUL」の繰り返しである。
 * 欄の数が奇数か、パスが空か、状態が`A`、`M`、`D`、`T`のどれでもないなら、読み違いを避けるため例外を投げる。
 * `--no-renames`を付け忘れると、改名の行は状態の後にパスが2つ続き、組がずれて保護パスへの改名を見落とすためである。
 */
export function parseNameStatus(output: string): ChangedPath[] {
  if (output === "") return [];
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new Error(
      "deploy gate: git diff --name-status output has an odd number of fields",
    );
  }
  const entries: ChangedPath[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const letter = fields[index] ?? "";
    const path = fields[index + 1] ?? "";
    if (path === "") {
      throw new Error(
        "deploy gate: git diff --name-status output has an empty path",
      );
    }
    const status = NAME_STATUS.get(letter);
    if (status === undefined) {
      throw new Error(
        `deploy gate: git diff --name-status output has an unexpected status: ${JSON.stringify(letter)}`,
      );
    }
    entries.push({ path, status });
  }
  return entries;
}

/** migrationのディレクトリ。`self_update`が自動で適用し、壊す操作も書けるので、保護パスかどうかによらず止める。 */
const MIGRATIONS_PREFIX = "migrations/";

/**
 * `self_update`が本番へ反映するファイルか。`f/`か`migrations/`の下、または`wmill.yaml`で、
 * `wmill-lock.yaml`と`*.script.lock`を除く。lockは依存の版を上げるたびに書き換わり、保護もしていないためである。
 * `infra/`は人の`mise run up`が関門で、`.github/`はCIにしか効かず、`.claude/`と`scripts/`とlockfileと設定は反映の外なので、判定しない。
 */
export function isDeployScopedPath(path: string): boolean {
  if (path === "wmill-lock.yaml" || path.endsWith(".script.lock")) return false;
  return (
    path === "wmill.yaml" ||
    path.startsWith("f/") ||
    path.startsWith(MIGRATIONS_PREFIX)
  );
}

/**
 * 変更が反映を止めるかを返す。反映するファイル(`isDeployScopedPath`)のうち、次のどれかに当たるものである。
 * - `migrations/`の下のファイル(保護パスかどうかによらない)。
 * - implementフローと同じ`matchesImplementProtectedPath`に当たるファイル。
 * - 新しい`*.sh`(`isNewShellScript`)。
 * 範囲の絞り込みを先に当てるので、範囲の外の保護パス(`infra/`、`.github/`、`.claude/`、`scripts/`、lockfile)は止めない。削除も変更に数える。
 */
export function isGatedChange(entry: ChangedPath): boolean {
  if (!isDeployScopedPath(entry.path)) return false;
  return (
    entry.path.startsWith(MIGRATIONS_PREFIX) ||
    matchesImplementProtectedPath(entry.path) ||
    isNewShellScript(entry)
  );
}

/** 変更のうち、反映を止めるもの(`isGatedChange`)のパスを、重ねずに出てきた順で返す。 */
export function selectProtectedChanges(
  entries: readonly ChangedPath[],
): string[] {
  const selected = entries.filter(isGatedChange).map((entry) => entry.path);
  return [...new Set(selected)];
}

export type ProtectedDeployVerdict =
  | { readonly kind: "proceed" }
  | {
      readonly kind: "hold";
      readonly reason: "protected_paths_approval";
      /** 依頼の行を作るか。行が無いときだけ作る。 */
      readonly request: boolean;
    };

/**
 * 保護パスの変更と、版の依頼の行から、反映を続けるか止めるかを決める。
 * 保護パスの変更が無ければ続ける。行が承認なら続ける。行が無ければ止めて依頼を作る。
 * 判断が無いか却下なら、依頼を重ねずに止める。止めた状態は期限で解けない。
 */
export function decideProtectedDeploy(input: {
  readonly protectedPaths: readonly string[];
  readonly approval: DeployApproval | null;
}): ProtectedDeployVerdict {
  if (input.protectedPaths.length === 0) return { kind: "proceed" };
  if (input.approval === null) {
    return { kind: "hold", reason: "protected_paths_approval", request: true };
  }
  if (input.approval.decision === "approved") return { kind: "proceed" };
  return { kind: "hold", reason: "protected_paths_approval", request: false };
}

/** 承認を待つ通知の次の操作。却下したときの戻し方まで書く。 */
export const DEPLOY_APPROVAL_NEXT_ACTION =
  "Consoleのシステムの画面の「反映の承認待ち」で、版と保護パスの変更を確かめて承認する。却下したときは、mainへ戻すPRを作ってマージする";

export type DeployApprovalNotice = {
  readonly notice: { readonly kind: string; readonly message: string };
  /** Discordの説明にも使う、起きたことの文。 */
  readonly cause: string;
  readonly next_action: string;
};

/**
 * 承認を待つ通知を作る。本文は版と件数で決まり、パスは載せない(パスはConsoleの承認待ちに出す)。
 * 同じ版の未解決の通知を、`addNoticeUnlessUnresolved`が重ねて記録しないためである。
 * 本文は`deployApprovalNoticePrefix(sha)`で始め、版ごとの解決が前方一致で当たるようにする。
 */
export function buildDeployApprovalNotice(
  sha: string,
  pathCount: number,
): DeployApprovalNotice {
  const cause = `${deployApprovalNoticePrefix(sha)}前回の反映からの変更に、反映を止めるファイル(保護パスかmigration)が${String(pathCount)}件あります。人が承認するまで反映しません`;
  return {
    notice: {
      kind: DEPLOY_APPROVAL_NOTICE_KIND,
      message: `${cause}。次の操作: ${DEPLOY_APPROVAL_NEXT_ACTION}`,
    },
    cause,
    next_action: DEPLOY_APPROVAL_NEXT_ACTION,
  };
}

/** Discordへ送る通知。`lib/discord.ts`の`NotifyEvent`の同じ種類と同じ形にする。 */
export type DeployApprovalEvent = {
  readonly kind: "deploy_approval_required";
  readonly instance_name: string;
  readonly cause: string;
  readonly next_action: string;
  /** Consoleでこのnoticeを選んだ要対応のURL。 */
  readonly url: string;
};

type GateLog = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
};

export type DeployGateDeps = {
  /** 反映する範囲の変更。読めなければ例外を投げる(反映しない)。 */
  readonly listChanges: () => Promise<readonly ChangedPath[]>;
  /** 版の依頼の行。無ければ`null`。読めなければ例外を投げる。 */
  readonly findApproval: (sha: string) => Promise<DeployApproval | null>;
  /** 依頼の行を作り、作ったら`true`、既にあれば`false`を返す。書けなければ例外を投げる。 */
  readonly requestApproval: (
    sha: string,
    paths: readonly string[],
  ) => Promise<boolean>;
  /** 古い版の承認を待つ通知を、まとめて解決する。 */
  readonly supersedeNotices: () => Promise<unknown>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: {
    readonly kind: string;
    readonly message: string;
  }) => Promise<number | null>;
  readonly notify: (event: DeployApprovalEvent) => Promise<unknown>;
  readonly noticeUrl: (noticeId: number) => string;
  readonly instanceName: string;
  readonly log: GateLog;
};

export type DeployGateResult = {
  readonly kind: "proceed" | "hold";
  readonly protectedPaths: readonly string[];
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 止めた回の要対応の通知を残す。新しく残したときだけDiscordに送る。
 * 同じ版の未解決の通知があれば、`addNotice`が重ねない。
 * 古い版の通知の解決(`supersede`)は、依頼の行を作った回だけに行う。
 * 解決は版を区別せずに前方一致で当たるので、続く回で行うと、同じ版の通知を毎回解決して作り直し、Discordに送り続けるためである。
 * どれが失敗しても、反映は止めたままにする(警告のログだけ残す)。
 */
async function raiseNotice(
  sha: string,
  pathCount: number,
  supersede: boolean,
  deps: DeployGateDeps,
): Promise<void> {
  if (supersede) {
    try {
      await deps.supersedeNotices();
    } catch (err) {
      deps.log.warn("older deploy approval notices could not be resolved", {
        error: errorText(err),
      });
    }
  }
  const built = buildDeployApprovalNotice(sha, pathCount);
  let noticeId: number | null;
  try {
    noticeId = await deps.addNotice(built.notice);
  } catch (err) {
    deps.log.warn("deploy approval notice could not be recorded", {
      sha,
      error: errorText(err),
    });
    return;
  }
  if (noticeId === null) return;
  try {
    await deps.notify({
      kind: "deploy_approval_required",
      instance_name: deps.instanceName,
      cause: built.cause,
      next_action: built.next_action,
      url: deps.noticeUrl(noticeId),
    });
  } catch (err) {
    deps.log.warn("deploy approval notification failed", {
      sha,
      error: errorText(err),
    });
  }
}

/**
 * 版`sha`への反映を続けるか止めるかを決め、止めるときは、依頼が無ければ作り、要対応の通知を残す。
 * 通知は止めるたびに残す。依頼を作った回に書き込みが失敗しても、次の回が残すためである。
 * 変更の一覧、依頼の読み取り、依頼の作成が失敗したら例外を投げる(判定できない回は反映しない)。
 * 通知の失敗は例外にしない。
 */
export async function runDeployApprovalGate(
  sha: string,
  deps: DeployGateDeps,
): Promise<DeployGateResult> {
  const protectedPaths = selectProtectedChanges(await deps.listChanges());
  if (protectedPaths.length === 0) return { kind: "proceed", protectedPaths };
  const approval = await deps.findApproval(sha);
  const verdict = decideProtectedDeploy({ protectedPaths, approval });
  if (verdict.kind === "proceed") {
    deps.log.info("protected path changes were approved, deploying", {
      sha,
      protected_path_count: protectedPaths.length,
    });
    return { kind: "proceed", protectedPaths };
  }
  const created =
    verdict.request && (await deps.requestApproval(sha, protectedPaths));
  await raiseNotice(sha, protectedPaths.length, created, deps);
  deps.log.info(
    "protected path changes need an approval, deferring the deployment",
    {
      sha,
      decision: approval?.decision ?? null,
      protected_path_count: protectedPaths.length,
    },
  );
  return { kind: "hold", protectedPaths };
}
