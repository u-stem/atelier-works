// f/factory/manual_intakeフローのステップ。
// `manual_intake_create_issue`が作ったIssueを登録する。進め方で道が2つに分かれる。
// - 要件定義の承認を要する進め方: `poll_issues.ts`が見つけたIssueと同じ手順で確保し、
//   `work_items`に行を追加して、f/factory/pipelineを起動し、Discordに通知する。
// - 承認を省く進め方: ラベルが無いので、取得は作業項目の挿入(稼働中のIssueの一意インデックス)で決める。
//   キーの表の行と引数の一致、リポジトリの許可、オーナーIDの照合を、挿入の前に確かめる。
//   承認の行を作らず、作業項目を`picked`から`implementing`へ移して、実装フローを直接起動する。
// この段階ではGitHubにコメントしない。
// GitHubには成果物だけを載せ、運用上の通知はDiscordとConsoleに出す方針のため。

import * as wmill from "windmill-client@1.817.0";
import {
  ACTIVE_WORK_ITEM_EXISTS_REASON,
  recordAssigneeMissing,
  recordClaimRaceLost,
} from "../lib/claim_support.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  defaultSqlClient,
  type IntakeKeyRow,
  insertIssueWorkItemUnlessActive,
  nextCycleForIssue,
  recordFailure,
  setFlowJobId,
  setFlowJobIdIfUnset,
  sqlIntakeKeyStore,
  updateStatusIfCurrentClearingFlowJobId,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { claimIssue, type GhClient, getViewer } from "../lib/github.ts";
import {
  IMPLEMENT_FLOW_PATH,
  parseFlowJobId,
  type StartImplementOutcome,
  startImplement,
} from "../lib/implement_launch_support.ts";
import { type Logger, logger } from "../lib/log.ts";
import {
  assertAcceptedProfile,
  assertImplementEnabledForProfile,
  assertIntakeKey,
  assertIntakeKeyForProfile,
  buildPostedIssueBody,
  computeIntakeContentHash,
  issueHtmlUrl,
  normalizeIntakeKey,
  skipsApprovals,
} from "../lib/manual_intake_support.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import {
  assertGitHubName,
  type FailureRecord,
  type WorkItemStatus,
} from "../lib/types.ts";
import {
  buildImplementLaunchNoticeMessage,
  notifyNeedsHumanBestEffort,
} from "./requirements_apply.ts";

export type ManualIntakeStartedResult = {
  readonly skipped: false;
  readonly work_item_id: number;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly flow_job_id: string;
};

/** 取得できなかったので何も始めなかった。`poll_issues`が、残っているラベルから拾い直す。 */
export type ManualIntakeSkippedResult = {
  readonly skipped: true;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly reason: string;
};

/**
 * 承認を省く進め方の登録の結果。実装フローのジョブIDは、起動の手順(`startImplement`)がDBに記録する。
 * `implement`が`started`以外のときは、起動の手順が失敗の記録と通知を済ませている。
 */
export type ManualIntakeApprovalFreeResult = {
  readonly skipped: false;
  readonly work_item_id: number;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly implement: StartImplementOutcome;
};

export type ManualIntakeRegisterResult =
  | ManualIntakeStartedResult
  | ManualIntakeApprovalFreeResult
  | ManualIntakeSkippedResult;

/** 同じ冪等キーの最初の投入が作ったIssueなので、通常の進め方は登録しない理由。 */
export const INTAKE_REUSED_REASON =
  "the issue was created by an earlier request with the same intake key";

/** 再利用したIssueに作業項目が既にあるので、新しいサイクルを始めない理由。 */
export const EXISTING_WORK_ITEM_REASON = "the issue already has a work item";

/**
 * 同じ冪等キーの最初の投入が作ったIssueを再利用したとき、通常の進め方の登録を飛ばすか。
 * 通常の進め方は、ラベルが残っていれば`poll_issues`が拾い直すので、ここでは何も始めない。
 * 承認を省く進め方は、ラベルが無く誰も拾わないので、飛ばさずに登録の中で判定する。
 */
