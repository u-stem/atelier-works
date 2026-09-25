// GitHub REST API access via `gh api` (spec-cycle2.md §1 github.ts, §7 item
// 1). Every call goes through the injected `run` (`CommandRunner`, from
// workspace.ts) executing `gh api ...` with an args array — never a shell
// string, and the token is only ever passed as the `GH_TOKEN` subprocess env
// var, never as a CLI argument or in a URL.
//
// Response parsing uses `gh api -i` (status line + headers + body on
// stdout — confirmed CRLF-terminated headers during the M4 contract smoke)
// so 403/429 rate-limit headers (`retry-after`, `x-ratelimit-remaining`)
// are visible without a second request.
//
// Self-reentry guard (spec-cycle2.md §7 item 1): every comment / review /
// reply the factory posts carries a `<!-- factory:<kind>:<work_item_id> -->`
// marker (`withMarker`); `hasMarker` / `isOwnPost` let pollers tell a human
// post from a factory one.

import { maskSecrets } from "./log.ts";
import type { FactoryOwnerKind, LabelerAssociation } from "./types.ts";
import { assertGitHubName } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

/** Validate both halves of an `owner/repo` pair before building any endpoint/URL with them. */
function validateOwnerRepo(owner: string, repo: string): void {
  assertGitHubName(owner);
  assertGitHubName(repo);
}

export type GhClient = {
  readonly run: CommandRunner;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  /** Injected delay for the single rate-limit retry. Defaults to a real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

function buildGhEnv(client: GhClient): Record<string, string> {
  const env: Record<string, string> = { GH_TOKEN: client.ghToken };
  const home = client.home ?? process.env.HOME;
  if (home !== undefined) env.HOME = home;
  const path = client.path ?? process.env.PATH;
  if (path !== undefined) env.PATH = path;
  return env;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Low-level `gh api -i` request/response plumbing
// ---------------------------------------------------------------------------

export type GhApiResponse = {
  readonly status: number;
  /** Header names lowercased. */
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyText: string;
};

function parseGhApiOutput(stdout: string): GhApiResponse {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  const headSection =
    separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const bodyText =
    separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 2);

  const headLines = headSection.split("\n");
  const statusLine = headLines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  const status =
    statusMatch !== null && statusMatch[1] !== undefined
      ? Number(statusMatch[1])
      : 0;

  const headers = new Map<string, string>();
  for (const line of headLines.slice(1)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    headers.set(
      line.slice(0, colonIndex).trim().toLowerCase(),
      line.slice(colonIndex + 1).trim(),
    );
  }

  return { status, headers, bodyText };
}

function isRateLimited(response: GhApiResponse): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.headers.has("retry-after")) return true;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

function computeRetryWaitMs(
  headers: ReadonlyMap<string, string>,
  now: () => Date,
): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== undefined) {
    const resetEpochSeconds = Number(reset);
    if (Number.isFinite(resetEpochSeconds)) {
      const waitMs = resetEpochSeconds * 1000 - now().getTime();
      return waitMs > 0 ? waitMs : 0;
    }
  }
  return 60_000;
}

export type GhApiCallOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serializable request body, sent via `--input -`. */
  readonly body?: unknown;
  readonly acceptHeader?: string;
};

