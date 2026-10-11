// draw.ioのビューアの固定(console/drawio-viewer.json)を、新しい公式のリリースへ上げるPRを作る。
// 週に1回動く。判断は`lib/drawio_viewer_bump.ts`の純関数が行い、ここは取得、観測の記録、重複の確認、PRの作成だけを担う。
//
// 上げるのは、公開から14日以上たち、同じcommitを14日以上前から見ている最新のリリースだけである。
// 取得したバイト列は、GitHubのAPIが返すgit blobのIDと大きさに照合する。
// メジャー版が変わる版もPRにする。題名の`[major]`と本文の先頭の文で、人の確認を求める。
// 大きさが大きく変わる版と、照合に通らない版、中身の合わない既存のブランチは、上げずにnoticeに残す。
// 大きさの変化が正当なら、人が`approved_version`にその版を指定して手で実行する。
// 最新の版を保留にしている間は、それより古い版も上げない。保留の理由はnoticeに出る。
// PRはDraftにせず、`factory:review`ラベルで自動レビューに回す。マージは人が行う。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { addNoticeUnlessUnresolved } from "./lib/db.ts";
import {
  type BranchVerdict,
  buildBumpCommitMessage,
  buildBumpPrBody,
  buildBumpTitle,
  bumpBranchName,
  bumpBranchPrefix,
  compareVersions,
  DRAWIO_OWNER,
  DRAWIO_REPO,
  type DrawioRelease,
  decideBump,
  downloadViewer,
  formatVersion,
  gitBlobSha1,
  PAGE_PATH,
  PIN_PATH,
  parsePinText,
  parseReleases,
  parseReleaseVersion,
  pinUrlFor,
  releasesToObserve,
  renderPin,
  rewriteViewerReference,
  sha256Hex,
  sizeChangeVerdict,
  VIEWER_PATH,
  verifyBranchContents,
} from "./lib/drawio_viewer_bump.ts";
import {
  type BranchFile,
  compareChangedFiles,
  createBranchWithFiles,
  type GitHubRelease,
  getBranchHeadSha,
  getDefaultBranch,
  getRepoFileMeta,
  getRepoFileText,
  listOpenPullRequestHeads,
  listReleases,
  type RepoFileMeta,
  resolveTagCommit,
} from "./lib/drawio_viewer_bump_github.ts";
import { recordViewerObservation } from "./lib/drawio_viewer_observations.ts";
import {
  addLabels,
  createPullRequest,
  type GhClient,
  GitHubHttpError,
  getViewer,
  gitIdentityForViewer,
  listPullRequestNumbersByHead,
  type PullRequestRef,
  parseGitHubRepoUrl,
} from "./lib/github.ts";
import { type Logger, logger } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";

/** noticeの種類。保留した理由は本文に書く。 */
const NOTICE_KIND = "drawio_viewer_bump_held";
const SCRIPT_PATH = "f/factory/drawio_viewer_bump";

export type BumpPullRequestInput = {
  readonly branch: string;
  readonly title: string;
  readonly message: string;
  readonly body: string;
  readonly files: readonly BranchFile[];
  /** `false`のときは、既にあるブランチからPRだけを作る。 */
  readonly createBranch: boolean;
};

