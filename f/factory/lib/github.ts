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
// marker (`withMarker`); `isFactoryPost` (login match via `isOwnPost` AND
// `hasMarker`) lets pollers tell a human post from a factory one — the
// factory runs under the same GitHub account as its human operator, so
// login alone can never make that call.

import { maskSecrets } from "./log.ts";
import type {
  FactoryOwnerKind,
  GitIdentity,
  LabelerAssociation,
} from "./types.ts";
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
 * callers must additionally require `isOwnPost(login, viewer)` (see
 * `isFactoryPost`, which combines both).
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

/**
 * Whether a post (comment/review/review-comment) is one the factory itself
 * made, as opposed to a human's — requires BOTH conditions:
 *
 * - `isOwnPost(login, viewer)`: login alone is not enough, because the
 *   factory runs under the same GitHub account as its human operator
 *   (shared PAT) — a login match cannot by itself distinguish the
 *   operator's own comment (e.g. a plain instruction comment) from the
 *   factory's.
 * - `hasMarker(body, kind)`: a marker alone is not enough either
 *   (spec-cycle2.md §7 item 1 / security-audit fix) — a third party could
 *   paste a matching `<!-- factory:... -->` line into their own post to
 *   have it ignored.
 *
 * Pass `kind` to further require a specific marker kind, e.g. only the
 * factory's own `pr_fix` replies (not its `pr_review` review) should be
 * excluded from pr_fix's feedback collection.
 */
export function isFactoryPost(
  login: string | undefined,
  viewer: string,
  body: string,
  kind?: string,
): boolean {
  if (typeof login !== "string") return false;
  if (!isOwnPost(login, viewer)) return false;
  return hasMarker(body, kind);
}

/** GitHub's `author_association` value for a comment/review/timeline-event
 * author, or `null` when absent — same type as
 * `LabeledTimelineEvent.authorAssociation` (spec-cycle2.md §7 item 1's
 * `allowed_labeler_associations` check, extended to the pr_fix human-
 * feedback filter). */
function parseAuthorAssociation(
  value: unknown,
): LabelerAssociation | string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export type Viewer = { readonly login: string; readonly id: number };

/** `{ login: string }` — shared by `getViewer` and any GitHub "actor" object (e.g. timeline events). */
type LoginPayload = { readonly login: string };

function isLoginPayload(value: unknown): value is LoginPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("login" in value)) return false;
  return typeof (value as { login: unknown }).login === "string";
}

/** `GET /user`'s payload shape needed by `getViewer` — a `LoginPayload` plus the numeric account `id` used to build a GitHub noreply commit email (`gitIdentityForViewer`). */
type ViewerPayload = LoginPayload & { readonly id: number };

function isViewerPayload(value: unknown): value is ViewerPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { login: unknown; id: unknown };
  return typeof record.login === "string" && typeof record.id === "number";
}

export async function getViewer(client: GhClient): Promise<Viewer> {
  const response = await callGhApi(client, "user");
  ensureSuccess(response, "GET /user");
  const parsed = parseJsonBody(response, "GET /user");
  if (!isViewerPayload(parsed)) {
    throw new Error("GET /user: unexpected response shape");
  }
  return { login: parsed.login, id: parsed.id };
}

/**
 * The git author/committer identity for a commit the factory makes, derived
 * from the viewer (the GitHub account the PAT resolves to). Uses GitHub's
 * noreply commit-email form (`<numeric id>+<login>@users.noreply.github.com`)
 * so no personal email is ever written to a commit — see docs/security.md's
 * "pr_fix の安全策" section. Pure function; `commitAndPush` (workspace.ts)
 * passes the result through the process env only (`GIT_AUTHOR_*`/
 * `GIT_COMMITTER_*`), never into git config.
 */