async function callGhApiOnce(
  client: GhClient,
  endpoint: string,
  options: GhApiCallOptions,
): Promise<GhApiResponse> {
  const argv = ["gh", "api", endpoint, "-i"];
  if (options.method !== undefined) argv.push("-X", options.method);
  if (options.acceptHeader !== undefined)
    argv.push("-H", `Accept: ${options.acceptHeader}`);
  if (options.body !== undefined) argv.push("--input", "-");

  const stdin =
    options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const commandResult = await client.run(argv, {
    env: buildGhEnv(client),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  return parseGhApiOutput(commandResult.stdout);
}

/**
 * Call `gh api <endpoint>`, retrying exactly once after waiting out a
 * rate-limit response (spec-cycle2.md §1 github.ts). Does not throw on HTTP
 * error status — callers check `response.status` (see `ensureSuccess`).
 */
async function callGhApi(
  client: GhClient,
  endpoint: string,
  options: GhApiCallOptions = {},
): Promise<GhApiResponse> {
  const first = await callGhApiOnce(client, endpoint, options);
  if (!isRateLimited(first)) return first;

  const sleep = client.sleep ?? defaultSleep;
  const now = client.now ?? (() => new Date());
  await sleep(computeRetryWaitMs(first.headers, now));

  return callGhApiOnce(client, endpoint, options);
}

function ensureSuccess(response: GhApiResponse, context: string): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new Error(
    maskSecrets(
      `${context} failed with HTTP ${response.status}: ${response.bodyText.slice(0, 500)}`,
    ),
  );
}

function parseJsonBody(response: GhApiResponse, context: string): unknown {
  try {
    return JSON.parse(response.bodyText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      maskSecrets(`${context}: response body is not valid JSON (${reason})`),
    );
  }
}

function parseNextLinkUrl(linkHeader: string | undefined): string | null {
  if (linkHeader === undefined) return null;
  // RFC 8288 Link header: `<url1>; rel="prev", <url2>; rel="next", ...`
  for (const segment of linkHeader.split(",")) {
    const match = segment.match(/<([^>]+)>;\s*rel="next"/);
    if (match !== null && match[1] !== undefined) return match[1];
  }
  return null;
}

/** A `link` header's absolute URL -> the relative `gh api` endpoint form used everywhere else in this module. */
function toApiEndpoint(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, "");
}

/**
 * Follow the `link` response header's `rel="next"` pages until exhausted,
 * extracting and concatenating each page's items via `extractPage` (which
 * differs by endpoint shape: a bare JSON array for timeline/comments/
 * reviews, vs a `{ items: [...] }` envelope for `/search/issues`).
 */
async function paginateGhApi<T>(
  client: GhClient,
  endpoint: string,
  extractPage: (parsed: unknown, context: string) => readonly T[],
): Promise<T[]> {
  const results: T[] = [];
  let nextEndpoint: string | null = endpoint;
  while (nextEndpoint !== null) {
    const response = await callGhApi(client, nextEndpoint);
    const context = `GET ${nextEndpoint}`;
    ensureSuccess(response, context);
    const parsed = parseJsonBody(response, context);
    results.push(...extractPage(parsed, context));
    const nextUrl = parseNextLinkUrl(response.headers.get("link"));
    nextEndpoint = nextUrl !== null ? toApiEndpoint(nextUrl) : null;
  }
  return results;
}

/**
 * Like `callGhApi`, but follows pagination, concatenating each page's JSON
 * array body. Used wherever an unbounded GitHub collection (timeline,
 * comments, reviews, review comments) could span more than one page.
 */
async function callGhApiAll(
  client: GhClient,
  endpoint: string,
): Promise<unknown[]> {
  return paginateGhApi(client, endpoint, (parsed, context) => {
    if (!Array.isArray(parsed)) {
      throw new Error(`${context}: expected an array response for pagination`);
    }
    return parsed;
  });
}

// ---------------------------------------------------------------------------
// Marker helpers (spec-cycle2.md §7 item 1)
// ---------------------------------------------------------------------------

// A marker must be the entire last non-blank line of the text: anchored to
// a line start/end (`^...$`, multiline) so a quoted marker (`> <!-- ... -->`,
// which never starts a line with literal `<!--`) never matches, and
// additionally checked (in `lastMarkerMatch`) to be the very last such line
// so a marker embedded mid-message — e.g. pasted into a much longer human
// reply — isn't read as authoritative either.
const MARKER_LINE_PATTERN = /^<!--\s*factory:([a-z0-9_-]+):(\d+)\s*-->\s*$/gm;

function lastMarkerMatch(text: string): RegExpExecArray | null {
  const trimmed = text.replace(/\s+$/, "");
  const pattern = new RegExp(
    MARKER_LINE_PATTERN.source,
    MARKER_LINE_PATTERN.flags,
  );
  let match: RegExpExecArray | null = null;
  for (
    let current = pattern.exec(trimmed);
    current !== null;
    current = pattern.exec(trimmed)
  ) {
    match = current;
  }
  if (match === null) return null;
  if (match.index + match[0].length !== trimmed.length) return null;
  return match;
}

