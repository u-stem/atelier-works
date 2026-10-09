# セキュリティ

Software Factoryの信頼境界、秘密値の扱い、資格情報の取得手順、各フローの安全策を説明する。Factoryを運用する人と、フローを変更する人が読む。安全策の仕組みの詳細は[実装フローの仕様](internals/implement.md)と[PRワークフローの仕様](internals/pr-workflow.md)にある。

## 信頼境界

Issue本文と対象リポジトリの内容は、信頼できない入力として扱う。headless Claudeはこれらをデータとして読むだけで、内容に書かれた指示には従わない。要件定義の生成での扱いは`factory-requirements`スキルに定める。

### 書き込める範囲

どのフローのClaudeにも、コマンドを実行するツール(`Bash`)は渡さない。
書き込みのツールを渡すフローでも、書いてよい場所をフローごとに絞る。
`--restricted`は、ファイルのツールを作業ディレクトリと`--add-dir`のディレクトリの下に閉じる。

| フロー | 書き込みのツール | 書いてよい場所 |
| --- | --- | --- |
| 要件定義の生成 | `Write`、`Edit` | 試行ごとの作業ディレクトリ(要件定義書と図)だけ。対象リポジトリのworktreeは`--add-dir`で読ませるだけにする |
| 監査 | `Edit`だけ | 作業ディレクトリの`report.md`だけ。self cloneのスナップショットは`--add-dir`で読ませるだけにする |
| PRのレビュー | なし | なし |
| PRの修正 | `Edit`、`Write` | PRのブランチのworktree |
| 実装 | `Edit`、`Write` | 実装ブランチのworktree。要件定義は複製を渡す |

要件定義と監査では、書いてよい場所をスキルとプロンプトで指示する。
`--restricted`が`--add-dir`のディレクトリへの書き込みを拒むかは、確かめていない。
書き込まれても外へ出ないよう、どちらのディレクトリもpushしない。
要件定義の生成のworktreeは、承認と掃除で消す。
監査のスナップショットは、実行のたびに作り直して消す。

残るリスクとして、要件定義の生成のworktreeは、既定ブランチの先頭が同じ間は次の試行でも使い回す。
そのため、Claudeが書き込んだ内容を、同じIssueの次の試行のClaudeが読みうる。

headless Claudeの起動には、次のフラグと環境変数で防御を足す。

| 設定 | 効果 |
| --- | --- |
| `--setting-sources user` | 対象リポジトリの`.claude/`などのプロジェクト設定を読み込ませない |
| `--strict-mcp-config` | 対象リポジトリのMCP設定を無視し、明示的に渡した設定だけを使う |
| `--max-budget-usd`、`--max-turns`、サブプロセスのタイムアウト | 暴走とコストの超過を打ち切る |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` | システムプロンプトにgit statusの写しとcommit・PRの手順を載せない |

最後の環境変数は、すべてのフローで設定する。写しを作るとき、Claudeは起動時に作業ディレクトリでgitを実行する。そのため、書き換えられた`.git`の参照先にあるconfig(`core.fsmonitor`など)を読みうる。どのフローのClaudeにも`Bash`を渡さないので、gitの文脈を使う処理は無い。

PRの修正(`pr_fix`)と実装(`implement`)のフローは、Claudeが対象リポジトリのworktreeに書き込み、その変更をpushする。
そのための追加の安全策は[PR修正の安全策](#pr修正の安全策)と[実装の安全策](#実装の安全策)に書く。

### 開発セッションのsubagent

`.claude/agents/`のsubagentは、開発のセッションで使うものである。
headless Claudeのフローは、プロジェクト設定を読み込まないので、これらを使わない。
レビュー役のsubagentは`Bash`を持つので、読み取り専用であることは指示で守らせる。
pushは親のセッションだけが、運用者の確認を経て行う。

### 状態の理由の区切り

状態の理由(`status_reason`や人の対応待ちの理由)は、`"; "`でつないだ項目の一覧である。
Consoleの表示と次の操作は、この区切りで分けた項目ごとに選ぶ。
Claudeや検査コマンドが書ける詳細と、pr_fixのClaudeが理由として書く`blocked_reason`は、区切りを`", "`に置き換えてから理由に入れる。
区切りを差し込んで、別の理由の訳文を表示させたり、既知の理由を足して次の操作を選ばせたりできないようにするためである。
置き換える詳細の範囲は[通知とrate limit](internals/notifications.md)にある。

残るリスクとして、Claudeは`blocked_reason`の全体を既知の理由と同じ文にできる。
そのときは、その理由の訳文と次の操作が表示される。

## シークレットの扱い

### Windmillでの保持

Windmillで実行する間、秘密値はWindmillのsecret変数に置く。

- `f/factory/claude_oauth_token`
- `f/factory/github_token`
- `f/factory/wmill_token`
- `f/factory/discord_webhook_url`

scriptは`wmill.getVariable()`で値を取得し、子プロセスの環境変数(`GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`など)としてだけ渡す。URLのクエリとパス、ログ、Data Tableの列、Discordの通知本文には出さない。

エラーメッセージと失敗の記録(`job_failures`)には、マスク処理を通してから値を入れる。マスクの関数はテストで検証する。

### ホストでの保持

ホストで使う次の秘密値は、gitignore済みの`mise.local.toml`に置く。テンプレートは`mise.local.toml.example`である。秘密でない設定は`mise.toml`の`[env]`にコミットする。

- `DB_PASSWORD`
- `WM_ADMIN_EMAIL`
- `WM_ADMIN_PASSWORD`
- `GITHUB_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `CONSOLE_GITHUB_TOKEN`

値は人が投入する。投入のコマンドは[セットアップ](setup.md)にある。Claudeが更新するのは、値の無いテンプレートである`mise.local.toml.example`までにする。投入が必要になったら、Claudeは実行するコマンドを示し、待たずにほかの作業を続ける。

`infra/.env`は置かない。存在するとDocker Composeが自動で読み込むためである。composeファイルは`mise run`が解決した環境変数を`${VAR:?run via mise}`の形で参照する。`mise run`を通さずに`docker compose`を実行すると、変数が無いので起動前に止まる。

### コマンド引数の例外

`scripts/bootstrap.sh`は、秘密値をコマンドの引数に載せない。例外は`wmill workspace add --token <t>`の1か所で、CLIにほかの受け口が無いためである。共有のマシンで実行すると、`ps`などでこの引数が見える。

### Windmill APIトークンの期限

workerが持つ`f/factory/wmill_token`は、ワークスペース`factory`に限定した有効期限180日のAPIトークンである。`mise run bootstrap`を実行するたびに新しいトークンを発行し、古いトークンを失効させる。これがトークンのローテーションの手段になる。期限が切れると、`self_update`のスケジュールが失敗する。

## 資格情報の取得

`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`は自分で決める。次の4つは外部のサービスから取得する。取得した値の投入は[セットアップ](setup.md)の手順で行う。

### GitHubのPAT

