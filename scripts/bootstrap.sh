#!/usr/bin/env bash
# bootstrap.sh - first-time (and idempotent re-run) setup of the local
# Windmill workspace for the Software Factory.
#
# There is no infra/.env or infra/secrets.env: configuration lives in mise's
# [env] block (non-secret, committed in mise.toml) and in mise.local.toml
# (gitignored secrets, populated via `mise set -E local KEY=value`). This
# script is meant to run as a mise task (`mise run bootstrap`) so those
# values are already present in its environment. It never reads a secrets
# file and never prints a secret's value - only whether an optional one is
# set. All direct API calls send their Authorization header from a 0600
# file inside a 0700 temp dir (see set_auth_token/AUTH_HEADER_FILE) rather
# than as a curl argument, so a token is never visible in `ps` output
# either.
#
# The sole exception to never taking a secret as a CLI argument is `wmill
# workspace add --token`, which has no other way to receive a token in
# wmill CLI 1.817.0 (see the comment at its call sites).
#
# Two tokens are in play. SESSION_TOKEN (from /auth/login) has full account
# privileges and is used only for the handful of operations that need them:
# creating the workspace, the superadmin-only instance-database setup, and
# token list/delete (both account-global, not workspace-scoped - see step
# 8). PERSISTENT_TOKEN is minted scoped to this one workspace with a
# 180-day expiry and is what actually drives every Windmill interaction
# from step 6 onward (`wmill` CLI calls via the workspace profile, direct
# API calls via the Authorization header) - this was verified end-to-end
# against a live instance. SESSION_TOKEN is logged out as soon as the
# token-rotation step that still needs it is done.
#
# Steps (idempotent - safe to re-run):
#   0. Refuse to run if WM_ADMIN_PASSWORD is the "changeme" default or
#      shorter than 12 characters.
#   1. Log in as the instance admin (configured password, falling back to
#      the Windmill default "changeme" on first run) and, on first run,
#      change the password to WM_ADMIN_PASSWORD. -> SESSION_TOKEN.
#   2. `wmill workspace add factory factory $WM_BASE_URL --token <session> --create`
#      (creates the workspace if missing) using the session token - no
#      workspace-scoped token exists yet.
#   3. Ensure the instance-backed Postgres database is set up (CREATE
#      DATABASE + grants for custom_instance_user) via the official
#      superadmin API (`/settings/{list,setup}_custom_instance_pg_database*`),
#      using the session token. Idempotent: the API skips CREATE DATABASE
#      when the database already exists and only (re-)grants permissions,
#      so this is safe on every run. Without this, `wmill datatable migrate
#      up` fails with "permission denied for schema public" the first time
#      a fresh instance-backed datatable is used.
#   4. Mint a workspace-scoped API token (label factory-bootstrap,
#      workspace_id factory, 180-day expiry) -> PERSISTENT_TOKEN.
#   5. `wmill workspace add` again with the session token (a workspace-
#      scoped token 401s on the `POST /workspaces/exists` check this
#      command always makes first, confirmed with --verbose - see the
#      comment at this step), then patch just the `token` field of
#      $WMILL_CONFIG_DIR/windmill/remotes.ndjson to PERSISTENT_TOKEN so
#      every `wmill` invocation below actually uses the scoped token.
#   6. `wmill datatable create` (skipped if a 'main' datatable already exists).
#   7. Upsert the four secret variables (claude_oauth_token, github_token,
#      wmill_token, discord_webhook_url) via the variables API. wmill_token
#      gets PERSISTENT_TOKEN. The other three come from
#      CLAUDE_CODE_OAUTH_TOKEN / GITHUB_TOKEN / DISCORD_WEBHOOK_URL and may
#      be empty - a human fills them in later via `mise set -E local` or the
#      Windmill UI.
#   8. Rotate out old tokens: `/users/tokens/list` and `/users/tokens/delete`
#      are account-global, so this runs on the session token (confirmed:
#      PERSISTENT_TOKEN gets 401 on token/list). Only runs once the new
#      token is durably saved in two places (the CLI workspace profile via
#      remotes.ndjson in step 5, and the wmill_token variable in step 7),
#      so a failure partway through rotation never leaves the instance
#      without a working token. Deletes every other token labeled
#      factory-bootstrap.
#   9. Log the session token out (`/auth/logout`) - nothing below needs it.
#  10. Create the `factory` folder if missing.
#  11. Create f/factory/factory_config from templates/factory_config.resource.yaml
#      if it does not already exist remotely. This resource is instance-specific
#      (owners, instance_name, windmill_public_url) and excluded from sync (see
#      wmill.yaml) - bootstrap never overwrites an existing one, so UI edits
#      always win.
#  12. `wmill sync push --yes --keep-deleted`
#  13. `wmill datatable migrate up`
#  14. `wmill resource-type generate-namespace` (writes rt.d.ts)
#  15. Print next steps.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