export function gitIdentityForViewer(viewer: Viewer): GitIdentity {
  return {
    name: viewer.login,
    email: `${viewer.id}+${viewer.login}@users.noreply.github.com`,
  };
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
  readonly id: number;
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
    id: unknown;
    number: unknown;
    title: unknown;
    body: unknown;
    html_url: unknown;
    repository_url: unknown;
    user: unknown;
  };
  if (typeof record.id !== "number") return false;
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
  // Quoted (label names can contain a colon, e.g. "factory:wip") — GitHub's
  // /search/issues currently accepts an unquoted `label:factory:wip` too,
  // but quoting is the documented/safe form and matches searchPrs below.
  const query = `is:issue state:open ${ownerQualifier(opts.owner, opts.ownerKind)} label:"${opts.label}" -label:"${opts.notLabel}"`;
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
      authorAssociation: parseAuthorAssociation(raw.author_association),
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
  readonly author_association: unknown;
};

function isCommentBodyPayload(value: unknown): value is CommentBodyPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id: unknown;
    body: unknown;
    user: unknown;
    author_association: unknown;
  };
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
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type ListIssueCommentsOptions = {
  readonly viewer: string;
  /** Only comments with an id greater than this are returned (the caller's
   * `last_comment_id` high-water mark); omit to return every comment
   * (excluding the factory's own marker-bearing posts — see
   * `isFactoryPost`). */
  readonly sinceId?: number;
};

/**
 * `GET .../issues/{number}/comments` (paginated), filtered to non-factory
 * comments newer than `sinceId` — mirrors `listPrReviews`'s shape
 * (`{ items, maxId }`). Feeds pr_fix's human-feedback collection
 * detector (poll_prs.ts): a comment is excluded here only when it is the
 * factory's own post — `isFactoryPost(login, opts.viewer, raw.body)` (any
 * marker kind), i.e. authored by the viewer login AND carrying a factory
 * marker. The factory runs under the same GitHub account as its human
 * operator (shared PAT), so a plain instruction comment typed by the
 * operator has the same login as the factory and is deliberately kept —
 * only a marker-bearing post (the factory's own comment, or an old "review
 * started" announcement) is dropped.
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
    if (isFactoryPost(login, opts.viewer, raw.body)) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      authorAssociation: parseAuthorAssociation(raw.author_association),
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

/**
 * Adds `labels` to an issue/PR without touching any label already on it —
 * GitHub's `POST .../labels` endpoint is additive, unlike `setLabels`'s PUT
 * (replaces the whole set). Promoted from
 * f/factory/steps/pr_workflow_support.ts's local version (same signature
 * and behavior — a bare POST, no re-fetch-to-confirm step). Used by
 * retry_work_item.ts to restore a terminal work item's labels without also
 * assigning anyone (unlike claimIssue, which POSTs an assignee too), and by
 * pr_fix_finish's requirements_gap reroute (re-adding the parent issue's
 * wip/trigger labels before restarting f/factory/pipeline on it).
 */
export async function addLabels(
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
      method: "POST",
      body: { labels },
    },
  );
  ensureSuccess(response, `POST issue labels ${owner}/${repo}#${number}`);
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

export type MarkerSearchResult = {
  readonly number: number;
  readonly htmlUrl: string;
  readonly body: string;
};

/**
 * `GET /search/issues` for an open-or-closed issue in `owner/repo` whose
 * body contains the literal `markerText` (quoted phrase search) — team-lead
 * fix round, [MUST] #2: issue_proposal_apply.ts uses this before calling
 * `createIssue` on an approve decision, so a retry after a crash between
 * recording the decision and creating the Issue reuses the Issue a previous
 * attempt already created instead of duplicating it. The caller passes the
 * *inner* marker text (`factory:issue_proposal:<id>`, not the full
 * `<!-- ... -->` comment syntax — pr_workflow_support.ts's
 * `issueProposalMarkerSearchTerm`), since GitHub's search treats `<`/`-`/`>`
 * as noise; quoting alone keeps the colon-bearing phrase from being parsed
 * as a `qualifier:value` search operator (mirrors `searchIssues`'s own label
 * quoting). Returns the first match's number/htmlUrl/body — `body` so the
 * caller can additionally confirm the match with an exact-substring check
 * (`hasIssueProposalMarker`) before trusting it, since search is a
 * word/phrase match, not an exact comparison — or `null` when nothing
 * matches. Not restricted to `state:open`, since a previously-created Issue
 * could have been closed independently.
 */
