#!/usr/bin/env bash
# Software FactoryのローカルのWindmillワークスペースを初回に設定する。
# 冪等なので、何度実行し直してもよい。
#
# `infra/.env`も`infra/secrets.env`も無く、設定は`mise.toml`の`[env]`
# (秘密でないものをコミット)と`mise.local.toml`(gitignore済みの秘密。
# `mise set -E local KEY=value`で入れる)にある。このスクリプトはmiseの
# タスク(`mise run bootstrap`)として動かす前提なので、値は既に環境変数にある。
# 秘密のファイルは読まず、秘密の値も表示しない(任意の秘密は設定の有無だけを出す)。
# APIを直接呼ぶときの`Authorization`ヘッダーは、curlの引数ではなく0700の
# 一時ディレクトリ内の0600のファイルから送る(`set_auth_token`・`AUTH_HEADER_FILE`
# を参照)。こうしてトークンが`ps`の出力にも出ないようにする。
#
# 秘密をCLIの引数で渡さない原則の唯一の例外は`wmill workspace add --token`。
# wmill CLI 1.817.0には、他にトークンを渡す方法が無い(呼び出し箇所のコメントを参照)。
#
# トークンは2つ使う。`SESSION_TOKEN`(`/auth/login`で得る)はアカウントの全権限を
# 持ち、それを要る少数の操作だけに使う。ワークスペースの作成、superadminだけが
# できるインスタンスのデータベースの設定、トークンの一覧と削除(どちらも
# ワークスペースではなくアカウント全体の操作。手順8を参照)。
# `PERSISTENT_TOKEN`はこのワークスペースだけに絞り、期限180日で発行する。
# 手順6以降のWindmillとのやり取りはすべてこれで行う(`wmill` CLIは
# ワークスペースのプロファイル経由、APIの直接呼び出しは`Authorization`ヘッダー
# 経由)。この動作は実際のインスタンスで通しで確かめた。`SESSION_TOKEN`は、
# それを要するトークンの入れ替えが終わったらすぐにログアウトする。
#
# 手順(冪等で、実行し直しても安全):
#   0. `WM_ADMIN_PASSWORD`が既定の"changeme"か12文字未満なら実行を拒む。
#   1. インスタンスの管理者でログインする(設定したパスワードで、初回は
#      Windmillの既定の"changeme"に戻して試す)。初回はパスワードを
#      `WM_ADMIN_PASSWORD`に変える。-> `SESSION_TOKEN`
#   2. セッションのトークンで
#      `wmill workspace add factory factory $WM_BASE_URL --token <session> --create`
#      を実行する(無ければワークスペースを作る)。ワークスペース用の
#      トークンはまだ無いため。続けて`POST .../workspaces/change_workspace_name`で
#      表示名を"Factory"にする(idは小文字の"factory"のまま)。冪等で、毎回
#      実行し直してよい。
#   3. インスタンスが持つPostgresのデータベースを用意する
#      (`custom_instance_user`への`CREATE DATABASE`と権限付与)。セッションの
#      トークンで、公式のsuperadmin用API
#      (`/settings/{list,setup}_custom_instance_pg_database*`)を使う。
#      データベースが既にあればAPIは`CREATE DATABASE`を飛ばし権限だけを
#      付与し直すので、毎回実行しても安全。これをしないと、新しいインスタンスの
#      datatableを初めて使うとき`wmill datatable migrate up`が
#      "permission denied for schema public"で失敗する。
#   4. ワークスペースに絞ったAPIトークン(ラベル`factory-bootstrap`、
#      `workspace_id`は`factory`、期限180日)を発行する。-> `PERSISTENT_TOKEN`
#   5. セッションのトークンでもう一度`wmill workspace add`を実行する
#      (このコマンドが最初に必ず行う`POST /workspaces/exists`の確認で、
#      ワークスペース用のトークンは401になる。`--verbose`で確認済み。
#      この手順のコメントを参照)。その後
#      `$WMILL_CONFIG_DIR/windmill/remotes.ndjson`の`token`だけを
#      `PERSISTENT_TOKEN`に書き換え、以降の`wmill`の呼び出しが
#      絞ったトークンを使うようにする。
#   6. `wmill datatable create`を実行する(`main`のdatatableが既にあれば飛ばす)。
#   7. 4つの秘密の変数(`claude_oauth_token`・`github_token`・`wmill_token`・
#      `discord_webhook_url`)を変数のAPIで作成・更新する。`wmill_token`には
#      `PERSISTENT_TOKEN`を入れる。残りの3つは`CLAUDE_CODE_OAUTH_TOKEN`・
#      `GITHUB_TOKEN`・`DISCORD_WEBHOOK_URL`から取り、空でもよい
#      (後で人が`mise set -E local`かWindmill UIで入れる)。
#   8. 古いトークンを入れ替える。`/users/tokens/list`と`/users/tokens/delete`は
#      アカウント全体の操作なので、セッションのトークンで行う
#      (`PERSISTENT_TOKEN`ではtoken/listが401になることを確認済み)。
#      新しいトークンを2か所(手順5の`remotes.ndjson`によるCLIのプロファイルと、
#      手順7の`wmill_token`変数)に確実に保存した後でだけ動かす。入れ替えの
#      途中で失敗しても、インスタンスに使えるトークンが無くならないようにするため。
#      ラベルが`factory-bootstrap`の他のトークンをすべて削除する。
#   9. セッションのトークンをログアウトする(`/auth/logout`)。以降は使わない。
#  10. `factory`フォルダが無ければ作る。
#  11. リモートに無ければ、`templates/factory_config.resource.yaml`から
#      `f/factory/factory_config`を作る。このリソースはインスタンス固有
#      (`owners`・`instance_name`・`windmill_public_url`)でsyncの対象外
#      (`wmill.yaml`を参照)。bootstrapは既存のものを上書きしないので、
#      UIでの編集が常に優先される。
#  12. リモートに無ければ、秘密でない変数`f/factory/deployed_sha`を空の値で作る。
#      これもsyncの対象外(`wmill.yaml`を参照)だが、理由は`factory_config`と違う。
#      インスタンスの設定ではなく`self_update`の実行時の状態であり、
#      bootstrapを実行し直しても空に戻してはならないため。
#  13. `wmill sync push --yes --keep-deleted`
#  14. `wmill datatable migrate up`
#  15. `wmill resource-type generate-namespace`(`rt.d.ts`を書く)
#  16. 次の手順を表示する。
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