/** Append a `<!-- factory:<kind>:<work_item_id> -->` marker to `body`. */
export function withMarker(
  kind: string,
  workItemId: number,
  body: string,
): string {
  return `${body}\n\n<!-- factory:${kind}:${workItemId} -->`;
}

/**
 * Whether `text` ends with a factory marker on its own line. Without
 * `kind`/`workItemId`, matches any factory marker (used to recognize "this
 * post came from the factory itself" regardless of which work item posted
 * it) — but see spec-cycle2.md §7 item 1 / the security-audit fix: a marker
 * alone must never be treated as proof of factory authorship on its own;
 * callers must additionally require `isOwnPost(login, viewer)`.
 */
export function hasMarker(
  text: string,
  kind?: string,
  workItemId?: number,
): boolean {
  const match = lastMarkerMatch(text);
  if (match === null) return false;
  if (kind !== undefined && match[1] !== kind) return false;
  if (workItemId !== undefined && Number(match[2]) !== workItemId) return false;
  return true;
}

/** Whether `login` is the factory's own GitHub account. Case-insensitive (GitHub logins are). */
export function isOwnPost(login: string, viewer: string): boolean {
  return login.toLowerCase() === viewer.toLowerCase();
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export type Viewer = { readonly login: string };

/** `{ login: string }` — shared by `getViewer` and any GitHub "actor" object (e.g. timeline events). */
type LoginPayload = { readonly login: string };

function isLoginPayload(value: unknown): value is LoginPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("login" in value)) return false;
  return typeof (value as { login: unknown }).login === "string";
}

export async function getViewer(client: GhClient): Promise<Viewer> {
  const response = await callGhApi(client, "user");
  ensureSuccess(response, "GET /user");
  const parsed = parseJsonBody(response, "GET /user");
  if (!isLoginPayload(parsed)) {
    throw new Error("GET /user: unexpected response shape");
  }
  return { login: parsed.login };
}

// ---------------------------------------------------------------------------
// Issue search / read / claim / comment / labels
// ---------------------------------------------------------------------------

function ownerQualifier(owner: string, ownerKind: FactoryOwnerKind): string {
  return ownerKind === "org" ? `org:${owner}` : `user:${owner}`;
}

function repoFromRepositoryUrl(repositoryUrl: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`unexpected repository_url shape: ${repositoryUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

export type IssueSearchItem = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  readonly authorLogin: string;
};

type SearchIssuesPayload = {
  readonly items: readonly SearchIssueItemPayload[];
};

type SearchIssueItemPayload = {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly repository_url: string;
  readonly user: { readonly login: string } | null;
};

function isSearchIssueItemPayload(
  value: unknown,
): value is SearchIssueItemPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    number: unknown;
    title: unknown;
    body: unknown;
    html_url: unknown;
    repository_url: unknown;
    user: unknown;
  };
  if (typeof record.number !== "number") return false;
  if (typeof record.title !== "string") return false;
  if (record.body !== null && typeof record.body !== "string") return false;
  if (typeof record.html_url !== "string") return false;
  if (typeof record.repository_url !== "string") return false;
  if (record.user !== null && typeof record.user !== "object") return false;
  return true;
}

function isSearchIssuesPayload(value: unknown): value is SearchIssuesPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("items" in value)) return false;
  const items = (value as { items: unknown }).items;
  return Array.isArray(items) && items.every(isSearchIssueItemPayload);
}

/**
 * Like `callGhApiAll`, but for the `/search/issues` envelope
 * (`{ items: [...] }` rather than a bare array).
 */
async function callGhApiAllSearchItems(
  client: GhClient,
  endpoint: string,
): Promise<SearchIssueItemPayload[]> {
  return paginateGhApi(client, endpoint, (parsed, context) => {
    if (!isSearchIssuesPayload(parsed)) {
      throw new Error(`${context}: unexpected response shape`);
    }
    return parsed.items;
  });
}

export type SearchIssuesOptions = {
  readonly owner: string;
  readonly ownerKind: FactoryOwnerKind;
  readonly label: string;
  readonly notLabel: string;
};

/** `GET /search/issues` (paginated) for open, non-PR issues with `label` and without `notLabel`. */
export async function searchIssues(
  client: GhClient,
  opts: SearchIssuesOptions,
): Promise<IssueSearchItem[]> {
  assertGitHubName(opts.owner);
  const query = `is:issue state:open ${ownerQualifier(opts.owner, opts.ownerKind)} label:${opts.label} -label:${opts.notLabel}`;
  const items = await callGhApiAllSearchItems(
    client,
    `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );
  return items.map((item) => {
    const { owner, repo } = repoFromRepositoryUrl(item.repository_url);
    return {
      owner,
      repo,
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      htmlUrl: item.html_url,
      authorLogin: item.user?.login ?? "",
    };
  });
}

