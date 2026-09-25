#!/usr/bin/env bash
# doctor.sh - environment health check for the local Software Factory stack.
# Prints an OK/NG table and exits 1 if any check failed.
#
# There is no infra/.env or infra/secrets.env: configuration lives in mise's
# [env] block (non-secret, committed in mise.toml) and in mise.local.toml
# (gitignored secrets, populated via `mise set -E local KEY=value`). This
# script is meant to run as a mise task (`mise run doctor`) so those values
# are already present in its environment; it never reads or prints them from
# a file, and it never prints a secret's value, only whether it is set.
set -euo pipefail

# Resolve the repository root from this script's own location so it works
# regardless of the caller's current directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"

NG_COUNT=0

# Print one result row and track failures.
# Usage: report <label> <ok|ng> [detail]
report() {
  local label="$1" status="$2" detail="${3:-}"
  if [[ "${status}" == "ok" ]]; then
    printf '  OK  %-32s %s\n' "${label}" "${detail}"
  else
    printf '  NG  %-32s %s\n' "${label}" "${detail}"
    NG_COUNT=$((NG_COUNT + 1))
  fi
}

echo "=== Software Factory 環境診断 ==="
echo

# 1. docker CLI と daemon
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    report "docker" ok "CLI / daemon ともに利用できます"
  else
    report "docker" ng "docker CLI はありますが daemon に接続できません"
  fi
else
  report "docker" ng "docker コマンドが見つかりません"
fi

# 2. docker compose v2
if docker compose version >/dev/null 2>&1; then
  report "docker compose" ok "$(docker compose version --short 2>/dev/null || echo v2)"
else
  report "docker compose" ng "docker compose (v2 プラグイン) が見つかりません"
fi

# 3. mise の有無
if command -v mise >/dev/null 2>&1; then
  report "mise" ok "$(mise --version 2>/dev/null || true)"
else
  report "mise" ng "mise コマンドが見つかりません"
fi

# 4. mise.toml が trust されているか
# `mise trust --show` は `~/path/to/repo: trusted` のように、ホームディレクトリ
# 配下は `~` に短縮したディレクトリ単位の行で出力する(ファイル名は付かない)。
# REPO_ROOT の $HOME 部分を `~` に置換した文字列と、念のため絶対パスの両方で
# 行全体にマッチさせる。
if command -v mise >/dev/null 2>&1; then
  # A bare ~ in the replacement is itself tilde-expanded by bash before the
  # substitution runs, so it would expand back to $HOME and silently no-op.
  # Escaping it keeps it literal.
  tilde_root="${REPO_ROOT/#$HOME/\~}"
  if mise trust --show 2>/dev/null | grep -qE "^(${tilde_root}|${REPO_ROOT}): *trusted$"; then
    report "mise.toml trust" ok "信頼済みです"
  else
    report "mise.toml trust" ng "未信頼です (リポジトリ直下で 'mise trust' を実行してください)"
  fi
else
  report "mise.toml trust" ng "mise が無いため確認できません"
fi

# 5. mise 経由のツール導入確認
if command -v mise >/dev/null 2>&1; then
  for name in wmill gh bun node; do
    case "${name}" in
      wmill) cmd=(wmill --version) ;;
      gh) cmd=(gh --version) ;;
      bun) cmd=(bun --version) ;;
      node) cmd=(node --version) ;;
    esac
    if output="$(cd "${REPO_ROOT}" && mise exec -- "${cmd[@]}" 2>&1)"; then
      report "tool: ${name}" ok "$(printf '%s' "${output}" | head -n1)"
    else
      report "tool: ${name}" ng "mise exec -- ${cmd[*]} の実行に失敗しました"
    fi
  done
else
  report "tool: wmill/gh/bun/node" ng "mise が無いため確認できません"
fi

# 6. 必須環境変数が設定されているか。
# 値そのものはログに一切出さない(存在確認のみ)。mise の [env] / mise.local.toml
# から渡される想定なので、このスクリプトを直接実行するのではなく
# `mise run doctor` 経由で実行しているか確認すること。
required_vars=(
  DB_PASSWORD
  WM_VERSION
  WM_HTTP_PORT
  WM_BIND
  WM_ADMIN_EMAIL
  WM_ADMIN_PASSWORD
  GITHUB_TOKEN
  CLAUDE_CODE_OAUTH_TOKEN
  DISCORD_WEBHOOK_URL
)
missing_vars=()
for key in "${required_vars[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing_vars+=("${key}")
  fi
