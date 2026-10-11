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

### mainの保護とリポジトリの公開

このリポジトリは公開している。
`main`はrulesetの`protect-main`で保護し、次の制限をかける。

- `main`の削除とforce pushを禁止する。
- `main`への変更はPRを必須にする。承認は0件でよく、人のレビューをGitHubが強制するわけではない。
- 必須チェックは`scope`、`check`、`test-db`、`metadata`、`console`、`caddyfile`、`console-fetcher-image`である。条件付きのジョブは、スキップされると通過として扱われる。
- 設定を迂回できるのは、管理者のロールだけである。迂回のモードは`pull_request`なので、直接pushはできず、PRを経由する迂回に限られる。

公開に伴い、外部からの操作は次のように絞る。

- GitHubのinteraction-limitsを`collaborators_only`にしている。期限付きの設定で、切れると外部の利用者もIssueやPRを作れるようになる。期限はGitHubの設定画面で確かめる。
- forkのPRのワークフローは、すべての外部の投稿者について、承認があるまで動かさない。
- secret scanningとpush protection、Dependabot security updatesを有効にしている。
- 脆弱性は、非公開の報告で受ける。窓口は[SECURITY.md](../SECURITY.md)にある。

FactoryはPAT(`f/factory/github_token`)で、人と同じアカウントとしてGitHubを操作する。
`f/factory`にはPRをマージするAPIの呼び出しが無い。
ただし、PATが`main`へのマージの権限を持つかは確かめていない。
承認が0件なので、PATで開いたPRを人の確認なしにマージできるかも確かめていない。
どちらも確かめるまでは、残るリスクとして扱う。

### CIで走査されないコミット

atelier-worksのCIは、gitleaksでPRのコミットを走査する。
走査されないコミットが、次の2つの場合に残る。

残るリスクとして、PRのCIの実行は、同じPRの新しい実行が始まると`cancel-in-progress`で止まる。
秘密値を含むコミットを、実行の途中でforce pushにより置き換えると、置き換えられたコミットはCIのgitleaksで走査されない。
置き換えられるのは、PRの履歴から外れたコミットなので、受け入れる。
手前の防御として、lefthookのpre-commitのgitleaksと、Factoryのpush前の走査がある。

残るリスクとして、`push`は`main`だけで動くので、PRを作るまで、人がpushしたブランチのコミットはCIで走査されない。
実行されるのはlefthookのpre-commitのgitleaksだけで、ローカルで飛ばせる。
PRを作ればCIが走査し、Factoryは実装ブランチのpushの前に走査するので、受け入れる。

### CIのトークンの権限

`ci.yml`の既定の権限は、リポジトリの読み取り(`contents: read`)だけである。
`scope`ジョブだけが、実行の一覧を読む権限(`actions: read`)を足す。
`main`へのpushで、直近で成功した実行のcommitを調べ、差分の基点にするためである。
どちらも読み取りだけで、書き込みの権限は付けない。
トークンを`gh`に渡すのは`main`へのpushの実行だけで、PRの実行には渡さない。

### CIの実行の範囲の判定

残るリスクとして、PRの実行の判定は、PRの版の`scripts/ci-scope.ts`で行う。
判定を書き換える変更は、保護パスとして`pr_fix`と`implement`が止める。
人が書いたPRは`ci.yml`も書き換えられるので、レビューで確かめる。

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

### 自己更新の通知の状態

`poll_issues`は、版の食い違いを最初に見た時刻をWindmillのstateに保存し、猶予を超えたときに`deployed_sha_mismatch`を通知する。
通知は、今の`deployed_sha`への反映が成功した記録(`factory.deployments`)のうち最も新しいものより前に作られたものだけが、自動で解決される。
残るリスクは次のとおりである。

- stateを書けるWindmillの利用者は、`deployed_sha_mismatch`の通知を遅らせられる。`deployed_sha`を書ける者と同じ範囲である。
- stateや`deployed_sha`を書き換えても、通知より新しい反映の成功の記録が無い限り、通知は解決されない。
- `deployed_sha`を今のHEADに書き換えると、版が一致するので、自己更新もそれを反映済みとみなす。これは通知の仕組みより前からある性質である。
- `factory.deployments`に書けるDBの利用者は、この判定も動かせる。

### ホストの反映の印

`host_action_required`は、自己更新が印を読んで自動で解決する。
印は、ホストの`mise run up`が共有ボリュームの`/var/lib/factory/host_applied_sha`に書く。
読む側は、印を信用しすぎないよう次のように読む。

- 通常のファイルで、symlinkでなく、128バイト以下のときだけ読む。`O_NOFOLLOW`と`O_NONBLOCK`で開き、先頭の64バイトだけを読む。
- 40桁の版として読めて、self cloneにあるコミットのときだけ使う。
- 条件に合わなければ、通知を解決しない。

残るリスクは次のとおりである。

- defaultのworkerのジョブは、印を偽造できる。偽の印で、`host_action_required`を黙らせられる。影響は、ホストでの反映の遅れに気づけなくなるところまでである。突くには、defaultのworkerでのコード実行が要る。
- ホストの書き込み(`docker compose exec`)は、ジョブと同じ権限で動く。
  同じディレクトリに、`mktemp`のランダムな名前の一時ファイルを排他的に作って書き、`mv -fT`で置き換える。
  印のパスがsymlinkでも、その先は上書きされず、置き換わるのはsymlink自体である。
  印のパスがディレクトリのときは、中へ移さず失敗し、一時ファイルを消す。その場合、記録は警告で終わる。
  一時ファイルの名前は予測できないので、ジョブがFIFOなどを先回りして置くことはできない。
  それでも止まらないよう、書き込みは`timeout 10`で包む。
  ホストのスクリプトが得る権限はジョブと同じで、権限は広がらない。

## シークレットの扱い

### Windmillでの保持

Windmillで実行する間、秘密値はWindmillのsecret変数に置く。

- `f/factory/claude_oauth_token`
- `f/factory/github_token`
- `f/factory/wmill_token`
- `f/factory/discord_webhook_url`

scriptは`wmill.getVariable()`で値を取得し、子プロセスの環境変数(`GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`など)としてだけ渡す。URLのクエリとパス、ログ、Data Tableの列、Discordの通知本文には出さない。
親プロセスが`fetch`で使う秘密値は、次の2か所である。