`GITHUB_TOKEN`には、GitHubのfine-grained personal access tokenを使う。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押す。表示された`github_pat_...`は一度しか表示されないので、その場で`GITHUB_TOKEN`として投入する。
5. orgのリポジトリが対象なら、org側でトークンを承認する。orgの設定によっては承認が要る。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-factory`。複数のインスタンスで運用するときは`atelier-works-factory-<instance_name>` |
| Description | `Software Factory worker (Issues/PR automation)` |
| Resource owner | 対象リポジトリの所有者(個人のアカウントかorg) |
| Expiration | Customで1年後(最長) |
| Repository access | Only select repositoriesを選び、拾わせるリポジトリ(sandboxのリポジトリを含む)を選ぶ |
| Repository permissions: Issues | Read and write |
| Repository permissions: Contents | Read and write |
| Repository permissions: Metadata | Read-only(IssuesかContentsを選ぶと自動で付く) |
| Repository permissions: Pull requests | Read and write |
| Repository permissions: Workflows | No access |
| Account permissions | すべてNo access |

ContentsをRead and writeにするのは、PR修正と実装のフローがブランチにpushするためである。WorkflowsはNo accessのままにする。`.github/workflows/`を含むpushをGitHubに拒否させるためである。実装フローは`.github/`の変更を止めずに記録するので、この拒否が実質のガードになる。

fine-grained PATは、トークンの値を変えずに権限の設定だけを変えられる。権限を変えるときは既存のトークンを更新すればよく、再発行は要らない。

Issue化の提案を承認してIssueを作るとき(`issue_proposal_apply`)も、同じ`f/factory/github_token`を使う。別の資格情報は用意しない。

有効期限は最長で1年である。`poll_issues`は冒頭で`GET /user`を呼び、トークンが失効していればジョブを失敗させる。noticeは残らない。失敗はスケジュールの失敗ハンドラ(`on_error_schedule`)が`job_failures`に記録し、Discordに`job_failed`として通知する。

GitHubの認証は、環境変数`GH_TOKEN`と、gitのcredential helperとしての`gh auth git-credential`だけで行う。`gh auth login`の対話ログインと、トークンを埋め込んだclone URLは使わない。

### Claude CodeのOAuthトークン

`CLAUDE_CODE_OAUTH_TOKEN`は、workerのheadless Claudeが使う、サブスクリプションの長期OAuthトークンである。

1. ホストにインストールしたClaude Code CLIで`claude setup-token`を実行する。
2. ブラウザでログインする。
3. 表示されたトークンを`CLAUDE_CODE_OAUTH_TOKEN`として投入する。

### DiscordのWebhook URL

`DISCORD_WEBHOOK_URL`は、通知の送り先である。

1. 通知先のDiscordチャンネルで、「チャンネル設定」、「連携サービス」、「ウェブフック」の順に開く。
2. 「新しいウェブフック」を押し、名前を`Software Factory`にする。
3. 「ウェブフックURLをコピー」でURLを取得し、`DISCORD_WEBHOOK_URL`として投入する。

### Consoleの取り込み用のPAT

`CONSOLE_GITHUB_TOKEN`は、Consoleの成果物を取り込む`console_fetcher`だけが使うfine-grained PATである。
Factoryの`GITHUB_TOKEN`は流用しない。
Actionsの読み取り権限が無いので403になり、ほかの権限も広すぎるためである。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押し、表示された`github_pat_...`を`CONSOLE_GITHUB_TOKEN`として投入する。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-console-fetcher` |
| Description | `Factory Console fetcher (read CI artifacts)` |
| Resource owner | このリポジトリの所有者 |
| Expiration | Customで1年後(最長)。期限切れは`console_fetcher`のログと`status.json`に`auth_failed`として出る |
| Repository access | Only select repositoriesを選び、このリポジトリだけを選ぶ |
| Repository permissions: Actions | Read-only |
| Repository permissions: Metadata | Read-only(自動で付く) |
| それ以外のRepository permissions | No access |
| Account permissions | すべてNo access |

値は`console_fetcher`のコンテナの環境変数にだけ渡る。
worker、Caddy、Windmillの変数には入らない。

## Windmillの公開範囲と初期パスワード

Caddyは`WM_BIND`のアドレスにだけバインドする。既定値は`mise.toml`の`[env]`にある`127.0.0.1`なので、ホストの外からは到達できない。外部に公開するときは、利用者が`WM_BIND`を明示的に変える。

初期の管理者アカウントのパスワードは、既知の既定値`changeme`である。`scripts/bootstrap.sh`はログインした後、パスワードを必ず`WM_ADMIN_PASSWORD`に変える。`WM_ADMIN_PASSWORD`が`changeme`か12文字未満なら、`bootstrap.sh`は実行を拒む。

`mise run doctor`は、既定のパスワードでログインできる状態をNGとして報告する。

## Consoleの配信

Consoleは、Windmillと同じオリジンの`/console/`で配信する。
ConsoleでXSSが起きると、運用者のCookieでWindmillのAPIを管理者として呼べる。
そのため、配信物の完全性とブラウザ側の制限を次のように守る。
仕組みの詳細は[Consoleの配信の仕様](internals/console.md)にある。

| 守ること | 内容 |
| --- | --- |
| 書ける場所を1つにする | 配信物の置き場所`factory_console`(dockerの名前付きボリューム)に書けるのは`console_fetcher`だけである。CaddyとConsole用のworkerは読み取り専用でマウントし、defaultのworkerはマウントしない |
| 取り込むものを絞る | `main`へのpushで動き、全体が成功した`ci.yml`の実行の成果物`console-dist`だけを取り込む。zipと展開した各ファイルのsha256を照合してから書く |
| `console_fetcher`を閉じ込める | rootでないuid、読み取り専用のファイルシステム、ケーパビリティなし、DBにもWindmillにも届かない専用のnetworkで動かす |
| ブラウザ側で制限する | `/console/*`の応答だけに、scriptの読み込み先を`/console/assets/`に絞ったCSPと、埋め込みを禁じるヘッダーを付ける |
| CSPとCaddyのパスの解釈の違いを塞ぐ | パーセント符号を戻した元のパスが`/console/`で始まる要求は、Windmillへ転送しない。Consoleの経路では、生のパスに`%2f`か`%5c`があれば400にする |
| 他のサイトからAPIを呼ばせない | `/api/*`への要求で`Sec-Fetch-Site`が`cross-site`か`same-site`のものは、Caddyが403にする |
| 配信する状態を絞る | `/console/status.json`で配信するのは、`console_fetcher`の状態の4項目(`state`、`sha`、`checked_at`、`error`)だけである。`checked_at`と`error`から、自動の配信が止まっていることなど運用の状態が外から見える。`error`には分類した失敗の種類だけを書き、トークンや応答の本文などの秘密は含まない。ボリュームの他のファイルは配信しない |
| 秘密を配信物に入れない | Consoleのバンドルは認証なしで配信されるので、`VITE_*`の変数に秘密を入れない |

