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

docker run -d --rm --name "${name}" -e BASE_URL=:80 \
  -p "127.0.0.1:${port}:80" \
  -v "${root}/infra/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "${image}" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
trap 'docker stop "${name}" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${port}/ws/ready"; then
    break
  fi
  sleep 1
done

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
expect 403 "Origin: スキームだけ違う" -H "Origin: https://localhost:${port}" "${localhost}/api/version"
expect 403 "Origin: 別のホスト名(同じポート)" -H "Origin: ${localhost}" "${loopback}/api/version"
expect 403 "Origin: 末尾に/を付けたもの" -H "Origin: ${localhost}/" "${localhost}/api/version"

# 通す。
expect 502 "Originなし(CLI)" "${localhost}/api/version"
expect 502 "Sec-Fetch-Site: same-origin" -H 'Sec-Fetch-Site: same-origin' "${localhost}/api/version"
expect 502 "Origin: localhost(一致)" -H "Origin: ${localhost}" "${localhost}/api/version"
expect 502 "Origin: 127.0.0.1(一致)" -H "Origin: ${loopback}" "${loopback}/api/version"

# 規則は/api/*だけに効く。
expect 502 "/api/*以外ではOriginを見ない" -H 'Origin: http://evil.example' "${localhost}/ws/ready"

if [[ "${failures}" -gt 0 ]]; then
  printf '%s件が期待と違う\n' "${failures}" >&2
  exit 1
fi