export function shouldSkipReusedStandard(
  profile: string,
  reused: boolean | null | undefined,
): boolean {
  return reused === true && !skipsApprovals(profile);
}

export type ManualIntakeClaimDeps = {
  readonly claimIssue: typeof claimIssue;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
};

const defaultClaimDeps: ManualIntakeClaimDeps = {
  claimIssue,
  addNoticeUnlessUnresolved,
};

/** 取得できず何も始めなかったときの、フローの結果を作る。 */
export function manualIntakeSkippedResult(
  issueNumber: number,
  issueUrl: string,
  reason: string,
): ManualIntakeSkippedResult {
  return {
    skipped: true,
    issue_number: issueNumber,
    issue_url: issueUrl,
    reason,
  };
}

/**
 * 手動投入のIssueを取得し、作業を始めてよいか返す。
 * 取得の所有は、自分のラベルの削除が成功したことで決まる(`claimIssue`を参照)。
 * - 取得できたときは、assigneeが付いていなくても作業を続ける。
 *   付いていないときは、`poll_issues`と同じ`claim_assignee_missing`のnoticeを残す。
 * - ほかが先にラベルを外した、またはラベルの削除に失敗してラベルが残っているときは、
 *   失敗にせず見送る。ラベルが残っていれば`poll_issues`が扱い、
 *   ほかが外したのならそのインスタンスが扱う。
 *   前者は`poll_issues`と同じく、`claim_race_lost`のnoticeを残す。
 * - 所有したか判断できなかったときは、`ClaimOwnershipUnknownError`をそのまま投げる。
 *   フローの失敗として`on_error_flow`が人へ知らせる。
 */
export async function claimManualIntakeIssue(
  input: {
    readonly client: GhClient;
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly triggerLabel: string;
    readonly viewerLogin: string;
    readonly log: Logger;
  },
  deps: ManualIntakeClaimDeps = defaultClaimDeps,
): Promise<
  | { readonly claimed: true }
  | { readonly claimed: false; readonly reason: string }
> {
  const { owner, repo, issueNumber, log } = input;
  const target = `${owner}/${repo}#${issueNumber}`;
  const claim = await deps.claimIssue(input.client, owner, repo, issueNumber, {
    triggerLabel: input.triggerLabel,
    assignee: input.viewerLogin,
    log,
  });
  if (!claim.claimed) {
    log.warn("manual intake skipped the claim", {
      target,
      outcome: claim.outcome,
      reason: claim.reason,
    });
    if (claim.outcome === "lost") {
      await recordClaimRaceLost(
        target,
        claim.reason,
        deps.addNoticeUnlessUnresolved,
        log,
      );
    }
    return { claimed: false, reason: claim.reason };
  }
  if (claim.assignee === "missing") {
    await recordAssigneeMissing(
      target,
      input.viewerLogin,
      deps.addNoticeUnlessUnresolved,
      log,
    );
  }
  return { claimed: true };
}

export type ManualIntakeInsertDeps = {
  readonly insertWorkItem: typeof insertIssueWorkItemUnlessActive;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
};

const defaultInsertDeps: ManualIntakeInsertDeps = {
  insertWorkItem: insertIssueWorkItemUnlessActive,
  addNoticeUnlessUnresolved,
};

/**
 * 手動投入のIssueの作業項目を登録し、そのIDを返す。
 * 手動投入は必ず新しいIssueを作るので、サイクルは1で、置き換える古い作業項目は無い。
 * 同じIssueの稼働中の作業項目が既にあって挿入されなかったときは、`null`を返す。
 * 並行する取得に先を越された場合で、そちらが作業を受け持つので、
 * `poll_issues`と同じく`claim_race_lost`のnoticeを残すだけで、人には知らせない。
 * 挿入が例外を投げたときは、そのまま投げる。フローの失敗として`on_error_flow`が知らせる。
 * 進め方が受け付けるものでなければ、挿入せずに例外を投げる。
 * 承認を省く進め方も、挿入せずに例外を投げる。その進め方は`registerApprovalFreeIntake`が登録する。
 * 挿入する行の進め方は、DBの既定(標準の進め方)である。この道を通るのは標準の進め方だけなので、列に書かない。
 */
