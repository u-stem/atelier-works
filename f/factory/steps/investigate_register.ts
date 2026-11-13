// f/factory/investigateフローの4ステップ中1番目(登録)。
// 実装せずに調べて答える調査を登録する。入力は、対象のIssueと依頼文である。
// 依頼文は引数で受けて、作業項目の行の`body`に保存する。以後のstepはその文だけを使い、Issueの本文は読まない。
// Issueは、依頼文の出どころではなく、返信の宛先としてだけ使う。
// 保護パスに置く。確認の順序や断りを緩めると、許可していないリポジトリや第三者のIssueの調査が通るため。
//
// 確認の順は、入力の形、調査の設定、リポジトリの許可とオーナーのID、Issue、隔離の測定、挿入である。
// 設定が偽のときは、GitHubにもsecret変数にも触れず、行も作らずに断る。Issueは、開いていて、PRでなく、作者が運用者のPATのアカウントであるものに限る。
// 第三者が書いたIssueの本文は、依頼文になる経路を持たないが、返信を受けるIssueとして選ぶことも断る。
// 隔離の測定のジョブが待ちか実行中のときは断る。測定は調査のworktreeの置き場を空にするため。
// 稼働中の調査が既にあるときは断る。調査は置き場の自分以外の項目を消すため、並行させない。
// 断りは例外にせず、理由の符号を結果で返す。入力の文字列は結果に含めない。
//
// 行にはフローのルートジョブのIDを、挿入と同時に記録する。後のstepと失敗処理は、これで自分の行を確かめる。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  insertInvestigateWorkItemUnlessActive,
  type NewInvestigateWorkItem,
} from "../lib/db.ts";
import {
  type GhClient,
  getIssue,
  getViewer,
  type Issue,
  isOwnPost,
} from "../lib/github.ts";
import { GitHubHttpError } from "../lib/github_errors.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import {
  INVESTIGATE_REQUEST_MAX_CHARS,
  isProbeJobActive,
} from "../lib/investigate_flow.ts";
import { logger } from "../lib/log.ts";
import {
  type RepoOwnerGateResult,
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { isGitHubName } from "../lib/types.ts";

/** 断る理由。入力の文字列は含めない。 */
export const INVESTIGATE_REGISTER_REFUSAL_REASONS = [
  "invalid_input",
  "repo_not_allowed",
  "owner_mismatch",
  "investigation_disabled",
  "issue_not_found",
  "issue_closed",
  "issue_is_pull_request",
  "issue_author_not_operator",
  "repo_mismatch",
  "probe_running",
  "investigation_in_progress",
] as const;

export type InvestigateRegisterRefusalReason =
  (typeof INVESTIGATE_REGISTER_REFUSAL_REASONS)[number];

/** 登録した(`skip: false`)か、断った(`skip: true`)か。断ったとき、後のstepは実行されない。 */
export type InvestigateRegisterResult =
  | {
      readonly skip: false;
      readonly reason: null;
      readonly work_item_id: number;
    }
  | {
      readonly skip: true;
      readonly reason: InvestigateRegisterRefusalReason;
      readonly work_item_id: 0;
    };

export type InvestigateRegisterInput = {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly request: string;
  /** フローのルートジョブのID。行に記録するリース。 */
  readonly flowJobId: string;
};

/** `registerInvestigation`が使う外部の操作。テストでは差し替える。 */
export type InvestigateRegisterDeps = {
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  /** オーナーの数値IDの照合(`verifyRepoOwnerId`)。 */
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<RepoOwnerGateResult>;
  /** 調査の設定が真か。 */
  readonly isEnabled: () => boolean;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<Issue>;
  /** 運用者のPATのアカウントのログイン名。設定とリポジトリの確認を通った後に、1回だけ呼ぶ。 */
  readonly getViewerLogin: () => Promise<string>;
  /** 隔離の測定のジョブが待ちか実行中か。 */
  readonly isProbeActive: () => Promise<boolean>;
  /** 稼働中の調査が無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly insert: (item: NewInvestigateWorkItem) => Promise<number | null>;
};

function refused(
  reason: InvestigateRegisterRefusalReason,
): InvestigateRegisterResult {
  return { skip: true, reason, work_item_id: 0 };
}

/**
 * 入力の形を確かめ、保存する依頼文(前後の空白を除いたもの)を返す。形が違えば`null`。
 * ownerとrepoはGitHubの名前の形、Issueの番号は正の安全な整数、依頼文は空でなく、上限以内で、NUL文字を含まない。
 * NUL文字はDBの文字列の列に入らないため、挿入の前に断る。
 */
function validRequest(
  input: Pick<
    InvestigateRegisterInput,
    "owner" | "repo" | "issueNumber" | "request"
  >,
): string | null {
  if (!isGitHubName(input.owner) || !isGitHubName(input.repo)) return null;
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    return null;
  }
  const request = input.request.trim();
  if (request === "" || request.length > INVESTIGATE_REQUEST_MAX_CHARS) {
    return null;
  }
  return request.includes("\u0000") ? null : request;
}

function isNotFound(err: unknown): boolean {
  return err instanceof GitHubHttpError && err.status === 404;
}

const UNIQUE_VIOLATION_MESSAGE =
  "duplicate key value violates unique constraint";

/**
 * 例外が、一意制約の違反かを返す。
 * 稼働中の調査の索引に阻まれた挿入は`null`で返るが、同じIssueの`(owner, repo, issue_number, cycle)`の制約は、
 * 並行する登録が同じcycleを読むと、例外になる。
 */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (Reflect.get(err, "code") === "23505") return true;
  const body: unknown = Reflect.get(err, "body");
  return (
    err.message.includes(UNIQUE_VIOLATION_MESSAGE) ||
    (typeof body === "string" && body.includes(UNIQUE_VIOLATION_MESSAGE))
  );
}