export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string;
  readonly state: string;
  readonly authorLogin: string;
  readonly labels: string[];
};

/** `{ name: string }` — shared by label objects (`{ name, ... }` label shape). */
type NamedPayload = { readonly name: string };

function isNamedPayload(value: unknown): value is NamedPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value)) return false;
  return typeof (value as { name: unknown }).name === "string";
}

/** GitHub returns issue labels as either a bare string or `{ name, ... }`; extract the name either way. */
function labelName(label: unknown): string | null {
  if (typeof label === "string") return label;
  if (isNamedPayload(label)) return label.name;
  return null;
}

type IssuePayload = {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly state: string;
  readonly user: { readonly login: string } | null;
  readonly labels: readonly unknown[];
};

function isIssuePayload(value: unknown): value is IssuePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    number: unknown;
    title: unknown;
    body: unknown;
    html_url: unknown;
    state: unknown;
    user: unknown;
    labels: unknown;
  };
  if (typeof record.number !== "number") return false;
  if (typeof record.title !== "string") return false;
  if (record.body !== null && typeof record.body !== "string") return false;
  if (typeof record.html_url !== "string") return false;
  if (typeof record.state !== "string") return false;
  if (!Array.isArray(record.labels)) return false;
  return true;
}

export async function getIssue(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<Issue> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}`,
  );
  ensureSuccess(response, `GET issue ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `GET issue ${owner}/${repo}#${number}`,
  );
  if (!isIssuePayload(parsed)) {
    throw new Error(
      `GET issue ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  const labels: string[] = [];
  for (const raw of parsed.labels) {
    const name = labelName(raw);
    if (name !== null) labels.push(name);
  }
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    htmlUrl: parsed.html_url,
    state: parsed.state,
    authorLogin: parsed.user?.login ?? "",
    labels,
  };
}

export type LabeledTimelineEvent = {
  readonly event: "labeled";
  readonly actorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly label: string;
  readonly createdAt: string | null;
};

type TimelineEventPayload = {
  readonly event: unknown;
  readonly actor: unknown;
  readonly label: unknown;
  readonly author_association: unknown;
  readonly created_at: unknown;
};

function isTimelineEventPayload(value: unknown): value is TimelineEventPayload {
  return typeof value === "object" && value !== null && "event" in value;
}

/**
 * `GET .../timeline` (paginated), returning only the *last* `labeled`
 * event (spec-cycle2.md §7 item 1 security-audit fix: the label may have
 * been removed and re-added by a different actor, so the most recent
 * labeling — not just any labeling — is what `poll_issues` must check
 * against docs/security.md's "public リポジトリでのラベル付与制限"). `null`
 * if the issue was never labeled (shouldn't happen for an issue we found
 * via a label-scoped search, but handled defensively).
 */
export async function getIssueTimeline(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<LabeledTimelineEvent | null> {
  validateOwnerRepo(owner, repo);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
  );

  let last: LabeledTimelineEvent | null = null;
  for (const raw of parsed) {
    if (!isTimelineEventPayload(raw)) continue;
    if (raw.event !== "labeled") continue;
    const actorLogin = isLoginPayload(raw.actor) ? raw.actor.login : null;
    const resolvedLabelName = labelName(raw.label);
    if (actorLogin === null || resolvedLabelName === null) continue;
    last = {
      event: "labeled",
      actorLogin,
      authorAssociation:
        typeof raw.author_association === "string"
          ? raw.author_association
          : null,
      label: resolvedLabelName,
      createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    };
  }
  return last;
}

export type ClaimIssueOptions = {
  readonly wipLabel: string;
  readonly assignee: string;
};

export type ClaimIssueResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly reason: string };

/**
 * Claim an issue: add `wipLabel`, assign `assignee`, then re-fetch to
 * confirm both stuck (spec-cycle2.md §1 github.ts "claimIssue... 再取得で確認")
 * — guards against a race with another factory instance claiming first.
 */
export async function claimIssue(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: ClaimIssueOptions,
): Promise<ClaimIssueResult> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(opts.assignee);

  const labelResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/labels`,
    {
      method: "POST",
      body: { labels: [opts.wipLabel] },
    },
  );
  ensureSuccess(labelResponse, `POST issue labels ${owner}/${repo}#${number}`);

  const assigneeResponse = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/assignees`,
    {
      method: "POST",
      body: { assignees: [opts.assignee] },
    },
  );
  ensureSuccess(
    assigneeResponse,
    `POST issue assignees ${owner}/${repo}#${number}`,
  );

  const confirmed = await getIssue(client, owner, repo, number);
  if (!confirmed.labels.includes(opts.wipLabel)) {
    return {
      claimed: false,
      reason: `wip label ${opts.wipLabel} missing after claim`,
    };
  }
  return { claimed: true };
}

