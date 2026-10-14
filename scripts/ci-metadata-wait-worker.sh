#!/usr/bin/env bash
# CIの`metadata`ジョブ専用。使い捨てのWindmillに、依存の解決のジョブ(tag `dependency`)を
# 動かせるworkerが登録されるまで待つ。
# 上流のworkerのイメージにはHEALTHCHECKが無く、`docker compose up --wait`は
# コンテナが動き始めたことしか待たない。ジョブを投げる前に、workerの登録を確かめる。
#
# workerの一覧のAPIは認証が要るので、`scripts/ci-metadata-login.sh`と同じく、
# 新しいWindmillの公開されている既定の管理者でログインする。
# この資格情報は誰でも知っているので、CIの実行(`CI=true`)でなければ実行を拒み、
# 接続先も手元のループバックに限る。トークンは表示しない。
#
# `mise exec -- scripts/ci-metadata-wait-worker.sh`として動かす前提。`WM_BASE_URL`はmiseから来る。
# 待つ回数と間隔は、テストで短くするために環境変数で変えられる。
set -euo pipefail

log() { printf '[ci-metadata-wait-worker] %s\n' "$*" >&2; }
die() {
  printf '[ci-metadata-wait-worker] ERROR: %s\n' "$*" >&2
  exit 1
}

[ "${CI:-}" = "true" ] || die "refusing to run outside CI (CI=true): this script logs in with Windmill's public default credentials"

command -v curl >/dev/null 2>&1 || die "required command not found: curl"
: "${WM_BASE_URL:?run via 'mise exec --' (mise.toml [env] sets this)}"

# globだと`http://127.0.0.1:80@evil.example/`のようなURLが通るので、正規表現で厳密に判定する。
if ! [[ "${WM_BASE_URL}" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/?$ ]]; then
  die "refusing to use the default credentials against a non-loopback URL: ${WM_BASE_URL}"
fi

attempts="${METADATA_WORKER_WAIT_ATTEMPTS:-60}"
interval="${METADATA_WORKER_WAIT_INTERVAL:-2}"
[[ "${attempts}" =~ ^[0-9]+$ ]] || die "METADATA_WORKER_WAIT_ATTEMPTS must be a number"
[[ "${interval}" =~ ^[0-9]+$ ]] || die "METADATA_WORKER_WAIT_INTERVAL must be a number"

API="${WM_BASE_URL%/}/api"

token="$(curl -fsS --max-time 30 -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' \
  --data-binary '{"email":"admin@windmill.dev","password":"changeme"}')" \
  || die "failed to log in to ${WM_BASE_URL}"
[ -n "${token}" ] || die "login returned an empty token"
echo "::add-mask::${token}"

for ((i = 1; i <= attempts; i++)); do
  # 一覧が取れない間(起動の途中)は、失敗を無視して次の回に進む。
  workers="$(curl -fsS --max-time 10 -H "Authorization: Bearer ${token}" "${API}/workers/list" 2>/dev/null || true)"
  # 各workerの`custom_tags`に`dependency`が含まれていれば、依存の解決のジョブを動かせる。
  if grep -Eq '"custom_tags":\[[^]]*"dependency"' <<<"${workers}"; then
    log "a worker for dependency jobs is registered"
    exit 0
  fi
  sleep "${interval}"
done

die "no worker registered for dependency jobs after ${attempts} attempts"
