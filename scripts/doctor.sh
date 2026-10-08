#!/usr/bin/env bash
# ローカルのSoftware Factoryのスタックの環境を点検する。
# OK・NGの表を出し、1つでも失敗があれば終了コード1で終わる。
#
# `infra/.env`も`infra/secrets.env`も無く、設定は`mise.toml`の`[env]`
# (秘密でないものをコミット)と`mise.local.toml`(gitignore済みの秘密。
# `mise set -E local KEY=value`で入れる)にある。このスクリプトはmiseの
# タスク(`mise run doctor`)として動かす前提なので、値は既に環境変数にある。
# ファイルから値を読んだり表示したりせず、秘密は値を出さず設定の有無だけを出す。
set -euo pipefail

# 呼び出し側のカレントディレクトリに関係なく動くよう、リポジトリのルートを
# このスクリプト自身の場所から求める。
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.yml"

NG_COUNT=0

# 結果を1行出し、失敗を数える。
# 使い方: report <label> <ok|ng> [detail]
report() {
  local label="$1" status="$2" detail="${3:-}"
  if [[ "${status}" == "ok" ]]; then
    printf '  OK  %-32s %s\n' "${label}" "${detail}"
  else
    printf '  NG  %-32s %s\n' "${label}" "${detail}"
    NG_COUNT=$((NG_COUNT + 1))
  fi
}

echo "=== Software Factory環境診断 ==="
echo

# 1. docker CLIとdaemon
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    report "docker" ok "CLI / daemonともに利用できます"
  else
    report "docker" ng "docker CLIはありますがdaemonに接続できません"
  fi
else
  report "docker" ng "dockerコマンドが見つかりません"
fi

# 2. docker compose v2
if docker compose version >/dev/null 2>&1; then
  report "docker compose" ok "$(docker compose version --short 2>/dev/null || echo v2)"
else
  report "docker compose" ng "docker compose (v2プラグイン)が見つかりません"
fi

# 3. miseの有無
if command -v mise >/dev/null 2>&1; then
  report "mise" ok "$(mise --version 2>/dev/null || true)"
else
  report "mise" ng "miseコマンドが見つかりません"
fi

# 4. `mise.toml`がtrustされているか
# `mise trust --show`は`~/path/to/repo: trusted`のように、ホームディレクトリの
# 下を`~`に縮めたディレクトリ単位の行で出す(ファイル名は付かない)。
# `REPO_ROOT`の`$HOME`の部分を`~`に置き換えた文字列と、念のため絶対パスの
# 両方で、行全体に一致させる。
if command -v mise >/dev/null 2>&1; then
  # 置換後の文字列の裸の`~`は、置換の前にbashがチルダ展開して`$HOME`に戻し、
  # 何も置き換わらない。エスケープして文字どおりの`~`にする。
  tilde_root="${REPO_ROOT/#$HOME/\~}"
  if mise trust --show 2>/dev/null | grep -qE "^(${tilde_root}|${REPO_ROOT}): *trusted$"; then
    report "mise.toml trust" ok "信頼済みです"
  else
    report "mise.toml trust" ng "未信頼です(リポジトリ直下で 'mise trust' を実行してください)"
  fi
else
  report "mise.toml trust" ng "miseが無いため確認できません"
fi

# 5. mise経由でツールが入っているか
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
      report "tool: ${name}" ng "mise exec -- ${cmd[*]}の実行に失敗しました"
    fi
  done
else
  report "tool: wmill/gh/bun/node" ng "miseが無いため確認できません"
fi

# 6. 必須環境変数が設定されているか。
# 値そのものはログに一切出さず、有無だけを確かめる。miseの`[env]`と
# `mise.local.toml`から渡す前提なので、直接ではなく`mise run doctor`で
# 実行しているかを確かめること。
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
  CONSOLE_GITHUB_TOKEN
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
  report "環境変数" ng "WM_ADMIN_PASSWORDが初期値changemeのままです"
else
  report "環境変数" ok "必須キー${#required_vars[@]}件すべて設定されています"
fi

# 7. `mise.local.toml`がgitignoreされているか(秘密の誤コミットを防ぐ)
if git -C "${REPO_ROOT}" check-ignore -q mise.local.toml; then
  report "mise.local.toml" ok "gitignore対象です"
else
  report "mise.local.toml" ng "gitignoreされていません。秘密情報が誤ってコミットされる恐れがあります"
fi

# 8. ポートが空いているか、またはWindmillが応答しているか
wm_http_port="${WM_HTTP_PORT:-8080}"

windmill_is_up=0
if curl -fs "http://127.0.0.1:${wm_http_port}/api/version" >/dev/null 2>&1; then
  version_body="$(curl -fs "http://127.0.0.1:${wm_http_port}/api/version" 2>/dev/null || true)"
  report "port ${wm_http_port}" ok "Windmillが応答しています(version: ${version_body})"
  windmill_is_up=1
elif (exec 3<>"/dev/tcp/127.0.0.1/${wm_http_port}") 2>/dev/null; then
  exec 3<&- 3>&- 2>/dev/null || true
  report "port ${wm_http_port}" ng "ポートは使用中ですがWindmillの応答ではありません"
else
  report "port ${wm_http_port}" ok "空いています(未起動)"
fi

# 9. workerのコンテナ内のツールの確認(スタックが起動している場合だけ)
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
    report "workerコンテナ" ok "スタック未起動のためスキップしました"
  fi
else
  report "workerコンテナ" ng "dockerまたはdocker-compose.ymlが見つからず確認できません"
fi

# 10. 初期パスワードのままログインできてしまわないか(Windmillが応答している場合だけ)
if [[ "${windmill_is_up}" -eq 1 ]]; then
  login_status="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:${wm_http_port}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@windmill.dev","password":"changeme"}' 2>/dev/null || echo "000")"
  if [[ "${login_status}" == "200" ]]; then
    report "初期パスワード" ng "admin@windmill.dev / changemeでログインできてしまいます。至急変更してください"
  else
    report "初期パスワード" ok "初期パスワードではログインできません"
  fi
else
  report "初期パスワード" ok "Windmill未起動のためスキップしました"
fi

echo
if [[ "${NG_COUNT}" -eq 0 ]]; then
  echo "=== 全項目OK ==="
  exit 0
else
  echo "=== NGが${NG_COUNT}件あります ==="
  exit 1
fi
