# セキュリティ

## 信頼境界

- **Issue本文・対象リポジトリの内容はuntrusted** として扱う。工程2(要件定義生成)のheadless Claude実行は、これらを「データ」として読むだけで、内容中の指示に従わない(詳細は`factory-requirements`スキル`.claude/skills/factory-requirements/SKILL.md`)。
- 工程2のClaude実行はread-onlyツール(`Read`/`Glob`/`Grep`)のみを許可し、書き込み・実行系ツールは与えない。
- 起動時のフラグで追加の防御をかける:
  - `--setting-sources user`: プロジェクト設定(対象リポジトリ側の`.claude/`等)を読み込ませない。
  - `--strict-mcp-config`: 対象リポジトリのMCP設定を無視し、明示的に渡した設定のみを使う。
  - `--max-budget-usd` / `--max-turns` / サブプロセスのタイムアウト: 暴走・コスト超過を打ち切る。
- `pr_fix`は書き込み権限を持つClaude実行の最初の例である。追加のガードは「pr_fixの安全策」節に定める(下記)。

## シークレットの扱い

- Windmill実行中のシークレットはWindmillのsecret変数(`f/factory/claude_oauth_token`、`f/factory/github_token`、`f/factory/wmill_token`、`f/factory/discord_webhook_url`)として保持する。
- scriptからは`wmill.getVariable()`で取得し、**子プロセスの環境変数としてのみ**渡す(`GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`など)。
- 次の場所には絶対に出さない: URLのクエリ・パス、ログ出力、Data Tableのカラム、Discord通知本文。
- エラーメッセージや失敗記録(`job_failures`)に含める前にマスク処理を通す。マスク関数はテストで検証する。
- `scripts/bootstrap.sh`はシークレットをコマンドライン引数に載せない設計だが、唯一の例外が`wmill workspace add --token <t>`(CLIに他の受け口が無い)。単一ユーザーのローカル環境が前提であれば実害は小さいが、共有マシンで実行する場合は`ps`などでプロセス引数が見えてしまう点に注意する。
- workerに保持する`f/factory/wmill_token`はワークスペース`factory`に限定した有効期限180日のAPIトークンで、`mise run bootstrap`を再実行するたびに新しいトークンが発行されて置き換わり、旧トークンは失効する(これがローテーション手段になる)。期限切れは、`self_update`スケジュール(工程実装後)の失敗として現れる。
- ホスト側で必要な秘密値(`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`、`GITHUB_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、`DISCORD_WEBHOOK_URL`)は`.env`ファイルを使わない。非秘密の設定は`mise.toml`の`[env]`にコミットし、個人の秘密値はgitignore済みの`mise.local.toml`(テンプレートは`mise.local.toml.example`)に置く。
- 値の投入は人が行う。推奨コマンドは`read -rs 'v?KEY: ' && mise set -E local KEY="$v"; unset v`(zsh / bash共通。値に`!`などの記号を含んでもシェル履歴展開で失敗せず、平文がシェル履歴に残らない)。`mise set -E local KEY=value`は`mise.local.toml`に`[env]`テーブルとして書き込まれる(実機確認済み)。Claudeが担当するのは`mise.local.toml.example`(値の無いテンプレート)の更新までで、値の投入は人の作業。必要になったら作業を止めずに投入コマンドを提示して先に進む。具体的な手順は`factory-dev`スキル(`.claude/skills/factory-dev/SKILL.md`)を参照。`mise set -E local KEY=value`の直書きは、値に記号を含まない場合のみ動くが、平文のままシェル履歴に残るため推奨しない。
- `infra/.env`ファイルは置かない(存在するとDocker Composeが自動的に読み込んでしまうため)。`mise run`タスク経由で解決された環境変数をcomposeファイル内で`${VAR:?run via mise}`として参照し、`mise run`を経由せず直接`docker compose`を叩いた場合はfail-fastで止まるようにする。

## pr_fixの安全策

- Factory自身の投稿かどうかは「投稿者ログインがviewer(Factory自身のGitHubアカウント)と一致 **かつ** 本文がfactoryマーカーを含む」の両方(`isFactoryPost`)で判定する。Factoryは人と同じGitHubアカウント(共有PAT)で運用されるため、ログイン一致だけでは人の投稿と区別できず、逆にマーカーの有無だけでは第三者が偽装できてしまう(marker alone is not proof of authorship)。この判定により、同一アカウント運用下でも人が投稿したコメントとFactory自身の一次レビュー指摘はpr_fixへのfeedbackとして扱われ、除外されるのはFactory自身の`pr_fix`返信のみとなる。

`pr_fix`はClaudeに書き込みツール(`Edit`/`Write`)を与える最初のフローであり、次のガードを設ける。

- Claudeのツールは`Read,Glob,Grep,Edit,Write`のみ。**`Bash`は与えない**。
- headless Claudeの起動オプション:
  - `--permission-mode dontAsk`: 確認なしで実行(Edit/Write拒否のデフォルト動作をoverwriteするため)。
  - `--allowedTools Edit Write`: Read/Glob/Grepに加えてEdit / Writeのみを明示許可、Bashは許可しない。
  - `--restricted`: Bash等のコード実行ツールとWebFetchを外し、fileツールを作業ディレクトリ(`--add-dir`含む)に閉じる。ネットワークは遮断しない。
- 対象リポジトリの標準チェック(lint / typecheck / test相当)はClaude自身に実行させない。フロー側のステップが`factory_config.allowed_check_commands[]`(例: `["mise run check"]`)を実行する。対象repoのコードをworkerコンテナ内でrootとして実行する。envの最小化は隔離ではなく、同一uidのため`/proc`経由でジョブトークンに到達しうる。サンドボックス(別コンテナ / 非root / network none)の実装まで既定`[]`を維持し、非空にすると実行ごとにnotice `unsandboxed_check_commands`が記録される。結果を2回目のClaude実行(修正)への入力として渡す。
- 対象リポジトリが定義するコマンドの中身(`allowed_check_commands`が指す先、対象リポジトリの`mise.toml` / `package.json`のscripts等)は **untrusted** として扱う。worker内のmiseは対象リポジトリの`mise.toml`をtrustしない(`mise --yes trust`を行わない)。`mise.toml`に依存しないコマンドか`MISE_TRUSTED_CONFIG_PATHS`を使わずに実行できないコマンドは、実行せず`blocked`として報告する。
- 修正の差分に次のいずれかが含まれる場合は **`blocked`** として中断する: `.claude/**`、`.agents/**`、`mise.toml`、`mise.*.toml`、`lefthook.yml`、`.github/workflows/**`、`package.json`の`scripts`変更、新規の`*.sh`ファイル追加。上記は代表例で、完全な一覧は`f/factory/lib/protected_paths.ts`(`FORBIDDEN_PATH_PREFIXES` / `FORBIDDEN_BASENAME_PATTERNS`)に定義し、`steps/pr_workflow_support.ts`が再exportして参照する(lib化で一覧の内容は変えていない。工程3が記録だけに使う`infra/**`入りの一覧は別定数`IMPLEMENT_PROTECTED_PATH_PREFIXES`で、pr_fixの判定には使わない)。
- 変更ファイル数・差分行数上限: diffに含まれるファイル数が`factory_config.max_fix_changed_files`を超える、またはそのdiffの追加・削除行数合計が`factory_config.max_fix_diff_lines`を超える場合は、安全上の理由で`blocked`として中断する(マージコンフリクトやファイル削除による大規模変更を検出するため)。
- push前に次をすべて確認し、いずれかが成り立たなければ`blocked`として中断する: `head.repo == base.repo`(forkからのPRにはpushしない)、PRがdraftでない、baseブランチが保護ブランチでない、fetchし直した`head_sha`が起動時に確認した値と一致する(その間に人がpushしていない)。
- E2Eの検証は本番のIssueやブランチではなく、捨てブランチ・捨てPRで行う。
- symlinkは`core.symlinks=false`をmain cloneのconfigに永続化し、pr_fixの検証でsymlinkの新規作成・変更・typechangeは`blocked`として扱う。
- コミットのauthor / committer情報は、PATが解決するGitHubアカウントのログイン名と、GitHubのnoreplyメールアドレス(`<数値 ID>+<ログイン名>@users.noreply.github.com`)を使う。個人のメールアドレスをどこにも書き込まないための措置で、`git commit`呼び出しの環境変数(`GIT_AUTHOR_*`/`GIT_COMMITTER_*`)としてのみ渡し、git configには書き込まない。

## 工程3(implement)の安全策

`implement`フローはpr_fixと同じくClaudeに書き込みツールを与えるが、PRを作るところまでで止まり、マージは常に人が行う(Factoryはmerge APIを呼ばない)。ガードはpr_fixと次の点で異なる。

- Claudeのツールは`Read,Glob,Grep,Edit,Write`のみで、**`Bash`は与えない**(`--permission-mode dontAsk` + `--allowedTools Edit Write` + `--restricted`)。検査はフロー側が実行する。
- **承認済み要件定義のファイルは書き換えられない**: Claudeには実行ごとに一時ディレクトリへ複製した要件定義のディレクトリを`--add-dir`で渡し、実行後に削除する。元のファイル(Consoleが表示する承認済みの文書)は渡さない。複製ではファイルへのシンボリックリンクを実体のファイルとして写し、ディレクトリへのリンク・リンク切れ・通常ファイル以外(FIFO等)は写さないので、複製の中にClaudeの`Write`が外へたどれるリンクは残らない。
- **検査コマンドはClaudeが書いたコードを実行する**: 検査コマンド(テスト等)は、Claudeが書いたテストやソースをworkerコンテナ内でrootとして、サンドボックスなしで実行する。このため実装フローが実行するのは、そのリポジトリについて`check_commands_by_repo`に明示されたコマンドだけで、`allowed_check_commands`には落とさない(エントリが無ければ検査コマンドを実行しない)。worker側のサンドボックスができるまでは、Issueを信頼できる人だけが起票するリポジトリにだけこのエントリを設定する。検査コマンドの実行前には毎回`git clean -fdX`で無視ファイル(`node_modules/`やビルド成果物)を消すので、検査コマンドは依存関係のインストールから行う(例: 先頭に`bun install --frozen-lockfile`)。lockfileは保護パスなので、Claudeが書き換えたラウンドでは検査コマンドを実行しない。
- **実装ブランチのpushで対象リポジトリのCIが動く**: 実装ブランチのpushとPRの作成により、対象リポジトリ自身の`push` / `pull_request`のCIが、人のレビューより前にClaudeが書いたコードを、そのリポジトリのsecretsを使える状態で実行しうる。対象リポジトリのCIの権限とsecretsの範囲はこの前提で設定する。
- **保護パスは止めずに明示する**: 保護パス(`f/factory/lib/protected_paths.ts`の`IMPLEMENT_PROTECTED_PATH_PREFIXES`と`IMPLEMENT_PROTECTED_BASENAME_PATTERNS`。pr_fixの一覧の`.github/workflows/**`を`.github/**`に広げ、`infra/**`・`.husky/**`・`.githooks/**`・`.yarn/**`・`.devcontainer/**`、`.env*`・gitleaksの設定・ランタイムのバージョン指定・パッケージマネージャーの設定とlockfile・`*.config.[cm][jt]s`等のツール設定・タスクランナー・`CODEOWNERS`・すべての`package.json`を加えたもの)・新規の`*.sh`・`package.json`の`scripts`の変更はPR本文とDiscordに列挙する。そのラウンドは検査コマンドを実行しない(Claudeが書き換えた`mise.toml` / `package.json` scripts / `lefthook.yml`等をworkerで実行すると、Issue本文経由のコード実行経路になるため)。検査はGitHub側のCIが担う。判定はブランチがデフォルトブランチから分かれた点(`git merge-base`)からの差分で行うので、前のラウンドや前回の実行でコミット済みの変更も毎回判定される。renameは元のパスの削除と新しいパスの追加として扱い、保護パスから外への移動も捕まえる。
- **symlinkの変更は止める**: 分岐点からのステージ済みの差分(`git diff --cached --raw -z`)で変更前か変更後のモードが`120000`のエントリ(新規作成・変更・削除・typechange・rename)があれば`needs_human`にする。ファイルシステムではなくgitのモードで判定するので、worktreeに残っていないsymlinkも捕まえる。変更パスは`git diff -z --name-status`で取得し、引用符付きのパス(非ASCII・制御文字)でも保護パスの判定を素通りしない。
- **worktreeの`.git`ファイルの書き換えを止める**: Claudeは`Edit` / `Write`でworktree直下の`.git`(gitdirへの参照)も書き換えられる。参照先を別のディレクトリに向けると、そこに置いた`config`のfilter等を次の`git add`がrootで実行する。準備ステップでworktreeを作った直後に参照先を検証し(`realpath`で解決した先が`<main clone>/.git/worktrees/`の直下で、その`gitdir`の戻り参照がworktreeを指すこと)、`.git`の中身を記録する。以降はClaudeの実行のたびに、worktreeでgitを実行する前(各ラウンドの冒頭、途中経過のpushと最終コミットの前)に`.git`が記録と一致する通常ファイルであることを確かめ、違えば何も実行せずに`needs_human`にする(途中の変更もpushしない)。
- **差分サイズの上限**は工程3専用の`implement_max_changed_files` / `implement_max_diff_lines`で、超えたら`needs_human`にする。
- **baseブランチが保護ブランチなら止めるガードは適用しない**(実装フローは保護されたbaseに直接pushせず、PRを作るだけのため)。
- **gitleaksを固定検査にする**: 毎ラウンド、差分をすべてステージし、ブランチがデフォルトブランチから分かれた点(`git merge-base`)からのステージ済みの差分全体を`git diff --cached --text --no-ext-diff --no-textconv -U0`で取り出して、追加された行を`gitleaks stdin --redact`に標準入力で渡す。gitleaksは私有の一時ディレクトリで実行し、既定のルールだけを`--config`で強制し、`--gitleaks-ignore-path`をその一時ディレクトリに向け、`--ignore-gitleaks-allow`を付ける。対象リポジトリの内容(`.gitleaks.toml`(壊れたものを含む)・`.gitleaksignore`・行内の`gitleaks:allow`コメント・`.gitattributes`の`binary` / `-diff`指定やtextconv)のいずれでも検出を無効にできない。前のラウンドや前回の実行でコミット済みの変更も毎ラウンド検査する。検出結果はルール名とファイル名だけをClaudeへの修正依頼とDBに渡し、一致した文字列は渡さない。検査する差分やレポートが出力の上限を超えた場合や終了コードが0 / 1以外の場合は検査の失敗として扱う。`needs_human`で途中の変更をpushするのは、ラウンド・予算上限、停滞、差分超過で止まり、PRが無いときだけで(symlink変更・Claude実行失敗・`.git`の書き換えでは検査を終えていない変更なのでpushしない。PRがあれば未検証の変更がPRに入るためpushしない)、そのときもgitleaksを再実行し、通らなければ(検査自体が失敗した場合も)pushしない。
- **検証したツリーだけをコミットする**: 検査に通った(または検査を実行しなかった)ラウンドのステージ済みのツリー(`git write-tree`)を記録し、完了ステップでコミットする直前にもう一度ステージして一致を確かめる。検査コマンドが追跡対象のファイルを書き換えた場合など、検証の後にworktreeが変わっていればpushせず`needs_human`にする。
- **Claudeが書くコミットメッセージのIssue参照は無効化する**: 件名と本文の`#12` / `owner/repo#12`は`No.12` / `owner/repo No.12`に書き換える(デフォルトブランチへのマージで任意のIssueを閉じたり、無関係なIssueにリンクしたりしないため)。元のIssueとの紐づけはFactoryが書くPR本文の`Closes #N`だけで行う。
- 検査コマンドの出力はストリームごとに1MiBまでしか保持せず(先頭と末尾を残す)、DBには秘密をマスクした先頭16KB(失敗した検査の出力を先に並べる)を保存する。
- `.github/workflows/**`を含むpushがPATの`workflow`権限不足で拒否された場合は`needs_human`の理由に載る。

## GitHub PAT

- fine-grained PATを使う。スコープはIssues R/W、Contents R/W、Metadata R、Pull requests R/Wとする。`pr_fix`の修正pushのためContentsをRead and writeにした。fine-grained PATは権限設定の変更をトークンの値を変えずに反映できるため、既存トークンの権限を更新するだけでよく、再発行(値の再生成)は不要。
- `issue_proposal_apply`(ユーザー決定2026-09-26、Issue化提案の承認結果反映)がIssueを作成する際も、他のGitHub呼び出しと同じ`f/factory/github_token`のPATを使う。別の認証情報は用意しない(Issues R/Wスコープは既に確保済み)。
- 有効期限は最長1年。`poll_issues`の冒頭で`gh api user`により有効性を確認し、失効していればnoticeを出す。
- orgリポジトリを対象にする場合、org側のPAT承認が必要になる場合がある点に注意する。
- 認証は`GH_TOKEN`環境変数と`gh auth git-credential`(gitのcredential helper経由)のみで行う。`gh auth login`の対話ログインや、トークンを埋め込んだclone URL(`https://<token>@github.com/...`)は使わない。
- 工程3以降でbotアカウントやGitHub Appへの分離を検討する(実装時に確定)。

### PAT作成手順(GitHubの画面項目)

GitHub右上のアイコン → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-factory`(複数インスタンスで運用する場合は`atelier-works-factory-<instance_name>`) |
| Description | `Software Factory worker (Issues/PR automation)` |
| Resource owner | 対象リポジトリの所有者(個人アカウントor org) |
| Expiration | Customで1年後(最長)。期限切れは`mise run doctor`と`poll_issues`が検出する |
| Repository access | Only select repositories → 拾わせるリポジトリ(sandboxリポジトリを含む) |
| Repository permissions: Issues | Read and write |
| Repository permissions: Contents | Read and write(`pr_fix`の修正pushに必要) |
| Repository permissions: Metadata | Read-only(Issues/Contentsを選ぶと自動で付与される) |
| Repository permissions: Pull requests | Read and write |
| Account permissions | すべてNo access |

生成後に一度だけ表示される`github_pat_...`は、次のコマンドで`GITHUB_TOKEN`として投入する(orgリポジトリではorg側の承認が必要な場合がある):

```sh
read -rs 'v?GITHUB_TOKEN: ' && mise set -E local GITHUB_TOKEN="$v"; unset v
```

## CLAUDE_CODE_OAUTH_TOKENの取得

| 項目 | 内容 |
| --- | --- |
| 取得コマンド | ホストにインストール済みのClaude Code CLIで`claude setup-token`を実行する |
| 用途 | worker内のheadless Claude実行が使うサブスク長期OAuthトークン |
| 投入 | `read -rs 'v?CLAUDE_CODE_OAUTH_TOKEN: ' && mise set -E local CLAUDE_CODE_OAUTH_TOKEN="$v"; unset v` |

## DISCORD_WEBHOOK_URLの取得

| 項目 | 内容 |
| --- | --- |
| 手順 | 通知先のDiscordチャンネルで「チャンネル設定」→「連携サービス」→「ウェブフック」→「新しいウェブフック」を開く |
| 名前 | `Software Factory` |
| 取得 | 「ウェブフックURLをコピー」でURLを取得する |
| 投入 | `read -rs 'v?DISCORD_WEBHOOK_URL: ' && mise set -E local DISCORD_WEBHOOK_URL="$v"; unset v` |

## Windmillサーバーの公開範囲と初期パスワード

- Caddyは`127.0.0.1`(環境変数`WM_BIND`。既定値`127.0.0.1`は`mise.toml`の`[env]`にある)にのみバインドする。ホスト外部からは到達できない構成が既定であり、外部公開する場合は利用者が明示的に`WM_BIND`を変更する必要がある。
- 初期管理者アカウントのパスワードは既知の既定値であるため、`scripts/bootstrap.sh`(M3で実装)がログイン後に必ずパスワードを変更する。実装が完了するまでは手動でパスワードを変更する。`doctor`は既定パスワード(`changeme`)でログインできてしまう状態をNGとして検出する。

## workerコンテナの権限

- workerは`privileged`を付けず、`FAVOR_UNSHARE_PID`も有効にしない。Windmillの公式構成はジョブ隔離のためにこれらを使うことがあるが、このworkerはuntrustedなIssue内容を読むheadless Claudeをサブプロセスとして実行するため、コンテナが万一侵害された場合の影響範囲(ホストへの波及)を優先して最小化する。ジョブ間の隔離は、追加の特権に頼らず、工程ごとのツール制限・read-only方針といった上位の信頼境界設計で担保する。
- 加えて`no-new-privileges: true`と`pids_limit`を設定する(infra側で反映予定)。`cap_drop`によるケーパビリティ削減と非rootユーザーでの実行は、ベースイメージ(Windmill公式イメージ、root実行前提)の制約により今回は見送る。

## `.claude/settings.json`のdenyルールとシークレット投入の運用

- 本リポジトリの`.claude/settings.json`にある`deny`は、**誤操作の防止**が目的であり、秘匿性を保証する仕組みではない。設定ファイルを直接読めばルール自体は誰でも確認できる。実際の秘匿性は、値そのものをリポジトリにコミットしないこと(`mise.local.toml`はgitignore済み)、Windmillのsecret変数として管理することで担保する。
- 次をdenyに含める。理由はいずれも、実行すると変数展開後のシークレット値がそのまま出力されうるため:
  - `mise.local.toml`の`Read` / `Edit`(個人の秘密値そのものが書かれている)
  - `mise env`とそのエイリアス(`mise e`、`mise ev`、`mise env-vars`)(展開済みの環境変数一覧を出力する)
  - `mise config get`(設定値を出力する)
  - 引数なしの`mise set`(現在の設定値一覧を出力する)。値を指定した書き込み専用の呼び出し(`mise set -E local KEY=value`、または推奨の`read -rs`経由での呼び出し)は対象外
  - `docker compose config`(変数展開後のcompose定義を出力する)
  - `docker inspect`(コンテナに渡っている環境変数が見える)
  - `docker exec` / `docker container exec`(コンテナ内から環境変数を読み出せる)
- これらのdenyは誤操作の防止であり、`mise run <task>`を経由した迂回(タスク内部で秘密値を出力する処理が新設される、等)までは防げない。**denyは秘匿の保証ではない**。
- 運用ルール: Claudeが担当するのは`mise.local.toml.example`(値の無いテンプレート)の更新までとする。実際の値の投入は人が行う。投入が必要になった時点で、Claudeは作業を止めて待つのではなく、実行すべきコマンドを提示したうえで、それ以外に進められる作業を続ける。

## draw.ioビューアーのプライバシー

- 要件定義の図(`<name>.drawio`)は要件定義ファイルと同じworker専用ディレクトリ(`requirement_drafts.doc_dir`以下)に生のXMLとして書かれ、DBの`requirement_drafts.diagrams`列には`{name, file}`という参照だけが入る。GitHub(Issue / PRコメント)にもDiscord通知にも図の内容・URLのいずれも投稿しない(2026-09-27の方針)。
- Consoleでのインライン描画は`f/factory/steps/console_query.ts`の`requirements_doc`ビューが`doc_dir`配下の`requirements.md`と各`<name>.drawio`をファイルから読み戻し(`readDocFromDisk`。`doc_dir`が`REQUIREMENTS_BASE_DIR`配下であることを検査したうえで読む)、Console(raw app)の`components/DrawioViewer.tsx`がXMLをブラウザ内で描画する形で実装済み。図のXMLはWindmillのjob結果としてConsoleのバックエンドランナブル呼び出し経由でフロントエンドに渡るだけで、GitHubやDiscordには一度も送られない。
- `DrawioViewer.tsx`はdiagrams.net公式の埋め込み用静的ビューアースクリプト(`https://viewer.diagrams.net/js/viewer-static.min.js`)をページに一度だけ読み込み、`<div class="mxgraph" data-mxgraph='{"xml": ...}'>`にXMLをJSONとして渡してブラウザ内で描画する(`window.GraphViewer.processElements()`)。XMLはこのスクリプトを経由して外部サーバーに送信されない(diagrams.net公式の埋め込み方式であり、レンダリングはクライアント側で完結する)。CDNからのスクリプト読み込みがConsoleのCSP(Content Security Policy)で拒否される場合は、`viewer-static.min.js`をこのApp自身の資産としてvendoringし`import`する対応が必要になる(Apache-2.0ライセンス、未実装)。
- 旧`f/factory/lib/drawio.ts`の`toViewerUrl`(`viewer.diagrams.net`のURLフラグメントへのエンコード、外部リンク方式)は上記のインライン描画実装に伴い削除した(`validateDrawioXml`は生成後の検査用として引き続き使用する)。

## 監査(工程5)

- **証跡パックはDATA**: `audit_prepare`が集計する証跡パック(`evidence.md`)は`maskSecrets`とHTML除去(タグ・コメントとも)を通した文字列のみで構成し、`factory-audit`スキル(`.claude/skills/factory-audit/SKILL.md`)がこれを命令ではなくデータとして扱うことを明文化する。`--add-dir`で渡すFactory自身のリポジトリ(下記のスナップショット)の内容も同様にDATAとして扱う。
- **ツール制限**: Claudeのツールは`Read` / `Glob` / `Grep` / `Edit`のみ。`Edit`はカレントディレクトリの`report.md`にしか使わせない(`Write`は許可しない、新規ファイルを作らせない)。
- **self cloneは見せない**: `self_update`のデプロイ元であるself cloneそのものはClaudeに渡さない。`audit_generate`は実行のたびにそのHEADから使い捨てのdetached worktree(`/var/lib/factory/audits/wi-<id>-snapshot`)を作り、`--add-dir`・テンプレート・スキルの読み込みをすべてこのスナップショットに向ける。スナップショットは成功・失敗を問わず`finally`で削除し、stepの再試行時に作り直す。
- **出力の機械検査**: Issueになる構造化出力(提案のtitle・bodyとsummary)は、HTMLコメント・禁止記法と、許可リスト(Factory自身のGitHub URLとWindmillの公開URL)外のURLを機械検査する。レポート本文は証跡にある対象リポジトリのURLを正当に引用するためURL許可リストの対象外とし、章立て・HTMLコメント・改善提案の表(構造化出力との件数・タイトル一致)を検査する。検査を通らない出力は保存せず、Issue本文にならない。
- **人の承認が最終ゲート**: 検査を通った提案も、承認Inboxで人が承認するまでGitHubのIssueにはならない。承認された提案だけがFactory自身のリポジトリ(`factory_repo`)にIssueとして起票される。

## 承認と権限

- **承認権限**: `f/factory/**`スクリプトの実行権限を持つアカウント。Windmillのdefaultワーカーグループではworkspace adminのみが対象。
- **承認方法**: Windmillのapproval page URL(署名付きcapability URL)は、PRコメントやDiscord通知に載せない。承認は必ずInbox App(`approval_decide`)を経由する。approval page URLを直接resumeするとapprovalがスキップされ、承認状態が記録されず`needs_human`に落ちる動作になる。
- **approverの記録**: `approvals`テーブルの`approver`カラム、および`issue_proposals`テーブルの`decided_by`カラムは、いずれも共有ヘルパー`deriveApprover`(`f/factory/lib/approver.ts`)でfail-closedに導出する。`WM_USERNAME`(Windmillのログインユーザー名)を優先し、未設定なら`WM_EMAIL`にフォールバックし、どちらも取得できなければ例外を投げて処理を中断する(呼び出し元が渡す引数は信頼せず、identityとして扱わない)。`"unknown"`のような既定値で承認者不明のまま記録することはない。

## publicリポジトリでのラベル付与制限

- `factory`ラベルの付与者はOWNER / MEMBER / COLLABORATORのいずれかである場合のみIssueを拾う。`poll_issues`は各Issueのタイムラインから最後にラベルを付けた人の`author_association`を確認し、許可された関係でなければ拾わずにnoticeを出す。これにより、publicリポジトリで第三者が任意にラベルを付けてパイプラインを起動させることを防ぐ。この確認は`getIssueTimeline`が`GET .../timeline`(Issueの現在のラベル一覧ではなく、付与・剥奪イベントの履歴)を見て行うため、claim時に`factory`ラベル自体が消費されて(外れて)以降も、`labeled`イベントの記録は残り続け、この確認は引き続き有効に機能する(2026-09-27方針変更: Issueのラベルはclaim時に一度だけ消費される)。
- GitHub側でもラベルの付与にはtriage以上の権限が必要なため、`labeled`イベントのactorはそもそも書き込み権限を持つ人に限られる。`author_association`の確認は、このGitHub側の制約に加えた補助的な二重チェックという位置づけ。
- PRのレビュー・コメント投稿者についても同様に制限する。`allowed_labeler_associations`(既定値: `["OWNER", "MEMBER", "COLLABORATOR"]`)に該当しない`author_association`からのレビューコメント・新規コメントは`pr_review` / `pr_fix`フローの起動対象から除外する。
- `factory:review` / `factory:fix`ラベル自体については、Issueの`getIssueTimeline`のようなタイムライン照会は行わず、GitHub側の権限制約(上記、triage以上が必要)のみに依拠する。この制約はラベルの付与操作自体に対する制約であり、claim時にラベルが消費されて(外れて)以降も後から弱まることはない(2026-09-27方針変更: PRのラベルはclaim時に一度だけ消費される — Issue側と同様)。
