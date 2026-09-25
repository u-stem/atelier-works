// Load and validate f/factory/factory_config (resource type c_factory_config,
// see rt.d.ts's RT.CFactoryConfig and c_factory_config.resource-type.yaml).
//
// `getResource` is injected so tests never hit `wmill.getResource`. Callers
// in Windmill scripts pass `() => wmill.getResource("f/factory/factory_config")`.
//
// Fields that have a `default:` in the resource type schema are filled in
// when absent (this is what lets an existing remote resource created before
// spec-cycle2.md §7 item 10 still validate: the 9 new fields are all
// optional with defaults). `owners`, `factory_repo`, and `instance_name`
// have no schema default (they are instance-specific) and are required.
// A present-but-wrong-shaped value is always a validation error, defaulted
// or not.

import {
  type FactoryConfig,
  type FactoryOwner,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  isStringArray,
  type LabelerAssociation,
  type ReviewPostMode,
} from "./types.ts";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`factory_config validation error: ${message}`);
    this.name = "ConfigValidationError";
  }
}

const LABELER_ASSOCIATIONS: readonly LabelerAssociation[] = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
];
const REVIEW_POST_MODES: readonly ReviewPostMode[] = ["comment_only", "gated"];
const OWNER_KINDS = ["user", "org"];

/** Every FactoryConfig field that declares a `default:` in
 * c_factory_config.resource-type.yaml (everything except owners,
 * factory_repo, instance_name — see requiredStringField below). */
type DefaultableField =
  | "trigger_label"
  | "wip_label"
  | "approved_label"
  | "allowed_labeler_associations"
  | "model"
  | "max_attempts"
  | "max_turns"
  | "max_budget_usd_per_run"
  | "daily_budget_usd"
  | "claude_timeout_sec"
  | "worktree_ttl_days"
  | "windmill_public_url"
  | "review_label"
  | "fix_label"
  | "pr_label"
  | "review_post_mode"
  | "max_fix_rounds"
  | "allowed_check_commands"
  | "default_reviewers"
  | "repo_allowlist"
  | "diff_max_lines";

/** Defaults for every field in DefaultableField, typed against FactoryConfig
 * itself so each value is checked without a type assertion. */
const DEFAULTS: Pick<FactoryConfig, DefaultableField> = {
  trigger_label: "factory",
  wip_label: "factory:wip",
  approved_label: "factory:approved",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  windmill_public_url: "http://127.0.0.1:8080",
  // New in cycle 2 (spec-cycle2.md §7 item 10).
  review_label: "factory:review",
  fix_label: "factory:fix",
  pr_label: "factory:pr",
  review_post_mode: "comment_only",
  max_fix_rounds: 3,
  allowed_check_commands: [],
  default_reviewers: [],
  repo_allowlist: [],
  diff_max_lines: 3000,
};

function isFactoryOwner(value: unknown): value is FactoryOwner {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isString(value.name) &&
    isString(value.kind) &&
    OWNER_KINDS.includes(value.kind)
  );
}

function isFactoryOwnerArray(value: unknown): value is FactoryOwner[] {
  return Array.isArray(value) && value.every(isFactoryOwner);
}

function isLabelerAssociationArray(
  value: unknown,
): value is LabelerAssociation[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isOneOf(item, LABELER_ASSOCIATIONS))
  );
}

function isReviewPostMode(value: unknown): value is ReviewPostMode {
  return isOneOf(value, REVIEW_POST_MODES);
}

/** Reads `raw[field]`, defaulting to `fallback` when absent; throws when
 * present but not a string. */
function stringField(
  raw: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isString(value)) {
    throw new ConfigValidationError(`"${field}" must be a string`);
  }
  return value;
}

function numberField(
  raw: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isNumber(value)) {
    throw new ConfigValidationError(`"${field}" must be a number`);
  }
  return value;
}

function stringArrayField(
  raw: Record<string, unknown>,
  field: string,
  fallback: string[],
): string[] {
  const value = raw[field];
  if (value === undefined) {
    return fallback;
  }
  if (!isStringArray(value)) {
    throw new ConfigValidationError(`"${field}" must be an array of strings`);
  }
  return value;
}

/** Reads a field with no schema default: throws when absent or malformed. */
function requiredStringField(
  raw: Record<string, unknown>,
  field: string,
): string {
  const value = raw[field];
  if (!isString(value) || value.length === 0) {
    throw new ConfigValidationError(
      `"${field}" is required and must be a non-empty string`,
    );
  }
  return value;
}

/**
 * Validate the raw factory_config resource value and fill in defaults for
 * every field that declares one, producing a fully-populated FactoryConfig.
 */
