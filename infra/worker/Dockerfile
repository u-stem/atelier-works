# syntax=docker/dockerfile:1
#
# Custom Windmill worker image: adds the tools an agentic factory job needs
# (claude, gh, gitleaks, gtr, wmill) on top of the upstream windmill worker image.
# No secret is baked into this image; credentials are injected at runtime
# as Windmill secret variables (never baked into the image).

# Defaults mirror the [env] block in mise.toml; docker-compose.yml always
# overrides them via explicit build args. The default merely keeps a bare
# `docker build` (without --build-arg) from resolving FROM to an
# empty/invalid image name.
ARG WM_VERSION=1.817.0
FROM ghcr.io/windmill-labs/windmill:${WM_VERSION}

ARG CLAUDE_VERSION
ARG GH_VERSION
ARG GITLEAKS_VERSION
ARG GTR_REF
# Commit that GTR_REF (v2.11.1) resolves to, pinned separately so a clone of
# a moved/re-tagged ref is caught instead of silently trusted.
ARG GTR_COMMIT=f4df6344a362303e6b47bc92955fef3bba468426
ARG WMILL_VERSION

# The base image already ships bun, node, npm, git, curl and jq. Only add the
# packages that are actually missing for what follows.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
    && rm -rf /var/lib/apt/lists/*

# gh CLI: install from the official release tarball (architecture-aware),
# verified against the release's own checksums.txt so a corrupted or
# tampered download fails the build instead of being installed silently.
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

# gitleaks: the implement flow's fixed secret scan (run with --redact on
# every verify round, independent of the target repo's own check commands).
# Same release-tarball + checksums.txt verification as gh above. The version
# is the one mise.toml's [tools] pins for the host-side pre-commit hook, so
# host and worker scan with the same release.
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

# gtr (git-worktree-runner): git-gtr resolves its own symlink target to find
# /opt/gtr/lib/*.sh, so the launcher must stay a symlink. Copying the file
# instead of symlinking it breaks it at runtime. GTR_COMMIT pins the exact
# commit GTR_REF must resolve to, so a moved tag is caught rather than
# silently trusted.
RUN set -eux; \
    git clone --depth 1 --branch "${GTR_REF}" https://github.com/coderabbitai/git-worktree-runner /opt/gtr; \
    actual_commit="$(git -C /opt/gtr rev-parse HEAD)"; \
    if [ "${actual_commit}" != "${GTR_COMMIT}" ]; then \
        echo "gtr commit mismatch: expected ${GTR_COMMIT}, got ${actual_commit}" >&2; \
        exit 1; \
    fi; \
    ln -s /opt/gtr/bin/git-gtr /usr/local/bin/git-gtr

# Windmill CLI, pinned explicitly (the base image already ships a matching
# `wmill` via bun; --force lets this npm install take precedence so
# WMILL_VERSION stays the single source of truth even if it ever diverges
# from WM_VERSION).
RUN npm install -g --force "windmill-cli@${WMILL_VERSION}"

# Claude Code CLI, installed to /root/.local/bin.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/var/lib/factory/claude \
    GH_CONFIG_DIR=/var/lib/factory/gh \
    GIT_TERMINAL_PROMPT=0
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}"
ENV PATH="/root/.local/bin:${PATH}"

# Build-time verification: fail the build immediately if any tool is missing
# or broken, instead of discovering it at job run time.
RUN claude --version && gh --version && gitleaks version && git gtr version && wmill --version && bun --version

CMD ["windmill"]