> [!WARNING]
> `factory_console`を、`console_fetcher`以外のコンテナに書き込みでマウントしない。
> workerのサンドボックスを作るときも同じである。
> 書けるコンテナが増えると、運用者のブラウザに居座る改ざんの経路になる。

残るリスクは次のとおりである。

- `main`にpushできる者(FactoryのPATを含む)が書いたコードは、人のレビューを経ずに運用者のブラウザで動きうる。今のGitHubのプランではこのリポジトリにbranch protection(rulesets)を設定できず、`main`へのpushを人のレビュー済みのものに限れない。Consoleの変更のレビューは、Windmillの管理者権限を持つコードのレビューとして行う。
- CIの組み立ての途中で動くもの(miseが入れるbunなどのツール、Viteのプラグインなどの依存)が侵害されると、出力が改ざんされうる。`digest`とマニフェストが保証するのは、GitHubのCIが作ったものであることまでである。
- 信頼の境界は`console`ジョブだけでなく、`ci.yml`のすべてのジョブとそこで動くツールや依存に及ぶ。同じ実行のほかのジョブも、ランナーから取れるトークンで成果物`console-dist`を上げ直せるためである。成果物は`overwrite: true`で上げ、`console_fetcher`はその名前の`id`が最大の成果物を取り込む。
- `Sec-Fetch-Site`をブラウザが送るのは、信頼できるオリジン(localhostかHTTPS)のときだけである。`WM_BIND`を外向きにしてHTTPで公開すると、この防御は効かない。外向きにするならHTTPSで公開する。
- `Sec-Fetch-Site`の規則が効くのは`/api/*`だけである。`windmill_extra`の経路(`/ws/*`、`/ws_mp/*`、`/ws_debug/*`)には効かない。
- 共有の`assets/`には古い版のファイルも残る。その間は`script-src`で読み込めるので、XSSの足がかり(script gadget)に使われうる。
- Trusted TypesのReport-Onlyの方針には報告先が無い。違反はブラウザの開発者ツールのコンソールにしか出ない。
- `console_fetcher`の外への通信はnetworkでは絞れない。コードが侵害されれば、任意の宛先へ出られる。
- `console_egress`は通常のbridgeで、ホストのloopbackから切り離されない。既定の`WM_BIND=127.0.0.1`のままでも、`host.docker.internal`経由でホストのCaddy、つまりWindmillに届く(OrbStackで確認)。`WM_BIND`を外向きにすると、ホストのゲートウェイのIP経由でも届く。`console_fetcher`はWindmillの資格情報を持たないが、認証の要らない経路には届く。
- `CONSOLE_GITHUB_TOKEN`は、ホストのdockerを使える人には`docker inspect`で見える。
- 成果物を取りに行くリポジトリ`CONSOLE_GITHUB_REPO`は、コミットされた`mise.toml`にある。これを書き換える変更がマージされると、任意のpublicリポジトリの成果物を取り込みうる。`mise.toml`は保護パスで、マージは人が行うことで抑えている。
- 成果物の保持は30日である。30日以上`main`へのpushが無いと、新しく立ち上げた環境は取り込めない。そのときは`main`に何かをpushしてCIを動かす。

## workerコンテナの権限

workerは`privileged`にせず、`FAVOR_UNSHARE_PID`も有効にしない。Windmillの公式の構成は、ジョブを隔離するためにこれらを使うことがある。このworkerは信頼できないIssueを読むheadless Claudeを実行するので、侵害されたときにホストへ波及する範囲を小さくすることを優先する。

ジョブ間の隔離は、追加の特権に頼らず、工程ごとのツールの制限と読み取り専用の方針で確保する。

workerには`no-new-privileges:true`と、プロセス数の上限(`deploy.resources.limits.pids`)を設定する。`cap_drop`によるケーパビリティの削減と、rootでないユーザーでの実行はしない。ベースのWindmill公式イメージがrootでの実行を前提にしているためである。

## Console用workerの境界

Console用のworker(`windmill_worker_console`)は、Consoleの問い合わせと操作の受付だけを処理する。
信頼できないIssueを読むClaudeは、このworkerでは動かさない。
このworkerの境界が守るのは、ファイルシステムだけである。
絞り方は次のとおりである。

| 項目 | 設定 |
| --- | --- |
| 書き込めるマウント | `worker_logs`と専用の依存キャッシュ`worker_console_dependency_cache`だけである。`factory_state`と`factory_console`は読み取り専用でマウントする。`worker_logs`は、`windmill_server`、defaultのworker、nativeのworkerとも共有する書き込みのマウントである |
| `factory_workspaces` | マウントしない。対象リポジトリのチェックアウトに届かない |
| `worker_dependency_cache` | 共有しない。Console用のworkerは専用のボリュームを使うので、defaultのworkerと依存のキャッシュを通して影響し合わない |
| `docker.sock` | マウントしない |
| 権限 | `privileged`にしない。`no-new-privileges:true`と`init`を設定し、プロセス数は256、メモリは1024Mに絞る |

`factory_state`を読めるのは、要件定義書と図のファイルを返すためである。
`factory_console`は配信中のJSの置き場所なので、書き込みでマウントしない。
読み取り専用で付けるのは、取り込みの失敗を見張るscriptが`status.json`を読むためである。

次のことは、この境界では守れない。

- DBには届く。`DATABASE_URL`はdefaultのworkerと同じ管理者の接続だからである。
- `factory_state`には、`requirements/`と`audits/`のほかに、次のものも入っていて、Console用のworkerから読める。
  - Claude Codeの設定と履歴(`CLAUDE_CONFIG_DIR=/var/lib/factory/claude`)
  - ghの設定(`GH_CONFIG_DIR=/var/lib/factory/gh`)
- このworkerで動かすのはリポジトリのscriptの想定だが、これを強制する仕組みは無い。ワークスペースでscriptを編集できる者は、任意のscriptにtag`console`を付けられる。
  tag`console`を付けたscriptは、上の設定と履歴を読める。書けるのはdefaultのworkerだけである。
  読めると、Claude Codeとghの認証情報が漏れうる。
- composeの環境変数`WORKER_TAGS`は既定値である。DBにワーカーグループの設定があると、そちらが実効になる。変化はWindmillの画面の「Workers」で確かめる。

## 自己更新の依存インストール

`self_update`は、Consoleのraw appの依存を`npm ci --ignore-scripts`で入れる。
依存のinstall scriptは、workerの権限のまま、ネットワークにも出られる状態で動くためである。

- `wmill sync push`がraw appを組み立てるときに動かすnpmには、`--ignore-scripts`が効かない。そのため、`wmill`のサブプロセスの環境変数に`NPM_CONFIG_IGNORE_SCRIPTS=true`を渡す。
- ホストで動かすmiseのタスク(`mise run push`、`mise run deploy`など)も、`npm ci --ignore-scripts`とこの環境変数を使う。
- raw appの`package-lock.json`には、install scriptを要する依存(`hasInstallScript`)が無い。そのような依存を足すと、コントラクトテスト(`tests/lib/self_update_support.test.ts`)が落ちる。足す前に、install scriptなしで組み立てが通るかを確かめる。