/**
 * Idempotent (marker-checked) issue comment. `viewer` (the factory's own
 * GitHub login, from `getViewer`) is required: a comment only counts as
 * "already posted by us" when it's both `isOwnPost` *and* carries the
 * marker — a marker alone is not proof of authorship (spec-cycle2.md §7
 * item 1 / security-audit fix), since anyone could paste a matching
 * `<!-- factory:... -->` line into their own comment.
 */
export async function commentIssue(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  kind: string,
  workItemId: number,
  body: string,
  viewer: string,
): Promise<{ readonly id: number; readonly created: boolean }> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(viewer);

  const existingId = await findExistingMarkerComment(
    client,
    owner,
    repo,
    number,
    kind,
    workItemId,
    viewer,
  );
  if (existingId !== null) {
    return { id: existingId, created: false };
  }

  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      body: { body: withMarker(kind, workItemId, body) },
    },
  );
  ensureSuccess(response, `POST issue comment ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `POST issue comment ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST issue comment ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id, created: true };
}

type IdPayload = { readonly id: number };

function isIdPayload(value: unknown): value is IdPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value)) return false;
  return typeof (value as { id: unknown }).id === "number";
}

type CommentBodyPayload = {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string } | null;
};

function isCommentBodyPayload(value: unknown): value is CommentBodyPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id: unknown; body: unknown; user: unknown };
  if (typeof record.id !== "number") return false;
  if (typeof record.body !== "string") return false;
  return record.user === null || isLoginPayload(record.user);
}

async function findExistingMarkerComment(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  kind: string,
  workItemId: number,
  viewer: string,
): Promise<number | null> {
  const items = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  );
  for (const raw of items) {
    if (!isCommentBodyPayload(raw)) continue;
    if (raw.user === null || !isOwnPost(raw.user.login, viewer)) continue;
    if (hasMarker(raw.body, kind, workItemId)) return raw.id;
  }
  return null;
}

export type IssueComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
};

export type ListIssueCommentsOptions = {
  readonly viewer: string;
  /** Only comments with an id greater than this are returned (the caller's
   * `last_comment_id` high-water mark); omit to return every human comment. */
  readonly sinceId?: number;
};

/**
 * `GET .../issues/{number}/comments` (paginated), filtered to human,
 * non-marker comments newer than `sinceId` — mirrors `listPrReviews`'s
 * shape (viewer-exclusion, `{ items, maxId }`). Feeds the `/factory fix`
 * slash-command trigger detector (poll_prs.ts): a comment is excluded here
 * when it's `isOwnPost` for `viewer` OR carries a factory marker. Unlike
 * `listPrReviews`/`listPrReviewComments` (security-audit fix: a marker
 * alone is never proof of authorship for *review-visibility* purposes),
 * excluding on marker alone here doesn't reopen that hole — the exact-match
 * `/factory fix` command text can never coexist with an appended marker
 * line in the same comment body, so this only ever drops comments that
 * could never have matched the command anyway.
 */
