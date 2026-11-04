// f/factory/investigateフローの4ステップ中4番目(投稿)。
// 生成のstepが作った最終の本文を、依頼したIssueにコメントとして投稿し、調査を終える。
// 保護パスに置く。検査を外したり、投稿先の確認を緩めたりすると、秘密値や悪意のある記法が、
// 閉じたIssueや別のリポジトリのIssueに投稿されるため。
//
// 受け取るのは、生成のstepが無害化と検査を済ませた最終の本文か、本文を作れなかった理由の符号だけである。
// 生の出力は受け取らない。本文を作るのは生成のstepで、このstepは本文を作り直さない。
//
// 順序は固定する。
// 1. 調査の設定を読み直す。偽なら調査を`cancelled`にして止める。
// 2. 行がこの実行のリースを持つ稼働中の調査であることと、受け取った値の形を確かめる。
// 3. 投稿先のIssueを読み直す。見つからない、閉じている、PRである、リポジトリが違うときは、投稿せずに`cancelled`にする。
// 4. 符号を受け取っていたら、投稿せずに`needs_human`にする。
// 5. 本文にgitleaksをもう一度掛ける。検出か検査の失敗なら、投稿せずに`needs_human`にする。
// 6. コメントを投稿する。目印で冪等であり、既に自分のアカウントの目印つきコメントがあれば、投稿せずにそのIDを使う。
// 7. 稼働中の調査を、投稿の済んだ状態(`investigated`)に比較交換で進める。
// 失敗は、Issueには書かない。運用者へはDiscordとConsoleで知らせる。
// 本文と失敗の詳細は、結果にも状態の注記にも例外にも載せない。

import * as wmill from "windmill-client@1.817.0";
import { ciTextScanner } from "../lib/ci_fix_round.ts";
import type { CiTextScanner } from "../lib/ci_log_support.ts";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, updateStatusIfLeaseHolder } from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import {
  commentIssue,
  type GhClient,
  getIssue,
  getViewer,
  type Issue,
} from "../lib/github.ts";
import { GitHubHttpError } from "../lib/github_errors.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import {
  type EscalationSpec,
  escalateInvestigation,
  holdsInvestigateLease,
  INVESTIGATE_MARKER_KIND,
  type InvestigateWithheld,
  isPostableCommentBody,
  isWithheldCode,
  withheldEscalation,
} from "../lib/investigate_flow.ts";
import { type Logger, logger } from "../lib/log.ts";
import type { WorkItem } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

export type InvestigatePostResult = {
  readonly outcome:
    | "posted"
    | "already_posted"
    | "withheld"
    | "cancelled"
    | "skipped"
    | "state_changed";
  /** 投稿した(または既にあった)コメントのID。投稿しなかったときは`null`。 */
  readonly comment_id: number | null;
};

export type InvestigatePostInput = {
  readonly workItemId: number;
  readonly rootJobId: string;
  /** 生成のstepが作った最終の本文。目印は付いていない。 */
  readonly commentBody: string | null;
  /** 生成のstepが本文を作れなかったときの理由の符号。 */
  readonly withheld: string | null;
};

/** `runInvestigatePost`が使う外部の操作。テストでは差し替える。 */
export type InvestigatePostDeps = {
  readonly readEnabled: () => boolean;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<Issue>;
  /** 投稿の直前に、本文に掛ける検査。 */
  readonly scan: CiTextScanner;
  /** 目印つきでコメントを投稿する。既に自分のコメントがあれば、投稿せずにそのIDを返す。 */
  readonly postComment: (
    item: WorkItem,
    body: string,
  ) => Promise<{ readonly id: number; readonly created: boolean }>;
  /** 稼働中の調査を、この実行のリースの下で`investigated`にする。 */
  readonly markInvestigated: (item: WorkItem) => Promise<boolean>;
  /** 稼働中の調査を、この実行のリースの下で`cancelled`にする。 */
  readonly cancel: (note: string) => Promise<boolean>;
  readonly escalate: (item: WorkItem, spec: EscalationSpec) => Promise<boolean>;
  readonly log: Logger;
};

function result(
  outcome: InvestigatePostResult["outcome"],
  commentId: number | null = null,
): InvestigatePostResult {
  return { outcome, comment_id: commentId };
}

function isNotFound(err: unknown): boolean {
  return err instanceof GitHubHttpError && err.status === 404;
}

/** 投稿先のIssueが投稿してよい状態でないときの、状態の注記。投稿してよいなら`null`。 */
function unpostableNote(
  issue: Issue,
  item: Pick<WorkItem, "owner" | "repo">,
): string | null {
  const repository = issue.repository;
  if (
    repository === null ||
    repository.owner.toLowerCase() !== item.owner.toLowerCase() ||
    repository.repo.toLowerCase() !== item.repo.toLowerCase()
  ) {
    return "issue repository differs from the investigation";
  }
  if (issue.state !== "open") return "issue is closed";
  if (issue.isPullRequest) return "issue is a pull request";
  return null;
}