export async function findIssueByMarker(
  client: GhClient,
  owner: string,
  repo: string,
  markerText: string,
): Promise<MarkerSearchResult | null> {
  validateOwnerRepo(owner, repo);
  const query = `is:issue repo:${owner}/${repo} "${markerText}" in:body`;
  const items = await callGhApiAllSearchItems(
    client,
    `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
  );
  const first = items[0];
  if (first === undefined) return null;
  return {
    number: first.number,
    htmlUrl: first.html_url,
    body: first.body ?? "",
  };
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
  readonly fixLabel: string;
  readonly wipLabel: string;
  /** The four PR state labels (pr_workflow_support.ts's allStateLabels) —
   * one `label:"<label>"` query is issued per entry, re-discovering a PR
   * the factory is already tracking whose trigger label has since fallen
   * off (team-lead design, 2026-09-26: replaces the former
   * `commenter:<viewer>` query — see the doc comment below). */
  readonly stateLabels: readonly string[];
};

/**
 * `GET /search/issues` scoped to PRs: review-requested, assigned, labeled
 * `reviewLabel` or `fixLabel`, or carrying one of `stateLabels` — excluding
 * `wipLabel` (spec-cycle2.md §7 item 1). The state-label queries re-discover
 * a PR whose trigger label has already fallen off (e.g. review finished and
 * the review label was removed) before a human acts on it (approving,
 * adding the fix label, or pushing a fix themselves) — without them,
 * such a PR would never re-enter the candidate set (E2E gap). This replaces
 * the former `commenter:<viewer>` query (team-lead design, 2026-09-26):
 * `commenter:` re-discovered a PR via the factory's own opening comment,
 * but the factory no longer posts one (see poll_prs.ts's startReview/
 * startFix); the state labels the factory itself sets and swaps are a more
 * precise, human-visible substitute that also doubles as an at-a-glance PR
 * status indicator.
 *
 * Runs as one query per qualifier, not one combined
 * `(review-requested:X OR assignee:X OR label:Y OR ...)` query — confirmed
 * empirically (real-flow E2E failure) that GitHub's `/search/issues` does
 * not support parenthesized OR grouping: the combined query always
 * returned 0 results, while each qualifier alone matched. Results are
 * merged and de-duplicated by the search item's GitHub `id` (a PR can
 * satisfy more than one qualifier at once).
 */
export async function searchPrs(
  client: GhClient,
  opts: SearchPrsOptions,
): Promise<PrSearchItem[]> {
  assertGitHubName(opts.owner);
  assertGitHubName(opts.viewer);
  // Label names can contain a colon (e.g. "factory:wip"), so the label
  // qualifiers are quoted.
  const base = `is:pr state:open ${ownerQualifier(opts.owner, opts.ownerKind)} -label:"${opts.wipLabel}"`;
  const queries = [
    `${base} review-requested:${opts.viewer}`,
    `${base} assignee:${opts.viewer}`,
    `${base} label:"${opts.reviewLabel}"`,
    `${base} label:"${opts.fixLabel}"`,
    ...opts.stateLabels.map((label) => `${base} label:"${label}"`),
  ];
  const resultsByQuery = await Promise.all(
    queries.map((query) =>
      callGhApiAllSearchItems(
        client,
        `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      ),
    ),
  );
  const seen = new Set<number>();
  const items: PrSearchItem[] = [];
  for (const queryItems of resultsByQuery) {
    for (const item of queryItems) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const { owner, repo } = repoFromRepositoryUrl(item.repository_url);
      items.push({
        owner,
        repo,
        number: item.number,
        title: item.title,
        htmlUrl: item.html_url,
      });
    }
  }
  return items;
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
  readonly authorAssociation: LabelerAssociation | string | null;
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
  readonly author_association: unknown;
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
 * `GET .../reviews` (paginated), filtered so that only the factory's own
 * `pr_fix` replies are excluded —
 * `isFactoryPost(login, viewer, raw.body, "pr_fix")`. The factory's own
 * `pr_review`-kind review (and a human's review) are intentionally kept:
 * adding the fix label after the factory's own review means "fix those
 * findings", so that review must remain visible as feedback rather than
 * being dropped just because its login happens to match the viewer (shared
 * operator account).
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
    if (isFactoryPost(login, viewer, raw.body, "pr_fix")) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      authorAssociation: parseAuthorAssociation(raw.author_association),
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
  readonly authorAssociation: LabelerAssociation | string | null;
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
  readonly author_association: unknown;
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
 * `GET .../comments` (inline review comments, paginated), filtered the same
 * way as `listPrReviews`: only the factory's own `pr_fix`-kind reply is
 * excluded (`isFactoryPost(login, viewer, raw.body, "pr_fix")`). The
 * factory's own unmarked inline findings from a `pr_review` pass stay
 * visible — pr_fix needs to see them as feedback to act on.
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
    if (isFactoryPost(login, viewer, raw.body, "pr_fix")) continue;
    items.push({
      id: raw.id,
      authorLogin: typeof login === "string" ? login : "",
      authorAssociation: parseAuthorAssociation(raw.author_association),
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
  /** First line of a comment spanning multiple lines — omit for a
   * single-line comment. When present, `start_side` is always sent as
   * `"RIGHT"` (every review comment in this project anchors to the new/
   * head version of the file, never a deletion on the base side). */
  readonly start_line?: number;
  readonly body: string;
};

export type CreatePrReviewOptions = {
  readonly event: "COMMENT";
  readonly body: string;
  readonly comments: readonly ReviewComment[];
};

/** GitHub Pull Request Review API's `comments[]` shape: same fields as
 * `ReviewComment`, plus `start_side` (only ever present alongside
 * `start_line`, fixed to `"RIGHT"` — not a caller-facing option). */
function toReviewCommentPayload(
  comment: ReviewComment,
): Record<string, unknown> {
  return {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
    ...(comment.start_line !== undefined
      ? { start_line: comment.start_line, start_side: "RIGHT" }
      : {}),
  };
}

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
      body: {
        event: opts.event,
        body: opts.body,
        comments: opts.comments.map(toReviewCommentPayload),
      },
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

// ---------------------------------------------------------------------------
// Branch protection (promoted from f/factory/steps/pr_workflow_support.ts)
// ---------------------------------------------------------------------------

type BranchProtectionPayload = { readonly protected: boolean };

function isBranchProtectionPayload(
  value: unknown,
): value is BranchProtectionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { protected: unknown };
  return typeof record.protected === "boolean";
}

/**
 * `GET repos/{owner}/{repo}/branches/{branch}`'s `protected` flag — this
 * endpoint returns `protected: false` (not a 404) for an unprotected
 * branch, unlike the dedicated `/branches/{branch}/protection` endpoint.
 */
export async function getBranchProtected(
  client: GhClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
  );
  ensureSuccess(response, `GET branch ${owner}/${repo}@${branch}`);
  const parsed = parseJsonBody(
    response,
    `GET branch ${owner}/${repo}@${branch}`,
  );
  if (!isBranchProtectionPayload(parsed)) {
    throw new Error(
      `GET branch ${owner}/${repo}@${branch}: unexpected response shape`,
    );
  }
  return parsed.protected;
}

