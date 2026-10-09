# セットアップ

このリポジトリをcloneしてから、ローカルのWindmillでSoftware Factoryを動かすまでの手順を書く。初めて環境を作る人と、作り直す人が読む。

## 前提

ホストに要るのは、Docker(Docker DesktopかOrbStack)とmiseだけである。node、bun、gh、windmill-cliなどほかのツールは、`mise run setup`の中の`mise install`で入る。

設定に`.env`系のファイルは使わない。`infra/.env`と`infra/secrets.env`は存在しない。秘密でない設定は`mise.toml`の`[env]`に、秘密値はgitignore済みの`mise.local.toml`に置く。理由は[セキュリティ](security.md)の「シークレットの扱い」にある。

## 資格情報を用意する

`mise.local.toml`に入れる秘密値は次の7つである。キーの一覧は`mise.local.toml.example`にもある。

| キー | 用意の仕方 |
| --- | --- |
| `DB_PASSWORD` | 自分で決める |
| `WM_ADMIN_EMAIL` | Windmillの初期管理者のメールアドレス`admin@windmill.dev`にする。`bootstrap`はこのアドレスと初期パスワードでログインする |
| `WM_ADMIN_PASSWORD` | 自分で決める。`changeme`と12文字未満は`bootstrap`が拒む |
| `GITHUB_TOKEN` | [セキュリティ](security.md)の「GitHubのPAT」の手順で取得する |
| `CLAUDE_CODE_OAUTH_TOKEN` | [セキュリティ](security.md)の「Claude CodeのOAuthトークン」の手順で取得する |
| `DISCORD_WEBHOOK_URL` | [セキュリティ](security.md)の「DiscordのWebhook URL」の手順で取得する |
| `CONSOLE_GITHUB_TOKEN` | [セキュリティ](security.md)の「Consoleの取り込み用のPAT」の手順で取得する。`GITHUB_TOKEN`は流用しない |

Consoleを取りに行くリポジトリは、`mise.toml`の`[env]`の`CONSOLE_GITHUB_REPO`にある。
フォークで動かすときだけ書き換える。

## 秘密値を投入する

秘密値は人が投入する。次のコマンドを使うと、値は画面に表示されず、シェルの履歴にも残らない。`KEY`をキーの名前に置き換え、キーごとに実行する。

zshでは次のように実行する。

```bash
read -rs 'v?KEY: ' && mise set -E local KEY="$v"; unset v
```

bashでは次のように実行する。

```bash
read -rs -p 'KEY: ' v && mise set -E local KEY="$v"; unset v
```

値は`mise.local.toml`の`[env]`に書き込まれる。`-E local`を付けなくても、以降の`mise run`と`mise exec`に反映される。

値を表示せずに、投入できたかを確かめるには次のように実行する。

```bash
mise exec -- sh -c 'test -n "$DB_PASSWORD" && echo ok'
```

`mise set -E local KEY=value`と値を直接書く方法は、補足の手段にとどめる。

> [!WARNING]
> 値を直接書くと、値がシェルの履歴にそのまま残る。
> 値に`!`などの記号があると、zshの履歴展開で壊れるので、記号を含まない値にだけ使う。

## 起動する

1. このリポジトリの`mise.toml`を信頼する。

   ```bash
   mise trust
   ```

2. ツール、JavaScriptの依存関係、gitのフックを入れる。
   中で`mise install`、`bun install --frozen-lockfile --ignore-scripts`、`lefthook install`を実行する。
   Consoleの依存は`bun install --cwd console --frozen-lockfile --ignore-scripts`で入れる。
   どちらも依存のinstall scriptは実行しない。

   ```bash
   mise run setup
   ```