export async function registerManualIntakeWorkItem(
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly issueUrl: string;
    readonly title: string;
    readonly body: string;
    readonly viewerLogin: string;
    /** 進め方。受け付けないものなら、挿入の前に例外を投げる。 */
    readonly profile: string;
    readonly log: Logger;
  },
  deps: ManualIntakeInsertDeps = defaultInsertDeps,
): Promise<number | null> {
  assertAcceptedProfile(input.profile);
  if (skipsApprovals(input.profile)) {
    throw new Error("manual_intake: the profile does not belong to this path");
  }
  const registered = await deps.insertWorkItem({
    cycle: 1,
    source: "manual",
    kind: "issue",
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    issue_url: input.issueUrl,
    pr_number: null,
    title: input.title,
    body: input.body,
    status: "picked",
    attempt: 1,
    claimed_by: input.viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  });
  if (registered === null) {
    await recordClaimRaceLost(
      `${input.owner}/${input.repo}#${String(input.issueNumber)}`,
      ACTIVE_WORK_ITEM_EXISTS_REASON,
      deps.addNoticeUnlessUnresolved,
      input.log,
    );
  }
  return registered?.id ?? null;
}

export type ApprovalFreeIntakeInput = {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  /** 作業項目の本文になる、Issueを作るステップが投稿した本文(区切りの行と目印を含む)。登録が組み立て直して照合する。 */
  readonly body: string;
  readonly viewerLogin: string;
  readonly profile: string;
  /** 同じ冪等キーの最初の投入が作ったIssueを返されたか。 */
  readonly reused: boolean;
  readonly intakeKey: string | undefined;
  /** キーの表の内容のハッシュを再計算するための、投入の目的の入力(組み立てる前)。 */
  readonly intakeBody: string;
  /** 同じく、投入の受入基準の入力(組み立てる前)。 */
  readonly acceptanceCriteria: string;
};

export type ApprovalFreeIntakeDeps = {
  /** 設定の`implement_enabled`。偽なら、挿入の前に断る。 */
  readonly implementEnabled: boolean;
  /** 設定の許可リストの判定(`isRepoAllowed`)。 */
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  /** オーナーの数値IDの照合(`verifyRepoOwnerId`)。通らないときは理由を返す。 */
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  readonly readIntakeKey: (key: string) => Promise<IntakeKeyRow | null>;
  readonly nextCycle: (
    owner: string,
    repo: string,
    issueNumber: number,
  ) => Promise<number>;
  readonly insertWorkItem: typeof insertIssueWorkItemUnlessActive;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
  /** 作業項目を`picked`から`implementing`へ移して、実装フローを起動する。 */
  readonly startImplement: (
    workItemId: number,
  ) => Promise<StartImplementOutcome>;
  readonly log: Logger;
};

const KEY_MISMATCH_MESSAGE =
  "manual_intake: the intake key does not match the request";

/**
 * 承認を省く進め方の作業項目を登録し、実装フローを直接起動する。承認の行は作らない。
 *
 * 承認の関門を通らないので、この関数が入口を閉じる。挿入の前に、次をすべて確かめる。
 * - 進め方は、承認を省くものでなければならない。
 * - 冪等キーが要る。実装の停止スイッチが偽なら断る。
 * - リポジトリは設定の許可リストにあり、オーナーのIDが照合を通る。
 *   フローを直接実行する経路でも、Issueを作ったステップの検査に頼らないためである。
 * - キーの表の行が、引数のリポジトリ、Issueの番号、進め方を含む内容のハッシュと一致する。
 *   進め方を差し替えた登録は、ハッシュが合わず断られる。
 * - 作業項目の本文が、入力とキーから組み立て直した値と一致する。
 *   本文は、Issueを作るステップが投稿した本文そのものでなければならない。
 * IssueのURLは入力から受けず、名前と番号から組み立てて保存する。
 * Issueに作業項目が1件でもあれば、再利用か新規かにかかわらず登録しない。
 * 終端の作業項目があるIssueで、新しいサイクルを始めないためである。
 * 取得は挿入で決まる。稼働中の作業項目が既にあって挿入されなければ、取得を失ったものとして何も始めない。
 * 検査に通らないときは例外を投げる。フローの失敗として`on_error_flow`が知らせる。
 */
