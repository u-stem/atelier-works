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
# 検査コマンドを動かす非特権ユーザーの先頭のuidと、その数。`mise.toml`の`[env]`と
# 同じ値を`docker-compose.yml`が渡す。既定値は、`--build-arg`無しの`docker build`でも
# 検査用のuidが決まるようにするためだけにある。
# 数は、workerの同時実行数(1)に、片付けられず飛ばす枠の分を足した数以上にする。
ARG FACTORY_CHECK_UID=10001
ARG FACTORY_CHECK_POOL_SIZE=8
ARG GH_VERSION
ARG GITLEAKS_VERSION
ARG GTR_REF
# `GTR_REF`(v2.11.1)が指すコミット。別に固定し、refが動いた・タグが
# 付け直された場合に、黙って信用せず検出する。
ARG GTR_COMMIT=f4df6344a362303e6b47bc92955fef3bba468426
ARG WMILL_VERSION

# ベースのイメージにはbun・node・npm・git・curl・jqが入っている。
# 以降の手順で実際に足りないパッケージだけを足す。
# 検査コマンドの後始末は、`util-linux`の`setpriv`と`flock`、`procps`の`kill`、
# `acl`の`getfacl`と`setfacl`を絶対パスで呼ぶ。`acl`は、検査用のユーザーが
# worktreeに付けたACLを、所有権を取り戻すときに消すために使う。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        acl \
        ca-certificates \
        curl \
        git \
        jq \
        procps \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# 検査コマンドを実行するための非特権ユーザー`factory-check-0`、`factory-check-1`、…。
# 並行して動く検査が同じuidを共有しないよう、実行ごとに空いている1つを使う。
# uidを固定するのは、worktreeの所有者や`setpriv`の引数がuidで決まり、再ビルドで
# 変わってはいけないため。ホームもログインシェルも持たせない。
# `setpriv`(util-linux)で切り替える。Windmillのジョブには、workerの環境変数が
# ほとんど渡らない。workerのscriptはこのユーザーのuidを`/etc/passwd`から読む。
RUN set -eux; \
    for i in $(seq 0 $((FACTORY_CHECK_POOL_SIZE - 1))); do \
        useradd -u "$((FACTORY_CHECK_UID + i))" -M -s /usr/sbin/nologin "factory-check-${i}"; \
    done

# ベースのイメージは、Windmillの実行ファイルと共有ライブラリを置く`/usr/src/app`と、
# `/tmp/.cache`を、誰でも書き込めてstickyでない(0777)ようにしている。
# 開いたままだと、検査用のユーザーがrootの実行するファイルを差し替えられるので、
# 中のファイルも含めて、グループとその他が書き込めないようにする。
# workerはrootで動くので、書き込みに困らない。
RUN chmod -R go-w /usr/src/app /tmp/.cache

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
# `CLAUDE_VERSION`はbuild argのままだと実行時に消える。`agent_runs.claude_version`の
# 記録元として、workerの環境変数にも残す。値はインストールした版と同じになる。
# Windmillのジョブには、`docker-compose.yml`の`WHITELIST_ENVS`に挙げた変数だけが届く。
ENV CLAUDE_VERSION=${CLAUDE_VERSION} \
    DISABLE_AUTOUPDATER=1 \
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
# `claude`はPATHの名前で解決して確かめる。`claude --version`の先頭の語(例: `2.1.282 (Claude Code)`の
# `2.1.282`)が`CLAUDE_VERSION`と違うか、
# `CLAUDE_VERSION`が空なら、記録する版と実際の版がずれるので、両方の値を標準エラーに出してビルドを失敗させる。
# `setpriv`は、検査の実行と同じ引数で、すべての枠について、切り替えた先のuidと、
# ケーパビリティの上限が空であること、`no_new_privs`が立つことを確かめる。
# 検査の後始末が絶対パスで呼ぶ`kill`、`getfacl`、`setfacl`があることも確かめる。
# 誰でも書き込めるもの(symlinkを除く、ファイルを含む)が、検査の後始末が片付ける共有の一時ディレクトリ
# (`f/factory/lib/check_sandbox.ts`の`SHARED_TMP_DIRS`)そのものだけであることも確かめる。
# `/tmp/windmill`は、検査の前に所有者だけが入れるように閉じるので除く。
RUN { [ -n "${CLAUDE_VERSION}" ] && [ "$(claude --version | cut -d' ' -f1)" = "${CLAUDE_VERSION}" ] \
        || { echo "claude --version reports '$(claude --version)', expected '${CLAUDE_VERSION}'" >&2; exit 1; }; } \
    && gh --version && gitleaks version && git gtr version && wmill --version && bun --version \
    && test -x /usr/bin/kill && test -x /usr/bin/getfacl && test -x /usr/bin/setfacl \
    && test -z "$(find / -xdev -path /tmp/windmill -prune -o ! -type l -perm -0002 -print | grep -vxE '/tmp|/var/tmp|/dev/shm|/dev/mqueue|/run/lock')" \
    && for i in $(seq 0 $((FACTORY_CHECK_POOL_SIZE - 1))); do \
        uid="$((FACTORY_CHECK_UID + i))"; \
        [ "$(setpriv --reuid="${uid}" --regid="${uid}" --groups=1000000 --bounding-set=-all --inh-caps=-all --no-new-privs -- id -u)" = "${uid}" ] \
        && setpriv --reuid="${uid}" --regid="${uid}" --groups=1000000 --bounding-set=-all --inh-caps=-all --no-new-privs -- grep -Eq '^CapBnd:[[:space:]]*0+$' /proc/self/status \
        && setpriv --reuid="${uid}" --regid="${uid}" --groups=1000000 --bounding-set=-all --inh-caps=-all --no-new-privs -- grep -Eq '^NoNewPrivs:[[:space:]]*1$' /proc/self/status \
        || exit 1; \
    done

CMD ["windmill"]