log() { printf '[bootstrap] %s\n' "$*" >&2; }
die() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (run via 'mise run bootstrap' so PATH includes it)"
}
require_cmd curl
require_cmd mise
require_cmd jq

# --- required, non-secret or instance-secret configuration -----------------
: "${WM_BASE_URL:?run via 'mise run bootstrap' (mise.toml [env] sets this)}"
: "${WM_ADMIN_EMAIL:?run via 'mise run bootstrap'; set with: mise set -E local WM_ADMIN_EMAIL=...}"
: "${WM_ADMIN_PASSWORD:?run via 'mise run bootstrap'; set with: mise set -E local WM_ADMIN_PASSWORD=...}"

# --- step 0: refuse to run with a weak/default admin password --------------
if [ "${WM_ADMIN_PASSWORD}" = "changeme" ] || [ "${#WM_ADMIN_PASSWORD}" -lt 12 ]; then
  die "WM_ADMIN_PASSWORD is the 'changeme' default or shorter than 12 characters; set a strong password: mise set -E local WM_ADMIN_PASSWORD=..."
fi

# --- optional secrets: bootstrap still runs with these empty; the
# corresponding variable is created/updated empty and downstream flows
# (poll_issues, pipeline, notify_discord) report needs_human / notices until
# a human sets the real value ---
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
for optional in GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN DISCORD_WEBHOOK_URL; do
  if [ -z "${!optional}" ]; then
    log "note: ${optional} is not set; the matching variable will be created empty"
  fi
done

WORKSPACE="factory"
API="${WM_BASE_URL%/}/api"

TMP_DIR="$(mktemp -d)"
chmod 700 "${TMP_DIR}"
trap 'rm -rf -- "${TMP_DIR}"' EXIT
RESP_FILE="${TMP_DIR}/resp.txt"
# Authorization header lives in its own 0600 file inside the 0700 TMP_DIR, so
# curl reads it via `-H @file` instead of taking the token as a command-line
# argument (which would otherwise be visible to any local user via `ps`).
AUTH_HEADER_FILE="${TMP_DIR}/auth_header.txt"

# Run a command with the repo root as cwd and mise's tool PATH/env applied,
# without using a top-level `cd` (only ever inside this subshell).
run_in_repo() {
  (cd -- "${REPO_ROOT}" && mise exec -- "$@")
}

run_wmill() { run_in_repo wmill "$@"; }

# Evaluate a small bun script with WM_TMP_* env vars (set by the caller as a
# prefix assignment) visible to it, and the repo as cwd. Values only ever
# travel through the environment or stdin, never through argv.
bun_eval() { run_in_repo bun -e "$1"; }

# Ensure the wmill CLI's config dir (workspace profiles, including tokens in
# remotes.ndjson) is not group/world readable.
harden_wmill_config_dir() {
  if [ -n "${WMILL_CONFIG_DIR:-}" ] && [ -d "${WMILL_CONFIG_DIR}" ]; then
    chmod 700 "${WMILL_CONFIG_DIR}" 2>/dev/null || true
    find "${WMILL_CONFIG_DIR}" -type f -name 'remotes*.ndjson' -exec chmod 600 {} + 2>/dev/null || true
  fi
}