export async function registerApprovalFreeIntake(
  input: ApprovalFreeIntakeInput,
  deps: ApprovalFreeIntakeDeps,
): Promise<ManualIntakeApprovalFreeResult | ManualIntakeSkippedResult> {
  const { owner, repo, issueNumber, profile } = input;
  // IssueのURLは、入力から受けず、名前と番号から組み立てる。
  // GitHubが返すURLは正規の綴りで、入力のオーナー名やリポジトリ名の綴りと違いうる。
  // 綴りの違いを断ると、Issueを作った後に登録が落ちて、誰も拾わないIssueが残る。
  const issueUrl = issueHtmlUrl(owner, repo, issueNumber);
  assertAcceptedProfile(profile);
  if (!skipsApprovals(profile)) {
    throw new Error("manual_intake: the profile needs approvals");
  }
  const key = input.intakeKey;
  assertIntakeKeyForProfile(profile, key);
  assertImplementEnabledForProfile(profile, deps.implementEnabled);
  if (key === undefined) {
    throw new Error(KEY_MISMATCH_MESSAGE);
  }
  if (!deps.isRepoAllowed(owner, repo)) {
    throw new Error(
      `manual_intake: ${owner}/${repo} is not allowed by factory_config (owners / repo_allowlist)`,
    );
  }

  const row = await deps.readIntakeKey(key);
  if (
    input.body !==
      buildPostedIssueBody(
        {
          body: input.intakeBody,
          acceptance_criteria: input.acceptanceCriteria,
        },
        key,
      ) ||
    row === null ||
    row.issue_number !== issueNumber ||
    row.owner !== owner ||
    row.repo !== repo ||
    row.content_hash !==
      computeIntakeContentHash({
        owner,
        repo,
        title: input.title,
        body: input.intakeBody,
        acceptance_criteria: input.acceptanceCriteria,
        profile,
      })
  ) {
    throw new Error(KEY_MISMATCH_MESSAGE);
  }

  const ownerGate = await deps.verifyRepoOwner(owner, repo);
  if (!ownerGate.ok) {
    throw new Error(`manual_intake: ${ownerGate.reason}`);
  }

  // 取得済みのIssueには、新しいサイクルを始めない。再利用か新規かにかかわらず、作業項目の有無だけで決める。
  // 再利用かどうかは、ログの区別にだけ使う。
  const cycle = await deps.nextCycle(owner, repo, issueNumber);
  if (cycle !== 1) {
    deps.log.info("manual intake found a work item for the issue", {
      target: `${owner}/${repo}#${String(issueNumber)}`,
      reused: input.reused,
    });
    return manualIntakeSkippedResult(
      issueNumber,
      issueUrl,
      EXISTING_WORK_ITEM_REASON,
    );
  }

  const registered = await deps.insertWorkItem({
    cycle,
    source: "manual",
    kind: "issue",
    owner,
    repo,
    issue_number: issueNumber,
    issue_url: issueUrl,
    pr_number: null,
    title: input.title,
    body: input.body,
    status: "picked",
    attempt: 1,
    claimed_by: input.viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
    profile,
  });
  if (registered === null) {
    await recordClaimRaceLost(
      `${owner}/${repo}#${String(issueNumber)}`,
      ACTIVE_WORK_ITEM_EXISTS_REASON,
      deps.addNoticeUnlessUnresolved,
      deps.log,
    );
    return manualIntakeSkippedResult(
      issueNumber,
      issueUrl,
      ACTIVE_WORK_ITEM_EXISTS_REASON,
    );
  }

  return {
    skipped: false,
    work_item_id: registered.id,
    issue_number: issueNumber,
    issue_url: issueUrl,
    implement: await deps.startImplement(registered.id),
  };
}