done
env_guidance="'mise run doctor' 経由で実行しているか、'mise set -E local KEY=value' で投入したか確認してください"
if [[ ${#missing_vars[@]} -gt 0 ]]; then
  report "環境変数" ng "未設定: ${missing_vars[*]} (${env_guidance})"
elif [[ "${WM_ADMIN_PASSWORD}" == "changeme" ]]; then
  report "環境変数" ng "WM_ADMIN_PASSWORD が初期値 changeme のままです"
else
  report "環境変数" ok "必須キー ${#required_vars[@]} 件すべて設定されています"
fi

# 7. mise.local.toml が gitignore されているか(秘密情報の誤コミット防止)
if git -C "${REPO_ROOT}" check-ignore -q mise.local.toml; then
  report "mise.local.toml" ok "gitignore 対象です"
else
  report "mise.local.toml" ng "gitignore されていません。秘密情報が誤ってコミットされる恐れがあります"
fi

# 8. ポートの空き、または Windmill が応答しているか
wm_http_port="${WM_HTTP_PORT:-8080}"

windmill_is_up=0
if curl -fs "http://127.0.0.1:${wm_http_port}/api/version" >/dev/null 2>&1; then
  version_body="$(curl -fs "http://127.0.0.1:${wm_http_port}/api/version" 2>/dev/null || true)"
  report "port ${wm_http_port}" ok "Windmill が応答しています (version: ${version_body})"
  windmill_is_up=1
elif (exec 3<>"/dev/tcp/127.0.0.1/${wm_http_port}") 2>/dev/null; then
  exec 3<&- 3>&- 2>/dev/null || true
  report "port ${wm_http_port}" ng "ポートは使用中ですが Windmill の応答ではありません"
else
  report "port ${wm_http_port}" ok "空いています (未起動)"
fi

# 9. worker コンテナ内のツール確認(スタックが起動している場合のみ)
if command -v docker >/dev/null 2>&1 && [[ -f "${COMPOSE_FILE}" ]]; then
  worker_id="$(docker compose -f "${COMPOSE_FILE}" ps -q windmill_worker 2>/dev/null || true)"
  worker_running=0
  if [[ -n "${worker_id}" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "${worker_id}" 2>/dev/null || echo false)" == "true" ]]; then
    worker_running=1
  fi
  if [[ "${worker_running}" -eq 1 ]]; then
    for name in claude gh gtr; do
      case "${name}" in
        claude) cmd=(claude --version) ;;
        gh) cmd=(gh --version) ;;
        gtr) cmd=(git gtr version) ;;
      esac
      if docker compose -f "${COMPOSE_FILE}" exec -T windmill_worker "${cmd[@]}" >/dev/null 2>&1; then
        report "worker: ${name}" ok "コンテナ内で実行できました"
      else
        report "worker: ${name}" ng "コンテナ内での実行に失敗しました"
      fi
    done
  else
    report "worker コンテナ" ok "スタック未起動のためスキップしました"
  fi
else
  report "worker コンテナ" ng "docker または docker-compose.yml が見つからず確認できません"
fi

# 10. 初期パスワードのままログインできてしまわないか(Windmill が応答している場合のみ)
if [[ "${windmill_is_up}" -eq 1 ]]; then
  login_status="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:${wm_http_port}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@windmill.dev","password":"changeme"}' 2>/dev/null || echo "000")"
  if [[ "${login_status}" == "200" ]]; then
    report "初期パスワード" ng "admin@windmill.dev / changeme でログインできてしまいます。至急変更してください"
  else
    report "初期パスワード" ok "初期パスワードではログインできません"
  fi
else
  report "初期パスワード" ok "Windmill 未起動のためスキップしました"
fi

echo
if [[ "${NG_COUNT}" -eq 0 ]]; then
  echo "=== 全項目 OK ==="
  exit 0
else
  echo "=== NG が ${NG_COUNT} 件あります ==="
  exit 1
fi