// ---------------------------------------------------------------------------
// Plain (non-idempotent) issue comment (promoted from f/factory/steps/
// pr_workflow_support.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Review threads (GraphQL) — team-lead decision (2026-09-26): on a
// re-review with zero findings, pr_review_post.ts resolves the factory's
// own still-unresolved `pr_review` inline-comment threads on the PR.
// GitHub's REST API has no thread-resolution endpoint, so this goes through
// `gh api graphql` instead (same `callGhApi` plumbing, endpoint "graphql").
// One page (100 threads) is enough for now; a PR with more open review
// threads than that is far beyond this project's expected review size.
// ---------------------------------------------------------------------------

type GraphqlErrorPayload = {
  readonly message: string;
};

type GraphqlErrorsPayload = {
  readonly errors: readonly GraphqlErrorPayload[];
};

/** A non-empty top-level `errors` array — GitHub's GraphQL error envelope. An
 * empty or absent `errors` field means the call actually succeeded, so this
 * intentionally returns `false` for it (an empty array is not an error). */
function isGraphqlErrorsPayload(value: unknown): value is GraphqlErrorsPayload {
  if (typeof value !== "object" || value === null) return false;
  const errors = (value as { errors: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { message: unknown }).message === "string",
  );
}

type GraphqlDataPayload = {
  readonly data: unknown;
};