/** 承認を省く進め方の起動が使う、DB・Windmill・Discordの呼び出し。テストでは差し替える。 */
export type PickedStartPorts = {
  readonly compareAndSwap: (
    id: number,
    from: WorkItemStatus,
    to: WorkItemStatus,
  ) => Promise<boolean>;
  readonly runFlowAsync: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly setFlowJobIdIfUnset: (id: number, jobId: string) => Promise<boolean>;
  readonly moveToNeedsHuman: (id: number, reason: string) => Promise<boolean>;
  readonly recordFailure: (record: FailureRecord) => Promise<unknown>;
  /** 要対応のnoticeを追加する。引数は、組み立て済みの本文。 */
  readonly addNotice: (message: string) => Promise<void>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
};

/**
 * 作業項目を`picked`から`implementing`へ移して、実装フローを起動する手順を組み立てる(`startImplement`)。
 * 要件定義の承認の後に起動する手順(`approved`から移す)とは別に持つ。承認の行が無く、`picked`から始まるためである。
 *
 * 移行が例外で終わると、作業項目は`picked`のまま残る。`picked`は終端でないので、`poll_issues`の照合が拾い、
 * 実行中のジョブが無いまま猶予を過ぎると失敗に移す。`startImplement`が失敗の記録とnoticeを残すので、
 * `approved`のように、人が見つけない限り残り続けることは無い。
 */
export function buildStartImplementFromPicked(
  ctx: {
    readonly workItemId: number;
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly log: Logger;
  },
  ports: PickedStartPorts,
): () => Promise<StartImplementOutcome> {
  const { workItemId, owner, repo, issueNumber, log } = ctx;
  const target = {
    owner,
    repo,
    issue_number: issueNumber,
    work_item_id: workItemId,
  };
  return () =>
    startImplement({
      casToImplementing: () =>
        ports.compareAndSwap(workItemId, "picked", "implementing"),
      launchFlow: () =>
        ports.runFlowAsync(IMPLEMENT_FLOW_PATH, { work_item_id: workItemId }),
      recordFlowJobId: (jobId) => ports.setFlowJobIdIfUnset(workItemId, jobId),
      moveToNeedsHuman: (reason) => ports.moveToNeedsHuman(workItemId, reason),
      recordFailure: async (reason, step) => {
        await ports.recordFailure({
          work_item_id: workItemId,
          flow_path: IMPLEMENT_FLOW_PATH,
          job_id: process.env.WM_JOB_ID ?? "unknown",
          step,
          error: reason,
        });
      },
      addNotice: (reason) =>
        ports.addNotice(buildImplementLaunchNoticeMessage(target, reason)),
      notifyNeedsHuman: (reason) => ports.notifyNeedsHuman(reason),
      log: (message, fields) =>
        log.warn(message, { work_item_id: workItemId, ...fields }),
    });
}

/**
 * `create_issue`の結果から登録する。進め方で道が分かれる(ファイルの先頭を参照)。
 * `profile`、`reused`、`intake_key`は、`create_issue`が検証した値を受ける。
 * `intake_body`と`acceptance_criteria`は、フローの入力のままで、承認を省く進め方がキーの表の行を照合するために使う。
 * 承認を省く進め方で冪等キーが無いときは、設定や外部に触れる前に例外を投げる。
 * 通常の進め方は、再利用したIssueを登録しない。ラベルが残っていれば`poll_issues`が拾う。
 */
