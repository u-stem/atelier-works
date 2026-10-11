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
// 印が無いとき、読めないとき、祖先かどうかを確かめられないときは、解決しない。
// 解決できなかった通知は、人がConsoleで解決してよい。

import type { NotifyBestEffortResult, NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

/** ホスト側の作業が要ることを示すnoticeの種類。 */
export const HOST_ACTION_NOTICE_KIND = "host_action_required";

/** `mise run up`が、反映したホストのcheckoutのHEADを書くファイル。 */
export const HOST_APPLIED_SHA_PATH = "/var/lib/factory/host_applied_sha";

/** 自動で解決したnoticeの`resolved_by`。 */
export const HOST_ACTION_RESOLVER = "self_update";

/** 本文に並べるパスの数の上限。残りは件数で示す。 */
const MAX_LISTED_PATHS = 10;

const NEXT_ACTION =
  "ホストのcheckoutでgit pullし、mise run upを実行する。実行が済むと、自己更新(10分ごと)がこの通知を自動で解決する";

const SHA_IN_MESSAGE = /反映した版: ([0-9a-f]{40})/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export type HostActionNotice = {
  readonly notice: NoticeRecord;
  /** Discordの説明にも使う、起きたことの文。 */
  readonly cause: string;
  /** 運用者がまず行う操作の1文。 */
  readonly next_action: string;
};

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
  const listed = hostPaths.slice(0, MAX_LISTED_PATHS).join(", ");
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

export type HostActionDeps = {
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly notify: (event: NotifyEvent) => Promise<NotifyBestEffortResult>;
  readonly instanceName: string;
  readonly log: Logger;
};

export type HostActionRecordResult = "recorded" | "already_open" | "failed";

/**
 * ホスト側の作業が要る反映を、noticeに残し、新しく残したときだけDiscordに送る。
 * 反映そのものは済んでいるので、通知の失敗で例外を投げない。失敗は警告ログに残す。
 */
export async function recordHostAction(
  deps: HostActionDeps,
  shaTo: string,
  hostPaths: readonly string[],
): Promise<HostActionRecordResult> {
  const built = buildHostActionNotice(shaTo, hostPaths);
  let noticeId: number | null;
  try {
    noticeId = await deps.addNotice(built.notice);
  } catch (err) {
    deps.log.warn("host action notice could not be recorded", {
      sha: shaTo,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
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
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
  return "recorded";
}

export type HostActionNoticeRow = {
  readonly id: number;
  readonly message: string;
};

export type ReconcileDeps = {
  /** ホストが書いた印を返す。無いか読めなければ例外を投げる。 */
  readonly readAppliedSha: () => Promise<string>;
  readonly listUnresolved: () => Promise<readonly HostActionNoticeRow[]>;
  /** `ancestor`が`descendant`の祖先(同じ版を含む)かを返す。確かめられなければ例外を投げる。 */
  readonly isAncestor: (
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
  /** noticeを解決し、実際に解決したら`true`を返す。 */
  readonly resolve: (id: number) => Promise<boolean>;
  readonly log: Logger;
};

/**
 * 未解決の通知のうち、ホストが反映した版に含まれるものを解決し、解決した件数を返す。
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
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return 0;
  }
  if (rows.length === 0) return 0;

  let applied: string;
  try {
    applied = (await deps.readAppliedSha()).trim();
  } catch {
    // ホストが一度も`mise run up`の印を書いていない。通知は人が解決するまで残る。
    return 0;
  }
  if (!FULL_SHA.test(applied)) {
    deps.log.warn("host applied sha is not a git sha", {
      path: HOST_APPLIED_SHA_PATH,
    });
    return 0;
  }

  let resolvedCount = 0;
  for (const row of rows) {
    const noticeSha = extractNoticeSha(row.message);
    if (noticeSha === null) continue;
    try {
      const covered =
        noticeSha === applied || (await deps.isAncestor(noticeSha, applied));
      if (!covered) continue;
      if (await deps.resolve(row.id)) {
        resolvedCount += 1;
        deps.log.info("host action notice resolved", {
          notice_id: row.id,
          sha: noticeSha,
          applied_sha: applied,
        });
      }
    } catch (err) {
      deps.log.warn("host action notice could not be checked", {
        notice_id: row.id,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return resolvedCount;
}
