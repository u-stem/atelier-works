# syntax=docker/dockerfile:1
#
# 独自のWindmill workerのイメージ。上流のworkerのイメージに、Factoryの
# ジョブが使う道具(claude・gh・gitleaks・gtr・wmill)を足す。
# 秘密はイメージに焼き込まず、実行時にWindmillの秘密の変数として渡す。

# 既定値は`mise.toml`の`[env]`と同じで、`docker-compose.yml`は常にビルド引数で
# 上書きする。既定値は、`--build-arg`無しの`docker build`で`FROM`が
# 空や不正なイメージ名にならないようにするためだけにある。
ARG WM_VERSION=1.817.0
FROM ghcr.io/windmill-labs/windmill:${WM_VERSION}

ARG CLAUDE_VERSION
ARG GH_VERSION
ARG GITLEAKS_VERSION
ARG GTR_REF
# `GTR_REF`(v2.11.1)が指すコミット。別に固定し、refが動いた・タグが
# 付け直された場合に、黙って信用せず検出する。
ARG GTR_COMMIT=f4df6344a362303e6b47bc92955fef3bba468426
ARG WMILL_VERSION

# ベースのイメージにはbun・node・npm・git・curl・jqが入っている。
# 以降の手順で実際に足りないパッケージだけを足す。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        procps \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# 検査コマンドを実行するための非特権ユーザー。uidを固定するのは、ボリュームの
# 所有者や`setpriv`の引数がuidで決まり、再ビルドで変わってはいけないため。
# ホームもログインシェルも持たせない。`setpriv`(util-linux)で切り替え、
# 残った子プロセスは`pkill`(procps)で止める。
RUN useradd -u 10001 -M -s /usr/sbin/nologin factory-check

# gh CLI: 公式のリリースのtarball(アーキテクチャ別)から入れ、リリースの
# `checksums.txt`で検証する。壊れた・改ざんされたダウンロードを黙って入れず、
# ビルドを失敗させるため。
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
        amd64) gh_arch=amd64 ;; \
        arm64) gh_arch=arm64 ;; \
        *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    tarball="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
    curl -fsSL -O "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${tarball}"; \
    curl -fsSL -O "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt"; \
    sha256sum -c --ignore-missing "gh_${GH_VERSION}_checksums.txt"; \
    tar -xzf "${tarball}"; \
    install -m 0755 "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf "${tarball}" "gh_${GH_VERSION}_checksums.txt" "gh_${GH_VERSION}_linux_${gh_arch}"

# gitleaks: implementフローが必ず行う秘密の走査に使う(対象リポジトリの
# 検査コマンドとは別に、検証のラウンドごとに`--redact`付きで実行する)。
# 上のghと同じく、リリースのtarballと`checksums.txt`で検証する。版は
# `mise.toml`の`[tools]`がホストのpre-commitフック用に固定しているものと同じで、
# ホストとworkerが同じリリースで走査する。
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
        amd64) gitleaks_arch=x64 ;; \
        arm64) gitleaks_arch=arm64 ;; \
        *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    tarball="gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz"; \
    curl -fsSL -O "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"; \
    curl -fsSL -O "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    sha256sum -c --ignore-missing "gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    tar -xzf "${tarball}" gitleaks; \
    install -m 0755 gitleaks /usr/local/bin/gitleaks; \
    rm -rf "${tarball}" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" gitleaks

# gtr(git-worktree-runner): `git-gtr`は自分のsymlinkの先をたどって
# `/opt/gtr/lib/*.sh`を探すので、起動用のファイルはsymlinkのままにする。
# コピーすると実行時に壊れる。`GTR_COMMIT`は`GTR_REF`が指すべきコミットを
# 固定し、タグが動いた場合に黙って信用せず検出する。
RUN set -eux; \
    git clone --depth 1 --branch "${GTR_REF}" https://github.com/coderabbitai/git-worktree-runner /opt/gtr; \
    actual_commit="$(git -C /opt/gtr rev-parse HEAD)"; \
    if [ "${actual_commit}" != "${GTR_COMMIT}" ]; then \
        echo "gtr commit mismatch: expected ${GTR_COMMIT}, got ${actual_commit}" >&2; \
        exit 1; \
    fi; \
    ln -s /opt/gtr/bin/git-gtr /usr/local/bin/git-gtr

# Windmill CLIの版を明示的に固定する。ベースのイメージにもbun経由で同じ版の
# `wmill`があるが、`--force`でこのnpm installを優先させ、`WM_VERSION`と
# 食い違っても`WMILL_VERSION`だけを正とする。
RUN npm install -g --force "windmill-cli@${WMILL_VERSION}"

# Claude Code CLI。インストーラーは`/root/.local/bin`に置くので、名前で起動
# できるよう`/usr/local/bin`にsymlinkを張る。
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/var/lib/factory/claude \
    GH_CONFIG_DIR=/var/lib/factory/gh \
    GIT_TERMINAL_PROMPT=0
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}" \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

# workerのPATHから、rootのホームと、誰でも書き込める`/tmp`の下を外す。
# ベースのイメージのPATHは`/root/.local/bin`と`/tmp/.local/bin`を含むので、
# 継承せず明示的に書く。`/tmp/.local/bin`は、workerの`windmill`の実行ファイルに
# 参照が無く、稼働中のコンテナにも存在しない。非特権のuidが同名の実行ファイルを
# 置いて、rootの名前解決を奪えるので、残さない。
# 値はベースのイメージのPATHから、この2つを除いたものである。
# `WM_VERSION`を上げるときは、新しいベースの`docker image inspect`でPATHを確かめ、
# 必要なディレクトリが増えていないか突き合わせる。
ENV PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin"

# ビルド時の検証。道具が欠けている・壊れているとき、ジョブの実行時に
# 気づくのではなく、その場でビルドを失敗させる。
# `claude`はPATHの名前で解決して確かめる。
# `setpriv`は、切り替えた先のuidを出力と比べて確かめる。
RUN claude --version && gh --version && gitleaks version && git gtr version && wmill --version && bun --version \
    && [ "$(setpriv --reuid=10001 --regid=10001 --clear-groups -- id -u)" = 10001 ]

CMD ["windmill"]