## Claude Codeの拒否ルール

`.claude/settings.json`の`deny`は、誤操作を防ぐためのもので、秘匿性を保証しない。設定ファイルを読めば、ルールは誰でも確かめられる。秘匿性は、値をコミットしないこと(`mise.local.toml`はgitignore済み)と、値をWindmillのsecret変数に置くことで保つ。

次の操作を拒否する。どれも、展開した後の秘密値を出力しうる。

| 拒否する操作 | 理由 |
| --- | --- |
| `mise.local.toml`と、その別名のファイル(`.mise.local.toml`、`mise.*.local.toml`)の`Read`と`Edit` | 秘密値そのものが書かれている |
| `.env`、`infra/.env`、`infra/secrets.env`の`Read` | 秘密値が書かれうる |
| `.wmill/`の`remotes.ndjson`の`Read`と`Edit` | wmill CLIのワークスペースのプロファイルで、APIトークンが書かれている |
| `mise env`とその別名(`mise e`、`mise ev`、`mise env-vars`) | 展開した環境変数の一覧を出力する |
| `mise config`、`mise cfg`、`mise toml` | 設定値を出力する |
| 引数なしの`mise set` | 設定値の一覧を出力する |
| `mise exec -- env`、`mise exec -- printenv`、`mise x -- env`、`mise x -- printenv`、`printenv`、`env` | 環境変数を出力する |
| `cat mise.local.toml` | 秘密値そのものを出力する |

値を指定して書き込むだけの`mise set -E local KEY=value`は拒否しない。これらのルールは、`mise run <task>`を通した迂回(タスクの中で秘密値を出力する処理など)は防げない。

`mise x`は`mise exec`の別名で、`mise x -- bun test`のように通常の作業にも使うので、環境変数を出す形だけをこの設定で拒否する。
`docker exec`と`docker inspect`は、設定のルールが引数を絞れないので、ここには置かない。
どちらも、環境変数を出す形だけを次の節のフックが拒否する。
引数なしの`docker compose config`だけは、設定にも置く。
`mise set -E`は、秘密値を投入する手順([セットアップ](setup.md))と同じ形なので、設定では拒否せず、フックが`KEY=VALUE`の無い呼び出しだけを拒否する。

## Claude Codeのフック

ClaudeがBashを実行する前に、`.claude/settings.json`が`scripts/claude-hooks/`のフックを動かす。
ローカルとクラウドのどちらのセッションでも動く。
FactoryのheadlessなClaudeの実行は`.claude/`を読まないので、このフックは動かない。

| 拒否する操作 | 理由 |
| --- | --- |
| 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec) | 公開した履歴を書き換えると、ほかの作業やFactoryの`pr_fix`の変更を消しうる |
| `main`と`master`へのpush(`--all`と`--mirror`を含む) | mainへの変更は、PRとCIを通してだけ入れる |
| subagentからのpush | subagentには、pushの前に確認する相手がいない |
| `xargs`の引数で渡す`git push`と`git commit` | 標準入力から来る引数は、実行するまで分からない |
| `--no-verify`、`git commit -n`、`core.hooksPath`の設定、`LEFTHOOK`を`0`、`false`、`off`、`no`にすること | lefthookの検査を飛ばすと、壊れた変更や秘密値がpushされる |
| `LEFTHOOK_EXCLUDE`に`wmill-metadata`と`wmill-metadata-check`以外を書くこと | AGENTS.mdが飛ばしてよいとするのは、この2つだけである |
| `LEFTHOOK_BIN`と`LEFTHOOK_CONFIG`の設定 | インストール済みのフックが読む、lefthookのバイナリと設定を差し替えられる |
| `lefthook uninstall`、`.git/hooks`と`.git/config`への書き込み | gitのフックを外せる |
| `git -c alias.*`、`remote.*.push`・`push.default`・`include.*`・`includeIf.*`の設定、`GIT_CONFIG_COUNT`・`GIT_CONFIG_GLOBAL`・`GIT_CONFIG_SYSTEM`などの環境変数 | `push`や`core.hooksPath`を別の名前や設定の裏から差し込める |
| フックを実行するgitのサブコマンド(`commit`、`push`、`merge`、`rebase`など)に前置きした`HOME=`と`XDG_CONFIG_HOME=` | gitに別の設定ファイルを読ませて、フックを外せる |
| `echo`や`printf`が変数から組み立てた文字列を、標準入力で読むシェル | 中身を判定できない |
| `mise exec`の`-c`と`--command`、コードを渡したシェル、`env`、`printenv`、`set`、`export -p`などの環境変数の一覧 | `mise exec`は`mise.local.toml`の秘密値を環境変数として渡すので、値を表示できる |
| `docker exec`と`docker compose exec`で実行する環境変数の一覧とコードを渡したシェル(`mise exec --`の前置きがあっても) | コンテナは秘密値を環境変数として持つ |
| フィールドの経路だけの`--format`を持たない`docker inspect`、`Env`か`Config`を含む経路 | コンテナに渡した環境変数が見える |
| 出力を絞らない`docker compose config`と`docker compose convert` | 変数を展開したcompose定義を出力する |
| `/proc/<pid>/environ`(`task/<tid>`の下を含む)を引数やリダイレクトに含むコマンド | プロセスの環境変数がそのまま入っている |
| 書き込む`KEY=VALUE`を持たない`mise set` | `mise.local.toml`の値を一覧する |
| 秘密値のファイル(`mise.local.toml`とその別名、`.wmill/`の`remotes.ndjson`、`.env`系)を名前で指すコマンド | `Read`の拒否はBashに効かず、`cat`や`grep`で読むと値が会話の記録に残る |
| リポジトリの根、`infra`、`.wmill`を起点にした再帰的な`grep`、`-u`や`--no-ignore`を付けた`rg`、`git grep --no-index` | gitignore済みの秘密値のファイルまで読む |

`--force-with-lease`と`--force-if-includes`は、subagentではないセッションが`main`と`master`以外のブランチへpushするときに限って許す。
リモートが想定と違えば失敗するので、他の人の変更を上書きせずに、自分のブランチの履歴を直せる。

拒否のメッセージには、代わりの操作を示す。
再帰的な検索の代わりには、gitignoreを尊重する`rg`、`git grep`、Grepツールを使う。
`mise exec`の代わりには、ツールを直接指定するか、`mise run`のタスクを使う。
秘密値が設定済みかどうかは`mise run doctor`で確かめる。

### 判定の範囲

フックは、コマンドを字句に分けてから判定する。
引用符の中の文字列と、区切り語を引用符で囲んだヒアドキュメントの本文は、コマンドとして扱わない。
`sh -c`、`eval`、`$(...)`、バッククォートの中身は、別のコマンドとして判定する。
標準入力からコードを読むシェルは、入力がヒアストリング、ヒアドキュメント、`echo`や`printf`が書いた文字列ならその中身を判定する。
`curl`の出力を`sh`に渡す形のように、別のプログラムが渡すコードは、中身を読めないので拒否しない。
コンテナの中でインストーラーを実行する作業を止めないためである。
`bash -`は標準入力から読む形として扱う。
`time`、`command`、`exec`、`env`、`xargs`、`timeout`などの前置きは外してから判定する。
`bash`のほかに、`fish`、`ash`、`mksh`、`tcsh`、`csh`、`busybox sh`も同じように扱う。