/** `runBump`が使う外部の操作。テストでは差し替える。 */
export type BumpDeps = {
  readonly now: () => Date;
  readonly log: Logger;
  /** Factoryのリポジトリの既定のブランチにあるファイルを読む。 */
  readonly readBaseText: (path: string) => Promise<string>;
  readonly listReleases: () => Promise<GitHubRelease[]>;
  /** タグが指すcommitのIDを返す。 */
  readonly resolveTagCommit: (tag: string) => Promise<string>;
  /** タグとcommitを記録し、そのcommitを最初に見た時刻を返す。付け替えられていれば取り直す。 */
  readonly observe: (tag: string, commit: string) => Promise<Date>;
  /** 上流の`commit`の時点のビューアのgit blobのIDと大きさを返す。 */
  readonly getViewerMeta: (commit: string) => Promise<RepoFileMeta>;
  readonly download: (commit: string) => Promise<Uint8Array>;
  /** 未完了のPRのheadのブランチ名。 */
  readonly listOpenHeads: () => Promise<string[]>;
  readonly branchExists: (branch: string) => Promise<boolean>;
  /** ブランチをheadにしたPRの数(閉じたものを含む)。 */
  readonly countPullRequests: (branch: string) => Promise<number>;
  /** PRの無い既存のブランチの中身が、`files`と一致し、差分がそのファイルだけかを確かめる。 */
  readonly verifyBranch: (
    branch: string,
    files: readonly BranchFile[],
  ) => Promise<BranchVerdict>;
  readonly publish: (input: BumpPullRequestInput) => Promise<PullRequestRef>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
};

export type BumpResult =
  | { readonly outcome: "up_to_date" }
  | { readonly outcome: "waiting" }
  | { readonly outcome: "pull_request_pending"; readonly branch: string }
  | { readonly outcome: "already_proposed"; readonly branch: string }
  | { readonly outcome: "rejected"; readonly tag: string }
  | {
      readonly outcome: "opened";
      readonly branch: string;
      readonly pr_url: string;
    };

function approvalCommand(tag: string): string {
  return `Windmillで${SCRIPT_PATH}を、approved_versionに${tag}を指定して実行してください`;
}

function rejectedNotice(
  tag: string,
  cause: string,
  nextAction: string,
): NoticeRecord {
  return {
    kind: NOTICE_KIND,
    message: `draw.ioのビューア${tag}へ上げませんでした(${cause})。次の操作: ${nextAction}`,
  };
}

/**
 * 固定を確かめ、上げる版があればPRを1件作る。
 * - 待ち: 公開から14日以上たち、同じcommitを14日以上前から見ている版だけを上げる。見始めた時刻は、タグごとに記録する。
 * - 重複の防止: 未完了の更新のPRがあるあいだは何もしない。同じ版のブランチをheadにしたPRが、閉じたものを含めて
 *   1件でもあれば作らない。
 * - 照合: 取得したバイト列の大きさとgit blobのIDが、GitHubのAPIの値と違えば、PRを作らずnoticeに残す。
 * - 大きさ: 今の大きさから2割を超えて増減した版は、`approvedTag`の指名が無ければ、PRを作らずnoticeに残す。
 * - 既存のブランチ: PRの無いブランチが既にあるときは、中身を確かめ、合わなければPRを作らずnoticeに残す。
 * - メジャー版: 変わる版も、他の確認を通ればPRにする。題名と本文で人の確認を求める。
 * 失敗はすべて例外にして、ジョブを失敗させる(スケジュールの失敗の通知に流れる)。次の週に再び試す。
 */