export async function listIssueComments(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: ListIssueCommentsOptions,
): Promise<ListHumanResult<IssueComment>> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(opts.viewer);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  );

  let maxId = 0;
  const items: IssueComment[] = [];
  for (const raw of parsed) {
    if (!isCommentBodyPayload(raw)) continue;
    if (raw.id > maxId) maxId = raw.id;
    if (opts.sinceId !== undefined && raw.id <= opts.sinceId) continue;
    const login = raw.user?.login;
    if (typeof login === "string" && isOwnPost(login, opts.viewer)) continue;
    if (hasMarker(raw.body)) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      body: raw.body,
    });
  }
  return { items, maxId };
}

export async function setLabels(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  labels: readonly string[],
): Promise<void> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/labels`,
    {
      method: "PUT",
      body: { labels },
    },
  );
  ensureSuccess(response, `PUT issue labels ${owner}/${repo}#${number}`);
}

export async function removeLabel(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  label: string,
): Promise<void> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
    },
  );
  if (response.status === 404) return; // already absent — nothing to do
  ensureSuccess(response, `DELETE issue label ${owner}/${repo}#${number}`);
}

export type CreateIssueOptions = {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
};

export async function createIssue(
  client: GhClient,
  owner: string,
  repo: string,
  opts: CreateIssueOptions,
): Promise<{ readonly number: number; readonly htmlUrl: string }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(client, `repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: {
      title: opts.title,
      body: opts.body,
      ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    },
  });
  ensureSuccess(response, `POST issue ${owner}/${repo}`);
  const parsed = parseJsonBody(response, `POST issue ${owner}/${repo}`);
  if (!isIssuePayload(parsed)) {
    throw new Error(`POST issue ${owner}/${repo}: unexpected response shape`);
  }
  return { number: parsed.number, htmlUrl: parsed.html_url };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export type PrSearchItem = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
};

export type SearchPrsOptions = {
  readonly owner: string;
  readonly ownerKind: FactoryOwnerKind;
  readonly viewer: string;
  readonly reviewLabel: string;
  readonly wipLabel: string;
};

/**
 * `GET /search/issues` scoped to PRs: review-requested, assigned, or
 * labeled `reviewLabel`, excluding `wipLabel` (spec-cycle2.md §7 item 1).
 */
export async function searchPrs(
  client: GhClient,
  opts: SearchPrsOptions,
): Promise<PrSearchItem[]> {
  assertGitHubName(opts.owner);
  assertGitHubName(opts.viewer);
  const query = `is:pr state:open ${ownerQualifier(opts.owner, opts.ownerKind)} -label:${opts.wipLabel} (review-requested:${opts.viewer} OR assignee:${opts.viewer} OR label:${opts.reviewLabel})`;
  const items = await callGhApiAllSearchItems(
    client,
    `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );
  return items.map((item) => {
    const { owner, repo } = repoFromRepositoryUrl(item.repository_url);
    return {
      owner,
      repo,
      number: item.number,
      title: item.title,
      htmlUrl: item.html_url,
    };
  });
}

export type PullRequest = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly baseRef: string;
  readonly mergeableState: string | null;
  readonly authorLogin: string;
};

type PrPayload = {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly head: {
    readonly sha: string;
    readonly ref: string;
    readonly repo: { readonly full_name: unknown } | null;
  };
  readonly base: {
    readonly ref: string;
    readonly repo: { readonly full_name: unknown } | null;
  };
  readonly mergeable_state: unknown;
  readonly user: { readonly login: string } | null;
};

function isPrPayload(value: unknown): value is PrPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    number: unknown;
    title: unknown;
    body: unknown;
    draft: unknown;
    state: unknown;
    merged: unknown;
    head: unknown;
    base: unknown;
  };
  if (typeof record.number !== "number") return false;
  if (typeof record.title !== "string") return false;
  if (record.body !== null && typeof record.body !== "string") return false;
  if (typeof record.draft !== "boolean") return false;
  if (record.state !== "open" && record.state !== "closed") return false;
  if (typeof record.merged !== "boolean") return false;
  if (typeof record.head !== "object" || record.head === null) return false;
  if (typeof record.base !== "object" || record.base === null) return false;
  const head = record.head as { sha: unknown; ref: unknown };
  const base = record.base as { ref: unknown };
  if (typeof head.sha !== "string") return false;
  if (typeof head.ref !== "string") return false;
  if (typeof base.ref !== "string") return false;
  return true;
}

