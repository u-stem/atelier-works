// draw.ioのビューアの固定(console/drawio-viewer.json)を、新しい公式のリリースへ上げるPRを作る。
// 週に1回動く。判断は`lib/drawio_viewer_bump.ts`の純関数が行い、ここは取得、重複の確認、PRの作成だけを担う。
//
// 上げるのは、公開から14日以上たち、今と同じメジャー版の最新のリリースだけである。
// 取得したバイト列は、GitHubのAPIが返すgit blobのIDと大きさに照合する。
// メジャー版が違う版と、大きさが大きく変わる版は上げず、noticeに残す。
// 人は、noticeの手順で`approved_version`にその版を指定して、この処理を手で実行する。
// PRはDraftにせず、`factory:review`ラベルで自動レビューに回す。マージは人が行う。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { addNoticeUnlessUnresolved } from "./lib/db.ts";
import {
  buildBumpCommitMessage,
  buildBumpPrBody,
  buildBumpTitle,
  bumpBranchName,
  bumpBranchPrefix,
  DRAWIO_OWNER,
  DRAWIO_REPO,
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
  renderPin,
  rewriteViewerReference,
  sha256Hex,
  sizeChangeVerdict,
  VIEWER_PATH,
} from "./lib/drawio_viewer_bump.ts";
import {
  addLabels,
  type BranchFile,
  createBranchWithFiles,
  createPullRequest,
  type GhClient,
  type GitHubRelease,
  getBranchHeadSha,
  getDefaultBranch,
  getRepoFileMeta,
  getRepoFileText,
  getViewer,
  gitIdentityForViewer,
  listOpenPullRequestHeads,
  listPullRequestNumbersByHead,
  listReleases,
  type PullRequestRef,
  parseGitHubRepoUrl,
  type RepoFileMeta,
  resolveTagCommit,
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
  /** 上流の`commit`の時点のビューアのgit blobのIDと大きさを返す。 */
  readonly getViewerMeta: (commit: string) => Promise<RepoFileMeta>;
  readonly download: (commit: string) => Promise<Uint8Array>;
  /** 未完了のPRのheadのブランチ名。 */
  readonly listOpenHeads: () => Promise<string[]>;
  readonly branchExists: (branch: string) => Promise<boolean>;
  /** ブランチをheadにしたPRの数(閉じたものを含む)。 */
  readonly countPullRequests: (branch: string) => Promise<number>;
  readonly publish: (input: BumpPullRequestInput) => Promise<PullRequestRef>;
  /** 同じ本文の未解決のnoticeが無ければ挿入してIDを返し、あれば`null`を返す。 */
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
};

export type BumpResult =
  | { readonly outcome: "up_to_date" }
  | { readonly outcome: "waiting" }
  | { readonly outcome: "held"; readonly tag: string }
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

function heldMajorNotice(tag: string): NoticeRecord {
  return {
    kind: NOTICE_KIND,
    message: `draw.ioのビューアの新しいメジャー版${tag}は、自動では上げません。次の操作: 変更内容を確かめ、上げてよければ、${approvalCommand(tag)}`,
  };
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
 * - 重複の防止: 未完了の更新のPRがあるあいだは何もしない。同じ版のブランチにPRがあれば作らない。
 * - 照合: 取得したバイト列の大きさとgit blobのIDが、GitHubのAPIの値と違えば、PRを作らずnoticeに残す。
 * - 大きさ: 今の大きさから2割を超えて増減した版は、`approvedTag`の指名が無ければ、PRを作らずnoticeに残す。
 * 失敗はすべて例外にして、ジョブを失敗させる(スケジュールの失敗の通知に流れる)。次の週に再び試す。
 */
export async function runBump(
  deps: BumpDeps,
  approvedTag: string | null,
): Promise<BumpResult> {
  const pin = parsePinText(await deps.readBaseText(PIN_PATH));
  const releases = parseReleases(await deps.listReleases());
  const decision = decideBump(pin.version, releases, deps.now(), approvedTag);

  let heldTag: string | null = null;
  if (decision.held !== null) {
    heldTag = decision.held.tag;
    await deps.addNotice(heldMajorNotice(heldTag));
    deps.log.warn("a new major draw.io release is held", { tag: heldTag });
  }
  const target = decision.target;
  if (target === null) {
    if (heldTag !== null) return { outcome: "held", tag: heldTag };
    return { outcome: decision.waiting ? "waiting" : "up_to_date" };
  }

  const openHeads = await deps.listOpenHeads();
  const pending = openHeads.find((head) => head.startsWith(bumpBranchPrefix()));
  if (pending !== undefined) {
    deps.log.info("a bump pull request is still open", { branch: pending });
    return { outcome: "pull_request_pending", branch: pending };
  }
  const branch = bumpBranchName(target.tag);
  const branchExists = await deps.branchExists(branch);
  if (branchExists && (await deps.countPullRequests(branch)) > 0) {
    deps.log.info("this version was already proposed", { branch });
    return { outcome: "already_proposed", branch };
  }

  const commit = await deps.resolveTagCommit(target.tag);
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
  const sizeApproved = approvedTag === target.tag;
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
  const pr = await deps.publish({
    branch,
    title: buildBumpTitle(toVersion),
    message: buildBumpCommitMessage(pin.version, toVersion),
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
