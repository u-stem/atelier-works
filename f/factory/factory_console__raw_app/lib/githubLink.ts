// GitHubのIssueとPRのURLを、リンクにしてよい形だけ通す。

const GITHUB_ISSUE_OR_PULL_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?\/)[A-Za-z0-9._-]{1,100}\/(?:issues|pull)\/[1-9][0-9]*$/;

/**
 * `url`が`https://github.com/<owner>/<repo>/(issues|pull)/<n>`の形ならそのまま返し、
 * それ以外(nullを含む)ならnullを返す。
 * DBの値を`href`に入れる前に通す。`javascript:`などをリンクにしないため。
 */
export function safeGitHubUrl(url: string | null): string | null {
  if (url === null) return null;
  return GITHUB_ISSUE_OR_PULL_URL.test(url) ? url : null;
}