export async function runBump(
  deps: BumpDeps,
  approvedTag: string | null,
): Promise<BumpResult> {
  const pin = parsePinText(await deps.readBaseText(PIN_PATH));
  const releases = parseReleases(await deps.listReleases());

  const commits = new Map<string, string>();
  const observed: DrawioRelease[] = [];
  for (const release of releasesToObserve(pin.version, releases)) {
    let commit: string;
    try {
      commit = await deps.resolveTagCommit(release.tag);
    } catch (error) {
      // 1つのタグが壊れていても、他の版の観測は続ける。
      deps.log.warn("could not resolve the tag, skipping it", {
        tag: release.tag,
        error: error instanceof Error ? error.message : "unknown error",
      });
      continue;
    }
    commits.set(release.tag, commit);
    observed.push({
      ...release,
      firstSeenAt: await deps.observe(release.tag, commit),
    });
  }
  const decision = decideBump(pin.version, observed, deps.now(), approvedTag);

  const target = decision.target;
  if (target === null) {
    return { outcome: decision.waiting ? "waiting" : "up_to_date" };
  }

  const openHeads = await deps.listOpenHeads();
  const pending = openHeads.find((head) => head.startsWith(bumpBranchPrefix()));
  if (pending !== undefined) {
    deps.log.info("a bump pull request is still open", { branch: pending });
    return { outcome: "pull_request_pending", branch: pending };
  }
  const branch = bumpBranchName(target.tag);
  // ブランチが消されていても、閉じたPRが残っていれば、同じ版を提案し直さない。
  if ((await deps.countPullRequests(branch)) > 0) {
    deps.log.info("this version was already proposed", { branch });
    return { outcome: "already_proposed", branch };
  }

  const commit = commits.get(target.tag);
  if (commit === undefined) {
    throw new Error(`no observed commit for ${target.tag}`);
  }
  const currentMeta = await deps.getViewerMeta(pin.commit);
  const newMeta = await deps.getViewerMeta(commit);
  const bytes = await deps.download(commit);

  if (bytes.length !== newMeta.size || gitBlobSha1(bytes) !== newMeta.sha) {
    await deps.addNotice(
      rejectedNotice(
        target.tag,
        "取得したファイルがGitHubのAPIの記録と一致しません",
        "上流のリリースを確かめてください。次の週に再び試します",
      ),
    );
    deps.log.warn("the downloaded viewer does not match the git object", {
      tag: target.tag,
    });
    return { outcome: "rejected", tag: target.tag };
  }
  const sizeApproved = isApproved(approvedTag, target);
  const verdict = sizeChangeVerdict(
    currentMeta.size,
    bytes.length,
    sizeApproved,
  );
  if (!verdict.ok) {
    await deps.addNotice(
      verdict.kind === "changed"
        ? rejectedNotice(
            target.tag,
            `ビューアの大きさが${String(currentMeta.size)}バイトから${String(bytes.length)}バイトに変わり、上限を超えました`,
            `変更内容を確かめ、上げてよければ、${approvalCommand(target.tag)}`,
          )
        : rejectedNotice(
            target.tag,
            "ビューアの大きさが取り込める範囲にありません",
            "上流のリリースを確かめてください。次の版が出れば、自動で試します",
          ),
    );
    deps.log.warn("the new viewer size was rejected", {
      tag: target.tag,
      reason: verdict.reason,
    });
    return { outcome: "rejected", tag: target.tag };
  }

  const sha256 = sha256Hex(bytes);
  const toVersion = formatVersion(target.version);
  const page = await deps.readBaseText(PAGE_PATH);
  const files: BranchFile[] = [
    {
      path: PIN_PATH,
      content: renderPin({
        version: toVersion,
        commit,
        url: pinUrlFor(commit),
        sha256,
      }),
    },
    {
      path: PAGE_PATH,
      content: rewriteViewerReference(page, pin.sha256, sha256),
    },
  ];

  const branchExists = await deps.branchExists(branch);
  if (branchExists) {
    const branchVerdict = await deps.verifyBranch(branch, files);
    if (!branchVerdict.ok) {
      await deps.addNotice(
        rejectedNotice(
          target.tag,
          `既にあるブランチ${branch}の中身が、作るはずの内容と一致しません`,
          "ブランチの内容を確かめ、不要なら削除してください。削除すると、次の週に作り直します",
        ),
      );
      deps.log.warn("the existing bump branch does not match", {
        branch,
        reason: branchVerdict.reason,
      });
      return { outcome: "rejected", tag: target.tag };
    }
  }
  const pr = await deps.publish({
    branch,
    title: buildBumpTitle(pin.version, target.version),
    message: buildBumpCommitMessage(pin.version, target.version),
    body: buildBumpPrBody({
      from: pin.version,
      to: target,
      commit,
      sha256,
      oldSize: currentMeta.size,
      newSize: bytes.length,
      now: deps.now(),
      sizeApproved,
    }),
    files,
    createBranch: !branchExists,
  });
  deps.log.info("opened a draw.io viewer bump pull request", {
    branch,
    pr: pr.htmlUrl,
  });
  return { outcome: "opened", branch, pr_url: pr.htmlUrl };
}

