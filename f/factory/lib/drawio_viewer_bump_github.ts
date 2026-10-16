// draw.ioのビューアの固定を上げる`drawio_viewer_bump`だけが使う、GitHubの読み取りとブランチの作成。
// 一般の`github.ts`から切り離して、保護パスにしている。
// ここが書き換えられると、固定を書き換えるPRの元になる値(リリース、タグが指すcommit、
// ビューアのgit blobのID)と、ブランチの作り方を偽れるため、人のレビューを経ずには変えられない。
// 要求の送り方(レート制限、再試行)は`github.ts`の共通の処理を使う。

import {
  callGhApi,
  callGhApiRawBody,
  ensureSuccess,
  type GhClient,
  paginateGhApi,
  parseJsonBody,
  validateOwnerRepo,
} from "./github.ts";
import { assertBranchName, type GitIdentity, isRecord } from "./types.ts";

/** `GET /repos/{owner}/{repo}/releases`の1件のうち、版の選別に使う項目。 */
export type GitHubRelease = {
  readonly tagName: string;
  readonly publishedAt: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
};

function isGitHubReleasePayload(value: unknown): value is {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value.tag_name === "string" &&
    (value.published_at === null || typeof value.published_at === "string") &&
    typeof value.draft === "boolean" &&
    typeof value.prerelease === "boolean"
  );
}

/** 新しい順の先頭100件のリリースを返す。 */
export async function listReleases(
  client: GhClient,
  owner: string,
  repo: string,
): Promise<GitHubRelease[]> {
  validateOwnerRepo(owner, repo);
  const context = `GET releases ${owner}/${repo}`;
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/releases?per_page=100`,
  );
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (!Array.isArray(parsed)) {
    throw new Error(`${context}: expected an array response`);
  }
  return parsed.map((item) => {
    if (!isGitHubReleasePayload(item)) {
      throw new Error(`${context}: unexpected response shape`);
    }
    return {
      tagName: item.tag_name,
      publishedAt: item.published_at,
      draft: item.draft,
      prerelease: item.prerelease,
    };
  });
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readObjectId(value: unknown, context: string): string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    throw new Error(`${context}: unexpected object id`);
  }
  return value;
}

/**
 * タグが指すcommitのIDを返す。注釈付きタグは、タグのオブジェクトをたどってcommitまで解く。
 * commitに行き着かなければ例外を投げる。
 */
export async function resolveTagCommit(
  client: GhClient,
  owner: string,
  repo: string,
  tag: string,
): Promise<string> {
  validateOwnerRepo(owner, repo);
  if (!TAG_NAME.test(tag) || tag.includes("..")) {
    throw new Error(`invalid tag name: ${JSON.stringify(tag)}`);
  }
  const context = `GET tag ${owner}/${repo}@${tag}`;
  const refResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/git/ref/tags/${tag}`,
  );
  ensureSuccess(refResponse, context);
  const ref = parseJsonBody(refResponse, context);
  if (!isRecord(ref) || !isRecord(ref.object)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  const id = readObjectId(ref.object.sha, context);
  if (ref.object.type === "commit") return id;
  if (ref.object.type !== "tag") {
    throw new Error(
      `${context}: the tag points at a ${String(ref.object.type)}`,
    );
  }
  const tagResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/git/tags/${id}`,
  );
  ensureSuccess(tagResponse, `${context} (tag object)`);
  const tagObject = parseJsonBody(tagResponse, `${context} (tag object)`);
  if (
    !isRecord(tagObject) ||
    !isRecord(tagObject.object) ||
    tagObject.object.type !== "commit"
  ) {
    throw new Error(`${context}: the tag object does not point at a commit`);
  }
  return readObjectId(tagObject.object.sha, context);
}

/** ファイルのgit blobのIDと大きさ。 */
export type RepoFileMeta = {
  readonly sha: string;
  readonly size: number;
};

function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * `ref`(commitのID、ブランチ、タグ)の時点のファイルのgit blobのIDと大きさを返す。
 * Contents APIは、1MBを超えるファイルでも`sha`、`size`、`type`を返す(`content`だけが空になる)。
 */
export async function getRepoFileMeta(
  client: GhClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<RepoFileMeta> {
  validateOwnerRepo(owner, repo);
  const context = `GET contents ${owner}/${repo}:${path}@${ref}`;
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (
    !isRecord(parsed) ||
    parsed.type !== "file" ||
    typeof parsed.size !== "number"
  ) {
    throw new Error(`${context}: unexpected response shape`);
  }
  return { sha: readObjectId(parsed.sha, context), size: parsed.size };
}

/**
 * `ref`の時点のファイルを、文字列として読む。1MB以下のファイルに使う。
 * 内容を書き換えてコミットするので、制御列を除いて受け取ることはしない。
 * 制御列を含んで`gh`が本文を出さなかったときは、1回だけ取り直し、
 * 取り直しても欠けたときは、空のファイルとして読まず例外にする。
 */
export async function getRepoFileText(
  client: GhClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  validateOwnerRepo(owner, repo);
  const context = `GET contents ${owner}/${repo}:${path}@${ref}`;
  const response = await callGhApiRawBody(
    client,
    `repos/${owner}/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`,
    { acceptHeader: "application/vnd.github.raw+json" },
    context,
  );
  ensureSuccess(response, context);
  return response.bodyText;
}

/** ブランチの先頭のcommitのIDを返す。ブランチが無ければ`null`を返す。 */
export async function getBranchHeadSha(
  client: GhClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  validateOwnerRepo(owner, repo);
  assertBranchName(branch);
  const context = `GET ref ${owner}/${repo}@${branch}`;
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/git/ref/heads/${branch}`,
  );
  if (response.status === 404) return null;
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (!isRecord(parsed) || !isRecord(parsed.object)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  return readObjectId(parsed.object.sha, context);
}

