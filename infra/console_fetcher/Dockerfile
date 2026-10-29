# Consoleの成果物をGitHubから取り込み、共有ボリュームに置くコンテナ。
# 第三者のパッケージは入れない。bunの版はmise.tomlの[tools]と揃え、digestで固定する
# (tests/console_fetcher/dockerfile.test.tsが確かめる)。
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

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