/** 人の指名が、この版を指すか。`v`の有無によらず、版の数で比べる。 */
function isApproved(
  approvedTag: string | null,
  target: DrawioRelease,
): boolean {
  if (approvedTag === null) return false;
  const approved = parseReleaseVersion(approvedTag);
  return approved !== null && compareVersions(approved, target.version) === 0;
}

/** 人が指名する版を読む。空なら指名なし。版の形でなければ例外を投げる。結果は`v`付きのタグの形にそろえる。 */
export function parseApprovedVersion(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const version = parseReleaseVersion(trimmed);
  if (version === null) {
    throw new Error("approved_version must look like v33.0.0");
  }
  return `v${formatVersion(version)}`;
}

export async function main(approved_version = ""): Promise<BumpResult> {
  const approvedTag = parseApprovedVersion(approved_version);
  const log = logger("drawio_viewer_bump");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const repoRef = parseGitHubRepoUrl(config.factory_repo);
  const baseBranch = await getDefaultBranch(
    client,
    repoRef.owner,
    repoRef.repo,
  );
  const viewer = await getViewer(client);

  return await runBump(
    {
      now: () => new Date(),
      log,
      readBaseText: (path) =>
        getRepoFileText(client, repoRef.owner, repoRef.repo, path, baseBranch),
      listReleases: () => listReleases(client, DRAWIO_OWNER, DRAWIO_REPO),
      resolveTagCommit: (tag) =>
        resolveTagCommit(client, DRAWIO_OWNER, DRAWIO_REPO, tag),
      observe: (tag, commit) => recordViewerObservation(tag, commit),
      getViewerMeta: (commit) =>
        getRepoFileMeta(client, DRAWIO_OWNER, DRAWIO_REPO, VIEWER_PATH, commit),
      download: (commit) => downloadViewer(commit, fetch),
      listOpenHeads: () =>
        listOpenPullRequestHeads(client, repoRef.owner, repoRef.repo),
      branchExists: async (branch) =>
        (await getBranchHeadSha(
          client,
          repoRef.owner,
          repoRef.repo,
          branch,
        )) !== null,
      countPullRequests: async (branch) =>
        (
          await listPullRequestNumbersByHead(
            client,
            repoRef.owner,
            repoRef.repo,
            branch,
          )
        ).length,
      verifyBranch: (branch, files) =>
        verifyBranchContents(
          files,
          async (path) => {
            try {
              return (
                await getRepoFileMeta(
                  client,
                  repoRef.owner,
                  repoRef.repo,
                  path,
                  branch,
                )
              ).sha;
            } catch (error) {
              if (error instanceof GitHubHttpError && error.status === 404) {
                return null;
              }
              throw error;
            }
          },
          () =>
            compareChangedFiles(
              client,
              repoRef.owner,
              repoRef.repo,
              baseBranch,
              branch,
            ),
        ),
      publish: async (input) => {
        if (input.createBranch) {
          await createBranchWithFiles(client, repoRef.owner, repoRef.repo, {
            baseBranch,
            branch: input.branch,
            message: input.message,
            files: input.files,
            identity: gitIdentityForViewer(viewer),
          });
        }
        const pr = await createPullRequest(
          client,
          repoRef.owner,
          repoRef.repo,
          {
            head: input.branch,
            base: baseBranch,
            title: input.title,
            body: input.body,
          },
        );
        await addLabels(client, repoRef.owner, repoRef.repo, pr.number, [
          config.review_label,
        ]);
        return pr;
      },
      addNotice: (record) => addNoticeUnlessUnresolved(record),
    },
    approvedTag,
  );
}
