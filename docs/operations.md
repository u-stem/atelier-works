# 運用

Factoryを動かす人が、日々の作業で何をすればよいかと、通知や失敗にどう対応するかをまとめた手順書である。構成と仕組みは[アーキテクチャ](architecture.md)、内部の挙動は`docs/internals/`の各文書を参照する。

画面の操作は、Factory Console(`f/factory/factory_console__raw_app`)のタブで行う。タブは**承認**、**要件定義**、**監査**、**パイプライン**、**分析**、**失敗**、**通知**の7つである。

## 運用の決まり

1つのIssueは1つのインスタンスだけが処理する。Issueに担当者を設定し、トリガーラベルを外す取得(claim)に成功したインスタンスが、そのIssueを受け持つ。後から来たインスタンスは手を引く。

Issueを取得したインスタンスの所有者が、そのIssueの承認をする。

各インスタンスは、稼働前に`f/factory/factory_config`の`instance_name`を設定する。Discordの通知と承認の画面で、どのインスタンスの担当かを示すのに使うためである。

作業項目の状態は、Consoleの**パイプライン**タブで確かめる。状態の値と意味は[アーキテクチャ](architecture.md)の状態の一覧にある。

### ラベルの扱い

Issue・PRに付けるラベルは、Factoryを起動するトリガーだけである。

| ラベル | 付ける対象 | 起動するもの |
| --- | --- | --- |
| `factory` | Issue | 要件定義 |
| `factory:review` | PR | PRのレビュー |
| `factory:fix` | PR | PRの修正 |

トリガーラベルは、取得のときに外れる。その後はどの状態になっても、FactoryはIssue・PRのラベルを付け外ししない。状態はDBの作業項目にだけあるためである。

もう一度処理させたいときは、人がトリガーラベルを付け直す。付け直すと、新しいサイクルとして別の作業項目ができる。

このリポジトリ自身の基盤整備PRには、`factory:review`と`factory:fix`のどちらも付けない。

### 対象のリポジトリ

Factoryが扱うのは、`factory_config`の`repo_allowlist`に含まれるリポジトリだけである。`repo_allowlist`が空なら、`owners`に含まれるリポジトリ全体が対象になる。

Factory自身のリポジトリ(`factory_repo`)は、`repo_allowlist`の内容に関わらず常に対象である。対象を試験的に絞りたいときは、`repo_allowlist`に対象のリポジトリを明示する。

## 作業を投入する

### ラベルで投入する

Issueに`factory`ラベルを付けると、Factoryがそれを拾う。拾うのは、最後にラベルを付けた人が許可された関係(既定ではOWNER、MEMBER、COLLABORATORのいずれか)のときだけである。

許可されていない人がラベルを付けたIssueは拾わない。Consoleの**通知**タブに、ラベル付与者の関係が許可されていない旨(`labeler_association_denied`)が残る。

### フォームで投入する

Windmillで手動投入のフロー(`f/factory/manual_intake`)を開き、フォームに入力して実行する。FactoryがIssueを作成し、ラベルで投入したときと同じ要件定義の工程に乗せる。

| 入力 | 内容 |
| --- | --- |
| `owner` | 対象リポジトリの所有者 |
| `repo` | 対象リポジトリ |
| `title` | Issueの題名 |
| `body` | このタスクで達成したい目的 |
| `acceptance_criteria` | 受入基準。1行に1項目で書く(任意) |

### 取得の後に登録が失敗したとき

ラベルを外した直後にDBへの登録が失敗すると、そのIssueはラベルと作業項目の両方が無い状態になる。Factoryはこれを自動では拾い直さない。

1. Discordの「人による対応が必要です: Issue #<番号>」の通知を開く。リンクはそのIssueである。
2. 失敗の原因を取り除く。原因は、Consoleの**失敗**タブの`claim_issue:<owner>/<repo>#<Issue番号>`か、`poll_issues`のジョブのログで確かめる。DBへの書き込みも失敗しているときは、**失敗**タブに出ず、ジョブのログにだけ残る。
3. そのIssueに`factory`ラベルを付け直す。

作業項目が無いので、**再実行**は使えない。
`poll_issues`のジョブ自体は失敗しない。
Factoryが自分でラベルを付け直さないのは、次の2つの害があるためである。
ラベルの付与者の記録がFactoryに置き換わり、ラベルを付けられる人の制限(`allowed_labeler_associations`)の検査が、人ではなくFactoryに対して行われる。
DBの障害が続く間は、取得と失敗が`poll_issues`のたびに繰り返される。

DBが挿入を確定したのに応答が失われたときは、作業項目が既にある。
付け直したラベルは、作業項目が進行中とみなされて見送られる。
`poll_issues`の点検が作業項目を孤児と判定して失敗にすると、次のポーリングで拾い直される。

## 要件定義を承認・却下する

要件定義の生成が終わると、Discordに承認待ちの通知が届く。

1. 通知のリンクか、Consoleの**承認**タブを開く。
2. 承認待ち一覧から作業項目を選ぶ。
3. 右側に表示される要件定義書と未確定事項を読む。
4. 承認するなら**承認**を押す。
5. 却下するなら、却下理由を書いてから**却下**を押す。補足は任意である。

承認した人は、実行したWindmillのユーザー(`WM_USERNAME`、無ければ`WM_EMAIL`)として記録される。承認すると、FactoryはIssueに要件定義へのConsoleのリンクを1件だけ投稿する。

却下すると、Factoryは却下理由を反映して要件定義を作り直し、もう一度承認待ちにする。作り直すたびに試行回数(attempt)が1つ増える。試行回数が上限(`max_attempts`、既定3)に達した後の却下では、作業項目は人の対応待ち(`needs_human`)になる。

