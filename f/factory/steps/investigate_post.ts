// f/factory/investigateフローの4ステップ中4番目(投稿)。
// 調査の結果を無害化し、秘密値を検査して、依頼したIssueにコメントとして投稿し、調査を終える。
// 保護パスに置く。無害化や検査を外したり、投稿先の確認を緩めたりすると、調査の出力に紛れた秘密値や悪意のある記法が、
// 閉じたIssueや別のリポジトリのIssueに投稿されるため。
//
// 順序は固定する。
// 1. 調査の設定を読み直す。偽なら調査を`cancelled`にして止める。
// 2. 行がこの実行のリースを持つ稼働中の調査であることと、出力の形を確かめる。
// 3. 投稿先のIssueを読み直す。見つからない、閉じている、PRである、リポジトリが違うときは、投稿せずに`cancelled`にする。
// 4. 本文を作る(`prepareInvestigateComment`)。生の出力と最終の本文にgitleaksを掛け、検出か検査の失敗なら、投稿せずに`needs_human`にする。
// 5. コメントを投稿する。目印で冪等であり、既に自分のアカウントの目印つきコメントがあれば、投稿せずにそのIDを使う。
// 6. 稼働中の調査を、投稿の済んだ状態(`investigated`)に比較交換で進める。
// 失敗は、Issueには書かない。運用者へはDiscordとConsoleで知らせる。
// 生の出力と失敗の詳細は、結果にも状態の注記にも載せない。

import * as wmill from "windmill-client@1.817.0";
import { ciTextScanner } from "../lib/ci_fix_round.ts";
import type { CiTextScanner } from "../lib/ci_log_support.ts";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, updateStatusIfLeaseHolder } from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { parseTokenVariable } from "../lib/gh_collect_support.ts";
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
  isInvestigateOutput,
  prepareInvestigateComment,
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
  /** 生成のstepの構造化出力。形は`isInvestigateOutput`で確かめる。 */
  readonly output: unknown;
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
  /** workerが持つ秘密値。完全一致で消す。 */
  readonly readSecrets: () => Promise<readonly string[]>;
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

const SECRET_DETECTED: EscalationSpec = {
  note: "result withheld: secret detected",
  reason:
    "調査の結果に秘密値の形の文字列が含まれていたため、結果を捨てて、投稿しませんでした。",
  nextAction: "依頼文を変えて投入し直してください。",
};

const SCAN_FAILED: EscalationSpec = {
  note: "result withheld: secret scan failed",
  reason:
    "調査の結果の秘密値の検査ができなかったため、結果を捨てて、投稿しませんでした。",
  nextAction:
    "検査(gitleaks)が動くことを確かめ、依頼文を変えて投入し直してください。",
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
 * 調査の結果を投稿して、調査を終える。順序は、ファイルの先頭の説明のとおり。
 * 行が無いとき、出力の形が違うとき、Issueの読み取り(404以外)や投稿の失敗は、例外を投げる。
 * 戻り値に、出力の本文は含めない。
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
  const output = input.output;
  if (!isInvestigateOutput(output)) {
    throw new Error(
      "investigate_post: the output of the generate step is missing or has an unexpected shape",
    );
  }
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

  const prepared = await prepareInvestigateComment(output, {
    workItemId: item.id,
    secrets: await deps.readSecrets(),
    scan: deps.scan,
  });
  if (prepared.kind === "withheld") {
    await deps.escalate(
      item,
      prepared.reason === "secret_detected" ? SECRET_DETECTED : SCAN_FAILED,
    );
    return result("withheld");
  }

  const posted = await deps.postComment(item, prepared.body);
  const marked = await deps.markInvestigated(item);
  if (!marked) return result("state_changed", posted.id);
  return result(posted.created ? "posted" : "already_posted", posted.id);
}

/** workerが持つ秘密値を集める。完全一致のマスクに使う。空の値は含めない。 */
async function readSecretValues(): Promise<readonly string[]> {
  const [oauth, github, windmill, discord, readTokens] = await Promise.all([
    wmill.getVariable("f/factory/claude_oauth_token"),
    wmill.getVariable("f/factory/github_token"),
    wmill.getVariable("f/factory/wmill_token"),
    wmill.getVariable("f/factory/discord_webhook_url"),
    wmill.getVariable("f/factory/github_read_tokens"),
  ]);
  const parsed = parseTokenVariable(readTokens);
  const tokens = parsed.kind === "ok" ? [...parsed.tokens.values()] : [];
  return [
    oauth,
    github,
    windmill,
    discord,
    ...tokens,
    process.env.WM_TOKEN ?? "",
  ].filter((value) => value !== "");
}

export async function main(
  work_item_id: number,
  output: Record<string, unknown> | null,
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
    { workItemId: work_item_id, rootJobId, output },
    {
      readEnabled: () => config.investigate_enabled,
      getWorkItem: (id) => getWorkItem(id),
      getIssue: (owner, repo, number) => getIssue(client, owner, repo, number),
      readSecrets: readSecretValues,
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