if ! curl -fsS -o /dev/null --max-time 10 "${WM_BASE_URL%/}/api/version"; then
  die "cannot reach Windmill at ${WM_BASE_URL} (run 'mise run up' first)"
fi

# set_auth_token TOKEN - updates AUTH_HEADER_FILE (and the AUTH_TOKEN
# variable, needed by jq-based helpers that read it via the environment, not
# argv) so subsequent api_* calls authenticate as TOKEN. Pass "" to clear it.
AUTH_TOKEN=""
set_auth_token() {
  AUTH_TOKEN="$1"
  if [ -n "${AUTH_TOKEN}" ]; then
    (umask 077 && printf 'Authorization: Bearer %s\n' "${AUTH_TOKEN}" >"${AUTH_HEADER_FILE}")
  else
    rm -f "${AUTH_HEADER_FILE}"
  fi
}

# api_post PATH - reads a JSON body from stdin, prints the HTTP status code.
api_post() {
  local path="$1"
  local -a headers=(-H 'Content-Type: application/json')
  [ -f "${AUTH_HEADER_FILE}" ] && headers+=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X POST "${API}${path}" "${headers[@]}" --data-binary @-
}

# api_get PATH - prints the HTTP status code; body lands in $RESP_FILE.
api_get() {
  local path="$1"
  local -a headers=()
  [ -f "${AUTH_HEADER_FILE}" ] && headers=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X GET "${API}${path}" "${headers[@]}"
}

# api_post_no_body PATH - like api_post but for endpoints that take no body.
api_post_no_body() {
  local path="$1"
  local -a headers=()
  [ -f "${AUTH_HEADER_FILE}" ] && headers=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X POST "${API}${path}" "${headers[@]}"
}

# api_delete PATH - prints the HTTP status code; body lands in $RESP_FILE.
api_delete() {
  local path="$1"
  local -a headers=()
  [ -f "${AUTH_HEADER_FILE}" ] && headers=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X DELETE "${API}${path}" "${headers[@]}"
}

login_body() {
  # $1 = password
  WM_TMP_EMAIL="${WM_ADMIN_EMAIL}" WM_TMP_PASSWORD="$1" bun_eval '
    const email = process.env.WM_TMP_EMAIL ?? "";
    const password = process.env.WM_TMP_PASSWORD ?? "";
    process.stdout.write(JSON.stringify({ email, password }));
  '
}

setpassword_body() {
  WM_TMP_PASSWORD="${WM_ADMIN_PASSWORD}" bun_eval '
    const password = process.env.WM_TMP_PASSWORD ?? "";
    process.stdout.write(JSON.stringify({ password }));
  '
}

# Workspace-scoped, time-limited token body: {label, workspace_id, expiration}.
persistent_token_body() {
  WM_TMP_WORKSPACE="${WORKSPACE}" bun_eval '
    const workspace_id = process.env.WM_TMP_WORKSPACE ?? "";
    const expiration = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    process.stdout.write(JSON.stringify({ label: "factory-bootstrap", workspace_id, expiration }));
  '
}

variable_create_body() {
  # $1 = path, $2 = value, $3 = description
  WM_TMP_PATH="$1" WM_TMP_VALUE="$2" WM_TMP_DESC="$3" bun_eval '
    const path = process.env.WM_TMP_PATH ?? "";
    const value = process.env.WM_TMP_VALUE ?? "";
    const description = process.env.WM_TMP_DESC ?? "";
    process.stdout.write(JSON.stringify({ path, value, is_secret: true, description }));
  '
}

