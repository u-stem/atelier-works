#!/usr/bin/env bash
# 検査コマンドの境界を、workerのイメージの中で実際に確かめる。
# 使い捨てのコンテナを`infra/docker-compose.yml`のworkerと同じ制限
# (`init`、`no-new-privileges`、落とすケーパビリティ)で起動し、
# `tests/lib/check_sandbox_integration.test.ts`を走らせる。
# テストは本物のsetpriv・flock・chown・/procを使い、検査用のuidで動くコマンドが
# workerの秘密に届かないこと、書き込める場所が限られること、
# 検査の後にworktreeの所有権がrootに戻り、残ったプロセスが無いことを確かめる。
#
# テストは`/tmp/windmill`の権限を書き換えるので、使い捨てのコンテナの中でだけ走らせる。
# 動いているworkerには触れない。
#
# 第1引数はworkerのイメージの名前。既定は`mise run up`が作るイメージ。
# イメージが無いときは`mise run build`で作る。
# `mise run test:check-sandbox`から呼ぶ。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"
IMAGE="${1:-infra-windmill_worker}"

# `infra/docker-compose.yml`のworkerの`cap_drop`と同じ一覧。
# 食い違わないことは`tests/infra/docker_compose.test.ts`が確かめる。
CAP_DROP=(NET_RAW MKNOD SETFCAP AUDIT_WRITE)

log() { printf '[verify-check-sandbox] %s\n' "$*" >&2; }
die() {
  printf '[verify-check-sandbox] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker not found"
docker image inspect "${IMAGE}" >/dev/null 2>&1 ||
  die "image not found: ${IMAGE} (build it with: mise run build)"

args=(run --rm --init --security-opt no-new-privileges:true)
for cap in "${CAP_DROP[@]}"; do
  args+=(--cap-drop "${cap}")
done
args+=(
  -e FACTORY_CHECK_SANDBOX_IT=1
  --entrypoint bun
  -v "${REPO_ROOT}:/src:ro"
  -w /src
  "${IMAGE}"
  test tests/lib/check_sandbox_integration.test.ts
)

log "running the check sandbox tests in ${IMAGE}"
exec docker "${args[@]}"