export async function main(
  owner: string,
  repo: string,
  issue_number: number,
  issue_url: string,
  title: string,
  body: string,
  profile: string = "standard",
  reused?: boolean,
  intake_key?: string,
  intake_body?: string,
  acceptance_criteria?: string,
): Promise<ManualIntakeRegisterResult> {
  const log = logger("manual_intake_register");
  assertGitHubName(owner);
  assertGitHubName(repo);
  // ラベルを外す(取得)より前に断る。外した後に断ると、Issueがどの取得にも拾われなくなる。
  assertAcceptedProfile(profile);
  const key = normalizeIntakeKey(intake_key);
  if (key !== undefined) {
    assertIntakeKey(key);
  }
  assertIntakeKeyForProfile(profile, key);
  if (shouldSkipReusedStandard(profile, reused)) {
    return manualIntakeSkippedResult(
      issue_number,
      issue_url,
      INTAKE_REUSED_REASON,
    );
  }

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { ghToken };

  const viewer = await getViewer(client);

  if (skipsApprovals(profile)) {
    const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
    const intakeKeys = sqlIntakeKeyStore(defaultSqlClient);
    return await registerApprovalFreeIntake(
      {
        owner,
        repo,
        issueNumber: issue_number,
        title,
        body,
        viewerLogin: viewer.login,
        profile,
        reused: reused === true,
        intakeKey: key,
        intakeBody: intake_body ?? "",
        acceptanceCriteria: acceptance_criteria ?? "",
      },
      {
        implementEnabled: config.implement_enabled,
        isRepoAllowed: (owner, repo) => isRepoAllowed(config, owner, repo),
        verifyRepoOwner: (owner, repo) =>
          verifyRepoOwnerId(
            config,
            owner,
            repo,
            repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
          ),
        readIntakeKey: (intakeKey) => intakeKeys.read(intakeKey),
        nextCycle: (owner, repo, issueNumber) =>
          nextCycleForIssue(owner, repo, issueNumber),
        insertWorkItem: insertIssueWorkItemUnlessActive,
        addNoticeUnlessUnresolved,
        startImplement: (workItemId) =>
          buildStartImplementFromPicked(
            { workItemId, owner, repo, issueNumber: issue_number, log },
            {
              compareAndSwap: (id, from, to) =>
                updateStatusIfCurrentClearingFlowJobId(id, from, to, null),
              runFlowAsync: (path, args) => wmill.runFlowAsync(path, args),
              setFlowJobIdIfUnset,
              moveToNeedsHuman: (id, reason) =>
                updateStatusIfLeaseHolder(
                  id,
                  "implementing",
                  "needs_human",
                  null,
                  reason,
                ),
              recordFailure,
              addNotice: async (message) => {
                await addNoticeUnlessUnresolved({
                  kind: "implement_launch_failed",
                  message,
                });
              },
              notifyNeedsHuman: (reason) =>
                notifyNeedsHumanBestEffort(
                  {
                    workItem: {
                      id: workItemId,
                      owner,
                      repo,
                      issue_url: issueHtmlUrl(owner, repo, issue_number),
                      design_attempt: 0,
                    },
                    issueNumber: issue_number,
                    webhookUrl,
                    log,
                  },
                  config,
                  reason,
                  "implement",
                ),
            },
          )(),
        log,
      },
    );
  }

  const claim = await claimManualIntakeIssue({
    client,
    owner,
    repo,
    issueNumber: issue_number,
    triggerLabel: config.trigger_label,
    viewerLogin: viewer.login,
    log,
  });
  if (!claim.claimed) {
    return manualIntakeSkippedResult(issue_number, issue_url, claim.reason);
  }

  const workItemId = await registerManualIntakeWorkItem({
    owner,
    repo,
    issueNumber: issue_number,
    issueUrl: issue_url,
    title,
    body,
    viewerLogin: viewer.login,
    profile,
    log,
  });
  if (workItemId === null) {
    return manualIntakeSkippedResult(
      issue_number,
      issue_url,
      ACTIVE_WORK_ITEM_EXISTS_REASON,
    );
  }

  // 応答がジョブIDでなければ例外にし、起動の失敗と同じくステップを失敗させて`on_error_flow`に任せる。
  const flowJobId = parseFlowJobId(
    await wmill.runFlowAsync("f/factory/pipeline", {
      work_item_id: workItemId,
      attempt: 1,
    }),
    "runFlowAsync",
  );
  await setFlowJobId(workItemId, flowJobId);

  const webhookUrl = await wmill.getVariable("f/factory/discord_webhook_url");
  await notifyBestEffort(
    webhookUrl,
    {
      kind: "issue_claimed",
      instance_name: config.instance_name,
      owner,
      repo,
      issue_number,
      issue_url,
      title,
    },
    log,
  );

  return {
    skipped: false,
    work_item_id: workItemId,
    issue_number,
    issue_url,
    flow_job_id: flowJobId,
  };
}