function isGraphqlDataPayload(value: unknown): value is GraphqlDataPayload {
  if (typeof value !== "object" || value === null) return false;
  return "data" in value;
}

/**
 * Shared POST to `gh api graphql` (spec-cycle2.md §1's `ensureSuccess`
 * covers REST's non-2xx-means-failure convention, but GitHub's GraphQL
 * endpoint returns HTTP 200 even for a permission/argument error — the
 * failure is only visible in a top-level `errors` array in the body). This
 * runs `ensureSuccess` first (still needed for genuine transport-level
 * failures), parses the JSON body, and throws when `errors` is a non-empty
 * array so a GraphQL-level failure can never be mistaken for success by a
 * caller that only checked the HTTP status. Returns the `data` field on
 * success.
 */
async function callGhGraphql(
  client: GhClient,
  query: string,
  variables: Record<string, unknown>,
  context: string,
): Promise<unknown> {
  const response = await callGhApi(client, "graphql", {
    method: "POST",
    body: { query, variables },
  });
  ensureSuccess(response, context);
  const parsed = parseJsonBody(response, context);
  if (isGraphqlErrorsPayload(parsed)) {
    const messages = parsed.errors.map((error) => error.message).join("; ");
    throw new Error(`${context}: GraphQL error: ${messages}`);
  }
  if (!isGraphqlDataPayload(parsed)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  return parsed.data;
}

export type ReviewThread = {
  readonly id: string;
  readonly isResolved: boolean;
  /** The file path and current diff line this thread is anchored to
   * (team-lead decision, 2026-09-26: needed by pr_workflow_support.ts's
   * `openFindingsForPrompt`, so a re-review can tell Claude *where* an open
   * finding is, not just what it said). `line` is GitHub's own
   * `PullRequestReviewThread.line` — `null` once the thread's anchor is no
   * longer part of the diff (e.g. the commented-on lines were since
   * changed again), same as a `ReviewFinding`'s own nullable `line`. */
  readonly path: string;
  readonly line: number | null;
  readonly firstCommentAuthorLogin: string;
  readonly firstCommentBody: string;
  readonly lastCommentAuthorLogin: string;
  readonly lastCommentBody: string;
  /** The first comment's REST id (`databaseId`) — team-lead fix round,
   * [MUST] #4: `matchReviewThreadForComment` (pr_workflow_support.ts) used
   * to match a FixReply's `review_comment_id` (a REST id) against a thread
   * by (path, line) instead, which silently mismatched once a later commit
   * shifted the diff's line numbers. `null` when GitHub returns no
   * `databaseId` for the comment (should not happen for a real REST-backed
   * comment, but the type guard treats it as absent rather than throwing). */
  readonly firstCommentDatabaseId: number | null;
  /** REST ids of every comment in the thread, first 50 (see the module note
   * above `listReviewThreads`) — lets `matchReviewThreadForComment` match a
   * reply that targets a later comment in the thread, not just the first. */
  readonly allCommentIds: number[];
};

type ReviewThreadsGraphqlPayload = {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly nodes: readonly unknown[];
      };
    };
  };
};