export function parseFactoryConfig(raw: unknown): FactoryConfig {
  if (!isRecord(raw)) {
    throw new ConfigValidationError("resource value must be an object");
  }

  const owners = raw.owners;
  if (!isFactoryOwnerArray(owners)) {
    throw new ConfigValidationError(
      '"owners" is required and must be an array of { name: string, kind: "user" | "org" }',
    );
  }

  const allowedLabelerAssociations = raw.allowed_labeler_associations;
  const resolvedAllowedLabelerAssociations =
    allowedLabelerAssociations === undefined
      ? DEFAULTS.allowed_labeler_associations
      : isLabelerAssociationArray(allowedLabelerAssociations)
        ? allowedLabelerAssociations
        : (() => {
            throw new ConfigValidationError(
              '"allowed_labeler_associations" must be an array of "OWNER" | "MEMBER" | "COLLABORATOR"',
            );
          })();

  const reviewPostMode = raw.review_post_mode;
  const resolvedReviewPostMode =
    reviewPostMode === undefined
      ? DEFAULTS.review_post_mode
      : isReviewPostMode(reviewPostMode)
        ? reviewPostMode
        : (() => {
            throw new ConfigValidationError(
              '"review_post_mode" must be "comment_only" | "gated"',
            );
          })();

  return {
    owners,
    trigger_label: stringField(raw, "trigger_label", DEFAULTS.trigger_label),
    wip_label: stringField(raw, "wip_label", DEFAULTS.wip_label),
    approved_label: stringField(raw, "approved_label", DEFAULTS.approved_label),
    allowed_labeler_associations: resolvedAllowedLabelerAssociations,
    model: stringField(raw, "model", DEFAULTS.model),
    max_attempts: numberField(raw, "max_attempts", DEFAULTS.max_attempts),
    max_turns: numberField(raw, "max_turns", DEFAULTS.max_turns),
    max_budget_usd_per_run: numberField(
      raw,
      "max_budget_usd_per_run",
      DEFAULTS.max_budget_usd_per_run,
    ),
    daily_budget_usd: numberField(
      raw,
      "daily_budget_usd",
      DEFAULTS.daily_budget_usd,
    ),
    claude_timeout_sec: numberField(
      raw,
      "claude_timeout_sec",
      DEFAULTS.claude_timeout_sec,
    ),
    worktree_ttl_days: numberField(
      raw,
      "worktree_ttl_days",
      DEFAULTS.worktree_ttl_days,
    ),
    factory_repo: requiredStringField(raw, "factory_repo"),
    instance_name: requiredStringField(raw, "instance_name"),
    windmill_public_url: stringField(
      raw,
      "windmill_public_url",
      DEFAULTS.windmill_public_url,
    ),
    review_label: stringField(raw, "review_label", DEFAULTS.review_label),
    fix_label: stringField(raw, "fix_label", DEFAULTS.fix_label),
    pr_label: stringField(raw, "pr_label", DEFAULTS.pr_label),
    review_post_mode: resolvedReviewPostMode,
    max_fix_rounds: numberField(raw, "max_fix_rounds", DEFAULTS.max_fix_rounds),
    allowed_check_commands: stringArrayField(
      raw,
      "allowed_check_commands",
      DEFAULTS.allowed_check_commands,
    ),
    default_reviewers: stringArrayField(
      raw,
      "default_reviewers",
      DEFAULTS.default_reviewers,
    ),
    repo_allowlist: stringArrayField(
      raw,
      "repo_allowlist",
      DEFAULTS.repo_allowlist,
    ),
    diff_max_lines: numberField(raw, "diff_max_lines", DEFAULTS.diff_max_lines),
  };
}

/**
 * Fetch and validate the factory_config resource.
 * @param getResource injected resource fetch, e.g.
 *   `() => wmill.getResource("f/factory/factory_config")`.
 */
export async function loadConfig(
  getResource: () => Promise<unknown>,
): Promise<FactoryConfig> {
  const raw = await getResource();
  return parseFactoryConfig(raw);
}

/**
 * Whether `owner`/`repo` is allowed to be targeted by this factory instance:
 * `owner` must be one of `config.owners` (case-insensitive, as GitHub logins
 * are), and when `config.repo_allowlist` is non-empty the repo's HTTPS
 * clone URL (with or without a trailing `.git`) must appear in it
 * (spec-cycle2.md §7 item 10: "repo_allowlist([] = owners 全体)"). Promoted
 * from f/factory/steps/manual_intake_create_issue.ts's own copy — that
 * call site switches over on its owner's own schedule.
 */
export function isRepoAllowed(
  config: Pick<FactoryConfig, "owners" | "repo_allowlist">,
  owner: string,
  repo: string,
): boolean {
  const ownerAllowed = config.owners.some(
    (candidate) => candidate.name.toLowerCase() === owner.toLowerCase(),
  );
  if (!ownerAllowed) {
    return false;
  }
  if (config.repo_allowlist.length === 0) {
    return true;
  }
  const normalize = (url: string): string =>
    url
      .trim()
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  const target = normalize(`https://github.com/${owner}/${repo}`);
  return config.repo_allowlist.some((entry) => normalize(entry) === target);
}
