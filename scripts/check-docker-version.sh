#!/usr/bin/env bash
# Dockerの版が、このリポジトリのcomposeの下限を満たすかを確かめる。
# 満たすなら版を1行出して終了コード0、満たさないなら理由を標準エラーに出して1で終わる。
#
# Console用のworkerは、`volume.subpath`で`factory_state`の一部だけをマウントする。
# Compose 2.26.0以上でEngineがAPI 1.45(Docker Engine 26.0)未満の組み合わせでは、
# Composeはエラーにせず、Engineが`subpath`を黙って無視する。
# 無視されると、サブパスではなく`factory_state`のボリューム全体がマウントされ、Claude Codeとghの設定まで届く。
# Compose 2.26.0未満が`subpath`を拒否するのか、黙って無視するのかは確かめていない。
# どちらであっても、ボリューム全体がマウントされる経路を残さないため、両方の下限を要求する。
# 起動の前に止めるため、スタックを起動するmiseのタスクと`doctor`がこれを呼ぶ。
# 対象はDocker Engineである。Podmanは検査も動作確認もしていない。
set -euo pipefail

MIN_ENGINE_API="1.45"
MIN_COMPOSE="2.26.0"

# 文字列の先頭にある、数字とドットだけの並び(`v`は読み飛ばす)を出す。
# `2.40.3-desktop.1`なら`2.40.3`。数字で始まらなければ失敗で終わる。
core_version() {
  if [[ "$1" =~ ^[[:space:]]*v?([0-9]+(\.[0-9]+)*) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

# 版`$1`が`$2`以上なら成功で終わる。
# 成分ごとに数として比べる。文字列で比べると`1.9`が`1.45`より新しくなる。
# 先頭の0は8進数とみなされないよう、`10#`を付けて10進数で読む。
version_ge() {
  local IFS=.
  local -a left right
  read -ra left <<<"$1"
  read -ra right <<<"$2"
  local count="${#left[@]}"
  if [[ "${#right[@]}" -gt "${count}" ]]; then
    count="${#right[@]}"
  fi
  local i l r
  for ((i = 0; i < count; i++)); do
    l=$((10#${left[i]:-0}))
    r=$((10#${right[i]:-0}))
    if ((l > r)); then
      return 0
    fi
    if ((l < r)); then
      return 1
    fi
  done
  return 0
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

problems=0

api_raw="$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null)" || api_raw=""
if api="$(core_version "${api_raw}")"; then
  if ! version_ge "${api}" "${MIN_ENGINE_API}"; then
    echo "Docker Engine API ${api} is older than ${MIN_ENGINE_API} (Docker Engine 26.0): volume.subpath may be ignored silently. Upgrade Docker Engine." >&2
    problems=$((problems + 1))
  fi
else
  echo "cannot read the Docker Engine API version (is the Docker daemon running?)" >&2
  problems=$((problems + 1))
  api="unknown"
fi

compose_raw="$(docker compose version --short 2>/dev/null)" || compose_raw=""
if compose="$(core_version "${compose_raw}")"; then
  if ! version_ge "${compose}" "${MIN_COMPOSE}"; then
    echo "Docker Compose ${compose} is older than ${MIN_COMPOSE}: this repository requires ${MIN_COMPOSE} or newer for volume.subpath (behavior of older versions is unverified). Upgrade Docker Compose." >&2
    problems=$((problems + 1))
  fi
else
  echo "cannot read the Docker Compose version (is the Compose v2 plugin installed?)" >&2
  problems=$((problems + 1))
  compose="unknown"
fi

if [[ "${problems}" -gt 0 ]]; then
  exit 1
fi

echo "Docker Engine API ${api}, Docker Compose ${compose}"