承認依頼には7日の期限がある。期限までに判断しなかった作業項目は期限切れ(`expired`)になり、Discordに人の対応を求める通知が届く。期限切れの作業項目は、[失敗した作業を再実行する](#失敗した作業を再実行する)の手順で作り直せる。

### Windmillから直接承認する

Consoleを使えないときは、Windmillで`f/factory/approval_decide`を開き、次の値を入力して実行する。

| 入力 | 値 |
| --- | --- |
| `approval_request_id` | Consoleの**承認**タブに表示される承認依頼のID |
| `decision` | `approve`か`reject` |
| `reason` | 却下の理由。却下では必須 |
| `note` | 補足(任意) |
| `options` | 要件定義の承認では空のままにする |

### 要件定義書を読む

Consoleの**要件定義**タブで、要件定義書を一覧から選んで読める。承認待ちのものに限らず、これまでに生成したすべての試行が並ぶ。本文は見出し・表・図を含む文書ページの形で表示され、draw.ioの図もページ内に描かれる。

Issueの承認のコメントとDiscordの通知のリンクは、末尾に`#requirements/<work_item_id>`を付けている。このリンクを開くと、要件定義タブがその作業項目を選んだ状態で開く。

ConsoleはWindmillの管理画面の中で別オリジンのアプリとして動く。そのため、環境によってはリンク先の作業項目を選べないことがある。その場合は、次のどちらかで探す。

- リンクの文に書かれた`work_item_id`を、要件定義タブの一覧の上の絞り込み欄に入れる。一覧の各行にも`work_item_id`が表示されている。
- ブラウザのアドレスバーで、開いたConsoleのURLの末尾に`#requirements/<work_item_id>`を足す。

### 承認の前後でIssueを直したいとき

Factoryは、Issueを取り込んだ時点の題名と本文で要件定義を作り、実装もその内容で行う。取り込んだ後にIssueを書き換えても、要件定義と実装のどちらにも反映されない。

- 承認の前に直したいとき: Issueは書き換えず、**承認**タブで却下する。直したい内容を却下理由に書くと、Factoryがそれを反映して要件定義を作り直す。
- 承認の後に作り直したいとき: まず既存のPRを閉じてから、`factory`ラベルをIssueに付け直す。新しいサイクルは別の作業項目・別のブランチ・別のPRになるので、古いPRを残すと重複する。

承認の後にIssueを書き換えると、実装のPR本文の「確認して欲しい点」にその旨が1行出る。

## 失敗した作業を再実行する

止まった作業項目は、`f/factory/retry_work_item`で再開する。
再実行はトリガーラベルを付け直さず、対応するフローを直接起動する。
GitHubには何も書き込まない。

どこから実行するかは、作業項目の止まり方で決まる。

| 止まり方 | 実行のしかた |
| --- | --- |
| ジョブが失敗した | Consoleの**失敗**タブで**再実行**を押す |
| 人の対応待ち、ブロック、期限切れで止まった | Windmillで`f/factory/retry_work_item`を開き、作業項目のID(`work_item_id`)を入れて実行する |

**失敗**タブは、ジョブの失敗(`job_failures`)だけを並べる。
人の対応待ち、ブロック、期限切れの作業項目は**失敗**タブに出ない。
作業項目のIDは、Consoleの**パイプライン**タブで確かめる。

再実行できる状態と、作業項目の種類ごとに起動するフローは、[作業項目の状態とリース](internals/work-items.md)の「再実行」にある。
監査の作業項目は再実行できない。
監査が失敗した期間は、次の週次の監査か、**監査**タブの**今すぐ監査**で取り込む。

### 再実行が拒否される場合

次のときは、Factoryが理由を示して再実行を拒否する。

| 状況 | 人がすること |
| --- | --- |
| 承認が試行回数に一致しているのに、`implement_enabled`が無効 | 承認済みの要件定義を作り直さないための拒否である。実装させるなら`implement_enabled`を有効にする |
| 承認済みの作業項目で、承認が試行回数に一致しない | 表示された理由を確かめる |
| 作業項目のフローのジョブがまだ実行中か、キュー待ち | Windmillでそのジョブを止めるか、終わるのを待ってから再実行する |
| ジョブの状態を読めない(Windmill APIの一時的な障害など) | 時間をおいて再実行する |
| 読み取った後に、別の処理が作業項目の状態を変えた | パイプラインタブで今の状態を確かめる |

別の実行が先に作業項目を取っていたときの表示と、再実行の内部の仕組みは、[作業項目の状態とリース](internals/work-items.md)を参照する。

### Windmillの再実行機能は使わない

フローの再実行には、必ず`retry_work_item`を使う。
Windmillの画面でフローを再実行したり、途中のステップから再開したり、フローを直接実行したりすると、新しいジョブIDで動くため何もせずに終わる。
元の実行で進んでいるClaudeや検査も止まらない。

要件定義のフローをWindmillから直接動かすと、作業項目が終端でなければ最大60秒待ってから何もせずに終わる。この実行が例外で失敗しても、作業項目は失敗にならない。

### GitHubのrate limitで失敗したとき

GitHub APIのrate limitの解除を待てないと、作業項目は`GitHubRateLimitError`で失敗になる。
拒まれた要求の副作用は起きていない。
解除を待ってから**失敗**タブで再実行する。

rate limitが原因で人の対応待ちになったときは、通知の次の操作に、解除を待ってから再実行するよう表示される。
この作業項目は**失敗**タブに出ないので、解除を待ってからWindmillで`retry_work_item`を実行する。
待つ時間の上限などの仕組みは[通知とrate limit](internals/notifications.md)を参照する。

### 既定のブランチが食い違って実装フローが失敗するとき

実装フローの準備が、次のエラーで失敗することがある。

```text
origin HEAD is refs/heads/<新しい既定のブランチ>, not refs/heads/<古い既定のブランチ>
```

workerにある対象リポジトリのclone(`/workspaces/<owner>/<repo>/main`)の`origin/HEAD`が、GitHubの既定のブランチと違うことが原因である。
対象リポジトリの既定のブランチの名前を変えたときと、検査コマンドがcloneの`origin/HEAD`を書き換えたときに起きる。
fetchでは`origin/HEAD`が直らないので、再実行しても同じエラーで失敗する。

GitHubで既定のブランチの名前を確かめ、次のコマンドでcloneの`origin/HEAD`を合わせる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker git -C /workspaces/<owner>/<repo>/main remote set-head origin <新しい既定のブランチ>
```

その後、Consoleの**失敗**タブで**再実行**を押す。

## 実装フローを有効にして使う

要件定義の承認の後に実装まで進めるには、`factory_config`の`implement_enabled`を`true`にする。既定は`false`で、その間は作業項目が承認済み(`approved`)で止まる。

実装フロー(`f/factory/implement`)は、実装ブランチ`factory/issue-<N>-wi-<work_item_id>`を作ってpushする。検査に通ったらコミットしてPRを作成する。既にPRがあれば、その本文を更新する。

PRには`factory:review`ラベルが付くので、自動レビューが起動する。PR本文の`Closes #N`で元のIssueに紐づく。マージは常に人が行う。

実装フローの設定値と既定値、時間の上限は[実装フローの仕様](internals/implement.md)にある。時間の設定を変えるときは、そこに書かれたステップのtimeoutの範囲で組み合わせる。実装フローの実行中は時間の設定を変えない。設定を確かめるのは準備のステップだけだからである。

### 検査コマンドを設定する

実装の検査コマンドは、リポジトリごとに`check_commands_by_repo`で設定する。

```json
{
  "<owner>/<repo>": ["bun install --frozen-lockfile", "bun test"]
}
```

- エントリが無いリポジトリでは、検査コマンドを実行しない。PRの修正で使う`allowed_check_commands`は、実装では使わない。
- 検査の前に毎回`git clean -fdX`で無視ファイル(`node_modules/`など)を消す。そのため先頭で依存関係をインストールする。
- workerのイメージにmiseは無い。worker内で直接動くコマンドにする。例は`bun install --frozen-lockfile`、`bun test`、`bunx --bun tsc --noEmit`、`bunx --bun biome check .`である。
- 1つのリポジトリの検査コマンドは4件までを目安にする。検査コマンドが多いほど、修正のラウンドを始められる時間が短くなるためである。
- 検査コマンドに常駐のデーモンを残させない。ロックのファイル記述子を持ったまま残ると、以降のラウンドがロックを取れずに失敗する。記述子を閉じて残ったものも、次の準備やPRの修正を止める。

> [!WARNING]
> 検査コマンドは、Claudeが書いたコードをworker内でrootとして、サンドボックスなしで実行する。workerのサンドボックスができるまでは、Issueを信頼できる人だけが起票するリポジトリにだけ`check_commands_by_repo`を設定する。

実装ブランチをpushすると、人のレビューの前に対象リポジトリ自身のCIも動く。そのCIが使えるsecretsの範囲を確かめておく。

検査コマンドを実行するたびに、**通知**タブに未サンドボックスの検査コマンドの実行(`unsandboxed_check_commands`)が記録される。秘密情報の検査(gitleaks)は、設定に関わらず毎ラウンド実行する。

### PRができたら

Discordに実装のPRの通知(`pr_opened`)が届く。通知とPR本文で次を確かめる。

- 保護パスの変更は、実装を止めずにPR本文の「確認して欲しい点」と通知に並ぶ。保護パスは`.claude/**`、`.github/**`、`infra/**`、`mise.toml`、`package.json`、lockfileなどである。
- 保護パスを変えたラウンドでは、検査コマンドを実行しない。PR本文の「動作確認結果」に「検査未実施」と理由が出るので、GitHub側のCIの結果を確かめる。

保護パスの一覧と理由は[セキュリティ](security.md)にある。

### 人の対応待ちになったら

Discordの通知の「次の操作」に従う。主な場合は次のとおり。

| 起きたこと | 途中の変更 | 人がすること |
| --- | --- | --- |
| 実装が変更を生まなかった | 無い | 要件定義を見直すか、Issueを閉じる |
| ラウンド・予算の上限、期限、停滞、差分の超過で止まった(PRが無い) | 秘密情報の検査に通れば、実装ブランチにpush済み | ブランチを確かめて人がPRを作る、要件を直す、不要ならブランチを消す |
| 同じ理由で止まった(PRが既にある) | pushせずworktreeに残す | 同上 |
| symlinkの変更、Claudeの実行の失敗、worktreeの`.git`の書き換えで止まった | pushせずworktreeに残す | 同上 |
| 前のステップのClaudeや検査コマンドが、worktreeに残っている。理由に残っているプロセスが載る | pushしない | 載ったプロセスを止めてから再実行する |
| 検査コマンドがローカルでcommitかブランチの切り替えをした(「worktreeのHEAD(…)が記録したブランチの先頭(…)と異なります」など) | pushしない | 検査コマンドを確かめて人が直してから再実行する |
| commitしたツリーが、検査したツリーと違う | pushしない | 検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめてから再実行する |
| 途中経過では秘密情報の検査の後に、最終のcommitでは検証の後に、worktreeが変わった(「秘密情報の検査の後にworktreeが変更されました」、「検証の後にworktreeが変更されました」) | pushしない | 同上 |
| 検証のラウンドで、変更の判定と秘密情報の検査の間にworktreeが変わった | そのラウンドで止め、pushしない | 同上 |

完了時に新しい変更が無くても、ブランチに分岐点より先のコミット(途中経過のコミットなど)があれば、FactoryはそれでPRを作るか更新する。ブランチに分岐点より先のものが何も無いときだけ、変更を生まなかったとして止まる。

原因を取り除いたら、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行し、実装フローを再実行する。
人の対応待ちの作業項目は**失敗**タブに出ない。
途中経過のコミットは、再実行で完了したときのコミットとは別のコミットとして残る。

実装が要件の不足(`requirements_gap`)を報告したときは、Factoryが自動で要件定義を作り直す。再承認すると、同じブランチ名で実装をやり直す。既にPRがあれば、そのPRを更新する。

### 実装フローを再実行するとき

`retry_work_item`で再実行すると、準備のステップが、同じ作業項目の前の実装フローが起動して残っているプロセスを止めてから続ける。
そのため、実行中に同じ実行の検査コマンドなどが残したプロセスがロックを持ち続けて失敗したときは、再実行するだけでよい。

PRの修正のプロセスや、持ち主の分からないプロセスがworktreeを使っていると、作業項目は人の対応待ちになる。
理由に、残っているプロセスが載る。
この場合は、載ったプロセスが終わるのを待つか、何のプロセスかを確かめてworkerのコンテナで止めてから再実行する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker kill <pid>
```

残ったプロセスが終端の作業項目のworktreeを使っていると、作業領域の掃除はそのworktreeを消さずに飛ばす。
このとき**通知**タブに`cleanup_worktree_busy`が残る。
載ったプロセスを止めれば、次の掃除で消える。

Windmillで取り消した実行のClaudeや検査コマンドは、止まらずに残る。残ったプロセスの扱いと、実行中に作業項目を取られたときの挙動は[実装フローの仕様](internals/implement.md)を参照する。

### 実装フローの実行中に避けること

- mainへのマージとデプロイを避ける。自己更新は実行中の実装フローを待たずに新しいステップを反映するので、1回の実行の中で別の版のステップが動きうる。実装中(`implementing`)の作業項目があれば、実行中である。
- 実装フローは1回の実行で、workerのプロセス(`NUM_WORKERS`の数だけある)の1つを数時間使う。その間、ほかのフローが使えるworkerはその分減る。
- インスタンスの`job_default_timeout`を設定するなら、21600秒以上にする。実装と検証のステップ、PRの修正の検証のステップより先に打ち切らないためである。

## PRでレビューと修正を使う

PRのレビュー(`pr_review`)と修正(`pr_fix`)の内部の挙動は、[PRワークフローの仕様](internals/pr-workflow.md)にある。

失敗、人の対応待ち、ブロックといった運用上の知らせは、PRには書かずDiscordに送る。PRに書くのは、レビューの指摘と総評、修正の返信だけである。

### レビューを起動する

次のどれかでレビューが起動する。

- PRに`factory:review`ラベルを付ける。
- PRのレビュー依頼かassigneeにこのインスタンスのGitHubアカウントを入れる。まだレビューしていないcommitがあるときだけ起動する。

Factoryは、コメントやレビューの投稿者の関係(`author_association`)が`allowed_labeler_associations`に含まれることを確かめてから起動する。

レビューは、GitHubのCOMMENTのレビューとして投稿する。総評とインラインコメントの1行目には、`[pr_review 自動レビュー] @<author>`という印とメンションが付く。運用者自身のアカウントで投稿するため、Factoryの投稿だと分かるようにしている。

総評の文面と、指摘のスレッドを自動で解決する条件は[PRワークフローの仕様](internals/pr-workflow.md)にある。指摘が無いときも、最終的なApproveは人が判断する。

レビューの投稿のステップを再実行すると、前の実行で解決する予定のスレッドは開いたまま残ることがある。人が確かめて解決する。

### 修正を起動する

1. 直してほしい内容を、PRに通常のコメントとして書く。
2. PRに`factory:fix`ラベルを付ける。

Factoryは、ほかの人のコメントと同じく、ラベルの前に書かれた指示を修正の材料として集める。Factoryのレビュー済みのPRにも使える。

修正は`factory:fix`ラベルでしか起動しない。コメントやcommitのpushだけでは起動しない。次の修正を始めたいときは、`factory:fix`を付け直す。

修正が終わると、Factoryは各コメントに返信してから再レビューを依頼する。返信の形式は`.claude/skills/factory-fix/SKILL.md`にある。

### 修正の返信の判断

各コメントへの返信は、次の3つのどれかになる。

| 判断 | 意味 | 返信の末尾 |
| --- | --- | --- |
| `fixed` | このPRの範囲で修正した | `対応: <commit sha7>` |
| `skipped` | 対応しないと判断した。理由は返信の本文に書く | `対応: 見送り` |
| `propose_issue` | 指摘は妥当だが、このPRの範囲外。Issue化を提案する | `対応: Issue化を提案(承認待ち)` |

Issue化の提案が1件でもあると、その回の修正は人の対応待ちで終わる。提案が1件でも残っている間は、この状態が続く。

### Issue化の提案を承認・却下する

1. Consoleの**承認**タブを開く。Issue化の提案は、要件定義の承認待ちと同じ一覧に種別の印付きで並ぶ。
2. 一覧のPR番号、PRの題名、提案の題名、作成日時、担当者を見て、提案を選ぶ。
3. 右側に提案の本文と操作欄が表示される。
4. 起票と同時に要件定義へ進めるなら、「起票と同時にfactoryラベルを付けて要件定義に進める」にチェックを入れる。Issue化の提案では既定でオフである。
5. **承認**か**却下**を押す。却下では理由が必須である。

承認すると、Factoryが対象リポジトリにIssueを作り、レビューのスレッドに`Issue #Nを起票しました。`と返信してスレッドを解決する。チェックを入れていれば、Issueに`trigger_label`(既定`factory`)が付いて要件定義に進む。チェックを外したときは起票だけを行い、必要になったら人が後からラベルを付ける。

却下すると、スレッドに`見送りとします。`と理由を返信する。スレッドは開いたまま残し、人が改めて判断する。

作業項目に未決定の提案が残らなくなると、作業項目の状態が自動で切り替わる。その回でコミットをpushしていれば再レビュー依頼(`rereview_requested`)、pushしていなければレビュー済み(`reviewed`)になる。

Consoleを使えないときは、Windmillで`f/factory/approval_decide`を実行する。入力は[Windmillから直接承認する](#windmillから直接承認する)と同じで、承認では`options`に`{"with_factory_label": true}`のように指定する。

同じ判断で承認や却下をやり直しても安全である。Issueは二重に作られない。既に決まった提案に別の判断を送ると、Factoryは上書きせずにエラーを返す。

起票が途中で失敗した提案は、**承認**タブに残る。Issueの作成が失敗したときは未決定に戻る。Issueを作った後の返信やスレッドの解決が失敗したときは、「起票未完了」の印付きで残る。どちらも、もう一度承認すれば続きから起票する。

### 修正を再実行する

失敗(`failed`)、人の対応待ち、ブロック(`blocked`)で終わった修正は、`retry_work_item`で再実行できる。
実行のしかたは[失敗した作業を再実行する](#失敗した作業を再実行する)にある。

修正がpushに成功するか、要件定義へ差し戻すまでは、処理済みの位置が進まない。そのため、それ以外で終わった修正を再実行すると、前回と同じ指摘を集め直す。

通知の次の操作は、修正のどこで止まったかで変わる。

| 止まったところ | 例 | 人がすること |
| --- | --- | --- |
| 修正の前(準備のステップ) | PRがドラフト、親のIssueかブランチの実装フローが実行中、worktreeの使用中、時間の設定 | 原因を取り除いてから、`retry_work_item`で同じ作業項目を再実行する。修正のラウンドを使わない |
| 修正の後 | 要件定義への差し戻しの見送り、commitしたツリーが検査したツリーと違う、秘密情報の検査の後にworktreeが変わった、worktreeのHEADが動いた | 原因を確かめてから、新しいラウンドとして`factory:fix`を付け直す |

`factory:fix`を付け直すと、新しい作業項目で修正のラウンドを1つ使う。

前の実行の残したプロセスがworktreeを使っていれば、修正の準備のステップはブロックで止まる。
そのプロセスが同じpr_fixのものであっても、準備のステップは止めない。
実行中にロックが取れずに失敗した修正も、再実行するとこの理由でブロックになる。
この場合は、理由に載ったプロセスが終わるのを待つか、何のプロセスかを確かめてworkerのコンテナで止めてから、`retry_work_item`で再実行する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker kill <pid>
```

載ったプロセスを止められないときだけ、workerを再起動する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml restart windmill_worker
```

> [!WARNING]
> workerを再起動すると、同じコンテナで動いているすべてのジョブが止まる。

### 修正の差分に秘密情報が見つかったとき

修正は、pushの前に実装フローと同じ秘密情報の検査(gitleaks)をする。
見つかるとpushせず、作業項目は人の対応待ちになる。
理由には`secrets detected, changes not pushed`が載る。
検出したルール名とファイル名はジョブのログに残り、一致した文字列は残らない。

worktreeの差分から秘密情報を取り除いてから、人が修正するか`factory:fix`を付け直す。

次のときもpushしない。

- 検査の後にworktreeが変わった(`worktree changed after the secret scan`)。
- commitしたツリーが、検査したツリーと違う(`committed tree differs from the inspected tree`)。

検査そのものが失敗したときは、pushせずに作業項目が失敗になる。

返信の投稿に失敗した分は、**通知**タブに返信の投稿の失敗(`fix_reply_post_failed`)が残る。その場合は、PRで人が返信する。

### 修正が要件の不足を報告したとき

修正のClaudeが要件の不足を報告すると、Factoryは修正をやめ、元のIssueの要件定義を作り直す。作り直せるのは、元のIssueの作業項目が承認済みかPR作成済み(`pr_open`)のときだけである。

元のIssueが実装中や承認待ちのとき、試行回数が上限に達しているとき、読み取った後に状態が変わったときは、作り直さない。修正の作業項目を人の対応待ちにして、Discordで知らせる。実装フローの完了や要件定義の承認を待ってから、`factory:fix`を付け直す。

### PRの状態と人がすること

レビューと修正の作業項目は、次の状態で止まる。

| 状態 | 意味 | 人がすること |
| --- | --- | --- |
| レビュー済み(`reviewed`) | レビューが終わり、修正は不要 | 内容を確かめてApproveする |
| 再レビュー依頼(`rereview_requested`) | 修正をpushし、再レビューを依頼した | 再レビューを待つ |
| ブロック(`blocked`) | 準備の確認で修正の前に止めた、修正の実行中にPRのheadが動いた、要件の不足で元のIssueへ差し戻した | 通知の理由に従う。修正の前に止めたときは、原因を取り除いて再実行する |
| 人の対応待ち(`needs_human`) | 修正を安全策や検査の失敗で止めた、レビューが失敗した、Issue化の提案がある | 通知の「次の操作」に従う |

### ラベルを外した後の追跡

トリガーラベルが外れた後も、Factoryは`tracked_pr_days`(既定30日)以内に更新があったPRをDBから見つけ直す。人が新しいcommitをpushすると、そのたびに再レビューが起動する。1回のpushにつきClaudeの実行は1回である。

それ以上追跡させたくないPRは、closeするか、`tracked_pr_days`を過ぎるまで待つ。

`review_post_mode`を`gated`にすると、レビューを投稿しない。検証用の予約のモードで、PRはレビュー依頼かassigneeからだけ見つけ直す。

### 人が作ったPRを要件と紐づける

PR本文に`Closes #123`と書くと、そのIssueの承認済みの要件と照合する。`Fixes`と`Resolves`も使える。照合できれば、レビューと修正のClaudeに要件を渡す。

## 監査を使う

Factory自身の運用記録の監査は、毎週月曜09:30に自動で走る(`audit_kickoff`)。Consoleの**監査**タブの**今すぐ監査**で前倒しできる。

次のときは監査を始めず、スキップの理由を表示する。

- 実行中の監査がある。
- 対象の期間が空である。
- 新しい記録が無い。
- 日次の予算を超えている。

監査レポートは**監査**タブで読む。一覧から選ぶと、本文と提案の決定の状況が表示される。

Discordの監査完了の通知(`audit_completed`)のリンクは、末尾に`#audit/<work_item_id>`を付けている。要件定義タブと同じ理由で選ばれないときは、一覧から選ぶ。

改善提案は、**承認**タブに「改善提案」として並ぶ。承認すると、Factory自身のリポジトリにIssueを起票する。「起票と同時にfactoryラベルを付けて要件定義に進める」は、改善提案では既定でオンである。外せば起票だけになる。Factory自身のリポジトリは常に対象なので、ラベルを付けたIssueはそのまま要件定義に進む。

監査の内部の挙動は[監査の仕様](internals/audit.md)にある。

## 通知を受けたら

Factoryは、人の行動が要るものだけをDiscordに送る。通知の仕組み、送れなかったときの扱い、rate limitは[通知とrate limit](internals/notifications.md)にある。

> [!NOTE]
> 通知は失敗しても再送しない。通知が来ないときは、ConsoleとGitHubで状態を確かめる。

### Discordの通知

| 通知 | 意味 | 人がすること |
| --- | --- | --- |
| Issue着手(`issue_claimed`) | FactoryがIssueを取得し、要件定義の生成を始めた | なし |
| 承認待ち(`approval_requested`) | 要件定義が承認待ちになった | [要件定義を承認・却下する](#要件定義を承認却下する) |
| 要件定義承認(`requirements_approved`) | 要件定義が承認され、Issueにリンクを投稿した | なし。実装が有効なら実装フローが始まる |
| 人による対応が必要(`needs_human`) | 作業項目が人の対応待ちか期限切れになった | 通知の「次の操作」に従う。再実行するときは、Windmillで`retry_work_item`を実行する |
| ジョブ失敗(`job_failed`) | フローやスケジュールが失敗した。孤児のジョブや閉じたIssue・PRの片付けも含む | **失敗**タブで内容を確かめ、再実行する |
| PR作成・更新(`pr_opened`) | 実装フローがPRを作成か更新した | [PRができたら](#prができたら) |
| PRレビュー完了(`pr_reviewed`) | レビューを投稿した | 指摘を確かめる。指摘が無ければApproveを判断する |
| PR修正適用(`pr_fixed`) | 修正をpushし、再レビューを依頼した | 再レビューを待つ。補足に依頼の失敗が載っていれば、GitHubのPRで人がレビュアーを依頼する |
| 日次サマリー(`daily_summary`) | 前日のコスト、件数、失敗、DBの掃除の件数 | 異常が無いか見る |
| 監査レポート(`audit_completed`) | 監査で改善提案が1件以上できた | **承認**タブで提案を承認か却下する |

GitHubのPATが失効していると、Issueの取得のスケジュール(`poll_issues`)がジョブ失敗として通知される。PATを再発行する手順は[秘密をローテーションする](#秘密をローテーションする)にある。

### Consoleの通知タブ

Consoleの**通知**タブには、Discordに送らない要対応の事項が残る。

| 種類 | 意味 | 人がすること |
| --- | --- | --- |
| `approval_notify_failed` | 承認待ちの通知がDiscordに届かなかった | 承認依頼は記録済みなので、**承認**タブで判断する |
| `approval_comment_failed` | 承認のコメントをIssueに投稿できなかった | 承認と実装の起動は進んでいる。必要ならnoticeのリンクを載せたコメントを人がIssueに投稿する |
| `implement_launch_failed` | 承認の後、実装フローへ進める処理がDBの失敗で例外になった | Windmillで`f/factory/retry_work_item`を作業項目のIDで実行して再開する |
| `implement_needs_human` | 実装フローが人の対応待ちで止まった | [人の対応待ちになったら](#人の対応待ちになったら) |
| `unsandboxed_check_commands` | 検査コマンドをサンドボックスなしで実行した | 設定が意図どおりか確かめる |
| `fix_reply_post_failed` | 修正の返信の投稿に失敗した | PRで人が返信する |
| `pr_fix_reviewer_request_failed` | 再レビューの依頼のAPIが失敗した。PRの取得の失敗と、Botや削除済みの作成者の名前で依頼を組み立てられない場合を含む | GitHubのPRで人がレビュアーを依頼する |
| `issue_proposal_record_failed` | Issue化の提案を記録できなかった | PRのスレッドを確かめ、必要なら人がIssueを起票する |
| `fix_feedback_association_excluded` | 許可されていない関係の人のコメントを、修正の材料から除いた | 必要なら許可された人が指示を書き直す |
| `labeler_association_denied` | 許可されていない関係の人が`factory`ラベルを付けた | 拾わせるなら、許可された人がラベルを付け直す |
| `claim_race_lost` | ほかのインスタンスが先にIssue・PRを取得した | なし |
| `deployed_sha_mismatch` | 自己更新が反映した版と、self cloneの版が一致しない | 自己更新のジョブの失敗を確かめる |
| `cleanup_db_failed` | 保持期間を過ぎたレコードの削除に失敗した | 内容を確かめる。次の日の掃除でやり直す |
| `cleanup_worktrees_skipped` | 動いているPRの修正のブランチを確かめられず、そのリポジトリの作業領域の掃除を見送った | 次の日の掃除を待つ |
| `cleanup_worktree_busy` | 残ったプロセスが使っているので、終端の作業項目のworktreeを消さなかった。作業項目のID、worktreeのパス、使っているプロセスが載る | 載ったプロセスを止める。止めない限り毎日残る |
| `workspace_disk_usage` | 作業領域の掃除(毎日03:00)が記録したディスク使用量 | 増え続けていないか見る |

### 要件定義の作り直しを起動できなかったとき

却下で要件定義を作り直すときに、フローを起動できないか、起動したジョブのIDを記録できないことがある。このとき作業項目は人の対応待ちになり、理由は`requirements regeneration could not be started`になる。Discordにはジョブ失敗が届く。

**失敗**タブから再実行する。この再実行では却下理由が要件定義のフローに渡らない。却下理由は承認依頼(`approval_requests.reason`)に残っている。

### 実装フローの起動前の処理が失敗したとき

承認済みから実装中へ進める処理がDBの失敗で例外になると、通知タブに`implement_launch_failed`が残る。作業項目はふつう承認済みのまま残り、自動では再開しない。

この作業項目は**失敗**タブに出ないので、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行して再開する。

まれに、例外の前に実装中へ進んでいることがある。この作業項目はフローの無いまま残る。猶予を過ぎると、定期の点検がこれを失敗にする。失敗になった後は、同じ手順で再開できる。

## 更新を反映する

### 自動で反映されるもの

`f/`、`migrations/`、`.claude/skills/`の変更は、自己更新のスケジュール(`self_update`、10分ごと)が自動で反映する。ホスト側の操作は要らない。

自己更新は`infra/`の変更と、`mise.toml`の`[tools]`・`[env]`の変更を検知すると、ログとデプロイの記録(`deployments.needs_host_action`)に残す。通知はしない。これらは、次にホスト側で`mise run up`したときに反映される。

`mise.toml`の`[tasks.*]`だけの変更、`scripts/`の変更、`mise.local.toml.example`の変更は記録しない。workerの動作に影響しないためである。

### ホスト側で反映するもの

`infra/`と`mise.toml`の`[tools]`・`[env]`の変更は、次の手順で反映する。ビルドはホスト側のcheckoutから行うので、先にmainを取り込む。

1. ホスト側のcheckoutで`git pull`する。
2. `mise run up`で起動し直す。workerのイメージの再ビルドとコンテナの再作成まで行う。

workerの並列数(`NUM_WORKERS`)のような`infra/docker-compose.yml`の変更も、`git pull`だけでは反映されず、`mise run up`で反映される。

まとめて反映したいときは、`mise run deploy`を手で実行する。必須の手順ではない。`mise run deploy`は次を順に行う。

1. ホスト側のcheckoutで`git pull --ff-only`
2. イメージの取得と、workerと`console_fetcher`のイメージのビルド
3. `docker compose up -d`
4. Consoleのraw appの依存の`npm ci --ignore-scripts`と`wmill sync push`
5. migrationの実行

`mise run push`と`mise run deploy`は、`wmill sync push`の前にConsoleのraw appの`npm ci --ignore-scripts`を実行する。
raw appのバンドルに依存が要るためである。
`wmill sync push`がバンドルのために動かすnpmも`NPM_CONFIG_IGNORE_SCRIPTS=true`で動かす。
どちらも、依存のinstall scriptを動かさない。
理由は[セキュリティ](security.md)の「自己更新の依存インストール」にある。

### mise run upで反映されないもの

| 変更 | 反映のしかた |
| --- | --- |
| `infra/Caddyfile` | bind mountしたファイルなので、`up -d`はコンテナを作り直さない。`mise exec -- docker compose -f infra/docker-compose.yml restart caddy`でCaddyを再起動する |
| `mise.toml`の`[tools]`のうちホスト側のCLI | `mise install`か`mise run setup`で反映する |

`mise run up`が反映するのは、`[env]`に書いたworkerのイメージのツールのバージョンである。

### workerのツールのバージョン

workerのイメージに入れるツールのバージョンは、`mise.toml`の`[env]`で固定し、`infra/worker/Dockerfile`のbuild argとして渡す。

| ツール | 変数 |
| --- | --- |
| `claude` | `CLAUDE_VERSION` |
| `gh` | `GH_VERSION` |
| `gitleaks` | `GITLEAKS_VERSION` |
| `gtr` | `GTR_REF` |
| `wmill` | `WMILL_VERSION` |

ツールの追加やバージョンの変更には、workerのイメージの再ビルドが要る。`gitleaks`は、実装フローが毎ラウンドの固定の検査として`--redact`付きで実行するために入れている。版はホスト側のpre-commitのフックと同じである。

### 同期されない変数とリソース

`wmill sync push`に`--include-secrets`を付けてはいけない。付けると、値を空のままコミットしている`f/factory/*.variable.yaml`で、4つの秘密の変数が空に上書きされる。対象は`claude_oauth_token`、`github_token`、`wmill_token`、`discord_webhook_url`である。`mise run push`は`--include-secrets`を付けない設定になっている。

秘密の変数とインスタンス固有の`factory_config`のリソースは、同期の対象外である。説明文(description)を変えても、`mise run push`では既存のインスタンスに反映されない。既存のインスタンスでは、WindmillのVariablesとResourcesの編集画面で説明文だけを直す。新しいインスタンスは、bootstrapがリポジトリの説明文で作る。

`f/factory/deployed_sha`変数も同期の対象外である。自己更新が書き込む実行時の状態だからである。`bootstrap`は初回だけ空の値で作り、既にあれば値を変えない。値を戻したいときは、Windmillの画面で直接編集する。

### Consoleのraw appを変更する

Factory Console(`f/factory/factory_console__raw_app/`)は、raw appとしてリポジトリでコードを管理する。Windmillの画面では編集せず、リポジトリのソース(`App.tsx`、`tabs/*.tsx`、`backend/*.yaml`など)を直して`mise run push`でデプロイする。ロックの情報は、コミット時にpre-commitのフックが更新する。

### Console(console/)を反映する・戻す

`console/`の変更は、`main`にマージされてCIが通れば、数分で`console_fetcher`が取り込んで反映する。
`self_update`は関与しない。
`infra/console_fetcher/`とCaddyfileの変更は、ほかの`infra/`と同じく次の`mise run up`で反映される。
Caddyfileだけを変えたときは、Caddyを再起動する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml restart caddy
```

`console_fetcher`は5分ごとに、`main`へのpushで全体が成功した`ci.yml`の最新の実行を探す。
その成果物`console-dist`を検証して`factory_console`の`releases/<sha>/`に置き、`current`を付け替える。
状態は`status.json`に書き、ログにも出す。
`status.json`には、`state`(`ok`、`failed`、`pinned`)、`sha`、`checked_at`、`error`が入る。

```bash
mise exec -- docker compose -f infra/docker-compose.yml logs --tail 50 console_fetcher
```

版は、配信するファイルの中身(`manifest.json`の`files`)が違うものを3つまで残す。
版は`main`へのpushのたびに作られ、`console/`に触れないpushでできた版は中身が同じなので、1つと数える。
無関係なマージが続いても、戻せる版を押し出さないためである。
数える対象は、直近20回のpushの範囲である(`history.json`が覚えている回数)。
共有の`assets/`は、残した版から参照されず14日を超えたファイルを消す。

新しい版に問題があれば、直前の版に戻す。

1. `mise run console:rollback`を実行する。取り込みの最中なら`console_fetcher is updating the console right now.`と出て止まるので、少し待ってやり直す。
2. 戻すと`pin`が置かれ、自動の付け替えが止まる。もう一度実行すると、さらに1つ前に戻る。
3. `main`に修正を入れてCIが成功したら、`mise run console:unpin`で`pin`を外す。5分以内に最新の版へ戻る。

戻し先は、中身が今の版と違う最も新しい版である。
中身が同じ版へ戻しても、何も変わらないためである。
そのような版が残っていないと、`No previous release with different content to roll back to.`と出て止まる。
この場合と、残っている版より前に戻したい場合は、`main`で該当のcommitをrevertし、CIを動かす。

戻すと、戻した元の版と、それと中身が同じ版を消す。
その版だけが参照する共有の`assets/`のファイルも、更新日時にかかわらず消す。
`pin`の間も、問題の版のscriptを`/console/assets/`から読めるままにしないためである。
消す版のshaは`pin`の`rolled_back_from`に、戻した元の版の中身(`files`のsha256)は`rolled_back_content`に記録する。
消し終わらなかったときは、`console:rollback`が`The rollback succeeded, but removing ...`で始まる文を出す。
続きは`console_fetcher`が次の取り込みで消す。
`rolled_back_from`を持たない`pin`では、戻した元の版は消えない。
消した版のページを開いたままのブラウザは、assetsを読み込めなくなるので、再読み込みが要る。

`pin`を外すと、`console_fetcher`は最新の成功した実行を取り込む。
その実行が戻した元の版と同じ中身だと、問題の版が再び配信される。
`console/`に触れないマージでも、同じ中身の版が新しいcommitで作られるので、commitのshaだけでは見分けられない。
`console:unpin`は、最新の成功した実行のshaと、その実行の`files`のsha256を、`pin`の記録と照らす。
次の場合は`pin`を外さず、理由を出して止まる。

| 状況 | 人がすること |
| --- | --- |
| 最新の成功した実行のshaが、戻した元の版のshaである | 修正を`main`に入れ、そのCIが成功してからやり直す |
| 最新の成功した実行の`files`が、戻した元の版と同じである | `console/`を変える修正を`main`に入れ、そのCIが成功してからやり直す |
| 最新の実行を調べられない(トークンや`CONSOLE_GITHUB_REPO`の不備、ネットワークの失敗) | 原因を直してやり直す |
| 最新の実行の`files`を調べられない(成果物の取得か検証に失敗) | 原因を直してやり直す |
| 戻した元の版を消せていない | このコマンドの出力か`console_fetcher`のログの`revoked_cleanup_skipped`、`revoked_cleanup_failed`を確かめ、原因を直してやり直す |

`rolled_back_content`を持たない`pin`は、shaだけを照らす。
`rolled_back_from`も持たない`pin`は、照らす版が無いので、問い合わせずに外す。

確認を飛ばすオプションは2つある。
`mise run console:unpin -- --force`は、最新の実行についての確認(上の表の前の4行)を飛ばす。
問題の版が再び配信されるのを承知の上で使う。
`mise run console:unpin -- --ignore-cleanup`は、戻した元の版を消せていない確認を飛ばす。
`--force`だけでは、この確認は飛ばない。

主な`error`と対処は次のとおり。

| `error` | 意味 | 人がすること |
| --- | --- | --- |
| `config_missing` | `CONSOLE_GITHUB_TOKEN`が無いか、`mise.toml`の`CONSOLE_GITHUB_REPO`の形が違う | 直して`mise run up`する |
| `auth_failed` | トークンが失効した | 再発行して投入し、`mise run up`する |
| `forbidden`、`not_found` | トークンの対象リポジトリか権限(Actions: Read)が違う | トークンと`mise.toml`の`CONSOLE_GITHUB_REPO`を確かめる |
| `rate_limited` | GitHub APIの呼び出し回数の上限に達した | 何もしなくてよい。5分ごとの次の確認で再試行し、その間も今の版を配信し続ける |
| `no_successful_run`、`artifact_missing`、`artifact_expired` | 取り込める成果物が無い | CIの結果を確かめ、必要なら`main`にpushしてCIを動かす |
| `digest_mismatch`、`manifest_mismatch`、`zip_unsafe_entry`、`unexpected_redirect` | 検証に失敗した | 今の版を配信し続けるので急ぎではないが、原因を調べる |
| `asset_conflict` | 新しい版の`assets/`のファイルが、既にある同じ名前のファイルと中身が違う(`console/public/assets/`の名前の付け替え忘れなど) | 置き換えると配信中の版が壊れるので取り込まない。名前を直したcommitを`main`に入れる |

取り込みの失敗は、noticeとDiscordのどちらにも出ない。ログで確かめる。

### adminsワークスペースの組み込み項目

Windmillは起動時に、`admins`ワークスペースへ組み込みのscriptとscheduleを作る。「Synchronize Hub Resource types with instance」などである。これらはWindmill本体の一部で、このリポジトリの管理対象ではない。`mise run push`と自己更新の同期にも含まれない。summaryが英語のままなのはそのためで、日本語化と削除はしない。

Factoryの資産は、すべて`factory`ワークスペースの`f/factory/**`にある。

### workerがプロセスを作れなくなったとき

workerのコンテナは、`init: true`でdocker-initをPID 1にし、終了した子プロセスを回収する。ジョブが起こすgit、gh、esbuildの子プロセスは、親より長く残ることがある。initが無いと、回収されないプロセスが上限の`pids: 512`を使い切り、すべてのジョブが`errno=11`(EAGAIN)で失敗する。

同じ症状が出たら、使用量を確かめてからworkerを再起動する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker cat /sys/fs/cgroup/pids.current
mise exec -- docker compose -f infra/docker-compose.yml restart windmill_worker
```

## 秘密をローテーションする

1. GitHubのPAT(`GITHUB_TOKEN`、`CONSOLE_GITHUB_TOKEN`)かClaude CodeのOAuthトークンを発行し直す。手順は[セキュリティ](security.md)にある。
2. 新しい値を`mise.local.toml`に投入する。コマンドは[セットアップ](setup.md)にある。
3. `mise run bootstrap`を実行し直す。`bootstrap.sh`は冪等で、既存のWindmillの変数を新しい値で上書きする。
4. `CONSOLE_GITHUB_TOKEN`は、`bootstrap`ではなく`mise run up`で反映する。`console_fetcher`のコンテナが新しい値で作り直される。

## バックアップ

Windmillのデータ(ワークスペースの設定、Data Table、ジョブの履歴など)は、すべて`db_data`というDockerのvolume(Postgres)にある。バックアップの対象はこのvolumeである。

> [!WARNING]
> `mise exec -- docker compose -f infra/docker-compose.yml down -v`は、`db_data`を含むすべてのvolumeを消す。消したデータは戻せない。

## 保持期間

DBの掃除のスケジュール(`cleanup_db`、毎日03:30)が、保持期間を過ぎたレコードを消す。日数はどちらも`f/factory/factory_config`で変えられる。

| 対象 | 保持期間 | 設定 |
| --- | --- | --- |
| 終端の状態になった作業項目と、それに連なる記録 | 90日 | `retention_work_items_days` |
| 監査の作業項目とレポート・提案 | 監査完了(`audited`)から90日 | `retention_work_items_days` |
| 失敗の記録、デプロイの記録、解決済みのお知らせ | 30日 | `retention_logs_days` |

終端の状態は、承認済み、人の対応待ち、期限切れ、失敗、レビュー済み、再レビュー依頼、ブロック、キャンセル、PR作成済み、監査完了である。PR作成済みの作業項目は、PRがopenのままでも90日で消える。

作業項目を消すと、外部キーの`ON DELETE CASCADE`で次の記録も消える。

- 要件定義のドラフト
- 承認の履歴と承認依頼
- 状態遷移の履歴(`work_item_events`)
- Claudeの実行の記録(`agent_runs`)

Claudeの実行の記録は、コスト分析(`v_agent_cost_daily`)の元データである。コスト分析を保持期間より長く見たいときは、`retention_work_items_days`を延ばす。

作業項目を消すときは、その要件定義のディレクトリも消す。ディレクトリは`requirement_drafts.doc_dir`が指す場所である。workerの`/var/lib/factory/requirements/<owner>/<repo>/issue-<N>/wi-<id>/`以下にある。

この削除はDBの行の削除とは別の処理である。失敗しても、ほかの掃除とDBの削除は止まらない。

未解決のお知らせは消さない。消した件数は`cleanup_runs`テーブルに記録し、翌朝09:00の日次サマリーの「DB掃除」欄に出す。

同じIssueの作業項目がすべて消えた後にそのIssueを拾い直すと、サイクルの番号は1から振り直す。番号は残っている行の最大値から決めるためである。過去の通知やDiscordの履歴にあるサイクルの番号と重なることがある。