/** ページ送りの上限。1ページ100件で、未完了のPRが1000件を超えることは想定しない。 */
const OPEN_PULL_REQUEST_MAX_PAGES = 10;

/**
 * このリポジトリのブランチをheadにした未完了のPRの、headのブランチ名を返す。
 * forkなど、headのリポジトリが違うPRは数えない。同じ名前のブランチを他のリポジトリに作られて、
 * 更新を止められないようにするためである。ページ送りは`OPEN_PULL_REQUEST_MAX_PAGES`ページまでで、
 * 超えたときは例外を投げる(重複を見落として進まないため)。
 */
export async function listOpenPullRequestHeads(
  client: GhClient,
  owner: string,
  repo: string,
): Promise<string[]> {
  validateOwnerRepo(owner, repo);
  const ownRepo = `${owner}/${repo}`.toLowerCase();
  const items = await paginateGhApi(
    client,
    `repos/${owner}/${repo}/pulls?state=open&per_page=100`,
    (parsed, context) => {
      if (!Array.isArray(parsed)) {
        throw new Error(`${context}: expected an array response`);
      }
      return parsed.map((item): string | null => {
        if (!isRecord(item) || !isRecord(item.head)) {
          throw new Error(`${context}: unexpected response shape`);
        }
        const ref = item.head.ref;
        if (typeof ref !== "string") {
          throw new Error(`${context}: unexpected response shape`);
        }
        const headRepo = item.head.repo;
        if (!isRecord(headRepo) || typeof headRepo.full_name !== "string") {
          return null;
        }
        return headRepo.full_name.toLowerCase() === ownRepo ? ref : null;
      });
    },
    OPEN_PULL_REQUEST_MAX_PAGES,
  );
  return items.filter((ref): ref is string => ref !== null);
}

/** 比較の結果の1ファイル。名前の変更は、`status`が`renamed`か、`previous_filename`がある。 */
export type ComparedFile = {
  readonly path: string;
  readonly renamed: boolean;
};

