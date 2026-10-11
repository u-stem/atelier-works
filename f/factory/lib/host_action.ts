// ホスト側の作業が要る反映(`infra/`や`mise.toml`の`[tools]`・`[env]`の変更)を、
// 要対応の通知(notice)とDiscordで知らせ、ホストで反映が済んだら通知を解決する。
//
// 自己更新はworkerの中でしか動かないので、これらの変更を自分では反映できない。
// 人が`mise run up`を実行するまで古い構成で動き続けるため、気づく手段として通知を出す。
// 古いイメージのまま検査コマンドを実行できなかったことも、同じ種類の通知で知らせる(`buildCheckImageStaleNotice`)。
// 稼働中のworkerが検査の前提を満たさなくなったことは、別の種類の通知で知らせる(`buildCheckRuntimeUnsafeNotice`)。
//
// 反映が済んだ印は、`mise run up`が終わりに共有ボリューム(`factory_state`)へ書く
// ホストのcheckoutのHEAD(`HOST_APPLIED_SHA_PATH`)である。
// 通知が名指しする版がこのHEADと同じか、その祖先なら、ホストはその変更を含む版で
// 起動し直したことになるので、通知を解決する。
// 祖先でなくても、ホスト側の作業が要るパスの内容がすべてHEADと同じなら、反映済みとして扱う。
// PRのブランチで先に`mise run up`してからマージすると、マージの版はHEADの祖先にならないためである。
// 印が無いとき、読めないとき、self cloneに無い版のときは、解決しない。
// 祖先かどうかを確かめられないときは、内容を比べずに解決しない。祖先でなく、内容を比べられないときも解決しない。
// 解決できなかった通知は、人がConsoleで解決してよい。
// 印は、workerのジョブも書ける場所にある。偽の印で黙らせられるのは、この通知だけである。

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  type CheckEnvironmentError,
  CheckImageStaleError,
  CheckRuntimeUnsafeError,
} from "./check_sandbox.ts";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import { classifyChangedPaths } from "./self_update_support.ts";
import type { NoticeRecord } from "./types.ts";

/** ホスト側の作業が要ることを示すnoticeの種類。 */
export const HOST_ACTION_NOTICE_KIND = "host_action_required";

/** `mise run up`が、反映したホストのcheckoutのHEADを書くファイル。 */
export const HOST_APPLIED_SHA_PATH = "/var/lib/factory/host_applied_sha";

/** 自動で解決したnoticeの`resolved_by`。 */
export const HOST_ACTION_RESOLVER = "self_update";

/**
 * 1回の実行で調べる未解決の通知の数の上限。古いものから調べる。
 * 通知ごとにgitを最大2回(祖先の確認と内容の比較)呼ぶので、数を固定して最悪の長さを抑える。
 * 古い通知はホストの反映に含まれやすく、解決されれば次の回で残りに進む。
 * 未解決の通知は、ふだん0〜1件である。
 * 本文から版を読めない通知は数えず、版を読めた通知の先頭から数える。
 */
export const HOST_ACTION_RECONCILE_LIMIT = 3;

/** 印のファイルの大きさの上限(バイト)。40桁の版と改行より十分に大きい。 */
const MAX_APPLIED_FILE_BYTES = 128;

/** 印のファイルから読むバイト数。 */
const READ_APPLIED_BYTES = 64;

/** 本文に並べるパスの数の上限。残りは件数で示す。 */
const MAX_LISTED_PATHS = 10;

const NEXT_ACTION =
  "ホストのcheckoutでgit pullし、mise installとmise run upを実行する。実行が済むと、自己更新(10分ごと)がこの通知を自動で解決する";

