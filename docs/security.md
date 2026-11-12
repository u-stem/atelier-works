# セキュリティ

Software Factoryの信頼境界、秘密値の扱い、資格情報の取得手順、フローをまたぐ脅威を説明する。
Factoryを運用する人と、フローを変更する人が読む。
各フローの安全策は、フローごとの内部仕様の文書にある。
置き場は、末尾の[各フローの安全策の置き場](#各フローの安全策の置き場)の表から引ける。
受け入れた残るリスクは、[残るリスク](#残るリスク)の節が案内する表にまとめる。

## 信頼境界

Issue本文と対象リポジトリの内容は、信頼できない入力として扱う。
headless Claudeはこれらをデータとして読むだけで、内容に書かれた指示には従わない。
要件定義の生成での扱いは`factory-requirements`スキルに定める。

### 書き込める範囲

どのフローのClaudeにも、コマンドを実行するツール(`Bash`)は渡さない。
書き込みのツールを渡すフローでも、書いてよい場所をフローごとに絞る。
`--restricted`は、ファイルのツールを作業ディレクトリと`--add-dir`のディレクトリの下に限る設定である。
その外への書き込みを実際に拒むかは、確かめていない。

| フロー | 書き込みのツール | 書いてよい場所 |
| --- | --- | --- |
| 要件定義の生成 | `Write`、`Edit` | 試行ごとの作業ディレクトリ(要件定義書と図)だけ。対象リポジトリのworktreeは`--add-dir`で読ませるだけにする |
| 設計書の生成 | `Write`、`Edit` | 設計書の試行ディレクトリ(設計書と図)だけ。要件定義の図は複製だけを`--add-dir`で読ませ、対象リポジトリのworktreeも読ませるだけにする |
| 監査 | `Edit`だけ | 作業ディレクトリの`report.md`だけ。self cloneのスナップショットは`--add-dir`で読ませるだけにする |
| PRのレビュー | なし | なし |
| dependabotの更新の影響調査 | なし | なし |
| PRの修正 | `Edit`、`Write` | PRのブランチのworktree |
| 実装 | `Edit`、`Write` | 実装ブランチのworktree。要件定義は複製を渡す |

要件定義、設計書の生成、監査では、書いてよい場所をスキルとプロンプトで指示する。
`--restricted`が`--add-dir`のディレクトリへの書き込みを拒むかは、確かめていない。
書き込まれても外へ出ないよう、`--add-dir`のディレクトリはどれもpushしない。
要件定義の生成のworktreeは、承認と掃除で消す。
監査のスナップショットは、実行のたびに作り直して消す。

残るリスクは[R-TB-01](security-risks.md#r-tb-01)である。

headless Claudeの起動には、次のフラグと環境変数で防御を足す。

| 設定 | 効果 |
| --- | --- |
| `--setting-sources user` | 対象リポジトリの`.claude/`などのプロジェクト設定を読み込ませない |
| `--strict-mcp-config` | 対象リポジトリのMCP設定を無視し、明示的に渡した設定だけを使う |
| `--max-budget-usd`、`--max-turns`、サブプロセスのタイムアウト | 暴走とコストの超過を打ち切る |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` | システムプロンプトにgit statusの写しとcommit・PRの手順を載せない |

最後の環境変数は、すべてのフローで設定する。
写しを作るとき、Claudeは起動時に作業ディレクトリでgitを実行する。
そのため、書き換えられた`.git`の参照先にあるconfig(`core.fsmonitor`など)を読みうる。
どのフローのClaudeにも`Bash`を渡さないので、gitの文脈を使う処理は無い。

サブプロセスのタイムアウトで打ち切った実行は、結果のJSONを読めないことが多く、費用が分からない。
そのため、標準出力に費用が無ければ、`--max-budget-usd`の値を費用として`agent_runs`に記録し、日次予算に数える。
タイムアウト、`--max-budget-usd`の超過、使用上限で失敗したときは、flowの再試行でClaudeを起動し直さない。
すぐ起動し直しても同じ失敗になり、費用だけがかかるためである。
全停止で止めた実行も、解除の直後に動き出さないよう、flowの再試行で起動し直さない。
再試行を止めるタグは、ステップが固定の文の前に付ける。
Claudeの出力は固定の文より後ろに入るので、出力の文字列でタグは付かない。
費用の記録(`lib/claude_flow_failure.ts`)と再試行の判定(`lib/flow_retry_marker.ts`)は、保護パスである。
各flowの`retry_if`が判定を使うことを確かめるテスト(`tests/scripts/claude_flow_retry.test.ts`)も保護パスである。
flowの定義は日常的に直すので守らず、`retry_if`が消えると、保護されたテストが落ちて検査を通らない。
書き換えられると、費用が日次予算に数えられなくなり、費用だけがかかる再試行が走るためである。

PRの修正(`pr_fix`)と実装(`implement`)のフローは、Claudeが対象リポジトリのworktreeに書き込み、その変更をpushする。
そのための追加の安全策は[PR修正の安全策](internals/pr-workflow.md#pr修正の安全策)と[実装の安全策](internals/implement.md#実装の安全策)に書く。

### mainの保護とリポジトリの公開

このリポジトリは公開している。
`main`はrulesetの`protect-main`で保護し、次の制限をかける。

- `main`の削除とforce pushを禁止する。
- `main`への変更はPRを必須にする。
  承認は0件でよく、人のレビューをGitHubが強制するわけではない。
- 必須チェックは次の10件である。
  条件付きのジョブは、スキップされると通過として扱われる。
  - `scope`、`check`、`check-docs`、`check-worker`、`test-db`
  - `metadata`、`console`、`console-a11y`、`caddyfile`、`console-fetcher-image`
- 設定を迂回できるのは、管理者のロールだけである。
  迂回のモードは`pull_request`なので、直接pushはできず、PRを経由する迂回に限られる。

迂回すると、`check`などの必須チェックが失敗していてもPRをマージできる。
運用者は、迂回を使わず、必須チェックが成功してからマージする。

必須チェックを足すときは、そのジョブが`main`の`ci.yml`に入ってから、rulesetの一覧を更新する。
先に更新すると、そのジョブを持たない古い`main`から分かれたPRが、出ないチェックを待ち続けてマージできない。
ジョブを足すPR自身は、一覧を更新する前にマージする。
更新は、マージの後にClaudeが行う。
次の順に進める。

射影には、次の`jq`を使う。
読み取り専用のフィールドを外し、書き込めるフィールドだけを残すためである。

```sh
jq '{name, target, enforcement, bypass_actors, conditions, rules}' <応答のファイル>
```

1. `gh api repos/<owner>/<repo>/rulesets`で、名前が`protect-main`のrulesetの`id`を読む。
2. `gh api repos/<owner>/<repo>/rulesets/<id>`で全体を読み、応答のファイルは書き換えずに残す。
編集の前に、そのファイルを前置きの`jq`で射影し、`before.json`として保存する。
書き戻した後の比較に使うためである。
続けて応答のファイルをコピーし、コピーの`required_status_checks`に足すチェックを、既存の項目と同じ形で加える。
既存の項目に`integration_id`があれば同じ値を付け、`context`だけなら`context`だけを足す。
形が違うと、別のアプリが出したチェックだけを受け付ける項目になり、待ち続けることがある。
他の規則と迂回の設定は変えない。
3. 手順2で編集したコピーを前置きの`jq`で射影する。
射影したファイルを、`gh api --method PUT repos/<owner>/<repo>/rulesets/<id> --input <file>`で書き戻す。
`id`、`source`、`_links`、`created_at`、`updated_at`、`current_user_can_bypass`などは読み取り専用なので、射影で外れる。
残すと、拒否されるか意図しない変更になる。
4. `gh api repos/<owner>/<repo>/rules/branches/main`を読み、一覧にチェック名が載ったことを確かめる。
あわせて、書き戻しで他が変わっていないことを確かめる。
もう一度`rulesets/<id>`を読み、前置きの`jq`で射影して、`before.json`と`diff`で比べる。
差が`required_status_checks`に足した1項目だけでなければ失敗とする。
差が空のときも失敗に含める。
失敗したときは、`before.json`を手順3と同じ`gh api --method PUT`の`--input`に渡して書き戻し、元の状態に戻す。
戻したら、運用者に報告する。

一覧を更新したら、更新の前に分かれたPRは、`main`を取り込むまで新しいチェックが出ずに待つ。
更新の後に開く新しいPRと、`main`を取り込んだPRには、新しいチェックが出る。

マージの後に開いているdependabotのPRがあれば、`@dependabot rebase`とコメントして、新しいチェックを出させる。
Factory自身のリポジトリのPRは、rulesetでなく、Factory内部の固定の一覧で必須チェックを判定する。
この一覧は、マージの後に`self_update`が反映すると増える。
マージの前にCIが走ったPRは、新しいチェックが出ないので、待ちになる。

タグはrulesetの`protect-tags`で保護する。
対象はすべてのタグで、作成、更新、削除を禁止する。
迂回できるのは、リポジトリの管理者のロールだけで、常に迂回できる。
`main`という名前のタグの実行は、`main`のブランチの実行と見分けがつかない。
`protect-tags`は、このタグを経由してConsoleの配布物(`console-dist`)をすり替える経路を塞ぐ。
このリポジトリはタグを使わないので、運用には影響しない。
タグを使うようにするときは、rulesetを見直す。
設定の確認は[運用](operations.md)の「タグのrulesetを確かめる」にある。

公開に伴い、外部からの操作は次のように絞る。

- GitHubのinteraction-limitsを`collaborators_only`にしている。
  期限付きの設定で、切れると外部の利用者もIssueやPRを作れるようになる。
  期限はGitHubの設定画面で確かめる。
- forkのPRのワークフローは、すべての外部の投稿者について、承認があるまで動かさない。
- secret scanningとpush protection、Dependabot security updatesを有効にしている。
- 脆弱性は、非公開の報告で受ける。
  窓口は[SECURITY.md](../SECURITY.md)にある。

FactoryはPAT(`f/factory/github_token`)で、人と同じアカウントとしてGitHubを操作する。
PRをマージするAPIを呼ぶのは、dependabotの更新のフローだけで、既定では無効である([dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ))。
残るリスクは[R-TB-35](security-risks.md#r-tb-35)である。

### CIで走査されないコミット

atelier-worksのCIは、gitleaksでPRのコミットを走査する。
走査されないコミットが残る場合は、次の2つの残るリスクである。

- [R-TB-02](security-risks.md#r-tb-02)
- [R-TB-03](security-risks.md#r-tb-03)

### CIのトークンの権限

`ci.yml`の既定の権限は、リポジトリの読み取り(`contents: read`)だけである。
`scope`ジョブだけが、実行の一覧を読む権限(`actions: read`)を足す。
`main`へのpushで、直近で成功した実行のcommitを調べ、差分の基点にするためである。
どちらも読み取りだけで、書き込みの権限は付けない。
トークンを`gh`に渡すのは`main`へのpushの実行だけで、PRの実行には渡さない。
`metadata`ジョブも権限を足さない。
失敗したときに限り、PRの実行でartifactを上げる([CIのメタデータの再生成](internals/ci-fix.md#ciのメタデータの再生成))。
`console-a11y`ジョブも権限を足さない。
失敗したときに限り、Playwrightのレポート(`playwright-report`)を3日間だけ上げる。
レポートは、検査が固定の値で受けた画面の記録だけである。
秘密値と実データは含まない。

`console-dist.yml`の既定の権限も、`contents: read`だけである。
ジョブは権限を足さない。
成果物の書き込みは、`GITHUB_TOKEN`の書き込み権限を使わず、ランナーの実行用の資格情報で行う。
`main`へのpushでだけ動かし、PRの実行では成果物を上げない。

### CIの実行の範囲の判定

PRの実行の判定は、PRの版の`scripts/ci-scope.ts`で行う。
残るリスクは[R-TB-04](security-risks.md#r-tb-04)である。

判定の`DB_DEPENDENCY_FILES`には、`test:db`が実行するコードの依存を列挙する。
`console_query.ts`が`lib/config.ts`を読むので、`f/factory/lib/config.ts`を入れている。
入れないと、設定の読み取りだけを変えるPRで`db`のジョブが動かない。

### 開発セッションのsubagent

開発のセッションでは、superpowersのsubagentと組み込みの`/code-review`を使う。
これらはheadlessのフローからは使われない。
pushは親のセッションだけが行い、subagentはpushしない。

worktreeを作るフックと、既存のブランチを使う経路(worktreeの再利用、既存ブランチの取り付け)は、ローカルのブランチを自分のものとして信頼する前提である。
そのブランチの`bunfig.toml`、`mise.toml`、lefthookのフックが動くのは、手でcheckoutしたときと同じ信頼によるためである。

### worktreeの自動の片付け

`worktree-new.sh`は、worktreeを新しく作った後に、`worktree-prune.sh --auto`をバックグラウンドで起動する。
手動の`--apply`は確認を経て消すが、自動の実行は確認なしで消す。
消す条件は手動と同じで、動作は[セットアップ](setup.md#自動の片付け)にある。
作成先のリポジトリが、実行している`worktree-new.sh`の属するリポジトリと同じときだけ起動する。
違うときは起動せず、標準エラーに警告を1行出す。
別のリポジトリのworktreeは、この経路では消えない。
加えて、`lsof`で呼び出し元が見えない実行と、`lsof`の出力が空の実行は、何も消さない。
削除の直前の取り直しにも、同じ条件を課す。

残るリスクは次のとおりである。

- [R-TB-05](security-risks.md#r-tb-05)
- [R-TB-06](security-risks.md#r-tb-06)
- [R-TB-07](security-risks.md#r-tb-07)
- [R-TB-08](security-risks.md#r-tb-08)
- [R-TB-09](security-risks.md#r-tb-09)
- [R-TB-10](security-risks.md#r-tb-10)
- [R-TB-11](security-risks.md#r-tb-11)
- [R-TB-12](security-risks.md#r-tb-12)
- [R-TB-13](security-risks.md#r-tb-13)
- [R-TB-14](security-risks.md#r-tb-14)
- [R-TB-15](security-risks.md#r-tb-15)
- [R-TB-16](security-risks.md#r-tb-16)
- [R-TB-17](security-risks.md#r-tb-17)

### 状態の理由の区切り

状態の理由(`status_reason`や人の対応待ちの理由)は、`"; "`でつないだ項目の一覧である。
Consoleの表示と次の操作は、この区切りで分けた項目ごとに選ぶ。
Claudeや検査コマンドが書ける詳細と、pr_fixのClaudeが理由として書く`blocked_reason`は、区切りを`", "`に置き換えてから理由に入れる。
区切りを差し込んで、別の理由の訳文を表示させたり、既知の理由を足して次の操作を選ばせたりできないようにするためである。
置き換える詳細の範囲は[通知とrate limit](internals/notifications.md)にある。

残るリスクは[R-TB-18](security-risks.md#r-tb-18)である。

### 自己更新の通知の状態

`poll_issues`は、版の食い違いを最初に見た時刻をWindmillのstateに保存し、猶予を超えたときに`deployed_sha_mismatch`を通知する。
通知は、今の`deployed_sha`への反映が成功した記録(`factory.deployments`)のうち最も新しいものより前に作られたものだけが、自動で解決される。
残るリスクは次のとおりである。

- [R-TB-19](security-risks.md#r-tb-19)
- stateや`deployed_sha`を書き換えても、通知より新しい反映の成功の記録が無い限り、通知は解決されない。
- [R-TB-20](security-risks.md#r-tb-20)
- [R-TB-21](security-risks.md#r-tb-21)

### Factory自身のリポジトリの照合

`factory_repo_id`を設定すると、Factory自身のcloneを用意する処理は、取得の前にGitHubの現在のリポジトリIDと照合する。
オーナーが改名して別の人がその名前を取得しても、その人のリポジトリを反映したり、Claudeに読ませたりしないためである。
設定と処理ごとの振る舞いは[運用](operations.md)の「Factory自身のリポジトリの数値IDを固定する」にある。

残るリスクは次のとおりである。

- [R-TB-22](security-risks.md#r-tb-22)
- [R-TB-23](security-risks.md#r-tb-23)
- [R-TB-24](security-risks.md#r-tb-24)
- [R-TB-25](security-risks.md#r-tb-25)
- [R-TB-26](security-risks.md#r-tb-26)

### オーナーの数値IDの照合

作業項目は、発見した候補か`getIssue`の応答の`repository_url`にある、その時点の名前を保存する。
承認を待つ間に名前が入れ替わると、保存した名前のURLは別の人のリポジトリを指す。
そのリポジトリをcloneして検査コマンドを実行すると、他人のコードを秘密値を持つworkerで動かすことになる。
そこで、発見の入口に加えて、次の処理が保存済みの名前を照合する。

- 作業項目を進める準備のステップ。
  リポジトリの取得の前に照合する。
  dependabotの準備(`dependabot_prepare`)は、事実を再収集した後、cloneの前に1回照合する。
  取得の入口の照合から収集を挟むので、その間に名前が入れ替わっても、相手のリポジトリをcloneして依存をインストールしないためである。
- フォームからのIssueの作成。
  投稿の前に照合する。
- Issue化の提案の処理。
  承認は判断の記録の前に、却下は返信の前に照合する。
- 長い実行を挟んだ後の書き込みのうち、次の5つの処理。
  照合は、書き込みの直前に1回行う。
  実装の終了処理(`implement_finish`)は、pushとリモートブランチの削除の前に照合する。
  PR修正の終了処理(`pr_fix_finish`)は、pushの前に照合する。
  PRレビューの投稿(`pr_review_post`)は、レビューの投稿の前に照合する。
  dependabotの終了処理(`dependabot_finish`)は、PRを読み直した後、マージ、所見の投稿、ラベルの付与の前に照合する。
  準備の入口の照合から、Claudeの実行と検査を挟むので、その間に名前が入れ替わると、
  ローカルにしか無いオブジェクトやレビューの文面が相手に渡るためである。
  dependabotでは、マージ、所見の投稿、ラベルの付与が相手のPRに及ぶためである。
  draw.ioのビューアを上げる`drawio_viewer_bump`は、`factory_repo_id`をブランチの作成の前に照合する。

関門は、呼び出しの順に頼らず、それ自身が閉じる。
`owners`に名前が無いオーナーのリポジトリは、`factory_repo`と一致するときだけ通し、それ以外は止める。
リポジトリが`factory_repo`と一致し、`factory_repo_id`があるときは、関門が先にそのIDも照合する。
cloneを開かない処理は、`openFactoryClone`の照合を通らないためである。
`id`を持つ要素は、現在のIDと合うときだけ通す。
`id`を持たない要素は、名前だけで動く。
`id`を持つ要素の照合は、リポジトリのオーナーのIDを1回取得して行う。
リポジトリが`factory_repo`と一致し、`factory_repo_id`があるときは、関門の中でリポジトリのIDも取得する。
cloneを開くステップでは、`openFactoryClone`の照合も重なるので、取得が増える。
設定と処理ごとの振る舞いは[運用](operations.md)の「オーナーの数値IDを固定する」にある。

残るリスクは次のとおりである。

- [R-TB-27](security-risks.md#r-tb-27)
- [R-TB-28](security-risks.md#r-tb-28)
- [R-TB-29](security-risks.md#r-tb-29)
- [R-TB-30](security-risks.md#r-tb-30)
- [R-TB-31](security-risks.md#r-tb-31)
- [R-TB-32](security-risks.md#r-tb-32)
- [R-TB-33](security-risks.md#r-tb-33)
- [R-TB-34](security-risks.md#r-tb-34)

### migrationを戻した日の日次予算

調査の種別と状態を足したmigrationのdownは、調査の作業項目を削除し、外部キーの連鎖で`agent_runs`の行も消す。
`agent_runs`は日次予算の元データなので、downを当てた日は、予算の検査が調査に使った費用の分だけ少なく数える。
その日は、予算の上限を超えてClaudeが動きうる。
手順と消える表は[調査のmigrationを戻す](operations.md#調査のmigrationを戻す)にある。

## シークレットの扱い

### Windmillでの保持

Windmillで実行する間、秘密値はWindmillのsecret変数に置く。

- `f/factory/claude_oauth_token`
- `f/factory/github_token`
- `f/factory/wmill_token`
- `f/factory/discord_webhook_url`
- `f/factory/github_read_tokens`
- `f/factory/db_backup_url`
- `f/factory/heartbeat_url`

scriptは`wmill.getVariable()`で値を取得し、子プロセスの環境変数(`GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`など)としてだけ渡す。
URLのクエリとパス、ログ、Data Tableの列、Discordの通知本文には出さない。
親プロセスが`fetch`で使う秘密値は、次の5か所である。

- Console用のworkerで動く`retry_work_item`は、`gh`を起動できないので、`github_token`を`fetch`の`Authorization`ヘッダに載せる。
  使うのは、取り消された作業項目を再開するときの対象の状態の確認と、Issueの要件定義を作り直す再実行のときの取り込み内容の更新(現在のIssueの題名と本文の取得)である。
  宛先は`https://api.github.com`に固定し、リダイレクトは辿らない。
  境界は[Console用workerの境界](#console用workerの境界)に書く。
- Console用のworkerで動く`approval_decide`は、要件定義の承認の前に現在のIssueを読むため、同じ形で`github_token`を使う。
  10秒の締め切りを付け、エラーの文とログにトークンとIssueの内容を含めない。
- Discordへの送信(`lib/discord.ts`の`notify`)は、`discord_webhook_url`を`fetch`の宛先のURLにする。
  URLそのものが秘密なので、エラーメッセージとログには含めない。
- 収集の`collect_github`(`lib/gh_graphql.ts`)は、`github_read_tokens`の所有者ごとのトークンを`fetch`の`Authorization`ヘッダに載せる。
  宛先は`https://api.github.com/graphql`に固定し、リダイレクトは辿らず、1要求に10秒の締め切りを付ける。
  エラーの文とログに、トークンと応答の本文を含めない。
  GraphQLのエラーの文は、残さない。
  拒否された項目として、許可表の`type`と、問い合わせの文に現れる語だけの項目名を、1回10件までログに残す。
  語の表は自前の問い合わせの文から作るので、エラーの側に何が来ても、トークンの形の文字列はログに入らない。
- 検出器の`detect_schedule_failures`は、外部の死活監視の`heartbeat_url`を`fetch`の宛先にする。
  `https`のURLだけを叩き、リダイレクトは辿らず、10秒の締め切りを付ける。
  URLそのものが秘密なので、ログには伏せた形だけを残す。
  漏れたときの影響は、偽の生存の報告で、止まったことに気づくのが遅れることに限られる。

エラーメッセージと失敗の記録(`job_failures`)には、マスク処理を通してから値を入れる。
マスクの関数はテストで検証する。

### ホストでの保持

ホストで使う次の秘密値は、gitignore済みの`mise.local.toml`に置く。
テンプレートは`mise.local.toml.example`である。
秘密でない設定は`mise.toml`の`[env]`にコミットする。

- `DB_PASSWORD`
- `WM_ADMIN_EMAIL`
- `WM_ADMIN_PASSWORD`
- `GITHUB_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `CONSOLE_GITHUB_TOKEN`
- `GITHUB_READ_TOKEN_<OWNER>`(所有者ごとに1つ。`<OWNER>`は所有者のloginを大文字にして、`-`を`_`にした名前)
- `HEARTBEAT_URL`(任意。外部の死活監視のURL)

値は人が投入する。
投入のコマンドは[セットアップ](setup.md)にある。
Claudeが更新するのは、値の無いテンプレートである`mise.local.toml.example`までにする。
投入が必要になったら、Claudeは実行するコマンドを示し、待たずにほかの作業を続ける。

`infra/.env`は置かない。
存在するとDocker Composeが自動で読み込むためである。
composeファイルは`mise run`が解決した環境変数を`${VAR:?run via mise}`の形で参照する。
`mise run`を通さずに`docker compose`を実行すると、変数が無いので起動前に止まる。

### コマンド引数の例外

`scripts/bootstrap.sh`は、秘密値をコマンドの引数に載せない。
例外は`wmill workspace add --token <t>`の1か所で、CLIにほかの受け口が無いためである。
共有のマシンで実行すると、`ps`などでこの引数が見える。

### Windmill APIトークンの期限

workerが持つ`f/factory/wmill_token`は、ワークスペース`factory`に限定した有効期限180日のAPIトークンである。
`mise run bootstrap`を実行するたびに新しいトークンを発行し、古いトークンを失効させる。
これがトークンのローテーションの手段になる。
期限が切れると、`self_update`のスケジュールが失敗する。

### 資格情報の期限の記録

`mise run bootstrap`は、資格情報の期限を、秘密でない変数`f/factory/credential_expiry`に記録する。
記録は、日次のまとめが期限を確かめるための入力で、手順は[運用](operations.md#資格情報の期限の通知)にある。
記録に入るのは期限の日時だけで、トークンの値は入らない。
例外はClaude CodeのOAuthトークンで、値の変更を見分けるため、SHA-256の先頭16桁の指紋を記録する。
`bootstrap`はWindmillのsecret変数を読み戻さないので、前回と同じ値かどうかは、記録に残した指紋でしか比べられないためである。
16桁は64ビットで、トークンの値を戻すには足りない。

記録を組み立てる次の3つは、ホストのユーザーの権限と秘密値のある環境で動くので、保護パスにある。
`bootstrap`が、秘密値を環境に持たせて起動するためである。

- `scripts/credential_expiry.ts`
- `f/factory/lib/credential_expiry.ts`
- `f/factory/lib/credential_expiry.script.yaml`

これらが読む`lib/log.ts`と`lib/types.ts`は、多くのscriptが使う部品なので守らない。

### 秘密の入れ替え

調査の隔離の測定の結果([止める条件](internals/investigate.md#止める条件))に`notice`が出たときの手順である。

結果の`notice`が出たときは、本物の秘密に届いた可能性があるので、次を入れ替える。
読めたかどうかは、結果から分からない。

1. Claude CodeのOAuthトークンを、[Claude CodeのOAuthトークン](#claude-codeのoauthトークン)の手順で発行し直し、[運用](operations.md#秘密をローテーションする)の手順で反映する。
   旧いトークンは、発行元のアカウントの設定で取り消す。
2. GitHubのPAT(`github_token`)を、[GitHubのPAT](#githubのpat)の手順で発行し直し、同じ手順で反映する。
   旧いPATは、GitHubの**Fine-grained tokens**の画面で削除する。
3. `DB_PASSWORD`を、次の順に変える。
   1. 次のコマンドでpsqlを開き、プロンプトで`\password postgres`と打って新しい値を入れる。
      値はコマンドの引数に載らず、履歴にも残らない。

      ```bash
      mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres
      ```

   2. 新しい値を、[セットアップ](setup.md#秘密値を投入する)の手順で`DB_PASSWORD`として投入する。
   3. `mise run up`を実行する。
      コンテナの`DATABASE_URL`が新しい値で作り直される。
   Postgresのパスワードを変えてから`mise run up`で反映するまでの間、Windmillはデータベースに接続できない。
4. workerの`/var/lib/factory/claude`と`/var/lib/factory/gh`に、ログインの記録があれば、発行元で失効させてから消す。
   中身は、次のコマンドで確かめる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker ls -A /var/lib/factory/claude /var/lib/factory/gh
   ```

## 資格情報の取得

`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`は自分で決める。
次の5つは外部のサービスから取得する。
取得した値の投入は[セットアップ](setup.md)の手順で行う。

### GitHubのPAT

`GITHUB_TOKEN`には、GitHubのfine-grained personal access tokenを使う。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押す。
   表示された`github_pat_...`は一度しか表示されないので、その場で`GITHUB_TOKEN`として投入する。
5. orgのリポジトリが対象なら、org側でトークンを承認する。
   orgの設定によっては承認が要る。

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

ContentsをRead and writeにするのは、PR修正と実装のフローがブランチにpushするためである。
WorkflowsはNo accessのままにする。
`.github/workflows/`を含むpushをGitHubに拒否させるためである。
実装フローは`.github/`の変更を止めずに記録するので、この拒否が実質のガードになる。
ただし、この拒否が及ぶのは`.github/workflows/`の下だけである。
`.github/actions/`のcomposite actionには及ばないので、PR修正はパスで止め、実装フローは記録する。
組み立てなど配布物に関わる手順は、composite actionに分けない。

ActionsをRead-onlyにするのは、次の3つを読むためである。

- `watch_main_ci`が読む、対象リポジトリの既定のブランチのActionsの実行
- `watch_pr_ci`が読む、FactoryのPRのheadのActionsの実行
- CI回の部品(`getWorkflowJobLog`)が読む、失敗したジョブのログ本文。
  詳細は[CIの失敗を直す部品の仕様](internals/ci-fix.md)にある。

書き込みの権限は付けない。
実行の再実行や取り消しをさせないためである。
権限が足りないリポジトリは、`watch_main_ci`が要対応の通知`main_ci_check_denied`で、`watch_pr_ci`が要対応の通知`pr_ci_check_denied`で知らせる。
権限が足りない間は、そのリポジトリのCIの失敗に気づけない。
`watch_pr_ci`は、実行の一覧とジョブの一覧とPRの状態に加えて、PRのコミット本文と、Factoryのリポジトリのfactory-fixスキルのファイルを読む。
ワークフローのログは取得しない。
コミット本文は、トレーラーの照合だけに使い、ログに出さない。
スキルのファイルは、マーカーの有無だけを見る。
ログを読んでClaudeに渡すのは、`watch_pr_ci`が起動した`pr_fix`のCI回だけである。
`watch_pr_ci`が起動するのは、設定`pr_ci_fix_enabled`が`true`のときに限る。
起動の判断は、レビューの有無、ジョブの種類などの固定の条件で決め、PRやログの文字列を読んで決めない。
コミット本文は、トレーラーの行との完全一致だけを見て、自由な文字列は解釈しない。
通知とDiscordの文は固定文で、workflowの名前、実行の結論、ログといった外部の文字列を入れない。
リポジトリへ書ける人が決める文字列なので、通知を介して人やClaudeへ指示を渡させないためである。
設定`pr_ci_watch_human_prs`が`true`のときは、許可された人が作ったPRのheadの実行も同じ権限で読む。
許可された人は、PATのアカウントと`allowed_labeler_logins`のアカウントである。
候補は、収集の表の行と、設定で明示したリポジトリのRESTの一覧から見つける。
検索は使わない。
表の行も一覧の要素も候補を絞るだけなので、PRを読み直して、作者の種別が`User`で、許可された名前(IDを設定した名前はIDも)に合うことを確かめる。
種別が`Bot`の作者、forkのPR、Factoryの実装ブランチの形のブランチのPRは、行を作らない。
リポジトリ、作者、fork、ブランチは、どちらの元から来た候補でも読み直した値で確かめる。
記録するheadも読み直したheadで、表と一覧のheadは使わない。
表の行が欠けるか書き換えられて候補が減れば、次に収集が書き直すまで記録されず、失敗の通知が遅れるだけである。
一覧は、リポジトリの名前を、GitHubの名前の形で検査してから読む。
残るリスクとして、記録が古い明示でないリポジトリの人のPRは、見つからない。
読めない間は、収集の鮮度の監視が通知するまで、黙って見送る。
明示でないリポジトリのうち、`gh_repos`に行が無いものの人のPRも、通知なしに見送る。
読み取りトークンに見えないリポジトリと、所有者のforkが当たる。
明示リポジトリは、行が無くても一覧で読む。
第三者が1000件超のPRで、一覧を読む明示リポジトリを埋めることもある。
一覧を読むのは、表の記録が新しくないか行が無い明示リポジトリと、収集が止まっている間である。
`owners`の外の`factory_repo`は、表に行が無いので、常に該当する。
1回の実行に、1リポジトリ10ページ、発見の時間の予算30秒、rate limitでの停止という上限がある。
時間の予算は、読み始める前に確かめる。
読み始めた1リポジトリは最大10ページを読み切るので、1リポジトリの分だけ超えうる。
FactoryのPRの判定と起動は発見より前に終わるので、この超過に巻き込まれない。
検索へ戻す設定は無い。
残るリスクの表の[R-CRED-01](security-risks.md#r-cred-01)にあたる。
人のPRには、直す作業項目を起動せず、PRとリポジトリへの書き込みもしない。
通知の文は、FactoryのPRと同じ固定文である。
forkのPRの実行と、別のPRの実行は、判定に使わず捨てる。
headのリポジトリのIDがベースと違う実行と、結び付いたPRの番号が違う実行を使うと、forkや別のPRの結果を、FactoryのPRの結果として扱ってしまうためである。
Actions: Read-onlyでは、実行の一覧だけでなく、選んだ全リポジトリの実行のログとartifactも読める。
`github_token`は、Console用workerの`approval_decide`と`retry_work_item`も読む。
残るリスクは[R-CRED-02](security-risks.md#r-cred-02)である。

PRのマージの競合を検知するscript`watch_pr_conflicts`は、Pull requestsの読み取りだけを使い、開いているPRの一覧とPRの状態を読む。
読む範囲は、許可リストに合うリポジトリの開いているPRで、作者を問わない。
検索は使わない。
判定するのは、そのうちPATのアカウントが作った、Factoryのブランチの形のPRだけである。
見つけ方は[PRのCI監視の内部仕様](internals/pr-ci.md#対象の見つけ方)にある。
収集の2つの設定が真のときは、リポジトリの発見とPRの列挙を収集の表から読む。
表の値は候補を絞ることにだけ使い、Factoryがpushしてよいブランチかの判断には使わない。
候補は、読み直したPRの応答で確かめ直してから扱う。
確かめるのは、PATのアカウントが作ったか、forkでないか、Factoryのブランチかである。
競合の通知と起動の判断は、RESTで読み直した値に固定する。
そのため、表の値が書き換えられても、候補が増えれば読み直して飛ばす。
候補が減れば、次に収集が書き直すまで列挙されず、処理が遅れるだけである。
`watch_pr_conflicts`自身は、PRとリポジトリへ書き込まない。
設定`pr_conflict_fix_enabled`が`true`のときは、競合を直す作業項目(`pr_fix`の競合回)を起動する。
そのフローが、同じPATでmergeコミットをPRのブランチへpushする。
書き込みの安全策は、[マージの競合を解く回](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策)に書く。
起動の判断のために、読む資源が増える。

- PRのcommit本文は、トレーラー`Generated-By`の完全一致の判定だけに使う。
  ログと通知には出さない。
- Factoryのリポジトリのfactory-fixスキルは、マーカーの有無だけを見る。
  本文は使わない。
- リポジトリの既定のブランチの名前と、その先頭のshaを読み、mainのCIの記録を引く。

起動の入力は、作業項目のIDだけである。
競合の行のIDと競合の回は、作業項目の列から読む。
保留の理由を通知とDiscordの文に載せるときは、語彙の固定値に対応する固定の説明だけを使う。
外部の文字列は載せない。
通知とDiscordの文には、PRの題名やブランチ名を載せない。
リポジトリへ書ける人が決める文字列を、通知を介して人やClaudeへ渡させないためである。
残るリスクは[R-CRED-03](security-risks.md#r-cred-03)、[R-CRED-04](security-risks.md#r-cred-04)である。
REST一覧を読むのは、表の記録が新しくない間の作業項目、競合の行、明示リポジトリと、収集が止まっている間である。
残るリスクは[R-CRED-01](security-risks.md#r-cred-01)である。
1回の実行に、1リポジトリ10ページ、予算120秒、rate limitでの停止という上限がある。
明示リポジトリは、運用者本人のPRが無くてもREST一覧で読まれる。
残るリスクは[R-CRED-05](security-risks.md#r-cred-05)である。

fine-grained PATは、トークンの値を変えずに権限の設定だけを変えられる。
権限を変えるときは既存のトークンを更新すればよく、再発行は要らない。
orgのリポジトリでは、権限を足すと、org側で再び承認を求められることもある。
承認するまで、同じ通知は残る。

Issue化の提案を承認してIssueを作るとき(`issue_proposal_apply`)も、同じ`f/factory/github_token`を使う。
別の資格情報は用意しない。

作成済みのIssueは、本文の最後の行の目印で見つける(`findIssueByMarker`)。
リポジトリのIssueの一覧を、PATのアカウントが作ったものに絞り、新しい順に読む。
本文の途中にある目印は、人が引用や貼り付けで書けるので、作成済みの印として信じない。
提案の作成時刻の1時間前より古い項目に当たったら読み終える。
10ページ(1000件)で読み終えなければ失敗にして、提案を保留に戻す。
一部だけで「無い」と判断すると、Issueが重複して作られるためである。
1000件は、PATのアカウントが作ったIssueとPRの合計である。
PRは除くが、ページは消費する。
走査は承認のたびに行う。
前回の試行があるときだけに絞る案は、試行の記録の列を足すmigrationが要るので採らない。
走査の所要時間に、実時間の予算は置かない。
残るリスクは次のとおりである。

- [R-CRED-06](security-risks.md#r-cred-06)
- 外の人が、PATと同じアカウントのIssueの最後の行に、目印を書く経路は無い。
  一覧を作成者で絞ること、Factoryが作るIssueの最後の行が`appendIssueProposalMarker`の目印に固定されることが、その根拠である。
  `pr_fix`の提案では、外の人が書いたレビューのコメントの文が、Issueの本文に入りうる。
  その文の後ろに目印が付くので、外の人の文が最後の行になることは無い。
  偽の目印は、作成済みのIssueとして再利用される。
  新しいIssueは作られず、再利用されたIssueの番号が`setIssueProposalCreatedIssue`で提案に記録される。
  `pr_fix`の提案では、PRのスレッドにその番号で返信して、スレッドを解決する。
  ラベルは再利用のとき付け直さず、記録済みの選択をそのまま付けた扱いにする(`issue_proposal_apply.ts`の`labelApplied`)。
  そのため、実際には付いていないラベルが付いた扱いになりうる。
  残るリスクの表の[R-CRED-07](security-risks.md#r-cred-07)にあたる。
- [R-CRED-08](security-risks.md#r-cred-08)
- [R-CRED-09](security-risks.md#r-cred-09)
- [R-CRED-10](security-risks.md#r-cred-10)

有効期限は最長で1年である。
`poll_issues`は冒頭で`GET /user`を呼び、トークンが失効していればジョブを失敗させる。
失敗は、スケジュールの失敗を拾う検出器(`detect_schedule_failures`)が`job_failures`に記録し、Discordに`job_failed`として通知する。
直近3回の実行が続けて失敗すると、要対応の通知`schedule_failing`も残る。

GitHubの認証は、環境変数`GH_TOKEN`と、gitのcredential helperとしての`gh auth git-credential`だけで行う。
`gh auth login`の対話ログインと、トークンを埋め込んだclone URLは使わない。

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

### 収集用の読み取りトークン

`GITHUB_READ_TOKEN_<OWNER>`は、収集の`collect_github`が所有者ごとに使う、読み取り専用のfine-grained PATである。
`GITHUB_TOKEN`は流用しない。
書き込みのできるトークンを、定期ジョブ用workerに届かせないためである。
fine-grained PATはResource ownerを1つしか選べないので、所有者(個人と所属する組織)ごとに1つ作る。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押し、表示された`github_pat_...`を、`GITHUB_READ_TOKEN_<OWNER>`として投入する。
5. 組織の所有者は、組織側でfine-grained PATを許可し、トークンを承認する。
   承認が保留や取り消しになると、非公開リポジトリが一覧から消えて`gone`になる。
   収集は閉じる側に倒れる。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-factory-reader-<所有者>` |
| Description | `Software Factory collector (read-only: PR / Issue state)` |
| Resource owner | その所有者(個人のアカウントかorg) |
| Expiration | Customで1年後。組織が最長期限を1年より短くすることがある |
| Repository access | All repositories。集める範囲は、設定の`owners`と`repo_allowlist`で絞る |
| Repository permissions: Metadata | Read-only(自動で付く) |
| Repository permissions: Pull requests | Read-only |
| Repository permissions: Issues | Read-only |
| それ以外のRepository permissions | No access。Contentsは付けない。Actions、Checks、Commit statusesは、CIの状態を集める変更で足す |
| Account permissions | すべてNo access |

できれば、すべての読み取りトークンを`GITHUB_TOKEN`と同じアカウントで作る。
トークンの持ち主が違うと、後の変更でPRの作者や担当を比べるときに、意味がずれるためである。
Contentsを付けないのは、Metadata、Pull requests、IssuesのRead-onlyだけで、収集の問い合わせが読む項目に足りるためである。
権限名とGraphQLの項目の対応は、反映後の実ジョブで確かめる。
段2の詳細の問い合わせも、ブランチの名前とSHAを、参照を辿らずにPRのスカラー項目で読む。
参照を辿ると、Contentsの権限が要りうるためである。
ラベル、担当、レビュー依頼の接続も読むが、どれもContentsの権限は要らない。
チームのレビュー依頼などの任意の項目が拒否されたときは、その項目の列だけが`NULL`になる。

値は`mise run bootstrap`が、環境変数から所有者のlogin(小文字)をキーにしたJSONの対応表に組み、Windmillのsecret変数`github_read_tokens`に入れる。
人がJSONを組むことは無い。
`bootstrap.sh`は、次のものを、環境変数の名前だけを出して警告し、飛ばす。
値は出さない。

- loginの形に合わない名前
- 名前を直した結果が同じloginになる複数の変数(両方を飛ばす)
- `github_pat_`で始まらない値
- `GITHUB_TOKEN`か`CONSOLE_GITHUB_TOKEN`と同じ値

loginに`_`を含む所有者(EMUのアカウント)は、環境変数の名前の`_`が`-`に直るので、対応表のキーに合わない。
収集は扱わない。
`mise run doctor`が、`owners`にある該当の所有者の名前を警告する。

## Windmillの公開範囲と初期パスワード

Caddyは`WM_BIND`のアドレスにだけバインドする。
既定値は`mise.toml`の`[env]`にある`127.0.0.1`なので、ホストの外からは到達できない。
外部に公開するときは、利用者が`WM_BIND`を明示的に変える。

初期の管理者アカウントのパスワードは、既知の既定値`changeme`である。
`scripts/bootstrap.sh`はログインした後、パスワードを必ず`WM_ADMIN_PASSWORD`に変える。
`WM_ADMIN_PASSWORD`が`changeme`か12文字未満なら、`bootstrap.sh`は実行を拒む。

`mise run doctor`は、既定のパスワードでログインできる状態をNGとして報告する。

ログインのセッション(`/auth/login`で発行されるもの)の有効期間は30日に設定している。
有効期間が更新される仕組みの有無は、確かめていない。
端末を紛失したときにセッションを失効させる手段も、確かめていない。
`WM_BIND`を外向きにするときは、`WM_SESSION_VALIDITY_SECONDS`を`mise.local.toml`などmiseの設定で上書きして短くする。
手順は[セットアップ](setup.md)にある。

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
| Console自身の誤りを防ぐ | 呼べるscriptは、許可リストの18個(読み取りの5つと、承認、再実行、監査の起動、通知の解決、手動投入の受付、PRレビューの投入の受付、保留の解除、凍結の解除、ジョブの取消、定期ジョブの再実行、設定の変更、保留と凍結を置く、スケジュールを止める)だけである。scheduleを有効に戻すscriptは無い。認可はWindmillのログインに任せる。承認者と解決者は、画面から渡さず、ジョブの実行文脈からscriptが導き、導けなければ拒否する。Consoleの書き込みは、同一オリジンの`fetch`によるPOSTで送る。副作用のあるGETと、ページの移動による書き込みは、上の行のとおりCaddyが止める |
| 配信する状態を絞る | `/console/status.json`で配信するのは、`console_fetcher`の状態の4項目(`state`、`sha`、`checked_at`、`error`)だけである。`checked_at`と`error`から、自動の配信が止まっていることなど運用の状態が外から見える。`error`には分類した失敗の種類だけを書き、トークンや応答の本文などの秘密は含まない。ボリュームの他のファイルは配信しない |
| 秘密を配信物に入れない | Consoleのバンドルは認証なしで配信されるので、`VITE_*`の変数に秘密を入れない |

> [!WARNING]
> `factory_console`を、`console_fetcher`以外のコンテナに書き込みでマウントしない。
> workerのサンドボックスを作るときも同じである。
> 書けるコンテナが増えると、運用者のブラウザに居座る改ざんの経路になる。

残るリスクは次のとおりである。

- [R-DLV-01](security-risks.md#r-dlv-01)
- 新規投入の再送は、冪等キーで止める。
  画面は、投入の1回ごとにキーを作り、メモリだけに持つ。
  リロードをまたぐ保持は持たない。
  同じキーの再送は、最初の投入のIssueを返し、Issue、作業項目、pipelineを増やさない。
  止まる範囲と止まらない範囲は、次のとおりである。
  - 止まるのは、同じ画面と同じタブで、リロードをしないまま、投入されたか分からない状態から入力を変えずに再送する場合である。
  - 止まらないのは、次の場合である。
    - リロードの後の再送
    - 別のタブからの再送
    - 入力を変えた再送。
      新しいキーを付けて、別の投入として扱う
    - キーを付けない直接のフロー実行
    - 保持期間(`retention_work_items_days`)を過ぎたキー

    これらの場合は、Issue、作業項目、pipelineが重複しうる。
    通常の進め方で重複したpipelineは、承認で止まり、無人では実装まで進まない。
    承認を省く進め方は、承認で止まらない。
    そのため、キーを必須にして、キー無しの重複を入口で断る。
    キーを付けた承認を省く投入が重複するのは、キーが変わる場合に限られる。
    その場合は、実装が二重に起動し、PRが重複しうる。
    Consoleの画面は進め方を送る。
    承認を省く投入ができるのは、フォルダ`f/factory`のscriptを実行できる管理者に限られる。
    リロードの後や、入力を変えた後の再送では、承認を省く投入が重なりうる。
    重なったIssueとPRは、人がマージするまで反映されず、人が閉じられる。
    入力とキーをタブのメモリだけに置く方針を保つため、リロードをまたぐ保持は持たない。
    残るリスクの表の[R-DLV-02](security-risks.md#r-dlv-02)にあたる。
  - 同じキーで内容が違う投入は、黙って捨てず、`intake_key_conflict`で失敗させて通知に出す。
  - 作成の途中で別のジョブが同じキーを予約しているときは、成功で返さず、`intake_key_in_flight`で失敗させて通知に出す。
    成功で返すと、作成が失敗したときに、Issueの無い投入が成功に見えるためである。
  - 作成に失敗しても、予約は消さない。
    GitHubに届いたか分からないためである。
    次の試行は、Issueの本文の末尾の目印(`<!-- factory:intake:<キー> -->`)で、作成済みのIssueを探して使う。
    本文の末尾は、区切りの行(`<!-- factory:intake:end -->`)、空行、目印の順に終わる。
    手動投入は、キーの有無にかかわらず本文の最後に区切りの行を足す。
    利用者の入力の最後の行に目印を書かれても、本文の末尾は区切りの行になり、別のIssueを作成済みと見誤らない。
    探索が見つけたIssueの本文がこの形で終わらないときは、作成済みと信じない。
  - 予約は、予約したジョブの識別子を持つ。
    予約を取り直せるのは、番号が無いまま10分を過ぎた予約だけで、番号を書けるのは持ち主のジョブだけである。
    取り直しの条件は、更新と同じ1つの文に入れる。
    時刻の比較は、DBの時計だけで行う。
  - 目印の探索と予約の取り直しの残るリスクは、[R-DLV-03](security-risks.md#r-dlv-03)にまとめる。
    GitHubの一覧の反映が遅れると、目印の探索が作成済みのIssueを見つけられず、Issueが二重になりうる。
    `gh`がタイムアウトすると、予約が10分残る。
    その間の同じキーの再送は、`intake_key_in_flight`で失敗して通知に出る。
    取り直した試行の目印の探索が、タイムアウトやレート制限、一覧の件数の上限で失敗すると、予約の時刻だけが先へ進む。
    探索の窓は予約の時刻から始まるので、次の取り直しは最初の試行が作ったIssueを見つけられず、Issueが二重になりうる。
    被害はIssue1件の重複で、重複したpipelineは承認で止まる。
    承認を省く進め方では、重複したIssueが承認で止まらない。
    ラベルも作業項目も無い孤立したIssueとして残り、人が閉じる。
    残るリスクの表の[R-DLV-03](security-risks.md#r-dlv-03)にあたる。
  - 承認を省く進め方では、キーが必須である。
    検証(`validateManualIntake`)、Issueの作成、登録の3か所が、副作用の前に断る。
    キーを扱う3つのファイルと、キーの表のmigrationは、保護パスに入れる([進め方ごとの承認](internals/implement.md#進め方ごとの承認))。
- 承認の二重の送信を画面で止められるのは、このタブの中だけである。
  別のタブや別の端末、リロードの後は止められない。
  Issue提案のIssue作成のやり直しは、画面でもこのタブで15分間止める。
  それでも重なると、どちらの呼び出しも作成済みのIssueが無いと見て、Issueが2件できうる。
  サーバーは、Issueを作る前に承認依頼ごとの印を条件付きのUPDATEで取り、取れなかった呼び出しを何もせずに終えて、この重なりを緩和する。
  Windmillの同時実行の制限(`concurrent_limit`)は設定しない。
  有償版でしか効かない。
  設定すると、自動の反映を拒否されるおそれもある。
  印は15分で切れるので、止まった処理のやり直しは塞がれない。
  失敗して提案を保留に戻した後も、印は期限まで残る。
  期限を過ぎて走り続けた呼び出しが失敗して戻すとき、印を取り直した別の呼び出しがIssueを作っている最中でも、次の承認と重ならないようにするためである。
  印に持ち主の識別子は無い。
  残るリスクの表の[R-DLV-04](security-risks.md#r-dlv-04)にあたる。
- [R-DLV-05](security-risks.md#r-dlv-05)
- [R-DLV-06](security-risks.md#r-dlv-06)
- HTTPSで公式の取得元(`cdn.playwright.dev`、予備に`playwright.download.prss.microsoft.com`)から取る。
  キャッシュのトークン(`ACTIONS_RUNTIME_TOKEN`)は、`permissions`と関係なく全ジョブに渡る。
  そのため、`main`のpushで動かすと、`main`の範囲のキャッシュ(`console-dist.yml`が復元するビューアのキャッシュ)へ書く経路ができる。
  `main`の実行では、このジョブを飛ばす。
  ブラウザはキャッシュせず、毎回取得する。
  照合しないキャッシュを、`main`の実行が書いてPRの実行が読む経路を作らないためである。
  残るリスクの表の[R-DLV-07](security-risks.md#r-dlv-07)にあたる。
- [R-DLV-08](security-risks.md#r-dlv-08)
- [R-DLV-09](security-risks.md#r-dlv-09)
- [R-DLV-10](security-risks.md#r-dlv-10)
- [R-DLV-11](security-risks.md#r-dlv-11)
- [R-DLV-12](security-risks.md#r-dlv-12)
- [R-DLV-13](security-risks.md#r-dlv-13)
- [R-DLV-14](security-risks.md#r-dlv-14)
- [R-DLV-15](security-risks.md#r-dlv-15)
- [R-DLV-16](security-risks.md#r-dlv-16)
- [R-DLV-17](security-risks.md#r-dlv-17)
- 前段でTLSを終端するときは、プロキシが`Host`をポートを含めて保つ(nginxなら`proxy_set_header Host $http_host`)。
  nginxの既定は`Host`を書き換え、`$host`はポートを落とす。
  どちらも`Origin`と合わず、ログインを含む書き込みがすべて403になる。
- [R-DLV-18](security-risks.md#r-dlv-18)
- [R-DLV-19](security-risks.md#r-dlv-19)
- [R-DLV-20](security-risks.md#r-dlv-20)
- [R-DLV-21](security-risks.md#r-dlv-21)
- [R-DLV-22](security-risks.md#r-dlv-22)
- [R-DLV-23](security-risks.md#r-dlv-23)
- 旧Consoleへの規則は、過去のDiscordの通知、Issueのコメント、PRの本文に残るリンクのために、旧Consoleを削除した後も残す。
  飛ばすのは閲覧の`/apps/get/`と`/apps_raw/get/`だけで、編集画面やAPIには触れない。
  フラグメントはブラウザがリダイレクトを越えて保ち、新しいConsoleが読み替える。
  読み替えるのは、正の整数のidを持つ要件定義書と監査レポートの形だけで、ほかのフラグメントは入口に着く。
- [R-DLV-24](security-risks.md#r-dlv-24)
- [R-DLV-25](security-risks.md#r-dlv-25)
- [R-DLV-26](security-risks.md#r-dlv-26)
- [R-DLV-27](security-risks.md#r-dlv-27)
- [R-DLV-28](security-risks.md#r-dlv-28)
- [R-DLV-29](security-risks.md#r-dlv-29)
- [R-DLV-30](security-risks.md#r-dlv-30)
- 検証用サーバー(`scripts/console-branch-server.ts`)は、ブランチ版のConsoleに、運用者のCookieで本物のWindmillのAPIを呼ばせる。
  ブランチの変更は人のレビューの前なので、悪意のあるConsoleのコードは、運用者のCookieで管理者の操作を呼べる。
  そのため、既定は読み取りだけにする。
  中継するのは、許可リストにあるGET、HEAD、OPTIONSと、読み取りの5つのscriptを実行するPOSTだけである。
  WindmillはGETでもscriptを同期で実行できるので、実行の経路とwebhookはGETでも断る。
  待ち受けは`127.0.0.1`だけで、Hostは`127.0.0.1:<port>`と`localhost:<port>`に限る。
  Originは自身のオリジンに限り、`Sec-Fetch-Site`が`cross-site`か`same-site`の要求は断る。
  転送元を名乗るヘッダーとhop-by-hopのヘッダーは、中継先へ渡さない。
  書き込みは、人が`--allow-writes`を付け、端末で「yes」と入力したときだけ届く。
- [R-DLV-31](security-risks.md#r-dlv-31)
- [R-DLV-32](security-risks.md#r-dlv-32)
- [R-DLV-33](security-risks.md#r-dlv-33)

## workerコンテナの権限

workerは`privileged`にせず、`FAVOR_UNSHARE_PID`も有効にしない。
Windmillの公式の構成は、ジョブを隔離するためにこれらを使うことがある。
このworkerは信頼できないIssueを読むheadless Claudeを実行するので、侵害されたときにホストへ波及する範囲を小さくすることを優先する。

ジョブ間の隔離は、追加の特権に頼らず、工程ごとのツールの制限と読み取り専用の方針で確保する。

workerには`no-new-privileges:true`と、プロセス数の上限(`deploy.resources.limits.pids`)を設定する。
`cap_drop`は、ジョブが使わない`NET_RAW`、`MKNOD`、`SETFCAP`、`AUDIT_WRITE`に限る。
`NET_RAW`は、同じnetworkの他のコンテナへのなりすましの足場になるため、落とす。
`SYS_CHROOT`、`FSETID`、`NET_BIND_SERVICE`は、Windmill本体が使わないことを確かめていないので残す。
`ALL`を落として必要なものだけを足す構成は、Windmill本体が使うものを確かめていないので採らない。
検査コマンドの実行には`CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`SETUID`、`SETGID`、`SETPCAP`、`KILL`が要るので、これらは落とさない。
workerのプロセスは、ベースのWindmill公式イメージがrootでの実行を前提にしているため、rootで動かす。
信頼できないコードを実行する検査コマンドだけを、非特権のユーザーに落とす([検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限))。

workerのPATHには、rootのホームの`/root/.local/bin`と、誰でも書き込める`/tmp`の下の`/tmp/.local/bin`を入れない。
ベースのイメージのPATHは、この2つを含む。
`/tmp/.local/bin`は、Windmillの`windmill`の実行ファイルに参照が無く、稼働中のworkerにも存在しない。
非特権のuidがそこに`git`などを置くと、rootのworkerの名前解決を奪えるため、外している。
`claude`は`/usr/local/bin`のsymlinkから名前で起動する。

イメージには、検査コマンドを動かす非特権のユーザー`factory-check-0`から`factory-check-7`を作ってある。
`useradd -M`でホームのディレクトリは作らず、passwdに記録されるホームのパスも実在しない。
`HOME`は、実行のたびに`/tmp`の下に作る非公開のディレクトリを渡す。
ジョブの`TMPDIR`が指す先には作らない。
そこは検査用のユーザーが入れない0700の下なので、`HOME`にたどり着けないためである。
ログインシェルは使えない。
uidの切り替えに使う`setpriv`と、枠のロックに使う`flock`も入っている。
後始末に使う`kill`(procps)と、ACLを確かめて消す`getfacl`と`setfacl`(acl)も入っている。
イメージのビルドは、検査の実行と同じ引数の`setpriv`で、すべてのユーザーについて、uid、ケーパビリティの上限が空であること、`no_new_privs`を確かめる。
`kill`、`getfacl`、`setfacl`があることも確かめる。
使い方は[検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限)に書く。

## バックアップの控え

夜間のバックアップ(`f/factory/backup`)は、Postgresのクラスタ全体と`factory_state`を控える。
手順は[運用](operations.md#バックアップ)にある。
調査のClaudeの読み出しの拒否の一覧(`READ_DENY_BASE_PATHS`)は、`/var/lib/factory-backups`を含む。

### 控えに含まれる秘密

`cluster.sql`は、Windmillのデータベースの全体を含む。
Windmillの秘密の変数は暗号化されて入っているが、復号の鍵も同じデータベースにある。
そのため、控えを読める者は、Windmillのすべての秘密を読めるものとして扱う。
ロールのパスワードのハッシュも含む。

`factory_state.tar`は、`claude/`、`gh/`、`check-slots/`を除く。
`claude/`と`gh/`は、人がworkerに入って使うときのログインの記録で、控えに秘密を増やさないため除く。
`factory_config.json`は、変数とresourceへの参照を`<redacted>`に置き換える。
値はWindmillの補間しない読み取り(`ResourceService.getResourceValue`)で読むので、参照の先の秘密は解決されない。

### 置き場の権限

名前付きvolume`factory_backups`は、defaultのworker(`windmill_worker`)だけに`/var/lib/factory-backups`としてマウントする。
Console用workerと定期ジョブ用workerには付けない。
置き場と各世代のディレクトリは、rootの所有で0700にする。
検査コマンドを動かす非特権のユーザーに、控えを読ませないためである。
イメージのビルドが置き場を0700で作り、scriptも実行のたびに0700へ直す。
既にあるvolumeには、イメージのモードが写らないためである。

`mise run backup:export`は、写した世代を所有者だけが読める権限にする。
写した先と、そこから移した媒体は、ホストの権限で守る。

### 接続URL

`f/factory/db_backup_url`は、composeのPostgresのsuperuser(`postgres`)の接続URLである。
`pg_dumpall`はロールの一覧(`pg_authid`)を読むので、読み取り専用のロールでは足りない。
`mise run bootstrap`が`mise.local.toml`の`DB_PASSWORD`から組み立てて入れる。
パスワードは百分率符号化し、jqの引数に載せない。
scriptはURLを読み解き、接続の情報を環境変数(`PGPASSWORD`など)で`pg_dumpall`に渡す。
引数に載せると、`/proc/<pid>/cmdline`から検査用のユーザーにも読めるためである。

### 控えの残るリスク

- [R-BAK-01](security-risks.md#r-bak-01)
- [R-BAK-02](security-risks.md#r-bak-02)
- [R-BAK-03](security-risks.md#r-bak-03)

## Console用workerの境界

Console用のworker(`windmill_worker_console`)は、Consoleの問い合わせと操作の受付だけを処理する。
信頼できないIssueを読むClaudeは、このworkerでは動かさない。
このworkerの境界が守るのは、ファイルシステムだけである。
以下で「ボリューム全体」と書くのは、`factory_state`の最上位を指す。
`claude`、`gh`、`audits`、`requirements`などが並ぶ層である。
絞り方は次のとおりである。

| 項目 | 設定 |
| --- | --- |
| 書き込めるマウント | `worker_logs`と専用の依存キャッシュ`worker_console_dependency_cache`だけである。`worker_logs`は、`windmill_server`とすべてのworkerと共有する書き込みのマウントである |
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

tag`console`を使える主体は、インスタンスのカスタムtagで決まる。
superadminは、許可の有無にかかわらず使える。
superadminでない主体は、許可されたtagしか使えない。
Consoleのscriptをsuperadminでない主体から呼べるよう、`mise run bootstrap`と`mise run instance:tags`がカスタムtagに`console`を足す。
定期ジョブ用workerのtag`periodic`も、同じ2つが足す。
許可しても、このworkerのマウントとDBへの到達は変わらない。
変わるのは、このworkerでscriptを動かせる主体である。

`manual_intake_submit`で実際に投入できるのは、フォルダ`f/factory`の権限で決まる主体である。
このフォルダには所有者も追加の権限も付けていないので、ワークスペースの管理者だけが該当する。
tag`console`がsuperadminでない主体にも許されていても、フォルダの権限は広がらない。
フローは呼び出した主体の権限で起動し、`on_behalf_of_email`を置かない。
そのため、投入できる主体は、WindmillのUIから`manual_intake`を実行できる主体と同じである。
`on_behalf_of_email`を置くと、フローが別の主体の権限で動くので、Console用のscriptに置かれていないことを契約テストが確かめる。
PRのレビューを投入する`pr_review_submit`も同じ作りで、投入できる主体は、`pr_review_intake`を実行できる主体と同じである。
詳しくは、[PRレビューの投入](internals/console/security.md#prレビューの投入)にある。

管理者の資格情報を送る`doctor`と`bootstrap`は、宛先を`WM_HTTP_PORT`のポートの`127.0.0.1`に限る。
`WM_BASE_URL`は使わない。
`mise.toml`では`WM_BASE_URL`が8080に固定されている。
`WM_HTTP_PORT`だけを変えると、8080を使う別のサービスへパスワードを誤って送りうるためである。
ログインの前に`/api/version`がWindmillの応答かを確かめ、違えば資格情報を送らずに止まる。
この照合は開始時に1回だけ行う。
`bootstrap`の`curl`は、リダイレクトを追わず、環境変数のプロキシも使わない。
追うか通すと、資格情報が確かめていない宛先へ届くためである。

Consoleから押せる書き込みには、読むsecret変数の上限を決める。
`github_token`を読んでよいのは、`approval_decide`と`retry_work_item`だけである。
`audit_kickoff`、`notice_resolve`、`manual_intake_submit`、`pr_review_submit`は、どのsecret変数も読まない。
保留と凍結の3つ(`console_holds`、`hold_release`、`freeze_release`)も、どのsecret変数も読まない。
保留と凍結の3つは、`discord_webhook_url`も読めないので、Discordへは送らない。
解除の記録は情報の通知に残す。
ジョブを取り消す`console_job_cancel`も、どのsecret変数も読まず、SDKの呼び出しを許可表に絞る([ジョブの取消](internals/console/security.md#ジョブの取消))。
失敗した定期ジョブを再実行する`console_job_rerun`と、設定を変更する`console_config_update`も、同じ上限と同じ絞り方である([定期ジョブの再実行](internals/console/security.md#定期ジョブの再実行)、[設定の変更](internals/console/security.md#設定の変更))。
保留と凍結を置く`console_hold_place`と、スケジュールを止める`console_schedule_stop`も、同じ上限と同じ絞り方である。
詳しくは、[保留と凍結を置く](internals/console/security.md#保留と凍結を置く)と[スケジュールを止める](internals/console/security.md#スケジュールを止める)にある。
Consoleの操作で、外向きの資格情報が動く範囲を広げないためである。
tag`console`のscriptがimportでたどれるソースを数える契約テスト(`tests/scripts/console_worker_boundary.test.ts`)が、この上限を確かめる。
許可した2つも、`github_token`以外のsecret変数は読まない。
走査でたどれない形が現れたら、テストは落ちる。
たどれない形は、次のとおりである。

- 絶対パスと、`f/`か`u/`で始まるimport
- `require`
- 引数が単純な文字列リテラルでないimport()
- `.name("literal")`の形の呼び出しで説明できない、`getVariable`と`getResource`の出現。
  添字アクセス、分割代入、名前付きimport、別名への代入、引数が変数の呼び出し、注入された関数の呼び出しが当たる
- 呼び出し(`名前(`)でない、`getVariable`と`setVariable`の出現。
  別名への代入、`.call`、`.bind`、`.apply`、他の関数への受け渡し、`?.(`の形の呼び出しが当たる。
  パスの固定は呼び出しの引数を見るので、呼び出しでない使い方は固定をすり抜ける

script.yamlに`$var:`か`$res:`の参照があるときも、テストは落ちる。
例外は3件で、いずれも読み取りを依存として注入するため、引数が変数になる。
`console_query`は`deployed_sha`の読み取りである。
`loadConfig`は設定のリソースの読み取りである。
凍結の変数の入出力(`freeze_apply.ts`)は、注入されたSDKの読み取りである。
凍結の変数`f/factory/freezes`は、書き込みのときに`isSecretIfNotExist`へ`false`を渡すので、secretではない。
呼び出し側が定数だけを渡すことを確かめ、テストの許可リストに理由を書いている。
テストが見ないのは、文字列を組み立てて作ったsecretのパス、環境変数やDBを経由して受け取る名前、`eval`、文字列の中に隠したコードである。
これらはコードのレビューで見る。

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

- DBには届く。
  `DATABASE_URL`はdefaultのworkerと同じ管理者の接続だからである。
- 次のtag`console`のscriptは、resource`f/factory/factory_config`を読む。
  `audit_kickoff`、`retry_work_item`、`manual_intake_submit`、`pr_review_submit`、`console_query`、`console_fetch_watch`である。
  `console_query`は、手動投入の候補(`intake_targets`)のために読む。
  `approval_decide`と`notice_resolve`は、設定を読まない。
  契約テストが見るのはsecret変数の名前の読み取りだけなので、resourceの値に`$var:`の参照が無いことは、人が確かめる。
  参照があると、参照先のsecret変数が、tag`console`のscriptから読めてしまう。
  確かめる手順はtag`periodic`の場合と同じで、[tagを付けるscriptの選び方](#tagを付けるscriptの選び方)に書く。
- tag`console`のscriptは、管理者の`DATABASE_URL`か`wmill.getVariable()`で、Windmillのsecret変数を読める。
  読める変数には`f/factory/claude_oauth_token`と`f/factory/github_token`がある。
  `retry_work_item`が実際に読むのは、次の2つのときの`github_token`である。
  取り消された作業項目の再開のときの、対象の状態の確認。
  Issueの要件定義を作り直す再実行のときの、取り込み内容の更新。
  `approval_decide`が読むのは、要件定義の承認のときの`github_token`である。
  Console用のworkerで動くscriptから`github_token`を読むのは、この2つのscriptに限る取り決めである。
  この取り決めは、tag`console`のscriptがたどれるソースを数える契約テストで確かめる。
  強制する仕組みは無い。
  マウントの制限で守るのは、Claude Codeとghの設定と履歴のファイルだけである。
  トークンそのものは守らない。
- scriptを編集できる者は、tagを付けずにdefaultのworkerで動かせば、`factory_state`のボリューム全体を読み書きできる。
- 要件定義書と図は読める。
  Consoleが表示するのと同じ内容である。
- ジョブのログと結果を通して、defaultのworkerの出力に届く。
  `f/factory/`のジョブのログと結果は、伏せ字を通してConsoleに返る。
  伏せ字は、形を持つ秘密とキー名で見分けられる秘密しか伏せられない。
  次の秘密は伏せられない。
  - 16進だけの秘密。
    古い形式の40桁のOAuthトークンや、HMACの鍵である。
    commit shaとダイジェストを残す例外に当たるため。
  - base64や分割で符号化された秘密。
  - 32字に満たず、形も持たない秘密。
  - 1行ずつ別の葉(配列の要素)に分けたPEM。
    BEGINとENDが別の葉になり、ブロックとして読めない。
    本文の行は、`+`と`/`で途切れない32字以上の部分だけが、一般形の規則で伏せられる。
  - 形を確かめていないトークン。
    ユーザーのAPIトークンの形は実測していないので、一般形の規則に当たる保証は無い。
  defaultのworkerで動くscriptが、秘密値をログと結果に書かないことが前提である。
  伏せ字は画面の共有と貼り付けのための規則で、ConsoleのXSSの対策ではない。
- workerの生死とグループは、Consoleから読まない。
  `WorkerService`の一覧は、ワークスペースの管理者のジョブトークンでは403になる。
  Console用workerの停止は`console_worker_missing`の通知が、負荷は`worker_load`が、defaultのworkerの停止は`default_worker_watch`が知らせる。
- このworkerで動かすのはリポジトリのscriptの想定だが、これを強制する仕組みは無い。
  ワークスペースでscriptを編集できる者は、任意のscriptにtag`console`を付けられる。
  `console`をカスタムtagに許可しているので、superadminでない者が付けたscriptも、このworkerで動く。
  tag`console`を付けたscriptは、`requirements`の下を読める。
  書けるのはdefaultのworkerだけである。
- 許可した主体は、Console用workerの依存キャッシュ(`worker_console_dependency_cache`)に書ける。
  defaultのworkerでscriptを実行できる者には、元から同等のことができるので、実害は増えない。
- Console用workerの枠は1つである。
  長く動くjobで枠を埋めると、Consoleの問い合わせと承認が止まる。
  可用性の問題で、秘密の漏れではない。
- 許可はすべてのワークスペースに及ぶ。
  ワークスペースに絞る書式(`console(factory)`)は、実機で確かめていないので採用していない。
- `doctor`と`bootstrap`の宛先の照合が防ぐのは、ポートの取り違えだけである。
  Windmillを装うローカルのプロセスには、資格情報が渡る。
  照合とログインは別の接続なので、その間に宛先が入れ替わる隙もある。
  `bootstrap`は、1回の照合の後に長い手順で同じ宛先へトークンを送るので、手順の途中の入れ替わりも防げない。
- composeの環境変数`WORKER_TAGS`は既定値である。
  DBにワーカーグループの設定があると、そちらが実効になる。
  変化はWindmillの画面の「Workers」で確かめる。
- `factory_state_init`の確認の後にも隙がある。
  Console用のworkerは、`factory_state_init`を経ない起動のたびに、サブパスを解決し直す。
  契機は、restart policy、Dockerデーモンの再起動、ホストの再起動、手動の`docker compose restart windmill_worker_console`である。
  その前にdefaultのworkerが`requirements`をsymlinkに置き換えると、symlinkの先がマウントされうる。
  隙は、`factory_state_init`を経ずにworkerが起動するたびに開く。
  誤ったマウントは、symlinkを消してworkerを起動し直すまで残る。
  `mise run up`は、設定の変わらない、動いているworkerを作り直さないためである。
  `mise run up`が`factory_state_init`の失敗で止まったときは、その時点のworkerのマウントを疑う。
  [Console用workerを確かめる](operations.md#console用workerを確かめる)の手順でsymlinkを消し、workerを作り直す。
  突くにはdefaultのworkerでのコード実行が要る。
  その権限があれば`factory_state`のボリューム全体を直接読めるので、実害は増えない。

## 定期ジョブ用workerの境界

定期ジョブ用のworker(`windmill_worker_periodic`)は、tag`periodic`を付けた定期ジョブを処理する。
信頼できない入力を扱うジョブは、このworkerでは動かさない。
リポジトリのコードや検査コマンドを動かすジョブと、Issueの本文やPRの差分を読むClaudeがそれにあたる。
このworkerの境界が守るのは、ファイルシステムである。
Console用workerと同じ型で、絞り方は次のとおりである。

| 項目 | 設定 |
| --- | --- |
| 書き込めるマウント | `worker_logs`と専用の依存キャッシュ`worker_periodic_dependency_cache`だけである。`worker_logs`は、`windmill_server`とすべてのworkerと共有する書き込みのマウントである |
| `factory_state` | マウントしない。Claude Codeとghの設定、監査レポート、要件定義書に届かない |
| `factory_workspaces` | マウントしない。対象リポジトリのチェックアウトに届かない |
| `factory_console` | マウントしない。配信中のJSに届かない |
| `worker_dependency_cache` | 共有しない。専用のボリュームを使うので、defaultのworkerと依存のキャッシュを通して影響し合わない |
| `docker.sock` | マウントしない |
| 権限 | `privileged`にしない。`no-new-privileges:true`と`init`を設定し、defaultのworkerと同じ`NET_RAW`、`MKNOD`、`SETFCAP`、`AUDIT_WRITE`を落とす。プロセス数は256、メモリは1024Mに絞る。権限はdefaultのworkerの部分集合である |
| 環境変数 | `NUM_WORKERS`と`I_ACK_NUM_WORKERS_IS_UNSAFE`は置かない。nativeでないworkerは1つで動くためである |

信頼できない入力を扱うジョブを動かさない理由は、このworkerが読める秘密にある。
DBには、defaultのworkerと同じ管理者の接続で届く。
Windmillのsecret変数は、管理者の`DATABASE_URL`か`wmill.getVariable()`で読める。
通知に使う`discord_webhook_url`と、収集に使う`github_read_tokens`も読める。
Console用workerと同じ前提で、マウントの制限が守るのはファイルであり、トークンそのものは守らない。
信頼できない入力を扱うジョブが、このworkerで任意のコードを動かせると、これらの秘密に届く。
そのため、tag`periodic`を付けるのは、コードを実行せず、Claudeに文章を渡さない定期ジョブだけである。
このworkerの権限はdefaultのworkerの部分集合なので、誤ってtagを付けても権限は広がらない。
分ける目的は、定期ジョブの枠の確保である。

tag`periodic`を使える主体は、Console用workerのtag`console`と同じく、インスタンスのカスタムtagで決まる。
superadminは、許可の有無にかかわらず使える。
superadminでない主体は、許可されたtagしか使えない。
次のことは、この境界では守れない。

- DBには届く。
  `DATABASE_URL`はdefaultのworkerと同じ管理者の接続だからである。
- secret変数の`claude_oauth_token`、`github_token`、`discord_webhook_url`、`github_read_tokens`、`heartbeat_url`を読める。
  どのscriptが読むかを制限する仕組みは、契約テストの許可だけである。
- このworkerで動かすのは、上の基準で選んだ定期ジョブの想定である。
  リポジトリに入る変更のうち、テストが走査できる形は、契約テスト(`tests/scripts/periodic_script_boundary.test.ts`)が止める。
  走査できない形と、Windmillの画面でtag`periodic`を付ける操作は止められない。
  ワークスペースでscriptを編集できる者は、任意のscriptにtag`periodic`を付けられる。
- 許可はすべてのワークスペースに及ぶ。
  ワークスペースで絞らない。
- scriptを編集できる者は、tagを付けずにdefaultのworkerで動かせば、`factory_state`のボリューム全体を読み書きできる。
- 許可した主体は、このworkerの依存キャッシュ(`worker_periodic_dependency_cache`)に書ける。
  defaultのworkerでscriptを実行できる者には、元から同等のことができるので、実害は増えない。
- このworkerの枠は1つである。
  長く動くjobで枠を埋めると、ほかの定期ジョブが待つ。
  可用性の問題で、秘密の漏れではない。
- composeの環境変数`WORKER_TAGS`は既定値である。
  DBにワーカーグループの設定があると、そちらが実効になる。
  変化はWindmillの画面の「Workers」で確かめる。

### tagを付けるscriptの選び方

このworkerは上流のWindmillイメージで動く。
独自イメージの道具も、defaultのworkerがマウントするファイルも、cgroupの計測の対象も無い。
そのため、tag`periodic`を付けるのは、次のどれにも依存しない定期ジョブだけである。
依存するジョブは、defaultのworkerに残す。

- ファイル。
  `factory_state`、`factory_workspaces`、self cloneの下を読み書きするジョブがあたる。
  このworkerには同じパスのボリュームが無い。
  ジョブは失敗するか、コンテナの中の別のディレクトリを触って成功したように見える。
  後者は気づきにくい。
- 独自イメージの道具。
  `claude`、`gh`、`git`、`gtr`を使うジョブと、道具や検査の枠を確かめるジョブがあたる。
  道具や検査の枠を確かめるジョブは、上流のイメージでは、必ず確認に失敗して保留される。
- cgroup。
  cgroupのファイルを読んで、負荷や使用量を測るジョブがあたる。
- 子プロセス。
  `child_process`で外部のコマンドを起動するジョブがあたる。

選ぶときは、scriptと、importでたどれるソースをすべて読み、上の4つに依存しないことを確かめる。
見る箇所は、ファイルのパスと`fs`の使用、`child_process`のimport、道具や検査の枠を確かめる呼び出し、cgroupのパスである。
同じ手順で、コードを実行しないことと、Claudeに文章を渡さないことも確かめる。
1つでも依存するなら、tagを付けない。

読んでよいsecret変数は、scriptごとに決める。
次のscriptが読めるのは、`discord_webhook_url`だけである。

- `notify_daily_summary`
- `auto_retry_pr_review`
- `default_worker_watch`

`detect_schedule_failures`が読めるのは、`discord_webhook_url`と`heartbeat_url`だけである。
`heartbeat_url`を許可するのは、ホストやDockerごと止まったことを、外部の監視のサービスに気づかせるためである。
検出器は5分ごとに動き、成功した回の最後にURLを叩く。
叩くのが途絶えると、監視のサービスが止まったと知らせる。

`collect_github`が読めるのは、`github_read_tokens`だけである。
`claude_oauth_token`、`github_token`、`wmill_token`は、このworkerに届かせない。
対象のscriptが読まない許可は、残さない。
別のscriptの許可を借りて読めるようにしないため、許可はscriptごとに分ける。
`discord_webhook_url`を許可するのは、通知を送る定期ジョブを、このworkerで動かすために、通知の送り先が要るためである。
このworkerは、固定のレビュー済みのscriptだけを動かす。
漏れたときの影響は、通知の偽装と、webhookの削除や改名による通知の停止に限られる。
webhookのURLを持つ者は、トークンだけで改名と削除ができる。
補足として、どのworkerのジョブも`getVariable`で読める状態はもとからで、このworkerで読める範囲は広がらない。
別のsecret変数を許すかは、この理由とは別に、読む必要と漏れたときの影響で決める。
これを超えて広げるときは、契約テストの許可と、この節の選定の結果を同じ変更で直す。

`github_read_tokens`を許可するのは、収集を、書き込みのできる`github_token`を使わずに、このworkerで動かすためである。
トークンのRepository accessは「All repositories」なので、読める内容は所有者の全リポジトリに及ぶ。

- Pull requestsの読み取りで、非公開リポジトリのPRの題・本文・コメント・レビューコメント・コミットと本文・変更ファイルとpatch。
- Issuesの読み取りで、Issueの本文とコメント。
- Metadataの読み取りで、collaboratorの一覧。

書き込みはできないので、漏れたときの影響は、これらの読み取りと、レート制限の消費に限られる。
全部の所有者のトークンが、1つの変数に集まる。
変数は所有者ごとに分けない。
分けると、`getVariable`の引数がリテラルでなくなり、契約テストの`filesWithNonLiteralReads`に反する。
所有者ごとにテストの許可も要る。
1つのジョブが乗っ取られれば、分けても全部に届くので、分ける利点が無い。

契約テスト(`tests/scripts/periodic_script_boundary.test.ts`)が、tag`periodic`を持つscriptについて次を固定する。
走査の方法と、たどれない形は、Console用workerの契約テストと同じである。

- `f/`の下のYAMLのうち、tag`periodic`へ振り分けるものが、テストの一覧のscriptの定義と一致する。
  scriptの定義の`tag`だけでなく、スケジュールの`tag`と、フローのモジュールの`tag`と`tag_override`も、入れ子の中まで調べる。
  読めないYAMLがあれば、ファイル名を添えてテストが落ちる。
  足すときは、一覧とこの節の選定の結果を同じ変更で直す。
- どのscriptも、スケジュールが呼ぶscriptで、`timeout`を持つ。
- 各scriptについて、他のscriptの`timeout`の合計に300秒の余裕を足した値が、待ちの検知のしきい値(`PERIODIC_JOB_WAIT_SECONDS`)を超えない。
  このworkerの枠は1つなので、長く動くジョブの後ろで待つジョブを、workerの不在と誤って知らせないためである。
  待たされる最悪は、他のscriptのtimeoutの合計である。
  今の5本では、`detect_schedule_failures`が最も待たされる。
  他の4本は、どれも120秒のtimeoutで、その後ろで最大480秒待つ。
  しきい値は、それに余裕を足した780秒である。
- importでたどれるソースが読むsecret変数は、scriptごとの許可に限る。
  許可のキーが、tag`periodic`のscriptの一覧と一致することと、許可したsecretを実際に読むことも固定する。
  ある許可を別のscriptに当てると、違反が返ることも確かめる。
- importでたどれるソースに、ファイル、サブプロセス、`claude.ts`への依存が無い。
  `node:fs`、`node:child_process`、`bun`モジュールのimportと、`Bun`の使い方を調べる。
  `Bun.sleep`のような無害なメンバー以外は、`Bun.spawn`や`Bun.file`に加えて、分割代入、別名への代入、添字アクセスも当たる。
  `globalThis`、`process.getBuiltinModule`、`process.binding`も当たる。

`node:module`、`node:worker_threads`、`node:vm`のimportも、迂回に使えるので数える。
`f/`の下のTypeScriptが、`JobService.run*`でジョブを起動したり、tagの文字列を渡したりしていないことも、テストが確かめる。
現在、該当する呼び出しは0件である。

テストが見ないものは、コードのレビューで見る。

- 式で組み立てたtag、フローの入力で渡すtag。
- Windmillの画面で付けたtag。
- 文字列で組み立てた参照、`eval`と`Function`、注入された関数の中身。
- 第三者パッケージ(`execa`、`fs-extra`、`zx`など)の中身。
- resourceの中身で解決されるsecret。
  `getResource`が返す値の中の`$var:`は、走査が見ない。

tag`periodic`を新しく付けるPRでは、そのscriptが読むresourceの中身を確かめる。
`getResource`の引数のresourceごとに、値に`$var:`で始まる参照が無いことを、Windmillで確かめる。
参照があれば、参照先のsecret変数が、そのscriptに許したものだけであることまで確かめる。
テストが固定するのはsecret変数の名前の読み取りだけなので、この確認は人かレビューが行う。

### 選定の結果

`f/factory/**`の定期実行のscriptを1つずつ読んだ結果は、次のとおりである。
tag`periodic`を付けたのは、次の5本である。

- `notify_daily_summary`
- `auto_retry_pr_review`
- `collect_github`
- `default_worker_watch`
- `detect_schedule_failures`

いずれもresource`f/factory/factory_config`だけを読む。
ローカルのインスタンスでは、その値に`$var:`と`$res:`の参照が無いことを確かめた。
本番相当のインスタンスのresourceは、リポジトリから確かめられない。
人がWindmillの画面で見て確かめる。

| script | 依存と読むsecret | 結論 |
| --- | --- | --- |
| `audit_kickoff`、`console_fetch_watch` | tag`console`でConsole用workerが動かす | 対象外 |
| `poll_dependabot`、`drawio_viewer_bump` | 保護パスで、`gh`と`github_token`を使う | 対象外 |
| `poll_issues`、`poll_prs`、`watch_pr_ci`、`watch_pr_conflicts`、`watch_main_ci` | `gh`、`git`、`github_token`を使う。`watch_pr_ci`は検査用イメージの確認も行う | defaultに残す |
| `cleanup_workspaces`、`self_update` | `factory_workspaces`、self clone、`git`、`gh`を使う。`self_update`は`wmill_token`も読む | defaultに残す |
| `cleanup_db` | `factory_state`の`requirements`ディレクトリを消す | defaultに残す |
| `backup` | `factory_state`と`factory_backups`のvolume、`pg_dumpall`と`tar`のサブプロセス、`db_backup_url`を使う | defaultに残す |
| `sample_worker_load` | cgroupのファイルを読む | defaultに残す |
| `notify_daily_summary` | DB、Windmillの状態、Discordだけを使う。読むsecretは`discord_webhook_url`だけである | `periodic`を付ける |
| `auto_retry_pr_review` | DB、WindmillのAPI、Discordだけを使う。読むsecretは`discord_webhook_url`だけである | `periodic`を付ける |
| `collect_github` | DB、Windmillのresource、宛先を固定したGitHubのGraphQLだけを使う。読むsecretは`github_read_tokens`だけである | `periodic`を付ける |
| `default_worker_watch` | DB、Windmillのqueueとジョブ履歴とschedule、Discordだけを使う。読むsecretは`discord_webhook_url`だけである。defaultのworkerが止まると動かないので、defaultには置けない | `periodic`を付ける |
| `detect_schedule_failures` | DB、Windmillのジョブ履歴、Discord、外部の死活監視だけを使う。読むsecretは`discord_webhook_url`と`heartbeat_url`だけである。失敗の記録とnoticeをDBに書き、外部の死活監視のURLを叩く。defaultのworkerで動かすと、長いジョブが枠を塞ぐ間、検知が止まるので置けない | `periodic`を付ける |

`github_token`を読む定期ジョブは、`gh`の道具に依存するため、tag`periodic`を付けられるものが無い。
`notify_daily_summary`と`auto_retry_pr_review`は、ファイル、サブプロセス、`claude`、`gh`のモジュールをimportでたどらない。
そのために、使う定数と型を小さなモジュールに分けている。
`collect_github`は、通信を`lib/gh_graphql.ts`に置き、`github.ts`を使わない。
`default_worker_watch`は、queueの応答を集計する副作用の無いモジュール(`worker_load_support`)を使う。
cgroupの文字列を解析するだけで、ファイルは読まない。
たどるようになれば、契約テストが落ちる。

### 収集のトークンの残るリスク

収集のトークンの残るリスクは、次のとおりである。

- [R-PER-01](security-risks.md#r-per-01)
- [R-PER-02](security-risks.md#r-per-02)
- [R-PER-03](security-risks.md#r-per-03)
- [R-PER-04](security-risks.md#r-per-04)
- [R-PER-05](security-risks.md#r-per-05)
- [R-PER-06](security-risks.md#r-per-06)
- [R-PER-07](security-risks.md#r-per-07)
- [R-PER-08](security-risks.md#r-per-08)
- [R-PER-09](security-risks.md#r-per-09)
- [R-PER-10](security-risks.md#r-per-10)
- [R-PER-11](security-risks.md#r-per-11)
- [R-PER-12](security-risks.md#r-per-12)
- [R-PER-13](security-risks.md#r-per-13)
- [R-PER-14](security-risks.md#r-per-14)
- [R-PER-15](security-risks.md#r-per-15)
- [R-PER-16](security-risks.md#r-per-16)
- 組織の所有者での次の4つは、実機で確かめていない。
  所有者が個人で、確かめる手段が無いためである。
  - `GET /user/teams`に必要なPATの権限。
    組織の権限のMembersの読み取りなどが要る可能性がある。
  - `GET /user/teams`が、PATのアカウントのチームを返すか。
  - 親チーム経由の依頼の扱い。
  - `requested_teams`と`/user/teams`の応答の形。
  組織の所有者を足すときは、先に[運用](operations.md#組織の所有者を足す前の確認)の手順で確かめる。
  権限が要ると分かったときは、同じ変更で[PATの権限](#githubのpat)の表に足し、種類をセキュリティとして監査を通す。
  今は、PATに権限を足していない。
- [R-PER-17](security-risks.md#r-per-17)
- `poll_prs`は、チームを使えて照合の結果対象でなかったPRを、1時間は確かめ直さない。
  残るリスクの表の[R-PER-18](security-risks.md#r-per-18)にあたる。
  次の場合に、最大で1時間気づかない。
  - 同じheadのまま、別のチームが依頼されたとき。
  - PATのアカウントが、依頼されたチームに足されたとき。
  - 表の依頼先が`NULL`のまま、同じheadで直接の依頼が足されたとき。
  - 作者を`allowed_labeler_logins`か`allowed_labeler_ids`に足したとき。
    作者が許可されていないために対象でなかったPRも、覚えているためである。
- [R-PER-19](security-risks.md#r-per-19)
- [R-PER-20](security-risks.md#r-per-20)
- [R-PER-21](security-risks.md#r-per-21)
- [R-PER-22](security-risks.md#r-per-22)

## ホストの実行役の境界

この節の内容は[ホストの実行役の内部仕様の「ホストの実行役の境界」](internals/host-apply.md#ホストの実行役の境界)にある。

## サブプロセスのnpmのinstall script

`self_update`と、ホストで動かすmiseのタスク(`mise run push`、`mise run deploy`など)は、`wmill sync push`のサブプロセスに次の環境変数を渡す。

```text
NPM_CONFIG_IGNORE_SCRIPTS=true
```

`wmill`がnpmを走らせることがあっても、依存のinstall scriptを動かさないためである。
install scriptは、workerの権限のまま、ネットワークにも出られる状態で動く。

Windmillの資産のうちnpmの依存を入れるのは、dependabotの更新のフローだけである。
`--ignore-scripts`を付け、検査コマンドと同じ隔離で動かす([インストールの後の確認](internals/dependabot.md#インストールの後の確認))。
ほかに足すときは、install scriptなしで組み立てが通るかを確かめる。

廃止した旧Consoleのappは、人が`mise run push:prune`を実行するまでWindmillに残る。
残ったappは更新されず、閲覧のURLはCaddyが新しいConsoleへ302で飛ばす。

## 依存の脆弱性

ルートの`bun audit`の指摘のうち、修正版が無いものの残るリスクは[R-TB-36](security-risks.md#r-tb-36)である。
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

## 依存の変更のレビュー

PRレビュー(`pr_review`)は、依存の宣言か取得を変えるPRに、サプライチェーン攻撃の観点で指摘する。
対象と観点、指摘の目安は、[factory-reviewスキル](../.claude/skills/factory-review/SKILL.md)の「依存関係の判定基準」にある。

指摘は人のレビューを補うもので、マージを決めない。
レビューのClaudeはレジストリを読めず、依存もインストールしない。
そのため、dependabotの自動マージの対象でないPRでは、版の公開日、メンテナの交代、リポジトリの移管、依存の中身のinstall時のスクリプトを人が確かめる。
dependabotの更新を自動でマージする前は、関門と影響調査がこれらを見る([dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ))。

## 反映の承認

この節の内容は[反映の承認の内部仕様の「反映の承認」](internals/deploy-approvals.md#反映の承認)にある。

## 自己更新の打ち切り

`self_update`のジョブには、全体の上限がある。
値と内訳は[アーキテクチャ](architecture.md)の「自己更新」にある。
通常は、各コマンドの上限と、区切ったSDK・DBの呼び出しの上限(30秒)で先に終わる。
全体の上限は、それでも止まったときの最後の砦である。

残るリスクは次のとおりである。

- [R-UPD-01](security-risks.md#r-upd-01)
- [R-UPD-02](security-risks.md#r-upd-02)
- [R-UPD-03](security-risks.md#r-upd-03)
- 残ったプロセスの見つけ方と、打ち切りが子を止めるかの確かめ方は[運用](operations.md)の「自己更新の打ち切りを確かめる」にある。

## 凍結とdeployの保留

この節の内容は[凍結とdeployの保留の内部仕様の「凍結とdeployの保留」](internals/freezes.md#凍結とdeployの保留)にある。

## 保留

この節の内容は[保留の内部仕様の「保留」](internals/holds.md#保留)にある。

## 全停止

全停止は、Factory全体を1つの操作で止める仕組みである。
手順は[運用](operations.md#全停止する)にある。
止める働きは、Windmillの秘密でない変数`f/factory/stop_all`と、それを読む各所にある。

- 変数を書くのは、Consoleの2つのscript(全停止と解除)と、それを`wmill script run`で呼ぶ`mise run stop`だけである。
  2つのscriptは、操作者を導き、操作の記録を残せないときは何も変えずに断る。
- 2つのscriptはConsole用のworkerで動き、どのsecret変数も読まない。
  Console用workerの境界の走査は、読む変数のパスを`freezes`、`stop_all`、`stop_all_record`の3つに限る。
  通知とDiscordへの送信は、定期ジョブ用のworkerで動く検出器が、変数を読んで行う。
- 2つのscriptは、`factory_config`の`*_enabled`を`true`から`false`へ変えるだけで、有効にする向きには変えない。
  解除しても`*_enabled`は戻らないので、解除の操作だけでは、止めた機能は動き出さない。
- 全停止のscriptは、止める名前を秘密でない変数`f/factory/stop_all_record`に記録する。
  名前の形は`*_enabled`に限り、64個までにする。
  記録の変数を名指しできる`f/`のファイルは、全停止のscriptと`lib/stop_all.ts`だけで、配線のテストが固定する。
- 止めた設定を戻すのは、ホストの端末で人が実行する`mise run stop:restore`だけである。
  Windmillのscriptを通らず、人の`wmill`のプロファイルで`factory_config`を書く。
  有効にする向きの書き込みを、Console用workerのscriptに持たせないためである。
  戻すのは、記録にあって今`false`で、設定の検査を通る名前だけである。
  書く前に名前を表示し、`yes`で確かめる。
  書く直前の読み直しと、書いた後の全停止の読み直しで、ほかの書き込みと全停止との競合を検出する。
- 実行中のClaudeと検査は、ランナーが15秒ごとに変数を読み、置かれていればプロセスグループごと止める。
  変数を読めないときは止めない。
  変数を読むAPIの障害で、動いている実行を壊さないためである。
  その受け皿は、ホストの`mise run stop -- --kill-only`である。
- 自己更新と取り込みは、変数を読めないときも見送る。
  止まっていないと確かめられないまま、Factoryを動かし直さないためである。
- `mise run stop`と`mise run stop:restore`は、端末で`yes`を入力して確かめる。
  端末を持たないsubagentと背景のセッションは、確認を通せない。
  `scripts/stop_all.ts`は、環境変数`CLAUDECODE`があるときも、確認の前に断る。
  Claude Codeのフックが`mise run stop`、`mise run stop:release`、`mise run stop:restore`、`scripts/stop_all.ts`の呼び出しと、全停止の変数と記録の変数への直接の書き込みを止めるので、環境変数は二重の守りである。
  フックは、読み取りのプログラムでも、別のコマンドの実行を委ねる形なら全停止の呼び出しとして見る。
  空白か、シェルが語を分けるか展開する字を含む先頭の代入の値も、全停止のCLIを指す字面か、`mise`と全停止のタスク名が並ぶ字面があれば拒否する。
  値が1語の代入は、引数を渡せないので判定しない。
  空白を含む値に全停止の字面がある代入は、後ろのプログラムが値を実行しなくても拒否する。
  受け入れる誤検知である。
  `CLAUDE_CODE_ENTRYPOINT`は、Claudeのセッションの印にしない。
- workerの中のプロセスは、`docker compose exec`で止める。
  Claudeはプロセスグループごと、検査は枠のuidごとに止める。
  workerの本体が属するグループには送らず、そのグループのClaudeはpidごとに止める。
  `detached`で起動しないClaudeが、workerと同じグループに入りうるためである。
- 2つのscript、変数の解析、実行中の監視と、それを固定するテストは、保護パスにある(`f/factory/lib/protected_paths.ts`)。
- ホストのCLI`scripts/stop_all.ts`と、戻す手順の`scripts/stop_all_restore.ts`は、ホストのユーザーの権限で動くので、保護パスにある。
  CLIが読む`lib/cleanup_support.ts`と`lib/types.ts`は、日常的に直す部品なので守らない。
  戻す手順が検査に使う`lib/config.ts`も守らない。
  検査を再実装せず、設定を読む処理と同じ規則で通すためである。

次のことは、この仕組みでは守れない。

- Windmillの画面で変数を直接書き換えられる者は、Consoleの確認と記録を経ずに全停止を外せる。
  外しても`*_enabled`は戻らない。
  検出器が全停止を見つけた後に外されたときは、検出器が5分以内に`stop_all_released`を残すので気づける。
  置いてから検出器の次の回までに外されたときは、どちらの通知も残らない。
  変数を直接外す操作はConsoleのscriptを通らないので、Consoleの操作の記録(`console_actions`)にも残らない。
- 戻すコマンドの操作は、Consoleの操作の記録(`console_actions`)に残らない。
  結果は端末に残る。
  人が設定を直接編集する今の運用と同じ水準である。
- 記録の変数は、全停止のscriptとホストの戻すコマンドのほかに、Windmillの画面の利用者と`f/`の他のscriptも書ける。
  設定を直接書ける経路と同じで、Claudeの書き込みはフックが止める。
  偽の名前が記録されても、戻すコマンドが戻すのは、設定に実在して`false`で検査を通り、人が`yes`で確かめた名前だけである。
  フックの照合は、パーセント符号化を1回解いた形までを見る。
  `/./`や`/../`を挟んだURLと、JSONの`\uXXXX`で書いたパスは、`freezes`と`stop_all`の変数と同じく、記録の変数でも止められない。
- 戻すコマンドの読み直しは、`wmill resource push`と全停止の間を排他にしない。
  読み直しの後、書き込みまでの間に入った書き込みは、上書きされうる。
  書いた後に全停止が置かれていれば、設定を読み直して`true`の`*_enabled`をすべて`false`に書き直すが、その間は機能が動きうる。
  記録を消す前には記録を読み直し、新しい全停止が記録を置き換えていれば消さない。
  ただし、変数には条件つきの更新が無いので、確かめてから消すまでの間に置かれた全停止の記録は、消えうる。
  消えうるのは記録だけで、設定はその全停止が`false`にする。
  消した後に全停止を読み直し、置かれていれば標準エラーに警告を出して止め直すので、人は`false`の`*_enabled`を確かめて手で戻せる。
  確かめた後から消す前の間に全停止が置かれ、さらに再確認の前に解除された場合は、記録が消えたことに気づけない(人が置いてすぐ外す操作が要るので、起きる見込みは低い)。
- 戻すコマンドは、端末に出す文字列の制御文字、書式文字、行と段落の区切りを、改行とタブを除いて`\uXXXX`の字面にする。
  例外の文や`wmill`の失敗の理由のような1行の値は、改行とタブも字面にして1行で出す。
  設定のキーと`wmill`の標準エラーは信頼できない入力で、端末の表示を書き換える並びを含みうるためである。
- 戻すコマンドは、`factory_config`の値のどこかに`!inline`で始まる文字列があれば、読んだ直後と書く前に断る。
  `wmill resource push`は、`content`が`!inline <パス>`か`!inline_fileset <ディレクトリ>`で始まる値を、ホストのファイルの中身に置き換えて書く。
  リモートから読んだ値を書き戻すので、その形の値を通すと、`mise.local.toml`のような秘密のファイルを設定へ持ち出せるためである。
- `lib/config.ts`を緩める変更は、戻すコマンドの検査も緩める。
  検査をすり抜けた設定が書かれうる。
  書く前に、戻す名前と戻さない名前を端末に表示し、人が`yes`を入力して確かめるので、意図しない名前は人が止められる。
  名前の組み合わせが緩めた検査をすり抜けたことは、表示からは分からない。
- 戻さないまま全停止を置き直すと、前の記録は、新しく止める名前があるときに置き換わる。
  置き換わった後は、前の全停止が止めた名前を`mise run stop:restore`で戻せない。
  全停止を置き直す前に、`mise run stop:restore`を実行する。
- 記録を書けなかった全停止と、記録に載らなかった名前は、手で戻す。
  ホストでは`mise run stop`の警告に、Consoleでは全停止の結果のトーストに出る。
- 全停止を置く前に始まったジョブの、Windmillのフローの再試行は止められない。
  再試行されたClaudeは、起動の前に変数を読んで断る。

## Claude Codeの拒否ルール

`.claude/settings.json`の`deny`は、誤操作を防ぐためのもので、秘匿性を保証しない。
設定ファイルを読めば、ルールは誰でも確かめられる。
秘匿性は、値をコミットしないこと(`mise.local.toml`はgitignore済み)と、値をWindmillのsecret変数に置くことで保つ。

次の操作を拒否する。
どれも、展開した後の秘密値を出力しうる。

| 拒否する操作 | 理由 |
| --- | --- |
| `mise.local.toml`と、その別名のファイル(`.mise.local.toml`、`mise.*.local.toml`)の`Read`と`Edit` | 秘密値そのものが書かれている |
| `.env`、`infra/.env`、`infra/secrets.env`の`Read` | 秘密値が書かれうる |
| `.wmill/`の`remotes.ndjson`の`Read`と`Edit` | wmill CLIのワークスペースのプロファイルで、APIトークンが書かれている |
| `mise env`とその別名(`mise e`) | 展開した環境変数の一覧を出力する |
| `mise config`、`mise cfg`、`mise toml` | 設定値を出力する |
| 引数なしの`mise set`と、別名の`mise ev`、`mise env-vars` | 設定値の一覧を出力する |
| `mise exec -- env`、`mise exec -- printenv`、`mise x -- env`、`mise x -- printenv`、`printenv`、`env` | 環境変数を出力する |
| `cat mise.local.toml` | 秘密値そのものを出力する |

値を指定して書き込むだけの`mise set -E local KEY=value`は拒否しない。
これらのルールは、`mise run <task>`を通した迂回(タスクの中で秘密値を出力する処理など)は防げない。

`mise x`は`mise exec`の別名で、`mise x -- bun test`のように通常の作業にも使うので、環境変数を出す形だけをこの設定で拒否する。
`docker exec`と`docker inspect`は、設定のルールが引数を絞れないので、ここには置かない。
どちらも、環境変数を出す形だけを次の節のフックが拒否する。
引数なしの`docker compose config`だけは、設定にも置く。
`mise set -E`は、値を指定して書き込む形があるので、設定では拒否せず、フックが書き込む形の無い呼び出しだけを拒否する。
書き込む形は、オペランドがすべて`KEY=VALUE`の形か、`--stdin`と、展開を含まない鍵の名前1つの形である。
`mise -E local set`のように、サブコマンドの前にグローバルオプションを置いても、値の語を読み飛ばして同じ判定をする。
`mise -E local x -- mise set`のように、オプションを前に置いた`mise exec`の内側の`mise`も調べる。
サブコマンドとその前の語が、展開、glob、ブレースを含むときは、語が変わるので拒否する。
`set`の後ろのオプションは、許可リストにあるものだけを認める。
値を取らないものは、`--stdin`、`-g`、`--global`、`--age-encrypt`である。
値を取るものは、`-E`、`--env`、`-C`、`--cd`、`-j`、`--jobs`、`--file`である。
`--age-key-file`、`--age-recipient`、`--age-ssh-recipient`も、値を取るものとして認める。
未知のオプション、展開やglobやブレースを含むオプションとその値、`--`を持つ形は、値を取ってオペランドを変えるおそれがあるので、一覧を出す形として拒否する。
オペランドに`set`などのサブコマンド名があるときも拒否する。
秘密値を投入する手順([セットアップ](setup.md))は、値を標準入力から渡す`mise set -E local --stdin KEY`を使う。
この形は一覧を出さないので、フックは拒否しない。
投入は人が行う。
フックは書き込みを止めないので、Claudeがこの形を実行すると、既にある値が空文字で上書きされうる。

残るリスクは[R-DENY-01](security-risks.md#r-deny-01)である。

守りは、守る対象ごとに次のとおり分かれる。

- `Read`ツールで`mise.local.toml`とその別名を読む経路は、`deny`が止める。
  GrepとGlobへの適用はベストエフォートである
- Bashで、秘密値のファイル名を字面で書いた参照は、フックの`guarded-files.ts`が拒否する。
  変数、ブレース展開、`find -exec`、`xargs`、`*`だけのglobを使う形は、「判定しないもの」に挙げる
- コミットへの混入は、層ごとに止める対象が違う。
  gitignoreは`git add`を、lefthookのgitleaksはコミットを、CIのgitleaksはmainへのマージを止める。
  CIが動くのは`pull_request`と`main`へのpushだけなので、値がリモートのブランチへ載ってから走る。
  `git add -f`はgitignoreを越え、gitleaksは規則に合う値だけを拾う
- Windmill上の保存とUIでの表示は、secret変数が守る

`mise`の一覧を出す経路は、これらのどの層も止めない。
`deny`の`Read`はBashに効かず、gitignoreとgitleaksはコミットとマージしか止めず、secret変数はホストの`mise.local.toml`の一覧に関係しないためである。
デバッグ中の誤操作でも打つ形(`mise -E local env`、`mise hook-env`など)が残る。
会話に出た値は、APIへ送られ、手元の記録にも残る。
漏れた値は失効して再投入する。
残るリスクの表の[R-DENY-02](security-risks.md#r-deny-02)にあたる。
[運用](operations.md)の「秘密をローテーションする」が扱うのは、`GITHUB_TOKEN`、`CONSOLE_GITHUB_TOKEN`、OAuthトークンだけである。
所有者ごとの読み取りPAT、`DISCORD_WEBHOOK_URL`、`DB_PASSWORD`、`WM_ADMIN_PASSWORD`には、手順が無い。
`DB_PASSWORD`と`WM_ADMIN_PASSWORD`は、再投入だけでは壊れるので、先にPostgresと管理者のパスワードを変える。
Postgresの`POSTGRES_PASSWORD`はvolumeの初期化時にだけ効くためである。
管理者のパスワードを先に変えるのは、`scripts/bootstrap.sh`が`WM_ADMIN_PASSWORD`と既定値の`changeme`でしかログインを試さず、どちらも通らなければ止まるためである。
`DISCORD_WEBHOOK_URL`は、[DiscordのWebhook URL](#discordのwebhook-url)の節の手順で新しいURLを取得して投入する。
旧URLの失効は、Discordのウェブフック設定で旧いウェブフックを削除して行う。

## Claude Codeのフック

ClaudeがBashを実行する前に、`.claude/settings.json`が`scripts/claude-hooks/`のフックを動かす。
ローカルとクラウドのどちらのセッションでも動く。
FactoryのheadlessなClaudeの実行は`.claude/`を読まないので、このフックは動かない。

| 拒否する操作 | 理由 |
| --- | --- |
| 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec) | 公開した履歴を書き換えると、ほかの作業やFactoryの`pr_fix`の変更を消しうる |
| `main`と`master`へのpush(`--all`と`--mirror`を含む) | mainへの変更は、PRとCIを通してだけ入れる |
| subagentからのpush | subagentには、pushの前に確認する相手がいない |
| deployの保留を置く操作(`freeze:place`の`--scope deploy`、`scripts/freeze.ts place --scope deploy`)、凍結の解除(`freeze:release`、`scripts/freeze.ts release`)、凍結の全消去(`freeze:reset`、`scripts/freeze.ts reset`)、削除を確定する押し出し(`push:prune`、`scripts/freeze.ts push --prune`)。前置き(`script`、`unbuffer`、`caffeinate`、`/usr/bin/time`、`ssh`)の後ろも拒否する。`--scope`の値が実行時に決まる形も拒否する | deployの保留は反映全体を止める。解除と全消去は保留を外せる。削除を確定する押し出しは、リモートだけの項目を消す。どれも人の端末の確認を通る操作で、subagentには確認する相手がいない。主セッションには、単独の`mise run <タスク>`の行(`freeze:place`と`freeze:release`)だけ許す。スケジュールの凍結を置くことと一覧は、両方に許す |
| 主セッションを含むすべてのClaudeのセッションの、Consoleの書き込みのscriptを呼びうる操作。コマンドの語か標準入力の文字列に、書き込みのscript(`scripts/claude-hooks/console-scripts.ts`の一覧。解除の`hold_release`と`freeze_release`、取消の`console_job_cancel`、再実行の`console_job_rerun`、設定変更の`console_config_update`、`approval_decide`、`retry_work_item`など)の名前、名前に当たりうるglob、ブレースの形があるもの。読み取りのプログラムと`wmill`の読み取りの副コマンドは、実行を表す語が並ばない限り除く。名前なしの`wmill jobs push`。凍結の変数`f/factory/freezes`を書く`wmill variable add`と`wmill variable push`、変数を書くURLへの呼び出し | 解除は、人がConsoleの画面で行うか、端末で確認を通るCLIで行う。ローカルの主セッションはCLIでは`session`として扱われ、他の主体の保留の解除に端末での人の確認が要る。Consoleのscriptは、その確認を通らずに他の主体の保留を外せる。ハッシュでの呼び出し、パーセント符号化したパス、変数やファイルで組み立てた名前は止められないので、残るリスクとして受け入れる([R-HOOK-01](security-risks.md#r-hook-01)) |
| 保留を置く・解除する操作。保留のコード(`hold`、`hold_psql`、`holds`。拡張子は省ける)を指す語を含む実行系の呼び出しのうち`list`と検査の道具以外、`hold:place`と`hold:release`を指しうる語を含む`mise`の実行、`holds`を語に含む`docker`と`psql`。`bun exec`の文字列は、シェルの入力として判定する。前置き(`script`、`unbuffer`、`caffeinate`、`/usr/bin/time`、`ssh`)の後ろの同じ形と、コマンド文字列の中の同じ形、語を足すコマンドとシェルを伴う形も拒否する | 保留は自動マージを止める。subagentには、置く前に確認する相手がいない。主セッションには、単独の`mise run hold:place`と`mise run hold:release`の行だけ許す。一覧(`list`)は両方に許す |
| `gh pr`と`gh api`のうち、読み取りか編集と確かめられた形以外(`gh pr merge`、書き込みのメソッドの`gh api`、GraphQLのマージのmutationなど)と、マージを含む`gh alias`。対象のリポジトリのマージの保留が有効なときと、保留を読めないとき。リポジトリが決まらないものは、どのリポジトリの保留でも拒否する | 保留は、期限つきでマージを止める。綴りの列挙は漏れるので、確かめられた形以外を対象にする。読めないときに通すと、保留を置いた意味が外れる |
| `wmill datatable migrate up`と`migrate down`(deployの保留が有効か、読めないとき)。`--dry-run`の無い`wmill sync push`(deployの保留かスケジュールの凍結が有効か、読めないとき) | deployの保留は反映全体を止める。除外を付けない手動のpushは、凍結中のスケジュールを上書きする |
| `xargs`の引数で渡す`git push`と`git commit` | 標準入力から来る引数は、実行するまで分からない |
| `--no-verify`、`git commit -n`、`core.hooksPath`の設定、`LEFTHOOK`を`0`、`false`、`off`、`no`にすること。追記(`+=`)は、追記後の値を判定できないので、値によらず拒否する | lefthookの検査を飛ばすと、壊れた変更や秘密値がpushされる |
| `LEFTHOOK_EXCLUDE`に`wmill-metadata`と`wmill-metadata-check`以外を書くことと、追記(`+=`) | AGENTS.mdが飛ばしてよいとするのは、この2つだけである |
| `CHECK_IDLE_FORCE`の代入(`=`と`+=`、前置き、`env`、`export`、`declare`、引用符とエスケープを外した後の形、値が動的な場合を含む) | `mise run up`と`mise run deploy`の、実行中の仕事の確認を飛ばせる。付けるのは人が自分の端末で、確かめた後だけである |
| `LEFTHOOK_BIN`と`LEFTHOOK_CONFIG`の設定 | インストール済みのフックが読む、lefthookのバイナリと設定を差し替えられる |
| `lefthook uninstall`と、リダイレクトや`rm`、`mv`、`tee`、`cp`、`sed -i`などの既知のコマンドによる`.git/hooks`と`.git/config`への書き込み(ほかにも書き込める経路が残り、主なものを「判定しないもの」に挙げる) | gitのフックを外せる |
| `git -c alias.*`、`remote.*.push`・`push.default`・`include.*`・`includeIf.*`の設定、`GIT_CONFIG_COUNT`・`GIT_CONFIG_GLOBAL`・`GIT_CONFIG_SYSTEM`などの環境変数 | `push`や`core.hooksPath`を別の名前や設定の裏から差し込める |
| フックを実行するgitのサブコマンド(`commit`、`push`、`merge`、`rebase`など)に前置きした`HOME=`と`XDG_CONFIG_HOME=`(`+=`の追記を含む) | gitに別の設定ファイルを読ませて、フックを外せる |
| `echo`や`printf`が変数から組み立てた文字列を、標準入力で読むシェル | 中身を判定できない |
| `mise exec`の`-c`と`--command`、コードを渡したシェル、`env`、`printenv`、`set`、`export -p`などの環境変数の一覧 | `mise exec`は`mise.local.toml`の秘密値を環境変数として渡すので、値を表示できる |
| `docker exec`と`docker compose exec`で実行する環境変数の一覧とコードを渡したシェル(`mise exec --`の前置きがあっても) | コンテナは秘密値を環境変数として持つ |
| フィールドの経路だけの`--format`を持たない`docker inspect`、`Env`か`Config`を含む経路 | コンテナに渡した環境変数が見える |
| 出力を絞らない`docker compose config`と`docker compose convert` | 変数を展開したcompose定義を出力する |
| `/proc/<pid>/environ`(`task/<tid>`の下を含む)を引数やリダイレクトに含むコマンド | プロセスの環境変数がそのまま入っている |
| 書き込む形(`KEY=VALUE`、または`--stdin`と鍵1つ)を持たない`mise set` | `mise.local.toml`の値を一覧する |
| `mise generate git-pre-commit`(別名`pre-commit`)と`mise generate github-action`の`--write`(`-w`を含む短いフラグの束を含む)。`generate`の別名`gen`と`g`も同じ。生成先を問わず、コマンド行(`-C`と`--cd`の値を含む)に`.git/hooks`、`.git/config`、`.github/workflows`を含む語か、実行時に決まる語がある形。`//`と`/./`はまとめ、大文字小文字は区別しない | `.git/hooks`と`.github/workflows`へ書き、lefthookのフックやCIの検査を上書きできる。`task-docs --output`のように、書き先を引数で選べる生成先もある。`--hook`と`--task`は単独では書かないので拒否しない。`--write`の省略形(`--wri`、`--w`)と別名(`gha`)は、この版のmiseが受け付けないことを実機で確かめたので、拒否しない |
| 秘密値のファイル(`mise.local.toml`とその別名、`.wmill/`の`remotes.ndjson`、`.env`系)を名前で指すコマンド | `Read`の拒否はBashに効かず、`cat`や`grep`で読むと値が会話の記録に残る |
| リポジトリの根、`infra`、`.wmill`を起点にした再帰的な`grep`、`-u`や`--no-ignore`を付けた`rg`、`git grep --no-index` | gitignore済みの秘密値のファイルまで読む |

`CHECK_IDLE_FORCE`の拒否は、誤って付けるのを防ぐもので、あらゆる回避を機械的に塞ぐものではない。
予備として、`.claude/settings.json`の`permissions.deny`にも、行頭の代入を置く。
残るリスクとして、次の回避は塞がない。

- [R-HOOK-02](security-risks.md#r-hook-02)
- [R-HOOK-03](security-risks.md#r-hook-03)
- [R-HOOK-04](security-risks.md#r-hook-04)
- [R-HOOK-05](security-risks.md#r-hook-05)
- [R-HOOK-06](security-risks.md#r-hook-06)
- [R-HOOK-07](security-risks.md#r-hook-07)
- [R-HOOK-08](security-risks.md#r-hook-08)

添字付きの代入をコマンドの前に置く形(`CHECK_IDLE_FORCE[1]=1`、`LEFTHOOK[1]=0`)は、読めない構文として拒否する。
`env -S`の文字列は、`env`と同じ規則で語に分けて判定する。
実行時に決まる文字列と、読めない文字列は、`bash-guard`が拒否する。

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
標準入力の扱いは、オプションの無い起動に限り、`bash`のほかに、`fish`、`ash`、`mksh`、`tcsh`、`csh`、`busybox sh`でも同じである。
これらのシェルの`-s`と`-`は、読み切れない起動として拒否する。

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
`git config core.hooksPath`は、値を設定するときだけ拒否する。
読むことと`--unset`は拒否しない。

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

`merge-guard`は、マージと反映の操作に当たったとき、保留と凍結を読めないと拒否する。
読めないのは、表が無い、行が壊れている、`mise`が無い場合である。
子プロセスの非ゼロの終了、時間切れ、読みの処理の例外も同じである。
対象に当たらないコマンドは、何も読まずに許可する。

実行環境が無いときは、警告を出して通す。
実行環境が無いのは、次の3つの場合である。

- 動くbunも、24以上のnodeも無いとき。
  依存を入れる前のコンテナが当たる。
  PATHにあってもshimの中身が無いbunや、24未満のnodeは、動かないものとして扱う
- 起動スクリプトが無いとき。
  `CLAUDE_PROJECT_DIR`が空のときが当たる
- `merge-guard`のスクリプトが無いとき。
  登録コマンドは、起動スクリプトに加えて、このスクリプトの有無も確かめる。
  古いチェックアウトで、すべてのBashを止めないためである

この場合も拒否すると、すべてのBashが止まり、人が復旧できないクラウドのセッションでは作業を続けられない。
`run.sh`は、動くbun、24以上のnode、`$HOME/.bun/bin/bun`、警告して通す、の順に試す。
警告は、終了コード0でも利用者に見えるよう、標準出力のJSON(`systemMessage`)にも出す。
起動スクリプトが無いときの登録コマンドも同じである。
警告は、フックごとに何が確かめられなくなったかを示す。
`bash-guard`は拒否ルールだけが残ること、`merge-guard`は保留に照らしていないことを伝える。
起動スクリプトは`mise`を経由しない。
自動インストールがタイムアウトを超えることがあり、信頼していない設定では動かないためである。
`merge-guard`が保留と凍結を読むときだけ、`mise exec`を経由する。
composeと`wmill`が、`mise`の環境変数とツールを要するためである。
読みの子プロセスでは、`mise`のツールの自動インストールを止める。
インストールが要る状態は、コマンドが見つからない失敗になり、拒否される。
フックが動かない間は、`bash-guard`の拒否ルールは`.claude/settings.json`のものだけが残り、保留は確かめられない。
フックは、bunとnodeのどちらでも動く(nodeは型を取り除いて`.ts`を実行できる24以上)。

Claude Codeは、タイムアウトしたフックのツール呼び出しを止めず、通常の権限の確認に進める。
そのため、登録するタイムアウトは10秒にして、処理が長引かないようにしている。
判定は同期の処理で、途中から止められない。
代わりに、gitの起動に回数と時間の上限を置き、gitの1回の実行にも2秒の上限を付ける。
非同期の判定を待つ処理には、8秒で終了コード2の拒否にする上限を付ける。
`merge-guard`の読みは、子プロセスを6秒で終了し、フック自身も6.5秒で拒否を決める。
子プロセスは新しいプロセスグループで起動し、上限でグループごと終了する。
判定を書き出した後は、残った待ちを待たずにプロセスを終了する。
孫のプロセスが出力を握り続けても、フックがタイムアウトして通常の権限の確認に進むことを避けるためである。
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
- `find -exec`、標準入力から名前を読む`xargs`(`git push`、`git commit`、`gh`、`wmill`を除く)
- `mise`のほかのサブコマンドによる秘密値の出力(`mise env`、`mise config`、`mise hook-env`、`mise en`、`mise direnv exec`、`mise mcp`)
- サブコマンドの前にグローバルオプションを置くと、設定の前方一致の拒否が外れる(`mise -E local env`など)
- `mise run`の`-s`と`--shell`、`mise exec`の`-c`の位置と束ねた形、`xargs`から起動する`mise`
- `MISE_UNIX_DEFAULT_INLINE_SHELL_ARGS`などの`MISE_*`の環境変数、`BASH_ENV`や`PATH`の差し替え
- `mise set`のサブコマンドの前に、値を取る隠しオプションを置く形(未知の版で増えたもの)
- `mise set`が、`-E local`を付けずにコミット対象の`mise.toml`へ、`-g`でグローバル設定へ、`--file`で任意のファイルへ書き込む形
- `mise`の書き込みと実行のサブコマンド(次は例で、ほかにもある)。
  フックが`mise`を、書き込むコマンドとして扱わないので拒否しない
  - `mise generate task-stubs`
  - `mise settings set`(設定を追加、更新する。既定は`~/.config/mise/config.toml`で、`--local`でローカルの設定になる)
  - `mise tasks add`(ローカルの`mise.toml`にタスクを足す。`-f`でファイルタスクを作る)と`mise tasks edit`
  - `mise doctor project`(`mise.toml`の`[doctor.checks.<name>]`に書かれたコマンドを実行する)
  - `mise unset`(設定ファイルの値を消す)
  - `mise implode`(miseとその関連データを消す)
  - `mise bootstrap`
    - パッケージ、リポジトリ、dotfiles、ツールを整え、`bootstrap`タスクがあれば実行する
    - このリポジトリのタスク`mise run bootstrap`は`scripts/bootstrap.sh`を動かすので、`mise bootstrap`もそれを実行する
    - 2つは別のコマンドである
- 保留と凍結の操作のうち、次の形。
  - 名乗りのholder。
    `session:<ブランチ>`は同じブランチのセッションで共有され、作業ディレクトリや別のチェックアウトによっても名乗るブランチは変わる
  - 端末を与える経路の列挙の外。
    前置きは5種に限り、人の確認を端末で通す仕組みは、端末を与える経路を列挙し切れない
  - 人の確認を端末からConsoleの承認へ移す構造的な案。
    境界を強めるには、フックの追加ではなくこの案が要る
  - 別名の呼び出し(`cp scripts/hold.ts /tmp/h.ts`の後に実行する形)
  - 変数や文字列の連結で組んだパス、動的なimport
  - `docker compose exec db psql`に渡す語を、組み立てて書く形
  - 新しいファイルを書いて実行する形。
    `mise-tasks/`と`.mise-tasks/`は保護パスだが、止めるのはFactoryのフローだけで、ローカルのsubagentには効かない
  - 保留のコードを書き換えてから起動する形(ファイルの複製、移動、書き込みの道具、設定ファイルの書き換え。Editツールを含む)
  - 前置きの無いシェルの`-c`と標準入力
  - 語を足す文脈の集合の名前が、絶対パスや探索先の違いで別のファイルに解決される形(新しいファイルを書いて実行する形に含む)
  - 変数とglobから`-exec`の語を作る形(実行時に組み立てる形の一種)
  - `xargs`や`find`の別名と、前置きの一覧に無い前置き(列挙の抜け)。
    語を足す別のプログラム(5つの文脈の外)を含む
  - `find`の後ろの検査の道具に、探索の起点の綴りでオプションを渡す形(`-`で始まる名前のファイルを先に書く形)
  - 保留の判定より前の検査にかかる時間。
    締め切りは判定の開始から数えるが、時計を見るのは保留の判定の中だけである(判定の時間の上限の外の検査)
  - 前置きの近縁のプログラム(`expect`、`gtime`、`stdbuf`など)。
    前置きは5種に限る
  - 実行時に組んだ名前。
    解析できない文字列と深さ4を超える入れ子は字面で判定するため
  - 実行を委ねる呼び出しの、委ねる先や設定の値を実行時に組み立てる形と、値を環境変数から読む設定の指定(実行時に組んだ名前の類)
  - 実行系に、変数で標準入力を指すオペランドを渡す形(実行時に組んだ名前の類)
  - 取り込むファイルの中身と、書き換えたファイルを値で指す設定(新しいファイルを書いて実行する形の類)
  - 字句の規則を変える変数の名前を、展開で組み立てて、代入を受ける組み込みの引数に渡す形。
    組み込みコマンドの引数の再評価と同じ分類として受け入れる
  - 入れ子の文字列を読み直す経路で、予約語の代替形とcase文を含む文字列
    - 読めない文字列として字面で判定する。
      語の途中の引用で名前を分けた形は、引用を除いた綴りでも判定するが、字の並びを組み立てる形は見落とす
    - 同じ迂回は、別の読めない形でも使える
    - 最上位とシェルの標準入力では、読めない構文として拒否するので塞がっている
  - 前置きの無いインタプリタが文字列で受け取るコード(`python -c`、`perl -e`、`ruby -e`、`awk`の`system()`など)。
    ストリームエディタのコマンドを実行する命令も同じ分類である
  - 起動語の列挙の外の名前(別名の実行ファイル、パッケージ管理の経由、アーキテクチャを選ぶ前置き)。
    名前の集合は開いているので、列挙を足さない
  - 先に用意したファイルや設定を使って実行に至る、gitの委ねない副コマンドの形(テンプレート、マージの戦略、リモートの補助、ヘルプの表示プログラム、属性のフィルター)。
    用意の段は、設定の書き込みを委ねる形として見るか、新しいファイルを書いて実行する形に入る
  - ブレースの範囲の端点を実行時に決まる語で書く形。
    範囲として読まない
  - `mise generate`の書き先の照合は、既存の`.git/hooks`と`.git/config`の照合(`GIT_INTERNALS`)と同じ限界を持つ。
    `cd`やシンボリックリンクを使った別名の書き方は見ない
  - `mise generate`の書き先の照合は、`/../`をまとめない。
    globとブレースを含む語は、書き先の判定ができないので拒否する
  - 凍結のCLIは、副コマンドの語(`place`、`release`、`reset`、`push`の`--prune`)と`--scope`の値の字面で判定する。
    別名と、組み立てたパスは見ない
  - 実行時に決まる語を含む`mise run`は、保留の操作と区別できないので拒否する。
    静的な値で書けば通る。
    全体オプションの値(`mise -C "$DIR" run check`)の変数は、保留とは別の規則で拒否する
- マージと反映の判定が追わない形。
  残るリスクは「保留」に書く。
  - 別名と関数、変数や連結で組んだ語、スクリプトのファイルの中の呼び出し
  - `curl`、`python`、`hub`、GitHubのMCP
  - GraphQLの`mergeBranch`
  - `find -exec`、`parallel`、`watch`の後ろのコマンド
  - `bunx wmill`、`npx wmill`、`wmill script push`などの個別のpush、`wmill schedule enable`
- wmill CLIによる秘密値の読み取り
  - secret変数だけではない
  - `wmill instance get-config --show-secrets`はインスタンスの設定を出す
  - `wmill sync pull --include-key`はワークスペースの暗号鍵を出す
  - `wmill variable get`
  - `wmill sync pull --include-secrets --plain-secrets`
  - `wmill trash get`
  - フックに判定は無く、値が会話に出るかは確かめていない
  - CLIのプロファイルのトークンで復号されて返るなら、値が会話に出る
- ブレース展開で作る秘密値のファイル名(`cat mise.local.{toml,}`)。
  ファイル名の判定が展開を見ない
- 外すことにしていない前置きのコマンド(`watch`、`flock`、`stdbuf`、`script`、`parallel`、`setsid`、`doas`など)
- スクリプトのファイルの中身
- コマンドを起動するインタープリター(`bun -e`、`python -c`が`git push`を実行する場合など)
- `bash /dev/stdin`や`source <(...)`のように、標準入力や置換から読むシェルのコード
- gitの省略形のオプション(`--forc`など)
- 式の中でファイルを開く操作(`sed`の`r`コマンド、`perl -e`など)
- `cd`やglob、`dd`、`perl -pi`、`find -delete`を使った`.git/hooks`と`.git/config`の書き換え
- 行き先を`.git/`にした`cp`、`mv`、`rsync`と、`tar -C`、`unzip -d`、`curl -o`による展開と書き込み
- リポジトリの根での`rg KEY *`や`grep KEY *`。
  シェルが`*`を`mise.local.toml`に展開しても拒否しない
- `echo ... | cat | sh`のように、間にコマンドを挟んだ標準入力のシェル(直前のパイプの元だけを見る)
- グループやサブシェルの中の、最後でないコマンドが標準入力へ渡す文字列。
  集められないので判定されない
- `docker run ... env`のように、新しく起動するコンテナで環境変数を出す操作
- `gh auth token`や`mise token`(gitのホストのトークン)のように、認証情報を表示するコマンドと、`~/.ssh`やgh CLIの設定ファイルの読み取り
- `mise exec`経由で秘密値を読む方法の一部(ベストエフォートの規則である)
- サブシェルの中の`cd`の範囲(外側にも効くものとして扱う)
- 前置きではない`HOME`と`XDG_CONFIG_HOME`の設定(`export HOME=...`の後のgit、`sh -c`の中のgit)
- 書き方を変えた`/proc/<pid>/environ`(`dd if=/proc/self/environ`、`/proc/self/./environ`、`//proc/...`、`/proc`の再帰的な検索)

フックは誤操作を止める仕組みで、意図した迂回は防げない。
上の一覧は主な経路で、網羅ではない。

## draw.ioの図の描画

この節の内容は[Consoleの安全策の内部仕様の「draw.ioの図の描画」](internals/console/security.md#drawioの図の描画)にある。

## 要件定義書のリンク

この節の内容は[Consoleの安全策の内部仕様の「要件定義書のリンク」](internals/console/security.md#要件定義書のリンク)にある。

## 更新履歴のPR

この節の内容は[Consoleの安全策の内部仕様の「更新履歴のPR」](internals/console/security.md#更新履歴のpr)にある。

## PR修正の安全策

この節の内容は[PRワークフローの仕様の「PR修正の安全策」](internals/pr-workflow.md#pr修正の安全策)と、[検査コマンドの実行と権限の「検査コマンドはフローが実行する」](internals/check-sandbox.md#検査コマンドはフローが実行する)と[「検査コマンドの権限」](internals/check-sandbox.md#検査コマンドの権限)にある。

## 実装の安全策

この節の内容は[実装フローの仕様の「実装の安全策」](internals/implement.md#実装の安全策)にある。

## 設計書の生成の安全策

この節の内容は[設計書の生成の仕様の「設計書の生成の安全策」](internals/design.md#設計書の生成の安全策)にある。

## 調査の隔離

この節の内容は[調査の隔離の内部仕様の「調査の隔離」](internals/investigate.md#調査の隔離)にある。

## 監査の安全策

この節の内容は[監査の内部仕様の「監査の安全策」](internals/audit.md#監査の安全策)にある。

## dependabotの更新の自動マージ

この節の内容は[dependabotの更新の内部仕様の「dependabotの更新の自動マージ」](internals/dependabot.md#dependabotの更新の自動マージ)にある。

## stepの間で渡す引数

外から来た文字列とClaudeの出力は、stepの引数にそのまま載せず、JSONの文字列に封じて渡す。
Windmillは、引数の文字列が変数やresourceへの参照の形で始まると、実行者の権限で値に置き換えてから、scriptに渡す。
封じない引数に参照の形の文字列が入ると、本物の秘密値がscriptに渡るためである。

### 前提

次の点は、Windmillの公開ソース(`backend/windmill-worker/src/common.rs`)の、`mise.toml`の`WM_VERSION`と同じ版のタグで確かめた。

- 置き換えは、引数ごとに働く。
  flowのstepの引数(式の結果)も同じである。
- 置き換えるのは、文字列の先頭が`$var:`、`$jsonvar:`、`$res:`、`$encrypted:`のどれかのときである。
  `$`で始まり、残りが予約変数の名前と一致する文字列も、その値に置き換わる。
- 引数のJSONのどこにも上の4つの形が無ければ、その引数は走査されない。
- 走査は、オブジェクトの中を深さ50まで進む。
  深さ2と1000件の制限は、配列だけにかかる。

ここから、次のことが決まる。

- 先頭が固定の文字列は、トップレベルの引数なら、置き換えの対象にならない。
- 値をオブジェクトで包んでも、守りにならない。
- JSONの文字列の`$`をすべてエスケープすれば、引数のどこにも参照の形が現れない。

この前提は版に依存する。
`WM_VERSION`を上げるときは、ソースの同じ箇所を読み直し、この節と、`tests/scripts/flow_untrusted_args.test.ts`が固定する前提を見直す。

### 封じ方

flow.yamlの式で、値全体を`JSON.stringify(...)`で文字列にし、`.replace(/\$/g, "\\u0024")`で`$`をエスケープして、1つの引数(`untrusted`)で渡す。
失敗の処理(`failure_module`)は、`error`を同じ式で封じて渡す。
受け取るstepは、`lib/untrusted_arg.ts`の`parseUntrustedArg`で戻し、型ガードで形を確かめる。
型ガードは、値の型の定義の近くに置く。

戻せないときは、値を載せずに例外を投げる。
例外の文には、合わなかったキーの名前だけを載せ、先頭に再試行を止める印(`[no-flow-retry]`)を付ける。
戻せない原因は定義の食い違いで、再試行しても直らないためである。
包まない引数で呼ぶ古い定義のflowも、文字列でないので同じ例外になり、包まない値は使われない。

PRレビューの投稿のstepは、戻せなかったときも、レビュー用のworktreeを消してから例外を投げる。
残ると、同じshaの再実行がworktreeを作れず止まるためである。
ほかのstepの作業ツリーは、片付け(`cleanup_workspaces`)が消す。

封じる値は次のとおりである。

| flowとstep | 封じる値 |
| --- | --- |
| `pr_review`の投稿 | 総評、判定、指摘、スレッドへの答え、変更ファイルとバイナリのパス、変更の範囲 |
| `pr_fix`の適用 | 指摘とコメントの本文、競合したファイルのパス |
| `pr_fix`の検証と完了 | 修正の結果(理由、要約、返信、コミットの件名と本文)、指摘とコメントの本文、競合したファイルのパスと3つのblobのsha、PRのheadのブランチ名 |
| `implement`の生成、検証、完了 | 実装の文脈(Issueの題名と本文を含む)、ラウンドの結果とループの結果(Claudeの出力を含む)、準備の理由 |
| `dependabot`の影響調査と完了 | 準備の結果(PRの本文と変更履歴を無害化した文を含む)、影響調査の結果(Claudeの出力を含む) |
| 各flowの失敗の処理 | 失敗の`error`(例外の文を含む) |

ブランチ名を封じるのは、gitが`$`で始まる名前を許すためである。

### 包まない値

次の値は、参照の形を取れないので、そのまま渡す。

| 値 | 根拠 |
| --- | --- |
| 数、真偽値、数だけを持つ集計 | 文字列ではない |
| コミットのsha | 40桁の16進である |
| GitHubのownerとrepoの名前 | `$`を含められない |
| GitHubが返すURL | 先頭が`https://`である |
| factoryが作る作業用の置き場と、`.git`の指し先 | 先頭が`/`か`gitdir:`である |
| 検査を通した列挙値と、検証した識別子 | stepが決める固定の値である |
| 調査の本文、証跡パック、差し戻しの自動の報告 | 先頭が固定の目印である(役割のタグ、注意書き、`[automated-report]`)。調査の見送りの符号は固定の2種類である |

運用者が自由に入力した文は、先頭が固定でないが、そのまま渡す。
手動投入の題名、本文、受け入れ基準、owner、repo、進め方、冪等キー、承認の却下の理由、PRレビューの投入と調査の入力である。
入力できる主体も、flowが動く主体も、ワークスペースの管理者である。
フォルダ`f/factory`の権限が、管理者だけに限られているためである。
管理者は変数を直接読めるので、置き換えで読める範囲は広がらない。
この根拠は、次の2点をテストで固定する。
1つは、フォルダの`owners`と`extra_perms`が空であることである。
もう1つは、`f/factory`の下のflow、script、scheduleの定義に、`on_behalf_of`で始まるキーが無いことである。

`feedback`を設計と要件定義のflowへ渡す起動の呼び出しは、テストに一覧がある。
実装やPRの修正などが返す自動の報告は`automatedFeedback`の印を通し、印のない値は承認の却下の理由だけである。
一覧に無い呼び出しが足されると、テストが落ちる。

### 検査するテスト

`tests/scripts/flow_untrusted_args.test.ts`が、すべてのflowの引数を調べる。

- 前のstepの結果かflowの入力を式に持つ引数は、テストの表に挙げなければならない。
  表は、封じたもの、包まない値、受け入れる入力に分かれる。
  対象は、`results`、`previous_result`、`resume`、`flow_input`、失敗の`error`を使う式である。
  新しいflowやstepが、表にない値を包まずに渡すと、テストが落ちる。
- 封じた式は、参照の形の文字列を載せて評価し、結果に`$`が残らないことと、戻した値に文字列が残ることを確かめる。
- 式のキーと、受け取るstepの型ガードのキーが一致することを確かめる。
- 受け取るstepの`main`が、引数を文字列で宣言することを確かめる。
- 受け入れる入力の根拠(フォルダの権限と定義)と、`feedback`を渡す起動の一覧を確かめる。

監査の集計は、型を数だけに限る。

封じ方の部品(`lib/untrusted_arg.ts`)、このテストとテストの補助は、保護パスである。
包む式を外すと、保護されたこのテストが落ちるので、検査を通せず、人の承認に回る。

### 反映

この変更の反映の時点で実行中のflowは、古い定義のまま新しいstepを呼ぶので、戻せずに失敗する。
失敗は安全側で、投稿とpushのどちらも行わない。
反映の途中には、新しい定義のflowが古いstepを呼ぶ短い間がありうる。
反映の順序と、古いstepが包んだ引数を受け取れないときの挙動は、確かめていない。
そのため、反映はflowが動いていない時に行う。

## 承認と権限

承認できるのは、`f/factory/**`のスクリプトを実行できるアカウントである。
実行の権限はフォルダ`f/factory`の権限で決まり、このフォルダには所有者も追加の権限も付けていないので、ワークスペースの管理者だけが該当する。

承認は必ずConsoleの要対応(`approval_decide`を実行する)から行う。
Windmillのapproval pageのURLは署名付きのcapability URLなので、PRのコメントやDiscordの通知に載せない。
approval pageのURLから直接resumeすると承認の状態が記録されず、作業項目は人の対応待ちになる。

承認者は`f/factory/lib/approver.ts`の`deriveApprover`が導出する。
記録先は`approval_requests.decided_by`と`issue_proposals.decided_by`である。
Windmillのログインユーザー名(`WM_USERNAME`)を優先し、無ければ`WM_EMAIL`を使い、どちらも無ければ例外で処理を止める。
呼び出し元が渡す引数は承認者として信頼しない。
承認者が不明なまま既定値で記録することは無い。

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

`poll_issues`は、トリガーラベル付きのIssueを収集の表から見つける。
表を使えない明示リポジトリは、RESTのIssueの一覧を`labels`で絞って読む。
検索は使わない。
表から見つけたIssueと、一覧で見つけたIssueは、付与者の確認の前に、`getIssue`で開いていること、PRでないこと、トリガーラベルが付いていることを確かめる。
閉じたIssue、PR、ラベルが外れたIssueは、付与者を読まずに外す。
外れたラベルの付与者を読むと、許可されない人がラベルを外した後に、偽の`labeler_denied`を残すためである。
表の値と一覧の番号は候補を絞ることにだけ使い、付与者の判定と取得は、見つけた元によらず同じ経路で行う。
そのため、表の値が書き換えられても、候補が増えれば読み直して外し、減れば着手が遅れるだけである。
表に行の無いIssueは、そのリポジトリを次に取り終えるまで着手が遅れる。
明示でないリポジトリで記録が古いものは見送る。
一覧を読むのは、照合を通った所有者の明示リポジトリだけで、読む範囲を設定の外へ広げない。

`poll_prs`は、ラベル、レビューの依頼、assigneeのPRを収集の表から見つける。
表を使えない明示リポジトリは、RESTのPRの一覧を読む。
検索は使わない。
表から見つけたPRと、一覧で見つけたPRは、`getPr`と`getIssue`で確かめてから判定に進む。
確かめるのは、PRが開いていることと、ラベル、PATのアカウントへの依頼、assigneeのどれかに今も当たることである。
閉じたPRと、どれにも当たらなくなったPRは外す。
assigneeや依頼を外された後の古い行から、対象でないPRのレビューを始めないためである。
表の値と一覧の値は候補を絞ることにだけ使う。
作者の確認、forkの確認、付与者の確認は、見つけた元によらず同じである。
`buildPrCandidate`がRESTで読んだ値を、`decidePrActions`と`confirmLabeler`が判定する。
そのため、表や一覧の値が書き換えられても、候補が増えれば読み直して外し、減れば着手が遅れるだけである。
明示でないリポジトリで記録が古いものは見送る。
一覧を読むのは、照合を通った所有者の明示リポジトリだけで、読む範囲を設定の外へ広げない。
チーム宛てのレビューの依頼は、PATのアカウントが属するチームの数値IDと、PRの`requested_teams`の数値IDで照合する。
チームへの依頼は、作者が許可された人のPRだけ候補にする。
チームを使えない組織では、チーム宛てだけの依頼を見送り、直接の依頼だけをRESTの`requested_reviewers`で確かめて拾う。
見送ったPRの数は、結果の`team_unresolved`に出る。

`labeled`イベントは`author_association`を持たない。
そのため、付与者はGitHubの関係(OWNERなど)ではなく、ログイン名で判定する。

許可するのは、次のアカウントである。
大文字小文字は区別しない。

- FactoryのPATのアカウント。
- `factory_config`の`allowed_labeler_logins`に挙げたアカウント。
  既定値は空である。
  `allowed_labeler_ids`にIDを入れたアカウントは、`actor`の数値IDも一致するときだけ許可する。

次のどれかのときは、判定できないものとして拒否する。
許可されたものだけが通るので、判定の失敗が拒否に倒れる。

- トリガーラベルの`labeled`イベントが無い。
- ラベルが付いているのに、最後のイベントが`unlabeled`である。
  イベントの反映が遅れていて、今の付与者を特定できない。
- 作成時刻が最大のイベントが、同じ秒に2件以上ある。
- イベントに`actor`が無い(削除されたユーザーなど)。
- `allowed_labeler_ids`にIDを入れたアカウントの名前で、`actor`の数値IDが一致しない、または応答に無い。
  改名の後に、別の人が古い名前を取得した場合を含む。
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
イベントの取得に失敗したときは、noticeを増やさず、失敗の記録を残す。
Consoleの**システム**の「作業項目に紐づかない失敗」に出る。
記録されるステップ名は、Issueが`fetch_labeler:<owner>/<repo>#<番号>`、PRが`fetch_pr:<owner>/<repo>#<番号>`である。

付与者を判定できないときは、失敗ではなく、noticeの`labeler_check_limit`を1回だけ記録する。
本文は対象とラベルだけで決まり、同じ本文の未解決のnoticeがあるあいだは追加しない。
次の操作として、ラベルを外し、許可された人が付け直すことを示す。
付け直すと、トリガーラベルの新しい`labeled`イベントが直近100件に入り、判定できるようになる。
人がラベルを外して付け直すまで、ポーリングのたびに同じ取得を繰り返す。
noticeは、対応した後にConsoleで解決する。

判定から取得までには時間差があるので、取得の直前に同じ確認をもう一度行う。
拒否されたときは、取得せずに`labeler_denied`を記録する。
取得できなかったときは、取得せず、失敗の記録に`confirm_labeler:<owner>/<repo>#<番号>`として残す。
Consoleの**システム**の「作業項目に紐づかない失敗」に出る。
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

許可は、名前を基本に判定する。
アカウント名を変更すると、他人が古い名前を取得できる場合がある。
`allowed_labeler_ids`に名前とIDを対で入れたアカウントは、名前に加えてIDでも照合する。
IDは、ラベルのイベントの`actor`の`databaseId`と、PRの応答の`user.id`である。
どちらも追加の呼び出しなしで取れるので、IDを入れたアカウントの古い名前を別の人が取得しても、通らない。
IDを入れないアカウントは名前だけで照合するので、名前を変えたアカウントは、`allowed_labeler_logins`から外す。
設定の手順は[運用](operations.md#ラベルの付与者の数値idを固定する)にある。

`factory`ラベルを付け直すと新しいサイクルが始まり、同じIssueの承認済みの作業項目は取り消される。
そのため、ラベルを付けられる人は、承認の取り消しも起こせる。
許可するアカウントを増やすときは、この影響も含めて決める。

許可されていない人の操作を運用者に見せるnotice(`labeler_denied`)は、重要度が「情報」なので、要対応の一覧には出ず、Consoleのシステム画面に7日だけ出る。
noticeは、許可された人が同じ対象を取得したときと、作成から`retention_logs_days`(既定30日)を過ぎたときに、解決済みになる。
取得による解決の範囲は[通知とrate limit](internals/notifications.md)にある。
どちらの場合も行は残り、解決の時刻から同じ期間の掃除までは、解決済みの履歴として読める。
許可されていない人は、取得の条件である最後のラベル付与者が許可された人であることを満たせない。
そのため、取得による解決を起こせない。
運用者が確かめないまま解決済みになる残るリスクは[R-LBL-10](security-risks.md#r-lbl-10)である。

### 確認しない経路

ラベルを介さずに始まるレビューは、付与者ではなくPRの作成者で確かめる。
対象は、次の2つである。

- PRのレビュー依頼かassigneeにFactoryのアカウントが入っているときのレビュー。
- 追跡中のPRに新しいcommitが入ったときの再レビュー。

どちらも、PRの作成者が許可されたアカウントのときに限る。
許可されるのは、FactoryのPATのアカウントと`allowed_labeler_logins`のアカウントである。
`allowed_labeler_ids`にIDを入れたアカウントは、作成者の数値IDも一致するときだけである。
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

### ラベル付与の残るリスク

残るリスクは次のとおりである。

- [R-LBL-01](security-risks.md#r-lbl-01)
- [R-LBL-02](security-risks.md#r-lbl-02)
- [R-LBL-03](security-risks.md#r-lbl-03)
- [R-LBL-04](security-risks.md#r-lbl-04)
- [R-LBL-05](security-risks.md#r-lbl-05)
- [R-LBL-06](security-risks.md#r-lbl-06)
- [R-LBL-07](security-risks.md#r-lbl-07)
- [R-LBL-08](security-risks.md#r-lbl-08)
- [R-LBL-09](security-risks.md#r-lbl-09)

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
判定は次の順に行う。
ログイン名は大文字と小文字を区別せずに比べる。

| 順 | 状況 | 判定 |
| --- | --- | --- |
| 1 | PRで`merged_at`がある | 取り消す。マージにもmerge queueへの投入にも、write権限が要るため |
| 2 | `closed_by`が無い、またはログイン名が空 | 取り消さない |
| 3 | `closed_by`がBot(`type`が`Bot`、またはログイン名が`[bot]`で終わる) | 取り消さない。BotやActionsは、第三者のイベントを受けて閉じることがあるため |
| 4 | 作者が分からない | 取り消さない |
| 5 | 作者以外の人が閉じた | 取り消す。他人のIssueやPRを閉じるには、triage以上の権限が要るため |
| 6 | 作者が閉じ、作者の`author_association`が`allowed_labeler_associations`に含まれる | 取り消す |
| 7 | 作者が閉じ、作者の関係が含まれないか分からない | 取り消さない |

取り消さなかった対象は、一覧に残る。
理由と対象は`poll_issues`のログにinfoで残す。

第三者が自分のIssueやPRを閉じて、安全策で止まった作業項目を一覧から消せないようにするためである。
publicのリポジトリでは、誰でもIssueを作れ、作者は自分のIssueやPRを閉じられる。
確認が無いと、安全策で止まった作業項目を、人が気づかないうちに一覧から外されてしまう。

この確認は、要対応の一覧から外す取り消しにだけかける。
取り消した作業項目は`retry_work_item`で再開できるので、権限のある人が元に戻せる。

残るリスクは次のとおり。

- [R-CLS-01](security-risks.md#r-cls-01)
- [R-CLS-02](security-risks.md#r-cls-02)
- [R-CLS-03](security-risks.md#r-cls-03)

## 残るリスク

受け入れた残るリスクは、領域ごとに[残るリスクの表](security-risks.md)へまとめ、この文書と`docs/internals/`の各文書の節からは、表の行のIDでリンクする。
表と節に書き分ける決まりは、[文書の書き方の「残るリスクを書く」](writing-guidelines.md#残るリスクを書く)にある。

## 各フローの安全策の置き場

各フローの安全策は、フローごとの内部仕様の文書にある。
受け入れた残るリスクは、[残るリスクの表](security-risks.md)にある。
次の表は、節の名前から置き場を引くためのものである。

| 節 | 置き場 |
| --- | --- |
| CIのメタデータの再生成 | [CIの失敗を直す部品の内部仕様の「CIのメタデータの再生成」](internals/ci-fix.md#ciのメタデータの再生成) |
| ホストの反映の印 | [ホストの実行役の内部仕様の「ホストの反映の印」](internals/host-apply.md#ホストの反映の印) |
| RESTの検索の拒否 | [GitHubの収集の内部仕様の「RESTの検索の拒否」](internals/github-collect.md#restの検索の拒否) |
| ジョブのログと結果の読み取り | [Consoleの安全策の内部仕様の「ジョブのログと結果の読み取り」](internals/console/security.md#ジョブのログと結果の読み取り) |
| ログと結果の伏せ字 | [Consoleの安全策の内部仕様の「ログと結果の伏せ字」](internals/console/security.md#ログと結果の伏せ字) |
| PRレビューの投入 | [Consoleの安全策の内部仕様の「PRレビューの投入」](internals/console/security.md#prレビューの投入) |
| ジョブの取消 | [Consoleの安全策の内部仕様の「ジョブの取消」](internals/console/security.md#ジョブの取消) |
| 定期ジョブの再実行 | [Consoleの安全策の内部仕様の「定期ジョブの再実行」](internals/console/security.md#定期ジョブの再実行) |
| 設定の変更 | [Consoleの安全策の内部仕様の「設定の変更」](internals/console/security.md#設定の変更) |
| 保留と凍結を置く | [Consoleの安全策の内部仕様の「保留と凍結を置く」](internals/console/security.md#保留と凍結を置く) |
| スケジュールを止める | [Consoleの安全策の内部仕様の「スケジュールを止める」](internals/console/security.md#スケジュールを止める) |
| 操作の記録 | [Consoleの安全策の内部仕様の「操作の記録」](internals/console/security.md#操作の記録) |
| ジョブの画面の描画 | [Consoleの安全策の内部仕様の「ジョブの画面の描画」](internals/console/security.md#ジョブの画面の描画) |
| 設計書の読み返しの画面 | [Consoleの安全策の内部仕様の「設計書の読み返しの画面」](internals/console/security.md#設計書の読み返しの画面) |
| 取り込み時点のIssueと提案の描画 | [Consoleの安全策の内部仕様の「取り込み時点のIssueと提案の描画」](internals/console/security.md#取り込み時点のissueと提案の描画) |
| 設計の承認画面の保護 | [Consoleの安全策の内部仕様の「設計の承認画面の保護」](internals/console/security.md#設計の承認画面の保護) |
| 設計書のプレビュー | [Consoleの安全策の内部仕様の「設計書のプレビュー」](internals/console/security.md#設計書のプレビュー) |
| ホストの実行役の境界 | [ホストの実行役の内部仕様の「ホストの実行役の境界」](internals/host-apply.md#ホストの実行役の境界) |
| 実行役のコード | [ホストの実行役の内部仕様の「実行役のコード」](internals/host-apply.md#実行役のコード) |
| treeの検査 | [ホストの実行役の内部仕様の「treeの検査」](internals/host-apply.md#treeの検査) |
| 人の承認が要る変更 | [ホストの実行役の内部仕様の「人の承認が要る変更」](internals/host-apply.md#人の承認が要る変更) |
| 承認の門 | [ホストの実行役の内部仕様の「承認の門」](internals/host-apply.md#承認の門) |
| 状態の置き場 | [ホストの実行役の内部仕様の「状態の置き場」](internals/host-apply.md#状態の置き場) |
| composeの方針 | [ホストの実行役の内部仕様の「composeの方針」](internals/host-apply.md#composeの方針) |
| composeのimageと秘密値の表 | [ホストの実行役の内部仕様の「composeのimageと秘密値の表」](internals/host-apply.md#composeのimageと秘密値の表) |
| 外部コマンドの許可表 | [ホストの実行役の内部仕様の「外部コマンドの許可表」](internals/host-apply.md#外部コマンドの許可表) |
| 子プロセスの環境とログ | [ホストの実行役の内部仕様の「子プロセスの環境とログ」](internals/host-apply.md#子プロセスの環境とログ) |
| CIの確認 | [ホストの実行役の内部仕様の「CIの確認」](internals/host-apply.md#ciの確認) |
| 保護パスとその限界 | [ホストの実行役の内部仕様の「保護パスとその限界」](internals/host-apply.md#保護パスとその限界) |
| 残るリスク(ホストの実行役の境界) | [残るリスクの表の「ホストの実行役の境界」](security-risks.md#ホストの実行役の境界) |
| 反映の承認 | [反映の承認の内部仕様の「反映の承認」](internals/deploy-approvals.md#反映の承認) |
| 凍結とdeployの保留 | [凍結とdeployの保留の内部仕様の「凍結とdeployの保留」](internals/freezes.md#凍結とdeployの保留) |
| 保留 | [保留の内部仕様の「保留」](internals/holds.md#保留) |
| draw.ioの図の描画 | [Consoleの安全策の内部仕様の「draw.ioの図の描画」](internals/console/security.md#drawioの図の描画) |
| ラベルのHTMLの読み方 | [Consoleの安全策の内部仕様の「ラベルのHTMLの読み方」](internals/console/security.md#ラベルのhtmlの読み方) |
| 隔離したiframeで描く | [Consoleの安全策の内部仕様の「隔離したiframeで描く」](internals/console/security.md#隔離したiframeで描く) |
| 親の部品が守ること | [Consoleの安全策の内部仕様の「親の部品が守ること」](internals/console/security.md#親の部品が守ること) |
| ビューアの更新 | [Consoleの安全策の内部仕様の「ビューアの更新」](internals/console/security.md#ビューアの更新) |
| 要件定義書のリンク | [Consoleの安全策の内部仕様の「要件定義書のリンク」](internals/console/security.md#要件定義書のリンク) |
| 監査レポートの本文 | [Consoleの安全策の内部仕様の「監査レポートの本文」](internals/console/security.md#監査レポートの本文) |
| 更新履歴のPR | [Consoleの安全策の内部仕様の「更新履歴のPR」](internals/console/security.md#更新履歴のpr) |
| PR修正の安全策 | [PRワークフローの仕様の「PR修正の安全策」](internals/pr-workflow.md#pr修正の安全策) |
| Factory自身の投稿の判定 | [PRワークフローの仕様の「Factory自身の投稿の判定」](internals/pr-workflow.md#factory自身の投稿の判定) |
| ツールの制限 | [PRワークフローの仕様の「ツールの制限」](internals/pr-workflow.md#ツールの制限) |
| 検査コマンドはフローが実行する | [検査コマンドの実行と権限の内部仕様の「検査コマンドはフローが実行する」](internals/check-sandbox.md#検査コマンドはフローが実行する) |
| 検査コマンドの権限 | [検査コマンドの実行と権限の内部仕様の「検査コマンドの権限」](internals/check-sandbox.md#検査コマンドの権限) |
| 対象リポジトリの設定を信頼しない | [PRワークフローの仕様の「対象リポジトリの設定を信頼しない」](internals/pr-workflow.md#対象リポジトリの設定を信頼しない) |
| 保護パスの変更を止める | [PRワークフローの仕様の「保護パスの変更を止める」](internals/pr-workflow.md#保護パスの変更を止める) |
| symlinkと特殊なファイルを止める | [PRワークフローの仕様の「symlinkと特殊なファイルを止める」](internals/pr-workflow.md#symlinkと特殊なファイルを止める) |
| HEADとブランチの確認 | [PRワークフローの仕様の「HEADとブランチの確認(PR修正の安全策)」](internals/pr-workflow.md#headとブランチの確認pr修正の安全策) |
| worktreeの.gitファイルの書き換えを止める | [PRワークフローの仕様の「worktreeの.gitファイルの書き換えを止める」](internals/pr-workflow.md#worktreeのgitファイルの書き換えを止める) |
| gitが読む設定を限る | [PRワークフローの仕様の「gitが読む設定を限る」](internals/pr-workflow.md#gitが読む設定を限る) |
| コミットの直前の再検査 | [PRワークフローの仕様の「コミットの直前の再検査」](internals/pr-workflow.md#コミットの直前の再検査) |
| 差し替えとサブモジュールに惑わされない | [PRワークフローの仕様の「差し替えとサブモジュールに惑わされない」](internals/pr-workflow.md#差し替えとサブモジュールに惑わされない) |
| 差分の大きさの上限(PR修正の安全策) | [PRワークフローの仕様の「差分の大きさの上限(PR修正の安全策)」](internals/pr-workflow.md#差分の大きさの上限pr修正の安全策) |
| PRの状態とheadの確認 | [PRワークフローの仕様の「PRの状態とheadの確認」](internals/pr-workflow.md#prの状態とheadの確認) |
| コミットの作成者情報 | [PRワークフローの仕様の「コミットの作成者情報(PR修正の安全策)」](internals/pr-workflow.md#コミットの作成者情報pr修正の安全策) |
| CIのログの扱い | [PRワークフローの仕様の「CIのログの扱い」](internals/pr-workflow.md#ciのログの扱い) |
| マージの競合を解く回 | [PRワークフローの仕様の「マージの競合を解く回(PR修正の安全策)」](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| 実装の安全策 | [実装フローの仕様の「実装の安全策」](internals/implement.md#実装の安全策) |
| ツールの制限と検査の分担 | [実装フローの仕様の「ツールの制限と検査の分担」](internals/implement.md#ツールの制限と検査の分担) |
| 取り込み後のIssueの書き換え | [実装フローの仕様の「取り込み後のIssueの書き換え」](internals/implement.md#取り込み後のissueの書き換え) |
| 同じ作業項目を同時に実装しない | [実装フローの仕様の「同じ作業項目を同時に実装しない」](internals/implement.md#同じ作業項目を同時に実装しない) |
| 承認済みの要件定義を書き換えさせない | [実装フローの仕様の「承認済みの要件定義を書き換えさせない」](internals/implement.md#承認済みの要件定義を書き換えさせない) |
| 検査コマンドを明示したリポジトリだけで実行する | [実装フローの仕様の「検査コマンドを明示したリポジトリだけで実行する」](internals/implement.md#検査コマンドを明示したリポジトリだけで実行する) |
| 対象リポジトリのCIが動く | [実装フローの仕様の「対象リポジトリのCIが動く」](internals/implement.md#対象リポジトリのciが動く) |
| 保護パスは止めずに明示する | [実装フローの仕様の「保護パスは止めずに明示する」](internals/implement.md#保護パスは止めずに明示する) |
| symlinkの変更を止める | [実装フローの仕様の「symlinkの変更を止める」](internals/implement.md#symlinkの変更を止める) |
| 差分の大きさの上限(実装の安全策) | [実装フローの仕様の「差分の大きさの上限(実装の安全策)」](internals/implement.md#差分の大きさの上限実装の安全策) |
| 保護ブランチのガードは使わない | [実装フローの仕様の「保護ブランチのガードは使わない」](internals/implement.md#保護ブランチのガードは使わない) |
| gitleaksで毎ラウンド検査する | [実装フローの仕様の「gitleaksで毎ラウンド検査する」](internals/implement.md#gitleaksで毎ラウンド検査する) |
| 検証したツリーだけをコミットする | [実装フローの仕様の「検証したツリーだけをコミットする」](internals/implement.md#検証したツリーだけをコミットする) |
| pushする履歴を記録した先頭と新しい1つのcommitに限る | [実装フローの仕様の「pushする履歴を記録した先頭と新しい1つのcommitに限る」](internals/implement.md#pushする履歴を記録した先頭と新しい1つのcommitに限る) |
| pushの前に生き残りのプロセスを確かめる | [実装フローの仕様の「pushの前に生き残りのプロセスを確かめる」](internals/implement.md#pushの前に生き残りのプロセスを確かめる) |
| コミットメッセージのIssue参照を無効にする | [実装フローの仕様の「コミットメッセージのIssue参照を無効にする」](internals/implement.md#コミットメッセージのissue参照を無効にする) |
| 子プロセスをグループごと止める | [実装フローの仕様の「子プロセスをグループごと止める」](internals/implement.md#子プロセスをグループごと止める) |
| 検査コマンドの出力を絞って保存する | [実装フローの仕様の「検査コマンドの出力を絞って保存する」](internals/implement.md#検査コマンドの出力を絞って保存する) |
| workflowの変更はpushで止まる | [実装フローの仕様の「workflowの変更はpushで止まる」](internals/implement.md#workflowの変更はpushで止まる) |
| 進め方ごとの承認 | [実装フローの仕様の「進め方ごとの承認」](internals/implement.md#進め方ごとの承認) |
| 設計書の生成の安全策 | [設計書の生成の仕様の「設計書の生成の安全策」](internals/design.md#設計書の生成の安全策) |
| 書き込める範囲と読める範囲 | [設計書の生成の仕様の「書き込める範囲と読める範囲」](internals/design.md#書き込める範囲と読める範囲) |
| worktreeの扱い | [設計書の生成の仕様の「worktreeの扱い」](internals/design.md#worktreeの扱い) |
| 差し戻しの報告 | [設計書の生成の仕様の「差し戻しの報告」](internals/design.md#差し戻しの報告) |
| 設計の承認の照合 | [設計書の生成の仕様の「設計の承認の照合」](internals/design.md#設計の承認の照合) |
| 設計の承認の反映 | [設計書の生成の仕様の「設計の承認の反映」](internals/design.md#設計の承認の反映) |
| 設計工程の門の固定 | [設計書の生成の仕様の「設計工程の門の固定」](internals/design.md#設計工程の門の固定) |
| 設計工程を有効にする操作 | [設計書の生成の仕様の「設計工程を有効にする操作」](internals/design.md#設計工程を有効にする操作) |
| 実装に渡す設計書 | [設計書の生成の仕様の「実装に渡す設計書」](internals/design.md#実装に渡す設計書) |
| 残るリスク(設計書の生成の安全策) | [残るリスクの表の「設計書の生成の安全策」](security-risks.md#設計書の生成の安全策) |
| 調査の隔離 | [調査の隔離の内部仕様の「調査の隔離」](internals/investigate.md#調査の隔離) |
| 起動の引数の固定 | [調査の隔離の内部仕様の「起動の引数の固定」](internals/investigate.md#起動の引数の固定) |
| 読み出しの拒否の固定の一覧 | [調査の隔離の内部仕様の「読み出しの拒否の固定の一覧」](internals/investigate.md#読み出しの拒否の固定の一覧) |
| 作業ディレクトリと設定の置き場の検査 | [調査の隔離の内部仕様の「作業ディレクトリと設定の置き場の検査」](internals/investigate.md#作業ディレクトリと設定の置き場の検査) |
| worktreeの置き場 | [調査の隔離の内部仕様の「worktreeの置き場」](internals/investigate.md#worktreeの置き場) |
| 指示ファイルの無効化 | [調査の隔離の内部仕様の「指示ファイルの無効化」](internals/investigate.md#指示ファイルの無効化) |
| 合格の証拠と関門 | [調査の隔離の内部仕様の「合格の証拠と関門」](internals/investigate.md#合格の証拠と関門) |
| 隔離の測定と判定 | [調査の隔離の内部仕様の「隔離の測定と判定」](internals/investigate.md#隔離の測定と判定) |
| 出力の本文を記録に残さない | [調査の隔離の内部仕様の「出力の本文を記録に残さない」](internals/investigate.md#出力の本文を記録に残さない) |
| 調査の入口を開ける門 | [調査の隔離の内部仕様の「調査の入口を開ける門」](internals/investigate.md#調査の入口を開ける門) |
| 調査の入口 | [調査の隔離の内部仕様の「調査の入口」](internals/investigate.md#調査の入口) |
| 保護パス | [調査の隔離の内部仕様の「保護パス」](internals/investigate.md#保護パス) |
| 残るリスク(調査の隔離) | [残るリスクの表の「調査の隔離」](security-risks.md#調査の隔離) |
| 入口の前提の扱い | [調査の隔離の内部仕様の「入口の前提の扱い」](internals/investigate.md#入口の前提の扱い) |
| 監査の安全策 | [監査の内部仕様の「監査の安全策」](internals/audit.md#監査の安全策) |
| dependabotの更新の自動マージ | [dependabotの更新の内部仕様の「dependabotの更新の自動マージ」](internals/dependabot.md#dependabotの更新の自動マージ) |
| マージする条件 | [dependabotの更新の内部仕様の「マージする条件」](internals/dependabot.md#マージする条件) |
| 他のリポジトリ | [dependabotの更新の内部仕様の「他のリポジトリ」](internals/dependabot.md#他のリポジトリ) |
| グループの更新 | [dependabotの更新の内部仕様の「グループの更新」](internals/dependabot.md#グループの更新) |
| インストールの後の確認 | [dependabotの更新の内部仕様の「インストールの後の確認」](internals/dependabot.md#インストールの後の確認) |
| Claudeは関門を緩めない | [dependabotの更新の内部仕様の「Claudeは関門を緩めない」](internals/dependabot.md#claudeは関門を緩めない) |
| 影響があるとき | [dependabotの更新の内部仕様の「影響があるとき」](internals/dependabot.md#影響があるとき) |
| マージの仕方 | [dependabotの更新の内部仕様の「マージの仕方」](internals/dependabot.md#マージの仕方) |
| PATのマージ権限 | [dependabotの更新の内部仕様の「PATのマージ権限」](internals/dependabot.md#patのマージ権限) |
| 守る部品と守らない部品 | [dependabotの更新の内部仕様の「守る部品と守らない部品」](internals/dependabot.md#守る部品と守らない部品) |
| 有効化の前の確認 | [dependabotの更新の内部仕様の「有効化の前の確認」](internals/dependabot.md#有効化の前の確認) |
| 残るリスク(dependabotの更新の自動マージ) | [残るリスクの表の「dependabotの更新の自動マージ」](security-risks.md#dependabotの更新の自動マージ) |