variable_update_body() {
  # $1 = value, $2 = description
  WM_TMP_VALUE="$1" WM_TMP_DESC="$2" bun_eval '
    const value = process.env.WM_TMP_VALUE ?? "";
    const description = process.env.WM_TMP_DESC ?? "";
    process.stdout.write(JSON.stringify({ value, is_secret: true, description }));
  '
}

folder_body() {
  bun_eval '
    process.stdout.write(JSON.stringify({
      name: "factory",
      summary: "Software Factory scripts, flows, resources, and variables.",
    }));
  '
}

# --- step 1: log in, changing the initial admin password on first run -----
status="$(login_body "${WM_ADMIN_PASSWORD}" | api_post /auth/login)"
if [ "${status}" = "200" ]; then
  SESSION_TOKEN="$(cat "${RESP_FILE}")"
  log "logged in with the configured admin password"
else
  status="$(login_body "changeme" | api_post /auth/login)"
  if [ "${status}" = "200" ]; then
    SESSION_TOKEN="$(cat "${RESP_FILE}")"
    log "logged in with the initial default password; changing it now"
    set_auth_token "${SESSION_TOKEN}"
    change_status="$(setpassword_body | api_post /users/setpassword)"
    [ "${change_status}" = "200" ] || die "failed to set the admin password (status ${change_status})"
    log "admin password changed to the value configured in mise.local.toml"
  else
    die "could not log in as ${WM_ADMIN_EMAIL} with either the configured WM_ADMIN_PASSWORD or the initial default (status ${status}). If the password was changed outside bootstrap, set WM_ADMIN_PASSWORD to match it."
  fi
fi
set_auth_token "${SESSION_TOKEN}"

# --- step 2: workspace, created with the session token (no scoped token yet) ---
# `--token` is the CLI's only way to hand it a token non-interactively; it
# has no stdin/file input mode for this. The value only ever reaches the
# `wmill` child process's argv, never a raw `curl`/API call.
run_wmill workspace add "${WORKSPACE}" "${WORKSPACE}" "${WM_BASE_URL}" \
  --token "${SESSION_TOKEN}" --create >&2
harden_wmill_config_dir
log "workspace '${WORKSPACE}' ready (using the session token for now)"

# Prints the resource_path of the 'main' datatable on stdout and exits 0 if
# it exists; exits 1 (nothing printed) otherwise.
datatable_main_resource_path() {
  local json
  json="$(run_wmill datatable list --json 2>/dev/null || true)"
  [ -n "${json}" ] || return 1
  WM_TMP_JSON="${json}" bun_eval '
    const json = process.env.WM_TMP_JSON ?? "[]";
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      process.exit(1);
    }
    const main = Array.isArray(parsed)
      ? parsed.find((item) => item && typeof item === "object" && item.name === "main")
      : undefined;
    if (main && typeof main.resource_path === "string" && main.resource_path.length > 0) {
      process.stdout.write(main.resource_path);
      process.exit(0);
    }
    process.exit(1);
  '
}

# --- step 3: instance-backed Postgres database (CREATE DATABASE + grants) --
# Requires superadmin, which the workspace-scoped token minted in step 4
# deliberately does not have - so this runs on the session token, before
# that token is minted. "datatable_db" is the resource_path this Windmill
# version (1.817.0 CE) assigns to a fresh instance-backed datatable; if
# 'main' already exists, use its real resource_path instead of assuming.
INSTANCE_DB_NAME="$(datatable_main_resource_path || true)"
INSTANCE_DB_NAME="${INSTANCE_DB_NAME:-datatable_db}"

instance_db_ready() {
  local status json
  status="$(api_post_no_body /settings/list_custom_instance_pg_databases)"
  [ "${status}" = "200" ] || return 1
  json="$(cat "${RESP_FILE}")"
  WM_TMP_JSON="${json}" WM_TMP_NAME="${INSTANCE_DB_NAME}" bun_eval '
    const json = process.env.WM_TMP_JSON ?? "{}";
    const name = process.env.WM_TMP_NAME ?? "";
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = {};
    }
    const entry = parsed && typeof parsed === "object" ? parsed[name] : undefined;
    process.exit(entry && entry.success === true ? 0 : 1);
  '
}