function isReviewThreadsGraphqlPayload(
  value: unknown,
): value is ReviewThreadsGraphqlPayload {
  if (typeof value !== "object" || value === null) return false;
  const repository = (value as { repository: unknown }).repository;
  if (typeof repository !== "object" || repository === null) return false;
  const pullRequest = (repository as { pullRequest: unknown }).pullRequest;
  if (typeof pullRequest !== "object" || pullRequest === null) return false;
  const reviewThreads = (pullRequest as { reviewThreads: unknown })
    .reviewThreads;
  if (typeof reviewThreads !== "object" || reviewThreads === null) {
    return false;
  }
  return Array.isArray((reviewThreads as { nodes: unknown }).nodes);
}

/** One `comments(...) { nodes { ... } }` connection — used for both the
 * `firstComments`/`lastComments` GraphQL aliases in the query below. */
type ReviewThreadCommentsConnectionPayload = {
  readonly nodes: readonly unknown[];
};

function isReviewThreadCommentsConnectionPayload(
  value: unknown,
): value is ReviewThreadCommentsConnectionPayload {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { nodes: unknown }).nodes);
}

type ReviewThreadNodePayload = {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly firstComments: ReviewThreadCommentsConnectionPayload;
  readonly lastComments: ReviewThreadCommentsConnectionPayload;
  readonly allComments: ReviewThreadCommentsConnectionPayload;
};

function isReviewThreadNodePayload(
  value: unknown,
): value is ReviewThreadNodePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id: unknown;
    isResolved: unknown;
    path: unknown;
    line: unknown;
    firstComments: unknown;
    lastComments: unknown;
    allComments: unknown;
  };
  if (typeof record.id !== "string") return false;
  if (typeof record.isResolved !== "boolean") return false;
  if (typeof record.path !== "string") return false;
  if (record.line !== null && typeof record.line !== "number") return false;
  if (!isReviewThreadCommentsConnectionPayload(record.firstComments)) {
    return false;
  }
  if (!isReviewThreadCommentsConnectionPayload(record.lastComments)) {
    return false;
  }
  return isReviewThreadCommentsConnectionPayload(record.allComments);
}

type ReviewThreadCommentPayload = {
  readonly author: { readonly login: string } | null;
  readonly body: string;
  readonly databaseId?: number | null;
};

function isReviewThreadCommentPayload(
  value: unknown,
): value is ReviewThreadCommentPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    author: unknown;
    body: unknown;
    databaseId: unknown;
  };
  if (record.author !== null && !isLoginPayload(record.author)) return false;
  if (typeof record.body !== "string") return false;
  if (
    record.databaseId !== undefined &&
    record.databaseId !== null &&
    typeof record.databaseId !== "number"
  ) {
    return false;
  }
  return true;
}

type ReviewThreadDatabaseIdNodePayload = {
  readonly databaseId: number | null;
};

function isReviewThreadDatabaseIdNodePayload(
  value: unknown,
): value is ReviewThreadDatabaseIdNodePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { databaseId: unknown };
  return record.databaseId === null || typeof record.databaseId === "number";
}

