#!/usr/bin/env bash
# ホストのcheckoutで反映が済んだ印を、workerの共有ボリュームに書く。
#
# `mise run up`と`mise run deploy`が、スタックの起動の後に呼ぶ。
# 書くのはホストのcheckoutのHEADで、自己更新(`f/factory/self_update`)が読む。
# ホスト側の作業が要る反映の通知(`host_action_required`)のうち、このHEADに含まれる版のものを、
# 自己更新が自動で解決するための印である。
#
# 印を書けなくても、起動は成功しているので終了コード0で終わる。
# そのときは警告を出す。通知は自動では解決されないので、人がConsoleで解決する。
# `-e`は付けない。書けなくても起動は済んでいるので、各失敗を警告にして終了コード0で終える。
set -uo pipefail

# 自己更新が読むパス(`HOST_APPLIED_SHA_PATH`、`f/factory/lib/host_action.ts`)と同じ値にする。
MARKER_PATH="/var/lib/factory/host_applied_sha"

if ! sha="$(git rev-parse HEAD 2>/dev/null)" || [[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "warning: could not read the checkout HEAD; the host action notice will not resolve by itself" >&2
  exit 0
fi

# shaは40桁の16進だけを確かめて渡すので、シェルに解釈される文字を含まない。
# コンテナの中で、同じディレクトリにランダムな名前の一時ファイルを作って(`mktemp`は排他的に作る)書き、
# `mv -fT`で置き換える。読む側が書きかけの値を読まず、印のパスがsymlinkでも、その先ではなく
# symlink自体を置き換える。`-T`は、印のパスがディレクトリ(を指すsymlink)でも、中へ移さず失敗させる。
# 書けなかったときは一時ファイルを消す。ジョブが先回りして置いたFIFOなどで止まらないよう、`timeout`で包む。
if ! docker compose -f infra/docker-compose.yml exec -T windmill_worker \
  timeout 10 sh -c 'tmp=$(mktemp "$2.tmp.XXXXXXXX") || exit 1; if printf "%s\n" "$1" > "$tmp" && mv -fT "$tmp" "$2"; then exit 0; fi; rm -f "$tmp"; exit 1' sh "${sha}" "${MARKER_PATH}"; then
  echo "warning: could not record ${sha} for the worker; the host action notice will not resolve by itself" >&2
  exit 0
fi

echo "recorded ${sha} as the version applied on this host"
