# Consoleの成果物をGitHubから取り込み、共有ボリュームに置くコンテナ。
# 第三者のパッケージは入れない。bunの版はmise.tomlの[tools]と揃え、digestで固定する
# (tests/console_fetcher/dockerfile.test.tsが確かめる)。
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

WORKDIR /app
# コードはrootの所有のまま置き、実行するユーザー(bun)からは書き換えられないようにする。
COPY main.ts fetcher.ts decide.ts zip.ts ./

# 名前付きボリュームは、初めてマウントされたときにこのディレクトリの所有者を引き継ぐ。
RUN mkdir -p /srv/console && chown bun:bun /srv/console

USER bun
# read_onlyのルートで動かすため、トランスパイルの結果をディスクに残さない。
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
# 依存は持たないので、bunの自動インストール(実行時のパッケージ取得)を切る。
ENTRYPOINT ["bun", "--no-install", "/app/main.ts"]
CMD ["loop"]
