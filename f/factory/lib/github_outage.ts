// GitHubへの通信断で、定期ジョブがそろって失敗した回を、1つの事象(notice)として扱う。
//
// 通信断の判定は、`github_http.ts`の再試行の後も応答が無いまま終わった読み取りの要求だけである。
// 定期ジョブは、通信断のエラーを失敗として記録せず、回の終わりに`finish`へ渡す。
// 通信断だけで終わった回は、見送りを1件記録して成功で終える。
// 通信断のほかにも失敗があった回は、失敗として終え、見送りにした分も失敗として記録する。

import {
  addNoticeUnlessUnresolved,
  recordOutageSkip,
  resolveUnresolvedNoticesByMessage,
} from "./db.ts";
import { type NotifyEvent, notifyBestEffort } from "./discord.ts";
import { isGitHubUnreachable } from "./github_errors.ts";
import { githubReadSuccessCount } from "./github_http.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const GITHUB_UNREACHABLE_KIND = "github_unreachable";

export const GITHUB_OUTAGE_RESOLVER = "github_outage";

export const GITHUB_UNREACHABLE_NEXT_ACTION =
  "GitHubの障害情報とこのサーバーのネットワークを確認する。通信が戻れば、次の定期ジョブの回で自動で解決する。";

// 時刻やジョブの名前を入れない。本文が変わると、同じ通信断の事象が重なる。
export const GITHUB_UNREACHABLE_MESSAGE = `GitHubを読む要求が、再試行の後も応答なしで終わりました。通信が戻るまで、定期ジョブの回を見送ります。次の操作: ${GITHUB_UNREACHABLE_NEXT_ACTION}`;

export type RecordFailureFn = (step: string, err: unknown) => Promise<void>;

export type OutageDeps = {
  addNotice: (record: NoticeRecord) => Promise<number | null>;
  resolveNotices: (
    kind: string,
    message: string,
    resolvedBy: string,
  ) => Promise<number>;
  recordSkip: (record: {
    flow_path: string;
    job_id: string;
    step: string | null;
  }) => Promise<unknown>;
  notify: (event: NotifyEvent) => Promise<void>;
  readSuccessCount: () => number;
  now: () => Date;
  jobId: () => string;
};

export type OutageRoundOptions = {
  flowPath: string;
  instanceName: string;
  log: Logger;
  /** 通知の宛先を取れない回でも、事象の記録と解決は続けるため、通知だけを外せる。 */
  webhookUrl?: string | null;
  deps?: Partial<OutageDeps>;
};

type Deferred = { step: string; err: unknown; record: RecordFailureFn };

export type OutageRound = {
  /** 通信断なら回の終わりまで預け、それ以外は`record`で失敗として記録する。 */
  failure(step: string, err: unknown, record: RecordFailureFn): Promise<void>;
  /** 本体を実行する。通信断のエラーは握りつぶして`fallback`を返し、それ以外は投げ直す。回の終わりに`finish`を呼ぶ。 */
  guard<T>(body: () => Promise<T>, fallback: T): Promise<T>;
  finish(): Promise<void>;
};

function defaultDeps(options: OutageRoundOptions): OutageDeps {
  return {
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    resolveNotices: (kind, message, resolvedBy) =>
      resolveUnresolvedNoticesByMessage(kind, message, resolvedBy),
    recordSkip: (record) => recordOutageSkip(record),
    notify: async (event) => {
      await notifyBestEffort(options.webhookUrl ?? "", event, options.log);
    },
    readSuccessCount: () => githubReadSuccessCount(),
    now: () => new Date(),
    jobId: () => process.env.WM_JOB_ID ?? "unknown",
  };
}

export function createOutageRound(options: OutageRoundOptions): OutageRound {
  const deps: OutageDeps = { ...defaultDeps(options), ...options.deps };
  const { log } = options;
  const startedReadSuccesses = deps.readSuccessCount();
  const deferred: Deferred[] = [];
  let otherFailure = false;
  let finished = false;

  async function ensureEvent(): Promise<void> {
    try {
      const id = await deps.addNotice({
        kind: GITHUB_UNREACHABLE_KIND,
        message: GITHUB_UNREACHABLE_MESSAGE,
      });
      if (id === null) return;
      await deps.notify({
        kind: "github_unreachable",
        instance_name: options.instanceName,
        detected_at: deps.now().toISOString(),
        next_action: GITHUB_UNREACHABLE_NEXT_ACTION,
      });
    } catch (err) {
      log.warn("failed to record github outage event", {
        error: maskSecrets(String(err)),
      });
    }
  }

  async function resolveEvent(): Promise<void> {
    try {
      await deps.resolveNotices(
        GITHUB_UNREACHABLE_KIND,
        GITHUB_UNREACHABLE_MESSAGE,
        GITHUB_OUTAGE_RESOLVER,
      );
    } catch (err) {
      log.warn("failed to resolve github outage event", {
        error: maskSecrets(String(err)),
      });
    }
  }

  async function finish(): Promise<void> {
    if (finished) return;
    finished = true;
    if (deferred.length > 0) {
      await ensureEvent();
      if (otherFailure) {
        for (const item of deferred) await item.record(item.step, item.err);
        return;
      }
      log.warn("github unreachable; skipping this round", {
        step: deferred[0]?.step ?? null,
        count: deferred.length,
      });
      try {
        await deps.recordSkip({
          flow_path: options.flowPath,
          job_id: deps.jobId(),
          step: deferred[0]?.step ?? null,
        });
      } catch (err) {
        log.warn("failed to record outage skip", {
          error: maskSecrets(String(err)),
        });
      }
      return;
    }
    if (deps.readSuccessCount() > startedReadSuccesses) await resolveEvent();
  }

  return {
    async failure(step, err, record) {
      if (isGitHubUnreachable(err)) {
        deferred.push({ step, err, record });
        return;
      }
      otherFailure = true;
      await record(step, err);
    },
    async guard(body, fallback) {
      try {
        return await body();
      } catch (err) {
        if (isGitHubUnreachable(err)) {
          deferred.push({
            step: "main",
            err,
            record: async () => {
              throw err;
            },
          });
          return fallback;
        }
        otherFailure = true;
        throw err;
      } finally {
        await finish();
      }
    },
    finish,
  };
}