秘密値のファイルの判定は、ファイルを読む引数とリダイレクトの先にだけ働く。
検索パターン(`rg mise.local.toml docs`の`mise.local.toml`)と、`sed`や`awk`の式の中の名前は拒否しない。
`find`の`-name`や`-path`などの値も拒否しない。
`ls`、`test`、`[[`、`echo`、`git check-ignore`のように中身を読まないコマンドも、名前を書いて拒否しない。
`process.env`のような識別子と、空白を含む文章は、ファイル名として扱わない。
`rm -rf dist/*`のように`*`だけで終わるglobは拒否しない。
`*.toml`のような秘密値のファイル名に当たりうるglobは、リポジトリの根、`infra`、`.wmill`の中のときだけ拒否する。

再帰的な`grep`と、`-u`や`--no-ignore`を付けた`rg`は、検索の起点がリポジトリの根、`infra`、`.wmill`、またはそれらを含むディレクトリのときだけ拒否する。
`scripts/`のようなサブディレクトリの検索は拒否しない。

`--no-verify`は、フックを実行するgitのサブコマンド(`commit`、`push`、`merge`、`rebase`、`am`、`cherry-pick`、`revert`、`pull`)でだけ拒否する。
`--`より後ろはパスとして扱う。
`git config core.hooksPath`は、値を設定するときだけ拒否する。読むことと`--unset`は拒否しない。

`git push`のブランチを省いたときの今のブランチは、同じコマンド行の前にある文字どおりの`cd`と`pushd`をたどって調べる。
`git -C`、`--git-dir`、`--work-tree`が指すディレクトリも同じように使う。
同じコマンド行の前にブランチを切り替える操作があれば、切り替えた先を今のブランチとする。
対象は`git checkout`、`git switch`、それぞれの`-b`と`-c`と`-t`、`git rebase <上流> <ブランチ>`、`git branch -m`である。
`git rebase`のオプションの値(`-X theirs`、`--onto <先>`など)は、ブランチとして数えない。
`git checkout <名前>`の名前がローカルのブランチなら、切り替え先だけを今のブランチとする。
そうでなければファイルの復元のこともあるので、実際のブランチも候補に残し、どちらかが保護するブランチなら拒否する。
`git rebase --root <ブランチ>`は、最初のオペランドをブランチとする。
`git switch`と`-b`、`-c`は、切り替え先だけを今のブランチとする。
`HEAD`、`@`、`main~2`のような相対の参照は、ブランチを変えないものとして扱う。
次の場合は、今のブランチが決まらないものとして扱う。

- 切り替え先が変数のとき
- `git checkout -`と`git checkout @{-1}`のとき
- `--detach`と`-d`のとき
- `git rebase <上流> <ブランチ>`の`<ブランチ>`が変数のとき

切り替えたブランチは、同じリポジトリの別のディレクトリ(`git -C scripts push`)でも使う。
`;`でつないだ切り替えも、成功したものとして扱う。
移動先が変数のときも今のブランチを調べられないので、そのpushだけを拒否する。
push先に`"$(git branch --show-current)"`を書いたときは、今のブランチとして扱う。
push先のrefspecは、`refs/heads/`と`heads/`を外して`main`、`master`と比べ、`*`を含むものは拒否する。
今のブランチとリポジトリの根を調べるgitの起動は、ディレクトリごとに結果を覚える。
1回の判定で、起動は20回、時間は5秒までに限る。
超えたコマンド行は、分けて実行するよう理由を示して拒否する。

`docker exec`と`docker compose exec`は、環境変数の一覧を出すコマンド(`env`、`/usr/bin/env`、`printenv`)かコードを渡したシェルのときだけ拒否する。
`docker compose exec windmill_worker kill <pid>`のような運用の手順は拒否しない。
`docker inspect`は、`--format`の`{{...}}`がフィールドの経路だけ(`{{.State.Running}}`、`{{json .State}}`)のときだけ拒否しない。
`{{.}}`、`range`、`printf`、`index`のように、オブジェクト全体を出せる指定は拒否する。
経路の区切りに`Env`か`Config`があるものも拒否する(`.HostConfig.Binds`は拒否しない)。
`--format`を複数指定したときは、1つでも拒否する形なら拒否する。
`docker compose config`と`convert`は、出力を絞った形を拒否しない。
絞るオプションは、`--services`、`--profiles`、`--volumes`、`--images`、`--hash`、`-q`、`--no-interpolate`である。

`mise exec`の拒否は、シェルにコードを渡す形と、環境変数の一覧を出すコマンドに限る。
`mise exec node -- env`のように、ツール名の後ろに`--`があるときは、その後ろのコマンドを見る。
名前を指定したツール(`mise exec -- gitleaks`、`mise exec -- wmill`、`mise exec -- bun test`)は拒否しない。
`bun -e`や`python -c`のように、インタープリターにコードを渡す形も拒否しない。
`mise exec -- bash scripts/doctor.sh`のように、スクリプトのファイルを渡したシェルも拒否しない。
この規則はベストエフォートで、`mise exec`経由で秘密値を読む方法をすべては塞げない。
`mise run`のタスクはリポジトリが定義するので、拒否しない。

### 失敗したときの動作

コマンドの意味を判定できないときは拒否する。
字句に分けられないコマンド、push先が実行するまで決まらないコマンド、フック自身の異常終了がこれに当たる。
Claude Codeは終了コード2以外のフックの失敗ではツールの呼び出しを止めないので、`scripts/claude-hooks/run.sh`が失敗を終了コード2に揃える。

実行環境が無いときは、警告を出して通す。
実行環境が無いのは、次の2つの場合である。

- 動くbunも、24以上のnodeも無いとき。依存を入れる前のコンテナが当たる。PATHにあってもshimの中身が無いbunや、24未満のnodeは、動かないものとして扱う
- 起動スクリプトが無いとき。`CLAUDE_PROJECT_DIR`が空のときが当たる

この場合も拒否すると、すべてのBashが止まり、人が復旧できないクラウドのセッションでは作業を続けられない。
`run.sh`は、動くbun、24以上のnode、`$HOME/.bun/bin/bun`、警告して通す、の順に試す。
警告は、終了コード0でも利用者に見えるよう、標準出力のJSON(`systemMessage`)にも出す。
起動スクリプトが無いときの登録コマンドも同じである。
`mise`は経由しない。自動インストールがタイムアウトを超えることがあり、信頼していない設定では動かないためである。
フックが動かない間は、`.claude/settings.json`の拒否ルールだけが残る。
フックは、bunとnodeのどちらでも動く(nodeは型を取り除いて`.ts`を実行できる24以上)。