/** GitHubが返すリポジトリの綴りが、入力と大文字小文字を除いて同じか。 */
function isSameRepository(
  repository: Issue["repository"],
  input: Pick<InvestigateRegisterInput, "owner" | "repo">,
): repository is NonNullable<Issue["repository"]> {
  return (
    repository !== null &&
    repository.owner.toLowerCase() === input.owner.toLowerCase() &&
    repository.repo.toLowerCase() === input.repo.toLowerCase()
  );
}

/**
 * 調査を登録する。断るときは何も作らず、理由の符号を返す。
 * 登録できたら、行のIDを返す。行は`investigating`で、`body`に依頼文、`flow_job_id`にルートジョブのIDを持つ。
 * GitHubの読み取りの失敗(404以外)と、挿入の予期しない失敗は、例外のまま投げる。
 */
export async function registerInvestigation(
  input: InvestigateRegisterInput,
  deps: InvestigateRegisterDeps,
): Promise<InvestigateRegisterResult> {
  const request = validRequest(input);
  if (request === null) return refused("invalid_input");

  if (!deps.isEnabled()) return refused("investigation_disabled");

  if (!deps.isRepoAllowed(input.owner, input.repo)) {
    return refused("repo_not_allowed");
  }
  const ownerGate = await deps.verifyRepoOwner(input.owner, input.repo);
  if (!ownerGate.ok) return refused("owner_mismatch");

  let issue: Issue;
  try {
    issue = await deps.getIssue(input.owner, input.repo, input.issueNumber);
  } catch (err) {
    if (isNotFound(err)) return refused("issue_not_found");
    throw err;
  }
  const repository = issue.repository;
  if (!isSameRepository(repository, input)) return refused("repo_mismatch");
  if (issue.state !== "open") return refused("issue_closed");
  if (issue.isPullRequest) return refused("issue_is_pull_request");
  const viewerLogin = await deps.getViewerLogin();
  if (!isOwnPost(issue.authorLogin, viewerLogin)) {
    return refused("issue_author_not_operator");
  }

  if (await deps.isProbeActive()) return refused("probe_running");

  let id: number | null;
  try {
    id = await deps.insert({
      owner: repository.owner,
      repo: repository.repo,
      issue_number: input.issueNumber,
      issue_url: issue.htmlUrl,
      title: issue.title,
      body: request,
      claimed_by: viewerLogin,
      flow_job_id: input.flowJobId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return refused("investigation_in_progress");
    throw err;
  }
  if (id === null) return refused("investigation_in_progress");
  return { skip: false, reason: null, work_item_id: id };
}

/**
 * フローの1番目のstep。入力は、`investigate`フローの入力をそのまま受ける。
 * 入力の形が違うときは、secret変数を読まず、GitHubも読まずに断る。
 * フローの外で実行されたときは、ルートジョブのIDを引けず、行を作る前に例外を投げる。
 */
export async function main(
  owner: string,
  repo: string,
  issue_number: number,
  request: string,
): Promise<InvestigateRegisterResult> {
  const input = { owner, repo, issueNumber: issue_number, request };
  if (validRequest(input) === null) return refused("invalid_input");

  const log = logger("investigate_register");
  const flowJobId = rootFlowJobId(process.env);
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  // 設定が偽のときにsecret変数を読まないよう、トークンは使うときに初めて読む。
  let clientPromise: Promise<GhClient> | undefined;
  const client = (): Promise<GhClient> => {
    clientPromise ??= wmill
      .getVariable("f/factory/github_token")
      .then((ghToken) => ({ ghToken }));
    return clientPromise;
  };
  const workspace = wmillDefault.getWorkspace();

  const result = await registerInvestigation(
    { ...input, flowJobId },
    {
      isRepoAllowed: (candidateOwner, candidateRepo) =>
        isRepoAllowed(config, candidateOwner, candidateRepo),
      verifyRepoOwner: (candidateOwner, candidateRepo) =>
        client().then((ghClient) =>
          verifyRepoOwnerId(
            config,
            candidateOwner,
            candidateRepo,
            repoOwnerGateDeps(ghClient, addNoticeUnlessUnresolved),
          ),
        ),
      isEnabled: () => config.investigate_enabled,
      getIssue: async (issueOwner, issueRepo, number) =>
        getIssue(await client(), issueOwner, issueRepo, number),
      getViewerLogin: async () => (await getViewer(await client())).login,
      isProbeActive: () =>
        isProbeJobActive({
          workspace,
          listQueue: (query) => wmill.JobService.listQueue(query),
        }),
      insert: (item) => insertInvestigateWorkItemUnlessActive(item),
    },
  );
  log.info("investigation registered", {
    owner,
    repo,
    issue_number,
    skip: result.skip,
    reason: result.reason,
    work_item_id: result.work_item_id,
  });
  return result;
}