const SHA_IN_MESSAGE = /反映した版: ([0-9a-f]{40})/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** 制御文字(C0、DEL、C1)、書式文字(双方向制御など)、行と段落の区切りを表すUnicodeの分類。 */
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Markdownの書式を作る文字。バックスラッシュ自身も含める。
 * 含めないと、パスの`\`が直後に足す`\`を打ち消し、`[]()`が有効なリンクとして残る。
 * `_`と`#`は含めない。リンクも強調も作れず、`console_fetcher`などのパスの読みやすさを保つため。
 */
const MARKDOWN_CHARS = /[\\[\]()*~|`<>]/g;

export type HostActionNotice = {
  readonly notice: NoticeRecord;
  /** Discordの説明にも使う、起きたことの文。 */
  readonly cause: string;
  /** 運用者がまず行う操作の1文。 */
  readonly next_action: string;
};

/**
 * gitで管理するファイル名は、改行や双方向制御などの文字を含められる。
 * 本文とDiscordの表示を崩さないよう、見えない文字を`?`にする。
 * Markdownの書式文字は、Discordのマスクリンクなどにならないよう、`\\`でエスケープする。
 * バックスラッシュ自身を先に(同じ置換の中で)エスケープする。
 */
function printablePath(path: string): string {
  return path.replace(INVISIBLE_CHARS, "?").replace(MARKDOWN_CHARS, "\\$&");
}

/**
 * 反映した版`shaTo`と、ホスト側の作業が要る変更のパス`hostPaths`から、通知の内容を作る。
 * 本文は、版とパスが同じなら同じ文になる。同じ本文の未解決の通知を
 * `addNoticeUnlessUnresolved`が重ねて記録しないためである。
 * 版は40桁のまま本文に含める。解決の判定が、本文から版を読み戻すため。
 */
export function buildHostActionNotice(
  shaTo: string,
  hostPaths: readonly string[],
): HostActionNotice {
  const listed = hostPaths
    .slice(0, MAX_LISTED_PATHS)
    .map(printablePath)
    .join(", ");
  const rest = hostPaths.length - MAX_LISTED_PATHS;
  const paths = rest > 0 ? `${listed} ほか${String(rest)}件` : listed;
  const cause = `反映した版: ${shaTo}。ホスト側の作業が要る変更(${paths})を含みます。workerの中からは反映できないため、ホストで作業するまで、新しい構成は動きません`;
  return {
    notice: {
      kind: HOST_ACTION_NOTICE_KIND,
      message: `${cause}。次の操作: ${NEXT_ACTION}`,
    },
    cause,
    next_action: NEXT_ACTION,
  };
}

/**
 * イメージが古いことを知らせるnoticeの本文に含める句。
 * 自動の再開(`auto_retry.ts`)が、解決されたnoticeのうち、反映の通知と見分けるために読む。
 */
export const STALE_IMAGE_NOTICE_MARKER = "workerのイメージが古く";

const STALE_IMAGE_NEXT_ACTION_UNRESOLVABLE =
  "ホストのcheckoutでgit pullし、mise installとmise run upを実行する。実行が済んだら、この通知を解決する";

/**
 * workerのイメージが古く、検査コマンドを枠のユーザーで実行できないことを知らせるnoticeを作る。
 * `f/`の変更がイメージの作り直しより先に反映されたときに、検証のステップが残す。
 * `deployedSha`は自己更新が反映した版で、40桁なら本文に含める。ホストがその版以降で`mise run up`すると、自己更新が自動で解決する。
 * `infra/`と`mise.toml`の内容がその版と同じ版で`mise run up`したときも解決する。イメージはこれらから作るためである。
 * 版が分からなければ含めず、人が解決する。
 * 本文は、版と`detail`が同じなら同じ文になる。`addNoticeUnlessUnresolved`が重ねて記録しないためである。
 */
export function buildCheckImageStaleNotice(
  deployedSha: string | null,
  detail: string,
): NoticeRecord {
  const version = deployedSha === null ? "" : `反映した版: ${deployedSha}。`;
  const nextAction =
    deployedSha === null ? STALE_IMAGE_NEXT_ACTION_UNRESOLVABLE : NEXT_ACTION;
  return {
    kind: HOST_ACTION_NOTICE_KIND,
    message: `${version}${STALE_IMAGE_NOTICE_MARKER}、検査コマンドを非特権のユーザーで実行できません(${printablePath(detail)})。イメージを作り直すまで、検査コマンドのある実装とPR修正は人の対応待ちで止まります。次の操作: ${nextAction}`,
  };
}

/** 稼働中のworkerが検査の前提を満たさないことを示すnoticeの種類。 */
export const CHECK_RUNTIME_NOTICE_KIND = "check_runtime_unsafe";

const RUNTIME_NEXT_ACTION =
  "本文のパスを、ホストのcheckoutからmise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker chmod o-w <パス>で閉じるか、mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_workerでworkerを作り直す。/workspacesと/var/lib/factoryは、ボリュームのマウントポイントで、作り直しでは閉じないので、chmodで閉じる。直したら、止まった作業項目を再実行し、この通知を解決する";

/**
 * 稼働中のworkerに誰でも書き込めるパスができたか、それを確かめられず、検査コマンドを枠のユーザーで実行できないことを知らせるnoticeを作る。
 * イメージの問題ではないので、`mise run up`を求めず、自己更新が自動で解決する版も載せない。人が直して解決する。
 * 本文は、`detail`が同じなら同じ文になる。`addNoticeUnlessUnresolved`が重ねて記録しないためである。
 */
export function buildCheckRuntimeUnsafeNotice(detail: string): NoticeRecord {
  return {
    kind: CHECK_RUNTIME_NOTICE_KIND,
    message: `workerの稼働中に、検査コマンドを非特権のユーザーで安全に実行できない状態になりました(${printablePath(detail)})。直すまで、検査コマンドのある実装とPR修正は止まります。次の操作: ${RUNTIME_NEXT_ACTION}`,
  };
}

export type CheckEnvironmentNoticeDeps = {
  /** 自己更新が反映した版(`f/factory/deployed_sha`)。読めなければ例外を投げる。 */
  readonly readDeployedSha: () => Promise<string>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly log: Logger;
};

/**
 * 検査の前提を満たさないことをnoticeに残す。
 * イメージの問題(`CheckImageStaleError`)は`buildCheckImageStaleNotice`で残す。版が読めないか40桁でなければ、版を含めずに残す。
 * イメージの問題と一緒に稼働中のworkerの点が見つかっていれば、その点は`buildCheckRuntimeUnsafeNotice`でも残す。
 * イメージの通知は`mise run up`の後に自己更新が解決するが、ボリュームのマウントポイントは作り直しでは閉じず、
 * 人が閉じて止まった作業項目を再実行するまで、通知を残すためである。
 * 稼働中のworkerの問題(`CheckRuntimeUnsafeError`)は`buildCheckRuntimeUnsafeNotice`で残す。
 * 呼び出し側は、続けて作業項目を止めるので、記録に失敗しても例外を投げず、警告ログに残す。
 */
export async function recordCheckEnvironmentNotice(
  deps: CheckEnvironmentNoticeDeps,
  error: CheckEnvironmentError,
): Promise<void> {
  if (error instanceof CheckRuntimeUnsafeError) {
    await addNoticeOrWarn(
      deps,
      buildCheckRuntimeUnsafeNotice(error.problems.join(", ")),
    );
    return;
  }
  const imageProblems =
    error instanceof CheckImageStaleError
      ? error.imageProblems
      : error.problems;
  const runtimeProblems =
    error instanceof CheckImageStaleError ? error.runtimeProblems : [];
  await recordStaleImageNotice(deps, imageProblems.join(", "));
  if (runtimeProblems.length > 0) {
    await addNoticeOrWarn(
      deps,
      buildCheckRuntimeUnsafeNotice(runtimeProblems.join(", ")),
    );
  }
}

async function recordStaleImageNotice(
  deps: CheckEnvironmentNoticeDeps,
  detail: string,
): Promise<void> {
  let deployedSha: string | null = null;
  try {
    const raw = (await deps.readDeployedSha()).trim();
    deployedSha = FULL_SHA.test(raw) ? raw : null;
  } catch (err) {
    deps.log.warn("deployed sha could not be read for the stale image notice", {
      error: errorMessage(err),
    });
  }
  await addNoticeOrWarn(deps, buildCheckImageStaleNotice(deployedSha, detail));
}

async function addNoticeOrWarn(
  deps: CheckEnvironmentNoticeDeps,
  notice: NoticeRecord,
): Promise<void> {
  try {
    await deps.addNotice(notice);
  } catch (err) {
    deps.log.warn("check environment notice could not be recorded", {
      kind: notice.kind,
      error: errorMessage(err),
    });
  }
}

/** 通知の本文から、反映した版を読み戻す。読めなければ`null`を返す。 */
export function extractNoticeSha(message: string): string | null {
  return SHA_IN_MESSAGE.exec(message)?.[1] ?? null;
}

/**
 * ホストが書いた印を読む。通常のファイル(symlinkでない)で、大きさが上限以下のときだけ読み、
 * 先頭の一部だけを返す。それ以外は例外を投げる。
 * 読み出し先がsymlinkやFIFOに差し替えられていても、追跡や待機をしないためである。
 * 開くときも`O_NOFOLLOW`と`O_NONBLOCK`を付け、調べてから開くまでの差し替えに備える。
 */
export async function readHostAppliedSha(
  path: string = HOST_APPLIED_SHA_PATH,
): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.size > MAX_APPLIED_FILE_BYTES) {
    throw new Error("host applied sha file is not a small regular file");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_APPLIED_FILE_BYTES) {
      throw new Error("host applied sha file is not a small regular file");
    }
    const buffer = Buffer.alloc(READ_APPLIED_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, READ_APPLIED_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

export type AppliedCheckDeps = {
  /** ホストが書いた印を返す。無いか読めなければ例外を投げる。 */
  readonly readAppliedSha: () => Promise<string>;
  /** `sha`のコミットがself cloneにあるかを返す。確かめられなければ例外を投げる。 */
  readonly commitExists: (sha: string) => Promise<boolean>;
  /** `ancestor`が`descendant`の祖先(同じ版を含む)かを返す。確かめられなければ例外を投げる。 */
  readonly isAncestor: (
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
  /**
   * `from`と`to`の間で内容が異なるパス(追加、削除、変更)をすべて返す。
   * 確かめられないとき、異なるパスが多すぎて全部を読めないときは、例外を投げる。
   */
  readonly differingPaths: (
    from: string,
    to: string,
  ) => Promise<readonly string[]>;
  readonly log: Logger;
};

/**
 * 版がホストの反映済みの版に含まれるかの判定の結果。
 * `included`は反映済みの版と同じか、その祖先であること、`same_content`は祖先ではないが、
 * ホスト側の作業が要るパスの内容が反映済みの版と同じことを表す。
 */
export type HostAppliedMatch = "included" | "same_content" | "not_applied";

/** 版`sha`がホストの反映済みの版に含まれるかを返す。 */
export type HostAppliedCheck = (sha: string) => Promise<HostAppliedMatch>;

/**
 * `hostAppliedChecker`が返す関数を作る。例外は投げず、確かめられなければ`not_applied`にする。
 * 先に祖先かどうかを確かめ、祖先でないときだけ内容を比べる。
 * 内容は、2つの版で内容が異なるパスを`classifyChangedPaths`で分類し直し、ホスト側の作業が要るものが無ければ同じとする。
 * 比べるのは、ある回の変更のパスだけでなく、ホスト側の作業が要るパスのすべてである。
 * 並行するPRを両方とも先に`mise run up`してからマージすると、1つの回の変更のパスだけでは、
 * もう一方のPRが変えたパスの違いを見落とすためである。
 * `mise.toml`は節を読まずにファイル全体で比べる。節を読むとgitの回数が増えるためで、節の外だけが違っても反映済みとしない。
 * 印は最初の呼び出しで1回だけ読み、self cloneにあるかも1回だけ確かめる。
 * 印が読めない、版として読めない、self cloneに無いときは、以降のどの`sha`も含まれないとして扱う。
 * 印が無いだけのとき(ホストが一度も書いていない)は、警告を出さない。
 */
export function hostAppliedChecker(deps: AppliedCheckDeps): HostAppliedCheck {
  let loaded: Promise<string | null> | undefined;
  const load = async (): Promise<string | null> => {
    let raw: string;
    try {
      raw = await deps.readAppliedSha();
    } catch (err) {
      if (!isMissingFile(err)) {
        deps.log.warn("host applied sha could not be read", {
          path: HOST_APPLIED_SHA_PATH,
          error: errorMessage(err),
        });
      }
      return null;
    }
    const applied = raw.trim();
    if (!FULL_SHA.test(applied)) {
      deps.log.warn("host applied sha is not a git sha", {
        path: HOST_APPLIED_SHA_PATH,
      });
      return null;
    }
    try {
      if (!(await deps.commitExists(applied))) {
        deps.log.warn("host applied sha is not in the self clone", {
          applied_sha: applied,
        });
        return null;
      }
    } catch (err) {
      deps.log.warn("host applied sha could not be looked up", {
        applied_sha: applied,
        error: errorMessage(err),
      });
      return null;
    }
    return applied;
  };
  return async (sha) => {
    loaded ??= load();
    const applied = await loaded;
    if (applied === null) return "not_applied";
    if (applied === sha) return "included";
    try {
      if (await deps.isAncestor(sha, applied)) return "included";
    } catch (err) {
      deps.log.warn("host applied ancestry could not be checked", {
        sha,
        applied_sha: applied,
        error: errorMessage(err),
      });
      return "not_applied";
    }
    return (await hasSameHostContent(deps, applied, sha))
      ? "same_content"
      : "not_applied";
  };
}

async function hasSameHostContent(
  deps: AppliedCheckDeps,
  applied: string,
  sha: string,
): Promise<boolean> {
  let differing: readonly string[];
  try {
    differing = await deps.differingPaths(applied, sha);
  } catch (err) {
    deps.log.warn("host applied content could not be compared", {
      sha,
      applied_sha: applied,
      error: errorMessage(err),
    });
    return false;
  }
  return classifyChangedPaths(differing, true).host_paths.length === 0;
}

export type HostActionDeps = {
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  /** 版がホストの反映済みの版に含まれるか(`hostAppliedChecker`)。 */
  readonly isApplied: HostAppliedCheck;
  readonly instanceName: string;
  readonly log: Logger;
};

export type HostActionRecordResult =
  | "recorded"
  | "already_open"
  | "already_applied"
  | "failed";

/**
 * ホスト側の作業が要る反映を、noticeに残し、新しく残したときだけDiscordに送る。
 * 先に印を確かめ、ホストがその版か、ホスト側の作業が要るパスの内容がすべて同じ版を既に反映していれば、通知もDiscordも出さない。
 * 比べるパスは`hostPaths`に限らない。未解決の通知の解決と同じ判定にし、記録と解決で食い違わないためである。
 * 運用者が先に`mise run deploy`やPRのブランチでの`mise run up`で反映した場合に、操作の要らない通知を送らないためである。
 * 出さなかったことは、戻り値の`already_applied`とinfoのログに残す。
 * 反映そのものは済んでいるので、通知の失敗で例外を投げない。失敗は警告ログに残す。
 */
export async function recordHostAction(
  deps: HostActionDeps,
  shaTo: string,
  hostPaths: readonly string[],
): Promise<HostActionRecordResult> {
  try {
    const match = await deps.isApplied(shaTo);
    if (match === "included") {
      deps.log.info("host action already applied on the host", { sha: shaTo });
      return "already_applied";
    }
    if (match === "same_content") {
      deps.log.info("skipped: host already applied the same content", {
        sha: shaTo,
      });
      return "already_applied";
    }
  } catch (err) {
    deps.log.warn("host applied check failed", {
      sha: shaTo,
      error: errorMessage(err),
    });
  }
  const built = buildHostActionNotice(shaTo, hostPaths);
  let noticeId: number | null;
  try {
    noticeId = await deps.addNotice(built.notice);
  } catch (err) {
    deps.log.warn("host action notice could not be recorded", {
      sha: shaTo,
      error: errorMessage(err),
    });
    return "failed";
  }
  if (noticeId === null) {
    deps.log.info("host action notice already open", { sha: shaTo });
    return "already_open";
  }
  deps.log.warn("host action notice recorded", {
    sha: shaTo,
    notice_id: noticeId,
  });
  try {
    await deps.notify({
      kind: "host_action_required",
      instance_name: deps.instanceName,
      cause: built.cause,
      next_action: built.next_action,
    });
  } catch (err) {
    deps.log.warn("host action notification failed", {
      sha: shaTo,
      error: errorMessage(err),
    });
  }
  return "recorded";
}

export type HostActionNoticeRow = {
  readonly id: number;
  readonly message: string;
};

export type ReconcileDeps = {
  readonly listUnresolved: () => Promise<readonly HostActionNoticeRow[]>;
  /** 版がホストの反映済みの版に含まれるか(`hostAppliedChecker`)。 */
  readonly isApplied: HostAppliedCheck;
  /** noticeを解決し、実際に解決したら`true`を返す。 */
  readonly resolve: (id: number) => Promise<boolean>;
  readonly log: Logger;
};

/**
 * 未解決の通知のうち、ホストが反映した版に含まれるものと、ホスト側の作業が要るパスの内容がその版と同じものを解決し、解決した件数を返す。
 * 調べるのは古いものから`HOST_ACTION_RECONCILE_LIMIT`件までで、残りは次の回に調べる。
 * 自己更新が毎回呼ぶので、例外を投げない。反映の可否に影響させないためである。
 */
export async function reconcileHostActionNotices(
  deps: ReconcileDeps,
): Promise<number> {
  let rows: readonly HostActionNoticeRow[];
  try {
    rows = await deps.listUnresolved();
  } catch (err) {
    deps.log.warn("host action notices could not be listed", {
      error: errorMessage(err),
    });
    return 0;
  }
  // 版を読めない通知(本文が書き換えられたものなど)で枠を埋めないよう、読めた通知から数える。
  const readable = rows.flatMap((row) => {
    const sha = extractNoticeSha(row.message);
    return sha === null ? [] : [{ id: row.id, sha }];
  });
  if (readable.length > HOST_ACTION_RECONCILE_LIMIT) {
    deps.log.info("host action notices exceed the check limit", {
      unresolved: readable.length,
      limit: HOST_ACTION_RECONCILE_LIMIT,
    });
  }

  let resolvedCount = 0;
  for (const { id, sha: noticeSha } of readable.slice(
    0,
    HOST_ACTION_RECONCILE_LIMIT,
  )) {
    try {
      const match = await deps.isApplied(noticeSha);
      if (match === "not_applied") continue;
      if (await deps.resolve(id)) {
        resolvedCount += 1;
        deps.log.info("host action notice resolved", {
          notice_id: id,
          sha: noticeSha,
          match,
        });
      }
    } catch (err) {
      deps.log.warn("host action notice could not be checked", {
        notice_id: id,
        error: errorMessage(err),
      });
    }
  }
  return resolvedCount;
}