/**
 * `base`と`head`(ブランチ名かcommitのID)の差分(`base...head`)で変わるファイルを、パスの順に返す。
 * 3つのドットの比較は、分岐点からの`head`側の変更だけを数える。
 */
export async function compareChangedFiles(
  client: GhClient,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<ComparedFile[]> {
  validateOwnerRepo(owner, repo);
  assertBranchName(base);
  assertBranchName(head);
  const context = `GET compare ${owner}/${repo} ${base}...${head}`;
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/compare/${encodeRepoPath(base)}...${encodeRepoPath(head)}`,
  );
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  const files = parsed.files.map((file): ComparedFile => {
    if (!isRecord(file) || typeof file.filename !== "string") {
      throw new Error(`${context}: unexpected response shape`);
    }
    return {
      path: file.filename,
      renamed: file.status === "renamed" || "previous_filename" in file,
    };
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export type BranchFile = {
  /** リポジトリのルートからの相対パス。 */
  readonly path: string;
  readonly content: string;
};

export type CreateBranchWithFilesOptions = {
  readonly baseBranch: string;
  readonly branch: string;
  readonly message: string;
  readonly files: readonly BranchFile[];
  readonly identity: GitIdentity;
};

/**
 * `baseBranch`の先頭から1つのcommitを作り、`files`を書き換えた内容で`branch`を作る。
 * commitの作者と作成者は`identity`にする。個人のメールアドレスを書かないためである。
 * 作ったcommitのIDを返す。ブランチが既にあれば、GitHubが422を返して例外になる。
 */
export async function createBranchWithFiles(
  client: GhClient,
  owner: string,
  repo: string,
  opts: CreateBranchWithFilesOptions,
): Promise<string> {
  validateOwnerRepo(owner, repo);
  assertBranchName(opts.baseBranch);
  assertBranchName(opts.branch);
  const baseSha = await getBranchHeadSha(client, owner, repo, opts.baseBranch);
  if (baseSha === null) {
    throw new Error(
      `base branch not found: ${owner}/${repo}@${opts.baseBranch}`,
    );
  }
  const base = `repos/${owner}/${repo}/git`;

  const commitContext = `GET commit ${owner}/${repo}@${baseSha}`;
  const commitResponse = await callGhApi(client, `${base}/commits/${baseSha}`);
  ensureSuccess(commitResponse, commitContext);
  const baseCommit = parseJsonBody(commitResponse, commitContext);
  if (!isRecord(baseCommit) || !isRecord(baseCommit.tree)) {
    throw new Error(`${commitContext}: unexpected response shape`);
  }
  const baseTree = readObjectId(baseCommit.tree.sha, commitContext);

  const treeContext = `POST tree ${owner}/${repo}`;
  const treeResponse = await callGhApi(client, `${base}/trees`, {
    method: "POST",
    body: {
      base_tree: baseTree,
      tree: opts.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    },
  });
  ensureSuccess(treeResponse, treeContext);
  const tree = parseJsonBody(treeResponse, treeContext);
  if (!isRecord(tree)) {
    throw new Error(`${treeContext}: unexpected response shape`);
  }
  const treeSha = readObjectId(tree.sha, treeContext);

  const createContext = `POST commit ${owner}/${repo}`;
  const createResponse = await callGhApi(client, `${base}/commits`, {
    method: "POST",
    body: {
      message: opts.message,
      tree: treeSha,
      parents: [baseSha],
      author: { name: opts.identity.name, email: opts.identity.email },
      committer: { name: opts.identity.name, email: opts.identity.email },
    },
  });
  ensureSuccess(createResponse, createContext);
  const created = parseJsonBody(createResponse, createContext);
  if (!isRecord(created)) {
    throw new Error(`${createContext}: unexpected response shape`);
  }
  const commitSha = readObjectId(created.sha, createContext);

  const refContext = `POST ref ${owner}/${repo}@${opts.branch}`;
  const refResponse = await callGhApi(client, `${base}/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${opts.branch}`, sha: commitSha },
  });
  ensureSuccess(refResponse, refContext);
  return commitSha;
}
