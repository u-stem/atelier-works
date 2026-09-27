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
- 修正の差分に次のいずれかが含まれる場合は **`blocked`** として中断する: `.claude/**`、`.agents/**`、`mise.toml`、`mise.*.toml`、`lefthook.yml`、`.github/workflows/**`、`package.json`の`scripts`変更、新規の`*.sh`ファイル追加。
- 変更ファイル数・差分行数上限: diffに含まれるファイル数が`factory_config.max_fix_changed_files`を超える、またはそのdiffの追加・削除行数合計が`factory_config.max_fix_diff_lines`を超える場合は、安全上の理由で`blocked`として中断する(マージコンフリクトやファイル削除による大規模変更を検出するため)。
- push前に次をすべて確認し、いずれかが成り立たなければ`blocked`として中断する: `head.repo == base.repo`(forkからのPRにはpushしない)、PRがdraftでない、baseブランチが保護ブランチでない、fetchし直した`head_sha`が起動時に確認した値と一致する(その間に人がpushしていない)。
- E2Eの検証は本番のIssueやブランチではなく、捨てブランチ・捨てPRで行う。
- symlinkは`core.symlinks=false`をmain cloneのconfigに永続化し、pr_fixの検証でsymlinkの新規作成・変更・typechangeは`blocked`として扱う。
- コミットのauthor / committer情報は、PATが解決するGitHubアカウントのログイン名と、GitHubのnoreplyメールアドレス(`<数値 ID>+<ログイン名>@users.noreply.github.com`)を使う。個人のメールアドレスをどこにも書き込まないための措置で、`git commit`呼び出しの環境変数(`GIT_AUTHOR_*`/`GIT_COMMITTER_*`)としてのみ渡し、git configには書き込まない。

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

- 要件定義の図は`viewer.diagrams.net`のURL(`#`以降に圧縮したXMLを埋め込む形式)で共有する。URLのフラグメント部分(`#`以降)はブラウザからdiagrams.netのサーバーには送信されない。
- このURLはGitHub(Issue / PRコメント)にもDiscord通知にも投稿しない(2026-09-27の方針変更: GitHubには成果物のみを書く)。図の内容はFactory Console App(`f/factory/factory_console`)のInboxタブからのみ閲覧できるため、閲覧できるのはConsoleへのアクセス権を持つ人に限られる。

## 承認と権限

- **承認権限**: `f/factory/**`スクリプトの実行権限を持つアカウント。Windmillのdefaultワーカーグループではworkspace adminのみが対象。
- **承認方法**: Windmillのapproval page URL(署名付きcapability URL)は、PRコメントやDiscord通知に載せない。承認は必ずInbox App(`approval_decide`)を経由する。approval page URLを直接resumeするとapprovalがスキップされ、承認状態が記録されず`needs_human`に落ちる動作になる。
- **approverの記録**: `approvals`テーブルの`approver`カラム、および`issue_proposals`テーブルの`decided_by`カラムは、いずれも共有ヘルパー`deriveApprover`(`f/factory/lib/approver.ts`)でfail-closedに導出する。`WM_USERNAME`(Windmillのログインユーザー名)を優先し、未設定なら`WM_EMAIL`にフォールバックし、どちらも取得できなければ例外を投げて処理を中断する(呼び出し元が渡す引数は信頼せず、identityとして扱わない)。`"unknown"`のような既定値で承認者不明のまま記録することはない。

## publicリポジトリでのラベル付与制限

- `factory`ラベルの付与者はOWNER / MEMBER / COLLABORATORのいずれかである場合のみIssueを拾う。`poll_issues`は各Issueのタイムラインから最後にラベルを付けた人の`author_association`を確認し、許可された関係でなければ拾わずにnoticeを出す。これにより、publicリポジトリで第三者が任意にラベルを付けてパイプラインを起動させることを防ぐ。
- GitHub側でもラベルの付与にはtriage以上の権限が必要なため、`labeled`イベントのactorはそもそも書き込み権限を持つ人に限られる。`author_association`の確認は、このGitHub側の制約に加えた補助的な二重チェックという位置づけ。
- PRのレビュー・コメント投稿者についても同様に制限する。`allowed_labeler_associations`(既定値: `["OWNER", "MEMBER", "COLLABORATOR"]`)に該当しない`author_association`からのレビューコメント・新規コメントは`pr_review` / `pr_fix`フローの起動対象から除外する。