/**
 * `GET`-equivalent GraphQL query for a PR's review threads (first 100 — see
 * the module note above): each thread's resolution state, its diff anchor
 * (`path`/`line` — team-lead decision, 2026-09-26: needed by
 * `openFindingsForPrompt`, pr_workflow_support.ts), its first comment's
 * author/body/REST id (`databaseId`), and (via the `lastComments` alias) its
 * last comment's author/body — `selectThreadsToResolve` (pr_workflow_support.ts)
 * needs the latter two to find the factory's own still-unresolved
 * `pr_review` threads whose last word was also the factory's (a human reply
 * left in the thread must block auto-resolve). The `allComments` alias
 * (first 50 comments' REST ids only) backs `matchReviewThreadForComment`
 * (team-lead fix round, [MUST] #4): matching a `FixReply.review_comment_id`
 * (a REST id) against a thread by (path, line) silently mismatched once a
 * later commit shifted the diff's line numbers, so matching is now by id —
 * `firstCommentDatabaseId` for the common case, `allCommentIds` for a reply
 * that targets a later comment in the thread. A thread whose shape doesn't
 * match (including one with no comments at all, which shouldn't happen on
 * GitHub) is skipped rather than throwing.
 */
export async function listReviewThreads(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]> {
  validateOwnerRepo(owner, repo);
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              firstComments: comments(first: 1) {
                nodes {
                  author { login }
                  body
                  databaseId
                }
              }
              lastComments: comments(last: 1) {
                nodes {
                  author { login }
                  body
                }
              }
              allComments: comments(first: 50) {
                nodes {
                  databaseId
                }
              }
            }
          }
        }
      }
    }
  `;
  const context = `GraphQL reviewThreads ${owner}/${repo}#${number}`;
  const data = await callGhGraphql(
    client,
    query,
    { owner, repo, number },
    context,
  );
  if (!isReviewThreadsGraphqlPayload(data)) {
    throw new Error(`${context}: unexpected response shape`);
  }
  const threads: ReviewThread[] = [];
  for (const rawNode of data.repository.pullRequest.reviewThreads.nodes) {
    if (!isReviewThreadNodePayload(rawNode)) continue;
    const firstComment = rawNode.firstComments.nodes[0];
    const lastComment = rawNode.lastComments.nodes[0];
    if (!isReviewThreadCommentPayload(firstComment)) continue;
    if (!isReviewThreadCommentPayload(lastComment)) continue;
    const allCommentIds = rawNode.allComments.nodes
      .filter(isReviewThreadDatabaseIdNodePayload)
      .map((node) => node.databaseId)
      .filter((id): id is number => id !== null);
    threads.push({
      id: rawNode.id,
      isResolved: rawNode.isResolved,
      path: rawNode.path,
      line: rawNode.line,
      firstCommentAuthorLogin: firstComment.author?.login ?? "",
      firstCommentBody: firstComment.body,
      lastCommentAuthorLogin: lastComment.author?.login ?? "",
      lastCommentBody: lastComment.body,
      firstCommentDatabaseId: firstComment.databaseId ?? null,
      allCommentIds,
    });
  }
  return threads;
}

/**
 * Resolves one review thread via GitHub's `resolveReviewThread` GraphQL
 * mutation (no REST equivalent exists). Callers (pr_review_post.ts) treat a
 * failure here as best-effort — warn-log per thread, never fail the step.
 */
export async function resolveReviewThread(
  client: GhClient,
  threadId: string,
): Promise<void> {
  const mutation = `
    mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { id isResolved }
      }
    }
  `;
  await callGhGraphql(
    client,
    mutation,
    { id: threadId },
    `GraphQL resolveReviewThread ${threadId}`,
  );
}

/**
 * Posts a plain (non-idempotent) issue-level comment. Unlike `commentIssue`
 * (one canonical marker comment per kind+work_item_id, deduplicated), this
 * always creates a new comment and never adds a marker — the caller applies
 * `withMarker` itself when one is needed. Used by pr_fix_finish.ts to reply
 * to a plain issue comment (GitHub has no threaded-reply concept for
 * issue-level comments, unlike PR review comments' `replyReviewComment`).
 */
export async function postIssueComment(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ readonly id: number }> {
  validateOwnerRepo(owner, repo);
  const response = await callGhApi(
    client,
    `repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      body: { body },
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
  return { id: parsed.id };
}