setup_instance_db_body() {
  bun_eval 'process.stdout.write(JSON.stringify({ tag: "datatable" }));'
}

# Prints a redacted {success, error, logs} summary of a
# setup_custom_instance_pg_database response to stderr. jq keeps the output
# to just those three fields (dropping anything else the API might ever
# add), and the sed pass belt-and-braces masks any postgres:// URL or
# "password" field that might slip into an error/log string.
log_setup_db_failure() {
  printf '%s\n' "$1" \
    | jq '{success, error, logs}' \
    | sed -E 's#postgres://[^"[:space:]]*#postgres://[REDACTED]#g; s/"password"[[:space:]]*:[[:space:]]*"[^"]*"/"password":"[REDACTED]"/gi' >&2
}

if instance_db_ready; then
  log "instance pg database '${INSTANCE_DB_NAME}' already set up"
else
  status="$(setup_instance_db_body | api_post "/settings/setup_custom_instance_pg_database/${INSTANCE_DB_NAME}")"
  setup_body="$(cat "${RESP_FILE}")"
  setup_ok="$(WM_TMP_BODY="${setup_body}" bun_eval '
    const body = process.env.WM_TMP_BODY ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    process.stdout.write(parsed && parsed.success === true ? "true" : "false");
  ')"
  if [ "${setup_ok}" = "true" ]; then
    log "instance pg database '${INSTANCE_DB_NAME}' set up"
  else
    log "setup_custom_instance_pg_database failed (status ${status}); details:"
    log_setup_db_failure "${setup_body}"
    die "could not set up instance pg database '${INSTANCE_DB_NAME}'"
  fi
fi

# --- step 4: mint a workspace-scoped, time-limited token --------------------
status="$(persistent_token_body | api_post /users/tokens/create)"
[ "${status}" = "201" ] || die "failed to create an API token (status ${status})"
PERSISTENT_TOKEN="$(cat "${RESP_FILE}")"
log "minted a workspace-scoped API token (label factory-bootstrap, workspace ${WORKSPACE}, 180-day expiry)"

# --- step 5: point the CLI's workspace profile at the scoped token ---------
# `wmill workspace add` always calls the global `POST /workspaces/exists`
# first (confirmed with --verbose), which a workspace-scoped token cannot
# call - it 401s regardless of --create, because that check is not scoped
# to a workspace. So the CLI call itself has to run on the session token
# (this is the "step that does not pass on the scoped token" the security
# review anticipated); we then patch just the `token` field of
# $WMILL_CONFIG_DIR/windmill/remotes.ndjson in place so every `wmill`
# invocation below actually uses PERSISTENT_TOKEN. This depends on that
# file's shape (one JSON object per line, keyed by name/remote/workspaceId/
# token) as of wmill CLI 1.817.0 - if a future CLI version changes it, the
# jq step below simply does not match and the CLI keeps using the session
# token; re-verify this step after any CLI upgrade.
run_wmill workspace add "${WORKSPACE}" "${WORKSPACE}" "${WM_BASE_URL}" \
  --token "${SESSION_TOKEN}" --create >&2
harden_wmill_config_dir
remotes_file="${WMILL_CONFIG_DIR%/}/windmill/remotes.ndjson"
if [ -f "${remotes_file}" ]; then
  (umask 077 && WM_TMP_NEW_TOKEN="${PERSISTENT_TOKEN}" jq -c --arg name "${WORKSPACE}" \
    'if .name == $name then .token = env.WM_TMP_NEW_TOKEN else . end' \
    "${remotes_file}" >"${remotes_file}.tmp")
  mv "${remotes_file}.tmp" "${remotes_file}"
  harden_wmill_config_dir
  log "swapped the CLI's stored token for the workspace-scoped one"