export async function getPr(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}`,
  );
  ensureSuccess(response, `GET pr ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(response, `GET pr ${owner}/${repo}#${number}`);
  if (!isPrPayload(parsed)) {
    throw new Error(
      `GET pr ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  const headRepoFullName =
    parsed.head.repo !== null && typeof parsed.head.repo.full_name === "string"
      ? parsed.head.repo.full_name
      : null;
  const baseRepoFullName =
    parsed.base.repo !== null && typeof parsed.base.repo.full_name === "string"
      ? parsed.base.repo.full_name
      : "";
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    draft: parsed.draft === true,
    state: parsed.state,
    merged: parsed.merged,
    headSha: parsed.head.sha,
    headRef: parsed.head.ref,
    headRepoFullName,
    baseRepoFullName,
    baseRef: parsed.base.ref,
    mergeableState:
      typeof parsed.mergeable_state === "string"
        ? parsed.mergeable_state
        : null,
    authorLogin: parsed.user?.login ?? "",
  };
}

export type PrDiff = {
  readonly diff: string;
  readonly truncated: boolean;
  readonly totalLines: number;
};

/** Raw unified diff via the `application/vnd.github.v3.diff` media type, truncated to `maxLines`. */
export async function getPrDiff(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  maxLines: number,
): Promise<PrDiff> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}`,
    {
      acceptHeader: "application/vnd.github.v3.diff",
    },
  );
  ensureSuccess(response, `GET pr diff ${owner}/${repo}#${number}`);
  const lines = response.bodyText.split("\n");
  if (lines.length <= maxLines) {
    return {
      diff: response.bodyText,
      truncated: false,
      totalLines: lines.length,
    };
  }
  return {
    diff: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}

export type PrFile = {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
};

type PrFilePayload = {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
};

function isPrFilePayload(value: unknown): value is PrFilePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    filename: unknown;
    status: unknown;
    additions: unknown;
    deletions: unknown;
    changes: unknown;
  };
  return (
    typeof record.filename === "string" &&
    typeof record.status === "string" &&
    typeof record.additions === "number" &&
    typeof record.deletions === "number" &&
    typeof record.changes === "number"
  );
}

/** `GET .../pulls/{number}/files` (paginated), the PR's changed-file list. */
export async function getPrFiles(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<PrFile[]> {
  validateOwnerRepo(owner, repo);
  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
  );
  const items: PrFile[] = [];
  for (const raw of parsed) {
    if (!isPrFilePayload(raw)) continue;
    items.push({
      filename: raw.filename,
      status: raw.status,
      additions: raw.additions,
      deletions: raw.deletions,
      changes: raw.changes,
    });
  }
  return items;
}

export type PrReview = {
  readonly id: number;
  readonly authorLogin: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string | null;
};

type PrReviewPayload = {
  readonly id: number;
  readonly user: { readonly login: string } | null;
  readonly state: string;
  readonly body: string;
  readonly submitted_at: unknown;
};

function isPrReviewPayload(value: unknown): value is PrReviewPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id: unknown; state: unknown; body: unknown };
  return (
    typeof record.id === "number" &&
    typeof record.state === "string" &&
    typeof record.body === "string"
  );
}

export type ListHumanResult<T> = {
  readonly items: T[];
  /** Max id seen across ALL reviews/comments (human and factory-authored), for tracking `last_review_id` / `last_comment_id`. */
  readonly maxId: number;
};

/**
 * `GET .../reviews` (paginated), filtered to human reviews. A review is
 * excluded only when `isOwnPost(login, viewer)` — a marker alone is never
 * sufficient (spec-cycle2.md §7 item 1 / security-audit fix): anyone could
 * paste a matching marker line into their own review to get it ignored.
 */
export async function listPrReviews(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  viewer: string,
): Promise<ListHumanResult<PrReview>> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(viewer);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
  );

  let maxId = 0;
  const items: PrReview[] = [];
  for (const raw of parsed) {
    if (!isPrReviewPayload(raw)) continue;
    if (raw.id > maxId) maxId = raw.id;
    const login = raw.user?.login;
    if (typeof login === "string" && isOwnPost(login, viewer)) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      state: raw.state,
      body: raw.body,
      submittedAt:
        typeof raw.submitted_at === "string" ? raw.submitted_at : null,
    });
  }
  return { items, maxId };
}