# --- 必須の設定(秘密でないもの、インスタンスの秘密) -------------------------
: "${WM_BASE_URL:?run via 'mise run bootstrap' (mise.toml [env] sets this)}"
: "${WM_ADMIN_EMAIL:?run via 'mise run bootstrap'; set with: mise set -E local WM_ADMIN_EMAIL=...}"
: "${WM_ADMIN_PASSWORD:?run via 'mise run bootstrap'; set with: mise set -E local WM_ADMIN_PASSWORD=...}"

# --- 手順0: 弱い・既定の管理者パスワードでは実行を拒む ----------------------
if [ "${WM_ADMIN_PASSWORD}" = "changeme" ] || [ "${#WM_ADMIN_PASSWORD}" -lt 12 ]; then
  die "WM_ADMIN_PASSWORD is the 'changeme' default or shorter than 12 characters; set a strong password: mise set -E local WM_ADMIN_PASSWORD=..."
fi

# --- 任意の秘密。空でもbootstrapは動き、対応する変数を空で作成・更新する。
# 人が本当の値を入れるまで、後続のフロー(poll_issues・pipeline)と、
# Discordへ送るライブラリ関数(`f/factory/lib/discord.ts`の`notify`)を使う処理は、
# needs_humanやnoticeで知らせる ---
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
# `Authorization`ヘッダーは、0700の`TMP_DIR`内の専用の0600のファイルに置く。
# curlは`-H @file`で読むので、トークンをコマンドラインの引数で渡さない
# (引数だと、同じマシンの誰でも`ps`で見られる)。
AUTH_HEADER_FILE="${TMP_DIR}/auth_header.txt"

# リポジトリのルートをcwdにし、miseのツールのPATHと環境変数を適用して
# コマンドを実行する。最上位で`cd`せず、このサブシェルの中だけで移る。
run_in_repo() {
  (cd -- "${REPO_ROOT}" && mise exec -- "$@")
}

run_wmill() { run_in_repo wmill "$@"; }

# 小さなbunのスクリプトを、リポジトリをcwdにして評価する。呼び出し側が
# 前置の代入で設定した`WM_TMP_*`の環境変数がスクリプトから見える。
# 値は環境変数か標準入力だけで渡し、argvには載せない。
bun_eval() { run_in_repo bun -e "$1"; }