3. [秘密値を投入する](#秘密値を投入する)の手順で、7つのキーを投入する。
4. 環境を診断する。

   ```bash
   mise run doctor
   ```

5. Docker Composeでスタックを起動する。イメージのビルドも行う。

   ```bash
   mise run up
   ```

6. ワークスペースを作り、secret変数を投入し、`wmill sync push`とmigrationを実行する。何度実行しても結果は同じになる。

   ```bash
   mise run bootstrap
   ```

7. ブラウザで`http://127.0.0.1:8080`を開き、`WM_ADMIN_EMAIL`と`WM_ADMIN_PASSWORD`でログインする。
8. Windmillの画面で`f/factory/factory_config`を開き、`owners`(対象リポジトリの所有者)と`instance_name`を設定する。この2つはgitで管理せず、`bootstrap`は空のまま作る。

`GITHUB_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、`DISCORD_WEBHOOK_URL`が空でも、`bootstrap`は完了する。対応するWindmillの変数が空で作られる。`doctor`はこれらが空だとNGを報告するので、運用を始める前に値を投入する。

`bootstrap`は、ワークスペースのIDを小文字の`factory`のままにし、表示名だけを`Factory`にする。表示名はダッシュボードのApp(Factory Console)などの表記にそろえる。

## gitのフック

`mise run setup`は、lefthookでgitのフックを入れる。フックは`--no-verify`で飛ばさない。

| フック | 実行するもの |
| --- | --- |
| pre-commit | `f/`の下をステージしたときは、先に`scripts/generate-metadata-staged.sh`を実行する。メタデータを作り直し、変わったlockとスキーマのファイルをステージする。続けて、biome、`as`の検出、`§`の検出、gitleaks、`wmill lint f`、文書の検査を並列に実行する |
| post-checkout | リンクされたgit worktreeでは、`scripts/link-worktree-wmill.sh`が`.wmill`をメイン作業ツリーの`.wmill`へのシンボリックリンクにする。メイン作業ツリーでは何もしない |
| commit-msg | `scripts/check-commit-msg.sh`でコミットメッセージの規約を検査する。Claude Codeのセッション(`CLAUDECODE=1`)では、Claudeのトレーラーの行も検査する |
| pre-push | `mise run check`を実行する。pushに`f/`、`dependencies/`、`wmill.yaml`、`wmill-lock.yaml`の変更があれば、`mise run metadata:check`で古いメタデータを見つけてpushを止める |

メタデータの作り直しと検査は、ローカルのWindmillに接続する。`mise run up`でスタックを起動しておく。手で実行するときは`mise run metadata`と`mise run metadata:check`を使う。

Windmillを起動できないときは、メタデータのフックだけを飛ばせる。次のように実行する。

```bash
LEFTHOOK_EXCLUDE=wmill-metadata git commit
LEFTHOOK_EXCLUDE=wmill-metadata-check git push
```

フックを飛ばしたときは、次のpushの前に`mise run metadata`を実行する。

CIの`metadata`ジョブも、メタデータが最新かを検査する。
使い捨てのWindmillをdbとサーバーだけで起動し、空のワークスペースを作って`mise run metadata:check`を実行する。
`main`へのpushでは、変更に関わらず毎回検査する。
`main`のCIの結果は、`main`全体の状態を表すためである。

PRと`main`以外へのpushでは、次のどれにも触れないとき、検査を飛ばして成功にする。

- メタデータの入力: `f/`、`dependencies/`、`wmill.yaml`、`wmill-lock.yaml`
- このジョブの定義
  - `.github/workflows/ci.yml`
  - `infra/docker-compose.yml`と`infra/docker-compose.ci.yml`
  - `scripts/ci-metadata-login.sh`と`scripts/check-metadata-fresh.sh`
  - `mise.toml`

比べる範囲は、PRではマージ基点からの変更、pushでは前回のpushからの変更である。
新しいブランチの初回pushでは、`origin/main`とのマージ基点からの変更を見る。
基点や差分を求められないときは、安全のために検査する。

フックを飛ばしてコミットしたPRは、手元で`mise run metadata`を実行してpushし直すまで、このジョブで失敗する。

### git worktreeのログイン情報

`.wmill`はwmillのログインプロファイルを置くディレクトリで、gitで管理しない。
`git worktree add`で作った作業ツリーには存在しないため、そのままではメタデータのフックが「No workspace profile found」で失敗する。
post-checkoutのフックは、メイン作業ツリーの`.wmill`へのシンボリックリンクを作業ツリーに張って、この失敗を防ぐ。

リンクを張るのは、メイン作業ツリーに`.wmill`があり、作業ツリーの`.wmill`が次のどれかのときだけである。

- 存在しない
- 空のディレクトリ
- リンク先が無いシンボリックリンク

空でないディレクトリと、リンク先があるシンボリックリンクは、作業ツリー自身のログイン情報を消さないために残す。
リンクを張れなかったときも、フックは警告だけを出して成功で終わる。
フックが失敗するとcheckoutまで失敗するためである。

ログイン情報は複製せず、すべての作業ツリーで共有する。
1回のログインで、すべての作業ツリーのメタデータのフックが動くようにするためである。
そのため、1つの作業ツリーで再ログイン、`mise run bootstrap`、接続先のワークスペースの切り替えのどれかを行うと、ほかのすべての作業ツリーにも反映される。
`mise run bootstrap`がトークンのファイルに行う権限の制限も、リンクをたどって共有先のディレクトリに及ぶ。
メイン作業ツリーに`.wmill`が無いときは、先にメイン作業ツリーで`mise run bootstrap`を実行する。

既存のクローンでは、`mise run setup`(または`lefthook install`)を再実行すると、post-checkoutのフックが入る。
フックを入れる前に作った作業ツリーには、次のcheckoutでリンクが張られる。
すぐに張るときは、その作業ツリーで`scripts/link-worktree-wmill.sh`を実行する。

## 自己更新の設定

`factory_config`の`factory_branch`には、`self_update`が追跡するこのリポジトリのブランチの名前を書く。既定値は`main`である。forkやfeatureブランチで運用するときは、Windmillの画面でこの値を変える。

この値が効くのは、workerの中にself cloneをまだ作っていないときだけである。既にあるself cloneに反映するには、workerコンテナの中の`/workspaces/factory/atelier-works`を消して作り直させる。

`f/factory/deployed_sha`は、直近でWindmillに反映したコミットのSHAを持つ、秘密でない変数である。`self_update`が更新するので、普段は人が編集しない。値を戻したいときは、Windmillの画面で直接編集する。

この変数は`factory_config`と同じく同期の対象外である。`bootstrap`は、変数が無いときだけ空の値で作り、あれば値を変えない。

## 動作を確かめる

| 確かめること | コマンド | 期待する出力 |
| --- | --- | --- |
| 環境の診断 | `mise run doctor` | すべての項目が`OK`で、最後に`=== 全項目OK ===`が出る。終了コードは0 |
| Windmillサーバーの応答 | `curl http://127.0.0.1:8080/api/version` | `CE v`に続いて、`mise.toml`の`WM_VERSION`の値が出る |
| ローカルとリモートの一致 | `mise exec -- wmill sync push --dry-run` | `0 changes` |
| Data Tableのmigration | `mise run test:db` | すべてのview(`v_inbox`など)のSELECTと、down migrationでの戻しが成功し、最後に`[test-db] OK`が出る |
| Consoleの取り込み | `mise exec -- docker compose -f infra/docker-compose.yml logs --tail 20 console_fetcher` | `"event":"status","state":"ok"`の行が出る。初回は`"event":"deployed"`も出る。`config_missing`なら、`CONSOLE_GITHUB_TOKEN`の投入と`mise run up`を確かめる |
| Consoleの配信 | `curl -sI http://127.0.0.1:8080/console/` | `HTTP/1.1 200`と`Content-Security-Policy`が出る。`/`と`/api/version`には`Content-Security-Policy`が付かない |

## トラブルシュート

| 症状 | 原因と対処 |
| --- | --- |
| ポートが衝突する | `mise.local.toml`の`WM_HTTP_PORT`で別のポートを指定する。投入は[秘密値を投入する](#秘密値を投入する)と同じコマンドで、`KEY`を`WM_HTTP_PORT`にする |
| `doctor`が「初期パスワード」でNGになる | パスワードが`changeme`のままである。`mise run bootstrap`がログインした後にパスワードを変える |
| `required variable ... is missing a value: run via mise`と出る | `docker compose`を`mise run`を通さずに実行している。composeの環境変数はmiseからしか渡らないので、`mise run <task>`か`mise exec -- docker compose ...`で実行する |
| workerのイメージを作り直したい | `mise run build`で、`windmill_worker`のサービスだけを作り直す |
| すべてを初期化したい | `mise exec -- docker compose -f infra/docker-compose.yml down -v`を実行する。下の警告を読んでから行う |
| ホストのCPUアーキテクチャが合うか気になる | 対応は要らない。Windmillの公式イメージとworkerのイメージは、arm64とamd64の両方に対応している |

> [!WARNING]
> `mise exec -- docker compose -f infra/docker-compose.yml down -v`は、`db_data`を含むすべてのvolumeを消す。Windmillのデータは元に戻せない。