Claude Codeは、タイムアウトしたフックのツール呼び出しを止めず、通常の権限の確認に進める。
そのため、登録するタイムアウトは10秒にして、処理が長引かないようにしている。
判定は同期の処理で、途中から止められない。
代わりに、gitの起動に回数と時間の上限を置き、gitの1回の実行にも2秒の上限を付ける。
非同期の判定を待つ処理には、8秒で終了コード2の拒否にする上限を付ける。
bunかnodeの起動そのものが止まったときだけ、タイムアウトの扱いになる。

### 拒否された操作を人が実行する

人は、拒否された操作を自分で実行できる。
ローカルのターミナルでは、プロンプトの先頭に`!`を付けると、Claudeを通さずにシェルがコマンドを直接実行するので、フックは動かない。
クラウドのセッションには`!`が無いので、人が別の場所で実行する。
フックをすべて止めるときは、gitignore済みの`.claude/settings.local.json`に`"disableAllHooks": true`を書く。
この設定はすべてのフックを止めるので、必要な間だけにして、済んだら消す。

### 判定しないもの

次の操作は判定できないので、拒否しない。

- 変数に入れたパスやコマンド(`cat "$FILE"`、`"$GIT" push`、`eval $CMD`、`bash -c "$X"`)
- 値が実行時に決まるオプション名(`git push ${X:---force}`など)
- シェルのエイリアスと関数
- `find -exec`、`env -S`、標準入力から名前を読む`xargs`(`git push`と`git commit`を除く)
- 外すことにしていない前置きのコマンド(`watch`、`flock`、`stdbuf`、`script`、`parallel`、`setsid`、`doas`など)
- スクリプトのファイルの中身
- コマンドを起動するインタープリター(`bun -e`、`python -c`が`git push`を実行する場合など)
- `bash /dev/stdin`や`source <(...)`のように、標準入力や置換から読むシェルのコード
- gitの省略形のオプション(`--forc`など)
- 式の中でファイルを開く操作(`sed`の`r`コマンド、`perl -e`など)
- `cd`やglob、`dd`、`perl -pi`、`find -delete`を使った`.git/hooks`と`.git/config`の書き換え
- `echo ... | cat | sh`のように、間にコマンドを挟んだ標準入力のシェル(直前のパイプの元だけを見る)
- `docker run ... env`のように、新しく起動するコンテナで環境変数を出す操作
- `gh auth token`のように、認証情報を表示するコマンドと、`~/.ssh`やgh CLIの設定ファイルの読み取り
- `mise exec`経由で秘密値を読む方法の一部(ベストエフォートの規則である)
- サブシェルの中の`cd`の範囲(外側にも効くものとして扱う)
- 前置きではない`HOME`と`XDG_CONFIG_HOME`の設定(`export HOME=...`の後のgit、`sh -c`の中のgit)
- 書き方を変えた`/proc/<pid>/environ`(`dd if=/proc/self/environ`、`/proc/self/./environ`、`//proc/...`、`/proc`の再帰的な検索)

フックは誤操作を止める仕組みで、意図した迂回は防げない。

## draw.ioビューアーのプライバシー

要件定義の図(`<name>.drawio`)は、生のXMLとして、要件定義のファイルと同じworker専用のディレクトリ(`requirement_drafts.doc_dir`の下)に書く。DBの`requirement_drafts.diagrams`列には、`{name, file}`の参照だけを入れる。図の内容とURLは、GitHubのIssueとPRのコメントにも、Discordの通知にも投稿しない。

Consoleは、`f/factory/steps/console_query.ts`の`requirements_doc`ビューで、`requirements.md`と各図のファイルを読み戻す。読む前に、`doc_dir`が`REQUIREMENTS_BASE_DIR`の下にあることを確かめる。図のXMLはWindmillのジョブ結果としてConsoleのフロントエンドに渡るだけで、GitHubとDiscordには送らない。

Consoleの`components/DrawioViewer.tsx`は、diagrams.netの公式の埋め込み用ビューアをページに一度だけ読み込む。スクリプトのURLは`https://viewer.diagrams.net/js/viewer-static.min.js`である。XMLは`<div class="mxgraph">`の`data-mxgraph`にJSONとして渡し、ブラウザの中で描画する。XMLは外部のサーバーに送らない。外部との通信は、スクリプト1つの取得だけである。

ConsoleのCSPがCDNからのスクリプトを拒否する場合は、`viewer-static.min.js`(Apache-2.0)をアプリのファイルとして同梱し、importする必要がある。この同梱は実装していない。

生成した図のXMLは、`f/factory/lib/drawio.ts`の`validateDrawioXml`で検査する。

## PR修正の安全策

PR修正のフロー(`pr_fix`)は、Claudeに書き込みのツールを与える。次の安全策で、信頼できないPRの内容やコメントから、Factoryの設定やworkerを書き換えられないようにする。仕組みの詳細は[PRワークフローの仕様](internals/pr-workflow.md)にある。

### Factory自身の投稿の判定

コメントがFactory自身の投稿かどうかは、投稿者がFactoryのGitHubアカウントであり、かつ本文にFactoryのマーカーがあるかで判定する。Factoryは人と同じGitHubアカウントで動くので、ログインだけでは人の投稿と区別できない。マーカーだけでは第三者が偽装できる。

この判定で除外するのは、Factory自身のPR修正の返信だけである。人のコメントと、Factoryの最初のレビューの指摘は、修正の依頼として扱う。

### ツールの制限

Claudeに渡すツールは`Read`、`Glob`、`Grep`、`Edit`、`Write`だけで、`Bash`は渡さない。`--restricted`でコード実行のツールとWebFetchを外し、ファイルのツールを作業ディレクトリに閉じる。ネットワークは遮断しない。

### 検査コマンドはフローが実行する

対象リポジトリのlintやテストは、Claudeではなくフローのステップが`factory_config`の`allowed_check_commands`を実行する。検査コマンドは対象リポジトリのコードをworkerの中でrootとして、隔離なしに実行する。そのため既定値は空の配列にし、空でなければ実行のたびに隔離していないことを知らせる記録(notice)を残す。

### 対象リポジトリの設定を信頼しない

対象リポジトリの`mise.toml`や`package.json`のscriptsは、信頼できない入力として扱う。workerのmiseは対象リポジトリの`mise.toml`を信頼しない。信頼が無いと動かない検査コマンドは実行せず、止めて報告する。

### 保護パスの変更を止める

保護パスを変更したら、修正を止める。保護パスは`.claude/`、`.agents/`、`mise.toml`、`lefthook.yml`、`.github/workflows/`、`package.json`のscripts、新しい`*.sh`などである。これらはFactoryやCIが実行する設定で、書き換えられるとコードを実行されるためである。
markdownlint-cli2とtextlintの設定(`.markdownlint-cli2.jsonc`、`.textlintrc.json`など)も止める。どちらも設定から任意のモジュールを読み込め、pre-commitと`mise run check`が読むためである。
Consoleでバンドルを通らずに配信される`console/public/`と`console/index.html`も止める。
一覧は`f/factory/lib/protected_paths.ts`にある。

