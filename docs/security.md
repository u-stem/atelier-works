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

タグはrulesetの`protect-tags`で保護する。
対象はすべてのタグで、作成、更新、削除を禁止する。
迂回できるのは、リポジトリの管理者のロールだけで、常に迂回できる。
`main`という名前のタグの実行は、`main`のブランチの実行と見分けがつかない。
`protect-tags`は、このタグを経由してConsoleの配布物(`console-dist`)をすり替える経路を塞ぐ。
このリポジトリはタグを使わないので、運用には影響しない。
タグを使うようにするときは、rulesetを見直す。
設定の確認は[運用](operations.md)の「タグのrulesetを確かめる」にある。

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

`console-dist.yml`の既定の権限も、`contents: read`だけである。
ジョブは権限を足さない。
成果物の書き込みは、`GITHUB_TOKEN`の書き込み権限を使わず、ランナーの実行用の資格情報で行う。
`main`へのpushでだけ動かし、PRの実行では成果物を上げない。

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
親プロセスが`fetch`で使う秘密値は、次の3か所である。

- Console用のworkerで動く`retry_work_item`は、`gh`を起動できないので、`github_token`を`fetch`の`Authorization`ヘッダに載せる。使うのは、取り消された作業項目を再開するときの対象の状態の確認と、Issueの要件定義を作り直す再実行のときの取り込み内容の更新(現在のIssueの題名と本文の取得)である。宛先は`https://api.github.com`に固定し、リダイレクトは辿らない。境界は[Console用workerの境界](#console用workerの境界)に書く。
- Console用のworkerで動く`approval_decide`は、要件定義の承認の前に現在のIssueを読むため、同じ形で`github_token`を使う。10秒の締め切りを付け、エラーの文とログにトークンとIssueの内容を含めない。
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
| Repository permissions: Actions | Read-only |
| Repository permissions: Metadata | Read-only(IssuesかContentsを選ぶと自動で付く) |
| Repository permissions: Pull requests | Read and write |
| Repository permissions: Workflows | No access |
| Account permissions | すべてNo access |

ContentsをRead and writeにするのは、PR修正と実装のフローがブランチにpushするためである。WorkflowsはNo accessのままにする。`.github/workflows/`を含むpushをGitHubに拒否させるためである。実装フローは`.github/`の変更を止めずに記録するので、この拒否が実質のガードになる。
ただし、この拒否が及ぶのは`.github/workflows/`の下だけである。`.github/actions/`のcomposite actionには及ばないので、PR修正はパスで止め、実装フローは記録する。組み立てなど配布物に関わる手順は、composite actionに分けない。

ActionsをRead-onlyにするのは、`watch_main_ci`が対象リポジトリの既定のブランチのActionsの実行を読むためである。
書き込みの権限は付けない。実行の再実行や取り消しをさせないためである。
権限が足りないリポジトリは、`watch_main_ci`が要対応の通知`main_ci_check_denied`で知らせる。権限が足りない間は、そのリポジトリのmainのCIの失敗に気づけない。
Actions: Read-onlyでは、実行の一覧だけでなく、選んだ全リポジトリの実行のログとartifactも読める。
`github_token`は、Console用workerの`approval_decide`と`retry_work_item`も読む。
そのため、漏れたときの影響は、Contentsの読み書きに加えて、ログとartifactを読まれる分だけ広がる。
ログとartifactには秘密値を入れない。漏れたときの影響が広がる分は、残るリスクとして受け入れる。

fine-grained PATは、トークンの値を変えずに権限の設定だけを変えられる。権限を変えるときは既存のトークンを更新すればよく、再発行は要らない。
orgのリポジトリでは、権限を足すと、org側で再び承認を求められることもある。承認するまで、同じ通知は残る。

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
Issues、Contents、Pull requestsの書き込み権限が広すぎるためである。

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
| 取り込むものを絞る | 専用のワークフロー`console-dist.yml`が`main`へのpushで動き、成功した実行の成果物`console-dist`だけを取り込む。同じcommitの`ci.yml`が`main`へのpushで成功していることも要る。どちらもワークフローのパスと名前、ブランチ、イベント、結論を確かめる。zipと展開した各ファイルのsha256を照合してから書く |
| `console_fetcher`を閉じ込める | rootでないuid、読み取り専用のファイルシステム、ケーパビリティなし、DBにもWindmillにも届かない専用のnetworkで動かす |
| ブラウザ側で制限する | `/console/*`の応答だけに、scriptの読み込み先を`/console/assets/`に絞ったCSPと、埋め込みを禁じるヘッダーを付ける |
| CSPとCaddyのパスの解釈の違いを塞ぐ | パーセント符号を戻した元のパスが`/console/`で始まる要求は、Windmillへ転送しない。Consoleの経路では、生のパスに`%2f`か`%5c`があれば400にする |
| 旧Consoleのリンクを固定の行き先に飛ばす | 廃止した旧ConsoleのURL(`/apps/get/f/factory/factory_console`と`/apps_raw/get/f/factory/factory_console`、配下を含む)は、パスとクエリによらず固定の`/console/`へ302で飛ばす。行き先を要求から作らないので、オープンリダイレクトにならない。`Cache-Control: no-store`を付け、ブラウザに転送を覚えさせない |
| 他のサイトからAPIを呼ばせない | `/api/*`への要求は、次の4つをCaddyが403にする。`Sec-Fetch-Site`が`cross-site`か`same-site`のもの。`Origin`がブラウザの開いたオリジンと一致しないもの。ジョブを起動するGET(`run_wait_result`、`run_and_stream`、`slack_approval`、`teams_approval`、`move_s3_file`)を、fetchとXHR以外(`Sec-Fetch-Dest`が`empty`でないもの)で呼んだもの。GETとHEAD以外の要求を、ページの移動(`Sec-Fetch-Mode`が`navigate`か`nested-navigate`)で送ったもの。副作用のあるGETも、`Sec-Fetch-Mode`が`navigate`のときは止める。`Sec-Fetch-*`、`Origin`、`Cookie`のどれも送らないCLIは通す |
| Console自身の誤りを防ぐ | 呼べるscriptは、許可リストの5つ(読み取りの1つと、承認、再実行、監査の起動、通知の解決)だけである。認可はWindmillのログインに任せる。承認者と解決者は、画面から渡さず、ジョブの実行文脈からscriptが導き、導けなければ拒否する。Consoleの書き込みは、同一オリジンの`fetch`によるPOSTで送る。副作用のあるGETと、ページの移動による書き込みは、上の行のとおりCaddyが止める |
| 配信する状態を絞る | `/console/status.json`で配信するのは、`console_fetcher`の状態の4項目(`state`、`sha`、`checked_at`、`error`)だけである。`checked_at`と`error`から、自動の配信が止まっていることなど運用の状態が外から見える。`error`には分類した失敗の種類だけを書き、トークンや応答の本文などの秘密は含まない。ボリュームの他のファイルは配信しない |
| 秘密を配信物に入れない | Consoleのバンドルは認証なしで配信されるので、`VITE_*`の変数に秘密を入れない |

> [!WARNING]
> `factory_console`を、`console_fetcher`以外のコンテナに書き込みでマウントしない。
> workerのサンドボックスを作るときも同じである。
> 書けるコンテナが増えると、運用者のブラウザに居座る改ざんの経路になる。

残るリスクは次のとおりである。

- 許可リストと型付きの関数が防ぐのは、Console自身の誤りだけである。ConsoleのXSSや、運用者のCookieを持つ攻撃者は防げない。Cookieがあれば、許可リストの外のscriptも、Windmillのapiから直に呼べる。
- 承認の二重の送信を画面で止められるのは、このタブの中だけである。別のタブや別の端末、リロードの後は止められない。
  Issue提案のIssue作成のやり直しは、画面でもこのタブで15分間止める。
  それでも重なると、GitHubの検索の反映の遅れで、Issueが2件できうる。
  サーバーは、Issueを作る前に承認依頼ごとの印を条件付きのUPDATEで取り、取れなかった呼び出しを何もせずに終えて、この重なりを緩和する。
  Windmillの同時実行の制限(`concurrent_limit`)は設定しない。有償版でしか効かない。設定すると、自動の反映を拒否されるおそれもある。
  印は15分で切れるので、止まった処理のやり直しは塞がれない。
  失敗して提案を保留に戻した後も、印は期限まで残る。
  印に持ち主の識別子は無い。期限を超える処理と取り直した処理は、理論上は重なりうる。
- `main`へのマージは、承認0件のPRで済む。PRの必須チェックは通る必要があるが、人のレビューは強制されない。FactoryのPATが`main`へマージできるか、人の確認なしにマージできるかは確かめていない([mainの保護とリポジトリの公開](#mainの保護とリポジトリの公開))。そのため、マージされたコードは人のレビューを経ずに運用者のブラウザで動きうる。Consoleの変更のレビューは、Windmillの管理者権限を持つコードのレビューとして行う。
- CIの組み立ての途中で動くもの(miseが入れるbunなどのツール、Viteのプラグインなどの依存)が侵害されると、出力が改ざんされうる。`digest`とマニフェストが保証するのは、GitHubのCIが作ったものであることまでである。
- 信頼の境界は`console-dist.yml`の1つのジョブと、そこで動くツールや依存に及ぶ。`ci.yml`のジョブは同名の成果物を上げても、取り込み先の実行(`console-dist.yml`)に入らない。組み立ての手順は`console-dist.yml`に直接書き、composite actionに分けない。`console-dist.yml`を書き換える変更は、`main`へのマージで反映されるので、マージ前のレビューが唯一の防御である。
- 同じ実行の中では、成果物を`overwrite: true`で上げ、`console_fetcher`はその名前の`id`が最大の成果物を取り込む。`console-dist.yml`のジョブは1つなので、同じ実行にほかの上げ手はいない。
- `console-dist.yml`の成功が示すのは、組み立てが通ったことだけである。型検査、lint、テストを担う`ci.yml`の成功も、同じcommitについて取り込みの条件にする。`ci.yml`が実行中のcommitは、成功するまで取り込まない。
- `main`という名前のタグの実行は、ブランチ名が`main`で現れる。`console_fetcher`は同じcommitで、`console-dist.yml`と`ci.yml`のどちらも`main`へのpushとして成功していることを要る。FactoryのPATはWorkflowsの権限が無く、ワークフローのファイルを書き換えたcommitを作れない。現在のワークフローは`main`のブランチのpushでしか動かないので、PATによるタグでは実行が作られない。
- 両方のワークフローを書き換えたcommitに`main`というタグを付けられる人は、この照合を通せる。タグの作成と更新は、rulesetの`protect-tags`で管理者に限っている。管理者は迂回できるので、管理者のアカウントの侵害は防げない。取り込むcommitが`main`の履歴に含まれるかは、確かめていない。
- draw.ioのビューアも、この成果物の差し替えの範囲に入る。ビューアは`console-dist.yml`が取得して、同じ成果物に入れるためである。
- `Sec-Fetch-Site`をブラウザが送るのは、信頼できるオリジン(localhostかHTTPS)のときだけである。`WM_BIND`を外向きにしてHTTPで公開すると、この防御は効かない。外向きにするならHTTPSで公開する。
- `Origin`の検査が比べる相手は、要求の`Host`ヘッダーから作ったオリジンである。DNSリバインディングで`Host`が攻撃者のホスト名になると、`Origin`も一致して通る。ただしCookieはホスト名ごとに付くので、運用者のCookieは付かない。
- `Origin`の検査が補えるのは、GETとHEAD以外のブラウザの要求だけである。ナビゲーションや`<img>`のGETには`Origin`が付かず、Firefox 70未満はフォームのPOSTにも付けない。この検査は、HTTPで公開してもブラウザが送るので、`Sec-Fetch-Site`の弱点を補う。
- 前段でTLSを終端するときは、プロキシが`Host`をポートを含めて保つ(nginxなら`proxy_set_header Host $http_host`)。nginxの既定は`Host`を書き換え、`$host`はポートを落とす。どちらも`Origin`と合わず、ログインを含む書き込みがすべて403になる。
- スキームを問わず許すので、HTTPS公開のときも、同じホスト名とポートの`http://`の`Origin`が通る。`Sec-Fetch-*`を送るブラウザは、`Sec-Fetch-Site`の規則が止める。止められないのは、`Sec-Fetch-*`を送らないブラウザだけである。
- GETでも副作用のあるAPIは、`Sec-Fetch-Site`と`Origin`では止まらない。同じオリジンの`<img>`やリンクから、Cookieの持ち主の権限でジョブを起動できる。そのため、副作用のあるGETの経路を洗い出し、fetchとXHR以外を403にしている。洗い出しの一覧は[Consoleの仕様](internals/console.md)にある。洗い出したのは`windmill-client`の型定義にあるAPIまでで、サーバーの全経路ではない。HTTPトリガー(`/api/r/*`)を足すときは、GETでジョブを起動する経路にならないかを確かめる。
- 古いブラウザと、HTTPで公開したブラウザは、`Sec-Fetch-Dest`を送らない。`Sec-Fetch-*`は、localhostかHTTPSのオリジンにだけ付くためである。この場合、副作用のあるGETは`Cookie`を持つときだけ止める。WindmillのフロントエンドがこれらのGETを使うと、その環境では403になる。
- 注入された`<form method="post">`のクリックは、`Sec-Fetch-Mode: navigate`で止める。`Sec-Fetch-Mode`を送らないブラウザは止めない。止めるとfetchの書き込みまで巻き込むためである。
- `<link rel="prefetch">`、`<link rel="preload">`、`<a ping>`は、`Sec-Fetch-Dest: empty`などで、副作用のあるGETを送りうる。
  どれも生のHTMLの注入が要り、サニタイザが落とすので、止めていない。
- この4つの規則が効くのは`/api/*`だけである。`windmill_extra`の経路(`/ws/*`、`/ws_mp/*`、`/ws_debug/*`)には、`Origin`の検査も含めて効かない。`handle @extra`が先に当たるためである。
- 旧Consoleへの規則は、過去のDiscordの通知、Issueのコメント、PRの本文に残るリンクのために、旧Consoleを削除した後も残す。飛ばすのは閲覧の`/apps/get/`と`/apps_raw/get/`だけで、編集画面やAPIには触れない。フラグメントはブラウザがリダイレクトを越えて保ち、新しいConsoleが読み替える。読み替えるのは、正の整数のidを持つ要件定義書と監査レポートの形だけで、ほかのフラグメントは入口に着く。
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

workerには`no-new-privileges:true`と、プロセス数の上限(`deploy.resources.limits.pids`)を設定する。
`cap_drop`は、ジョブが使わない`NET_RAW`、`MKNOD`、`SETFCAP`、`AUDIT_WRITE`に限る。
`NET_RAW`は、同じnetworkの他のコンテナへのなりすましの足場になるため、落とす。
`SYS_CHROOT`、`FSETID`、`NET_BIND_SERVICE`は、Windmill本体が使わないことを確かめていないので残す。
`ALL`を落として必要なものだけを足す構成は、Windmill本体が使うものを確かめていないので採らない。
検査コマンドの実行には`CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`SETUID`、`SETGID`、`SETPCAP`、`KILL`が要るので、これらは落とさない。
workerのプロセスは、ベースのWindmill公式イメージがrootでの実行を前提にしているため、rootで動かす。
信頼できないコードを実行する検査コマンドだけを、非特権のユーザーに落とす([検査コマンドの権限](#検査コマンドの権限))。

workerのPATHには、rootのホームの`/root/.local/bin`と、誰でも書き込める`/tmp`の下の`/tmp/.local/bin`を入れない。
ベースのイメージのPATHは、この2つを含む。
`/tmp/.local/bin`は、Windmillの`windmill`の実行ファイルに参照が無く、稼働中のworkerにも存在しない。
非特権のuidがそこに`git`などを置くと、rootのworkerの名前解決を奪えるため、外している。
`claude`は`/usr/local/bin`のsymlinkから名前で起動する。

イメージには、検査コマンドを動かす非特権のユーザー`factory-check-0`から`factory-check-7`を作ってある。
`useradd -M`でホームのディレクトリは作らず、passwdに記録されるホームのパスも実在しない。
`HOME`は、実行のたびに`/tmp`の下に作る非公開のディレクトリを渡す。
ジョブの`TMPDIR`が指す先には作らない。そこは検査用のユーザーが入れない0700の下なので、`HOME`にたどり着けないためである。
ログインシェルは使えない。
uidの切り替えに使う`setpriv`と、枠のロックに使う`flock`も入っている。
後始末に使う`kill`(procps)と、ACLを確かめて消す`getfacl`と`setfacl`(acl)も入っている。
イメージのビルドは、検査の実行と同じ引数の`setpriv`で、すべてのユーザーについて、uid、ケーパビリティの上限が空であること、`no_new_privs`を確かめる。
`kill`、`getfacl`、`setfacl`があることも確かめる。
使い方は[検査コマンドの権限](#検査コマンドの権限)に書く。

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

Consoleから押せる書き込みには、読むsecret変数の上限を決める。
`github_token`を読んでよいのは、`approval_decide`と`retry_work_item`だけである。
`audit_kickoff`と`notice_resolve`は、どのsecret変数も読まない。
Consoleの操作で、外向きの資格情報が動く範囲を広げないためである。
tag`console`のscriptがimportでたどれるソースを数える契約テスト(`tests/scripts/console_worker_boundary.test.ts`)が、この上限を確かめる。
許可した2つも、`github_token`以外のsecret変数は読まない。
走査でたどれない形が現れたら、テストは落ちる。
たどれない形は、次のとおりである。

- 絶対パスと、`f/`か`u/`で始まるimport
- `require`
- 引数が単純な文字列リテラルでないimport()
- `.name("literal")`の形の呼び出しで説明できない、`getVariable`と`getResource`の出現。添字アクセス、分割代入、名前付きimport、別名への代入、引数が変数の呼び出し、注入された関数の呼び出しが当たる

script.yamlに`$var:`か`$res:`の参照があるときも、テストは落ちる。
例外は2件で、どちらも読み取りを依存として注入するため、引数が変数になる。`console_query`は`deployed_sha`の読み取りで、`loadConfig`は設定のリソースの読み取りである。呼び出し側が定数だけを渡すことを確かめ、テストの許可リストに理由を書いている。
テストが見ないのは、文字列を組み立てて作ったsecretのパス、環境変数やDBを経由して受け取る名前、`eval`、文字列の中に隠したコードである。これらはコードのレビューで見る。

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
  `retry_work_item`が実際に読むのは、次の2つのときの`github_token`である。
  取り消された作業項目の再開のときの、対象の状態の確認。
  Issueの要件定義を作り直す再実行のときの、取り込み内容の更新。
  `approval_decide`が読むのは、要件定義の承認のときの`github_token`である。
  Console用のworkerで動くscriptから`github_token`を読むのは、この2つのscriptに限る取り決めである。
  この取り決めは、tag`console`のscriptがたどれるソースを数える契約テストで確かめる。強制する仕組みは無い。
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

## サブプロセスのnpmのinstall script

`self_update`と、ホストで動かすmiseのタスク(`mise run push`、`mise run deploy`など)は、`wmill sync push`のサブプロセスに次の環境変数を渡す。

```text
NPM_CONFIG_IGNORE_SCRIPTS=true
```

`wmill`がnpmを走らせることがあっても、依存のinstall scriptを動かさないためである。
install scriptは、workerの権限のまま、ネットワークにも出られる状態で動く。

リポジトリのWindmillの資産には、npmの依存を入れるものが無い。
足すときは、install scriptなしで組み立てが通るかを確かめる。

廃止した旧Consoleのappは、人が`mise run push:prune`を実行するまでWindmillに残る。
残ったappは更新されず、閲覧のURLはCaddyが新しいConsoleへ302で飛ばす。

## 依存の脆弱性

ルートの`bun audit`の指摘のうち、修正版が無いものを受け入れる。
`overrides`で解消できるものは[コーディング規約](coding-guidelines.md#依存の脆弱性)の手順で固定する。

ルートの依存はすべて開発用で、文書の検査(markdownlint-cli2、textlint)、型検査、整形に使う。
本番のコードからは読まれない。
ただし、このリポジトリを対象に`check_commands_by_repo`か`allowed_check_commands`を設定すると、検査がworkerのコンテナの中で走る。
そのとき`bun install`で入る依存は、workerのコンテナの中で動く。
設定の詳細は[実装フローの仕様](internals/implement.md)と[PRワークフローの仕様](internals/pr-workflow.md)にある。

### 受け入れている指摘

| パッケージ | 重大度 | 経路 | 受け入れる理由 |
| --- | --- | --- | --- |
| `braces` | high | markdownlint-cli2 > globby > fast-glob > micromatch | `scripts/lint-docs.ts`はファイル名をglobとしてmarkdownlint-cli2に渡す。`{`を含む名前をコミットできる者は、深くネストしたパターンに到達しうる。影響は文書検査の失敗にとどまり、本番には及ばない。長さの上限の範囲では停止を再現できていない |
| `sprintf-js` | moderate | prh > js-yaml@3.15.2 > argparse@1.0.10 > sprintf-js | js-yaml@3でargparseを読むのはCLIの`bin/js-yaml.js`だけで、`lib/`からは読まれない。prhの実行時にsprintf-jsは読み込まれない |

markdown-itはargparse@3を、rc-config-loaderのjs-yaml@4はargparse@2を使い、どちらもsprintf-jsに依存しない。

### 修正版が出たときの確認

`bun audit`は定期には走らない。
依存を更新するPRの前と、指摘の報告を受けたときに、人かClaudeが次の順で確かめる。

1. ルートで`bun audit`を実行する。
2. 受け入れている指摘に修正版が出ていれば、`bun update`か`overrides`で解消し、上の表から外す。
3. `overrides`で固定しているパッケージの親が修正版を取り込んでいれば、`overrides`を外す。
4. `mise run lint:docs`が通ることを確かめる。

## 自己更新の打ち切り

`self_update`のジョブには、全体の上限がある。
値と内訳は[アーキテクチャ](architecture.md)の「自己更新」にある。
通常は、各コマンドの上限と、区切ったSDK・DBの呼び出しの上限(30秒)で先に終わる。
全体の上限は、それでも止まったときの最後の砦である。

残るリスクは次のとおりである。

- Windmillが全体の上限でジョブを打ち切るときに、子プロセスが止まるかを確かめていない。
  子(`wmill sync push`、`wmill datatable migrate up`、git)は別のセッションで起動する。
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
要件定義書の画面(`/console/items/:id/requirements`)が、図ごとに`DrawioFrame`で描く。
安全の検査を通らなかった図(`rejected_diagrams`)は、iframeを作らず、表示しない旨だけを出す。
仕組みは[Consoleの配信の仕様](internals/console.md)の「draw.ioの図」にある。

| 守ること | 内容 |
| --- | --- |
| ビューアを同梱する | CDNからは読まない。CIが、版を固定したURLからビューアを取得し、固定のsha256と照合してから、配信物の`drawio/`に置く。照合に失敗すると、CIが止まる |
| 本体から読めない場所に置く | ビューアと受け口は、Console本体のscriptの置き場所`/console/assets/`ではなく`/console/drawio/`に置く。本体のCSPは`/console/assets/`だけを許すので、本体にHTMLが注入されても、信頼されたオリジンでビューアを動かせない |
| 取得元を固定する | 固定する値は`console/drawio-viewer.json`にある。URLはbranchやtagではなくcommitを指す。この固定ファイルと、固定を書き換えるPRを作るscriptとその部品、固定を強制するスクリプトは保護パスで、人のレビューを経ずには変えられない。一覧は[保護パスの変更を止める](#保護パスの変更を止める)にある |
| 不透明なオリジンで動かす | iframeの`sandbox`は`allow-scripts`だけにする。`allow-same-origin`が無いので、iframeはCookieにも、Windmillにも、親のDOMにも届かない。ポップアップと最上位のページの遷移も許さない。`/console/drawio.html`のCSPにも`sandbox allow-scripts`を付け、ページを直接開いても不透明なオリジンで動かす |
| 外への取得をCSPで止める | `/console/drawio.html`だけに、別のCSPを付ける。scriptは`/console/drawio/`の同梱のファイル(ビューアと受け口)に限り、`connect-src`、画像、フォント、フォームの送信先は外を許さない。XMLが外部の画像やフォントを指していても、取得されない |
| XMLを1回だけ送る | 親は、XMLごとにiframeを作り直す。1つのiframeに送るのは、最初のloadの後の1回だけである。2回目のloadは、iframeが別の文書へ遷移したことを表す。親はiframeを`about:blank`にして表示を止め、以後そのiframeのメッセージを受けない。遷移した先へ、次のXMLは渡らない。この停止は最善の努力で、loadが起きない遷移は止められない。その場合も、親が受ける値は、数値と固定の失敗の種類だけである |
| メッセージを絞る | iframeは、親のwindowからの描画の依頼を最初の1回だけ受ける。親は、iframeのwindowからの高さと失敗の種類(固定の3つ)だけを受け、高さは数値に絞って80〜1600pxに収める。256KBを超えるXMLは送らない |
| リンクを開かない | ツールバー、lightbox、図のリンクを無効にする。ページ内のクリックとauxclickの既定の動作は、押された要素を問わず止める |

固定するsha256は、commit固定のURLから取得したバイト列の値である。
版の更新は、[ビューアの更新](#ビューアの更新)で自動のPRにする。
手で上げる手順は[Consoleの配信の仕様](internals/console.md)の「draw.ioの図」にある。

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
- `'unsafe-eval'`は許さない。根拠は、32.4.1のビューアのコードの読解と、ヘッドレスのChromeでの確認である。
  自動で上げた版は、この調査を経ていない。`eval`が要る版は、図が描かれなくなるだけで、CSPが評価を止める。
  - ビューアが`eval`を呼ぶ箇所は2つある。図のスタイルや定義に書かれた式を評価する経路は、評価を許すフラグがどれも既定で無効である。外部の図形ライブラリのscriptを取得して評価する経路は、取得をCSPの`connect-src 'none'`が止める。`new Function`は無い。
  - `'unsafe-eval'`を付けずに、普通の図と、リンク、外部の画像、フォント、図形ライブラリ、評価を許す式を含む図を描いた。`eval`の違反は出なかった。
- 外部の図形ライブラリ(AWSなどのアイコン集)を使う図は、その図形が描かれない。外部への取得をCSPが止めるためである。

### 親の部品が守ること

`DrawioFrame`が、iframeを作る。
iframeとのメッセージは、`console/src/lib/drawioMessages.ts`と`console/src/lib/drawioFrameState.ts`の純関数が扱う。

| 守ること | 内容 |
| --- | --- |
| 不透明なオリジンで動かす | `<iframe src="/console/drawio.html" sandbox="allow-scripts" referrerPolicy="no-referrer">`にする。`srcDoc`は使わない。`allow-same-origin`、`allow-popups`、`allow-forms`、`allow-top-navigation`は付けない。iframeは、WindmillのCookie、親のDOM、最上位のページの遷移、ポップアップ、フォームの送信から切り離される。外への取得は、CSPの`connect-src 'none'`が止める |
| 受け口と値を合わせる | メッセージの種別と失敗の種類は、`console/public/drawio/drawio-frame-*.js`と同じにする。`tests/lib/drawio_frame_isolation.test.ts`が、ソースを文字列として読んで確かめる |
| XMLは1回だけ渡す | 最初のloadの後にpostMessageで1回だけ送る。親は、送り元がそのiframeの`contentWindow`のものだけを受け取り、高さを80〜1600の範囲に収め、失敗は固定の3つの種類だけを受ける。iframeが2回目のloadを起こしたら、遷移とみなして表示を止める |
| 図を拒否する | 上の`validateDrawioXml`が、生成の時点と読み戻しの時点で、リンク、危険な要素、圧縮した図を拒否する |

読み戻しで拒否した図は、`requirements_doc`ビューが名前を`rejected_diagrams`で返す。
本文は、その名前の図を「安全の検査を通らなかったので表示しません」と表示し、図が見つからない場合と区別する。

読み戻しの検査は、すでにディスクにある図にもかかる。検査を通らない図は表示しない。
`link`属性や`<a>`を含む既存の図は、「表示しません」になる。
承認する人は、図を見ないまま判断することになる。
図が判断に要るときは、要件定義の作り直しを求める。

#### sandboxが止められない経路

`sandbox`は、iframeの`window.top.postMessage`と`window.parent.postMessage`を止められない。
ConsoleのSPAの親のページは、iframeから高さと失敗の種類だけを受け、ほかのメッセージの通り道を持たない。
図のscriptが親へ送れるものは、範囲に収めた数値の高さと、固定の失敗の種類に限られる。

#### 保護パス

次のファイルは、保護パスである。

- `tests/lib/drawio_frame_isolation.test.ts`

書き換えられると、sandboxを外したり、別のページをiframeに読ませたりしても、検査を通ってしまうためである。
`DrawioFrame.tsx`は保護しない。
画面の普段の変更を、保護パスで止めないためである。
`sandbox`の値は上のテストが固定し、HTTPのCSP(`infra/Caddyfile`の`drawio_headers`)も後ろ盾になる。
別の部品が`/console/drawio.html`をsandboxなしのiframeで読む迂回は、CSPの`sandbox allow-scripts`が、ページを不透明なオリジンに固定して止める。
`frame-ancestors`は、埋め込める親を、このサイトと同じオリジンのページに限る。

制約は次のとおりである。

- `/console/drawio.html`が配信されていないと、図は描かれない。親は、応答がないものとして固定の文を出す。
- 外部の図形ライブラリ(AWSなどのアイコン集)と、ビューアのtoolbar、ズーム、レイヤは使えない。

残るリスクは次のとおりである。

- ビューアがiframeの中で`window.location`を書き換えて遷移する経路は、`sandbox`で防げない。2回目のloadの検知で表示を止めるが、loadが起きない遷移は検知できない。そのときも、親が受け取るのは、範囲に収めた高さと、固定の失敗の種類だけである。
- ラベルの`%名前%`を別の値に置き換える`placeholders`と`vars`は、検査が拒否する。
  draw.ioが別の属性でも同じ置き換えをするようになると、検査はその図を拒否できない。
  その図は、iframeの隔離とCSPで止める。

実機でしか確かめられない点は次のとおりである。

- 図が描かれ、高さが図に追従すること。
- リンクを含む図を描いても、クリックで遷移しないこと。

### ビューアの更新

固定は、Windmillの`f/factory/drawio_viewer_bump`が週に1回確かめ、新しい版があればPRにして上げる。
GitHub Actionsではなく、Windmillで動かす。
ActionsでPRを作るには、PRに書ける長期のトークンをActionsのsecretに足す必要があるためである。
Actionsの既定のトークンで作ったPRは、CIを起動しない。
このリポジトリは、`ci.yml`の権限を読み取りだけに保つ。
Windmillは、実装とPR修正が使う`f/factory/github_token`で足りる。このトークンはWorkflowsの権限が無いので、`.github/workflows/`には書けない。

| 守ること | 内容 |
| --- | --- |
| 取得元を絞る | 公式のjgraph/drawioのGitHubのリリースだけを読む。下書きとプレリリースは読まない。タグが指すcommitは、GitHubのAPIでたどって決める。ビューアのURLはcommit固定で、リダイレクトは許さない |
| 2つの時計で待つ | 公開日(`published_at`)から14日以上たち、かつ、同じcommitを14日以上前から見ている版だけを上げる。公開日はリリースを作る側が書き換えられるので、それだけを根拠にしない。見始めた時刻は、タグごとにDBの`factory.drawio_viewer_observations`へ記録する。記録は、Factoryの通常の経路からは書き換えない。DBを直接触る変更(migration、WindmillのSQL)は、この保護の外にある |
| 付け替えで待ちを数え直す | タグが別のcommitに付け替えられたら、記録の時刻を今に取り直す。付け替えた版は、取り直した時刻から14日待つ |
| 正式版から数える | プレリリースは読まず、記録もしない。プレリリースから正式版に切り替わった版は、正式版として初めて見た時刻から14日を数える |
| メジャー版に目印を付ける | メジャー版が変わる版も、他の確認を通ればPRにする。固定のファイルは保護パスで、マージは人が行うため、メジャー版で止めても安全は増えない。題名を`[major]`で始め、本文の先頭に、リリースノートとCSP、sandbox、図の隔離のテスト(`drawio_frame_isolation`)の確認を人が行うと書く |
| 大きさの急変を上げない | 今のビューアの大きさから2割を超えて増減した版は上げない。noticeに残し、人が版を指名したときだけ上げる。空のファイルと、CIの取得の上限(10MB)を超えるファイルは、指名しても上げない |
| 2つの経路で照合する | 取得したバイト列の大きさとgit blobのIDを、GitHubのAPIが返す同じcommitのファイルの値と照合する。違えばPRを作らず、noticeに残す。sha256はこのバイト列から計算して固定ファイルに書く。CIは別の経路(`raw.githubusercontent.com`)で取得し直して照合する |
| 書き込みを絞る | PRのブランチを1つ作るだけで、`main`には書かない。変えるのは固定のファイルと、ビューアを読むページ(`console/public/drawio.html`)の2つだけである。commitの名義はGitHubのnoreplyにする |
| 重複を作らない | 同じ版のブランチをheadにしたPRが、閉じたものを含めて1件でもあれば、ブランチが消えていても作らない。未完了の更新のPRがあるあいだも、新しいPRを作らない。数えるのは、このリポジトリのブランチをheadにしたPRだけで、forkに同じ名前のブランチを作られても更新は止まらない |
| 既存のブランチを確かめる | PRの無いブランチが既にあれば、先頭のcommitを1回だけ取り、そのcommitに対して確かめる。各ファイルのgit blobのIDが作るはずの内容と一致し、`main`との差分がその2ファイルだけで、名前の変更を含まないことを確かめる。合わなければPRを作らず、noticeに残す。PRを作った後に、PRのheadのcommitが確かめたcommitと同じかを確かめ、違えば自動レビューのラベルを付けずに止めて、noticeに残す |
| 自動でマージしない | PRはDraftにせず、自動レビューのラベルを付ける。マージは人が行う |
| 修正を人に限る | ブランチ名が`factory/drawio-viewer-`で始まるPRには、PR修正を始めない。修正の準備のステップも止める。修正を許すと、固定のファイル以外も書き換えたcommitを、人が気づかずにマージするおそれがある。自動レビューは動く。`factory:fix`ラベルは消費されず残る。修正は人が行う。判定はブランチ名だけで行うので、`factory_repo`に限らず、担当するすべてのリポジトリのPRに効く |
| 部品を保護パスにする | 更新のscript、判断、GitHubの読み取り、観測の記録、scriptとスケジュールの定義を保護パスにする。書き換えられると、別の版や取得元の更新を人の確認なしに提案できるためである。一覧は[保護パスの変更を止める](#保護パスの変更を止める)にある |

更新のPRは、通常のCIを通る。
`console`ジョブが固定のURLからビューアを取得してsha256を照合し、`public-assets`のテストがページの参照と固定の一致を、CSPと図の隔離のテストが設定を確かめる。

残るリスクは次のとおりである。

- 新しい版が図を描けるかは、自動では確かめない。描けない版は、iframeが固定の失敗の文を出す。PR本文が、マージ後にConsoleで図を開いて確かめるよう求める。
- 上流のリポジトリが侵害され、2つの待ちと大きさの確認をすり抜けた版は、PRになる。マージの前に人が見る。マージ後も、iframeの隔離とCSPが被害を限る。
- 観測の時刻は、こちらが見た時刻である。公開日を古く偽られても、こちらが初めて見た時刻から数えるので、14日の待ちは回避されない。
- 観測は週に1回なので、観測の間にタグを付け替えて元に戻されると、気づけない。
- 最初に動かした週は、すべての版の観測が始まったばかりなので、14日間は何も上げない。記録が消えたときも、同じように待ちを数え直す。
- 上げる版に選んだ最新の版を保留している間は、それより古い版も上げない。保留の理由はnoticeに出る。
- 保護するのは更新に専用の部品である。汎用の層(`github.ts`、`db.ts`、`types.ts`、`workspace.ts`)は保護していない。更新はこれらの関数を呼ぶので、挙動を変える変更は通常のレビューで確かめる。
- script定義とlockのうち、`drawio_viewer_bump.script.lock`と`lib/drawio_viewer_observations.script.lock`は保護しない。`windmill-client`の版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。他の部品のscript定義とlockは保護する。
- ブランチ名が`factory/drawio-viewer-`で始まる未完了のPRが残ると、更新は止まる。そのPRを閉じるかマージすると、次の週に再開する。

## 要件定義書のリンク

要件定義書のMarkdownは、Issueの内容に由来する。
Consoleは、これをWindmillと同じオリジンで描く。
`rehype-sanitize`の既定のスキーマは`javascript:`などを除くが、任意の`http(s)`のURLの`a[href]`は通す。
そのため、読み手がリンクの文字を信じて、外のページを開くおそれがある。

`src/components/markdown/Markdown.tsx`は`a`を差し替える。
リンクにするものは、`src/lib/markdownLink.ts`の`resolveMarkdownLink`で絞る。

- 作業項目と同じリポジトリのIssueとPRのURL。`src/lib/safeUrl.ts`の`safeGitHubUrl`を通り、ownerとrepoが作業項目のものと一致するものに限る。ownerとrepoは、大文字小文字を区別せずに比べる。信頼できない本文が、読み手を別のリポジトリへ誘導できないようにするためである。
- 同じページの見出しへのフラグメント。`#`で始まり、`slugify`が作るslugと同じ形に限る。

それ以外は、リンクにせず文字で出す。
リンクの文字とURLが違うときは、URLも括弧で添える。
読み手が行き先を判断できるようにするためである。
添えたURLは`<bdi>`で包む。文字の向きを変える制御文字が、周りの表示を崩さないようにするためである。
同じページの見出しへのリンクは、行き先を取り違えようがないので、URLを添えない。
GitHubへのリンクは、`rel="noopener noreferrer"`を付けて新しいタブで開く。

`Markdown`が`repo`を必須の引数で受けるので、リポジトリを渡さずにGitHubのURLをリンクにする経路は無い。
見出しへのフラグメントは、接頭辞`h-`を付けた見出しの`id`を指すように読み替える。
見出しの`id`が、ページの他の要素の`id`や`name`と重ならないようにするためである。
脚注の記法は使わない。脚注への参照(`#user-content-fn`で始まるフラグメント)は、リンクにせず文字で出す。
本文、要約、未確定事項、題名は、描く前に`displayableIssueText`で見えない文字を置き換える。
画像は図の参照`<name>.drawio`だけを無害化のスキーマで通し、それ以外の画像のURLは描かない。
`src/components/markdown/Markdown.test.tsx`が、次のものを描かないことを固定している。
生のHTML、外のリンク、別のリポジトリのリンク、`javascript:`のリンク、外の画像である。

### 監査レポートの本文

新しいConsoleの監査レポートの本文(`console/src/screens/reports/AuditMarkdown.tsx`)は、リンクを張らない。
本文は、監査のClaudeが信頼できない運用記録から書くためである。
監査レポートの本文にはURLを書かない決まりで、リポジトリの情報も渡されないので、張ってよいリンクが無い。
同じページの見出しへのリンクも張らない。見出しに`id`を付けないので、行き先が無い。

リンクの文字はそのまま文字で出し、URLが文字と違うときは括弧で添える。
添えたURLは`<bdi>`で包む。
画像は読み込まず、「画像は表示しません」と出す。
外のURLを読み込むと、レポートを開いただけで外へ通信が出るためである。
本文の生のHTMLは、`rehype-raw`を使わないので要素にならず、描かずに捨てる。
`rehype-sanitize`の既定のスキーマは、変換後の要素と属性を絞る二重の防御である。
描く前に`displayableIssueText`で見えない文字を置き換える。

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

対象リポジトリのlintやテストは、Claudeではなくフローのステップが`factory_config`の`allowed_check_commands`として実行する。
実装フローは、`check_commands_by_repo`に明示したコマンドを実行する。
検査コマンドは対象リポジトリのコードを実行するので、workerのrootではなく、非特権のユーザー(`factory-check-N`)で動かす([検査コマンドの権限](#検査コマンドの権限))。
ただしコンテナ、network、CPUとメモリはworkerと共有する。
そのため既定値は空の配列にし、空でなければ、コンテナの分離が無いことを知らせる記録(notice)を作業項目ごとに残す。
同じ本文の未解決の記録があれば新しく作らない。作成から1日を過ぎていれば、時刻を更新する。

検査コマンドに渡す`PATH`は固定の`/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin`で、workerの`PATH`は引き継がない。
どのディレクトリもrootが所有し、非特権のuidは書き込めない。
rootのホームと`/tmp`の下は入れない。そこに置かれた実行ファイルを、名前の解決で拾わないようにするためである。

### 検査コマンドの権限

検査コマンドは、実uidと実gidを検査用のユーザー`factory-check-N`にして実行する。
対象リポジトリのコードから、workerの秘密と、workerが後で実行するファイルを守るためである。
実装は`f/factory/lib/check_runner.ts`と`f/factory/lib/check_sandbox.ts`にある。

検査用のユーザーは、並行して動く検査どうしが同じuidを共有しないよう、複数ある(枠)。
実行ごとに、空いている枠を1つ取り、終わったら手放す。
枠の数は`FACTORY_CHECK_POOL_SIZE`で、既定は8である。workerの同時実行数(`NUM_WORKERS`、3)以上にする。
先頭のuidは`FACTORY_CHECK_UID`で、既定は10001である。
どちらもイメージのビルド引数で、`mise.toml`の`[env]`が値を持つ。
ジョブにはworkerの環境変数がほとんど渡らないので、scriptは`/etc/passwd`の`factory-check-N`から枠のuidを読む。
読んだuidが1000未満(rootを含む)なら、検査を始めずに失敗させる。

| 守るもの | 仕組み |
| --- | --- |
| 権限 | `setpriv`で、実uidと実gidを枠のuidにし、補助グループを実行ごとの目印の1つだけにし、ケーパビリティの上限と継承を空にし、`no_new_privs`を立てる。setuidのバイナリやファイルのケーパビリティで特権を戻せない |
| プロセス数 | `setpriv`の前に`prlimit`で、枠のuidが持てるプロセス(スレッドを含む)を256までにする。カーネルは実uidごとに数えるので、同時に動く検査がそろって上限まで使っても、workerのコンテナのpidsの上限(1024)の内に検査の外の分が残る([プロセス数の上限の決め方](#プロセス数の上限の決め方))。後始末の`kill`は上限を付けずに起動するので、上限に達した枠のプロセスも止められる |
| 並行する検査 | 枠ごとにuidが違うので、並行して動く別の検査のworktreeとHOMEに書き込めない。枠は`/var/lib/factory/check-slots`のロックファイル(`flock`)で取る。ロックを持つプロセスの標準入力のパイプが閉じると解放されるので、ジョブが殺されても枠は塞がったままにならない |
| 枠の使い回し | 枠は、後の実行で別のリポジトリの検査に使う。枠を取るたびに、前の実行が残したプロセス、所有権、HOME、共有の一時ディレクトリのファイル、System VのIPCを消してから使う([枠の記録と片付け](#枠の記録と片付け)) |
| 環境変数 | 許可リストの`PATH`、`HOME`、`TMPDIR`、`LANG`と、worktreeだけを`safe.directory`にするgitの設定(`GIT_CONFIG_COUNT`など)だけを渡す。workerの環境変数は1つも引き継がない。`TMPDIR`は`HOME`の下の0700のディレクトリである |
| workerの秘密 | 別のuidのプロセスは、rootのプロセスの`/proc/<pid>/environ`とfdを読めない。`DATABASE_URL`や`WM_TOKEN`などの環境変数と、0600のファイルに届かない。枠のロックファイルと記録のディレクトリは0700である |
| worktreeのロック | worktreeのロックファイルは0600で、検査用のユーザーは開けない。flockは読み取りで開いたファイルにもかけられるので、開けるとロックを握ってworktreeを塞げるためである |
| 書き込める場所 | worktree、実行ごとの`HOME`、共有の一時ディレクトリ(`/tmp`、`/var/tmp`、`/dev/shm`、`/dev/mqueue`、`/run/lock`)である。main cloneの`.git`、worktreeの隣、システムのディレクトリ、`/var/lib/factory`には書けない。ベースのイメージが誰でも書けるようにしている`/usr/src/app`(Windmillの実行ファイルと共有ライブラリの置き場)と`/tmp/.cache`は、イメージのビルドで、中のファイルも含めてグループとその他が書けないようにする。共有の一時ディレクトリそのもののほかに、誰でも書けるファイルかディレクトリがあれば、ビルドを失敗させる |
| Windmillの実行時のディレクトリ | `/tmp/windmill`の下の`cache`などは、Windmillが誰でも書き込める権限(0777)で作る。rootのworkerが実行する依存のバンドルを検査用のユーザーが差し替えられないよう、検査の前に`/tmp/windmill`を所有者以外が入れない権限(0700)にする |
| 後始末 | コマンドごとと実行の最後に、枠のuidのプロセスをSIGKILLで止める。止まらないプロセスが残れば、所有権を戻さずに失敗させる。実行の最後には、共有の一時ディレクトリとIPCからも枠のuidのものを消す |
| イメージと実行時の前提 | 準備の最初に、後始末が呼ぶ道具(`setpriv`、`prlimit`、`find`、`chown`、`chmod`、`flock`、`rm`、`ipcrm`、`kill`、`getfacl`、`setfacl`)と、枠のuidの`factory-check-N`がイメージにあるかを確かめる。誰でも書けるものが無いことも確かめる([誰でも書き込めるものの探し方](#誰でも書き込めるものの探し方))。満たさなければ、所有権と枠の記録のどちらにも触れずに止まる |

実行の順序は次のとおりである。

1. イメージと実行時の前提を確かめる。満たさなければ止まる。
2. `/tmp/windmill`を0700にする。
3. 空いている枠を取る。全部埋まっていれば、2秒おきに取り直し、最大5分待つ。待っても取れなければ「検査の枠が空かない」という失敗にする。
4. 枠を片付ける。片付けられなければ、その枠を手放し、noticeを残して次の枠を試す。
5. 枠の記録に、worktreeと`HOME`のパスを書く。
6. worktreeと`HOME`のうち、rootが所有するものを枠のuidに渡す。
7. コマンドを、worktreeのロック(`flock`)の下の`prlimit`と`setpriv`で実行する。コマンドごとに、残ったプロセスを止める。
8. 枠のuidのプロセスがいないことを確かめてから、worktreeの所有権を取り戻す。
9. `HOME`を消し、共有の一時ディレクトリとIPCから枠のuidのものを消し、枠の記録を消して、枠を手放す。

待つのは、同時実行が枠の数を超えても開発を止めないためである。
実行を直列にはしない。

1で止まったときの理由は、イメージの問題なら`worker image is stale: run mise run up`で始まる。
稼働中のworkerの問題なら`worker runtime is unsafe for checks:`で始まる。

1でイメージの前提を確かめるのは、`f/`の変更がイメージの作り直しより先に反映されても、開発を止めないためである。
前提を確かめずに進むと、古いイメージに無い`getfacl`で取り戻しが失敗し、記録と所有権が残る。
次にそのworktreeを使う準備も同じ失敗で止まり、枠が1つずつ飛ばされて、すべての検査が失敗する。
実装とPR修正の準備のステップも、検査コマンドがあれば、Claudeを動かす前に同じ前提を確かめる。
前提を満たさずに止まった実行は、検査の失敗として数えず、ラウンドも記録しない。
PR修正の完了のステップが、commitの前に同じ理由で止まったときも、ラウンドを記録しない。
実装は人の対応待ち、PR修正は`blocked`で止まる。
イメージの問題なら、要対応の通知`host_action_required`で`mise run up`を求める([運用](operations.md#fとworkerのイメージを両方変えたとき))。
稼働中のworkerの問題なら、要対応の通知`check_runtime_unsafe`で、パスを閉じるか、workerのコンテナを作り直すよう求める([運用](operations.md#稼働中のworkerが検査の前提を満たさないとき))。
確かめた結果は、1回の実行の間だけ覚える。

9で共有の一時ディレクトリを消し切れなくても、検査は失敗にしない。次にその枠を取る実行が、4で消し直すためである。
9で消すのは、番号の大きい枠が次に使われるまで、検査の残したファイルを共有の場所に長く置かないためである。

#### 誰でも書き込めるものの探し方

前提の確かめは、`find`で`/`と`/dev/shm`からたどり、誰でも書き込めるもの(symlinkを除く)を探す。
ほかのマウント(`/proc`、ボリューム)には入らない。
`/dev/shm`は`/`と別のファイルシステムなので、`/`からはたどれず、起点に足す。
rootのジョブがそこに誰でも書けるディレクトリを作ると、`/tmp`の下と同じく、検査用のユーザーが名前を差し替えられるためである。
`/dev/mqueue`は見ない。ディレクトリを作れないファイルシステムで、共有の一時ディレクトリの下ではディレクトリだけを数えるためである。
ボリュームのマウントポイントそのものは見るので、`/workspaces`と`/var/lib/factory`はrootの0755にしておく。
誰でも書ける権限にすると、検査のたびに止まる。
ボリュームの中は見ないので、そこに残ったものは、導入のときに人が確かめる([前提と残るリスク](#前提と残るリスク))。
`/tmp/windmill`の下は見ない。検査の前に、所有者だけが入れる権限(0700)へ変えるためである。

共有の一時ディレクトリ(`/tmp`、`/var/tmp`、`/run/lock`、`/dev/shm`)そのものは数えない。
その下では、rootが所有し、stickyでない、誰でも書き込めるディレクトリだけを数える。
検査用のユーザーが、rootの使う名前のファイルを差し替えられる場所になるためである。
枠のuidのものは数えない。枠を取るたびに消すためである。
ただし、`/tmp/.cache`とその下では、この緩和を当てず、ファイルも含めて数える。
ベースのイメージが開いている場所で、新しいイメージはビルドで中のものまで閉じるためである。

見つかったものが`/usr/src/app`か`/tmp/.cache`のディレクトリそのものなら、イメージの問題とする。
ベースのイメージで誰でも書けるのは、この2つのディレクトリそのものだけで、下のものは閉じているためである。
新しいイメージは、ビルドで2つのディレクトリを閉じ、念のため下のものからも書き込みの権限を落とす。
それ以外は、ビルドが同じ確かめをするので、稼働中にできたものとして、実行時の問題とする。
2つのディレクトリの下にあるものも、実行時の問題とする。
イメージの問題の通知は`mise run up`の後に自動で解決されるので、稼働中にできたものをそこに混ぜると、閉じないまま通知が消えるためである。
2つのディレクトリの下にも誰でも書けるものを置く別のベースのイメージでも、検査は実行時の問題として止まる。
イメージの問題と実行時の問題が一緒に見つかったときは、両方の通知を残す。
走査がタイムアウトしたとき、`find`が0と1以外で終わったとき(シグナルでの終了を含む)、起動できなかったときも、実行時の問題とする。
途中までの結果では、見落としが無いとは言えないためである。
終了コードの1は、走査の間にエントリが消えると起きるので、出力で判断する。

走査の上限は300秒である。
稼働中のworkerで測ると、約5万7千のエントリをたどる走査が、`docker exec`の起動を含めて0.1〜0.4秒で終わった。

#### 所有権の受け渡し

所有権を渡すときは、symlinkをたどらない。
`find -P`はsymlinkに入らず、`chown -h`はsymlink自身の所有者を変える。
`-execdir`は、見つけたエントリの親ディレクトリを起点に`./名前`だけを渡す。
列挙と変更の間に、親のパスがsymlinkに差し替えられても、worktreeの外のファイルの所有者は変わらない。
ハードリンクが2つ以上あるファイルは渡さない。
worktreeの外のファイルへのリンクの所有者を変えないためである。
渡さなかったファイルはrootの所有のままで、検査コマンドは書き換えられない。

ハードリンクのあるファイルが無ければ、`chown -R -P -h --from=0:0`で一括して渡す。
`chown -R`も`fts`でfdを起点に降り、symlinkをたどらないので、差し替えへの強さは変わらない。
渡す時点では、枠のuidのプロセスは動いておらず、木はrootの所有で、列挙の間に差し替える者がいないためである。
ディレクトリごとに`chown`を起動する方法は、9,091個のディレクトリで約7秒、一括は約0.06秒だった(workerのイメージで測定)。
一括ではハードリンクのあるファイルを除けないので、1つでもあれば、ディレクトリごとの方法で渡す。
ハードリンクの確認と受け渡しは別のコマンドなので、その間にハードリンクを作られる窓がある。
前提は、渡す時点で枠のuidのプロセスが動いておらず、ほかの非特権のユーザーもこのworktreeに書けないことである。
一括の`chown -R`は、worktreeの下の別のファイルシステムにも入る。
ハードリンクの確認も`-xdev`を付けずに、同じ範囲を見る。
前提は、worktreeの下にマウントが無いことである。
マウントを作れるのはrootだけなので、検査コマンドは作れない。

`node_modules`は渡す対象から外さない。
検査コマンドは先頭で依存関係をインストールするので、検査用のユーザーの書き込みが要るためである。

#### 所有権の取り戻し

取り戻しは次の4段で行う。
rootは権限のビットを変えず、権限のビットは枠のuidとして落とす。
rootの`chmod`はコマンドラインのsymlinkをたどるので、差し替えられると任意のパスの権限が変わるためである。
rootが行うのは、`chown`と、後で述べるACLの削除だけである。
`chown -R`は受け渡しと同じく`fts`でfdを起点に降り、symlinkをたどらない。
一括の戻しは、1から3の後に行う。
木のほとんどが枠のuidの所有になっているので、ディレクトリごとに`chown`を起動すると時間がかかるためである。
一括の戻しの後に残るのは、ほかのユーザーのごく少数なので、ディレクトリごとの戻しは短く終わる。

1. rootで、枠のuidのものでないディレクトリすべてと、ほかの非rootのユーザーのものを、枠のuidに集める。書き込みかsetidのビットが立った、rootの単独のファイルも集める。
2. 枠のuidとして、所有者が入れないディレクトリを開ける。
3. 枠のuidとして、グループとその他の書き込みと、setuidとsetgidのビットを落とす。
4. rootで、枠のuidのものを`chown -R -P -h --from=<枠のuid>`で一括して戻し、続けて、残ったrootでないものをすべてrootに戻す。

1で集めるものには、検査が誰でも書けるようにしたディレクトリへ、並行して動く別の枠の検査が置いたものも含む。
取り戻した後も、rootでないものか、書き込みかsetidのビットを持つものが残っていれば、失敗にする。
並行して動く別の枠のプロセスが、途中で書き足したときに起きる。

ハードリンクは、リンク先のファイルがworktreeの外にあっても、同じファイルとして扱う。
非rootのファイルは、リンクの数によらず1で集め、最後にrootの所有になり、書き込みのビットも落ちる。
worktreeの外の同じファイルも変わるが、リンクを作れるのは、そのファイルを所有するか読み書きできるユーザーだけである(`fs.protected_hardlinks`)。
そのため、変わるのは、リンクした枠がもともと書き換えられたファイルに限られる。
rootのファイルは、リンクが1つのものだけを集める。
worktreeの外のrootのファイルの権限を変えないためである。
検査が書き込めるrootのファイルへリンクすると、そのリンクは書き込めるまま残るので、確かめで見つけて失敗にする。
書き込めるファイルをworktreeに残したまま、rootが後で読み書きしないためである。

続けて、拡張のACL(名前付きのエントリと、ディレクトリのデフォルトのACL)が残っていないかを`getfacl`で確かめる。
ACLは`chown`と`chmod`では消えない。
検査がディレクトリに`o::rwx`のデフォルトのACLを付けたまま残ると、後でrootが作るファイルに、ほかの枠から書ける権限が付くためである。
ACLはファイルの所有者が付けられ、ケーパビリティは要らない。
残っていれば、rootで`setfacl -b -k`を`find -execdir`から実行して消し、権限のビットとACLをもう一度確かめる。
rootが消すのは、すべてrootの所有で、グループとその他が書き込めない状態を確かめた後だけである。
その状態では、ほかのユーザーがエントリをsymlinkに差し替えられないので、rootの変更がworktreeの外に及ばない。
`setfacl -b`は権限のビットを変えず、グループのビットはマスクの値のまま残る。
ACLの無いファイルシステムでは、`getfacl`は何も出さないので、`setfacl`は呼ばない。
消した後もACLか書き込めるものが残れば、失敗にする。

失敗したときは枠の記録が残り、次にその枠を取る実行が取り戻し直す。

#### 検査が置いたsymlinkの検出

検査が置いた、worktreeの外を指すsymlinkは、取り戻しの後も残る。
取り戻しはsymlink自身の所有者をrootに戻すだけで、消さないためである。
rootで動く修正のClaudeが、次のラウンドでそのsymlinkをたどって`Edit`か`Write`をすると、worktreeの外に書きうる。
そのため、取り戻しの後に見つけて消す。

検出は、一覧の書き出し、一覧の大きさの抑え、一覧の欠けの検出、名前と中身の扱いと走査、消す動作と失敗の扱いの順に行う。

##### 一覧の書き出し

一覧は、`find -P`の`-fprint0`で、rootだけが入れる一時ディレクトリのファイルに書き出す。
標準出力に出すと出力の上限で省かれうるので、ファイルに書いて全件を受け取る。

一時ディレクトリは、枠の記録のディレクトリ(rootの0700)の下に、枠ごとに決まった名前(`slot-N.links`)で作る。
使う前に同じ名前の残りを消してから`mkdir`で作り、読んだ後にもディレクトリごと消す。
取り消しやworkerの再起動で消されなかった残りを、次にその枠を取る実行が片付けるためである。
枠を持たずに走査するときだけ、ランダムな名前にする。
親をrootだけが書ける場所にするのは、共有の`/tmp`のように親を差し替えられる場所だと、書き込み先を差し替えられるためである。

##### 一覧の大きさの抑え

一覧の大きさは、書き込みと読み込みの2段で抑える。

- 書き込みでは、`find`に`prlimit`の`--fsize`を付け、書けるファイルの大きさを128MiBまでにする。
  超えて書こうとすると、`find`は失敗する。
  `prlimit`には`--core=0:0`も付け、制限で止められた`find`がコアダンプを書かないようにする。
  - 書き込み量の制限で`find`が失敗したときも、出力ファイルが64MiBを超えていれば、読み込みの上限と同じく不完全として扱う。
    異常に大きい木で作業項目が停止し続けないためである。
    このとき、`find`の失敗について、秘密値をマスクした先頭1行をログに残す。
  - それ以外の`find`の失敗は、例外にして作業項目を停止する。
- 読み込みでは、読む前に`stat`で大きさを見て、64MiBを超えていたら読まずに、検出が不完全だったものとして扱う。
  読んだ後のBufferと文字列と配列が同時に生きるので、メモリを抑えるためである。
  一覧を読めなかったときも、検出が不完全だったものとして扱う。

##### 一覧の欠けの検出

`find`の終了コードだけに頼ると、一覧の後半が黙って欠け、外向きのsymlinkを見逃す。
そのため、欠けは次の2つで見つける。

- 末尾の確認では、読んだ一覧が空でなく、末尾が`\0`でなければ、途中で切れているとみなす。
  最後の断片は名前として扱わず、検出が不完全だったものとして扱う。
- 件数の突き合わせでは、`find`が`-printf .`で、見つけたsymlinkごとに標準出力へ1バイトを出す。
  この数と、一覧の名前の数が違えば、検出が不完全だったものとして扱う。
  標準出力が上限で省かれたときも同じである。

##### 名前と中身の扱いと走査

- 名前と中身は、バイト列のまま扱う。
  `\0`で区切り、`readlink`と`realpath`と`unlink`には、バイト列のパスをそのまま渡す。
  UTF-8でない名前やU+FFFDを含む名前は、別々の名前として照合でき、それだけでは不完全にならない。
- 準備で、枠の記録を書いた後の、渡す前のworktreeから、外を指すsymlinkを名前と中身の組で控える。
  控えの収集が失敗しても、枠は後始末で手放される。
  控えの収集が不完全だと、準備の時点にあった外向きの追跡symlinkが、新しく置かれたものとして消される。
  不完全の条件は、後述の「検出が不完全だった」と同じである。
  消す方向の動きなので安全側であり、意図どおりである。
- 取り戻しの後に、同じ走査をする。
  控えに無い組は、新しく置かれたものとして消す。
  控えにある名前で中身が変わった組は、消さずに、控えた中身で張り直す。
- 指す先は、中身を1要素ずつたどって決める。
  存在する要素は`realpath`で解き、`..`は解いた後の親に進む。
  `..`を含むパスは`realpath`に渡さない。
  実行系によって、途中のsymlinkを経由する`..`の解き方が違うためである。
- 途中でworktreeとその祖先の外に出たら、戻ってくるとしても外とみなす。
  外のディレクトリは、検査に差し替えられている恐れがあるためである。
- 次の場合は、決められないので外とみなす。
  - 先が無い要素の後ろに、`.`か`..`が続く。
  - 先が無い要素を、symlinkと見分けられない。
  - `realpath`が、名前が長すぎる、または輪になっているために解けない。
- 解く途中の予期しない失敗(権限など)も、止めずに外とみなし、ログに残す。
  1件の失敗で、ほかのsymlinkを調べ損ねないためである。
  ログには、エラーの種類だけを載せる。
  symlinkの中身が、例外のメッセージ経由で出ないようにするためである。
- 中身の要素が1,000を超えるものは、たどれないので外とみなす。
- 走査には60秒の上限を設ける。
  超えたら、検出が不完全だったものとして扱う。
- 木はrootの所有で書き込めない状態なので、決める間にsymlinkが差し替わらない。

##### 消す動作と失敗の扱い

追跡されている正当なsymlinkは、準備の時点で既にworktreeにあるので、控えに入って数えない。
追跡の有無をgitに問わないのは、検査が書き換えたworktreeの設定を、rootのgitが読まないためである。
追跡されている内向きのsymlinkでも、検査が途中のディレクトリを外向きに差し替えると、外に解決される。
その場合は消す。
外に解決される以上、消すほうが安全だからである。
控えは外向きのsymlinkだけなので、内向きの追跡symlinkを検査が同じパスで外向きに書き換えると、控えに無いものとして消されるだけで、失敗にはならない。
消されたsymlinkは、差分に削除として残る。
控えを全symlinkに広げると、node_modulesのように多い木でコストが大きいため、広げない。

消すのは、木がrootの所有になり、枠のuidが書けなくなった後で、symlink自身だけである。
たどらない。
`python3 -m venv`や`uv venv`のように、正当な道具も外を指す絶対パスのsymlinkを置く。
そのため、消しただけでは検査を失敗にしない。
消したパスはログに残す。
そのうち、中身がHOMEの外にあるものを調べる。
中身がシステムのインタープリタの置き場(`/usr/bin`、`/usr/local/bin`、`/bin`)の下でもなければ、疑わしい外向きのsymlinkとして区別してログに残す。
ログに載せるのはパスだけで、中身は載せない。

次の場合だけ、検査の結果に失敗した検査を1件足す。
ほかの検査の失敗と同じに、修正のClaudeへ渡る。

- 検出が不完全だった。
  次のどれかである。
  - 一覧が大きすぎるか、読めないか、末尾で切れているか、件数が目印と合わない。
  - 中身を読めないパスがある。
  - 消せなかったsymlinkがある。
  - 走査の時間の上限を超えた。
  パスの長さがPATH_MAX(4096バイト)以上のsymlinkは、`readlink`にパスで渡せず、中身を読めないパスになる。
- 追跡されているsymlinkの中身が書き換えられた。
  消すと差分に意図しない削除が出る。
  そのため、控えた中身で張り直し、失敗にする。

検出が不完全なら、失敗として報告する前に、危険なsymlinkをまとめて消す。
`find -lname`で、中身が絶対パスか`..`を含むsymlinkを、すべて消す。
`find`は名前をバイトのまま扱うので、名前の文字コードと長さに依らない。
`-delete`は親のfdを起点に消すので、差し替えられてもたどらない。
消えるのは、中身が絶対パスか`..`を含むsymlinkすべてである。
内向きでも、追跡されていても消える。
追跡された内向きのsymlinkも、中身に`..`を含めば消える。
消えた追跡symlinkは、worktreeの差分に削除として出る。
戻すのは、使い回しの経路の`reset --hard`だけである。
それまでの差分には、削除が残る。
後始末の`find`が失敗したら、例外にして作業項目を停止する。
rootのClaudeのラウンドへ進ませないためである。

走査そのものが投げる場合も、例外のまま作業項目を停止する。
`find`の失敗と、worktreeの正規のパスを決められない場合である。
失敗した検査には畳まない。
走査できていない木を、rootのClaudeのラウンドへ渡さないためである。

失敗にする場所は、取り戻しの後の呼び出し側で、取り戻しの中ではない。
取り戻しの中で失敗にすると、枠の記録が残り、次にその枠を取る実行が同じworktreeを取り戻し直すためである。

走査と後始末は、取り戻しの後も、枠のロックを持ったまま行う。
ロックを手放した後に行うと、ほかの実行が同じ枠を取り、残っている記録を、壊れた前の実行のものと見て回復してしまうためである。
その回復は、正常な実行のworktreeを掃き、並行する削除で走査を失敗させる。
回復が途中で失敗すると、worktreeが枠のuidの書ける状態のまま、どの記録からも指されなくなる。
そのため、枠を手放すのは、走査と後始末が終わり、記録を消した後である。
走査が長いと、その枠を待つ実行の待ちが延びうる。

走査か後始末が投げたときは、記録を残して枠を手放す。
手放す処理は投げず、例外を保持して、`escapingSymlinks`が投げ直す。
作業項目は止まり、次の回復が記録を頼りに掃く。
控えを取る前に準備が失敗した実行は、走査をしないので、手放すときに記録を消す。

取り消し、タイムアウト、取り戻しの失敗、走査の前の中断で検出まで進まなかった実行は、次にその枠かそのworktreeを使うときの回復の経路で取り戻す。
その経路でも、取り戻しの後に、`find -lname`で同じ後始末をする。
検査が置いた外向きのsymlinkが、次の準備で控えに入って、消されずに残るのを防ぐためである。
後始末が失敗したら、例外にして枠の記録を残し、次の実行が取り戻し直す。

既知の限界は次のとおりである。

- 回復の経路の後始末は、追跡されている正当な外向きのsymlinkも消しうる。
  再利用されるworktreeは、使い回しの経路が`git fetch`の後に`reset --hard`と`clean`を行うので、追跡されているsymlinkは戻る。
  ただし、gitが無視するパスのsymlinkは、`clean`の対象外なら戻らない。
- パスの長さがPATH_MAX以上のsymlinkは、パスでは読めず、`unlink`にもパスで渡せない。
  そのため、検査としては「不完全」の失敗になり、後始末の`find`がsymlinkを消す。
  準備の時点にこのsymlinkがあると、毎回失敗になる。
- 枠を持たない走査のランダムな名前(`scan-<uuid>.links`)の一時ディレクトリは、実行が途中で殺されると残りうる。
  残りは最大でも書き込み量の制限(128MiB)の大きさで、頻度は低いので、受け入れる。
- `pr_fix`では、後始末で`.venv/bin`のsymlinkが消えるので、仮想環境を作らずに使う検査コマンドがあるリポジトリでは、検査が失敗しうる。

#### 枠の記録と片付け

取り消し、タイムアウト、workerの再起動で後始末が走らないと、worktreeと`HOME`が枠のuidの所有のまま残る。
そのままだと、同じ枠を次に取る別のリポジトリの検査が、古いworktreeを書き換えられる。
そのため、所有権を渡す前に、枠の記録(`/var/lib/factory/check-slots/slot-N.state`、rootの0600)へworktreeと`HOME`のパスを書く。
記録は、後始末と、続く外向きのsymlinkの走査が最後まで終わったときだけ消す。
走査の間も、枠のロックは持ち続ける。

記録は、書く前に、読み直せる形(正規化された2段以上の絶対パス)かを確かめる。
読めない記録を書くと、その枠を取るたびに片付けが失敗するためである。

枠を取った実行は、ロックを持ったまま、次の順で片付けてから使う。

1. 枠のuidのプロセスをすべて止める。枠のロックを持つ間、残っているのは終わった実行のものだけだからである。
2. 記録があれば、そのworktreeの所有権を取り戻し、`HOME`を消し、記録を消す。
3. 共有の一時ディレクトリから、枠のuidのファイルとディレクトリを消す。消し切れなければ失敗にする。
4. 枠のuidが所有するか作ったSystem VのIPC(共有メモリ、セマフォ、メッセージキュー)を消す。workerのrootは`CAP_IPC_OWNER`を持たないので、枠のuidとして消す。

2で記録が読めなければ、記録を`slot-N.state.corrupt-<時刻>-<乱数>`へ退避する。
続けて`check_slot_record_unreadable`のnoticeを残し、記録が無いものとして片付けを続ける。
読めない記録を残すと、その枠を取るたびに片付けが失敗し、枠をずっと使えなくなるためである。
記録が指していたworktreeは自動では戻らないので、人が片付ける([運用](operations.md#検査の枠の記録を片付ける))。

片付けに失敗した枠は手放し、`check_slot_skipped`のnoticeを残して次の枠を試す。
例えば、止まらないプロセス(D状態など)が残ると、片付けに失敗する。
すべての枠で失敗すれば、検査を失敗させる。

`HOME`は`rm -rf`で消す。GNUの`rm`は`openat`で降り、symlinkをたどらない。
後始末に失敗した実行は`HOME`を消さず、記録を通して次の片付けに任せる。
止まらないプロセスが書き換えている木を、rootでたどらないためである。

worktreeを次に使うときにも片付ける。
関係するプロセスが走査で見えないと分かった後に、記録がそのworktreeを指す枠のロックを取り、上の1と2を行う。
worktreeのロックが塞がっているのに保持者が見えないときも行う。取り消された検査が別のセッションに残したプロセスが、worktreeのロックを持ち続けることがあるためである。
1でそのプロセスが止まるので、ロックが空く。
枠のロックを最大5秒待っても取れなければ、記録を読み直す。
記録がもうそのworktreeを指していなければ、ロックを持つ実行が片付けを終えたので、先へ進む。
まだ指していれば、worktreeには触れず、使用中として引き返す。
その枠を持つのは、そのworktreeで検査している実行か、その枠を取って記録を片付けている実行だからである。
プロセスを止められないか、取り戻しが失敗したときも、使用中として引き返す。
理由には、枠のユーザーと失敗の詳細が載り、準備は人の対応待ちになる。
読めない記録は、どのworktreeを指すか分からないので飛ばす。
ただし、読めない記録があってworktreeにrootでないものが残っていれば、その記録がworktreeを指していたとみなす。
このときは、記録のパスを載せて使用中として引き返す。
rootでないものが残ったworktreeでは、rootのgitが所有者の違いで実行を拒み、理由の分からない失敗になるためである。
記録の読み取りのそれ以外の失敗は、そのまま例外にする。
記録がそのworktreeを指すと分かったら、枠のロックを取る前に、イメージの前提を確かめる。
満たさなければ、所有権と記録のどちらにも触れずに止まり、要対応の通知`host_action_required`を残す。
古いイメージには取り戻しの道具が無く、途中で失敗すると、取り戻しの失敗と区別できないためである。
記録は残るので、イメージを作り直した後に同じ手順で取り戻す。
この確認は、worktreeを使うステップの準備と完了の前と、掃除が行う([実装フロー](internals/implement.md#残った所有権の復旧))。

#### プロセスの止め方

枠のuidのプロセスは、枠のuidとして`kill -9 -- -1`を送って止める。
`kill -1`は、送り手が送れるすべてのプロセスに送り、送り手自身には送らない。
枠のuidとして送るので、rootのプロセスと別の枠のプロセスには届かない。
1回のシグナルで、その時点で生きているものがすべて止まるので、止める間に子を作り続けるプロセスにも追い越されない。
`/proc`で枠のuidの生きたプロセスが見つからなくなるまで、100msおきに送り続ける。30秒を過ぎても残れば、止められないものとして失敗にする。
この操作は、枠のロックを持つ間にだけ行う。ロックを持たずに行うと、並行して動く別の検査を巻き込むためである。

検査のコマンドには、実行ごとの目印として、補助グループの大きなgidを1つ付ける。
子孫に受け継がれ、検査用のユーザーは`CAP_SETGID`が無いので外せない。
別のセッションに抜けたプロセスも、`/proc/<pid>/status`の`Groups`行で、どの実行が起動したかを見分けられる。
止める対象は目印ではなくuidで選ぶ。枠を取るときに前の実行の残りを止めるので、枠のロックを持つ間の枠のuidのプロセスは、その実行のものだけだからである。

workerには`CAP_SYS_PTRACE`が無いので、別のuidのプロセスの環境変数とfdは読めない。
プロセスロックの走査は、枠のuidで動くプロセスを一覧に入れない。
どのworktreeの検査かを特定できず、一覧に入れると無関係なworktreeの走査まで塞ぐためである。
目印のgidを記録に残して走査で照らし合わせる形は採らない。枠のロックを取れるかどうかで、そのプロセスを起動した実行が終わったかが分かり、記録から止められるためである。

#### プロセス数の上限の決め方

枠ごとの上限(`CHECK_NPROC_LIMIT`)と、workerのコンテナのpidsの上限は、次の関係を保つ。
`tests/infra/docker_compose.test.ts`がこの関係を確かめる。

```text
NUM_WORKERS × CHECK_NPROC_LIMIT + 検査の外に残す数 ≦ pids
3 × 256 + 256 = 1024
```

workerは`NUM_WORKERS`の数だけジョブを同時に動かすので、検査も同じ数まで重なる。
カーネルは枠のuidごとに数えるので、検査がそろって上限まで使うと、その合計がコンテナのpidsを使う。

検査の外に残す数は256である。
動いているworkerのpidsは、待機中が53、起動からの最大が112だった。
Windmill本体、ジョブのbun、Claude、gitが使う分で、その2倍強を残す。
片付けられなかった枠を飛ばしても、止まらないプロセスが残っていれば、その枠の分(最大256)も、この残りから使う。
そのため、枠を飛ばしたときの通知`check_slot_skipped`は、workerの再起動を求める。

pidsの上限はコンテナごとで、同じDockerのVMの別のコンテナは数えない。
VM全体の上限は別にあり、測ったVMでは`kernel.threads-max`が64,272、`kernel.pid_max`が4,194,304だった。
そのとき、すべてのコンテナのタスクの合計は約500で、上限には遠い。
一方、枠ごとの上限(`RLIMIT_NPROC`)は、コンテナではなく実uidごとにVM全体で数える。
別のコンテナが枠と同じuid(既定は10001〜10008)でプロセスを動かすと、その数も枠の上限を使う。

枠ごとの上限は、workerのイメージの使い捨てのコンテナで、検査コマンドが同時に持つタスク(プロセスとスレッド)の最大を測って決めた。
測ったのは次の値で、測る道具自身の約7を含む。
対象はatelier-worksのリポジトリと、`net/http`を使う小さなGoのモジュールである。

| コマンド | 1コア | 4コア | 12コア |
| --- | --- | --- | --- |
| `bun install --frozen-lockfile` | 13 | 15 | 23 |
| `bun test` | 25 | 31 | 41 |
| `tsc --noEmit` | 12 | 15 | 28 |
| `biome check .` | 16 | 19 | 27 |
| `go build`(キャッシュが空) | 測っていない | 48 | 112 |

どれもコア数とともに増え、`go build`が最も多い。
`go build`はコアの数だけコンパイラを並べ、それぞれがスレッドを持つためである。
測ったのは、Dockerに12コアを割り当てたVMである。
上限を256にすると、`go build`も20コア台まで収まる。
それより多いコアで上限に達するときは、検査コマンドを`go build -p 8`のように並列の数を絞った形にする。

#### main cloneの保護

main cloneの`.git`はrootが所有する。
検査用のユーザーは、`config`、`hooks/`、`info/attributes`、worktreeごとの`config.worktree`を書き換えられない。
そのため、検査コマンドがgitの設定を書き換えて、rootのgitに実行させる経路は無い。
検査コマンドの中のgitは、indexを書けないので`git add`と`git commit`が失敗する。`git status`と`git diff`は動く。

#### 前提と残るリスク

前提は次のとおりである。

- ホストのカーネルで`fs.protected_hardlinks`と`fs.protected_symlinks`が1である。他のユーザーのファイルへのリンクを作らせないためである。1でなければ、検査の実行のたびにnoticeへ警告を足す。検査は止めない。
- Docker Engineがuser namespaceの再マップ(userns-remap)やrootlessで動いていない。再マップがあると、目印の補助グループが設定できず、検査が失敗する。検査が失敗するだけで、安全側に倒れる。
- `allowed_check_commands`と`check_commands_by_repo`に、`.git`へ書き込むコマンドを置かない。
  `git add`、`git commit`、`git stash`、lint-stagedなどである。
  main cloneの`.git`はrootの所有なので、検査用のユーザーでは失敗する。
- 次の変更の前に、枠の記録が残っていないことを確かめる。
  枠の数(`FACTORY_CHECK_POOL_SIZE`)を減らす、先頭のuid(`FACTORY_CHECK_UID`)を変える、検査を枠のユーザーで動かす前の版へ`f/`を戻す、の3つである。
  範囲の外の枠の記録と、前の版が読まない記録は、どの実行も片付けないためである。
  手順は[運用](operations.md#検査の枠の記録を片付ける)にある。
- 検査を枠のユーザーで動かす前にrootが作った、誰でも書けるworktreeやファイルが、`/workspaces`と`/var/lib/factory`に残っていない。
  実行時の前提の確かめはボリュームの中に入らないので、残っていても止まらず、検査用のユーザーがそこへ書き込めるためである。
  導入のときに、イメージを作り直す前と後に、ボリュームの中を走査して閉じる([運用](operations.md#稼働中のworkerの状態の確かめ方))。

残るリスクは次のとおりである。

- 検査用のユーザーは、`/workspaces`の下の他のリポジトリのcloneとworktreeを読める。cloneのURLにトークンは無い。`/workspaces/<owner>/<repo>`を0700にすると、worktreeの受け渡しと衝突しやすいので、今は受け入れる。
- 並行して動く検査の間でも、worktreeのファイルは読める。書き込めるのは、検査が権限のビットかACLで誰でも書けるようにしたものだけで、そこに置かれたものは取り戻しでrootに戻り、ACLも消える。ハードリンクで置かれたものは、worktreeの外のリンク先ごとrootに戻る([所有権の取り戻し](#所有権の取り戻し))。HOMEは他の枠から書けないが、0755にされると読める。
- 検査コマンドは、workerと同じコンテナとnetworkで動く。DBとWindmillの宛先に届く。認証に使う秘密には届かないが、認証が要らない経路には届く。
- メモリとCPUはworkerと共有する。検査コマンドがworkerのジョブを枯渇させうる。プロセス数は、検査がそろって上限まで使っても検査の外に256が残るように抑える。
- 検査のプロセス自身は、worktree、`HOME`、共有の一時ディレクトリの外に書けない。
  ただし、検査がworktreeの中身を書き換えた結果は、次のラウンドでrootの処理に影響しうる。
  例えば、gitが無視するパス(`node_modules/`など)に、worktreeの外を指すsymlinkを置ける。
  取り戻しはsymlinkの所有者をrootに戻すが、symlink自体は消さない。
  そのため、取り戻しの後に、worktreeの外を指すsymlinkを調べて消す([検査が置いたsymlinkの検出](#検査が置いたsymlinkの検出))。
  失敗にするのは、検出が不完全だったときと、追跡されているsymlinkが書き換えられたときだけである。
  取り戻しが失敗した実行と、取り消された実行は検出まで進まない。
  その場合は、回復の経路が取り戻した後に、絶対パスか`..`を含むsymlinkをすべて消す。
  実装フローは、次の検査の前の`git clean -fdX`で、無視されるパスのsymlinkを消す。
- 共有の一時ディレクトリとSystem VのIPCは、並行して動く別の枠の検査と共有する。権限で開いたものは、別の枠から読み書きできる。同じuidを次に使う実行には、枠を取るときに消してから渡す。
- `/proc/<pid>/cmdline`は誰でも読める。workerのプロセスの引数に秘密を載せない。
- `/var/lib/factory`の`requirements`と`audits`は0755で、検査用のユーザーが読める。`claude`は一覧を読めるが、中のファイルは0600である。
- Windmillが`/tmp/windmill`の権限を戻す契機は確かめていない。戻ると、その間だけ上の保護が外れる。検査の前には、毎回0700へ直す。
- 共有の一時ディレクトリの下にある、rootが所有する誰でも書き込めるファイルは数えない。検査用のユーザーは、その中身を書き換えられる。
- workerのジョブは`HOME`が`/root`で、`TMPDIR`が無い。
  共有の`/tmp`に作られる一時ファイルは、まだ無い名前なら検査用のユーザーが先に作れ、その後でrootのジョブがそれを使いうる。
  そのため、ジョブごとに`/run/factory-tmp/fj-<ジョブID>`を0700で作り、一時ファイルをそこへ向ける。
  親は、Windmillが管理する`/tmp/windmill`ではなく、rootが所有して他のユーザーが書けない`/run`の下に置く。
  `/tmp/windmill`の権限はWindmillがジョブの途中で戻しうるので、それに頼らない。
  - ここを使うのは、git、gh、`wmill`の子プロセスの`TMPDIR`、Claudeの`TMPDIR`と`CLAUDE_CODE_TMPDIR`、gitleaksの設定のディレクトリである。
  - Claude Codeが`TMPDIR`に従うかは確かめていないので、`CLAUDE_CODE_TMPDIR`にも同じ場所を渡す。
  - `/run/factory-tmp`はジョブが作る。rootの所有なら、0700でなくても0700に直して使う。他のユーザーの所有かsymlinkなら、ジョブを失敗させる。
  - 既にあるジョブ用のディレクトリが、他のユーザーの所有か、他のユーザーに開いているときも、ジョブを失敗させる。
  - ジョブのIDが読めないときは、共有の`/tmp`を使うことを警告に残し、ジョブは止めない。
  - ジョブの終了時に、プロセスの終了処理でディレクトリの削除を試みる。
  - 消えなかったものは、毎日の作業領域の掃除が、3日を過ぎてから消す。取り消しやworkerの強制終了で終了処理が走らなかったものも、ここで消える。
    掃除も、消す前に`/run/factory-tmp`を同じ基準で確かめ、満たさなければ何も消さない。
    ジョブ用のディレクトリが他のユーザーの所有か、他のユーザーに開いているときも、rootでは消さずに失敗として残す。
    3日は、`claude_timeout_sec`と`implement_timeout_sec`の既定値より十分長い。設定がこの3日を超える値は、設定の検証が拒否する。
  - `TMPDIR`を渡さないworkerのプロセス自身(Windmillとbunの依存の取得など)は、共有の`/tmp`を使う。
  - ClaudeのBashツールが固定の名前で`/tmp`の下に書く場合は、`TMPDIR`では塞げない。
  - 検査の準備が`lockDownRuntimeDir`で閉じるのは`/tmp/windmill`だけで、`/run/factory-tmp`には触れない。
  - 検査用のユーザーが共有の`/tmp`に作ったものは、枠を取るときと手放すときに消える。
- 取り消されたジョブが残した、枠のuidの孤児プロセスは、同じ枠が次に使われるか、そのworktreeが次に使われるまで残る。その間は、記録したworktreeと`HOME`を書き換え、共有の一時ディレクトリにファイルを作りうる。取り消されたジョブでは手放すときの片付けが走らないので、共有の一時ディレクトリのものは、同じ枠が次に使われて消されるまで残る。片付けでプロセスを止めてから取り戻すので、次にそのworktreeを使う実行と、その枠の次の利用者には引き継がれない。
- 所有権の受け渡しと取り戻しは、ディレクトリの数に比例して時間がかかる。
  取り戻しは常に一括で、受け渡しもハードリンクが無ければ一括なので、9,091個のディレクトリで`chown`は0.1秒に満たない。
  残りは`find`と`getfacl`でたどる時間である。
  取り戻しでは`find`で5回、`getfacl`で1回たどり、ACLが残っていれば`find`と`getfacl`でさらに3回たどる。
  ハードリンクのあるファイルがあるworktreeでは、受け渡しがディレクトリごとになり、9,000個で約5秒かかる。
  1回の上限は300秒なので、超えると打ち切られて検査が失敗する。
  ディレクトリごとの受け渡しでは、50万個が目安である。
  打ち切られると記録が残り、次にその枠を取る実行と、そのworktreeを次に使うステップの片付けも、同じ上限で失敗し続ける。
- 一括の受け渡しと戻しは、worktreeの下にマウントが無いことを前提とする。
  `chown -R`には`-xdev`に当たるものが無く、別のファイルシステムのマウントがあれば、そこへ入るためである。
- コンテナで共有するカーネルの脆弱性による脱出は防げない。

これらは、検査コマンドを別のコンテナで、networkなしに動かすまで残る。
`scripts/verify-check-sandbox.sh`(`mise run test:check-sandbox`)が、上の表の項目を確かめる。
成功、失敗、タイムアウトする検査も確かめる。
`git status`、`git diff`、`bun test`を使う検査も確かめる。
枠の取得と待ちと解放、取り消された実行の後の片付け、共有の一時ディレクトリとIPCの片付け、別の枠が書き足したものの取り戻しも確かめる。
検査が付けたACLの削除、子を作り続けるプロセスの停止、読めない記録の退避、worktreeのロックを持ったまま残ったプロセスの片付けも確かめる。
プロセス数の上限、終わった検査が共有の一時ディレクトリに残したものの削除、イメージの前提も確かめる。
走らせている側が殺されても、別のセッションに抜けた検査のプロセスが枠のロックを持ち続けないことも確かめる。
workerと同じ制限の使い捨てのコンテナで、実際のsetpriv、flock、chown、`/proc`を使う。

### 対象リポジトリの設定を信頼しない

対象リポジトリの`mise.toml`や`package.json`のscriptsは、信頼できない入力として扱う。workerのmiseは対象リポジトリの`mise.toml`を信頼しない。信頼が無いと動かない検査コマンドは実行せず、止めて報告する。

### 保護パスの変更を止める

保護パスを変更したら、修正を止める。保護パスは`.claude/`、`.agents/`、`mise.toml`、`lefthook.yml`、`package.json`のscripts、新しい`*.sh`などである。
CIのワークフローとcomposite action(`.github/workflows/`と`.github/actions/`)も含む。
これらはFactoryやCIが実行する設定で、書き換えられるとコードを実行されるためである。
markdownlint-cli2とtextlintの設定(`.markdownlint-cli2.jsonc`、`.textlintrc.json`など)も止める。どちらも設定から任意のモジュールを読み込め、pre-commitと`mise run check`が読むためである。
Consoleでバンドルを通らずに配信される`console/public/`と`console/index.html`も止める。
配信するdraw.ioのビューアを固定する`console/drawio-viewer.json`も止める。
固定を書き換えるPRを作る側も止める。
対象は、`f/factory/drawio_viewer_bump`のscript、スケジュール、script定義(`.script.yaml`)である。
`f/factory/lib/`では、次の3つが対象である。

- `drawio_viewer_bump.ts`
- `drawio_viewer_bump_github.ts`
- `drawio_viewer_observations.ts`

この3つのscript定義(`.script.yaml`)と、観測の記録を除く2つのlock(`.script.lock`)も対象である。
lockの保護を限る理由は、残るリスクに書いた。

固定を強制し、配信物を作って検査するスクリプトも止める。
図を隔離して描くiframeの検査(`tests/lib/drawio_frame_isolation.test.ts`)も止める。一覧は`f/factory/lib/protected_paths.ts`の`FORBIDDEN_EXACT_PATHS`にある。
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
どちらも書き換えられると、`-c`では`config.worktree`の読み込みを止められない。
検査コマンドは別のuidで動き、書き込めない。書き込める経路が増えたときに備えて固定する。
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
検査コマンドは検査用のユーザーで動き、main cloneの`.git`に書き込めない([検査コマンドの権限](#検査コマンドの権限))。
そのため、検査コマンドが`.git/config`を書き換えて、`GH_TOKEN`を持つgitにプログラムを実行させる経路は無い。
検査コマンドが書き換えられるworktreeの`.git`ファイルは、記録との照合で止める。

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

### 取り込み後のIssueの書き換え

Claudeに渡すIssueの題名と本文は、作業項目に取り込んだものである。承認の後にIssueを書き換えても、プロンプトには入らない。現在のIssueは、openかどうかの確認と、PR本文の注記にだけ使う。

取り込んだ内容が変わる経路は、却下や再実行による作り直しだけである。
作り直しの前に、取り込んだ題名と本文を現在のIssueの内容へ更新する([作業項目の状態とリース](internals/work-items.md)の「却下と再生成」)。
却下の理由がIssueの書き換えのとき、作り直した要件定義を承認できるようにするためである。

承認者が見ていない内容が渡らないよう、次の策を重ねる。

- Consoleの要件定義の承認画面に、取り込んだ題名と本文を出す。更新後の内容は更新後の値で出し、更新したことを警告で示す。
- 同じ画面に、承認する試行の要件定義書を並べる。取り込んだ内容と要件定義書の両方を見られるまで、承認を押せない。承認の試行が分からないときは、最新の試行で代えず、承認を止める。
- 要件定義の承認では、決定を記録する前に現在のIssueを取り込んだ内容と比べる。違うときと、比べられなかったときは、承認を断る。比べる処理は`approval_decide`の中で、`github_token`を使ってGitHubのREST APIを`fetch`で読む。Console用のworkerの`github_token`の扱いは[Console用workerの境界](#console用workerの境界)に書く。
- 取り込んだ内容を更新したときは、`work_item_events`に文字数とハッシュを残し、noticeとDiscordで承認者に知らせる(再実行ではnoticeだけ)。更新後の内容は信頼できない入力なので、履歴にはそのまま入れない。
- 更新したことのある作業項目のPR本文には、「確認して欲しい点」に注記を必ず出す。更新後の内容と現在のIssueを比べる注記では、更新のときの書き換えを拾えないためである。

次のことは、この策では守れない。

- 確認から決定の記録までの間のIssueの書き換えは防げない。承認者が見た内容のハッシュに結び付ける案は、`approval_decide`がそのハッシュを受け取らないので、今は採れない。
- 承認者は、Consoleの要件定義の承認画面で、取り込んだ内容と更新の警告を確かめて承認する。Consoleは、取り込んだ内容を表示できないあいだ、承認を押せないようにする。確かめずに承認しても、承認の前の確認が働くので、承認の時点で書き換わっているIssueは通らない。ただし、却下を挟むと、書き換え後の内容が取り込み直されて承認画面に出るので、確かめずに承認すると書き換え後の内容が実装に渡る。通知とPR本文の注記が緩和する。
- Claudeに渡す題名と本文から、不可視の文字(tag文字、ゼロ幅の文字、双方向の制御文字など)を除いていない。Consoleは置き換えて警告を出すが、Claudeには置き換える前の内容が届く。除く処理は別に扱う。
- 本文が長いとき、Consoleは先頭だけを表示する。表示していない後ろの部分は、Consoleでも、MarkdownとしてHTMLのコメントや不可視の文字を描かないGitHubの画面でも、確かめられない。後ろの部分にある`<!--`と不可視の文字の数を数えて警告するが、内容そのものは確かめられない。

### 同じ作業項目を同時に実装しない

同じ作業項目の実装フローは、同時に1つしか作業しない。フローのジョブIDをリースとして扱い、worktreeとClaudeのプロセスにはロックファイルを持たせる。Windmillでジョブを取り消しても、Claudeや検査コマンドのプロセスは止まらないためである。

### 承認済みの要件定義を書き換えさせない

Claudeには、要件定義のディレクトリを一時ディレクトリに複製して渡す。Consoleが表示する承認済みの文書は渡さない。複製にはsymlinkを写さないので、Claudeが文書の外のファイルに書き込む経路は残らない。

### 検査コマンドを明示したリポジトリだけで実行する

検査コマンドは、Claudeが書いたコードをworkerの中で、非特権のユーザーとして、コンテナの分離なしに実行する([検査コマンドの権限](#検査コマンドの権限))。
そのため、`check_commands_by_repo`にそのリポジトリのコマンドを明示したときだけ実行し、`allowed_check_commands`は使わない。
networkとworkerの資源を共有するので、Issueを信頼できる人だけが起票するリポジトリにだけ設定する。

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
検査コマンドが別のセッションに抜けたときは、枠のuidのプロセスとして止める([プロセスの止め方](#プロセスの止め方))。

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
| 人の承認が最後のゲート | 検査に通った提案も、Consoleの要対応で人が承認するまでIssueにならない。承認された提案だけが`factory_repo`にIssueとして起票される |

self cloneは`self_update`のデプロイ元なので、Claudeに書き換えられないよう直接は渡さない。

## 承認と権限

承認できるのは、`f/factory/**`のスクリプトを実行できるアカウントである。実行の権限はフォルダ`f/factory`の権限で決まり、このフォルダには所有者も追加の権限も付けていないので、ワークスペースの管理者だけが該当する。

承認は必ずConsoleの要対応(`approval_decide`を実行する)から行う。Windmillのapproval pageのURLは署名付きのcapability URLなので、PRのコメントやDiscordの通知に載せない。approval pageのURLから直接resumeすると承認の状態が記録されず、作業項目は人の対応待ちになる。

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
イベントの取得に失敗したときは、noticeを増やさず、失敗の記録を残す。Consoleの**システム**の「作業項目に紐づかない失敗」に出る。
記録されるステップ名は、Issueが`fetch_labeler:<owner>/<repo>#<番号>`、PRが`fetch_pr:<owner>/<repo>#<番号>`である。

付与者を判定できないときは、失敗ではなく、noticeの`labeler_check_limit`を1回だけ記録する。
本文は対象とラベルだけで決まり、同じ本文の未解決のnoticeがあるあいだは追加しない。
次の操作として、ラベルを外し、許可された人が付け直すことを示す。
付け直すと、トリガーラベルの新しい`labeled`イベントが直近100件に入り、判定できるようになる。
人がラベルを外して付け直すまで、ポーリングのたびに同じ取得を繰り返す。
noticeは、対応した後にConsoleで解決する。

判定から取得までには時間差があるので、取得の直前に同じ確認をもう一度行う。
拒否されたときは、取得せずに`labeler_denied`を記録する。
取得できなかったときは、取得せず、失敗の記録に`confirm_labeler:<owner>/<repo>#<番号>`として残す。Consoleの**システム**の「作業項目に紐づかない失敗」に出る。
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
- ラベルを付けた後から、いずれかの却下までの間に、起票者がIssueの本文を編集できる。
  取得の時点の本文が`work_items.body`に保存されるので、取得までの編集は要件定義の入力になる。
  却下や再実行による作り直しでは、その時点のIssueの内容が取り込み直されるので、窓は取得までから、却下までに広がる。
  起票者を信頼せず、ラベルを付ける人が内容を確かめる前提は、却下を挟むと弱まる。
  更新を承認者に知らせる通知(Discordとnotice)、Consoleの承認画面の警告、PR本文の注記で緩和している。
- 却下の理由が`intake refreshed from the current issue`で始まると、更新していなくても、取り込み直しの印として数えられ、警告とPR本文の注記が出る。
  警告が増える方向だけの誤りなので、許容する。
- 起票者がIssueを書き換え続けると、承認を止め続けられる。
  書き換えのたびに承認が断られ、却下で作り直すとClaudeの実行と試行が1回ずつ減り、`max_attempts`に達すると人の対応待ちになる。
  起票者を信頼できないリポジトリ、特に公開リポジトリを対象とする前には、ラベルを付けた後のIssueをロックし、編集を止める運用を決める。
  Issueの「Lock conversation」が起票者の本文の編集を止めるかは未確認である。採用の前に確かめる。
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