# wmill CLIの設定ディレクトリ(`remotes.ndjson`のトークンを含むワークスペースの
# プロファイル)を、グループや他人が読めないようにする。
harden_wmill_config_dir() {
  if [ -n "${WMILL_CONFIG_DIR:-}" ] && [ -d "${WMILL_CONFIG_DIR}" ]; then
    chmod 700 "${WMILL_CONFIG_DIR}" 2>/dev/null || true
    find "${WMILL_CONFIG_DIR}" -type f -name 'remotes*.ndjson' -exec chmod 600 {} + 2>/dev/null || true
  fi
}

if ! curl -fsS -o /dev/null --max-time 10 "${WM_BASE_URL%/}/api/version"; then
  die "cannot reach Windmill at ${WM_BASE_URL} (run 'mise run up' first)"
fi

# set_auth_token TOKEN: 以降の`api_*`の呼び出しがTOKENで認証するよう、
# `AUTH_HEADER_FILE`と`AUTH_TOKEN`変数を更新する(`AUTH_TOKEN`は、argvでなく
# 環境変数から読むjqの補助関数が使う)。""を渡すと消す。
AUTH_TOKEN=""
set_auth_token() {
  AUTH_TOKEN="$1"
  if [ -n "${AUTH_TOKEN}" ]; then
    (umask 077 && printf 'Authorization: Bearer %s\n' "${AUTH_TOKEN}" >"${AUTH_HEADER_FILE}")
  else
    rm -f "${AUTH_HEADER_FILE}"
  fi
}

# api_post PATH: 標準入力からJSONの本文を読み、HTTPのステータスコードを出す。
api_post() {
  local path="$1"
  local -a headers=(-H 'Content-Type: application/json')
  [ -f "${AUTH_HEADER_FILE}" ] && headers+=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X POST "${API}${path}" "${headers[@]}" --data-binary @-
}

# api_get PATH: HTTPのステータスコードを出す。本文は`$RESP_FILE`に入る。
api_get() {
  local path="$1"
  local -a headers=()
  [ -f "${AUTH_HEADER_FILE}" ] && headers=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X GET "${API}${path}" "${headers[@]}"
}

# api_post_no_body PATH: 本文を取らないエンドポイント用の`api_post`。
api_post_no_body() {
  local path="$1"
  local -a headers=()
  [ -f "${AUTH_HEADER_FILE}" ] && headers=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X POST "${API}${path}" "${headers[@]}"
}

# api_delete PATH: HTTPのステータスコードを出す。本文は`$RESP_FILE`に入る。
api_delete() {
  local path="$1"
  local -a headers=()
  [ -f "${AUTH_HEADER_FILE}" ] && headers=(-H "@${AUTH_HEADER_FILE}")
  curl -sS -o "${RESP_FILE}" -w '%{http_code}' -X DELETE "${API}${path}" "${headers[@]}"
}