### symlinkと特殊なファイルを止める

symlinkの作成・変更・削除、入れ子のリポジトリ、`.git`という要素を含むパス、通常のファイルでないものがあれば止める。symlinkを通すと、作業ディレクトリの外のファイルを読み書きされるためである。変更の一覧は、引用符付きのパスや未追跡のディレクトリでも判定を素通りしない形で取得する。

### HEADとブランチの確認

変更を調べる前に、worktreeのHEADとブランチが、準備のときに見たPRのものと同じかを確かめる。検査コマンドがcommitやブランチの切り替えをすると、その変更が差分から消えて検査を素通りするためである。

### worktreeの.gitファイルの書き換えを止める

worktreeの`.git`ファイルは、準備のときに検証して中身を記録する。以降、Claudeを起動する前とgitを実行する前に、記録と一致することを確かめる。参照先を別のディレクトリに向けられると、そこのconfigの設定を次のgitがrootで実行するためである。この安全策は実装のフローでも同じように働く。

### コミットの直前の再検査

完了のステップは検証とは別のジョブなので、commitの前にもう一度確かめる。worktreeを使うプロセスが残っていないこと、ブランチとHEADが記録どおりであること、ステージした内容に保護パスやsymlinkが無いことを見る。1つでも通らなければ、commitとpushをしない。

commitの前には、実装フローと同じgitleaksの検査もする。
commitするツリーは、gitleaksが検査したツリーと同じことを確かめ、pushは作ったcommitのshaだけを送る。
検査していない変更と履歴をpushしないためである。
手順は[PRワークフローの仕様](internals/pr-workflow.md)の「コミットの前の再確認」にある。

### 差し替えとサブモジュールに惑わされない

gitの実行には`GIT_NO_REPLACE_OBJECTS=1`を付け、`refs/replace/`で差し替えたオブジェクトを読まない。変更の一覧には`--ignore-submodules=none`を付け、サブモジュールの変更を隠させない。差し替えのrefとサブモジュールの設定は、検査コマンドが作れるためである。

同じ理由で、ローカルの`origin/HEAD`と追跡ref(`refs/remotes/origin/*`)も、送る内容を決めるときには信じない。
検査コマンドはメインのcloneの`.git`を書き換えられ、`--prune`なしのfetchは書き換えられた`origin/HEAD`を直さない。
実装フローが空のブランチをpushするときは、リモートに`git ls-remote`で問い合わせた既定のブランチの先頭を送る。
リモートの`HEAD`が既定のブランチと違うとき、リモートに既定のブランチが無いとき、ローカルの追跡refがリモートと違うときは、何もpushしない。

### 差分の大きさの上限

変更したファイルの数が`max_fix_changed_files`を超えるか、差分の行数が`max_fix_diff_lines`を超えたら止める。マージの衝突やファイルの削除による大きな変更を、レビューなしにpushしないためである。

### PRの状態とheadの確認

準備のステップで、PRについて次の4点を確かめる。

- openである。
- forkからでない。
- draftでない。
- baseが保護ブランチでない。

通らなければ、worktreeを作らずにブロック(`blocked`)で止める。
forkのブランチと保護されたbaseにはFactoryがpushしてはならず、draftのPRは作者がまだ作業しているためである。

pushの直前には、PRのheadが準備のときから変わっていないことだけを確かめ直す。
変わっていれば、pushせずにブロックで止める。
人がpushした変更を上書きしないためである。

### コミットの作成者情報

コミットのauthorとcommitterには、PATのアカウントのログイン名とGitHubのnoreplyメールアドレスを使う。個人のメールアドレスをどこにも書き込まないためである。値は`git commit`の環境変数としてだけ渡し、git configには書かない。

## 実装の安全策

実装のフロー(`implement`)も、Claudeに書き込みのツールを与える。PRを作るところで止まり、マージは常に人が行う。Factoryはmerge APIを呼ばない。仕組みの詳細は[実装フローの仕様](internals/implement.md)にある。

### ツールの制限と検査の分担

Claudeに渡すツールは`Read`、`Glob`、`Grep`、`Edit`、`Write`だけで、`Bash`は渡さない。検査コマンドはフローが実行する。

### 承認後のIssueの書き換えを使わない

Claudeに渡すIssueの題名と本文は、取り込んだ時点のものである。承認の後にIssueを書き換えて指示を差し込むことはできない。現在のIssueは、openかどうかの確認と、PR本文の注記にだけ使う。

### 同じ作業項目を同時に実装しない

同じ作業項目の実装フローは、同時に1つしか作業しない。フローのジョブIDをリースとして扱い、worktreeとClaudeのプロセスにはロックファイルを持たせる。Windmillでジョブを取り消しても、Claudeや検査コマンドのプロセスは止まらないためである。

### 承認済みの要件定義を書き換えさせない

Claudeには、要件定義のディレクトリを一時ディレクトリに複製して渡す。Consoleが表示する承認済みの文書は渡さない。複製にはsymlinkを写さないので、Claudeが文書の外のファイルに書き込む経路は残らない。

### 検査コマンドを明示したリポジトリだけで実行する

検査コマンドは、Claudeが書いたコードをworkerの中でrootとして、隔離なしに実行する。そのため、`check_commands_by_repo`にそのリポジトリのコマンドを明示したときだけ実行し、`allowed_check_commands`は使わない。Issueを信頼できる人だけが起票するリポジトリにだけ設定する。

### 対象リポジトリのCIが動く

実装ブランチのpushとPRの作成で、対象リポジトリの`push`と`pull_request`のCIが動く。Claudeの書いたコードは、人のレビューより前に、そのリポジトリのsecretsを使える状態で実行されうる。対象リポジトリのCIの権限とsecretsの範囲は、この前提で設定する。

### 保護パスは止めずに明示する

保護パスの変更は止めずに、PR本文とDiscordの通知に列挙する。保護パスは、PR修正の一覧より広い`IMPLEMENT_PROTECTED_PATH_PREFIXES`などで定める。そのラウンドは検査コマンドを実行せず、検査はGitHubのCIに任せる。書き換えられた設定をworkerで実行すると、Issueの本文からコードを実行する経路になるためである。

### symlinkの変更を止める

symlinkの作成・変更・削除があれば、人の対応待ちにする。ファイルシステムではなくgitのモードで判定するので、worktreeに残っていないsymlinkも捕まえる。

### 差分の大きさの上限

変更したファイルの数と差分の行数が、`implement_max_changed_files`と`implement_max_diff_lines`を超えたら、人の対応待ちにする。

### 保護ブランチのガードは使わない

baseが保護ブランチなら止めるガードは、実装フローには適用しない。実装フローは保護されたbaseに直接pushせず、PRを作るだけのためである。

### gitleaksで毎ラウンド検査する

毎ラウンド、デフォルトブランチから分かれた点と、そのラウンドで記録したツリーの間の差分全体を、gitleaksの既定のルールで検査する。対象リポジトリの`.gitleaks.toml`、`.gitleaksignore`、行内の`gitleaks:allow`などでは検出を無効にできない。検出結果はルール名とファイル名だけをClaudeとDBに渡し、一致した文字列は渡さない。

