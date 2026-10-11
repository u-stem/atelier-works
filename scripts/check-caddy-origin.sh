#!/usr/bin/env bash
# CaddyがAPIの他のサイトからの要求を止めることを、実際にCaddyを起動して確かめる。
# composeと同じイメージで`infra/Caddyfile`を動かし、`curl`の応答の状態を比べる。
# 転送先のWindmillは起動しないので、止められなかった要求は502になる。
# 全部期待どおりなら終了コード0、1つでも違えば1で終わる。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="$(grep -oE 'ghcr\.io/windmill-labs/caddy-l4:[^[:space:]]+' "${root}/infra/docker-compose.yml")"
name="caddy-origin-check-$$"
port="${CHECK_PORT:-18080}"

docker run -d --name "${name}" -e BASE_URL=:80 \
  -p "127.0.0.1:${port}:80" \
  -v "${root}/infra/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "${image}" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
trap 'docker rm -f "${name}" >/dev/null 2>&1 || true' EXIT

ready=false
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${port}/ws/ready"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  echo "Caddyが${port}番で応答しない。コンテナのログを示す。" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi

failures=0

# expect <期待する状態> <説明> <curlの引数...>
expect() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [[ "${got}" == "${want}" ]]; then
    printf 'ok    %s -> %s\n' "${label}" "${got}"
  else
    printf 'FAIL  %s -> %s (期待: %s)\n' "${label}" "${got}" "${want}"
    failures=$((failures + 1))
  fi
}

localhost="http://localhost:${port}"
loopback="http://127.0.0.1:${port}"

# 止める。
expect 403 "Sec-Fetch-Site: cross-site" -H 'Sec-Fetch-Site: cross-site' "${localhost}/api/version"
expect 403 "Sec-Fetch-Site: same-site" -H 'Sec-Fetch-Site: same-site' "${localhost}/api/version"
expect 403 "Origin: 別のサイト" -H 'Origin: http://evil.example' "${localhost}/api/version"
expect 403 "Origin: 別のサイト(POST)" -X POST -H 'Origin: http://evil.example' "${localhost}/api/version"
expect 403 "Origin: null" -H 'Origin: null' "${localhost}/api/version"
expect 403 "Origin: 別のポートのlocalhost" -H 'Origin: http://localhost:1' "${localhost}/api/version"
expect 403 "Origin: 別のホスト名(同じポート)" -H "Origin: ${localhost}" "${loopback}/api/version"
expect 403 "Origin: 末尾に/を付けたもの" -H "Origin: ${localhost}/" "${localhost}/api/version"

# 通す。
expect 502 "Originなし(CLI)" "${localhost}/api/version"
expect 502 "Sec-Fetch-Site: same-origin" -H 'Sec-Fetch-Site: same-origin' "${localhost}/api/version"
expect 502 "Origin: localhost(一致)" -H "Origin: ${localhost}" "${localhost}/api/version"
expect 502 "Origin: スキームだけ違う(https)" -H "Origin: https://localhost:${port}" "${localhost}/api/version"
expect 502 "Origin: 127.0.0.1(一致)" -H "Origin: ${loopback}" "${loopback}/api/version"

# GETで副作用のあるAPIは、fetch(Sec-Fetch-Dest: empty)からだけ通す。
run="${localhost}/api/w/factory/jobs/run_wait_result/p/f/factory/steps/x"
expect 403 "GET + Sec-Fetch-Dest: image" -H 'Sec-Fetch-Dest: image' -H 'Sec-Fetch-Site: same-origin' "${run}"
expect 403 "GET + Sec-Fetch-Dest: document" -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Site: same-origin' "${run}"
expect 403 "GET + Sec-Fetch-Dest: iframe" -H 'Sec-Fetch-Dest: iframe' -H 'Sec-Fetch-Site: same-origin' "${run}"
expect 403 "HEAD + Sec-Fetch-Dest: image" -I -H 'Sec-Fetch-Dest: image' "${run}"
expect 403 "GET Dest無し + Cookie(古いブラウザ)" -H 'Cookie: token=x' "${run}"
expect 403 "run_and_stream + Sec-Fetch-Dest: image" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/run_and_stream/p/f/factory/steps/x"
expect 403 "slack_approval + Sec-Fetch-Dest: image" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/slack_approval/1"
expect 403 "teams_approval + Sec-Fetch-Dest: image" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/teams_approval/1"
expect 403 "move_s3_file + Sec-Fetch-Dest: image" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/job_helpers/move_s3_file?x=1"
expect 502 "GET + Sec-Fetch-Dest: empty(fetch)" -H 'Sec-Fetch-Dest: empty' -H 'Sec-Fetch-Site: same-origin' "${run}"
expect 502 "GET Dest無し + Cookie無し(CLI)" "${run}"
expect 502 "POST + Origin一致 + Sec-Fetch-Dest: empty" -X POST -H "Origin: ${localhost}" -H 'Sec-Fetch-Dest: empty' -H 'Sec-Fetch-Site: same-origin' "${run}"
expect 502 "読み取り系のGET + Sec-Fetch-Dest: image" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs_u/get/1"
expect 502 "署名付きの承認リンク + Sec-Fetch-Dest: document" -H 'Sec-Fetch-Dest: document' "${localhost}/api/w/factory/jobs_u/resume/1/0/sig"

# 規則は/api/*だけに効く。
expect 502 "/api/*以外ではOriginを見ない" -H 'Origin: http://evil.example' "${localhost}/ws/ready"

if [[ "${failures}" -gt 0 ]]; then
  printf '%s件が期待と違う\n' "${failures}" >&2
  exit 1
fi
