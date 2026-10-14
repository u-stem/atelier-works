#!/usr/bin/env bash
# CaddyがAPIの他のサイトからの要求を止めることと、旧ConsoleのURLを新しいConsoleに飛ばすことを、
# 実際にCaddyを起動して確かめる。
# composeと同じイメージで`infra/Caddyfile`を動かし、`curl`の応答の状態とLocationを比べる。
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

# expect_redirect <期待する状態> <期待するLocation> <説明> <curlの引数...>
# Locationは、行き先が固定であることを確かめるため、応答のヘッダーの値を完全に一致させる。
expect_redirect() {
  local want_status="$1" want_location="$2" label="$3"
  shift 3
  local headers got_status got_location
  headers="$(curl -s -o /dev/null -D - "$@" | tr -d '\r')"
  got_status="$(printf '%s\n' "${headers}" | awk 'NR == 1 { print $2 }')"
  got_location="$(printf '%s\n' "${headers}" | awk -F': ' 'tolower($1) == "location" { print $2 }')"
  if [[ "${got_status}" == "${want_status}" && "${got_location}" == "${want_location}" ]]; then
    printf 'ok    %s -> %s %s\n' "${label}" "${got_status}" "${got_location}"
  else
    printf 'FAIL  %s -> %s %s (期待: %s %s)\n' "${label}" "${got_status}" "${got_location}" "${want_status}" "${want_location}"
    failures=$((failures + 1))
  fi
}

# expect_no_store <説明> <curlの引数...>
# 転送の応答に`Cache-Control: no-store`が付くことを確かめる。付かないと、ブラウザが転送を覚える。
expect_no_store() {
  local label="$1"
  shift
  local got
  got="$(curl -s -o /dev/null -D - "$@" | tr -d '\r' | awk -F': ' 'tolower($1) == "cache-control" { print $2 }')"
  if [[ "${got}" == "no-store" ]]; then
    printf 'ok    %s -> %s\n' "${label}" "${got}"
  else
    printf 'FAIL  %s -> %s (期待: no-store)\n' "${label}" "${got}"
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

# GETの副作用のあるAPIは、表記を変えても止める。
expect 403 "大文字のRUN_WAIT_RESULT" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/RUN_WAIT_RESULT/p/f/factory/steps/x"
expect 403 "jobs//run_wait_result" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs//run_wait_result/p/f/factory/steps/x"
expect 403 "//api//w/..." -H 'Sec-Fetch-Dest: image' "${localhost}//api//w/factory/jobs/run_wait_result/p/f/factory/steps/x"
expect 403 "%72un_wait_result" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/%72un_wait_result/p/f/factory/steps/x"
expect 403 "作業スペースの部分に%2fを入れたもの" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/a%2fb/jobs/run_wait_result/p/f/factory/steps/x"
expect 403 "run_wait_result/fv/<version>" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/run_wait_result/fv/1"
expect 403 "run_and_stream/f/<path>" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/run_and_stream/f/factory/steps/x"
expect 403 "run_and_stream/h/<hash>" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/jobs/run_and_stream/h/abc"
expect 403 "move_s3_file(末尾に/)" -H 'Sec-Fetch-Dest: image' "${localhost}/api/w/factory/job_helpers/move_s3_file/"
expect 403 "GET + Sec-Fetch-Dest: empty + Sec-Fetch-Mode: navigate(<a download>)" -H 'Sec-Fetch-Dest: empty' -H 'Sec-Fetch-Mode: navigate' "${run}"
expect 502 "GET + Sec-Fetch-Dest: empty + Cookie(fetch)" -H 'Sec-Fetch-Dest: empty' -H 'Cookie: token=x' "${run}"

# ページの移動で送られる書き込み(注入された<form method=post>)は止める。fetchの書き込みは通す。
approve="${localhost}/api/w/factory/jobs/run/p/f/factory/approval_decide"
expect 403 "フォームのPOST(Sec-Fetch-Mode: navigate)" -X POST -H "Origin: ${localhost}" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1' "${approve}"
expect 403 "フォームのPOST(iframeの中)" -X POST -H "Origin: ${localhost}" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: iframe' -d 'a=1' "${approve}"
expect 502 "JSONのfetchのPOST(Sec-Fetch-Mode: cors)" -X POST -H "Origin: ${localhost}" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Dest: empty' -H 'Content-Type: application/json' -d '{}' "${approve}"
expect 502 "ナビゲーションで開く読み取りのGET" -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' "${localhost}/api/version"
expect 502 "Sec-Fetch-Modeが無いPOST(古いブラウザやCLI)" -X POST -H "Origin: ${localhost}" -d '{}' "${approve}"

# 規則は/api/*だけに効く。
expect 502 "/api/*以外ではOriginを見ない" -H 'Origin: http://evil.example' "${localhost}/ws/ready"

# 旧Console(raw app)のURLは、パスの配下とクエリがあっても、固定の/console/へ一時的に飛ばす。
# #requirements/<id>のフラグメントはブラウザが保つので、curlでは確かめない。
console="/console/"
expect_redirect 302 "${console}" "旧Console(apps)" "${localhost}/apps/get/f/factory/factory_console"
expect_redirect 302 "${console}" "旧Console(apps_raw)" "${localhost}/apps_raw/get/f/factory/factory_console"
expect_redirect 302 "${console}" "旧Consoleの配下" "${localhost}/apps/get/f/factory/factory_console/assets/a.js"
expect_redirect 302 "${console}" "旧Consoleの末尾の/" "${localhost}/apps/get/f/factory/factory_console/"
expect_redirect 302 "${console}" "旧Consoleの/の重なり" "${localhost}//apps//get//f/factory/factory_console"
expect_redirect 302 "${console}" "旧Consoleのクエリは行き先に写さない" "${localhost}/apps/get/f/factory/factory_console?next=http://evil.example/&x=1"
expect_redirect 302 "${console}" "旧Consoleの配下にURLらしいパス" "${localhost}/apps/get/f/factory/factory_console/http://evil.example/"
expect_redirect 302 "${console}" "旧Console(別のホスト名のHost)" -H 'Host: evil.example' "${localhost}/apps/get/f/factory/factory_console"
expect_no_store "旧Consoleの転送はキャッシュさせない" "${localhost}/apps/get/f/factory/factory_console"
expect 502 "名前が続く別のアプリは飛ばさない" "${localhost}/apps/get/f/factory/factory_console2"
expect 502 "旧Consoleの編集画面は飛ばさない" "${localhost}/apps/edit/f/factory/factory_console"
expect_redirect 308 "${console}?approval=9" "/consoleはクエリを保って入口へ" "${localhost}/console?approval=9"

if [[ "${failures}" -gt 0 ]]; then
  printf '%s件が期待と違う\n' "${failures}" >&2
  exit 1
fi