検査したツリーが、そのラウンドで変更を判定したツリーと違えば、そのラウンドで止める。
判定と検査の両方を経たツリーだけを、検証済みとして記録するためである。

### 検証したツリーだけをコミットする

検査に通ったラウンドのツリーを記録し、コミットの直前に一致を確かめる。検査コマンドがファイルを書き換えた場合など、検証の後にworktreeが変わっていればpushしない。

commitの直前には、ステージし直した索引のツリーも同じツリーと比べる。
commitの後には、作ったcommitのツリーを確かめ、違えばcommitを取り消す。
検査していない内容をcommitしないためである。

### pushする履歴を記録した先頭と新しい1つのcommitに限る

commitの前に、ローカルのHEADが、準備のステップの記録した実装ブランチの先頭であることを確かめる。
pushは、作ったcommitのshaだけを送る。
検査コマンドがローカルで作ったcommitは差分の検査に現れないのに、pushすると履歴ごと送られるためである。
準備のステップが空のブランチをpushするときも、ローカルのブランチではなく、リモートに問い合わせた既定のブランチの先頭のshaを送る。

### pushの前に生き残りのプロセスを確かめる

途中経過のpushと最終のcommitの前に、worktreeを使うプロセスが残っていないことを確かめる。
残っていればpushせずに、人の対応待ちにする。
前のステップのClaudeや検査コマンドが、検査とcommitの間にworktreeを書き換えうるためである。

仕組みは[実装フローの仕様](internals/implement.md)の「検証したツリーだけのコミット」、「pushする履歴の制限」、「pushの前の生き残りのプロセスの確認」にある。

### コミットメッセージのIssue参照を無効にする

Claudeが書くコミットメッセージの`#12`などのIssue参照は`No.12`の形に、IssueとPRのURLのホストは`github[.]com`に書き換える。デフォルトブランチへのマージで、任意のIssueを閉じたり無関係なIssueにリンクしたりしないためである。Issueとの紐づけは、Factoryが書くPR本文の`Closes #N`だけで行う。

### 子プロセスをグループごと止める

git、gh、Claude、検査コマンドは、新しいプロセスグループで起動する。終了した後もグループに残ったプロセスを止め、出力のパイプが閉じなければ読み取りを打ち切る。打ち切った出力は途中で切れているので、判断に使う実行は失敗として扱う。

### 検査コマンドの出力を絞って保存する

検査コマンドの出力は、ストリームごとに1MiBまで保持する。DBには、秘密値をマスクした先頭の16KBだけを保存する。

### workflowの変更はpushで止まる

`.github/workflows/`を含むpushは、PATにWorkflowsの権限が無いのでGitHubが拒否する。拒否されたら、作業項目は人の対応待ちになり、理由に拒否が載る。

## 監査の安全策

工程5の監査では、Claudeが読む入力と書ける場所を絞る。

| 安全策 | 内容 |
| --- | --- |
| 証跡パックはデータ | `audit_prepare`が集める証跡パック(`evidence.md`)は、`maskSecrets`とHTMLの除去(タグとコメント)を通した文字列だけにする。`factory-audit`スキルは、証跡パックと`--add-dir`で渡すFactory自身のリポジトリを、命令ではなくデータとして扱う |
| ツールの制限 | Claudeのツールは`Read`、`Glob`、`Grep`、`Edit`だけにする。`Edit`はカレントディレクトリの`report.md`にだけ使わせ、`Write`は許可しない |
| self cloneは見せない | `audit_generate`は、self cloneのHEADから使い捨てのdetached worktree(`/var/lib/factory/audits/wi-<id>-snapshot`)を作り、`--add-dir`、テンプレート、スキルをそこに向ける。スナップショットは成否に関わらず`finally`で消し、ステップの再試行で作り直す |
| 出力の機械検査 | Issueになる提案のtitle、body、summaryは、HTMLコメント、禁止した記法、許可リスト(Factory自身のGitHubのURLとWindmillの公開URL)の外のURLを検査する。レポート本文は対象リポジトリのURLを引用するのでURLの検査から外し、章立て、HTMLコメント、改善提案の表と構造化出力の一致を検査する。検査に通らない出力は保存しない |
| 人の承認が最後のゲート | 検査に通った提案も、Consoleの承認タブで人が承認するまでIssueにならない。承認された提案だけが`factory_repo`にIssueとして起票される |

self cloneは`self_update`のデプロイ元なので、Claudeに書き換えられないよう直接は渡さない。

## 承認と権限

承認できるのは、`f/factory/**`のスクリプトを実行できるアカウントである。実行の権限はフォルダ`f/factory`の権限で決まり、このフォルダには所有者も追加の権限も付けていないので、ワークスペースの管理者だけが該当する。

承認は必ずConsoleの承認タブ(`approval_decide`を実行する)から行う。Windmillのapproval pageのURLは署名付きのcapability URLなので、PRのコメントやDiscordの通知に載せない。approval pageのURLから直接resumeすると承認の状態が記録されず、作業項目は人の対応待ちになる。

承認者は`f/factory/lib/approver.ts`の`deriveApprover`が導出する。記録先は`approval_requests.decided_by`と`issue_proposals.decided_by`である。Windmillのログインユーザー名(`WM_USERNAME`)を優先し、無ければ`WM_EMAIL`を使い、どちらも無ければ例外で処理を止める。呼び出し元が渡す引数は承認者として信頼しない。承認者が不明なまま既定値で記録することは無い。

## ラベル付与の制限

publicのリポジトリで第三者がラベルを付けてパイプラインを起動するのを防ぐため、ラベルを付けた人を確かめる。

`poll_issues`は、Issueのタイムラインから、最後に`factory`ラベルを付けた人の`author_association`を確かめる。OWNER、MEMBER、COLLABORATORのどれかでなければ、Issueを拾わずにnoticeを記録する。タイムラインはラベルの付与と剥奪の履歴なので、取り込みでラベルが外れた後もこの確認は働く。

GitHubでは、ラベルを付けるのにtriage以上の権限が要る。`author_association`の確認は、この制約に重ねる補助の確認である。

`factory`ラベルを付け直すと新しいサイクルが始まり、同じIssueの承認済みの作業項目は取り消される。
そのため、ラベルを付けられる人は、承認の取り消しも起こせる。
pushの権限を持たないtriageの権限のcollaboratorも、これに含まれる。

PRのレビューとコメントも、投稿者で絞る。許可する関係は`allowed_labeler_associations`で、既定値は`["OWNER", "MEMBER", "COLLABORATOR"]`である。これに当たらない投稿者のレビューコメントと新しいコメントは、`pr_review`と`pr_fix`の起動に使わない。

`factory:review`と`factory:fix`のラベルについては、タイムラインを確かめず、GitHubの権限の制約だけに頼る。この制約は付与の操作そのものにかかるので、取り込みでラベルが外れた後も弱まらない。
