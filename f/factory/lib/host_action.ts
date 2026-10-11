// ホスト側の作業が要る反映(`infra/`や`mise.toml`の`[tools]`・`[env]`の変更)を、
// 要対応の通知(notice)とDiscordで知らせ、ホストで反映が済んだら通知を解決する。
//
// 自己更新はworkerの中でしか動かないので、これらの変更を自分では反映できない。
// 人が`mise run up`を実行するまで古い構成で動き続けるため、気づく手段として通知を出す。
//
// 反映が済んだ印は、`mise run up`が終わりに共有ボリューム(`factory_state`)へ書く
// ホストのcheckoutのHEAD(`HOST_APPLIED_SHA_PATH`)である。
// 通知が名指しする版がこのHEADと同じか、その祖先なら、ホストはその変更を含む版で
// 起動し直したことになるので、通知を解決する。
// 印が無いとき、読めないとき、self cloneに無い版のとき、祖先かどうかを確かめられないときは、
// 解決しない。解決できなかった通知は、人がConsoleで解決してよい。
// 印は、workerのジョブも書ける場所にある。偽の印で黙らせられるのは、この通知だけである。

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

/** ホスト側の作業が要ることを示すnoticeの種類。 */
export const HOST_ACTION_NOTICE_KIND = "host_action_required";

/** `mise run up`が、反映したホストのcheckoutのHEADを書くファイル。 */
export const HOST_APPLIED_SHA_PATH = "/var/lib/factory/host_applied_sha";

/** 自動で解決したnoticeの`resolved_by`。 */
export const HOST_ACTION_RESOLVER = "self_update";

/**
 * 1回の実行で調べる未解決の通知の数の上限。古いものから調べる。
 * 通知ごとにgitを1回呼ぶので、数を固定して最悪の長さを抑える。
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
  readonly log: Logger;
};

/**
 * 版`sha`がホストの反映済みの版に含まれるかを返す関数を作る。例外は投げず、確かめられなければ`false`にする。
 * 印は最初の呼び出しで1回だけ読み、self cloneにあるかも1回だけ確かめる。
 * 印が読めない、版として読めない、self cloneに無いときは、以降のどの`sha`も含まれないとして扱う。
 * 印が無いだけのとき(ホストが一度も書いていない)は、警告を出さない。
 */
export function hostAppliedChecker(
  deps: AppliedCheckDeps,
): (sha: string) => Promise<boolean> {
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
    if (applied === null) return false;
    if (applied === sha) return true;
    try {
      return await deps.isAncestor(sha, applied);
    } catch (err) {
      deps.log.warn("host applied ancestry could not be checked", {
        sha,
        applied_sha: applied,
        error: errorMessage(err),
      });
      return false;
    }
  };
}

export type HostActionDeps = {
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  /** 版がホストの反映済みの版に含まれるか(`hostAppliedChecker`)。 */
  readonly isApplied: (sha: string) => Promise<boolean>;
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
 * 先に印を確かめ、ホストがその版を既に反映していれば、通知もDiscordも出さない。
 * 運用者が先に`mise run deploy`などで反映した場合に、操作の要らない通知を送らないためである。
 * 反映そのものは済んでいるので、通知の失敗で例外を投げない。失敗は警告ログに残す。
 */
export async function recordHostAction(
  deps: HostActionDeps,
  shaTo: string,
  hostPaths: readonly string[],
): Promise<HostActionRecordResult> {
  try {
    if (await deps.isApplied(shaTo)) {
      deps.log.info("host action already applied on the host", { sha: shaTo });
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
  readonly isApplied: (sha: string) => Promise<boolean>;
  /** noticeを解決し、実際に解決したら`true`を返す。 */
  readonly resolve: (id: number) => Promise<boolean>;
  readonly log: Logger;
};

/**
 * 未解決の通知のうち、ホストが反映した版に含まれるものを解決し、解決した件数を返す。
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
      if (!(await deps.isApplied(noticeSha))) continue;
      if (await deps.resolve(id)) {
        resolvedCount += 1;
        deps.log.info("host action notice resolved", {
          notice_id: id,
          sha: noticeSha,
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
