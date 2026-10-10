# セットアップ

このリポジトリをcloneしてから、ローカルのWindmillでSoftware Factoryを動かすまでの手順を書く。初めて環境を作る人と、作り直す人が読む。

## 前提

ホストに要るのは、Docker(Docker DesktopかOrbStack)とmiseだけである。node、bun、gh、windmill-cliなどほかのツールは、`mise run setup`の中の`mise install`で入る。
テストを動かすホストのgitと、workerのgitは、2.44以上が要る([実装フローの仕様](internals/implement.md)を参照)。

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
mise run doctor
```

環境変数の項目が、未設定のキーの名前を示す。値は表示しない。

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
| pre-commit | `f/`の下をステージしたときは、先に`scripts/generate-metadata-staged.sh`を実行する。メタデータを作り直し、変わったlockとスキーマのファイルをステージする。続けて、biome、`as`の検出、`§`の検出、短い名前のリモートrefの検出、gitleaks、`wmill lint f`、文書の検査を並列に実行する |
| post-checkout | リンクされたgit worktreeでは、`scripts/link-worktree-wmill.sh`が`.wmill`をメイン作業ツリーの`.wmill`へのシンボリックリンクにする。メイン作業ツリーでは何もしない |
| commit-msg | `scripts/check-commit-msg.sh`でコミットメッセージの規約を検査する。Claude Codeのセッション(`CLAUDECODE=1`)では、最後の段落にClaudeのトレーラーの行があるかも検査する |
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
このジョブを動かす条件は、「CIの実行の範囲」にある。

フックを飛ばしてコミットしたPRは、手元で`mise run metadata`を実行してpushし直すまで、このジョブで失敗する。

### CIの実行の範囲

`ci.yml`は、次のときに動く。

- `push`は`main`だけで動かす。
  ほかのブランチは、PRの実行が検査する。
- タグのpushでは動かさない。
  `main`という名前のタグで動くと、その実行は「mainの最新の成功した実行」に見える。
  console_fetcherの取り込みが止まるため、動かさない。
- `pull_request`は、変更したパスで絞らない。
  文書だけのPRも、lint:docsと秘密情報の検査のために動く。
- 同じ参照の古いPRの実行は、新しい実行が始まると止める。
- `main`の実行は止めない。
  止めると、console_fetcherの取り込む成功した実行が欠けるためである。

動いた実行の中では、`scope`ジョブが変更したファイルを見て、後続のジョブを動かすかを決める。
判定は`scripts/ci-scope.ts`にあり、結果を6つのフラグ(`db`、`worker`、`caddy`、`fetcher`、`metadata`、`console`)で各ジョブに渡す。
飛ばしたジョブは課金されない。
関係しないジョブを飛ばすと、GitHub Actionsの無料枠の消費が減る。
`check`ジョブは常に動かす。
ただし、`check`ジョブの中のworkerイメージのビルドとプロセスロックのテストは、`worker`が偽のときに飛ばす。

変更したパスは、次の順に規則を当てて、動かすジョブを決める。

1. 個別の規則: 先に当たった規則だけを使う。
2. 入力が決まっているパスの規則: 当たった規則のジョブをすべて動かす。
3. 許可リスト: `check`の検査だけで足りるパス。どのジョブも動かさない。
4. どれにも当たらないパス: すべてのフラグを真にする。

どれにも当たらないパスは、読むジョブが分からない。
検査を見逃すより、余分に動かすほうが安全なため、すべてのジョブを動かす。
許可リストには、迷うパスを入れない。

次のパスが変わると、すべてのフラグが真になる。
CI自身と環境の定義が変わると、どのジョブの結果も変わりうるためである。

- `.github/workflows/`
- `.github/`のうち、IssueとPRのテンプレート以外
- `infra/`のうち、`Caddyfile`、`console_fetcher/`、`worker/`以外(`docker-compose*.yml`を含む)
- `mise.toml`、`package.json`、`bun.lock`、`wmill.yaml`
- ルートの`tsconfig*.json`
- `scripts/`の下の`.sh`ファイル(次の表に挙げたものを除く)
- `scripts/ci-scope.ts`と`tests/scripts/ci-scope.test.ts`(判定自身。誤ると検査を飛ばすため)
- 次の表と許可リストのどちらにも無いパス(例: `.mise.toml`、`.tool-versions`、`bunfig.toml`、`.npmrc`、`.gitattributes`)

次の表のパスは、表のジョブだけを動かす。

| パス | 動かすジョブ |
| --- | --- |
| `infra/Caddyfile` | `caddyfile` |
| `infra/console_fetcher/` | `console-fetcher-image` |
| `infra/worker/` | `check`の中のworkerのステップ |
| `migrations/`、`scripts/test-db`で始まるファイル | `test-db` |
| `test:db`が読み込む`f/factory/`の下のファイル | `test-db`と`metadata` |
| `f/factory/lib/process_lock`と`tests/lib/process_lock`で始まるファイル、そのテストが読み込むファイル | `check`の中のworkerのステップ |
| `f/`、`dependencies/`、`wmill-lock.yaml` | `metadata` |
| `scripts/check-metadata-fresh.sh`、`scripts/ci-metadata-login.sh` | `metadata` |
| `console/`、`scripts/check-console-lockfile.ts` | `console` |

許可リストは、次のパスである。
どれも、読むのは`check`のステップだけで、他のジョブは読まない。

| パス | 理由 |
| --- | --- |
| `docs/`、`.md`ファイル | lint:docsとdocs:gen --checkが検査する |
| `tests/` | テストは`check`だけが実行する(プロセスロックとCIの判定のテストは、上の規則が先に当たる) |
| `.claude/`、`.agents/`、`templates/` | CIのジョブは読まない |
| `rt.d.ts`、ルートの`c_factory_config.resource-type.yaml` | `wmill.yaml`の同期の対象(`f/**`)の外で、メタデータの入力ではない |
| `biome.json`、`lefthook.yml`、`.gitleaks.toml`、`.textlintrc.json`、`.markdownlint`で始まるファイル、`.gitignore`、`LICENSE` | lintと走査の設定で、`check`のステップが読む |
| `scripts/`の下の`.ts`ファイル | 上の規則に当たらないものは、`check`のテストが担う |
| IssueとPRのテンプレート、`scripts/claude-hooks/run.sh`、`scripts/check-commit-msg.sh` | `check`の文書の検査とテストが担う |

`console`ジョブは、型検査、lint、テストをしない。
`check`ジョブの`mise run check`がConsoleの検査(`console:check`)を含むためである。
`console`ジョブは、lockfileの検査、ビルド、draw.ioのビューアの取得と照合、マニフェストの書き出し、成果物の上げだけをする。

差分の基点は、イベントで決める。

- PRは、マージ基点から先頭までの変更を見る。
- `main`へのpushは、直近で成功した`ci.yml`の`main`のpushの実行のcommitから、今のcommitまでの変更を見る。
  直前のpushを基点にすると、直前の実行が失敗していても、無関係な次のpushで失敗したジョブが飛ばされ、実行が成功になるためである。
  成功した実行を基点にすれば、失敗したcommitの変更は、次の実行で必ず検査し直される。
- `main`へのpushでは、`console`を常に真にする。
  `console_fetcher`が、`main`へのpushで成功した実行の成果物`console-dist`を取り込むため、毎回その実行を作る。

次のときは、すべてのフラグを真にする。
検査を見逃すより、余分に動かすほうが安全なためである。

- 差分を取れないとき
- `main`へのpushで、成功した実行を取得できないとき、結果が空のとき、結果の形が不正なとき
- `main`へのpushで、基点が今のcommitと同じとき、または今のcommitの履歴に無いとき
- イベントを判別できないとき

理由は、`scope`ジョブのログに`scope fallback: <理由>`の1行で出る。

ファイル名は、改行や空白を含んでいても壊れない形で読む。
名前の変更は、変更前と変更後の両方のパスを変更として扱う。

後続のジョブは、`scope`の出力が欠けても動く。
`scope`ジョブが失敗しても、後続のジョブは動かし、実行は失敗になる。

条件で飛ばしたジョブは、成功として扱われる。

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