- Console用のworkerで動く`retry_work_item`は、`gh`を起動できないので、`github_token`を`fetch`の`Authorization`ヘッダに載せる。宛先は`https://api.github.com`に固定し、リダイレクトは辿らない。境界は[Console用workerの境界](#console用workerの境界)に書く。
- Discordへの送信(`lib/discord.ts`の`notify`)は、`discord_webhook_url`を`fetch`の宛先のURLにする。URLそのものが秘密なので、エラーメッセージとログには含めない。

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

有効期限は最長で1年である。`poll_issues`は冒頭で`GET /user`を呼び、トークンが失効していればジョブを失敗させる。
失敗はスケジュールの失敗ハンドラ(`on_error_schedule`)が`job_failures`に記録し、Discordに`job_failed`として通知する。
直近3回の実行が続けて失敗すると、要対応の通知`schedule_failing`も残る。

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
仕組みの詳細は[Consoleの仕様](internals/console.md)にある。

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

- `main`へのマージは、承認0件のPRで済む。PRの必須チェックは通る必要があるが、人のレビューは強制されない。FactoryのPATが`main`へマージできるか、人の確認なしにマージできるかは確かめていない([mainの保護とリポジトリの公開](#mainの保護とリポジトリの公開))。そのため、マージされたコードは人のレビューを経ずに運用者のブラウザで動きうる。Consoleの変更のレビューは、Windmillの管理者権限を持つコードのレビューとして行う。
- CIの組み立ての途中で動くもの(miseが入れるbunなどのツール、Viteのプラグインなどの依存)が侵害されると、出力が改ざんされうる。`digest`とマニフェストが保証するのは、GitHubのCIが作ったものであることまでである。
- 信頼の境界は`console`ジョブだけでなく、`ci.yml`のすべてのジョブとそこで動くツールや依存に及ぶ。同じ実行のほかのジョブも、ランナーから取れるトークンで成果物`console-dist`を上げ直せるためである。成果物は`overwrite: true`で上げ、`console_fetcher`はその名前の`id`が最大の成果物を取り込む。
- draw.ioのビューアも、この成果物の差し替えの範囲に入る。ビューアは`console`ジョブが取得して、同じ成果物に入れるためである。
- `Sec-Fetch-Site`をブラウザが送るのは、信頼できるオリジン(localhostかHTTPS)のときだけである。`WM_BIND`を外向きにしてHTTPで公開すると、この防御は効かない。外向きにするならHTTPSで公開する。
- `Sec-Fetch-Site`の規則が効くのは`/api/*`だけである。`windmill_extra`の経路(`/ws/*`、`/ws_mp/*`、`/ws_debug/*`)には効かない。
- 共有の`assets/`には古い版のファイルも残る。その間は`script-src`で読み込めるので、XSSの足がかり(script gadget)に使われうる。
- Trusted TypesのReport-Onlyの方針には報告先が無い。違反はブラウザの開発者ツールのコンソールにしか出ない。
- `console_fetcher`の外への通信はnetworkでは絞れない。コードが侵害されれば、任意の宛先へ出られる。
- `console_egress`は通常のbridgeで、ホストのloopbackから切り離されない。既定の`WM_BIND=127.0.0.1`のままでも、`host.docker.internal`経由でホストのCaddy、つまりWindmillに届く(OrbStackで確認)。`WM_BIND`を外向きにすると、ホストのゲートウェイのIP経由でも届く。`console_fetcher`はWindmillの資格情報を持たないが、認証の要らない経路には届く。
- `CONSOLE_GITHUB_TOKEN`は、ホストのdockerを使える人には`docker inspect`で見える。
- 成果物を取りに行くリポジトリ`CONSOLE_GITHUB_REPO`は、コミットされた`mise.toml`にある。これを書き換える変更がマージされると、任意のpublicリポジトリの成果物を取り込みうる。`mise.toml`は保護パスで、マージは人が行うことで抑えている。ただしPATのマージ権限は未確認である。
- 成果物の保持は30日である。30日以上`main`へのpushが無いと、新しく立ち上げた環境は取り込めない。そのときは`main`に何かをマージしてCIを動かす。

## workerコンテナの権限

workerは`privileged`にせず、`FAVOR_UNSHARE_PID`も有効にしない。Windmillの公式の構成は、ジョブを隔離するためにこれらを使うことがある。このworkerは信頼できないIssueを読むheadless Claudeを実行するので、侵害されたときにホストへ波及する範囲を小さくすることを優先する。

ジョブ間の隔離は、追加の特権に頼らず、工程ごとのツールの制限と読み取り専用の方針で確保する。

workerには`no-new-privileges:true`と、プロセス数の上限(`deploy.resources.limits.pids`)を設定する。`cap_drop`によるケーパビリティの削減と、rootでないユーザーでの実行はしない。ベースのWindmill公式イメージがrootでの実行を前提にしているためである。

workerのPATHには、rootのホームの`/root/.local/bin`と、誰でも書き込める`/tmp`の下の`/tmp/.local/bin`を入れない。
ベースのイメージのPATHは、この2つを含む。
`/tmp/.local/bin`は、Windmillの`windmill`の実行ファイルに参照が無く、稼働中のworkerにも存在しない。
非特権のuidがそこに`git`などを置くと、rootのworkerの名前解決を奪えるため、外している。
`claude`は`/usr/local/bin`のsymlinkから名前で起動する。

イメージには、固定のuid 10001のユーザー`factory-check`を作ってある。
`useradd -M`でホームのディレクトリは作らず、passwdに記録されるホームのパスも実在しない。
`HOME`は、このuidで何かを動かす側が、書き込めるディレクトリを渡す。
ログインシェルは使えない。
uidの切り替えに使う`setpriv`と、残ったプロセスを止める`pkill`も入っている。
検査コマンドを含め、このuidで動く処理はまだ無い。
検査コマンドは、[検査コマンドはフローが実行する](#検査コマンドはフローが実行する)のとおりrootで動く。

`factory-check`で何かを動かす前に、次を満たす。

- `/tmp/windmill`の下は、`cache`などが誰でも書き込めるディレクトリ(0777)である。
  rootのworkerが実行する依存のバンドルを、`factory-check`が差し替えられないよう、書き込めない状態にする。
- main cloneとworktreeの`.git`(`config`、`hooks/`、`info/attributes`)を、`factory-check`が書き換えられないようにする。
  検査の前後でハッシュを比べる方法は、別のジョブが`git worktree add`で`.git/config`に追跡の設定を書くため、正規の操作で誤検知する。
- `/var/lib/factory`の下で、`factory-check`が読めるものを確かめる。
  `claude`、`requirements`、`audits`のディレクトリは0755で、一覧を読める。

## Console用workerの境界

Console用のworker(`windmill_worker_console`)は、Consoleの問い合わせと操作の受付だけを処理する。
信頼できないIssueを読むClaudeは、このworkerでは動かさない。
このworkerの境界が守るのは、ファイルシステムだけである。
以下で「ボリューム全体」と書くのは、`factory_state`の最上位を指す。`claude`、`gh`、`audits`、`requirements`などが並ぶ層である。
絞り方は次のとおりである。

| 項目 | 設定 |
| --- | --- |
| 書き込めるマウント | `worker_logs`と専用の依存キャッシュ`worker_console_dependency_cache`だけである。`worker_logs`は、`windmill_server`、defaultのworker、nativeのworkerとも共有する書き込みのマウントである |
| `factory_state` | ボリューム全体はマウントしない。サブパス`requirements`だけを、同じパス(`/var/lib/factory/requirements`)に読み取り専用でマウントする。Claude Codeとghの設定は、ボリューム全体の直下にあるので届かない |
| `factory_console` | 読み取り専用でマウントする |
| `factory_workspaces` | マウントしない。対象リポジトリのチェックアウトに届かない |
| `worker_dependency_cache` | 共有しない。Console用のworkerは専用のボリュームを使うので、defaultのworkerと依存のキャッシュを通して影響し合わない |
| `docker.sock` | マウントしない |
| 権限 | `privileged`にしない。`no-new-privileges:true`と`init`を設定し、プロセス数は256、メモリは1024Mに絞る |

`requirements`を読めるのは、要件定義書と図のファイルを返すためである。
監査レポートは本文をDBから読むので、`audits`はマウントしない。
`factory_console`は配信中のJSの置き場所なので、書き込みでマウントしない。
読み取り専用で付けるのは、取り込みの失敗を見張るscriptが`status.json`を読むためである。

サブパスのマウントは、ディレクトリが無いとコンテナが起動しない。
1回限りのサービス`factory_state_init`が、起動の前に`requirements`を作る。
このサービスは`factory_state`を書き込みでマウントするが、ネットワークを持たず、権限もすべて落とし、固定の短いシェルのコマンドだけを実行して終わる。
`requirements`がsymlinkならディレクトリを作らずに失敗で終わり、そうでなければ`mkdir -p -m 0755`を実行する。
defaultのworkerで動くものが置いたsymlinkの先を、Console用のworkerにマウントさせないためである。
`requirements`がsymlinkだと`factory_state_init`が失敗し、`mise run deploy`は`wmill sync push`とmigrationの前で止まる。

`volume.subpath`は、古いEngineでは気づかないうちに無視され、`factory_state`のボリューム全体がマウントされうる。
そのため、スタックを起動するmiseのタスク(`up`、`deploy`)は、起動の前にEngineが26.0(API 1.45)以上、Composeが2.26.0以上かを確かめ、満たさなければ止まる。
この強制が止めるのは、`mise run up`と`mise run deploy`を通した起動だけである。
`mise exec -- docker compose ... up`を直接実行した場合や、restart policyによる再起動は止めない。
`doctor`は同じ検査に加えて、起動中のConsole用workerの中から、`factory_state`のボリューム全体がマウントされている証拠が見えないことを確かめる。
証拠は、`/var/lib/factory`の直下の`claude`、`gh`、`audits`と、`requirements/requirements`である。
対象リポジトリのowner名が`requirements`だと、サブパスだけが付いていても`requirements/requirements`が見える。
そのため、この証拠だけではボリューム全体のマウントを見分けられない。
Podmanは対象外である。

次のことは、この境界では守れない。

- DBには届く。`DATABASE_URL`はdefaultのworkerと同じ管理者の接続だからである。
- tag`console`のscriptは、管理者の`DATABASE_URL`か`wmill.getVariable()`で、Windmillのsecret変数を読める。
  読める変数には`f/factory/claude_oauth_token`と`f/factory/github_token`がある。
  `retry_work_item`が実際に読むのは、取り消された作業項目の再開のときの`github_token`だけである。
  マウントの制限で守るのは、Claude Codeとghの設定と履歴のファイルだけである。
  トークンそのものは守らない。
- scriptを編集できる者は、tagを付けずにdefaultのworkerで動かせば、`factory_state`のボリューム全体を読み書きできる。
- 要件定義書と図は読める。Consoleが表示するのと同じ内容である。
- このworkerで動かすのはリポジトリのscriptの想定だが、これを強制する仕組みは無い。ワークスペースでscriptを編集できる者は、任意のscriptにtag`console`を付けられる。
  tag`console`を付けたscriptは、`requirements`の下を読める。書けるのはdefaultのworkerだけである。
- composeの環境変数`WORKER_TAGS`は既定値である。DBにワーカーグループの設定があると、そちらが実効になる。変化はWindmillの画面の「Workers」で確かめる。
- `factory_state_init`の確認の後にも隙がある。
  Console用のworkerは、`factory_state_init`を経ない起動のたびに、サブパスを解決し直す。
  契機は、restart policy、Dockerデーモンの再起動、ホストの再起動、手動の`docker compose restart windmill_worker_console`である。
  その前にdefaultのworkerが`requirements`をsymlinkに置き換えると、symlinkの先がマウントされうる。
  隙は、`factory_state_init`を経ずにworkerが起動するたびに開く。
  誤ったマウントは、symlinkを消してworkerを起動し直すまで残る。`mise run up`は、設定の変わらない、動いているworkerを作り直さないためである。
  `mise run up`が`factory_state_init`の失敗で止まったときは、その時点のworkerのマウントを疑う。
  [Console用workerを確かめる](operations.md#console用workerを確かめる)の手順でsymlinkを消し、workerを作り直す。
  突くにはdefaultのworkerでのコード実行が要る。その権限があれば`factory_state`のボリューム全体を直接読めるので、実害は増えない。

## 自己更新の依存インストール

`self_update`は、Consoleのraw appの依存を`npm ci --ignore-scripts`で入れる。
依存のinstall scriptは、workerの権限のまま、ネットワークにも出られる状態で動くためである。

- `wmill sync push`がraw appを組み立てるときに動かすnpmには、`--ignore-scripts`が効かない。そのため、`wmill`のサブプロセスの環境変数に`NPM_CONFIG_IGNORE_SCRIPTS=true`を渡す。
- ホストで動かすmiseのタスク(`mise run push`、`mise run deploy`など)も、`npm ci --ignore-scripts`とこの環境変数を使う。
- raw appの`package-lock.json`には、install scriptを要する依存(`hasInstallScript`)が無い。そのような依存を足すと、コントラクトテスト(`tests/lib/self_update_support.test.ts`)が落ちる。足す前に、install scriptなしで組み立てが通るかを確かめる。

## 自己更新の打ち切り

`self_update`のジョブには、全体の上限がある。
値と内訳は[アーキテクチャ](architecture.md)の「自己更新」にある。
通常は、各コマンドの上限と、区切ったSDK・DBの呼び出しの上限(30秒)で先に終わる。
全体の上限は、それでも止まったときの最後の砦である。

残るリスクは次のとおりである。

- Windmillが全体の上限でジョブを打ち切るときに、子プロセスが止まるかを確かめていない。
  子(`npm ci`、`wmill sync push`、`wmill datatable migrate up`、git)は別のセッションで起動する。
  子の上限はworkerの中のタイマーなので、ジョブごと止まると子は上限なしで残りうる。
- 残った`wmill sync push`が、次の回が更新する作業ツリーを読み続けると、新旧の混ざった内容をpushしうる。
  作業ツリーのロックは、cloneの更新の間しか取らず、pushの間は守らない。
- 残った`wmill datatable migrate up`が、次の回の同じ処理と並行しうる。
- 打ち切りが子の実行中に当たるのは、内側の上限が働く前に全体の上限に達したときだけである。
  区切った呼び出しが30秒で終わるので、通常は当たらない。
- 残ったプロセスの見つけ方と、打ち切りが子を止めるかの確かめ方は[運用](operations.md)の「自己更新の打ち切りを確かめる」にある。

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

## draw.ioの図の描画

要件定義の図(`<name>.drawio`)は、生のXMLとして、要件定義のファイルと同じworker専用のディレクトリ(`requirement_drafts.doc_dir`の下)に書く。DBの`requirement_drafts.diagrams`列には、`{name, file}`の参照だけを入れる。図の内容とURLは、GitHubのIssueとPRのコメントにも、Discordの通知にも投稿しない。

Consoleは、`f/factory/steps/console_query.ts`の`requirements_doc`ビューで、`requirements.md`と各図のファイルを読み戻す。読む前に、`doc_dir`が`REQUIREMENTS_BASE_DIR`の下にあることを確かめる。図のXMLはWindmillのジョブ結果としてConsoleのフロントエンドに渡るだけで、GitHubとDiscordには送らない。

図のXMLは、`f/factory/lib/drawio.ts`の`validateDrawioXml`で検査する。
検査は2か所でかける。生成の時点と、`requirements_doc`ビューがディスクから読み戻す時点である。
ディスクのファイルは生成の後に書き換わりうるので、読み戻す時点でも同じ検査をかける。
読み戻しで通らない図は、ファイル名が不正な図と同じように、警告のログを残して一覧から落とす。
検査が例外で終わった図も、通らない図として扱い、警告のログを残す。安全と確かめられない図は、表示しないほうを選ぶためである。
文書の本文と、ほかの図は返す。

検査は、大きさ、ルート要素に加えて、次のものを加工せずに拒否する。
拒否したときは`valid: false`と理由を返す。

- 圧縮した図。すべての`<diagram>`について、空白以外のテキストとCDATAを拒否する。`<mxfile>`の`compressed`属性の値が`true`のときも、引用符の種類を問わず拒否する。圧縮した図は中身が見えず、以降の検査を素通りするためである
- `link`属性と`usemap`属性
- `placeholders`属性と、`<mxfile>`の`vars`属性。理由は下にある
- 図の構造としての`<a>`、`<area>`、`<map>`、`<meta>`、`<iframe>`要素
- ラベルのHTMLの、パーサーによって読み方が分かれる構文。大文字小文字を区別しない。
  - `<!`で始まる構文(コメント、DOCTYPE、CDATA、偽のコメント)、`<?`、`</`の後ろが英字でない形
  - 中身をタグとして読まない要素。属性の有無を問わない。
    対象は`<textarea>`、`<title>`、`<xmp>`、`<noscript>`、`<noembed>`、`<noframes>`、`<plaintext>`、`<iframe>`、`<style>`、`<script>`である
  - 外来要素の`<svg>`と`<math>`
  - SVGのアニメーション要素: `<set>`、`<animate>`、`<animateMotion>`、`<animateTransform>`

  理由は、下の「ラベルのHTMLの読み方」にある。
- ラベルのHTMLの、属性付きの次の要素。属性付きとは、`名前=`の形の属性を持つことである。
  - リンク: `<a>`、`<area>`、`<map>`
  - ページ遷移: `<meta>`、`<base>`、`<link>`
  - 埋め込み: `<object>`、`<embed>`、`<frame>`、`<img>`、`<image>`、`<video>`、`<audio>`、`<source>`、`<use>`
  - 送信: `<form>`、`<input>`、`<button>`

  `<image>`は、HTMLのパーサーが`<img>`に置き換えるので、`<img>`と同じに扱う。
  `<iframe>`と`<svg>`は、上の読み方が分かれる構文として、属性の有無を問わず拒否する。
- ラベルのHTMLのタグの中のイベントハンドラ属性。`onclick=`のように、`on`と英字の名前に`=`が続く形である
- ラベルのHTMLの`usemap=`、`formaction=`、`srcdoc=`
- 構文が不正なXML。閉じていないコメント、CDATA、処理命令、タグ、引用符と、タグの引用符の外の`<`である。XML全体を前から1回だけ読み、読めない箇所があれば拒否する。正規表現の打ち切りで、手前までしか検査されずに通ることを防ぐためである

`Promise<Object>`、`List<Map>`、`Result<A, E>`のように、属性を持たない要素名だけの表記は通す。
型の書き方としてラベルに現れ、属性の無い要素は行き先も資源のURLも持てないためである。
`<A extends B = C>`のような表記は拒否することがある。要素名と同じ型引数の名前に`名前=`が続くと、属性付きの要素と見分けられないためである。

図のXMLを加工して取り除くと、図の見た目が変わり、ビューアの解釈との差が新しい抜け道にもなる。
そのため、取り除かずに拒否し、理由を生成のやり直しでClaudeに伝える。

属性の値とテキストは、XMLの実体参照(`&lt;a`、数値文字参照の`&#60;`と`&#x3c;`)を復号してから調べる。
ビューアは`html=1`のラベルをHTMLとして解釈するためである。
二重にエスケープした`&amp;lt;a`も、安全側に倒して復号し、拒否する。実際に何として読まれるかは追わない。
復号は5段までで、それでも変わり続ける値は調べきれないので拒否する。
`placeholders`属性は、どの要素にあっても値を問わず拒否する。`<mxfile>`の`vars`属性も拒否する。
`placeholders`を持つセルでは、draw.ioがラベルの`%名前%`を別の値に置き換える。
置き換える値は、祖先のセルの属性、ページの名前、`vars`に書いた値などである。
タグを置き換え元の値とラベルに分けて書けるので、置き換えた後のラベルを検査では確かめきれない。
要件定義の図には置き換えが要らないので、使うこと自体を拒否する。
要素と属性の名前は、大文字小文字を区別せずに比べる。
`link`と`usemap`は名前の完全一致だけを見るので、`linkTarget`のような別の属性や、ラベルの文章にあるだけの単語は拒否しない。
`<object>`は、draw.ioがセルを包む要素として正しい。構造としては許し、ラベルのHTMLの中の、属性付きのものだけを拒否する。

### ラベルのHTMLの読み方

検査は、ラベルのHTMLのタグを、引用符を読む走査で読む。
`<`に英字が続く開始タグと、`</`に英字が続く終了タグを、HTMLのパーサーと同じ規則で、引用符の外の`>`まで読む。
終了タグも読むのは、HTMLのパーサーが終了タグの属性の引用符も読むためである。
この走査で、イベントハンドラ属性と、属性付きの拒否する要素を探す。
タグの外の文章にある`one = 1`、`online = true`、`https://x/?online=1`は拒否しない。

パーサーによって読み方が分かれる構文を拒否するのは、検査とブラウザがタグを同じ位置で区切る入力だけを通すためである。
HTMLのパーサーは、コメントや`<textarea>`の内側をタグとして読まない。
検査がその内側の引用符を読むと、タグの終わりが検査とブラウザでずれ、本物のタグのハンドラを見逃す。
`<svg>`と`<math>`の内側は、CDATAを読むなど、別の規則で読まれる。
これらの構文が無いラベルでは、ブラウザはタグの外を常に同じ規則で読み、引用符を読む走査と同じ位置でタグを区切る。
SVGのアニメーション要素は、`href`などの属性を後から書き換えてリンクを作れるので、`<svg>`の外にあっても拒否する。

要素名は、後ろに空白、`/`、`>`、文字列の終わりが続くときだけ当てる。
HTMLのパーサーは、それ以外の文字を要素名の続きとして読むので、`Map<Settings>`や`List<Titles>`は通す。
`<title>`は、属性が無くても拒否する。
属性の無い`<title>`でも、閉じるまでの内側をタグとして読まない状態に入るためである。
`Map<title>`のような型の表記は拒否されるので、型の名前を変えるか、文章で書く。
`a < b`のように`<`の後ろが英字でない形は通す。
`x </ y`のように`</`の後ろが英字でない形は、HTMLのパーサーが偽のコメントとして読むので拒否する。

補助として、引用符を読まない走査も行う。
`<`に英字が続く箇所から次の`>`までの区間を、引用符を無視してタグとして調べ、イベントハンドラ属性があれば拒否する。
属性付きの要素も、要素名の後ろから最初の`>`までに`名前=`があれば拒否する。
引用符を読む走査とブラウザで読み方の分かれる入力が、まだ残っていたときに備えるためである。
引用符の中の`>`で区間が切れるので、補助の走査だけでは足りない。

どの走査も、調べ終えた位置の後ろから次を探すので、検査の時間は入力の長さに比例する。
この検査は1層目である。
2層目は、iframeのCSPである。
`script-src`に`'unsafe-inline'`が無いので、検査をすり抜けたハンドラも実行されない。

### 隔離したiframeで描く

ConsoleのSPAは、図を最上位のページでは描かず、隔離したiframeの中で描く。
図のXMLはIssue本文に由来する信用できない入力で、ビューアは第三者の大きなコードだからである。
最上位のページで描くと、ビューアの欠陥が、Windmillを管理者として操作できるXSSになる。
実装は`console/src/components/drawio/DrawioFrame.tsx`と、`console/public/drawio.html`である。
`DrawioFrame`はどの画面にも組み込まれていない。Consoleの画面で図を描くのは、Windmillのraw app(Factory Console)のコンポーネントである。
仕組みは[Consoleの配信の仕様](internals/console.md)の「draw.ioの図」にある。

| 守ること | 内容 |
| --- | --- |
| ビューアを同梱する | CDNからは読まない。CIが、版を固定したURLからビューアを取得し、固定のsha256と照合してから、配信物の`drawio/`に置く。照合に失敗すると、CIが止まる |
| 本体から読めない場所に置く | ビューアと受け口は、Console本体のscriptの置き場所`/console/assets/`ではなく`/console/drawio/`に置く。本体のCSPは`/console/assets/`だけを許すので、本体にHTMLが注入されても、信頼されたオリジンでビューアを動かせない |
| 取得元を固定する | 固定する値は`console/drawio-viewer.json`にある。URLはbranchやtagではなくcommitを指す。この固定ファイルと、固定を強制するスクリプトは保護パスで、人のレビューを経ずには変えられない |
| 不透明なオリジンで動かす | iframeの`sandbox`は`allow-scripts`だけにする。`allow-same-origin`が無いので、iframeはCookieにも、Windmillにも、親のDOMにも届かない。ポップアップと最上位のページの遷移も許さない。`/console/drawio.html`のCSPにも`sandbox allow-scripts`を付け、ページを直接開いても不透明なオリジンで動かす |
| 外への取得をCSPで止める | `/console/drawio.html`だけに、別のCSPを付ける。scriptは`/console/drawio/`の同梱のファイル(ビューアと受け口)に限り、`connect-src`、画像、フォント、フォームの送信先は外を許さない。XMLが外部の画像やフォントを指していても、取得されない |
| XMLを1回だけ送る | 親は、XMLごとにiframeを作り直す。1つのiframeに送るのは、最初のloadの後の1回だけである。2回目のloadは、iframeが別の文書へ遷移したことを表す。親はiframeを`about:blank`にして表示を止め、以後そのiframeのメッセージを受けない。遷移した先へ、次のXMLは渡らない。この停止は最善の努力で、loadが起きない遷移は止められない。その場合も、親が受ける値は、数値と固定の失敗の種類だけである |
| メッセージを絞る | iframeは、親のwindowからの描画の依頼を最初の1回だけ受ける。親は、iframeのwindowからの高さと失敗の種類(固定の3つ)だけを受け、高さは数値に絞って80〜1600pxに収める。256KBを超えるXMLは送らない |
| リンクを開かない | ツールバー、lightbox、図のリンクを無効にする。ページ内のクリックとauxclickの既定の動作は、押された要素を問わず止める |

固定するsha256は、commit固定のURLから取得したバイト列の値である。
版を上げるときは、新しいcommitのURLから同じ手順で取り直す。
手順は[Consoleの配信の仕様](internals/console.md)の「draw.ioの図」にある。

XMLをiframeへ送るときの`targetOrigin`は`"*"`にする。
不透明なオリジンには、送り先のオリジンを指定する方法が他に無いためである。
送るのは図のXMLだけなので、宛先を絞れなくても許容する。

サーバー側で図の`link`属性と`html=1`を落とす処理は入れない。
`validateDrawioXml`は1層目として、リンクを含む図のうち既知の形を拒否する。網羅はしない。
すり抜けた図は、2層目のCSP、sandbox、受け口のscriptとビューアの設定が受け止める。
iframeの中で動くscriptが取れるのは、そのiframeが受け取った図のXMLだけで、リンクを押せず、外への取得はCSPが止める。
`html=1`を落とすと、`<br>`による改行のような正しい図が壊れる。

残るリスクは次のとおりである。

- ビューアの欠陥でiframeの中でscriptが動くと、iframe自身を別のURLへ遷移させ、受け取ったXMLをURLに載せて外のサーバーへ送れる。CSPは、ページの遷移を止められない。
  送った1回のXMLは外へ出せる。
  次のXMLを渡さないので、被害は、そのiframeが受け取った図1枚に限る。
  CookieとWindmillの資格情報には届かない。
- `'unsafe-eval'`は許さない。根拠は、固定した版(32.4.1)のビューアの調査と、ヘッドレスのChromeでの確認である。
  - ビューアが`eval`を呼ぶ箇所は2つある。図のスタイルや定義に書かれた式を評価する経路は、評価を許すフラグがどれも既定で無効である。外部の図形ライブラリのscriptを取得して評価する経路は、取得をCSPの`connect-src 'none'`が止める。`new Function`は無い。
  - `'unsafe-eval'`を付けずに、普通の図と、リンク、外部の画像、フォント、図形ライブラリ、評価を許す式を含む図を描いた。`eval`の違反は出なかった。
- 外部の図形ライブラリ(AWSなどのアイコン集)を使う図は、その図形が描かれない。外部への取得をCSPが止めるためである。

### 旧Consoleのraw appで描く

Windmillのraw app(Factory Console)も、図をWindmillのオリジンで直接は描かない。
`components/DrawioViewer.tsx`が、隔離したiframeの中で描く。
ビューアの欠陥が、管理者としてWindmillを操作できるXSSになるのを防ぐためである。
ビューアはWindmillのオリジンでは動かず、iframeの中でだけ動く。
iframeの`src`は、SPAのConsoleが配信する`/console/drawio.html`である。
そのページの同梱のビューア、受け口のscript、HTTPのCSPは、上の表のとおりで、raw appは別のビューアも別のCSPも持たない。
raw appがsandboxなしでWindmillと同じオリジンで動くなら、`/console/`も同じサイトなので、`frame-ancestors`に一致して読み込めるはずである。
ただし、実機で確かめるまでは前提として扱う。
管理スキルの`.claude/skills/raw-app/SKILL.md`に、バンドルが不透明なオリジンから動くという記述があり、この前提に反するためである。
読み込めない場合は、隔離なしの描画には戻らず、図の代わりに「図のページが応答しませんでした」と出す。
図を描けなくなる側に倒れるので、安全側である。

| 守ること | 内容 |
| --- | --- |
| 不透明なオリジンで動かす | `<iframe src="/console/drawio.html" sandbox="allow-scripts" referrerPolicy="no-referrer">`にする。`srcDoc`は使わない。`allow-same-origin`、`allow-popups`、`allow-forms`、`allow-top-navigation`は付けない。iframeは、WindmillのCookie、親のDOM、最上位のページの遷移、ポップアップ、フォームの送信から切り離される。外への取得は、CSPの`connect-src 'none'`が止める |
| SPAと同じ値を使う | `src`とsandboxは、`lib/drawioMessages.ts`の`DRAWIO_FRAME_SRC`と`DRAWIO_FRAME_SANDBOX`から使う。`DRAWIO_FRAME_SRC`と`MAX_XML_BYTES`は、`console/src/lib/drawioMessages.ts`と同じ値にする。メッセージの種別と失敗の種類は、`console/public/drawio/drawio-frame-*.js`と同じにする。`tests/lib/drawio_raw_app_isolation.test.ts`が、ソースを文字列として読んで確かめる |
| XMLは1回だけ渡す | 最初のloadの後にpostMessageで1回だけ送る。親は、送り元がそのiframeの`contentWindow`のものだけを受け取り、高さを80〜1600の範囲に収め、失敗は固定の3つの種類だけを受ける。iframeが2回目のloadを起こしたら、遷移とみなして表示を止める |
| 図を拒否する | 上の`validateDrawioXml`が、生成の時点と読み戻しの時点で、リンク、危険な要素、圧縮した図を拒否する |
| 取り違えを防ぐ | 図は枠で囲み、「Issueから生成した図」と明記する。図が承認画面を偽った表示をしても、読み手が取り違えにくくするためである |

読み戻しで拒否した図は、`requirements_doc`ビューが名前を`rejected_diagrams`で返す。
本文は、その名前の図を「安全の検査を通らなかったので表示しません」と表示し、図が見つからない場合と区別する。

読み戻しの検査は、すでにディスクにある図にもかかる。検査を通らない図は表示しない。
`link`属性や`<a>`を含む既存の図は、「表示しません」になる。
承認する人は、図を見ないまま判断することになる。
図が判断に要るときは、要件定義の作り直しを求める。

#### sandboxが止められない経路

`sandbox`は、iframeの`window.top.postMessage`と`window.parent.postMessage`を止められない。
旧Consoleでは、図のiframeのscriptが、WindmillのSPAとraw appのメッセージの通り道に届く。
raw appの`backend.*`の呼び出しは、メッセージを通してWindmillのSPAが受けて実行し、応答をraw appのリスナーが受ける。
図のscriptがこの通り道へ送ったメッセージが、`backend.*`の呼び出しや応答として扱われると、sandboxの隔離は意味を失う。
そのため、次の2つが`event.source`を確かめて、自分が送った相手以外のメッセージを捨てていることが前提になる。

- WindmillのSPA。raw appの`backend.*`の呼び出しを受ける側
- raw app内の、応答を受けるリスナー

この前提は、Windmill 1.817.0のコードと実機で確かめる必要がある。
このリポジトリで読めるのは、次の2点までである。

- 図の部品(`DrawioViewer.tsx`)が`event.source`を確かめること
- `windmill-client`の1.817.0に`message`のリスナーが無いこと

Windmill本体の画面と、raw appの実行時に注入される応答のリスナーは、このリポジトリに無く、`event.source`を確かめているかは未確認である。
`mise.toml`の`WM_VERSION`を上げるたびに、確かめ直す。

SPAのConsoleには、この経路が無い。
親のページは、iframeから高さと失敗の種類だけを受け、Windmillの`backend.*`のメッセージの通り道を持たないためである。

#### 保護パス

次のファイルは、保護パスである。

- `DrawioViewer.tsx`
- `lib/drawioMessages.ts`
- `lib/drawioFrameState.ts`
- `tests/lib/drawio_raw_app_isolation.test.ts`

書き換えられると、sandboxを外したり、別のページをiframeに読ませたりできるためである。
iframeへ送るXMLと、受ける応答の扱いも変えられる。
保護したファイルが主に守るのは、iframeの`src`と、送るXMLの扱いである。

`components/Markdown.tsx`は保護しない。
旧Consoleの普段の変更を、保護パスで止めないためである。
`sandbox`は、HTTPのCSP(`infra/Caddyfile`の`drawio_headers`)も後ろ盾になる。
別の部品が`/console/drawio.html`をsandboxなしのiframeで読む迂回は、CSPの`sandbox allow-scripts`が、ページを不透明なオリジンに固定して止める。
`frame-ancestors`は、埋め込める親を、このサイトと同じオリジンのページに限る。

制約は次のとおりである。

- SPAのConsoleが配信されていないと、`/console/drawio.html`が無く、図は描かれない。親は、応答がないものとして固定の文を出す。
- 外部の図形ライブラリ(AWSなどのアイコン集)と、ビューアのtoolbar、ズーム、レイヤは使えない。

残るリスクは次のとおりである。

- ビューアがiframeの中で`window.location`を書き換えて遷移する経路は、`sandbox`で防げない。2回目のloadの検知で表示を止めるが、loadが起きない遷移は検知できない。そのときも、親が受け取るのは、範囲に収めた高さと、固定の失敗の種類だけである。
- 図のiframeが`window.top.postMessage`と`window.parent.postMessage`で、WindmillのSPAとraw appのメッセージの通り道に届く。上のとおり、Windmill本体の画面とraw appの応答のリスナーが`event.source`を確かめているかは、未確認である。`WM_VERSION`を上げるたびに確かめ直す。確かめていない版では、この経路を塞げているとは言えない。
  それでも受け入れる理由は、この隔離が新しい経路を作らないためである。
  届くには、ビューアの欠陥、検査のすり抜け、送り元を確かめないリスナーの3つが揃う必要がある。
  ビューアをWindmillのオリジンで直接動かす構成なら、より広く届く。
- ラベルの`%名前%`を別の値に置き換える`placeholders`と`vars`は、検査が拒否する。
  draw.ioが別の属性でも同じ置き換えをするようになると、検査はその図を拒否できない。
  その図は、iframeの隔離とCSPで止める。

実機でしか確かめられない点は次のとおりである。

- raw appから`/console/drawio.html`をiframeで読めること。`frame-ancestors`が合わないと、図の代わりに応答なしの文が出る。
- raw appがsandboxなしで動くこと。管理スキルの`.claude/skills/raw-app/SKILL.md`は、バンドルが不透明なオリジンから動くと書いており、反する。
- raw appの文書が`srcdoc`か`blob:`かで、相対パス`/console/drawio.html`が解決できるかが変わる。`blob:`だと解決できないおそれがある。
- 図が描かれ、高さが図に追従すること。
- リンクを含む図を描いても、クリックで遷移しないこと。
- 図のiframeから`window.top`と`window.parent`へ`backend.*`の呼び出しや応答の形のメッセージを送っても、実行されず、応答も奪われないこと。

## 要件定義書のリンク

要件定義書と監査レポートのMarkdownは、Issueの内容に由来する。
Windmillのraw appは、これをWindmillと同じオリジンで描く。
`rehype-sanitize`の既定のスキーマは`javascript:`などを除くが、任意の`http(s)`のURLの`a[href]`は通す。
そのため、読み手がリンクの文字を信じて、外のページを開くおそれがある。

`components/Markdown.tsx`は`a`を差し替え、`lib/markdownLink.ts`の`resolveMarkdownLink`で、リンクにするものを絞る。

- 作業項目と同じリポジトリのIssueとPRのURL。`lib/githubLink.ts`の`safeGitHubUrl`を通り、ownerとrepoが作業項目のものと一致するものに限る。ownerとrepoは、大文字小文字を区別せずに比べる。信頼できない本文が、読み手を別のリポジトリへ誘導できないようにするためである。
- 同じページの見出しへのフラグメント。`#`で始まり、`lib/extractHeadings.ts`の`slugify`が作るslugと同じ形に限る。

`Markdown`は、リポジトリを`repo`の引数で受ける。要件定義書(`RequirementsDocument`)と承認タブの提案は、作業項目のownerとrepoを渡す。
監査レポート(`AuditTab`)のように渡せない呼び出し元では、GitHubのURLもリンクにせず、文字で出す。
それ以外は、リンクにせず文字で出す。
リンクの文字とURLが違うときは、URLも括弧で添える。
読み手が行き先を判断できるようにするためである。
添えたURLは`<bdi>`で包む。文字の向きを変える制御文字が、周りの表示を崩さないようにするためである。
同じページの見出しへのリンクは、行き先を取り違えようがないので、URLを添えない。
GitHubへのリンクは、`rel="noopener noreferrer"`を付けて新しいタブで開く。

## 更新履歴のPR

Consoleの更新履歴は、反映に含まれるPRの題名と番号を出す。
FactoryのPRの題名は、信頼できないIssueに由来する。
題名は、マージのコミットの本文として`self_update`が読み、`deployments.pull_requests`に記録する。
そのため、記録から画面までの各段で、値の形を確かめ直す。

| 段 | 守ること |
| --- | --- |
| 取り出し | self cloneの`git log --first-parent`だけを読む。PRのブランチの中のコミットが、件名でマージのコミットを装えないようにするためである。件名`Merge pull request #<N> from <owner>/<branch>`は、親が2つ以上のコミットだけを読む |
| 取り出し | 題名は本文の1行目だけを取る。制御文字、書字方向の制御文字、幅の無い空白などの見えない書式文字、タグ文字を空白にし、200字で切る。ZWJとZWNJは、絵文字の列や一部の文字の題名が崩れるので残す。題名は表示だけに使い、承認の判断には使わない。この処理は`sanitizePullRequestTitle`で、読み出しでも同じものを通す |
| 取り出し | リンクは、Factoryのリポジトリから`https://github.com/<owner>/<repo>/pull/<N>`の形に組み立てる。GitHubのAPIは呼ばない。呼ぶと、Console用のworkerのネットワークとトークンの権限が広がる |
| 読み出し | `console_query`が、番号が正の整数であること、URLがPRのURLの形であること、題名を`sanitizePullRequestTitle`でもう一度通す(取り出しと同じ文字を空白にし、200字で切る)。形が違う要素は捨てる |
| 画面 | 題名は文字としてだけ描く。リンクにするのは、GitHubのPRのURLの形で、末尾の番号がPRの番号と一致するものだけである。それ以外は番号を文字で出す |

作り手のバッジは、確かな証明ではなく、ブランチの名前から決めた印である。
ownerがFactoryのリポジトリと同じで、ブランチが実装ブランチ(`factory/issue-<N>-wi-<id>`)のときだけ「Software Factory」にする。
同じ名前のブランチを作れるのは、リポジトリに書ける人だけである。forkのブランチは「人」になる。
マージの方式がsquashのPRと、Factoryのリポジトリを読めないときは、ブランチが確かめられないので「不明」にする。

mainに直接pushされたコミットも、件名の末尾が`(#<N>)`で親が1つなら、PRとして記録される。
記録は表示のための印で、PRの実在は確かめない。
mainのrulesetが直接pushを止めていることを前提にする。

## PR修正の安全策

PR修正のフロー(`pr_fix`)は、Claudeに書き込みのツールを与える。次の安全策で、信頼できないPRの内容やコメントから、Factoryの設定やworkerを書き換えられないようにする。仕組みの詳細は[PRワークフローの仕様](internals/pr-workflow.md)にある。

### Factory自身の投稿の判定

コメントがFactory自身の投稿かどうかは、投稿者がFactoryのGitHubアカウントであり、かつ本文にFactoryのマーカーがあるかで判定する。Factoryは人と同じGitHubアカウントで動くので、ログインだけでは人の投稿と区別できない。マーカーだけでは第三者が偽装できる。

この判定で除外するのは、Factory自身のPR修正の返信だけである。人のコメントと、Factoryの最初のレビューの指摘は、修正の依頼として扱う。

### ツールの制限

Claudeに渡すツールは`Read`、`Glob`、`Grep`、`Edit`、`Write`だけで、`Bash`は渡さない。`--restricted`でコード実行のツールとWebFetchを外し、ファイルのツールを作業ディレクトリに閉じる。ネットワークは遮断しない。

### 検査コマンドはフローが実行する

対象リポジトリのlintやテストは、Claudeではなくフローのステップが`factory_config`の`allowed_check_commands`を実行する。検査コマンドは対象リポジトリのコードをworkerの中でrootとして、隔離なしに実行する。そのため既定値は空の配列にし、空でなければ実行のたびに隔離していないことを知らせる記録(notice)を残す。
検査コマンドに渡す`PATH`は固定の`/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin`で、workerの`PATH`は引き継がない。
どのディレクトリもrootが所有し、非特権のuidは書き込めない。
rootのホームと`/tmp`の下は入れない。そこに置かれた実行ファイルを、名前の解決で拾わないようにするためである。

### 対象リポジトリの設定を信頼しない

対象リポジトリの`mise.toml`や`package.json`のscriptsは、信頼できない入力として扱う。workerのmiseは対象リポジトリの`mise.toml`を信頼しない。信頼が無いと動かない検査コマンドは実行せず、止めて報告する。

### 保護パスの変更を止める

保護パスを変更したら、修正を止める。保護パスは`.claude/`、`.agents/`、`mise.toml`、`lefthook.yml`、`.github/workflows/`、`package.json`のscripts、新しい`*.sh`などである。これらはFactoryやCIが実行する設定で、書き換えられるとコードを実行されるためである。
markdownlint-cli2とtextlintの設定(`.markdownlint-cli2.jsonc`、`.textlintrc.json`など)も止める。どちらも設定から任意のモジュールを読み込め、pre-commitと`mise run check`が読むためである。
Consoleでバンドルを通らずに配信される`console/public/`と`console/index.html`も止める。
配信するdraw.ioのビューアを固定する`console/drawio-viewer.json`も止める。
固定を強制し、配信物を作って検査するスクリプトも止める。
旧Consoleのraw appが図を隔離して描く部品(iframeを作る`DrawioViewer.tsx`、`src`とsandboxの定数、iframeとの状態の遷移、それらを照合するテスト)も止める。一覧は`f/factory/lib/protected_paths.ts`の`FORBIDDEN_EXACT_PATHS`にある。
CIがどのジョブを動かすかを決める`scripts/ci-scope.ts`も止める。書き換えられると、検査のジョブを飛ばされるためである。
配信のCSPを持つ`infra/Caddyfile`と、配信物を検証する`infra/console_fetcher/`も止める。
一覧は`f/factory/lib/protected_paths.ts`にある。

### symlinkと特殊なファイルを止める

symlinkの作成・変更・削除、入れ子のリポジトリ、`.git`という要素を含むパス、通常のファイルでないものがあれば止める。symlinkを通すと、作業ディレクトリの外のファイルを読み書きされるためである。変更の一覧は、引用符付きのパスや未追跡のディレクトリでも判定を素通りしない形で取得する。

### HEADとブランチの確認

変更を調べる前に、worktreeのHEADとブランチが、準備のときに見たPRのものと同じかを確かめる。検査コマンドがcommitやブランチの切り替えをすると、その変更が差分から消えて検査を素通りするためである。

### worktreeの.gitファイルの書き換えを止める

worktreeの`.git`ファイルは、準備のときに検証して中身を記録する。以降、Claudeを起動する前とgitを実行する前に、記録と一致することを確かめる。参照先を別のディレクトリに向けられると、そこのconfigの設定を次のgitがrootで実行するためである。この安全策は実装のフローでも同じように働く。

### gitが読む設定を限る

`f/factory/lib/workspace.ts`と`f/factory/steps/pr_workflow_support.ts`が実行するgitは、読む設定を同じ方法で限る。
どちらも`workspace.ts`の`buildGitArgv`と`localGitEnv`を使う。

システムとグローバルの設定は、環境変数`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_SYSTEM`、`GIT_CONFIG_GLOBAL`、`GIT_ATTR_NOSYSTEM`で読ませない。
workerのホストの設定が、検証の前提を変えないためである。
コミットのauthorは環境変数で、認証は`GH_TOKEN`で渡すので、これらの設定は要らない。
workerのイメージは、グローバルのgit設定もgtrのグローバル設定も持たない。
HOMEは、ghなどの子プロセスと、gitの`~`の展開(`.git/config`のパスの`~`、httpsの`$HOME/.netrc`)のために渡す。
workerのHOMEには`.netrc`を置かない。イメージにも置いていない。
`safe.directory`は設定しない。
workerとcloneはどちらもrootで動き、`/workspaces`のボリュームの所有者が同じになるためである。
Dockerfileとworkerの`docker-compose.yml`に、`USER`と`user:`の指定は無い。

転送はhttpsだけを許す。環境変数`GIT_ALLOW_PROTOCOL`を`https`にする。
`.git/config`に`protocol.ext.allow=always`と`ext::`のremoteを書かれると、`GH_TOKEN`を持つ環境でコマンドを実行されうる。
この環境変数は`protocol.*`の設定より優先されるので、設定ファイルでは許可を広げられない。
対象のremoteはhttpsだけなので、fileやsshは使えなくてよい。

main cloneの`.git/config`は、gitがremoteやブランチの設定を読むので、読ませないことはできない。
`extensions.worktreeConfig`が有効なときは、worktreeごとの`config.worktree`も読まれる。
どちらも検査コマンドが書き換えられ、`-c`では`config.worktree`の読み込みを止められない。
そこで、プログラムの実行と検証の前提に関わる設定を、コマンドラインの`-c`で固定する。
`-c`はどの設定ファイルよりも優先されるので、設定ファイルに別の値を書かれても効かない。
`git gtr`の子のgitにも、環境変数`GIT_CONFIG_PARAMETERS`を通して渡る。

| 設定 | 固定する値 | 防ぐこと |
| --- | --- | --- |
| `core.hooksPath` | `/dev/null` | 設定のフックの実行 |
| `core.fsmonitor` | `false` | 設定のfsmonitorのヘルパーの実行 |
| `core.askPass` | 空 | 設定のaskpassのプログラムの実行 |
| `commit.gpgsign` | `false` | commitの署名で`gpg.program`を実行させること |
| `push.gpgSign` | `false` | pushの署名で`gpg.program`を実行させること |
| `core.symlinks` | `false` | symlinkの検出が前提にする値の巻き戻し |
| `core.excludesFile` | `/dev/null` | `$HOME/.config/git/ignore`の読み込み |
| `core.attributesFile` | `/dev/null` | `$HOME/.config/git/attributes`の読み込み |
| `credential.helper` | 空 | 設定のcredential helperの実行。`credential.<URL>.helper`も一覧ごと消える |

`ignore`と`attributes`は設定ファイルではないので、`GIT_CONFIG_GLOBAL`では止まらない。
ネットワーク操作では、この後にghのcredential helperを加える。

`core.symlinks=false`はFactory自身のself cloneにも効く。
Factoryのリポジトリにsymlinkを足すと、self cloneでは普通のファイルになる。

固定していない設定は、そのまま読まれる。
`url.*.insteadOf`、`remote.*.pushurl`、`http.*`、`filter.*`、`diff.*`などは、キーが対象ごとに変わり、名前で固定できない。
名前が決まっていて、プログラムを実行できたり作業ツリーを変えたりする設定にも、固定していないものがある。
`core.alternateRefsCommand`は、`objects/info/alternates`があるcloneのfetchで、シェルから実行される。
`core.worktree`は、`config.worktree`に書くと、`status`、`clean`、`add -A`が見る作業ツリーを別のディレクトリに変える。
どちらも実際のgitで確かめた。
これらは残るリスクである。
`git gtr new`のcheckoutは`GH_TOKEN`を持つ環境で動く。
そのため、`.git/config`の`filter.<名前>.smudge`や`process`を、PRの内容の`.gitattributes`が指名すると、`GH_TOKEN`を読めるプログラムが動く。
根本の対処は、ネットワーク操作とcheckoutを分け、checkoutを`localGitEnv`で行うことである。
検査コマンドはworkerのrootとして隔離なしに動く([検査コマンドはフローが実行する](#検査コマンドはフローが実行する))。
そのため、`.git/config`を書き換えなくても、gitプロセスの環境変数を読むなど、同じことができる。
この隔離は、設定の誤動作への備えである。
根本の対処は、検査コマンドの実行ユーザーをgitの実行ユーザーと分けることである。

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

実装ブランチのpushとPRの作成で、対象リポジトリの`push`と`pull_request`のCIが動く。atelier-worksのCIはPRの作成から動く。Claudeの書いたコードは、人のレビューより前に、そのリポジトリのsecretsを使える状態で実行されうる。対象リポジトリのCIの権限とsecretsの範囲は、この前提で設定する。

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

publicのリポジトリで第三者がラベルを付けてパイプラインを起動するのを防ぐため、トリガーラベルを付けた人を確かめる。
対象は、Issueの`factory`ラベルと、PRの`factory:review`、`factory:fix`ラベルである。

GitHubでは、ラベルを付けるのにtriage以上の権限が要る。
一方、Issueフォームが自動で付けるラベルは、起票者の権限によらず付く。
そのため、Issueフォームにはトリガーラベルを設定せず、ラベルを付けた人をFactoryが確かめて、許可された人でなければ反応しない。

### 付与者の確認

`poll_issues`と`poll_prs`は、IssueとPRのラベルのイベントから、トリガーラベルの最後の`labeled`か`unlabeled`を探す。
イベントはGraphQLで、直近100件のラベルのイベントだけを読む。
コメントや参照のイベントは含まれない。
ラベルのイベントを増やせるのは、ラベルを付け外しできる権限を持つ人と、その権限で動く自動化だけである。
自動化は、第三者の入力に応じてラベルを付け外しするActionsやAppを指す。
最後のイベントは、並び順ではなく、作成時刻の最大で決める。
作成時刻は秒単位なので、同じ秒のイベントが複数あれば、順序を判定できないものとして拒否する。
同じ秒のイベントは時刻が変わらないので、時間が経っても判定できない。
許可された人がラベルを外して付け直すと、新しいイベントが最後になり、判定できる。
最後のイベントが`labeled`なら、その`actor`のログイン名を確かめる。
他のラベルのイベントは見ない。
ラベルが一度外されて付け直されていれば、最後のイベントが対象になる。
ラベル名は、GitHubと同じく大文字小文字を区別せずに比べる。

`labeled`イベントは`author_association`を持たない。
そのため、付与者はGitHubの関係(OWNERなど)ではなく、ログイン名で判定する。

許可するのは、次のアカウントである。
大文字小文字は区別しない。

- FactoryのPATのアカウント。
- `factory_config`の`allowed_labeler_logins`に挙げたアカウント。
  既定値は空である。

次のどれかのときは、判定できないものとして拒否する。
許可されたものだけが通るので、判定の失敗が拒否に倒れる。

- トリガーラベルの`labeled`イベントが無い。
- ラベルが付いているのに、最後のイベントが`unlabeled`である。
  イベントの反映が遅れていて、今の付与者を特定できない。
- 作成時刻が最大のイベントが、同じ秒に2件以上ある。
- イベントに`actor`が無い(削除されたユーザーなど)。
- `actor`が人のアカウント(`User`)でない。
  GitHub Appなどのログイン名は`[bot]`を伴わないため、人のログイン名と取り違えないようにする。
- イベントを取得できなかった。
  そのポーリングでは対象にせず、次のポーリングで取得し直す。
- FactoryのPATのアカウントを取得できなかった。
  ポーリングのジョブが失敗し、何も始めない。
- 直近100件のラベルのイベントにトリガーラベルのイベントが無く、それより古いイベントが残っている。
  読んだ範囲では付与者が分からない。

拒否したときは、ラベルを外さずに、noticeの`labeler_denied`を記録する。
本文は対象とラベルだけで決まり、同じ本文の未解決のnoticeがあるあいだは追加しない。
イベントの取得に失敗したときは、noticeを増やさず、**失敗**タブに記録する。
記録されるステップ名は、Issueが`fetch_labeler:<owner>/<repo>#<番号>`、PRが`fetch_pr:<owner>/<repo>#<番号>`である。

付与者を判定できないときは、失敗ではなく、noticeの`labeler_check_limit`を1回だけ記録する。
本文は対象とラベルだけで決まり、同じ本文の未解決のnoticeがあるあいだは追加しない。
次の操作として、ラベルを外し、許可された人が付け直すことを示す。
付け直すと、トリガーラベルの新しい`labeled`イベントが直近100件に入り、判定できるようになる。
人がラベルを外して付け直すまで、ポーリングのたびに同じ取得を繰り返す。
noticeは、対応した後にConsoleで解決する。

判定から取得までには時間差があるので、取得の直前に同じ確認をもう一度行う。
拒否されたときは、取得せずに`labeler_denied`を記録する。
取得できなかったときは、取得せず、**失敗**タブに`confirm_labeler:<owner>/<repo>#<番号>`として記録する。
このときラベルは外れていないので、操作は要らない。
次のポーリングが、自動で拾い直す。
ラベルを付け直すと、付与者がその人に変わる。
そのため、この失敗を理由にラベルを付け直さない。

許可するアカウントに、他人の入力に応じてラベルを付ける自動化のアカウントを入れない。
FactoryのPATを使う自動化も、入れない。
GitHub Appがオーナーの代理でラベルを付けると、`actor`はオーナーになる。
そのため、第三者の入力に応じてオーナーの権限でラベルを付けるAppやワークフローを、設定しない。
自動化が第三者の入力でラベルを付けると、付与者の確認が素通りになるためである。
`[bot]`で終わるログイン名は、設定の検証で拒否する。

許可はログイン名で判定する。
アカウント名を変更すると、他人が古い名前を取得できる場合がある。
名前を変えたアカウントは、`allowed_labeler_logins`から外す。

`factory`ラベルを付け直すと新しいサイクルが始まり、同じIssueの承認済みの作業項目は取り消される。
そのため、ラベルを付けられる人は、承認の取り消しも起こせる。
許可するアカウントを増やすときは、この影響も含めて決める。

許可されていない人の操作を運用者に見せるnotice(`labeler_denied`)は、運用者が確かめないまま解決済みになることがある。
このnoticeは重要度が「情報」なので、要対応の一覧には出ず、Consoleのシステム画面に7日だけ出る。
その間に、許可された人がラベルを付け直してIssueかPRを取得すると、同じ対象の未解決のnoticeが解決済みになる。
対象の範囲は[通知とrate limit](internals/notifications.md)にある。
解決しなかったnoticeも、作成から`retention_logs_days`(既定30日)を過ぎると、DBの掃除が解決済みにする。
どちらの場合も行は残り、解決の時刻から同じ期間の掃除までは、解決済みの履歴として読める。
許可されていない人は、取得の条件である最後のラベル付与者が許可された人であることを満たせない。
そのため、この解決を起こせない。
Consoleからは解決できない種類だが、人の介在を減らすため、この自動の解決を受け入れる。

### 確認しない経路

ラベルを介さずに始まるレビューは、付与者ではなくPRの作成者で確かめる。
対象は、次の2つである。

- PRのレビュー依頼かassigneeにFactoryのアカウントが入っているときのレビュー。
- 追跡中のPRに新しいcommitが入ったときの再レビュー。

どちらも、PRの作成者が許可されたアカウントのときに限る。
許可されるのは、FactoryのPATのアカウントと`allowed_labeler_logins`のアカウントである。
作成者を取得できないときは始めない。
Factoryが作ったPRの作成者はFactoryのPATのアカウントである。
そのため、Factory以外が追加したcommitで再レビューされる。

`factory:review`か`factory:fix`が、許可されていない人に付けられた状態で付いているPRでも、ラベルを介さないレビューは始めない。
ラベル名の大文字小文字がconfigと違っていても、同じラベルとして扱う。

同じリポジトリのブランチから出した第三者のPRは、許可されたアカウントがトリガーラベルを付けたときだけレビューされる。
新しいcommitが入るたびに、ラベルを付け直す必要がある。
自動の再レビューは起きない。
CODEOWNERSなどによるレビュー依頼も、作成者が許可されていなければ起動しない。

PRのheadが対象のリポジトリにないとき(forkのPRと、headのリポジトリを取得できないPR)は、許可されたアカウントがラベルを付けても、レビューを始めない。
forkの内容は第三者が書いたもので、信頼してレビューに渡せないためである。
見送ったときは、ラベルを外さず、noticeの`fork_head_denied`を記録する。

### 残るリスク

次のリスクは、受け入れている。

- 作成者が許可されたアカウントのPRに、書き込み権限のある共同作業者がpushすると、ラベル無しの再レビューが起動する。
  書き込み権限を持つ人は、信頼された共同作業者とみなす。
  Factory自身のpushは`setHeadSha`で記録されるので、起動しない。
- ラベルを付けた後から取得までの間に、起票者がIssueの本文を編集できる。
  承認前の本文が`work_items.body`に保存されるので、編集後の本文が要件定義の入力になる。
- 確認からラベルを外すまでの窓は数百ミリ秒である。
  付け直しを成功させるには、狙ったタイミングが要る。
- 書き込み権限のある人がラベルを改名すると、過去の付与が現在のトリガーラベルの付与として数えられる。
  書き込み権限を持つ人は、元から信頼する前提である。
- ラベルを付け外しできる権限で動く自動化が、第三者の入力に応じてイベントを積むと、判定不能が続く。
  判定不能は拒否に倒れるので、作業は始まらない。
- 拒否したトリガーラベルはPRに残る。
  人がラベルを外すまで、そのPRはラベルを介さないレビューの自動検出も止まる。
- Factory自身のPRで拒否したラベルのせいでサイクルが止まっても、気づく手段は「情報」のnoticeだけである。
  人がラベルを外すと、サイクルが再開する。

### 投稿者の関係の確認

PRのレビューとコメントは、投稿者で絞る。
許可する関係は`allowed_labeler_associations`で、既定値は`["OWNER", "MEMBER", "COLLABORATOR"]`である。
コメントとレビューの応答は`author_association`を持つので、この関係で判定できる。
これに当たらない投稿者のレビューコメントと新しいコメントは、`pr_review`と`pr_fix`の起動に使わない。

## 閉じた人の確認

`poll_issues`は、対象のIssueやPRが閉じられた作業項目を取り消し、Consoleの要対応の一覧から外す。
対象は、失敗、人の対応待ち、期限切れの作業項目である。
このとき、IssueまたはPRの取得の応答から、閉じた人を確かめる。
使うのは、`GET /repos/{owner}/{repo}/issues/{番号}`の次の項目である。

- `pull_request.merged_at`
- `closed_by`
- 作者(`user`)
- 作者の`author_association`

タイムラインの`closed`と`merged`のイベントには`author_association`が無いので、使わない。
判定は次の順に行う。ログイン名は大文字と小文字を区別せずに比べる。

| 順 | 状況 | 判定 |
| --- | --- | --- |
| 1 | PRで`merged_at`がある | 取り消す。マージにもmerge queueへの投入にも、write権限が要るため |
| 2 | `closed_by`が無い、またはログイン名が空 | 取り消さない |
| 3 | `closed_by`がBot(`type`が`Bot`、またはログイン名が`[bot]`で終わる) | 取り消さない。BotやActionsは、第三者のイベントを受けて閉じることがあるため |
| 4 | 作者が分からない | 取り消さない |
| 5 | 作者以外の人が閉じた | 取り消す。他人のIssueやPRを閉じるには、triage以上の権限が要るため |
| 6 | 作者が閉じ、作者の`author_association`が`allowed_labeler_associations`に含まれる | 取り消す |
| 7 | 作者が閉じ、作者の関係が含まれないか分からない | 取り消さない |

取り消さなかった対象は、一覧に残る。理由と対象は`poll_issues`のログにinfoで残す。

第三者が自分のIssueやPRを閉じて、安全策で止まった作業項目を一覧から消せないようにするためである。
publicのリポジトリでは、誰でもIssueを作れ、作者は自分のIssueやPRを閉じられる。
確認が無いと、安全策で止まった作業項目を、人が気づかないうちに一覧から外されてしまう。

この確認は、要対応の一覧から外す取り消しにだけかける。
取り消した作業項目は`retry_work_item`で再開できるので、権限のある人が元に戻せる。

残るリスクは次のとおり。

- PRのheadブランチやforkを消してPRが閉じたときの`closed_by`は、実機で確かめる。作者と別のアカウントが消すと、作者以外の人が閉じた扱いで取り消されうる。
- 人のアカウント(`type`が`User`)のPATで閉じる自動化は、Botとして扱われない。作者と別のアカウントなら、作者以外の人が閉じた扱いになり、取り消される。第三者のイベントで閉じる自動化は、`GITHUB_TOKEN`かGitHub Appのinstallation tokenで動かす。
- 判定は、要対応の一覧の取り消しにだけかかる。承認待ちなど終端でない作業項目は、既存のreconcileが閉じた人を確かめずに取り消す。