/**
 * 生成のstepから受け取った値を、本文か符号のどちらか1つとして読む。
 * どちらでもない、または両方あるときは、値を載せずに例外を投げる。
 */
function readHandover(
  input: InvestigatePostInput,
  workItemId: number,
): { readonly body: string } | { readonly withheld: InvestigateWithheld } {
  const { commentBody, withheld } = input;
  if (commentBody !== null && withheld === null) {
    if (isPostableCommentBody(commentBody, workItemId)) {
      return { body: commentBody };
    }
  } else if (commentBody === null && isWithheldCode(withheld)) {
    return { withheld };
  }
  throw new Error(
    "investigate_post: the comment body or the withheld code from the generate step is missing or has an unexpected shape",
  );
}

/** 本文に秘密値の検査を掛ける。検査の失敗は、検出と区別して返す。 */
async function scanBody(
  deps: InvestigatePostDeps,
  body: string,
): Promise<"clean" | InvestigateWithheld> {
  try {
    const scanned = await deps.scan(body);
    return scanned.ok ? "clean" : "secret_detected";
  } catch {
    return "scan_failed";
  }
}

/**
 * 調査の結果を投稿して、調査を終える。順序は、ファイルの先頭の説明のとおり。
 * 行が無いとき、受け取った値の形が違うとき、Issueの読み取り(404以外)や投稿の失敗は、例外を投げる。
 * 戻り値に、本文は含めない。
 */
export async function runInvestigatePost(
  input: InvestigatePostInput,
  deps: InvestigatePostDeps,
): Promise<InvestigatePostResult> {
  if (!deps.readEnabled()) {
    await deps.cancel("investigation disabled");
    return result("cancelled");
  }

  const item = await deps.getWorkItem(input.workItemId);
  if (item === null) {
    throw new Error(
      `investigate_post: no work item with id ${String(input.workItemId)}`,
    );
  }
  if (!holdsInvestigateLease(item, input.rootJobId)) {
    deps.log.info("investigation is not running under this flow, skipping", {
      work_item_id: item.id,
      status: item.status,
    });
    return result("skipped");
  }
  const handover = readHandover(input, item.id);
  if (item.issue_number === null) {
    throw new Error(
      `investigate_post: work item ${String(item.id)} has no issue number`,
    );
  }

  let issue: Issue;
  try {
    issue = await deps.getIssue(item.owner, item.repo, item.issue_number);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await deps.cancel("issue not found");
    return result("cancelled");
  }
  const note = unpostableNote(issue, item);
  if (note !== null) {
    await deps.cancel(note);
    return result("cancelled");
  }

  if ("withheld" in handover) {
    await deps.escalate(item, withheldEscalation(handover.withheld));
    return result("withheld");
  }

  const verdict = await scanBody(deps, handover.body);
  if (verdict !== "clean") {
    await deps.escalate(item, withheldEscalation(verdict));
    return result("withheld");
  }

  const posted = await deps.postComment(item, handover.body);
  const marked = await deps.markInvestigated(item);
  if (!marked) return result("state_changed", posted.id);
  return result(posted.created ? "posted" : "already_posted", posted.id);
}

export async function main(
  work_item_id: number,
  comment_body: string | null,
  withheld: string | null,
): Promise<InvestigatePostResult> {
  const log = logger("investigate_post");
  const rootJobId = rootFlowJobId(process.env);
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  const client: GhClient = { run: runCommand, ghToken };
  const viewer = await getViewer(client);

  const outcome = await runInvestigatePost(
    {
      workItemId: work_item_id,
      rootJobId,
      commentBody: comment_body,
      withheld,
    },
    {
      readEnabled: () => config.investigate_enabled,
      getWorkItem: (id) => getWorkItem(id),
      getIssue: (owner, repo, number) => getIssue(client, owner, repo, number),
      scan: ciTextScanner(runCommand),
      postComment: async (item, body) => {
        if (item.issue_number === null) {
          throw new Error(
            `investigate_post: work item ${String(item.id)} has no issue number`,
          );
        }
        return commentIssue(
          client,
          item.owner,
          item.repo,
          item.issue_number,
          INVESTIGATE_MARKER_KIND,
          item.id,
          body,
          viewer.login,
        );
      },
      markInvestigated: (item) =>
        updateStatusIfLeaseHolder(
          item.id,
          "investigating",
          "investigated",
          item.flow_job_id,
          "investigation posted",
        ),
      cancel: (note) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "investigating",
          "cancelled",
          rootJobId,
          note,
        ),
      escalate: (item, spec) =>
        escalateInvestigation(item, spec, config.instance_name, {
          markNeedsHuman: (id, flowJobId, note) =>
            updateStatusIfLeaseHolder(
              id,
              "investigating",
              "needs_human",
              flowJobId,
              note,
            ),
          notify: async (event) => {
            await notifyBestEffort(webhookUrl, event, log);
          },
        }),
      log,
    },
  );
  log.info("investigation posted", {
    work_item_id,
    outcome: outcome.outcome,
    comment_id: outcome.comment_id,
  });
  return outcome;
}
