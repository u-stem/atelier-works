// Structured logging with secret masking.
//
// Every log line goes through maskSecrets so a stray token in an error
// message or a subprocess's stdout never reaches a Windmill job log.
// Known token *formats* (GitHub PAT, Claude Code OAuth token, Discord
// webhook URL) are masked unconditionally via regex; opaque tokens with no
// public format (e.g. the Windmill API token) must be passed explicitly via
// the `secrets` list so they can be masked by exact match.

/** Regexes for secret formats that are safe to recognize without being told
 * the exact value (spec-cycle2.md §1 log.ts). */
const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub fine-grained PAT: github_pat_ + ~82 base62/underscore chars.
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // GitHub classic PAT / OAuth / app / refresh token prefixes.
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  // Claude Code OAuth token.
  /sk-ant-oat[A-Za-z0-9_-]{10,}/g,
  // Any other Anthropic API-style secret key, as defense in depth.
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  // Discord webhook URL: everything after /webhooks/ is the secret.
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
];

/**
 * Replace known secret formats and any explicitly-listed secret value with
 * `***` in `text`. Safe to call on arbitrary text (error messages,
 * subprocess stdout/stderr) before logging or storing it.
 */
export function maskSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let masked = text;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    masked = masked.split(secret).join("***");
  }
  return masked;
}

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogSink = (line: string) => void;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type LoggerOptions = {
  /** Secret values to mask in every log line, in addition to the built-in
   * known formats (e.g. the Windmill API token, which has no fixed format). */
  secrets?: readonly string[];
  /** Where a serialized log line is written. Defaults to `console.log`. */
  sink?: LogSink;
  /** Clock injection for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
};

/**
 * Create a structured logger for one pipeline stage (e.g. "poll_issues",
 * "generate_requirements"). Every call emits one JSON line via `sink`
 * (default: `console.log`, which Windmill captures as the job log).
 *
 * Masking is applied to the *entire serialized line*, not field-by-field —
 * `fields` can be an arbitrarily nested object/array (e.g. a captured HTTP
 * request), and a per-field-only pass would miss a secret nested inside a
 * nested object or array element. Running maskSecrets once over the full
 * JSON string catches a secret anywhere in the record, at any depth.
 */
export function logger(stage: string, options: LoggerOptions = {}): Logger {
  const secrets = options.secrets ?? [];
  const sink = options.sink ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      stage,
      message,
    };
    if (fields !== undefined) {
      record.fields = fields;
    }
    sink(maskSecrets(JSON.stringify(record), secrets));
  }

  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
