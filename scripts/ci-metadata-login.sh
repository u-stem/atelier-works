#!/usr/bin/env bash
# CIの`metadata`ジョブ専用。使い捨てのWindmillサーバーに、空のワークスペース
# `factory`を作り、`wmill`のワークスペースのプロファイルを登録する。
# `mise run metadata:check`(`wmill generate-metadata --dry-run`)が、これだけで動く。
# ドライランはリモートの状態に依存しないので、ワークスペースは空でよい。
#
# 新しいWindmillの既定の管理者(公開されている既定のメールとパスワード)で
# ログインする。この資格情報は誰でも知っているので、実際のインスタンスには
# 決して使わない。そのため、CIの実行(`CI=true`)でなければ実行を拒み、
# 接続先も手元のループバックに限る。
# トークンは、サーバーごとCIの終了とともに捨てる使い捨てのもの。表示はしないが、
# `wmill workspace add --token`は他にトークンを渡す方法が無く、引数で渡す
# (`scripts/bootstrap.sh`の冒頭を参照)。
#
# `mise exec -- scripts/ci-metadata-login.sh`として動かす前提。
# `WM_BASE_URL`、`WMILL_CONFIG_DIR`とwmillのPATHはmiseから来る。
set -euo pipefail

log() { printf '[ci-metadata-login] %s\n' "$*" >&2; }
die() {
  printf '[ci-metadata-login] ERROR: %s\n' "$*" >&2
  exit 1
}

[ "${CI:-}" = "true" ] || die "refusing to run outside CI (CI=true): this script logs in with Windmill's public default credentials"

command -v curl >/dev/null 2>&1 || die "required command not found: curl"
command -v wmill >/dev/null 2>&1 || die "required command not found: wmill (run via 'mise exec -- scripts/ci-metadata-login.sh')"
: "${WM_BASE_URL:?run via 'mise exec --' (mise.toml [env] sets this)}"

# globだと`http://127.0.0.1:80@evil.example/`のようなURLが通るので、正規表現で厳密に判定する。
if ! [[ "${WM_BASE_URL}" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/?$ ]]; then
  die "refusing to use the default credentials against a non-loopback URL: ${WM_BASE_URL}"
fi

WORKSPACE="factory"
API="${WM_BASE_URL%/}/api"

token="$(curl -fsS --max-time 30 -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' \
  --data-binary '{"email":"admin@windmill.dev","password":"changeme"}')" \
  || die "failed to log in to ${WM_BASE_URL}"
[ -n "${token}" ] || die "login returned an empty token"
# 万一ログに出ても伏せられるよう、GitHub Actionsにトークンを秘密として登録する。
echo "::add-mask::${token}"
log "logged in with the default admin"

curl -fsS --max-time 30 -o /dev/null -X POST "${API}/workspaces/create" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${token}" \
  --data-binary "{\"id\":\"${WORKSPACE}\",\"name\":\"${WORKSPACE}\"}" \
  || die "failed to create workspace '${WORKSPACE}'"
log "workspace '${WORKSPACE}' created"

wmill workspace add "${WORKSPACE}" "${WORKSPACE}" "${WM_BASE_URL}" --token "${token}" >&2
log "wmill workspace profile '${WORKSPACE}' registered"