else
  die "expected ${remotes_file} to exist after 'wmill workspace add'"
fi
# From here on, direct API calls use PERSISTENT_TOKEN too (verifying it is
# enough for variables/folder/resource calls, same as the CLI calls above
# now use it via remotes.ndjson). The one exception is token-list/delete
# during rotation below, which needs the session token (see there).
set_auth_token "${PERSISTENT_TOKEN}"

# --- step 6: datatable -------------------------------------------------------
if resolved_path="$(datatable_main_resource_path)"; then
  log "datatable 'main' already registered; skipping create"
  if [ "${resolved_path}" != "${INSTANCE_DB_NAME}" ]; then
    log "note: 'main' datatable resource_path is '${resolved_path}', not '${INSTANCE_DB_NAME}' used above for instance pg database setup - re-run bootstrap so the right database gets set up"
  fi
else
  run_wmill datatable create >&2
  log "datatable 'main' created"
  resolved_path="$(datatable_main_resource_path || true)"
  if [ -n "${resolved_path}" ] && [ "${resolved_path}" != "${INSTANCE_DB_NAME}" ]; then
    log "note: 'main' datatable resource_path is '${resolved_path}', not '${INSTANCE_DB_NAME}' used above for instance pg database setup - re-run bootstrap so the right database gets set up"
  fi
fi

# --- step 7: secret variables ------------------------------------------------
upsert_variable() {
  local path="$1" value="$2" description="$3" status
  status="$(variable_create_body "${path}" "${value}" "${description}" | api_post "/w/${WORKSPACE}/variables/create")"
  if [ "${status}" = "201" ]; then
    log "variable ${path} created"
    return 0
  fi
  log "variable ${path} create returned ${status} (likely already exists); updating instead"
  status="$(variable_update_body "${value}" "${description}" | api_post "/w/${WORKSPACE}/variables/update/${path}")"
  [ "${status}" = "200" ] || die "failed to create or update variable ${path} (update status ${status})"
  log "variable ${path} updated"
}

upsert_variable "f/factory/claude_oauth_token" "${CLAUDE_CODE_OAUTH_TOKEN}" \
  "Claude Code long-lived OAuth token, passed to worker subprocesses as an env var."
upsert_variable "f/factory/github_token" "${GITHUB_TOKEN}" \
  "GitHub fine-grained PAT, passed to worker subprocesses as an env var."
upsert_variable "f/factory/wmill_token" "${PERSISTENT_TOKEN}" \
  "Workspace-scoped Windmill API token (180-day expiry) used by self_update to sync push / migrate from the worker."
upsert_variable "f/factory/discord_webhook_url" "${DISCORD_WEBHOOK_URL}" \
  "Discord incoming webhook URL used for pipeline notifications."

# --- step 8: rotate out old factory-bootstrap tokens ------------------------
# /users/tokens/list and /users/tokens/delete are account-global (no
# workspace scoping), so a workspace-scoped token 401s on them (confirmed
# with --verbose against a live instance) - this is the step the security
# review's "fall back to the session token" clause covers. It runs on the
# session token, and is why that token cannot be logged out until after
# this step. Only runs once the new token is durably saved in two places
# (the CLI workspace profile via remotes.ndjson above, and the
# wmill_token variable below), so a failure partway through rotation never
# leaves the instance without a working token.
rotate_old_bootstrap_tokens() {
  local status
  set_auth_token "${SESSION_TOKEN}"
  status="$(api_get '/users/tokens/list?exclude_ephemeral=true')"
  if [ "${status}" != "200" ]; then
    set_auth_token "${PERSISTENT_TOKEN}"
    die "failed to list tokens for rotation (status ${status})"
  fi
  local prefixes
  # Delete every token labeled factory-bootstrap whose prefix is not a
  # prefix of the token we just minted (i.e. every token except the current
  # one). The new token is passed via env, never as a jq --arg on argv.
  prefixes="$(WM_TMP_NEW_TOKEN="${PERSISTENT_TOKEN}" jq -r '
    env.WM_TMP_NEW_TOKEN as $new
    | .[]
    | select(.label == "factory-bootstrap")
    | select(.token_prefix as $prefix | ($new | startswith($prefix)) | not)
    | .token_prefix
  ' "${RESP_FILE}")"
  if [ -z "${prefixes}" ]; then
    log "no old factory-bootstrap tokens to rotate out"
  else
    local prefix del_status
    while IFS= read -r prefix; do
      [ -n "${prefix}" ] || continue
      del_status="$(api_delete "/users/tokens/delete/${prefix}")"
      if [ "${del_status}" = "200" ]; then
        log "rotated out old factory-bootstrap token (prefix ${prefix})"
      else
        log "warning: failed to delete old factory-bootstrap token (prefix ${prefix}, status ${del_status})"
      fi
    done <<<"${prefixes}"
  fi
  set_auth_token "${PERSISTENT_TOKEN}"
}
rotate_old_bootstrap_tokens