login_body() {
  # $1 = パスワード
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

# ワークスペースに絞った期限付きトークンの本文: {label, workspace_id, expiration}
persistent_token_body() {
  WM_TMP_WORKSPACE="${WORKSPACE}" bun_eval '
    const workspace_id = process.env.WM_TMP_WORKSPACE ?? "";
    const expiration = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    process.stdout.write(JSON.stringify({ label: "factory-bootstrap", workspace_id, expiration }));
  '
}

variable_create_body() {
  # $1 = パス、$2 = 値、$3 = 説明、$4 = is_secret("true"か"false"。既定は"true")。
  # 呼び出し箇所はどれも秘密を作り、手順12の`deployed_sha`だけが秘密でない
  # 例外として"false"を渡す。
  local is_secret="${4:-true}"
  WM_TMP_PATH="$1" WM_TMP_VALUE="$2" WM_TMP_DESC="$3" WM_TMP_IS_SECRET="${is_secret}" bun_eval '
    const path = process.env.WM_TMP_PATH ?? "";
    const value = process.env.WM_TMP_VALUE ?? "";
    const description = process.env.WM_TMP_DESC ?? "";
    const is_secret = process.env.WM_TMP_IS_SECRET === "true";
    process.stdout.write(JSON.stringify({ path, value, is_secret, description }));
  '
}

variable_update_body() {
  # $1 = 値、$2 = 説明
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

change_workspace_name_body() {
  bun_eval 'process.stdout.write(JSON.stringify({ new_name: "Factory" }));'
}

# --- 手順1: ログインし、初回は管理者の初期パスワードを変える ----------------
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

# --- 手順2: ワークスペース。絞ったトークンはまだ無いので、セッションのトークンで作る ---
# 対話無しでCLIにトークンを渡す方法は`--token`しかなく、標準入力やファイルから
# 渡す方法は無い。値は`wmill`の子プロセスのargvにだけ届き、curlやAPIの
# 直接呼び出しには載せない。
run_wmill workspace add "${WORKSPACE}" "${WORKSPACE}" "${WM_BASE_URL}" \
  --token "${SESSION_TOKEN}" --create >&2
harden_wmill_config_dir
log "workspace '${WORKSPACE}' ready (using the session token for now)"

# idは小文字("factory")のまま、表示名はUI(Factory Consoleなど)に合わせて
# 先頭を大文字("Factory")にする。冪等で、実行し直して同じ名前を設定しても何も変わらない。
status="$(change_workspace_name_body | api_post "/w/${WORKSPACE}/workspaces/change_workspace_name")"
[ "${status}" = "200" ] || die "failed to set workspace display name (status ${status})"
log "workspace display name set to 'Factory'"

# `main`のdatatableがあれば、その`resource_path`を標準出力に出して0で終わる。
# 無ければ何も出さず1で終わる。
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

# --- 手順3: インスタンスが持つPostgresのデータベース(CREATE DATABASEと権限付与) --
# superadminの権限が要り、手順4で発行するワークスペース用のトークンは意図して
# それを持たない。そのため、そのトークンを発行する前にセッションのトークンで行う。
# "datatable_db"は、このWindmillの版(1.817.0 CE)が新しいインスタンスの
# datatableに割り当てる`resource_path`。`main`が既にあれば、決め打ちせず
# 実際の`resource_path`を使う。
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

# `setup_custom_instance_pg_database`の応答を、伏せ字にした
# {success, error, logs}の要約にして標準エラーに出す。jqで3つの項目だけに絞り
# (APIが将来足すかもしれない他の項目は捨てる)、さらに念のためsedで、
# エラーやログの文字列に紛れたpostgres://のURLと"password"の項目を伏せる。
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

# --- 手順4: ワークスペースに絞った期限付きのトークンを発行する --------------
status="$(persistent_token_body | api_post /users/tokens/create)"
[ "${status}" = "201" ] || die "failed to create an API token (status ${status})"
PERSISTENT_TOKEN="$(cat "${RESP_FILE}")"
log "minted a workspace-scoped API token (label factory-bootstrap, workspace ${WORKSPACE}, 180-day expiry)"

# --- 手順5: CLIのワークスペースのプロファイルを絞ったトークンに向ける --------
# `wmill workspace add`は最初に必ずグローバルな`POST /workspaces/exists`を呼ぶ
# (`--verbose`で確認済み)。この確認はワークスペース単位ではないので、
# ワークスペース用のトークンでは`--create`の有無に関係なく401になる。
# そのためCLIの呼び出しはセッションのトークンで行い、その後
# `$WMILL_CONFIG_DIR/windmill/remotes.ndjson`の`token`だけをその場で書き換え、
# 以降の`wmill`の呼び出しが`PERSISTENT_TOKEN`を使うようにする。
# これはwmill CLI 1.817.0時点のファイルの形(1行に1つのJSONオブジェクトで、
# キーはname・remote・workspaceId・token)に依存する。将来のCLIで形が変わると、
# 下のjqが一致せず、CLIはセッションのトークンを使い続ける。
# CLIを更新したら、この手順を確かめ直すこと。
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
# ここからは、APIの直接呼び出しも`PERSISTENT_TOKEN`を使う(変数・フォルダ・
# リソースの呼び出しにはこれで足りる。上のCLIも`remotes.ndjson`経由でこれを使う)。
# 唯一の例外は下の入れ替えでのトークンの一覧と削除で、セッションのトークンが要る。
set_auth_token "${PERSISTENT_TOKEN}"

# --- 手順6: datatable -----------------------------------------------------------
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

# --- 手順7: 秘密の変数 ---------------------------------------------------------
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

# --- 手順8: 古いfactory-bootstrapのトークンを入れ替える ---------------------
# `/users/tokens/list`と`/users/tokens/delete`はアカウント全体の操作
# (ワークスペース単位でない)なので、ワークスペース用のトークンでは401になる
# (実際のインスタンスに対し`--verbose`で確認済み)。そのためセッションの
# トークンで行い、この手順が終わるまでセッションのトークンをログアウトできない。
# 新しいトークンを2か所(上の`remotes.ndjson`によるCLIのプロファイルと、
# `wmill_token`変数)に確実に保存した後でだけ動かす。入れ替えの途中で
# 失敗しても、インスタンスに使えるトークンが無くならないようにするため。
rotate_old_bootstrap_tokens() {
  local status
  set_auth_token "${SESSION_TOKEN}"
  status="$(api_get '/users/tokens/list?exclude_ephemeral=true')"
  if [ "${status}" != "200" ]; then
    set_auth_token "${PERSISTENT_TOKEN}"
    die "failed to list tokens for rotation (status ${status})"
  fi
  local prefixes
  # ラベルが`factory-bootstrap`で、接頭辞が今発行したトークンの接頭辞でない
  # もの(今のトークン以外のすべて)を削除する。新しいトークンは環境変数で渡し、
  # argvに載るjqの`--arg`では渡さない。
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

# --- 手順9: セッションのトークンをログアウトする。以降は使わない ------------
set_auth_token "${SESSION_TOKEN}"
logout_status="$(api_post_no_body /auth/logout)"
log "session token logged out (status ${logout_status})"
set_auth_token "${PERSISTENT_TOKEN}"

# --- 手順10: フォルダ -----------------------------------------------------------
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

# --- 手順11: インスタンス固有のfactory_configリソース ------------------------
# syncの対象外(`wmill.yaml`の`excludes`を参照。`owners`・`instance_name`・
# `windmill_public_url`はインスタンスごとに違う)。テンプレートから一度だけ作り、
# 既にあれば触らない。bootstrapを実行し直しても、UIでの編集を上書きしないため。
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

# --- 手順12: インスタンス固有のdeployed_sha変数(無ければ作る) -------------
# syncの対象外(`wmill.yaml`の`excludes`のこのパスのコメントを参照)。
# 秘密でないこの変数には`self_update`が実行時に書き込む。手順7の4つの秘密は
# 実行し直すたびに上書きしてよいが、これは一度だけ作り、後の実行で空に
# 戻してはならない。空に戻すと`self_update`が毎回再デプロイが要ると判断し、
# ホストで進行中の`mise run deploy`と競合する。
# 存在の判定は作成の応答のステータスで行う(上の`upsert_variable`と同じく、
# 201以外は既にあるとみなす)。201以外ならログを残すだけで既存の値は触らず、
# updateは呼ばない。
deployed_sha_create_status="$(variable_create_body "f/factory/deployed_sha" "" \
  "Software Factory 自身のうち、直近で Windmill に反映済みのコミットです。自己更新処理が自動的に更新します。" \
  "false" | api_post "/w/${WORKSPACE}/variables/create")"
if [ "${deployed_sha_create_status}" = "201" ]; then
  log "variable f/factory/deployed_sha created (empty)"
else
  log "variable f/factory/deployed_sha create returned ${deployed_sha_create_status} (likely already exists); leaving its value alone"
fi

# --- 手順13: ローカルのsyncの状態をpushする ------------------------------------
# バンドルがraw appに対して走らせるnpmにも、依存のinstall scriptを動かさせない。
NPM_CONFIG_IGNORE_SCRIPTS=true run_wmill sync push --yes --keep-deleted >&2
log "sync push complete"

# --- 手順14: 未適用のData Tableのmigrationを適用する ---------------------------
# `FACTORY_BOOTSTRAP_SKIP_MIGRATE=1`は、この手順の直前でbootstrapを止める
# 非常口(例: 手順3の後のインスタンスのデータベースの状態を、`migrate up`が
# 触る前に手で確かめたいとき)。意図してこのスクリプトの外には書いていない。
# 必要な理由を分かっている運用者向けで、普段使うフラグではない。
if [ -n "${FACTORY_BOOTSTRAP_SKIP_MIGRATE:-}" ]; then
  log "FACTORY_BOOTSTRAP_SKIP_MIGRATE is set; skipping 'wmill datatable migrate up'"
else
  run_wmill datatable migrate up >&2
  log "datatable migrations applied"
fi

# --- 手順15: リソース型の名前空間を作り直す ------------------------------------
run_wmill resource-type generate-namespace >&2
log "rt.d.ts regenerated"

log "bootstrap complete"
log "open ${WM_BASE_URL} and sign in as ${WM_ADMIN_EMAIL} with the password from mise.local.toml"
log "in the Windmill UI, set owners and instance_name on f/factory/factory_config (it is not synced from git)"