export type PrReviewComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

type PrReviewCommentPayload = {
  readonly id: number;
  readonly user: { readonly login: string } | null;
  readonly path: string;
  readonly line: unknown;
  readonly body: string;
};

function isPrReviewCommentPayload(
  value: unknown,
): value is PrReviewCommentPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id: unknown; path: unknown; body: unknown };
  return (
    typeof record.id === "number" &&
    typeof record.path === "string" &&
    typeof record.body === "string"
  );
}

/**
 * `GET .../comments` (inline review comments, paginated), filtered to human
 * posts. Excluded only via `isOwnPost(login, viewer)` — same reasoning as
 * `listPrReviews`.
 */
export async function listPrReviewComments(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  viewer: string,
): Promise<ListHumanResult<PrReviewComment>> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(viewer);

  const parsed = await callGhApiAll(
    client,
    `repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
  );

  let maxId = 0;
  const items: PrReviewComment[] = [];
  for (const raw of parsed) {
    if (!isPrReviewCommentPayload(raw)) continue;
    if (raw.id > maxId) maxId = raw.id;
    const login = raw.user?.login;
    if (typeof login === "string" && isOwnPost(login, viewer)) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      path: raw.path,
      line: typeof raw.line === "number" ? raw.line : null,
      body: raw.body,
    });
  }
  return { items, maxId };
}

export type ReviewComment = {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
};

export type CreatePrReviewOptions = {
  readonly event: "COMMENT";
  readonly body: string;
  readonly comments: readonly ReviewComment[];
};

export async function createPrReview(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: CreatePrReviewOptions,
): Promise<{ readonly id: number }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}/reviews`,
    {
      method: "POST",
      body: { event: opts.event, body: opts.body, comments: opts.comments },
    },
  );
  ensureSuccess(response, `POST pr review ${owner}/${repo}#${number}`);
  const parsed = parseJsonBody(
    response,
    `POST pr review ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST pr review ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id };
}

export async function replyReviewComment(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  body: string,
): Promise<{ readonly id: number }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
    {
      method: "POST",
      body: { body },
    },
  );
  ensureSuccess(
    response,
    `POST pr review comment reply ${owner}/${repo}#${number}`,
  );
  const parsed = parseJsonBody(
    response,
    `POST pr review comment reply ${owner}/${repo}#${number}`,
  );
  if (!isIdPayload(parsed)) {
    throw new Error(
      `POST pr review comment reply ${owner}/${repo}#${number}: unexpected response shape`,
    );
  }
  return { id: parsed.id };
}

export type RequestReviewersResult =
  | { readonly outcome: "requested"; readonly reviewers: string[] }
  | { readonly outcome: "skipped_empty" }
  | { readonly outcome: "failed"; readonly error: string };

export type RequestReviewersOptions = {
  readonly reviewers: readonly string[];
  readonly authorLogin: string;
  readonly viewer: string;
};

/**
 * Request reviewers, excluding the PR author and the viewer itself. Never
 * throws — a failure here should not fail the caller's flow (spec-cycle2.md
 * §1 github.ts "requestReviewers... 失敗は非致命").
 */
export async function requestReviewers(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  opts: RequestReviewersOptions,
): Promise<RequestReviewersResult> {
  validateOwnerRepo(owner, repo);
  assertGitHubName(opts.authorLogin);
  assertGitHubName(opts.viewer);

  const excluded = new Set([
    opts.authorLogin.toLowerCase(),
    opts.viewer.toLowerCase(),
  ]);
  const reviewers = opts.reviewers.filter(
    (login) => !excluded.has(login.toLowerCase()),
  );
  if (reviewers.length === 0) {
    return { outcome: "skipped_empty" };
  }

  try {
    const response = await callGhApi(
      client,
      `repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
      {
        method: "POST",
        body: { reviewers },
      },
    );
    ensureSuccess(
      response,
      `POST pr requested reviewers ${owner}/${repo}#${number}`,
    );
    return { outcome: "requested", reviewers };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", error: maskSecrets(message) };
  }
}