# --- step 9: log the session token out - no longer needed from here on -----
set_auth_token "${SESSION_TOKEN}"
logout_status="$(api_post_no_body /auth/logout)"
log "session token logged out (status ${logout_status})"
set_auth_token "${PERSISTENT_TOKEN}"

# --- step 10: folder -----------------------------------------------------------
folder_exists() {
  local status
  status="$(api_get "/w/${WORKSPACE}/folders/exists/factory")"
  [ "${status}" = "200" ] && [ "$(cat "${RESP_FILE}")" = "true" ]
}

if folder_exists; then
  log "folder 'factory' already exists; skipping create"
else
  status="$(folder_body | api_post "/w/${WORKSPACE}/folders/create")"
  [ "${status}" = "200" ] || die "failed to create folder 'factory' (status ${status})"
  log "folder 'factory' created"
fi

# --- step 11: instance-specific factory_config resource ---------------------
# Not synced (see wmill.yaml excludes: owners/instance_name/windmill_public_url
# are per-instance). Seed it from the template once; if it already exists,
# leave it alone so UI edits are never clobbered by a bootstrap re-run.
factory_config_exists() {
  local status
  status="$(api_get "/w/${WORKSPACE}/resources/exists/f/factory/factory_config")"
  [ "${status}" = "200" ] && [ "$(cat "${RESP_FILE}")" = "true" ]
}

if factory_config_exists; then
  log "resource f/factory/factory_config already exists; leaving it as configured in the Windmill UI"
else
  run_wmill resource push templates/factory_config.resource.yaml f/factory/factory_config >&2
  log "resource f/factory/factory_config created from templates/factory_config.resource.yaml (owners is empty)"
fi

# --- step 12: push local sync state -----------------------------------------
run_wmill sync push --yes --keep-deleted >&2
log "sync push complete"

# --- step 13: apply pending data table migrations ----------------------------
# FACTORY_BOOTSTRAP_SKIP_MIGRATE=1 is an escape hatch to stop bootstrap right
# before this step (e.g. to manually verify the instance pg database state
# after step 3 before letting `migrate up` touch it). Deliberately
# undocumented outside this script - it is for operators who already know
# why they need it, not a routine flag.
if [ -n "${FACTORY_BOOTSTRAP_SKIP_MIGRATE:-}" ]; then
  log "FACTORY_BOOTSTRAP_SKIP_MIGRATE is set; skipping 'wmill datatable migrate up'"
else
  run_wmill datatable migrate up >&2
  log "datatable migrations applied"
fi

# --- step 14: regenerate the RT namespace ------------------------------------
run_wmill resource-type generate-namespace >&2
log "rt.d.ts regenerated"

log "bootstrap complete"
log "open ${WM_BASE_URL} and sign in as ${WM_ADMIN_EMAIL} with the password from mise.local.toml"
log "in the Windmill UI, set owners and instance_name on f/factory/factory_config (it is not synced from git)"
