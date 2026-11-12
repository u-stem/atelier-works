# 残るリスク

Software Factoryが受け入れた残るリスクを、領域ごとの表にまとめる。
フローを変更する人と、セキュリティの変更をレビューする人が読む。
行を足すときの決まりは、[文書の書き方の「残るリスクを書く」](writing-guidelines.md#残るリスクを書く)にある。

## 表の読み方

1列目は、リスクのIDである。
各行は、IDを小文字にした名前のアンカー(`#r-tb-01`など)を持つ。
2列目は、受け入れた残るリスクと、受け入れる理由である。
受け入れたリスクに結び付く未確認の点と、受け入れを見直す条件も、同じ行の文に含む。
3列目の関連する節には、そのリスクに関わる安全策の仕組みがある。
関連する節が複数あるときは、読点「、」で区切って並べる。

IDは`R-<領域>-<連番2桁>`の形で、領域の略号は次の表のとおりである。
「使った最大の番号」は、その領域でこれまでに振ったIDの番号の最大である。
消したIDは、末尾の[欠番](#欠番)に並ぶ。

| 略号 | 領域 | 説明の文書 | 使った最大の番号 |
| --- | --- | --- | --- |
| TB | [信頼境界](#信頼境界) | [セキュリティ](security.md) | 36 |
| CRED | [資格情報の取得](#資格情報の取得) | [セキュリティ](security.md) | 10 |
| DLV | [Consoleの配信](#consoleの配信) | [セキュリティ](security.md) | 33 |
| BAK | [バックアップの控え](#バックアップの控え) | [セキュリティ](security.md) | 03 |
| PER | [定期ジョブ用workerの境界](#定期ジョブ用workerの境界) | [セキュリティ](security.md) | 22 |
| UPD | [自己更新の打ち切り](#自己更新の打ち切り) | [セキュリティ](security.md) | 04 |
| DENY | [Claude Codeの拒否ルール](#claude-codeの拒否ルール) | [セキュリティ](security.md) | 02 |
| HOOK | [Claude Codeのフック](#claude-codeのフック) | [セキュリティ](security.md) | 08 |
| LBL | [ラベル付与の制限](#ラベル付与の制限) | [セキュリティ](security.md) | 10 |
| CLS | [閉じた人の確認](#閉じた人の確認) | [セキュリティ](security.md) | 03 |
| HOST | [ホストの実行役の境界](#ホストの実行役の境界) | [ホストの実行役の内部仕様](internals/host-apply.md) | 56 |
| CON | [Consoleの安全策](#consoleの安全策) | [Consoleの安全策の内部仕様](internals/console/security.md) | 42 |
| DIO | [draw.ioの図の描画](#drawioの図の描画) | [Consoleの安全策の内部仕様](internals/console/security.md) | 17 |
| INV | [調査の隔離](#調査の隔離) | [調査の隔離の内部仕様](internals/investigate.md) | 41 |
| DES | [設計書の生成の安全策](#設計書の生成の安全策) | [設計書の生成](internals/design.md) | 46 |
| HOLD | [保留](#保留) | [保留の内部仕様](internals/holds.md) | 32 |
| FRZ | [凍結とdeployの保留](#凍結とdeployの保留) | [凍結とdeployの保留の内部仕様](internals/freezes.md) | 29 |
| FIX | [PR修正の安全策](#pr修正の安全策) | [PRワークフロー](internals/pr-workflow.md) | 28 |
| CHK | [検査コマンドの権限](#検査コマンドの権限) | [検査コマンドの実行と権限の内部仕様](internals/check-sandbox.md) | 15 |
| DEP | [dependabotの更新の自動マージ](#dependabotの更新の自動マージ) | [dependabotの更新の内部仕様](internals/dependabot.md) | 15 |
| DAP | [反映の承認](#反映の承認) | [反映の承認の内部仕様](internals/deploy-approvals.md) | 05 |
| GHC | [RESTの検索の拒否](#restの検索の拒否) | [GitHubの収集の内部仕様](internals/github-collect.md) | 05 |
| IMP | [実装の安全策](#実装の安全策) | [実装フロー](internals/implement.md) | 04 |
| CIF | [CIのメタデータの再生成](#ciのメタデータの再生成) | [CIの失敗を直す部品の内部仕様](internals/ci-fix.md) | 03 |
| COV | [カバレッジの検査](#カバレッジの検査) | [テストの基準](testing-guidelines.md) | 05 |

## 信頼境界

### 書き込める範囲

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-01"></a>R-TB-01 | 残るリスクとして、要件定義の生成のworktreeは、既定ブランチの先頭が同じ間は次の試行でも使い回す。そのため、Claudeが書き込んだ内容を、同じIssueの次の試行のClaudeが読みうる。 | [書き込める範囲](security.md#書き込める範囲) |

### CIで走査されないコミット

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-02"></a>R-TB-02 | 残るリスクとして、PRのCIの実行は、同じPRの新しい実行が始まると`cancel-in-progress`で止まる。秘密値を含むコミットを、実行の途中でforce pushにより置き換えると、置き換えられたコミットはCIのgitleaksで走査されない。置き換えられるのは、PRの履歴から外れたコミットなので、受け入れる。手前の防御として、lefthookのpre-commitのgitleaksと、Factoryのpush前の走査がある。 | [CIで走査されないコミット](security.md#ciで走査されないコミット) |
| <a id="r-tb-03"></a>R-TB-03 | 残るリスクとして、`push`は`main`だけで動くので、PRを作るまで、人がpushしたブランチのコミットはCIで走査されない。実行されるのはlefthookのpre-commitのgitleaksだけで、ローカルで飛ばせる。PRを作ればCIが走査し、Factoryは実装ブランチのpushの前に走査するので、受け入れる。 | [CIで走査されないコミット](security.md#ciで走査されないコミット) |

### CIの実行の範囲の判定

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-04"></a>R-TB-04 | 残るリスクとして、PRの実行の判定は、PRの版の`scripts/ci-scope.ts`で行う。判定を書き換える変更は、保護パスとして`pr_fix`が止める。`implement`は止めず、記録して検査を省き、PRの「確認して欲しい点」に載せる。人が書いたPRは`ci.yml`も書き換えられるので、レビューで確かめる。 | [CIの実行の範囲の判定](security.md#ciの実行の範囲の判定) |

### worktreeの自動の片付け

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-05"></a>R-TB-05 | 許可済みの`mise run worktree:new`とWorktreeCreateフックから、確認なしで削除が起動する。手動の`--apply`にある確認の門を、自動の経路に限って外している。`--auto`を手で起動する入口は、許可リストに足さない。消えるのは、実行している`worktree-new.sh`と同じリポジトリのworktreeに限る。`origin/main`に入っていなくても、作ったまま独自のコミットが無く、別のrefがHEADのコミットを含む放置されたもの(`abandoned`)は消える。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-06"></a>R-TB-06 | エディタで開いているだけのworktreeは、cwdを持つプロセスが無いので、消えうる。`recent`が守るのは、直近120分以内に更新したファイルがあるときだけである。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-07"></a>R-TB-07 | subagentのBashのシェルは、コマンドを実行している間だけcwdを持つ。コマンドの合間は、`in use`に見えない。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-08"></a>R-TB-08 | 削除の途中で止まった、変更のあるworktreeは残り続ける。人が手で片付ける。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-09"></a>R-TB-09 | worktreeを作らない日は、自動の片付けが走らない。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-10"></a>R-TB-10 | 失敗の警告は標準エラーだけに出る。運用者に見えるかは、実機で確かめていない。当面は`log`を見る前提にする。確かめるには、`failures`を2以上にした状態で`worktree:new`を実行し、標準エラーを見る。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-11"></a>R-TB-11 | 再検査から削除までに、短い時間差がある。`lsof`を取り直して`git worktree remove`の直前に寄せているが、時間差はゼロではない。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-12"></a>R-TB-12 | 許可済みの`mise run worktree:new`とWorktreeCreateフックは、そのチェックアウトにある`worktree-prune.sh`を、確認なしの削除として起動する。編集中やレビュー前の版も、無人で走る。止める手段は、セッションの起動時に`WORKTREE_AUTO_PRUNE=0`をexportしておくことだけである。コマンドへの前置きは、許可の確認を求められる場合があるが、実際に求められるかは確かめていない。スクリプトを編集して許可済みのコマンドで実行する能力は、この機能の有無によらず持つので、新しい権限ではない。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-13"></a>R-TB-13 | 最上位の`.yomiyasu/`の下で、無視されたファイルとして出るものは、確認なしで消える。無視の元は問わない。中の`.gitignore`(`*`)は、置いたものを中身にかかわらず無視させる。yomiyasuが置く最終稿の写し(`exports/`)と入力の写し(`inputs/`)も消えるので、残したい原文と最終稿はworktreeの外に写す。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-14"></a>R-TB-14 | gitが入れ子のリポジトリと認めたものは、末尾が`/`の1行で出るので残す。認めないもの(bareのリポジトリ、指す先の無いgitfile)は消える。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-15"></a>R-TB-15 | `.yomiyasu`を`.git/info/exclude`やユーザーの除外の設定に足すと、中に`.gitignore`の無い`.yomiyasu/`も消える側に移る。足さない。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-16"></a>R-TB-16 | 既定の場所で`yomiyasu_check.py`を実行すると、`.gitignore`と`state.json`のどちらも無い既存の`.yomiyasu/`には、`.gitignore`(`*`)が足される。中のファイルは`??`から`!!`に変わり、`dirty`で残っていたものが消える側に移る。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |
| <a id="r-tb-17"></a>R-TB-17 | メインのcheckoutの`.yomiyasu/`は片付けの範囲外で、写しが溜まる。コミットには入らない。 | [worktreeの自動の片付け](security.md#worktreeの自動の片付け) |

### 状態の理由の区切り

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-18"></a>R-TB-18 | 残るリスクとして、Claudeは`blocked_reason`の全体を既知の理由と同じ文にできる。そのときは、その理由の訳文と次の操作が表示される。 | [状態の理由の区切り](security.md#状態の理由の区切り) |

### 自己更新の通知の状態

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-19"></a>R-TB-19 | stateを書けるWindmillの利用者は、`deployed_sha_mismatch`の通知を遅らせられる。`deployed_sha`を書ける者と同じ範囲である。 | [自己更新の通知の状態](security.md#自己更新の通知の状態) |
| <a id="r-tb-20"></a>R-TB-20 | `deployed_sha`を今のHEADに書き換えると、版が一致するので、自己更新もそれを反映済みとみなす。これは通知の仕組みより前からある性質である。 | [自己更新の通知の状態](security.md#自己更新の通知の状態) |
| <a id="r-tb-21"></a>R-TB-21 | `factory.deployments`に書けるDBの利用者は、`deployed_sha_mismatch`の通知を自動で解決する判定も動かせる。 | [自己更新の通知の状態](security.md#自己更新の通知の状態) |

### Factory自身のリポジトリの照合

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-22"></a>R-TB-22 | 照合の応答を読んでからfetchの接続までの短い間は、リポジトリが入れ替わる余地として残る。照合はcloneのロックの中で行うので、この間にロックの待ちは入らない。 | [Factory自身のリポジトリの照合](security.md#factory自身のリポジトリの照合) |
| <a id="r-tb-23"></a>R-TB-23 | `factory_repo_id`が未設定の間は、名前の再取得から守られない。未設定のときは、照合せず、通知も出さない。 | [Factory自身のリポジトリの照合](security.md#factory自身のリポジトリの照合) |
| <a id="r-tb-24"></a>R-TB-24 | `isRepoAllowed`は`factory_repo`を名前で許すので、自己改善の起票と候補への採用は名前のままである。 | [Factory自身のリポジトリの照合](security.md#factory自身のリポジトリの照合) |
| <a id="r-tb-25"></a>R-TB-25 | Consoleの配信物を取り込む処理と、ホストの`git pull`は、`factory_repo_id`を照合しない。 | [Factory自身のリポジトリの照合](security.md#factory自身のリポジトリの照合)、[Factory自身のリポジトリの数値IDを固定する](operations.md#factory自身のリポジトリの数値idを固定する) |
| <a id="r-tb-26"></a>R-TB-26 | 監査のスナップショットのworktreeが、self cloneに既にあるshaを取るfetchは、照合しない。 | [Factory自身のリポジトリの照合](security.md#factory自身のリポジトリの照合)、[Factory自身のリポジトリの数値IDを固定する](operations.md#factory自身のリポジトリの数値idを固定する) |

### オーナーの数値IDの照合

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-27"></a>R-TB-27 | `id`の無いオーナーは、名前だけで動く。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合)、[オーナーの数値IDを固定する](operations.md#オーナーの数値idを固定する) |
| <a id="r-tb-28"></a>R-TB-28 | dependabotを除く準備のステップ、フォームからのIssueの作成、Issue化の提案の承認は、処理の始めに照合する。Issue化の提案の却下だけは、判断を記録した後に照合する。照合の後に名前が入れ替わっても、その実行は検知しない。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |
| <a id="r-tb-29"></a>R-TB-29 | `allowed_labeler_ids`にIDを入れないアカウントは、名前だけで判定する。`allowed_labeler_logins`に古い名前が残ると、その名前を取得した人が、許可された付与者とPRの作成者になりうる。IDを入れたアカウントは、IDも一致するときだけ許可する。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |
| <a id="r-tb-30"></a>R-TB-30 | 保存済みの名前でGitHubを読み書きする処理は、ほかにもある。Issueの状態の確認と整理、承認後のIssueへのコメント、PRへの返信は、名前のままである。取り消された作業項目を再開する前の状態の確認と、要件定義を作り直す再実行の前の取り込みも、名前のままである。これらはcloneも検査コマンドの実行もしない。投稿の内容は、名前を取得した人の目に触れうる。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |
| <a id="r-tb-31"></a>R-TB-31 | 監視が無効の間の`watch_pr_ci`の回復は、オーナーの照合をせずに、名前でPRの状態とheadを読む。書き込みは、FactoryのDBと、Discordへの固定文に限る。DBへの書き込みは、行を戻すこと、行を`superseded`にすること、noticeを足すこと、noticeを解決することである。保留した失敗の通知として、noticeの登録と、通知した理由コードの記録も行う。通知の本文は、固定文と語彙のコードだけで作り、GitHubから読んだ文字列を入れない。GitHubへの書き込みも、Claudeへの入力も、cloneや検査コマンドの実行もしない。監視を有効に戻せば、照合が働く。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |
| <a id="r-tb-32"></a>R-TB-32 | 書き込みの直前の照合と書き込みの間は、入れ替わる余地として残る。実装のPR作成とラベル付与、PR修正の返信は、直前の照合の後にpushと続けて行うので、個別には照合しない。dependabotの終了処理も、所見の投稿の後のラベルの付与と、baseの読み直しの後のマージを、個別には照合しない。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |
| <a id="r-tb-33"></a>R-TB-33 | dependabotの準備は、照合からcloneまでの短い間が、入れ替わる余地として残る。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |
| <a id="r-tb-34"></a>R-TB-34 | `drawio_viewer_bump`は、`factory_repo_id`があれば、書き込みの直前の照合で止まる。残る余地は、照合からブランチの作成までの間だけである。`factory_repo_id`が未設定のときは照合せず、名前だけでブランチとPRを作る。送る内容は公開物である。 | [オーナーの数値IDの照合](security.md#オーナーの数値idの照合) |

### mainの保護とリポジトリの公開

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-35"></a>R-TB-35 | PATが`main`へのマージの権限を持つかは確かめていない。承認が0件なので、PATで開いたPRを人の確認なしにマージできるかも確かめていない。どちらも確かめるまでは、残るリスクとして扱う。 | [mainの保護とリポジトリの公開](security.md#mainの保護とリポジトリの公開) |

### 依存の脆弱性

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-tb-36"></a>R-TB-36 | ルートの`bun audit`の指摘のうち、修正版が無いものは受け入れる。ルートの依存は開発用だけで、本番のコードが読まないためである。 | [依存の脆弱性](security.md#依存の脆弱性) |

## 資格情報の取得

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-cred-01"></a>R-CRED-01 | 記録が古い明示でないリポジトリの人のPRは、収集の鮮度の監視が通知するまで見つからず、`gh_repos`に行が無い明示でないリポジトリの人のPRは、通知なしに見送る。第三者が1000件超のPRで一覧を読む明示リポジトリを埋めると、5分ごとに10ページを読み続け、他のフローと共有するPATのrate limitの枠を、1リポジトリにつき1時間で約120リクエスト使う。第三者が埋める経路が当たる条件は、対象のリポジトリが明示リポジトリで、公開されていることなので、受け入れる。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-02"></a>R-CRED-02 | Actions: Read-onlyの権限は選んだ全リポジトリの実行のログとartifactも読め、`github_token`はConsole用workerも読むので、漏れたときの影響は、Contentsの読み書きに加えて、ログとartifactを読まれる分だけ広がる。ログとartifactには秘密値を入れない。漏れたときの影響が広がる分は、残るリスクとして受け入れる。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-03"></a>R-CRED-03 | 残るリスクとして、トレーラーはcommit本文の照合なので、リポジトリへ書ける人は偽れる。偽ったcommitだけのPRは、「Factoryが作ったPR」として自動で直す対象になりうる。対象のPRは、PATのアカウントが作った、Factoryのブランチの形のPRに限る。書き込める人は、ほかの手段でも同じPRを書き換えられるので、受け入れる。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-04"></a>R-CRED-04 | 残るリスクとして、第三者が1000件超のPRで、REST一覧を読むリポジトリを埋めることがある。このとき5分ごとに10ページを読み続け、他のフローと共有するPATのrate limitの枠を、1リポジトリにつき1時間で約120リクエスト使う。1回の実行に、1リポジトリ10ページ、予算120秒、rate limitでの停止という上限がある。条件は、対象のリポジトリが作業項目、競合の行、明示リポジトリのどれかに入り、公開されていることで、1回の実行にこの上限があるので、受け入れる。 | [GitHubのPAT](security.md#githubのpat)、[限界](internals/pr-ci.md#限界) |
| <a id="r-cred-05"></a>R-CRED-05 | 残るリスクとして、次のPRを拾えなくなる。作業項目も競合の行も無く、表も古い、明示でないリポジトリにあるFactoryのPRである。読めない間は、収集の鮮度の監視が通知するまで、知らせずに見送る。検索へ戻す設定は無い。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-06"></a>R-CRED-06 | 人がIssueの末尾に書き足すと、目印が最後の行でなくなり、再試行のときに見つからず、Issueが重複して起票される。書き足せるのは、リポジトリのIssueを編集できる人に限る。受け入れる。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-07"></a>R-CRED-07 | 目印を偽造して、作成済みのIssueとして再利用させる経路があり、実際には付いていないラベルが付いた扱いになりうる。偽造できるのは、PATのアカウントとしてIssueを作る人と、書き込み権限のある協力者のIssueの書き換えに限る。PATのアカウントとしてIssueを作る経路は、運用者と、親のセッションが同じアカウントで`gh issue create`する経路、`manual_intake_create_issue`である。親のセッションの経路と`manual_intake_create_issue`には、信頼できない文が入りうるので、その文に目印が書かれると偽造になる。受け入れる。偽造できる人は、Factoryのリポジトリに書き込める人で、その人はIssueやPRを直接操作できるためである。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-08"></a>R-CRED-08 | 提案の作成の1時間前から承認までの間に、PATのアカウントが作ったIssueとPRが1000件を超えると、その提案の承認は通らない。承認は保留のまま残り、再度承認しても通らないので、却下して起票し直すしかない。受け入れる。長く保留した提案だけで起き、却下して起票し直せば復旧できるためである。 | [GitHubのPAT](security.md#githubのpat) |
| <a id="r-cred-10"></a>R-CRED-10 | 再試行の前にPATのアカウントが替わると、前のアカウントが作ったIssueは作成者で絞った一覧に出ず、取りこぼして重複して起票される。受け入れる。再試行の前にPATを替える運用は想定しないためである。 | [GitHubのPAT](security.md#githubのpat) |

## Consoleの配信

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-dlv-01"></a>R-DLV-01 | 許可リストと型付きの関数が防ぐのは、Console自身の誤りだけである。ConsoleのXSSや、運用者のCookieを持つ攻撃者は防げない。Cookieがあれば、許可リストの外のscriptも、Windmillのapiから直に呼べる。ログインのセッションの有効期間は30日で、Windmillの既定の3日より長い。運用者のブラウザが管理者のCookieを持つ時間も、そのぶん長い。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-02"></a>R-DLV-02 | 新規投入の冪等キーで止まらない再送(リロードの後、別のタブ、入力を変えたもの、キーを付けない直接のフロー実行、保持期間を過ぎたキー)では、Issue、作業項目、pipelineが重複しうる。承認を省く進め方でキーが変わる再送では、実装が二重に起動し、PRが重複しうる。損なわれるのは手間で、データと権限は損なわれない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-03"></a>R-DLV-03 | GitHubの一覧の反映の遅れや、取り直した試行の目印の探索の失敗で、新規投入のIssueが二重になりうる。`gh`がタイムアウトすると予約が10分残り、その間の同じキーの再送は`intake_key_in_flight`で失敗する。取り直しの前に探索する順にすると設計が変わるので、受け入れる。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-04"></a>R-DLV-04 | 承認の二重の送信を画面で止められるのは送信した同じタブの中だけで、Issue提案のIssue作成のやり直しが重なると、Issueが2件できうる。サーバーの承認依頼ごとの印が重なりを緩和するが、期限を超える処理と取り直した処理は、理論上は重なりうる。走査と作成が、Issueを作る処理の印の有効期間(15分)を超えて続く障害では、印を取り直した別の呼び出しと重なり、Issueが重複して起票されうる。受け入れる。 | [Consoleの配信](security.md#consoleの配信)、[GitHubのPAT](security.md#githubのpat) |
| <a id="r-dlv-05"></a>R-DLV-05 | `main`へのマージは、承認0件のPRで済む。PRの必須チェックは通る必要があるが、人のレビューは強制されない。FactoryのPATが`main`へマージできるか、人の確認なしにマージできるかは確かめていない([mainの保護とリポジトリの公開](security.md#mainの保護とリポジトリの公開))。そのため、マージされたコードは人のレビューを経ずに運用者のブラウザで動きうる。Consoleの変更のレビューは、Windmillの管理者権限を持つコードのレビューとして行う。保護パスの反映の承認は、Consoleの配信物(`console/`)を止めない([反映の承認](internals/deploy-approvals.md#反映の承認))。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-06"></a>R-DLV-06 | CIの組み立ての途中で動くもの(miseが入れるbunなどのツール、Viteのプラグインなどの依存)が侵害されると、出力が改ざんされうる。`digest`とマニフェストが保証するのは、GitHubのCIが作ったものであることまでである。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-07"></a>R-DLV-07 | `console-a11y`ジョブが使うPlaywrightのブラウザは、ハッシュで照合しないので、取得元かその通信が侵害されると、改ざんされたブラウザが動く。受け入れる理由は、このジョブが`contents: read`の権限だけを持ち、秘密値と配信物を扱わず、PRの実行だけで動くためである。 | [Consoleの配信](security.md#consoleの配信)、[CIの組み立て](internals/console/delivery.md#ciの組み立て) |
| <a id="r-dlv-08"></a>R-DLV-08 | e2eの依存(`@playwright/test`、`@axe-core/playwright`、`axe-core`)は、`console/package.json`にある。そのため、配信するジョブ(`console-dist.yml`と`ci.yml`の`console`ジョブ)の`node_modules`に入る。インストールは`--ignore-scripts`で行うので、install scriptは動かない。`vite build`はこの3つを読み込まないので、配布物には入らない。別の`package.json`に分けると、lockfileの検査とdependabotの設定が二重になる。そのため、分けない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-09"></a>R-DLV-09 | 信頼の境界は`console-dist.yml`の1つのジョブと、そこで動くツールや依存に及ぶ。`ci.yml`のジョブは同名の成果物を上げても、取り込み先の実行(`console-dist.yml`)に入らない。組み立ての手順は`console-dist.yml`に直接書き、composite actionに分けない。`console-dist.yml`を書き換える変更は、`main`へのマージで反映されるので、マージ前のレビューが唯一の防御である。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-10"></a>R-DLV-10 | 同じ実行の中では、成果物を`overwrite: true`で上げ、`console_fetcher`はその名前の`id`が最大の成果物を取り込む。`console-dist.yml`のジョブは1つなので、同じ実行にほかの上げ手はいない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-11"></a>R-DLV-11 | `console-dist.yml`の成功が示すのは、組み立てが通ったことだけである。型検査、lint、テストを担う`ci.yml`の成功も、同じcommitについて取り込みの条件にする。`ci.yml`が実行中のcommitは、成功するまで取り込まない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-12"></a>R-DLV-12 | `main`という名前のタグの実行は、ブランチ名が`main`で現れる。`console_fetcher`は同じcommitで、`console-dist.yml`と`ci.yml`のどちらも`main`へのpushとして成功していることを求める。FactoryのPATはWorkflowsの権限が無く、ワークフローのファイルを書き換えたcommitを作れない。現在のワークフローは`main`のブランチのpushでしか動かないので、PATによるタグでは実行が作られない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-13"></a>R-DLV-13 | 両方のワークフローを書き換えたcommitに`main`というタグを付けられる人は、`console_fetcher`の、同じcommitで`console-dist.yml`と`ci.yml`のどちらも`main`へのpushとして成功していることの照合を通せる。タグの作成と更新は、rulesetの`protect-tags`で管理者に限っている。管理者は迂回できるので、管理者のアカウントの侵害は防げない。取り込むcommitが`main`の履歴に含まれるかは、確かめていない。 | [Consoleの配信](security.md#consoleの配信)、[取り込みの検証](internals/console/delivery.md#取り込みの検証) |
| <a id="r-dlv-14"></a>R-DLV-14 | draw.ioのビューアも、`console-dist`の成果物の差し替えの範囲に入る。ビューアは`console-dist.yml`が取得して、同じ成果物に入れるためである。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-15"></a>R-DLV-15 | `Sec-Fetch-Site`をブラウザが送るのは、信頼できるオリジン(localhostかHTTPS)のときだけである。`WM_BIND`を外向きにしてHTTPで公開すると、この防御は効かない。外向きにするならHTTPSで公開する。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-16"></a>R-DLV-16 | `Origin`の検査が比べる相手は、要求の`Host`ヘッダーから作ったオリジンである。DNSリバインディングで`Host`が攻撃者のホスト名になると、`Origin`も一致して通る。ただしCookieはホスト名ごとに付くので、運用者のCookieは付かない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-17"></a>R-DLV-17 | `Origin`の検査が補えるのは、GETとHEAD以外のブラウザの要求だけである。ナビゲーションや`<img>`のGETには`Origin`が付かず、Firefox 70未満はフォームのPOSTにも付けない。この検査は、HTTPで公開してもブラウザが送るので、`Sec-Fetch-Site`の弱点を補う。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-18"></a>R-DLV-18 | スキームを問わず許すので、HTTPS公開のときも、同じホスト名とポートの`http://`の`Origin`が通る。`Sec-Fetch-*`を送るブラウザは、`Sec-Fetch-Site`の規則が止める。止められないのは、`Sec-Fetch-*`を送らないブラウザだけである。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-19"></a>R-DLV-19 | GETでも副作用のあるAPIは、`Sec-Fetch-Site`と`Origin`では止まらない。同じオリジンの`<img>`やリンクから、Cookieの持ち主の権限でジョブを起動できる。そのため、副作用のあるGETの経路を洗い出し、fetchとXHR以外を403にしている。洗い出しの一覧は[Consoleの配信の仕様の「副作用のあるGET」](internals/console/delivery.md#副作用のあるget)にある。洗い出したのは`windmill-client`の型定義にあるAPIまでで、サーバーの全経路ではない。HTTPトリガー(`/api/r/*`)を足すときは、GETでジョブを起動する経路にならないかを確かめる。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-20"></a>R-DLV-20 | 古いブラウザと、HTTPで公開したブラウザは、`Sec-Fetch-Dest`を送らない。`Sec-Fetch-*`は、localhostかHTTPSのオリジンにだけ付くためである。この場合、副作用のあるGETは`Cookie`を持つときだけ止める。WindmillのフロントエンドがこれらのGETを使うと、その環境では403になる。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-21"></a>R-DLV-21 | 注入された`<form method="post">`のクリックは、`Sec-Fetch-Mode: navigate`で止める。`Sec-Fetch-Mode`を送らないブラウザは止めない。止めるとfetchの書き込みまで巻き込むためである。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-22"></a>R-DLV-22 | `<link rel="prefetch">`、`<link rel="preload">`、`<a ping>`は、`Sec-Fetch-Dest: empty`などで、副作用のあるGETを送りうる。どれも生のHTMLの注入が要り、サニタイザが落とすので、止めていない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-23"></a>R-DLV-23 | 他のサイトからAPIを呼ばせない4つの規則が効くのは`/api/*`だけである。`windmill_extra`の経路(`/ws/*`、`/ws_mp/*`、`/ws_debug/*`)には、`Origin`の検査も含めて効かない。`handle @extra`が先に当たるためである。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-24"></a>R-DLV-24 | 共有の`assets/`には古い版のファイルも残る。その間は`script-src`で読み込めるので、XSSの足がかり(script gadget)に使われうる。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-25"></a>R-DLV-25 | Trusted TypesのReport-Onlyの方針には報告先が無い。違反はブラウザの開発者ツールのコンソールにしか出ない。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-26"></a>R-DLV-26 | `console_fetcher`の外への通信はnetworkでは絞れない。コードが侵害されれば、任意の宛先へ出られる。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-27"></a>R-DLV-27 | `console_egress`は通常のbridgeで、ホストのloopbackから切り離されない。既定の`WM_BIND=127.0.0.1`のままでも、`host.docker.internal`経由でホストのCaddy、つまりWindmillに届く(OrbStackで確認)。`WM_BIND`を外向きにすると、ホストのゲートウェイのIP経由でも届く。`console_fetcher`はWindmillの資格情報を持たないが、認証の要らない経路には届く。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-28"></a>R-DLV-28 | `CONSOLE_GITHUB_TOKEN`は、ホストのdockerを使える人には`docker inspect`で見える。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-29"></a>R-DLV-29 | 成果物を取りに行くリポジトリ`CONSOLE_GITHUB_REPO`は、コミットされた`mise.toml`にある。これを書き換える変更がマージされると、任意のpublicリポジトリの成果物を取り込みうる。`mise.toml`は保護パスで、マージは人が行うことで抑えている。ただしPATのマージ権限は未確認である。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-30"></a>R-DLV-30 | 成果物の保持は30日である。30日以上`main`へのpushが無いと、新しく立ち上げた環境は取り込めない。そのときは`main`に何かをマージしてCIを動かす。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-31"></a>R-DLV-31 | 検証用サーバーを受け入れる理由は、マージ前の画面を本物のデータで確かめないと、画面のレビューが差し替えたデータだけに頼るためである。読み取りの5つが読み取り専用であることは、相対importで辿るファイルと、取り込む名前と、呼ぶ関数の本文をテストで固定して守る。ブランチ版のConsoleは、読み取りのscriptが返す内容を読む。これが残るリスクである。内容は、運用者が今の画面で読める範囲に限られる。ログと結果の伏せ字は、script側で行っている。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-32"></a>R-DLV-32 | 検証用サーバーは、検証をする人のマシンで動く。`--allow-writes`を付けた人は、マージ前のコードに書き込みを許す。付けるかどうかは、人の判断に任せ、`mise.toml`のタスクは付けない。agentが確認なしに付けられないよう、標準入力が端末でなければ起動に失敗させ、端末では「yes」の入力を求める。有効な間は、全応答に`x-branch-server-writes: on`を付ける。 | [Consoleの配信](security.md#consoleの配信) |
| <a id="r-dlv-33"></a>R-DLV-33 | 許可リストにある`/api/`のGETは、WindmillのUIの経路の一部だけである。Windmillの画面が許可リスト外のGETを使うと、ブランチ版のConsoleから開いた画面の一部が403になる。その場合は、8080で直接開く。 | [Consoleの配信](security.md#consoleの配信) |

## バックアップの控え

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-bak-01"></a>R-BAK-01 | `db_backup_url`は秘密の変数で、ワークスペースのどのscriptも読める。defaultのworkerのジョブはrootで動き、workerの環境変数`DATABASE_URL`からも同じ接続先に届くので、新しい経路ではない。 | [バックアップの控え](security.md#バックアップの控え) |
| <a id="r-bak-02"></a>R-BAK-02 | 控えは暗号化しない。控えの容量も監視しない。 | [バックアップの控え](security.md#バックアップの控え) |
| <a id="r-bak-03"></a>R-BAK-03 | `mise run backup:restore`は、クラスタ全体の複製を、使い捨てのプロジェクトの`factory-restore_*`のvolumeに残す。複製は、Windmillの秘密を復号する鍵を含む。`db`は`restart: unless-stopped`で動き続け、人が最後に出る`down -v`のコマンドを実行するまで残る。残っていることを追う仕組みはない。 | [バックアップの控え](security.md#バックアップの控え) |

## 定期ジョブ用workerの境界

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-per-01"></a>R-PER-01 | 書き込み権限を持つfine-grained PATを、読み取り用として入れても、`bootstrap.sh`は見分けられない。見るのは、`github_pat_`の接頭辞と、`GITHUB_TOKEN`と`CONSOLE_GITHUB_TOKEN`との一致だけである。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-02"></a>R-PER-02 | 「All repositories」のトークンは、所有者の全リポジトリの内容を読める。集める範囲は設定で絞るが、トークンの読める範囲は絞られない。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-03"></a>R-PER-03 | 全部の所有者のトークンを、所有者ごとに分けずに1つの変数に置く。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-04"></a>R-PER-04 | `repo_allowlist`が空のとき、見えないリポジトリを`not_visible`として検出できない。反映後に、人が件数を確かめる([収集の運用](operations/collect.md#収集の運用))。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-05"></a>R-PER-05 | loginに`_`を含む所有者(EMUのアカウント)は集めない。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-06"></a>R-PER-06 | 先頭が`.`のリポジトリ名(`.github`など)は、収集から漏れる。GitHubの名前の述語は、シェルとパスに渡す名前の守りと共通なので、収集のために緩めると、その守りも緩む。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-07"></a>R-PER-07 | 締め切りやGitHubの失敗が続くと、リポジトリの状態が前回のまま凍る。`gone`の行は消えない。 | [既知の限界](internals/github-collect.md#既知の限界)、[定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-08"></a>R-PER-08 | 詳細の行のブランチ名と作者は、forkのPRを含めて、外の人が決められる。収集は、書くときと読むときに形を検査し、通らない値を`NULL`にする。下流は、DBの値だけでGitHubへ作用する操作に進まない([下流が守る不変条件](internals/github-collect.md#下流が守る不変条件))。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-09"></a>R-PER-09 | 開いたPRが90件を超えるリポジトリは、詳細が打ち切られ続ける。公開リポジトリでは、外の人がPRを開けて、そのリポジトリの詳細を古いままにできる。打ち切りや失敗のリポジトリの古い行は、`usable`が真のまま残る。最初に詳細の行を読む処理には、閾値で判断を止める判定が要る([下流が守る不変条件](internals/github-collect.md#下流が守る不変条件))。 | [読む側の判定](internals/github-collect.md#読む側の判定)、[定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-10"></a>R-PER-10 | `poll_issues`は、明示でないリポジトリの記録が古い間、そのリポジトリのIssueを見つけない。鮮度の監視が通知するまでの時間は、黙って見送る。最大の時間は[GitHubの収集](internals/github-collect.md#鮮度の足りないリポジトリ)にある。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-11"></a>R-PER-11 | `poll_issues`が検索を使わないので、発見の経路を設定だけで検索へ戻す手段は無い。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-12"></a>R-PER-12 | `poll_issues`が明示リポジトリを一覧で読むとき、トリガーラベルの付いた開いたIssueとPRが合わせて1000件を超えると、一覧が失敗し続ける。トリガーラベルはIssueフォームに設定しない方針なので、外の人が埋めるのは難しい。失敗は`list_labeled_issues`の段に残る。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-13"></a>R-PER-13 | `poll_prs`は、明示でないリポジトリの記録が古い間、そのリポジトリのPRを見つけない。鮮度の監視が通知するまでの時間は、黙って見送る。最大の時間は[GitHubの収集](internals/github-collect.md#鮮度の足りないリポジトリ)にある。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-14"></a>R-PER-14 | `poll_prs`が検索を使わないので、発見の経路を設定だけで検索へ戻す手段は無い。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-15"></a>R-PER-15 | `poll_prs`が明示リポジトリを一覧で読むとき、開いたPRが1000件を超えると、一覧が失敗し続ける。公開リポジトリでは、外の人がforkからPRを開けて、一覧を失敗させ続けられる。失敗は`list_open_prs`の段に残り、通知は出ない。記録が新しい間は表から読むので、一覧に当たるのは、収集が止まっている間と、収集が集めない明示リポジトリである。開いたPRが90件を超えて収集が打ち切られている明示リポジトリも、一覧に当たる。外の人が自分でそこへ到達できるので、1000件を超えると、通知なしに失敗が続く。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-16"></a>R-PER-16 | `poll_prs`は、組織の所有者のPRのチーム宛てのレビューの依頼を、`GET /user/teams`のチームの数値IDで照合する。チームへの依頼は、作者が許可された人のPRだけ、候補にする。個人の所有者のリポジトリには、チーム宛ての依頼が付かないので、現在の構成では起きない。個人の所有者の行は、直接の依頼だけで判定される。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-17"></a>R-PER-17 | 組織の所有者で`GET /user/teams`を使えない間は、チーム宛てだけの依頼のレビューが起動しない。通知は出ず、組織ごとの固定の文の失敗が、`job_failures`に毎周回残る。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-18"></a>R-PER-18 | `poll_prs`がチームを使えて照合の結果対象でなかったPRを1時間は確かめ直さないので、別のチームの依頼、依頼されたチームへのPATのアカウントの追加、直接の依頼の追加、作者の許可の追加に、最大で1時間気づかない。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-19"></a>R-PER-19 | `poll_prs`は、stateを書けない間、チームへの依頼の確認を毎周回先頭から選ぶ。先頭の候補が枠を使うので、後ろの候補を確かめられないことがある。 | [既知の限界](internals/github-collect.md#既知の限界)、[定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-20"></a>R-PER-20 | `poll_prs`は、チーム宛ての確認が要る行を、1周回に20件までRESTで確かめる。超えた分は、結果の`team_capped`に出る。前の周回の続きから選ぶので、次の周回以降に確かめられる。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-21"></a>R-PER-21 | 許可されていない作者のPRも、1周回20件のチーム宛ての確認の枠を使う。外の人がheadを変え続けると、許可された作者のチーム依頼の確認が数周回遅れうる。止まらない。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |
| <a id="r-per-22"></a>R-PER-22 | `listPrReviews`と`listPrReviewComments`にはページの上限が無い。許可された作者のPRや直接の依頼のPRに、外の人がコメントを増やせる経路は、以前からある。この変更の範囲外の記録である。 | [定期ジョブ用workerの境界](security.md#定期ジョブ用workerの境界) |

## 自己更新の打ち切り

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-upd-01"></a>R-UPD-01 | Windmillが全体の上限でジョブを打ち切るときに、子プロセスが止まるかを確かめていない。子(`wmill sync push`、`wmill datatable migrate up`、git)は別のセッションで起動する。子の上限はworkerの中のタイマーなので、ジョブごと止まると子は上限なしで残りうる。打ち切りが子の実行中に当たるのは、内側の上限が働く前に全体の上限に達したときだけである。区切った呼び出しが30秒で終わるので、通常は当たらない。 | [自己更新の打ち切り](security.md#自己更新の打ち切り) |
| <a id="r-upd-02"></a>R-UPD-02 | 残った`wmill sync push`が、次の回が更新する作業ツリーを読み続けると、新旧の混ざった内容をpushしうる。子が残る条件と頻度は[R-UPD-01](#r-upd-01)にある。作業ツリーのロックは、cloneの更新の間しか取らず、pushの間は守らない。 | [自己更新の打ち切り](security.md#自己更新の打ち切り) |
| <a id="r-upd-03"></a>R-UPD-03 | 残った`wmill datatable migrate up`が、次の回の同じ処理と並行しうる。子が残る条件と頻度は[R-UPD-01](#r-upd-01)にある。 | [自己更新の打ち切り](security.md#自己更新の打ち切り) |
| <a id="r-upd-04"></a>R-UPD-04 | `self_update`の成功の行の記録が失敗したときは、`deployments`に行が残らない履歴の欠落を受け入れる。 | [自己更新](architecture.md#自己更新) |

## Claude Codeの拒否ルール

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-deny-01"></a>R-DENY-01 | フックが`mise`で拒否するのは、[Claude Codeの拒否ルール](security.md#claude-codeの拒否ルール)で一覧を出す形として挙げた形にとどめる。許可リスト方式の全面化は採らず、層を新しく足さない縮小版にとどめて受け入れる。`mise`のサブコマンドを許可リストで絞って、一覧を出すあらゆる形を拒否することはしない。一覧を出す経路は列挙しきれないためである。許可リストを広げるほど、前置きのオプション、`mise run`のシェル指定、`MISE_*`の環境変数、`xargs`、書き込み先といった新しい迂回が見つかる。秘密値を会話に出さない設計にも広げず、会話への露出は残るリスクとして受け入れる。 | [Claude Codeの拒否ルール](security.md#claude-codeの拒否ルール) |
| <a id="r-deny-02"></a>R-DENY-02 | `mise`の一覧を出す経路で秘密値が会話に出る形(`mise -E local env`、`mise hook-env`など)が残る。会話への露出は、ベストエフォートのフックと前方一致の`deny`だけで守り、会話に出た値は、APIへ送られ、手元の記録にも残る。 | [Claude Codeの拒否ルール](security.md#claude-codeの拒否ルール) |

## Claude Codeのフック

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-hook-01"></a>R-HOOK-01 | Consoleの書き込みのscriptは、端末での人の確認を通らずに他の主体の保留を外せるので、`hold-guard.ts`が、1コマンドで呼ぶ形を、主セッションを含むすべてのセッションで拒否する。この判定はベストエフォートで、ハッシュでの呼び出し、パーセント符号化したパス、変数やファイルで組み立てた名前、名前が語にも標準入力にも現れない形などは止めない。これらの形は止められないので、残るリスクとして受け入れる。 | [Claude Codeのフック](security.md#claude-codeのフック)、[保留](internals/holds.md#保留) |
| <a id="r-hook-02"></a>R-HOOK-02 | `CHECK_IDLE_FORCE`の拒否は、変数名の組み立てと、スクリプトファイルを経由した代入を塞がない。 | [Claude Codeのフック](security.md#claude-codeのフック) |
| <a id="r-hook-03"></a>R-HOOK-03 | `CHECK_IDLE_FORCE`の拒否は、代入以外で変数を設定する組み込み(`read`、`printf -v`、`declare -n`)と、`set -a`に続く`source`を塞がない。 | [Claude Codeのフック](security.md#claude-codeのフック) |
| <a id="r-hook-04"></a>R-HOOK-04 | `CHECK_IDLE_FORCE`の拒否は、ブレース展開(`CHECK_IDLE_FORCE{,}=1`)を塞がない。 | [Claude Codeのフック](security.md#claude-codeのフック) |
| <a id="r-hook-05"></a>R-HOOK-05 | `CHECK_IDLE_FORCE`の拒否は、フックが外さない前置き(`stdbuf`、`caffeinate`、`bunx`、`npx cross-env`など)を塞がない。 | [Claude Codeのフック](security.md#claude-codeのフック) |
| <a id="r-hook-06"></a>R-HOOK-06 | `CHECK_IDLE_FORCE`の拒否は、標準入力から渡る値(`xargs`)を塞がない。 | [Claude Codeのフック](security.md#claude-codeのフック) |
| <a id="r-hook-07"></a>R-HOOK-07 | `CHECK_IDLE_FORCE`の拒否は、miseの設定ファイルへの書き込みと、`docker compose up`の直接実行を塞がない。 | [Claude Codeのフック](security.md#claude-codeのフック) |
| <a id="r-hook-08"></a>R-HOOK-08 | `CHECK_IDLE_FORCE`の拒否は、`mise set CHECK_IDLE_FORCE=1`による`mise.toml`の`[env]`への書き込みを塞がない。`mise.toml`は保護パスなので、差分はレビューされる。 | [Claude Codeのフック](security.md#claude-codeのフック) |

## ラベル付与の制限

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-lbl-01"></a>R-LBL-01 | 作成者が許可されたアカウントのPRに、書き込み権限のある共同作業者がpushすると、ラベル無しの再レビューが起動する。書き込み権限を持つ人は、信頼された共同作業者とみなす。Factory自身のpushは`setHeadSha`で記録されるので、起動しない。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-02"></a>R-LBL-02 | ラベルを付けた後から、いずれかの却下までの間に、起票者がIssueの本文を編集できる。取得の時点の本文が`work_items.body`に保存されるので、取得までの編集は要件定義の入力になる。却下や再実行による作り直しでは、その時点のIssueの内容が取り込み直されるので、窓は取得までから、却下までに広がる。起票者を信頼せず、ラベルを付ける人が内容を確かめる前提は、却下を挟むと弱まる。更新を承認者に知らせる通知(Discordとnotice)、Consoleの承認画面の警告、PR本文の注記で緩和している。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-03"></a>R-LBL-03 | 却下の理由が`intake refreshed from the current issue`で始まると、更新していなくても、取り込み直しの印として数えられ、警告とPR本文の注記が出る。警告が増える方向だけの誤りなので、許容する。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-04"></a>R-LBL-04 | 起票者がIssueを書き換え続けると、承認を止め続けられる。書き換えのたびに承認が断られ、却下で作り直すとClaudeの実行と試行が1回ずつ減り、`max_attempts`に達すると人の対応待ちになる。起票者を信頼できないリポジトリ、特に公開リポジトリを対象とする前には、ラベルを付けた後のIssueをロックし、編集を止める運用を決める。Issueの「Lock conversation」が起票者の本文の編集を止めるかは未確認である。採用の前に確かめる。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-05"></a>R-LBL-05 | 確認からラベルを外すまでの窓は数百ミリ秒である。付け直しを成功させるには、狙ったタイミングが要る。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-06"></a>R-LBL-06 | 書き込み権限のある人がラベルを改名すると、過去の付与が現在のトリガーラベルの付与として数えられる。書き込み権限を持つ人は、元から信頼する前提である。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-07"></a>R-LBL-07 | ラベルを付け外しできる権限で動く自動化が、第三者の入力に応じてイベントを積むと、判定不能が続く。判定不能は拒否に倒れるので、作業は始まらない。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-08"></a>R-LBL-08 | 拒否したトリガーラベルはPRに残る。人がラベルを外すまで、そのPRはラベルを介さないレビューの自動検出も止まる。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-09"></a>R-LBL-09 | Factory自身のPRで拒否したラベルのせいでサイクルが止まっても、気づく手段は「情報」のnoticeだけである。人がラベルを外すと、サイクルが再開する。 | [ラベル付与の制限](security.md#ラベル付与の制限) |
| <a id="r-lbl-10"></a>R-LBL-10 | `labeler_denied`のnoticeは、運用者が確かめないまま解決済みになることがある。情報のnoticeがConsoleに出る7日の間に、許可された人がラベルを付け直してIssueかPRを取得すると、同じ対象の未解決のnoticeが解決済みになる。Consoleからは解決できない種類だが、人の介在を減らすため、この自動の解決を受け入れる。 | [付与者の確認](security.md#付与者の確認) |

## 閉じた人の確認

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-cls-01"></a>R-CLS-01 | PRのheadブランチやforkを消してPRが閉じたときの`closed_by`は、実機で確かめる。作者と別のアカウントが消すと、作者以外の人が閉じた扱いで取り消されうる。 | [閉じた人の確認](security.md#閉じた人の確認) |
| <a id="r-cls-02"></a>R-CLS-02 | 人のアカウント(`type`が`User`)のPATで閉じる自動化は、Botとして扱われない。作者と別のアカウントなら、作者以外の人が閉じた扱いになり、取り消される。第三者のイベントで閉じる自動化は、`GITHUB_TOKEN`かGitHub Appのinstallation tokenで動かす。 | [閉じた人の確認](security.md#閉じた人の確認) |
| <a id="r-cls-03"></a>R-CLS-03 | 判定は、要対応の一覧の取り消しにだけかかる。承認待ちなど終端でない作業項目は、既存のreconcileが閉じた人を確かめずに取り消す。 | [閉じた人の確認](security.md#閉じた人の確認) |

## ホストの実行役の境界

### 承認の門の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-host-01"></a>R-HOST-01 | 同じホストユーザーのプロセスは、`approved.json`を直接書ける。ファイルの権限では防げない。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-02"></a>R-HOST-02 | agentが環境変数を消し、疑似端末で文言を入力すれば、`approve`を通せる。起動を拒否ルールで止めるかは、運用者の判断である。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-03"></a>R-HOST-03 | 書き換えた側がコードの出どころの検査を迂回する経路は、Bunの読み込みの設定、gitの挙動と設定、`origin/main`のref、承認する版そのものになりうる`HEAD`、`mise activate`を使うシェルの環境である。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-04"></a>R-HOST-04 | 承認の表示を作るコードの変更は、`origin/main`へのマージ時の人のレビューにだけ守られる。mainへは承認0件でマージできる。Windmillへの反映の承認は、ホストの実行役のコードを止めない([反映の承認](internals/deploy-approvals.md#反映の承認))。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-05"></a>R-HOST-05 | 許可した日本語の文字の中にある同形異字は、検出しない。ASCIIの記号に似る`一`、`ー`、`〜`は、許可した文字なので通る。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-06"></a>R-HOST-06 | `origin/main`のrefは、人が`git fetch`で更新する。古い参照は拒否側に倒れる。偽の参照は、表示した先端のshaをGitHubと照合して見分ける。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-07"></a>R-HOST-07 | 適用済みのshaは人が入力する。実際の適用済みと一致しない記録は`plan`が使わない。ただし、これは「実際の適用済み」を偽造できない出どころから得たときだけ成り立つ。共有ボリュームの印はworkerが偽造できるので、`--applied`はホストのcheckoutの履歴で確かめる。ホストの状態ディレクトリ(0700)に適用済みのshaを書き、`approve`と`plan`がそれを読む形は、後続の段階である。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-08"></a>R-HOST-08 | `plan --approved`は、承認の`applied`を照合しない。自動の経路は`plan --state-dir`だけを使う。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-09"></a>R-HOST-09 | ページ送りは論理行単位である。1行が極端に長い入力は、画面の外へ流れる。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-10"></a>R-HOST-10 | パスが`-`で始まる承認の対象は、gitの引数に渡せないので、`approve`が終了コード1で止まる。 | [承認の門](internals/host-apply.md#承認の門) |
| <a id="r-host-11"></a>R-HOST-11 | 承認は1回に1件で、前の記録を置き換える。 | [承認の門](internals/host-apply.md#承認の門) |

### 置き場の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-host-12"></a>R-HOST-12 | 同じホストユーザーのプロセスは、置き場のファイルを直接書ける。0700が防ぐのは、他のユーザーとworkerのコンテナである。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-13"></a>R-HOST-13 | 排水の記録の読み書きの競合と、状態ファイルを新しく作るときの「無いときだけ」の確認から書くまでの競合は、ロックを持つ書き手だけが書くことで防ぐ。ロックが防ぐのはプロセスの間だけである。プロセスの中の書き手は、1つに直列化する(実行役の本体の規則)。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-14"></a>R-HOST-14 | フェンスは、書く直前の`lock`の実体の照合までを確かめる。同じホストユーザーのプロセスが`lock`を消す・差し替えると、排他を割れる。dockerの操作はフェンスの外にあり、照合の後の差し替えは次の書き込みまで検出できない。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-15"></a>R-HOST-15 | ロックは置き場ごとである。dockerのスタックはホストに1つなので、別の`--state-dir`で動く実行役は別のロックを取れる。dockerを操作するサブコマンドは、既定の置き場だけを受ける(実行役の本体の規則)。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-16"></a>R-HOST-16 | 本物の孤児は、控えに残る限り`orphan_alive`で止める。pgidの再利用は区間の照合で除くが、先頭が抜けた別のグループ、`setsid`で別のグループへ逃げた孫、子を控える前のSIGKILLは守れない。人が確かめて、`resetOwnerRecord`の`discard`で外す。生きた本物を名指しすれば、孤児と並んで実行役が動く。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-17"></a>R-HOST-17 | 電源断で`lock`の本文が壊れると、`owner_unreadable`で止まる。`resetOwnerRecord`で戻す。通常のファイルでない、他者の所有、緩い権限、リンクの複数化、symlinkの`lock`は`unsafe`で止まり、記録の復旧では直らない。実行役が動いていないことを確かめたうえで、人がそのパスの実体だけを除き、`init`で作り直す。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-18"></a>R-HOST-18 | `lock`のopenと置き場の照合の間に、置き場をsymlinkへ差し替えて戻されると、置き場の外のファイルに記録を書かれる。差し替えられるのは、親を書ける同じホストユーザーに限る。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-19"></a>R-HOST-19 | 孤児の検査の間(実行役の本体では`ps`の起動を含む)に`lock`の実体が替わるのは、書く前の照合で検出する。照合の後の差し替えは、次の書き込みまで検出できない。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-20"></a>R-HOST-20 | ロックの有効性の検査は、同じプロセスの中の2回目のopenが`EAGAIN`になることまでである。CIはLinuxなので、カーネルのロックを使うテストはdarwinだけで動く。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-21"></a>R-HOST-21 | スタックの照合は、呼び出し側が渡す関数で、`state_io.ts`は中身を確かめられない。渡せるのは実行役のコードだけで、コードの出どころの検査が守る。ただし、正当なコードの誤りは防げない。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-22"></a>R-HOST-22 | 同じホストユーザーのプロセスは、`state.json`の`applied_sha`を書き換えられる。これで承認の差の基準をずらせる。`approved.json`を直接書ける場合と同じ扱いである。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-23"></a>R-HOST-23 | コンテナから状態の置き場を守るのは、0700ではなく、置き場をマウントしないことである。Docker Desktop for Macのbind mountでは、コンテナが書いたファイルはホストのユーザーの所有に見える。所有者と権限の検査では区別できない。`--state-dir`は、共有の場所やbind mountの下に置かない。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-24"></a>R-HOST-24 | 契約テストは字句の検査である。文字列の連結は検出できない。レビューが守る。`node:fs`を使えるモジュールは、閉じた一覧(`code_origin.ts`、`lock.ts`、`secure_file.ts`)で固定する。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-25"></a>R-HOST-25 | 状態ファイルが読めないとき(`state_unreadable`)は、`createState`と`reinit`のどちらも使えない。人が壊れたファイルを退避して初期化する。手順は、初期化を足す段階で`docs/operations/deploy.md`に書く。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-26"></a>R-HOST-26 | 親のディレクトリの鎖とACLは検査しない。`--state-dir`は、本人だけが書ける親の下に置く。 | [状態の置き場](internals/host-apply.md#状態の置き場) |
| <a id="r-host-27"></a>R-HOST-27 | 置き場の検査から開くまでの間に、パスを差し替えられる隙がある。差し替えられるのは、親を書ける同じホストユーザーに限る。 | [状態の置き場](internals/host-apply.md#状態の置き場) |

### 外部コマンドの残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-host-28"></a>R-HOST-28 | 実行口の検査は、実行役のコード自身が行う。同じユーザーのプロセスが実行役のコードを書き換えれば、迂回できる。コードの出どころの検査が守る。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-29"></a>R-HOST-29 | 本番の`command.ts`が、検査を飛ばす入口をexportする。守りは、別の登録簿と契約テストである。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-30"></a>R-HOST-30 | 取得先のURLの照合は、`url.<base>.insteadOf`、URLごとの`http.<url>.*`、`include`を見ない。リポジトリの置き場は0700だが、同じユーザーのプロセスは書き換えられる。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-31"></a>R-HOST-31 | トークンは環境に入る。同じユーザーのプロセスは、`ps eww`で読める。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-32"></a>R-HOST-32 | `ps`の開始時刻は秒単位である。同じ秒の内にpidが再利用されると、区別できない。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-33"></a>R-HOST-33 | 子は別のプロセスグループで動くので、`plan`と`approve`のgitは、端末のCtrl-Cを受けない。読み取りだけなので害は無い。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-34"></a>R-HOST-34 | 終了を見た後にグループを止めるとき、別のグループが同じpgidを得ていると、無関係なグループを止めうる。グループが空になった後にだけ起きる、狭い競合である。標準出力の溢れでプロセスを止める経路も、終了を見た後に止める窓を持つ。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-35"></a>R-HOST-35 | `setsid`で別のグループに移った孫は、止められない。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-36"></a>R-HOST-36 | `Bun.spawn`の`detached`の挙動は、Bunの版に依る。実際のプロセスのテストが検知する。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-37"></a>R-HOST-37 | `GIT_NO_LAZY_FETCH`は、ホストのgitの版に依る。古いgitは無視する。読み取りの環境の空の`GIT_ALLOW_PROTOCOL`も、遅延取得を止める。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-38"></a>R-HOST-38 | リポジトリの設定の`http.*`のうち、検証、プロキシ、リダイレクトのURL別の指定と、名前解決の上書きだけを引数で固定する。`http.sslCAInfo`や`fetch.bundleURI`などは、取得の通信先や検証を変えうるが、止まらない。`url.<base>.insteadOf`と`include`を見ないことと同じく、置き場の0700に頼る。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-39"></a>R-HOST-39 | 取得先を別のホストへ向けられると、URLで照合する認証ヘッダー(`http.https://github.com/.extraHeader`)のトークンがそのホストへ送られうる。向ける手段は、リポジトリの設定の`http.sslCAInfo`と、名前解決の上書きの組である。名前解決の上書きは、引数の空の値で消えると、gitの文書にある。実機では確かめていない。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |
| <a id="r-host-40"></a>R-HOST-40 | リポジトリの設定の`remote.<取得先URL>.*`(`remote.<取得先URL>.proxy`など)が、`http.<URL>.*`を覆いうる。gitのソースからの推論で、実機では確かめていない。置き場の0700に頼る。 | [外部コマンドの許可表](internals/host-apply.md#外部コマンドの許可表) |

### ホストの実行役の境界の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-host-41"></a>R-HOST-41 | composeの検査は、YAMLを静的に読む。`docker compose config`の解釈とは突き合わせていない。解釈が食い違うと、許可した形が別の意味になりうる。食い違いうる書き方のうち、マージキー、YAMLのタグ、`\r`とUnicodeの改行は、文字があれば拒否する。重複したキーは、composeが失敗するので反映されない。複数の文書を書いたYAMLは、1つ目だけを検査して2つ目以降を見逃さないよう、拒否する。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-42"></a>R-HOST-42 | composeの`image`と環境変数の参照を表と照らした違反は、`plan`の判定に使っていないので、表の外のリポジトリや、表の外のサービスへの`DB_PASSWORD`の受け渡しは、`would_converge`と判定される。受け入れる理由は、実行役がまだ反映しないためである。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-43"></a>R-HOST-43 | 表が見るのは参照名とリポジトリ名だけである。タグが同じ名前の別のイメージを指す浮動タグは、見ない。`build`するサービスのDockerfileの`FROM`も、表の外である。守りは保護パスと人のマージだけである。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-44"></a>R-HOST-44 | 表のサービスの`environment`の値に、秘密値の参照を置くことは許す。値の残りは見ないので、`DATABASE_URL`のホストを外部に変えても、通常の参照として扱われる。後続の段階で、秘密値を運ぶ値の形を固定するか、許した参照を含むスカラーを承認の材料に入れるかを検討する。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-45"></a>R-HOST-45 | 表の秘密値の検出は、Bunが読んだ文字列の走査である。composeの補間の仕様が変わると、見逃しうる。補間した後の値を見る二重の検査は、`docker compose config`の出力が要るので、後続の段階に回す。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-46"></a>R-HOST-46 | ホストの秘密値を置くファイルを指すパスの拒否は、名前で判定する。ディレクトリのbindやcontextは、ルートを含みうる。`prod`の木にあるリンクがsymlinkで、コンテナの中では辿れないことに頼っている。ハードリンクやコピーに変えるときは、この規則を見直す。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-47"></a>R-HOST-47 | `bun.lock`は承認の対象ではないので、取得元の欄を承認なしで書き換えられる。実行役が`bun install`を呼ぶ段階を足すときは、`bun install --frozen-lockfile`の前に、`bun.lock`の取得元を検査するか、承認の対象にする。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-48"></a>R-HOST-48 | パスの検査は、文字列で行い、symlinkを辿らない。目標のtreeにsymlinkがあれば拒否するが、実行役が使うチェックアウトに後から置かれたsymlinkは見ない。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-49"></a>R-HOST-49 | miseの値の免除は、形式だけを見る。`GTR_COMMIT`の指す内容は確かめない。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-50"></a>R-HOST-50 | `plan`はCIを確認しない。`would_converge`は、CIの通過を含まない判定である。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-51"></a>R-HOST-51 | `mise run up`の許可は、自前でビルドした旧イメージの削除を含む。`mise run up`と`mise run deploy`は、終わりに`docker image prune -f --filter label=com.atelier-works.prune=true`を実行する。消えるのは、ラベルが付いた、タグの無いイメージだけで、他のイメージ、ボリューム、コンテナ、ビルドキャッシュには触れない。コマンドは固定で引数を受けないが、ラベルを付けるのは`infra/docker-compose.yml`の`build.labels`なので、守りは保護パスと人のマージである。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-52"></a>R-HOST-52 | 取得した浮動タグのイメージ(`postgres:18`など)の旧版と、ビルドキャッシュは、掃除の対象外である。ラベルを持たないイメージを、`mise run up`は消さないためである。ラベルを足す前にビルドした旧イメージと、ラベルを足した最初のビルドで置き換わる1つ前の版も、ラベルが無いので対象外である。ディスクを使い続けるので、増えたときは人が手で掃除する。 | [ホストの実行役の境界](internals/host-apply.md#ホストの実行役の境界) |
| <a id="r-host-56"></a>R-HOST-56 | workerを作り直す前の確認は、dry-runが作り直しを示さない変更を見逃す。イメージだけが変わる更新で、dry-runが`Recreate`を示すかは、確かめていない。示さなければ、workerは確認なしで作り直される。 | [workerを作り直す前の確認](operations/stages.md#workerを作り直す前の確認) |

### ホストの反映の印

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-host-53"></a>R-HOST-53 | defaultのworkerのジョブは、印を偽造できる。偽の印で、`host_action_required`を黙らせられる。影響は、ホストでの反映の遅れに気づけなくなるところまでである。突くには、defaultのworkerでのコード実行が要る。 | [ホストの反映の印](internals/host-apply.md#ホストの反映の印) |
| <a id="r-host-54"></a>R-HOST-54 | 印を`approve`の`--applied`の値に使うと、偽の印が承認の始点になる。実際の適用済みと違う始点で承認すると、人が見ていない変更を、記録が隠しうる。そのため、`--applied`の値は印から取らず、ホストのcheckoutの履歴で確かめる([変更を承認する](operations/deploy.md#変更を承認する))。印は照合にだけ使う。 | [ホストの反映の印](internals/host-apply.md#ホストの反映の印) |
| <a id="r-host-55"></a>R-HOST-55 | 印を書くホストの書き込み(`docker compose exec`)は、ジョブと同じ権限で動く。ホストのスクリプトが得る権限はジョブと同じで、権限は広がらない。 | [ホストの反映の印](internals/host-apply.md#ホストの反映の印) |

## Consoleの安全策

### ジョブのログと結果の読み取り

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-01"></a>R-CON-01 | 3つのscriptの`.script.lock`を書き換えて、依存の取得元を変えられる可能性がある。Windmillのbun workerがlockの取得元に従うかは、実機で確かめていない(未確認)。lockの差分は、レビューで確かめる。 | [ジョブのログと結果の読み取り](internals/console/security.md#ジョブのログと結果の読み取り) |

### PRレビューの投入

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-02"></a>R-CON-02 | `pr_review_intake`のフローを直接実行すると、`pr_review_submit`を通らず、操作の記録が残らない。実行できるのは、`f/factory`の権限を持つ管理者と、その資格情報で動くローカルのClaudeのセッションである。拒否フックが名前で止めるのは、`CONSOLE_WRITE_SCRIPTS`の書き込みのscriptだけで、フローと登録のステップは止めない。手動投入のフロー(`manual_intake`)と同じ性質である。`.claude/settings.json`の許可に`wmill`の実行系は無いので、実行には人の許可が要る。 | [PRレビューの投入](internals/console/security.md#prレビューの投入) |
| <a id="r-con-03"></a>R-CON-03 | 登録のステップの断りのうち、noticeに残るのは、fork headとオーナーのIDの食い違いだけである。そのほかは、ステップのジョブの結果として読む。 | [PRレビューの投入](internals/console/security.md#prレビューの投入) |
| <a id="r-con-04"></a>R-CON-04 | 一意インデックスを足すmigrationは、重なった古い`pr_review`を取り消す。`pr_review`はリースを使わず、止めるのは投稿の直前に作業項目が`reviewing`かを確かめる処理だけである。この確かめから投稿(`publishReview`)までの間に取り消しが割り込むと、取り消された行のレビューが投稿されうる。migrationは1回しか走らず、窓も短いので、受け入れる。 | [PRレビューの投入](internals/console/security.md#prレビューの投入)、[PRの発見](internals/pr-workflow.md#prの発見) |
| <a id="r-con-05"></a>R-CON-05 | 次の確かめは、綴りを区別したままである。`listActionableWorkItems`と`console_query.ts`の「より新しい行」の確かめ、`hasNonTerminalPrWorkItem`、`hasUnfinishedPrRun`、`pr_fix`側の`countPrFixFailures`、`restartStoppedWorkItem`、自動の再開である。綴りの違う行があると、引き継ぎ済みの古い`failed`の行が要対応の一覧に残る。人がそれを再実行すると、レビューが二重になりうる。閉じたPRのworktreeの掃除と、実装の準備の保護も、綴りの違う行を見落とす。後の2つは、自動で復旧する。 | [PRレビューの投入](internals/console/security.md#prレビューの投入) |
| <a id="r-con-06"></a>R-CON-06 | 投入の確認の後に、ラベルの経路が同じPRのレビューを始めた競合は、登録のステップの挿入が断る。人の依頼は失われない。ラベルの経路は、ラベルを付け直して次の巡回に任せる。 | [PRレビューの投入](internals/console/security.md#prレビューの投入) |

### ジョブの画面の描画

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-07"></a>R-CON-07 | 契約テストのソースの検査は、項目名と埋め込みの形を見る規則で、式を組み立てて渡す経路は捕まえられない。網羅テストも、テストが組み立てた項目だけを確かめる。そのため、項目や経路を足す変更は、無害化の入口を通していることを、レビューで差分から確かめる。 | [ジョブの画面の描画](internals/console/security.md#ジョブの画面の描画) |

### 設計書の読み返しの画面

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-08"></a>R-CON-08 | 承認が決着した後に、実装が受け取った文字を確かめる入口を、Consoleに置いていない。`approval_design_doc`のviewは、決着した依頼にも設計書を返せるが、画面から開く経路が無い。読み返しの画面が見せる文字は、実装が受け取った文字と一致するとは限らない。 | [設計書の読み返しの画面](internals/console/security.md#設計書の読み返しの画面) |
| <a id="r-con-09"></a>R-CON-09 | プレビューで読んだ人が、固定の注記を読み飛ばして、承認画面を開かずに判断すると、生のHTML(コメントを含む)とリンク参照定義と見えない文字と長さの違いに気づけない。Markdownの文字では、コメントとリンク参照定義が見えるが、見えない文字の表し方、改行と空白の扱い、長さの違いには気づけない。`<div>`に入れた文や、リンク参照定義のtitleに書いた命令は、プレビューに描かれないまま実装に渡る。8000字より後ろの部分は、読み返しの画面にだけ出て実装には渡らない。承認の操作は承認画面にしか無いので、承認の判断そのものは、承認画面の全文を通る。 | [設計書の読み返しの画面](internals/console/security.md#設計書の読み返しの画面) |

### 取り込み時点のIssueと提案の描画

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-10"></a>R-CON-10 | プレビューの確認のチェックは、自己申告である。読んだことは保証しない。既存の切り詰めの確認と同じ水準である。 | [取り込み時点のIssueと提案の描画](internals/console/security.md#取り込み時点のissueと提案の描画) |
| <a id="r-con-11"></a>R-CON-11 | チェックを強制する承認バー(`ApprovalBar.tsx`)と判定(`approvalDecision.ts`)は、保護パスに入れていない。日常的に直す部品なので、保護するとレビューが詰まる。部品のテストと画面のテストが、配線を固定する。 | [取り込み時点のIssueと提案の描画](internals/console/security.md#取り込み時点のissueと提案の描画) |
| <a id="r-con-12"></a>R-CON-12 | プレビューは、文字参照から戻した見えない文字と、向きの制御文字を、置き換えずに描くことがある。置き換えは、Markdownを解釈する前の文字に対して行うためである。プレビューを選んだ承認は、原文の確認を求める。原文は、解釈する前の文字列のまま見せる。 | [取り込み時点のIssueと提案の描画](internals/console/security.md#取り込み時点のissueと提案の描画) |
| <a id="r-con-13"></a>R-CON-13 | 元のIssueの本文が、保護していない`Markdown`を通る。安全の根拠は、`rehype-sanitize`のスキーマと、`rehype-raw`を使わないことである。この部品を直す変更は、保護パスでないので、レビューで確かめる。 | [取り込み時点のIssueと提案の描画](internals/console/security.md#取り込み時点のissueと提案の描画) |
| <a id="r-con-14"></a>R-CON-14 | 要件定義書や設計書の本文の画面のプレビューで読んでから、承認画面に来る経路は、プレビューを選んだ記録が立たない。承認画面の外の経路なので、取り込み時点のIssueの描画の守りでは防げない。 | [取り込み時点のIssueと提案の描画](internals/console/security.md#取り込み時点のissueと提案の描画) |
| <a id="r-con-15"></a>R-CON-15 | 設計の承認画面は、取り込み時点のIssueのパネルを共有する。パネルの`mode`を省略すると原文になるので、設計の承認画面は、変更なしで原文のままである。この既定を固定するテスト(`DesignReview.test.tsx`)も、保護の外にある。 | [取り込み時点のIssueと提案の描画](internals/console/security.md#取り込み時点のissueと提案の描画) |

### 設計の承認画面の保護

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-16"></a>R-CON-16 | 拒否の一覧は完全でない。フォントが空白に描く文字(U+1D159など)は、数えきれない。設計工程を有効にする条件として、この限界を受け入れる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-17"></a>R-CON-17 | 全走査はBunのUnicodeの表で行い、画面はブラウザの表で動く。版の差で分類が変わりうる。未割当は表記にするので、版の差は表記が増える側に倒れる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-18"></a>R-CON-18 | 判定は画面にだけある。`approval_decide`を直接呼ぶと効かない。ワークスペースのトークンを持つ主体は、このscriptを直接実行できる。ローカルのClaudeのセッションは、`hold-guard.ts`がscriptの名前で止める。組み立てた名前やハッシュでの呼び出しは止められないが、受け入れる。backendでの照合は入れない。承認のときに見せた文字のハッシュを送る照合も、同じ主体が、組み立てた呼び出しで回避できるためである。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-19"></a>R-CON-19 | 許可する文字を列挙する方式は採らない。正当な記号も表記になり、読みにくくなるためである。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-20"></a>R-CON-20 | 受信箱と要約が返す件数は、既定で200件までである。設計の依頼が行に加わるので、件数が上限に達したとき、並びの後ろの行が一覧から外れうる。外れた依頼は、上位の依頼を片付けた後に見える。この影響は、残るリスクとして受け入れる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-21"></a>R-CON-21 | 強い右から左の文字は、含むだけで止める。右から左へ書く言語の設計書は、却下か再生成で扱う。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-22"></a>R-CON-22 | 押し出しの検出は、連続した空行に限る。空行2行ごとに1文字を置く入力は、止まらない。U+1D159など、空白に描かれる文字との組み合わせも、止まらない。本文に偽の終わりの印を置き、その後ろに空行でない行を並べて指示を置く組み合わせも、止まらない。全文の終わりの印の行数を、パネルの先頭にも出して、全文の長さを確かめられるようにする。承認画面を実機で動かすときに、表示の長さを確かめる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-23"></a>R-CON-23 | 保護しない祖先の部品(`ApprovalOverview.tsx`、`InboxDetail.tsx`)と共有の部品(`ReviewPanel.tsx`の`PanelShell`)、全体のCSSとTailwindのテーマから、設計の承認画面の全文の一部の行だけを隠せる。組み直しの検査はCSSを当てず、印の見える文字も確かめないので、どの手も捕まえない。承認画面が読み込む保護しない部品(`LoadingState`、`QueryFailure`、`queries.ts`)の変更でも、描画は変わる。守る範囲は、承認画面のファイルの中に限る。この経路は、承認の詳細を含むConsoleのPRのレビューで確かめる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-24"></a>R-CON-24 | 設計書の取得(`queries.ts`の`fetchApprovalDesignDoc`)と型ガード(`approvalDesignDoc.ts`)は保護しない。描く文字と止める判定の入力を、同じ形に書き換えられる。配線の検査はキャッシュに値を直接入れるので、この経路を通らない。承認画面の起点である`InboxDetail.tsx`から`ApprovalOverview`への分岐も、配線の検査は通らない。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-25"></a>R-CON-25 | 組み直しの検査は、固定した入力だけを使う。承認画面(`DesignReview.tsx`)の中の、入力の内容によって動く変更は、保護パスなので、人のレビューで確かめる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-26"></a>R-CON-26 | 承認を止める連鎖(`designBlockedReason`、`approveGateProblem`、承認バー、承認の呼び出し)は、承認画面のほかは保護しない。止める理由を無視する分岐を足す変更は、分岐の条件がテストの固定値に当たらないとき、配線の検査を通る。`ApprovalOverview.tsx`と`ReviewPanel.tsx`の入力によって動く差し替えも、同じく検査を通る。呼ぶ側が判定を迂回する変更は、レビューで差分から確かめる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-27"></a>R-CON-27 | 配線の契約テストは、最初の描画だけを見る。DOMを動かすテストの基盤が無いので、mountの後に止める理由を外す変更は、テストで検出できない。`initialView`を渡して描くプレビューと、プレビューを選んだ後の原文も、最初の描画である。mountの後に切り替えた状態は、テストで描けない。切り替えと原文への復帰は、保護の外のe2e(`console/e2e/keyboard.a11y.ts`)が確かめる。レビューで差分から確かめる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護)、[設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-con-28"></a>R-CON-28 | 長い全文を最後までスクロールしなくても、承認できる。見える文字で後ろに置いた指示は、読まれずに通りうる。行数、コードポイント数、終わりの印を全文の外に出して、長さを確かめられるようにしている。読み終えたことを承認の条件にする仕組みは無い。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-29"></a>R-CON-29 | タブは4桁で数えるが、描画の既定の`tab-size`は8である。`<pre>`に`tab-size: 4`を付け、ソースの契約で固定している。ブラウザが`tab-size`を効かせない場合は、数える桁と見える桁がずれる。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |
| <a id="r-con-30"></a>R-CON-30 | NFDで書いたラテン文字(e+U+0301など)は、結合文字を数えるので、承認が止まり続ける。却下か再生成で扱う。 | [設計の承認画面の保護](internals/console/security.md#設計の承認画面の保護) |

### 設計書のプレビュー

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-31"></a>R-CON-31 | 確認のチェックは自己申告で、読んだことを保証しない。プレビューで読んで原文に戻し、読まずにチェックを付けて承認すると、プレビューに描かれない指示が、そのまま実装に渡る。原文を既定にした画面でも、原文を読まずに承認できる水準と同じである。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-32"></a>R-CON-32 | 表示の形式と、プレビューを選んだ記録(`previewed`)は、画面の状態だけにある。承認画面を離れて戻るか、再読み込みすると、どちらも消え、原文のまま確認のチェックを求めない。祖先の部品がmountし直させる変更も、配線の検査を通る。承認依頼のidごとの記録は、状態の置き場所が増え、保護テストが固定しにくいので、持たない。要件定義の承認画面と同じ水準で受け入れる。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-33"></a>R-CON-33 | 設計書のプレビューで、mountの後の確認のチェックの扱いは、すべて保護の外の`ApprovalBar.tsx`と`approvalDecision.ts`にあり、mountの後の変更は、保護パスを通らず、人のレビューを経ない。チェックを付けた後の挙動を確かめるのは、保護の外のe2eだけである。この経路は、要件定義とIssue提案の承認画面と同じ水準で受け入れる。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-34"></a>R-CON-34 | `ViewModeSwitch`と`ToggleChip`は、原文の表示中も設計書のパネルの中に描かれる。保護しない部品なので、全文の一部を覆う変更が、人のレビューを経ずに入りうる。既存の、保護しない祖先の部品と共有の部品と同類のリスクである。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-35"></a>R-CON-35 | 閉じない`<!--`より後ろの本文は、プレビューに描かれない。描かれないまま、実装に渡る。注記が伝えるが、原文を読まずに承認する人には届かない。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-36"></a>R-CON-36 | 表示の形式とは別の状態を、保護の外のモジュールから持ち込む経路は、検査を通る。許可リストにあるフック(`useApprovalDesignDoc`など)の中身や、保護の外の部品に状態を持たせる変更が当たる。止めるのは、保護パスの人のレビューである。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-37"></a>R-CON-37 | 設計書のプレビューを守るソースの走査は、文字列の形だけを見るので、フックの呼び方、名前の束縛の差し替え、importの形、入力で変わる差し替えなどを使うと、mountの後に表示と判定がずれ、プレビューのまま承認が通りうる。止めるのは、保護パスの人のレビューである。検査は、これ以上足さずに受け入れる。足し続けると、迂回を1つずつ塞ぐ競争になるためである。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-38"></a>R-CON-38 | 保護しない`DesignTextPreview`を読み込むと、モジュールの副作用で、承認画面の描画が変わりうる。この経路は、保護しない祖先の部品と全体のCSSの残るリスク([R-CON-23](#r-con-23))に含める。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |
| <a id="r-con-42"></a>R-CON-42 | 設計の承認画面で確認のチェックを付けた後に、プレビューへ移って原文へ戻しても、承認バーの付けたチェックは残る。同じ依頼の中では、申告し直さずに承認できる。この振る舞いは受け入れる。 | [設計書のプレビュー](internals/console/security.md#設計書のプレビュー) |

### ジョブの取消

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-39"></a>R-CON-39 | ローカルのClaudeのセッションも、運用者のwmillの資格で、Consoleの取消と同じことができる。`wmill job cancel`や、取り消しのAPI(`curl`での`/jobs_u/queue/cancel/<id>`)は、許可表、tag`console`の除外、操作の記録のどれも通らない。そのため、`self_update`、migrationを走らせるscript、`cleanup_*`のジョブも止められる。フックが止めるのは、書き込みのscriptを名前で呼ぶ経路だけである。この経路は、`AGENTS.wmill.md`がジョブのデバッグに勧める正当な操作でもあるので、フックで止めずに受け入れる。止めると、障害のときにジョブを止める手段を、セッションから奪うためである。 | [ジョブの取消](internals/console/security.md#ジョブの取消) |

### 定期ジョブの再実行

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-40"></a>R-CON-40 | ローカルのClaudeのセッションも、運用者のwmillの資格で、`wmill`の汎用の呼び出しから、許可表の外のscriptを動かせる。フックが止めるのは、書き込みのscriptを名前で呼ぶ経路だけである。この経路は、ジョブのデバッグに必要な正当な操作でもあるので、受け入れる。 | [定期ジョブの再実行](internals/console/security.md#定期ジョブの再実行) |

### 設定の変更

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-con-41"></a>R-CON-41 | ローカルのClaudeのセッションも、運用者のwmillの資格で、`wmill resource push`やAPIから、設定を直接書ける。この経路は、許可表も、比較交換も、操作の記録も通らない。フックが止めるのは、書き込みのscriptを名前で呼ぶ経路だけである。この経路は、設定の手順で人が使う正当な操作でもあるので、受け入れる。 | [設定の変更](internals/console/security.md#設定の変更) |

## draw.ioの図の描画

### 隔離したiframeで描く

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-dio-01"></a>R-DIO-01 | 残るリスクとして、`flows.json`は、リポジトリのflow定義の説明と配線を、認証なしのバンドルで公開する。秘密値は含まない。 | [隔離したiframeで描く](internals/console/security.md#隔離したiframeで描く) |
| <a id="r-dio-02"></a>R-DIO-02 | 設計の図のXMLに秘密値のマスクをかけないのは、文字参照などで秘密の形を分けられ、`maskSecrets`と`sanitizeModelTextDetailed`のどちらも合わないためである。要件定義の図と同じく、残るリスクとして受け入れる。 | [隔離したiframeで描く](internals/console/security.md#隔離したiframeで描く) |
| <a id="r-dio-03"></a>R-DIO-03 | ビューアの欠陥でiframeの中でscriptが動くと、iframe自身を別のURLへ遷移させ、受け取ったXMLをURLに載せて外のサーバーへ送れる。CSPは、ページの遷移を止められない。送った1回のXMLは外へ出せる。次のXMLを渡さないので、被害は、そのiframeが受け取った図1枚に限る。CookieとWindmillの資格情報には届かない。 | [隔離したiframeで描く](internals/console/security.md#隔離したiframeで描く) |
| <a id="r-dio-04"></a>R-DIO-04 | `'unsafe-eval'`を許さない根拠は、32.4.1のビューアのコードの読解とヘッドレスのChromeでの確認で、自動で上げた版は、この調査を経ていない。`eval`が要る版は、図が描かれなくなるだけで、CSPが評価を止める。 | [隔離したiframeで描く](internals/console/security.md#隔離したiframeで描く) |
| <a id="r-dio-05"></a>R-DIO-05 | 外部の図形ライブラリ(AWSなどのアイコン集)を使う図は、その図形が描かれない。外部への取得をCSPが止めるためである。 | [隔離したiframeで描く](internals/console/security.md#隔離したiframeで描く) |
| <a id="r-dio-17"></a>R-DIO-17 | 図のXMLをiframeへ送るときの宛先のオリジンは絞れない。送るのは図のXMLだけなので、許容する。 | [隔離したiframeで描く](internals/console/security.md#隔離したiframeで描く) |

### 保護パス

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-dio-06"></a>R-DIO-06 | ビューアがiframeの中で`window.location`を書き換えて遷移する経路は、`sandbox`で防げない。2回目のloadの検知で表示を止めるが、loadが起きない遷移は検知できない。そのときも、親が受け取るのは、範囲に収めた高さと、固定の失敗の種類だけである。 | [保護パス](internals/console/security.md#保護パス) |
| <a id="r-dio-07"></a>R-DIO-07 | ラベルの`%名前%`を別の値に置き換える`placeholders`と`vars`は、検査が拒否する。draw.ioが別の属性でも同じ置き換えをするようになると、検査はその図を拒否できない。その図は、iframeの隔離とCSPで止める。 | [保護パス](internals/console/security.md#保護パス) |

### ビューアの更新

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-dio-08"></a>R-DIO-08 | 新しい版が図を描けるかは、自動では確かめない。描けない版は、iframeが固定の失敗の文を出す。PR本文が、マージ後にConsoleで図を開いて確かめるよう求める。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-09"></a>R-DIO-09 | 上流のリポジトリが侵害され、2つの待ちと大きさの確認をすり抜けた版は、PRになる。マージの前に人が見る。マージ後も、iframeの隔離とCSPが被害を限る。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-10"></a>R-DIO-10 | 観測の時刻は、こちらが見た時刻である。公開日を古く偽られても、こちらが初めて見た時刻から数えるので、14日の待ちは回避されない。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-11"></a>R-DIO-11 | 観測は週に1回なので、観測の間にタグを付け替えて元に戻されると、気づけない。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-12"></a>R-DIO-12 | 最初に動かした週と記録が消えたときは、待ちを数え直すので、14日間はどの版も上がらない。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-13"></a>R-DIO-13 | 最新の版を保留している間は、それより古い版も上がらない。保留の理由はnoticeに出る。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-14"></a>R-DIO-14 | 保護するのは更新に専用の部品である。汎用の層(`github.ts`、`db.ts`、`types.ts`、`workspace.ts`)は保護していない。更新はこれらの関数を呼ぶので、挙動を変える変更は通常のレビューで確かめる。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-15"></a>R-DIO-15 | script定義とlockのうち、`drawio_viewer_bump.script.lock`と`lib/drawio_viewer_observations.script.lock`は保護しない。`windmill-client`の版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。部品のscript定義を保護し、部品の依存の無いlockを保護しない(理由は[保護パスの変更を止める](internals/pr-workflow.md#保護パスの変更を止める)の「libのlockを保護しない理由」)。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |
| <a id="r-dio-16"></a>R-DIO-16 | ブランチ名が`factory/drawio-viewer-`で始まる未完了のPRが残ると、更新は止まる。そのPRを閉じるかマージすると、次の週に再開する。 | [ビューアの更新](internals/console/security.md#ビューアの更新) |

## 調査の隔離

### 隔離の測定と判定の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-inv-01"></a>R-INV-01 | 予定外の`tool_use`の検査は、起動が終わった後にtranscriptを読む、事後の検出である。外れた呼び出しの`tool_result`は、検出より前にモデル(API)へ送られている。検査が止めるのは、残りの実行である。 | [隔離の測定と判定](internals/investigate.md#隔離の測定と判定) |

### 調査の隔離の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-inv-02"></a>R-INV-02 | 合格が保証するのは、[合格の意味](internals/investigate.md#合格の意味)の範囲だけである。外の9件は、3つの置き場の目印が読めないことしか示さない。ほかのパス(`/etc`、別のユーザーの`$HOME`など)、symlink経由、`--add-dir`、ほかのツールは測っていない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-03"></a>R-INV-03 | `deny`の規則が効くかは、測っていない。拒否は、`--restricted`の閉じ込め1枚に頼る。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-04"></a>R-INV-04 | ツールを通らない経路(設定の層、hook)は、測っていない。`CLAUDE.md`の`@`による取り込みは測らずに、[指示ファイルの無効化](internals/investigate.md#指示ファイルの無効化)で名前を変えて塞ぐ。設定の層を`user`だけにしたとき、対象リポジトリの`CLAUDE.md`が読み込まれなくなるかは、実機で確かめていない。読み込まれうる条件が残っても、改名の後の確かめ直しが、対象の名前が残ったworktreeを使わせない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-05"></a>R-INV-05 | 判定の根拠は、1回の実行(ジョブ01a1a0b1-cd69-6017-20f8-26b7407b6f3b)で、Claude Code 2.1.282に限る。版が上がると、関門が`version_changed`で閉じる。そのとき拒否の文言が変わっていれば、判定の版を上げて測り直す。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-06"></a>R-INV-06 | 拒否の文言は、Claude Codeの内部の文字列に頼る。文言が変わると、不合格に倒れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-07"></a>R-INV-07 | 12件の実行は、モデルの振る舞いに依存する。呼び出しが1回でなくなると不合格になるので、再実行して通るかを確かめる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-08"></a>R-INV-08 | 観測のモジュールの変更は、ハッシュの表が拾う。表に入っていない`lib/log.ts`の`maskSecrets`などが観測の文字列を変えても、表は落ちない。その変更は、観測のテストの固定とレビューが受け持つ。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-09"></a>R-INV-09 | 表に入っていないファイルの変更も、表は拾わない。`lib/investigate_workspace.ts`の`investigateWorktreeDir`が返す作業ディレクトリや、`lib/investigate_isolation.ts`の定数が対象である。保護パスとレビューが受け持つ。表に足さないのは、判定に効く変更が頻繁に版を上げる原因にならないよう、判定の直接の入力だけに絞るためである。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-10"></a>R-INV-10 | 測定のscriptが自己申告する結果を、関門は読む。関門が読むのは、Windmillに置かれた`f/factory/investigate_isolation_probe`の完了ジョブで、gitの保護パスは通らず、ジョブの`script_hash`も照らさない。Windmillの画面か、どのブランチからでも`wmill sync push`で、そのpathや、判定と観測のモジュール、`lib/claude.ts`のpathを書き換えられる主体は、合格を偽造できる。この偽造できる主体は、デプロイできる者であり、デプロイ済みのコード全体と同じ信頼の範囲に含める。scriptのハッシュの照合は入れずに、受け入れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-11"></a>R-INV-11 | 測定の実行の経路に、保護されていないモジュールが入っている。対象は次の3つである。`lib/log.ts`(`maskSecrets`)、`lib/types.ts`、`lib/db.ts`(`hasInvestigatingWorkItem`)。`lib/db.ts`は日常的に直すので保護しない。稼働中の調査を読むSQLの全文と戻り値の式は、保護されたテスト(`tests/scripts/investigate_singleton_migration.test.ts`)が固定する。`lib/db.ts`の他の部分や、`defaultSqlClient`の差し替えは、固定しない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-12"></a>R-INV-12 | 指示ファイルの再走査は、worktreeの項目数に上限が無い。大きなリポジトリでは、stepのタイムアウトで失敗しうる。失敗は調査を止める側に倒れるので、受け入れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-13"></a>R-INV-13 | Claude Codeの版が上がると、作業ディレクトリから読む指示や設定の名前が増えうる。版を上げるときは、その名前を確かめ、`INSTRUCTION_ENTRY_NAMES`(`lib/investigate_workspace.ts`)を直す。確かめない間は、新しい名前の項目が改名されずに残る。受け入れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-14"></a>R-INV-14 | 関門が見るのは、最新の完了ジョブ1件だけである。不合格の後に再実行して通ると、前の不合格は見えなくなる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-15"></a>R-INV-15 | 判定は、後始末の失敗(`cleanup.failed`)を条件にしない。目印が秘密でなく、後始末の失敗が秘密に関わらないためである。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-16"></a>R-INV-16 | 観測の中の予定外の読み出しは、実行が終わってから、transcriptで見つける。1回の実行の途中で止める手段は無い。本物の秘密を読ませない保証は、次の3つに頼る。固定のプロンプト、読み出しを塞ぐ一覧、実行の後に止める検査である。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-17"></a>R-INV-17 | 出力用のツール名の綴りに、秘密の断片が載りうる。目印の値と名前、32桁以上の16進の並び、既知の秘密の形は置き換えるが、それ以外の短い断片は、名前の形に合えば残る。断片を載せるには、モデルが先に予定外の`tool_use`で秘密を読む必要がある。その場合は、名前を結果に並べないので、断片は残らない。外に触れる判定を抜けた読み出しがあると、この前提が崩れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-18"></a>R-INV-18 | 測定は1時点の結果である。Claude Codeの版か起動の形が変われば、関門が閉じ、測り直しになる。worker imageと、マウントの変更は、証拠に入らないので、測り直しにならない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-19"></a>R-INV-19 | 古い版の測定のscriptをハッシュで実行すれば、合格のジョブの記録を作れる。デプロイできる者と、rootで動くジョブ(superuserのDB接続を持つ)も、ジョブの記録を作れる。uidを分けるまでは、デプロイ済みのコード全体と同じ信頼の範囲に含める。scriptのハッシュの照合は入れない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-20"></a>R-INV-20 | 測定を動かす主体と、関門を呼ぶ主体が、同じ範囲のジョブの記録を読めることを前提にする。見える範囲が違うと、閉じる理由が`proof_unreadable`か`proof_missing`になる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-21"></a>R-INV-21 | ジョブの記録の保持期間(約30日)が切れると、測定のジョブが見えなくなり、関門が閉じる。閉じるのは安全な側である。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-22"></a>R-INV-22 | 関門が塞ぐのは、`runInvestigateClaude`を通る起動だけである。`runClaude`を直接呼ぶ経路は`lib/claude.ts`にあり、合格の証拠の関門では塞がない。`lib/claude.ts`は保護パスなので、変更には人の承認が要る。調査の4つのstepと支援のlibが`runClaude`を名指ししないことは、保護されたテストが固定する。別のファイルから名指しする経路は、このテストでは見つからないので、PRのレビューで見る。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-23"></a>R-INV-23 | 証拠の参照元の走査は、識別子を連結や別名で組み立てる動的な参照を数えられない。そうした参照は、PRのレビューで見る。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-24"></a>R-INV-24 | `lib/claude.ts`の分岐のうち、テストと本番で振る舞いが変わるものは、保護されたテストでは見つからない。PRのレビューで見る。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-25"></a>R-INV-25 | 作業ディレクトリの検査は、起動の前の1回である。起動の後にsymlinkを差し替える操作は、検出しない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-26"></a>R-INV-26 | 掃除は、置き場の下の自分以外の項目をすべて消すので、稼働中の調査と隔離の測定の確認から掃除までの間に、相手が始まる競合が残る。workerが調査を1件ずつ動かす前提(`replicas`が1)に立つ。workerを増やす変更や、調査を並行させる変更では、この前提を見直す。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-27"></a>R-INV-27 | 調査のフローの失敗処理は、`flow_job_id`を記録していない行を`failed`にしない。登録が、行の作成と同時にフローのルートジョブのIDを`flow_job_id`に記録することを前提にする。記録のない行は、照合が孤児として扱う。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-28"></a>R-INV-28 | 掃除が取るロックは、引数の主リポジトリのものだけである。置き場は全リポジトリで共有するので、他のリポジトリの項目はロックなしで消す。他のリポジトリのworktreeの登録(`.git/worktrees/<id>`)は、そのリポジトリの次の作成の`git worktree prune`で消える。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-29"></a>R-INV-29 | 別名の`/var/run`、`/var/lock`と、`/dev/fd`、`/dev/stdin`の拒否は、効くことを確かめない。拒否が効かないと、綴りを変えて塞いだ場所に届く。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-30"></a>R-INV-30 | 最終の本文は、生成のstepの結果と、投稿のstepの引数に残る。保持先は、Windmillの完了ジョブ(約30日)と、Consoleのジョブ詳細である。投稿のstepの再検査で止めた本文も残る。生成のstepでは、この本文は検査を2回通っている。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-31"></a>R-INV-31 | 投稿のstepは、コメントの投稿と、調査の状態の更新を、別の操作で行う。投稿の後に更新が失敗すると、調査は`failed`になり、コメントは残る。投稿し直すと、新しい作業項目の目印で、2件目のコメントが付く。受け入れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-32"></a>R-INV-32 | 調査の実行の途中で、予定外の読み出しを見つけて止める手段は無い。隔離の測定は実行の後にtranscriptを読んで検出するが、調査の本番の実行には、実行後のtranscriptの検査が無い。読み出しを防ぐのは、ツールの制限と`--restricted`の閉じ込めと、指示ファイルの無効化に限る。受け入れる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-33"></a>R-INV-33 | 調査の結果のコメントには、`Glob`と`Grep`の結果のパス名が出うる。対象は、作業ディレクトリの中のパスと、それを根拠にした説明である。Issueを読める人には見える。非公開の試験用リポジトリで、敵対的な依頼文を使って確かめる。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-34"></a>R-INV-34 | 完全一致のマスクの対象は、生成のstepが読む秘密値に限る。`claude_oauth_token`、`github_token`、`wmill_token`、`discord_webhook_url`の値と、生成のstepのジョブのトークンである。`github_read_tokens`は、対応表の値を1つずつ消す。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-35"></a>R-INV-35 | 本文の検査の経路の5つのファイル(`lib/ci_fix_round.ts`、`lib/workspace.ts`、`lib/log.ts`、`lib/github.ts`、`lib/gh_collect_support.ts`)は、保護の外にあり、緩められても保護されたテストは落ちない。ほかのフローも日常的に直すファイルなので、保護しない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-36"></a>R-INV-36 | 生成のstepが推移的にimportするモジュールは、保護しない。固定するのは、直接importするモジュールの集合だけである。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-37"></a>R-INV-37 | 一意制約の違反(23505)は、すべて`investigation_in_progress`として断る。同じIssueの別の行との衝突も、同じ理由で表に出る。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-38"></a>R-INV-38 | 作業ディレクトリの中(対象リポジトリの内容)は、読めるので、信頼できない入力のままである。プロンプトのデータの区切りと、出力の検査で抑える。どちらも、呼び出し側が担う。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-39"></a>R-INV-39 | 観測は、`Glob`と`Grep`が祖先のディレクトリから目印を見つけるか、設定の層が読まれないか、指示文書の`@`の取り込みが起きないかを測らない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-40"></a>R-INV-40 | 拒否の規則は、`Read`、`Glob`、`Grep`の組み込みのツールに効く設定である。対象リポジトリの設定を読まないこと(設定の層を`user`だけにしたこと)が、実際に文脈へ入らないことも、実機で確かめていない。 | [調査の隔離](internals/investigate.md#調査の隔離) |
| <a id="r-inv-41"></a>R-INV-41 | 隔離の測定のジョブの有無を、調査の登録と生成が、ジョブのトークンの権限で見られるかは、実機で確かめる。見えないと、確認が空の一覧になり、測定が動いていても調査を始めうる。 | [調査の隔離](internals/investigate.md#調査の隔離) |

## 設計書の生成の安全策

### 設計工程を有効にする操作

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-des-01"></a>R-DES-01 | 運用者の資格で`wmill resource push`を呼ぶと、許可表も、比較交換も、操作の記録も通らずに、設計工程の入口を開けられる。開いたことは、設定タブの「設計工程(実際の状態)」の行が効いている値を出すので見える。ただし、`design_enabled`か`design_enabled_since`が参照で書かれているときは、行が「判定できない」と出すので、開いたことは設定タブから見えない。受け入れる理由は、ローカルのClaudeのセッションが設定を直接書ける経路([R-CON-41](#r-con-41))と同じだからである。 | [設計工程を有効にする操作](internals/design.md#設計工程を有効にする操作) |

### 設計書の生成の安全策の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-des-02"></a>R-DES-02 | 印を付けて`dataFence`に入れても、要件定義や設計のClaudeが報告の内容に従う可能性は残る。報告は、Issueの本文を読んだ別の段のClaudeが書いたもので、人は渡る前に読めない。人が読むのは、生成された要件定義書か設計書の承認の画面である。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-03"></a>R-DES-03 | Issueに仕込んだ指示で、設計が毎回`requirements_gap`を返すと、人の要件定義の承認を毎回無効にし、上限まで要件定義と設計の生成を繰り返す。止まるのは、`max_attempts`、日次予算、承認の待ちである。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-04"></a>R-DES-04 | Issueに仕込んだ指示で、設計書を受け取った実装が毎回`design_gap`を返すと、設計と実装の繰り返しが上限まで続き、実装の作業は捨てられ、人が却下できる回数も減る。上限に達すると人の対応待ちで止まる。ほかに自動の繰り返しを止めるのは、日次予算と承認の待ちである。再実行は数えないので、仕込みが続くかぎり、人の操作のたびに同じ繰り返しが1周する。設計工程が無効の間は、設計書が実装に渡らないので起きない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-05"></a>R-DES-05 | Issueに仕込んだ指示や、レビューの指摘の文が、PR修正のClaudeに`design_gap`を返させると、人が承認した設計を戻し、人の却下と共有する上限(`max_design_attempts`)を減らす。1回の戻しごとに、人の設計の承認を通る。上限に達すると人の対応待ちで止まる。この影響は、残るリスクとして受け入れる。軽減として、返してよい条件を「設計どおりに直すと要件か受入条件を満たせないとき」に狭め、設計と食い違うだけなら見送らせる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-06"></a>R-DES-06 | 自動のPRレビュー(`pr_review`)には設計書を渡さない。レビューの指摘が承認済みの設計と食い違うと、PR修正が`design_gap`を返す候補になる。この影響は、残るリスクとして受け入れる。誤った`design_gap`は、返してよい条件を狭めたこと、見送る(`skipped`)逃げ道、戻しの上限、人の設計の承認で抑える。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-07"></a>R-DES-07 | PR修正の設計への戻しで書き込みが途中で失敗し、処理済みの位置が進んでいると、次のPR修正の行は位置を引き継ぐので、元の指摘は二度と集まらない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-08"></a>R-DES-08 | 設計の起動に失敗した親は、人の対応待ちで止まる。その後で設計工程を無効にして親を再実行すると、報告が設計に届かず実装へ進む。処理済みの位置は戻した時点で進んでいるので、元の指摘は消える。人の手順は、再実行の前に設計工程が有効かを確かめることである。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-09"></a>R-DES-09 | PR修正の設計への戻しの上限と設計工程の無効の判定は、親の状態の確認より前にある。親が別の経路ですでに設計の段階にあり、数が上限に達していると、理由が上限になる。このとき案内は「ラベルの付け直しか、PRを人が直す」になる。親は進行中なので、設計の段階にあるという案内の方が正しい。理由の字面を固定するテストと両立させるため、この食い違いは直さずに受け入れる。 | [戻さずに止めるとき](internals/pr-workflow.md#戻さずに止めるとき)、[設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-10"></a>R-DES-10 | PR修正の設計への戻しで、親の確認と比較交換は1つの文ではない。その間に割り込んだ同じIssueの新しいサイクルは、部分一意インデックス(`work_items_active_issue_key`)が捕まえる。この制約が効かないと、置き換わった親を設計へ戻して生き返らせる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-11"></a>R-DES-11 | PR修正の設計への戻しが、上限か設計工程の無効で止まったとき、親はPR作成済みのまま残り、再実行で設計を作り直せない。人が、トリガーのラベルを付け直すか、PRを直す。自動で設計を作り直し続けることは無い。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-12"></a>R-DES-12 | 設計の段階の間にPRのブランチへ別の回がpushしないよう回ごとに止めるが、ブランチ名から作業項目を引けないとき(形が違う、削除済み、別のリポジトリ)は、どの回も止めない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-13"></a>R-DES-13 | 起動の判断が作業項目の状態を読んでから回の準備が動くまでの間に承認が入ると、実装の準備は人の対応待ちで止まり、PRの終端でない回が無くなった後に自動で再開する。探す範囲の外の回が残っていたときは、再開した準備が止め直し、再開の回数を1回使う。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-14"></a>R-DES-14 | 自動の再開の回数の上限(3回)は、イメージが古い理由で止まった後の再開と共有する。どちらかで回数を使うと、もう一方で使える回数が減る。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-15"></a>R-DES-15 | 再開の直後に、`poll_prs`が5分ごとに作る再レビューが終端でない回として残っていると、準備が止め直し、再開の回数を使う。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-16"></a>R-DES-16 | 設計の段階で`blocked`にしたレビュー回は、Consoleの進行中の一覧に残りうる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-17"></a>R-DES-17 | 承認待ちの2状態(`awaiting_approval`、`awaiting_design_approval`)の間は、競合の通知が出ず、競合回とCI回も起動しない。解けるのは、承認、却下、期限切れ(`expired`)のときである。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-18"></a>R-DES-18 | 承認済み(`approved`)は終端の状態で、実装フローが無効のとき(`implement_enabled`が偽)などは長く残る。その間も、競合回とCI回の自動修正と、競合の通知は止まる。本番は実装フローが有効なので、通常は短い。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-19"></a>R-DES-19 | CI回の失敗は、ブランチを引き継ぐ間は自動で直さず、見送りの時点では保留を書かない。保留の無い失敗の通知(`UNHELD_FAILURE_NOTICE_AFTER_MS`、2時間)が、説明なしに出うる。競合の通知は止めるのに、CI回の通知は止めない。 | [ブランチを引き継ぐ間](internals/pr-ci.md#ブランチを引き継ぐ間)、[設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-20"></a>R-DES-20 | 通知済みの競合の行は、動かさない。通知した後で作業項目が設計の段階へ移ると、通知は開いたまま残る。人が手でpushした後は、自動修正が`not_factory_head`で止まる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-21"></a>R-DES-21 | 照合(reconcile)は、設計中のPRの閉鎖を見ない(#146)。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-22"></a>R-DES-22 | 実装の不足の報告(`gap_report`)には、整える前の文字列を保存する場所がある。実装のラウンドの記録(`implement_rounds.gap_report`)は、Claudeの出力をそのまま保存し、Consoleのラウンドの表示に出る。要件の不足の遷移の注記(`gap: ...`)と、その遷移の戻り値(`transitionResult`)にも、整えずに入る。整えるのは、設計や要件定義へ渡すときと、再実行が注記から読み出すときである。ここまでは要件の不足にもともとある扱いで、設計の不足のラウンドの記録にも同じ扱いが及ぶ。設計の不足の遷移の注記と戻り値は、整えてから入れる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-23"></a>R-DES-23 | 設計が読む対象リポジトリのコミットは、要件定義が読んだコミットと違いうる。既定ブランチが進むためである。読んだ先頭は`design_drafts.head_sha`に記録し、追えるようにしている。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-24"></a>R-DES-24 | 書き込み境界は、検出して止めるにとどまる。書き換えを元に戻す手段は別に要る。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-25"></a>R-DES-25 | ハッシュの検査には、次の限界がある。ルートのリンクの検査は、検査の時点で最後の要素がリンクのときだけ拒む。走査の途中の入れ替えと、親の要素のリンクは検出できない。`snapshotDocDir`は、窓の中の追加と削除を前後のハッシュの違いで検出する。ただし、検査とハッシュと本文の読み取りは別々にファイルを読むので、Claudeの終了の後も動き続けてdoc dirに書ける者による入れ替えは検出できない。どちらも、`--restricted`の境界の外に書ける者が前提である。設計のClaudeにはBashが無く、今の呼び出し元から到達する経路は見つかっていない。 | [ハッシュ](internals/requirements.md#ハッシュ)、[設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-26"></a>R-DES-26 | 要件定義の下書きの列の欠落(PostgreSQLのコード42703)の判定は、PostgreSQLの文言とコードに依る。`message`と`body`の`\"`を`"`に戻して照合する。本番の`wmill.datatable()`が返す形を、実機で確かめていない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-27"></a>R-DES-27 | 実行が強制終了されたとき、`design-<N>`のworktreeと図の複製は、次の日次の掃除まで残りうる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-28"></a>R-DES-28 | 日次の掃除が稼働中かを判定してから削除するまでの間に、別の実行が同じ`design-<N>`を使い始める競合が残る。判定と削除が別の操作だからである。要件定義と実装のworktreeも、掃除が使用中かを判定してから消す([実装](internals/implement.md)の「ロックファイルの掃除」)ので、同じ前提が設計のworktreeにも当てはまる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-29"></a>R-DES-29 | 設計書は信頼できない入力で、HTMLとリンク参照定義を除かずに文字として実装に渡すので、人が見る内容と実装が受け取る内容は、承認画面が同じ文字を文字として描くときだけ一致する。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-30"></a>R-DES-30 | Consoleを読める人は、全作業項目の設計書と要件定義書を読め、設計書には形式の無い秘密値が、マスクしていない図のXMLには秘密値が残りうる。設計書と要件定義書を返すviewは持ち主を確かめず、idは連番で、総当たりできる。マスクしていない図のXMLは、`console_query`のジョブ結果としてWindmillに残る。この影響は、残るリスクとして受け入れる。Consoleを呼べる人の範囲は、広がらない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-31"></a>R-DES-31 | `normalizeDesignForImplement`(`f/factory/lib/model_text.ts`)が除くのは、制御文字(Cc)と書式文字(Cf)だけである。設計のClaudeが、異体字セレクタなどの列で命令を隠した設計書を出すと、人は承認画面で何も見えないまま承認しうる。承認画面は、`safeText`を通さずに不可視文字を表記にするので、この食い違いを塞ぐ。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-32"></a>R-DES-32 | 人が画面を見てから関門が読むまでの間に、`model_text.ts`か`log.ts`の秘密値の形式を変える変更が反映されると、画面の文字と実装が読む文字はずれる。承認したときの文字のハッシュを記録して関門で照合する仕組みは無い。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-33"></a>R-DES-33 | 実装の関門や再実行などの呼び出し側を守るのは、人のレビューである。拒否の一覧が守るのは、判定の実体(`approval_gate`、`doc_tree_hash`)と共有部品(`model_text`)である。呼び出し側は次のとおりである。`implement_prepare`の`designGate`の呼び出し、`retry_work_item`(`readGap`を含む)、`design_apply`と`design_apply_support`、承認待ちの走査(`approval_sweep`)、`db.ts`の`latestDesignApproval`と`getDesignDraft`。日常的に直されるファイルで、拒否すると正当な修正を止める。呼び出しの順序(照合の後に比較交換、比較交換の後に副作用)や結果の扱いを誤る修正は、人のレビューと、ソースの文面を固定するテストでしか止められない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-34"></a>R-DES-34 | 再実行の行き先の分類は遷移の注記の文面に依るので、文面を変える前に止まった作業項目は分類できず、要件定義の生成へ戻る行に当たらない。設計が有効なら設計、無効なら実装で再開するが、実装の関門が最後に止める。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-35"></a>R-DES-35 | 再実行が渡す却下の理由に、scriptの側の長さの上限が無い。設計の経路も同じで、`design_apply`が設計フローと要件定義の生成へ渡す理由と、再実行の設計フローへの`designFeedback`がそのまま渡す。上限はConsoleの4000コードポイントだけである。書き手は人である。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-36"></a>R-DES-36 | 設計の承認依頼の期限切れの直後に人が承認を記録すると、判断は反映されず、依頼は承認済みのまま残る。走査が先に作業項目を期限切れへ移すためである。この競合は、作業項目を移してから依頼を期限切れにするまでの間に限られる。通知は依頼の期限切れの後に送るので、通知を待つ間は開かない。作業項目は期限切れになり、再実行できる。再実行は最新の依頼が承認済みなら承認の後の工程から始まる。実装が人の承認なしに進むことはない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-37"></a>R-DES-37 | 判断の反映が3回の起動し直しの後に止まった作業項目を再実行すると、承認の副作用は実行されない。止まった理由は`approval decision could not be applied after 3 restarts of the handler`である。要件定義の承認では、Issueへのコメントと要件定義のworktreeの片付けが対象である。反映の処理が失敗し続けた作業項目なので、人がConsoleで状態と承認の記録を確かめてから再実行する。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-38"></a>R-DES-38 | 設計の却下の反映でIssueが消えた、または移された場合は、Issueを読めない。変わっていないものとして設計を再生成するので、要件定義へ戻る出口に入れず、`max_design_attempts`の回数まで再生成が繰り返される。上限で人の対応待ちになり、通知が知らせる。却下は人の意思で、読めないことを理由に止めても再実行は同じ状態に戻るだけで出口にならない。承認の断りの案内が、この挙動を先に伝える。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-39"></a>R-DES-39 | 恒久的に失敗する決定済みの依頼は、処理先を3回起動し直した後に人の対応待ちにする。それ以降は走査の対象から外れ、3回の起動し直しの失敗が`job_failures`に残る。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-40"></a>R-DES-40 | `design_enabled`を偽から真にする時点で止まっている作業項目(承認済み、実装中、自動で再開する理由を持つ人の対応待ち)は、有効にしても自動では再開されず、人が再実行すると設計から始まる。運用の手順は、有効にする前の件数を数え、0にすることである。0にできない分は、再実行が設計へ回ることを受け入れる。開ける前にPRを出していた作業項目で`design_gap`が出ると、設計へ差し戻される。差し戻しは、上限と人の承認で抑えられるため、受け入れる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策)、[有効にする前に確かめること](operations/stages.md#有効にする前に確かめること) |
| <a id="r-des-41"></a>R-DES-41 | `design_enabled`を真から偽に戻しても、設計中と設計の承認待ちの作業項目は止まらず、`design_apply`も動く。承認の反映は`design_enabled`の値を見ず、設計書を渡さずに実装へ進む。関門は設計が無効のときの扱い(`skip`)になるためである。却下の反映は、設計を作り直す分岐でだけ値を見る。偽なら設計フローを起動せず、人の対応待ちで止める。閉じた入口を、`design_apply`が迂回しないためである。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-42"></a>R-DES-42 | 要件定義の下書きができた後に止まった作業項目は、理由が使われ済みなので、再実行は理由を渡さない。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-43"></a>R-DES-43 | `design_enabled`が真偽値でないときと、`max_design_attempts`が範囲外のときは、設定を読む処理が例外のままである。設定を読む処理は`self_update`で`try`の外にあるので、自己更新と検知が止まる。設定の書き損じが、そのまま全体の停止になる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-44"></a>R-DES-44 | `config.ts`で名前を組み立てて入力(`raw`)を書き換える変更は、保護されたテストでは検出できない。`resolveDesignGate`へ渡す前に、`config.ts`が`design_enabled_since`の値を作り直せるためである。文字列の連結を検出できないとする既存の限界と同じ形で、PRの人のレビューとマージが守る。禁止の一覧で検出する方式は、保護されていない別ファイルの補助関数経由やスプレッドでの作り直しが残るので採らない。この限界は、残るリスクとして受け入れる。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-45"></a>R-DES-45 | Consoleで止めた後、`design_enabled_since`が残るので、`design_enabled`だけを`true`に戻すと、設計工程がすぐ開く。有効に戻す手順(時刻の書き直し)は、運用者が行い、確認のダイアログと文書で伝える。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |
| <a id="r-des-46"></a>R-DES-46 | 設定タブの一覧は、書かれた値をそのまま出す。`false`として読まれている`design_enabled`の`true`も、`true`と表示される。設計工程だけは、「設計」グループの先頭の「設計工程(実際の状態)」の行が、効いている値と、書かれた値が無視されている理由を出す。設定が参照で書かれているときは、設定タブが参照を解決しないので、効いている値を断定せず「判定できない」と出す。通知`design_enabled_ignored`は、書き忘れだけを知らせる。効いている値の確認は、設定タブだけである。 | [設計書の生成の安全策](internals/design.md#設計書の生成の安全策) |

## 保留

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-hold-01"></a>R-HOLD-01 | Windmillのscriptはすべて同じdatatableの接続を持つ。検出をすり抜けるコードは、表を読み書きできる。保留は止めるためだけに使い、外れても元の保護が残るので、受け入れる。接続の`role`で分離できる可能性は、確かめるまで、できないとは断定しない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-02"></a>R-HOLD-02 | 検出の範囲は、`f/`のすべてのファイル(`.lock`を含む)と、`migrations/datatable/main/`の表を作る2本以外である。`.ts`は変換後のコードを、ほかの形式(SQL、シェル、Python、YAML)は生のテキストを読む。`scripts/`やローカルのフックなど、ほかの場所は見ない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-03"></a>R-HOLD-03 | 許可した読み取りの関数(`listActiveHolds`)は、呼び出し側から接続を受け取る。呼び出し側が`strings`を書き換えた接続を渡す迂回は、止めない。 | [保留](internals/holds.md#保留)、[参照の禁止](internals/holds.md#参照の禁止) |
| <a id="r-hold-04"></a>R-HOLD-04 | 英文のログ(`could not update holds`など)は当たらない。`factory.holds`を含む文字列は、英文でも、SQLコメントや`COMMENT ON`、`.script.yaml`の`description`でも当たる。見逃しを減らすため、誤検知を許している。誤検知の規則を直すには、保護パスの変更としてPRを出す。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-05"></a>R-HOLD-05 | 見つけられない入力の例は次のとおりである。文字列の連結や`${}`で名前を組み立てるコード、名前をJavaScriptの文字列のエスケープで書くコード、保留のモジュールの名前を組み立てるimportがある。migrationの動的SQL(`EXECUTE format(...)`、文字列の連結、カタログを引くループ)では、スキーマ無しの`holds`の規則も塞げない。`PGOPTIONS=-csearch_path=factory`や`set_config('search_'\|\|'path', ...)`のように、語を分ける形もある。これらは例であり、すべてではない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-06"></a>R-HOLD-06 | `scripts/test-db.sh`は守らない。日常的に直すファイルなので、守ると正当な変更を止める。実DBの検査を呼ぶ位置の検査は、`exit 0`を足すか、呼び出しを`if false; then ... fi`で囲むと、迂回できる。迂回しても、制約名まで照合する`scripts/test-db-holds.ts`と、CIの`test-db`ジョブが別の層で守るので、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-07"></a>R-HOLD-07 | 実DBの検査が使う`scripts/test-db-sql.ts`は、保護の外にある。ほかの実DBの検査も使う部品なので、守ると日常の変更を止める。制約の拒否は制約名まで照合するので、単純な誤りでは検査を通らない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-08"></a>R-HOLD-08 | 書き手は`created_at`と`expires_at`の列を自由に渡せる。24時間の上限は、表の制約と、読み取りの有効条件の両方で効かせる。制約を外せる主体は、[R-HOLD-10](#r-hold-10)の`psql`の項目の権限を持つ。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-09"></a>R-HOLD-09 | 1行の期限は最大24時間だが、置き直しの回数に上限は無い。`holder`は名乗りなので、上限は抑止にならない。連続した保留は、人が表の未解除の行を確かめて解除するまで続きうる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-10"></a>R-HOLD-10 | `session`と`human`の区別は、呼び出し側が名乗る`holder`で決まる。解除の可否を決める`canRelease`は名乗りを信じるので、権限の境界ではない。BashとDockerを持つ主体は、`psql`で他の主体の保留を解除でき、削除でき、制約も外せる。止めが外れる向きでも、区別は境界ではない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-11"></a>R-HOLD-11 | Consoleから保留を解除できる。Windmillにログインした管理者(ワークスペースの管理者)は、Consoleでなくても、APIとpsqlで同じことができる。scriptを足しても権限は増えないが、1回の呼び出しで届く道が増える。解除は止めが外れる向きだが、保留は止めるための補助で、元の保護が残るため、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-12"></a>R-HOLD-12 | Consoleの解除は、`session`や`factory`が置いた保留も、人(`human`)として解除する。操作者の名前は`released_by`に書けず(`human`の`holder`は`human`に限る)、情報の通知とジョブの記録に残る。通知の書き込みが失敗しても解除は取り消さず、画面が知らせる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-13"></a>R-HOLD-13 | Consoleの確認は、`yes`の入力を求めない。ログインした管理者が、対象、期限、効果の文を見て押す操作で、フォーカスの既定が「取り消す」にある。解除は止めが外れる向きだが、保留は期限で必ず終わるため、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-14"></a>R-HOLD-14 | Consoleで解除するscriptと、ジョブを取り消すscriptの名前は、各scriptと許可リストの外に出さない。`f/`のほかのファイルが名前を持つと、自動のコードから、解除や取消のscriptを起動できる。生成した既知pathの定数(`lib/console_known_paths.ts`)も、この名前を持たないよう、生成で除く。`tests/scripts/hold_wiring.test.ts`が、`f/`のすべてのファイル(`.lock`とflowの定義を含む)を走査して固定する。名前を組み立てる形は、検出できない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-15"></a>R-HOLD-15 | 保留の表の壊れた行が1つでもあると、Consoleは一覧を出さない(`corrupt`)。回復はpsqlで行う。読めない間は、dependabotの自動マージが止まる側に倒れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-16"></a>R-HOLD-16 | 画面の時計とDBの`now()`のずれで、期限の境界に数秒の誤差が出る。解除はidで行い、idは再利用されないので、別の保留を解除することはない。idは、migrationをdownしてからupすると振り直されるが、運用では行わない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-17"></a>R-HOLD-17 | 偽造した保留の影響は、対象の進みが遅れることに限られる。許可に使わない限り、保留が権限を増やすことはない。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-18"></a>R-HOLD-18 | 保留を読めないとき、dependabotの自動マージは止まる。DBが落ちている間は、取得が待ち、終了のステップが作業項目を人の対応待ちで終える。止めた作業項目は再開しないので、人がPRを確認して手でマージする。安全側に倒す方針なので、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-19"></a>R-HOLD-19 | 保留を読んでからマージを要求するまでの数秒は、保留が置かれても止まらない。保留は止めるだけの補助で、元の保護(レビューとゲート)が残るので、受け入れる。 | [保留](internals/holds.md#保留)、[dependabotの自動マージ](internals/holds.md#dependabotの自動マージ) |
| <a id="r-hold-20"></a>R-HOLD-20 | ローカルのセッションの`gh pr merge`などは`merge-guard.ts`が止めるが、人の端末、GitHubのWeb UI、他の人のマージ、クラウドのセッションのGitHubのMCP、保留を置く前から有効だった自動マージ、追わない形のマージは止まらない。端末は人が意図して実行する経路で、止めると復旧の手段を失うため、受け入れる。ほかは、保留は止めるだけの補助で、元の保護(レビューとゲート)が残るため、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-21"></a>R-HOLD-21 | `gh pr comment`は対象外にしている。コメントで`@dependabot merge`のようなコマンドを送れるが、保留が有効な間にそれがマージを起こすかは、確かめていない。Factoryのdependabotの自動マージは、保留が別に止める。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-22"></a>R-HOLD-22 | フックが保留を読んでからマージを要求するまでの間は、保留が置かれても止まらない。人の承認を待つ間は、分単位に延びうる。待つ間にマージが要る作業は、保留を置いた主体と調整するため、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-23"></a>R-HOLD-23 | マージの判定は、安全と確かめられた形を対象外にし、確かめられない形(`gh`のグループの前のオプション、値を付けた真偽値のオプション、外し切れない前置き)をマージか反映として扱う。新しい迂回が見つかっても、列挙を足し続けず、残るリスクとして書いて受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-24"></a>R-HOLD-24 | `gh api`の書き込み(POST、PUT、PATCH、DELETE)と、`gh pr`の読み取りと編集以外のサブコマンドは、マージとして扱う。コメントの投稿や、ラベルの変更なども、保留が有効な間と保留を読めないときは止まる。止めすぎは、綴りの漏れを追い続けないために、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-25"></a>R-HOLD-25 | リポジトリが決まらないマージは、どのリポジトリの保留でも止まる。`--repo`が無い、値が食い違う、実行時に決まるときが当たる。他のリポジトリの保留で止めすぎるが、安全側に倒すため、受け入れる。`--repo <owner>/<repo>`を文字どおり書けば避けられる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-26"></a>R-HOLD-26 | クラウドのセッションには`mise`と`docker`が無く、保留を読めないので、マージ系と反映系は拒否される。`bun`も24以上の`node`も無い環境では、起動スクリプトがフックを動かさずに通す。クラウドでの動作は、実機で確かめていない。マージは人が行う方針と合うため、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-27"></a>R-HOLD-27 | `.claude/settings.local.json`の`disableAllHooks`は、`merge-guard`を含むすべてのフックを止める。ファイルはgitignore済みで、置くのは人である。範囲外の既存の穴として受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-28"></a>R-HOLD-28 | ホストの実行役(`scripts/host_apply/`)の反映は、`merge-guard`が覆わない。実行役は承認の門を別に持つため、受け入れる。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-29"></a>R-HOLD-29 | `merge-guard`の読みは、`mise exec`で包んだ子プロセスを使う。子の環境で自動インストールを止めるので、ネットワークには出ない。`mise`のツールが入っていなければ、読めないものとして拒否される。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-30"></a>R-HOLD-30 | 保留の操作と、凍結のCLIでの端末の確認を通る書き込みを止める`hold-guard.ts`の拒否は、語の字面で判定するので、実行時に組んだ名前、別名、変数で組んだパス、前置きの無いシェルやインタプリタが受け取るコード、保留のコードを書き換えてから起動する形などは止めず、受け入れる誤検知も残る。`find`の後ろの`node`、`tsx`、`ts-node`、`deno`は最初のオペランドをファイルとして実行するので、探索先に検査の道具と同じ名前のファイルがあると、それが実行され、この形も新しいファイルを書いて実行する形として受け入れる。フックの時点では、名前からしか実体を判定できないので、`sh`の実体がzshに設定された環境、`ksh`がmkshやpdkshの環境、Linuxの実体では、判定が食い違いうる。止めるのは、誤操作と、拒否を知らない呼び出しで、境界ではない。保留は、BashとDockerを持つ主体がpsqlで直接書ける。 | [保留](internals/holds.md#保留)、[主セッションの免除](internals/holds.md#主セッションの免除) |
| <a id="r-hold-31"></a>R-HOLD-31 | 保留の`reason`と`holder`は、psqlのプロセスの引数に現れ、一覧に表示される。秘密を書かない前提である。一覧は、`target`、`reason`、`holder`の制御文字を空白にして表示する。 | [保留](internals/holds.md#保留) |
| <a id="r-hold-32"></a>R-HOLD-32 | 保留で待つPRが増えても取得の通知は周回ごとに種類ごとの1件に保つが、監視の対象から外れたリポジトリの通知は、読まないので解決しない。保留は1行が最長24時間なので、受け入れる。 | [保留](internals/holds.md#保留) |

## 凍結とdeployの保留

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-frz-01"></a>R-FRZ-01 | 凍結はWindmillの変数なので、`f/factory`に書ける主体は凍結を書き換えられる。この権限を持つ主体は、スケジュールそのものも書き換えられるため、凍結が増やす危険は無い。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-02"></a>R-FRZ-02 | `CLAUDECODE`とTTYによる`session`と`human`の区別は、誤操作を防ぐためで、権限の境界ではない。環境の差し替えと、端末を与える経路で通れる。守る対象が誤操作であり、悪意のある主体は`f/factory`に書ける権限で直接書き換えられるため、受け入れる。主セッションのフックも、書き込みを`mise run <タスク>`の単独の行に絞って誤操作を止める発見的な検査で、境界ではない。人の確認の境界は、CLIの端末での確認と、Claude Codeの権限の流れのほうである。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-03"></a>R-FRZ-03 | 凍結を覆わない操作がある。`wmill sync push`の直接実行と、凍結を取り込む前の作業ツリーの`mise run`である。特に、取り込む前の作業ツリーで`push:prune`(旧タスクの`wmill sync push --yes`)を走らせると、変数ごと削除される。`f/factory/freezes`が、除外にも手元のファイルにも無いためである。すべての凍結が、警告なしに消える。凍結は確認作業のための期限つきの補助であり、消えた場合の影響は、スケジュールが次の反映で戻るだけに限られるため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-04"></a>R-FRZ-04 | 凍結の道具のうち、`scripts/freeze.ts`、`f/factory/lib/freezes.ts`、`f/factory/lib/freeze_apply.ts`は保護パスに入れる。保留のCLIが起動のたびにこの3つを読み込み、書き換えられるとCLIの実行に任意の処理を足せるためである。`self_update`が行う凍結の通常の修正も、保護パスの変更になるので、人が確認してマージする。凍結の変更が人に回るのは、凍結の仕組みの修正が、保留のCLIの実行にも効くためで、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-05"></a>R-FRZ-05 | 保護パスに入れていない`f/factory/lib/freeze*.ts`のファイルは、ホストのユーザーの権限で動く。動かすのは、`scripts/bootstrap.sh`の全手順のモードと、`mise run push`、`deploy`である。これらのファイルを書き換えるPRがマージされると、次の実行でその内容が動く。正当な変更を止めたくないため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-06"></a>R-FRZ-06 | 同時書き込みで、行が失われうる。`self_update`の行の削除と人の`place`が重なる窓はミリ秒から秒、CLI同士が重なる窓は秒単位である。`place`は書いた後に読み直し、自分の行が残っているかを確かめる。窓が短く、運用手順に止める直前の`freeze:list`による確認を置いているため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-07"></a>R-FRZ-07 | 同じ`target`の凍結を、期限ごとに置き直し続けられる。1回の上限が24時間で、置けるのは書き込み権限を持つ主体だけだから、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-08"></a>R-FRZ-08 | 凍結の変数を壊すと、反映が要る回は`freeze:reset`まで止まる。壊れた状態のまま反映すると、凍結を無視して上書きするおそれがあり、止めるほうが安全なため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-09"></a>R-FRZ-09 | 追従のpushは、凍結を置かずに画面で止めたスケジュールも含め、リポジトリの定義へ全体を書き戻す。リポジトリの定義が正であり、画面での変更を残す仕組みは、そもそも無いため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-10"></a>R-FRZ-10 | 別の端末で始まった`mise run push`と`deploy`のpushには時間の上限が無い。`place`が示す7分の保証は、`self_update`のpushだけを数えている。別の端末のpushは人が始めるので、人が凍結の時刻を意識して実行できるため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-11"></a>R-FRZ-11 | 終わってから24時間を過ぎた行は、次の`place`で捨てられ、追従のpushが行われない。スケジュールは次の反映で戻るため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-12"></a>R-FRZ-12 | `wmill variable list`が100件以上を返すと、変数が無いと判定できず、読み取りの失敗になる。失敗側に倒れるので、誤って反映することは無く、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-13"></a>R-FRZ-13 | 安全策の全体が、`wmill`のCLIの挙動に依存する。`--excludes`がカンマ区切りで別のパターンとして効くことと、`wmill.yaml`の`excludes`を置き換えることである。CLIは1.817.0に固定しており、版を上げるときは`mise run push:dry`で、`deployed_sha`と凍結中のスケジュールが変更に出ないことを確かめるため、受け入れる([更新の反映の運用の「ホスト側で反映するもの」](operations/deploy.md#ホスト側で反映するもの))。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-14"></a>R-FRZ-14 | 書く段が10秒の時間切れになっても、`setVariable`の要求は止まらず、ジョブが終わるまで遅れて届きうる。窓は、時間切れのときその分だけ延びる。運用手順に、止める直前の`freeze:list`による確認を置いているため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-15"></a>R-FRZ-15 | 凍結の行を消す書き込みが続けて失敗すると、追従のpushが2分ごとに、通知なしで(警告のログだけで)繰り返される。同じ定義を書き戻すだけで害が無く、書き込みが通れば止まるため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-16"></a>R-FRZ-16 | deployの保留は止めるためだけに使い、許可には使わない。保留を偽造しても、起きるのは反映の遅れだけで、何かを通すことは無いため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-17"></a>R-FRZ-17 | 作成が未来の行や、期限が遠い先の行は、反映の経路が壊れた変数として扱う。読めない扱いなので、反映が要る回は失敗の記録に残り、版の食い違いの通知は出る側に倒れる。反映が不要な回の追従は、警告だけで見送られる。`freeze:list`と`hold:list`は、現在時刻を使わず、行をそのまま表示する。人が行を確かめて`freeze:reset`で消せるためである。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-18"></a>R-FRZ-18 | 保留を読んだ後に始まった`self_update`の回は、止まらない。`place`が示す13分は、その回のpushとmigrationが終わるまでの目安である。待ってから作業する決まりを運用手順に置いているため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-19"></a>R-FRZ-19 | 保留が有効なあいだ、`self_update`は反映全体を見送る。migrationより後のコミットの通常の反映も待たされる。保留の上限は120分で、置けるのは書き込み権限を持つ主体だけだから、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-20"></a>R-FRZ-20 | 見送りの通知は出ない。新しい通知を足すと、ジョブの時間の余裕を減らすためである。ログと`freeze:list`で確かめる。版の食い違いの通知(`deployed_sha_mismatch`)は、保留中は出さず、読めないときは出す。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-21"></a>R-FRZ-21 | deployの保留の配列`deploy_freezes`を知らない版が、この配列を落とすことがある。知らない版の`self_update`と`freeze.ts`は、スケジュールの凍結を書き戻すときに、この配列を書かない。知らない版の`self_update`は、保留を効かせない。作業の途中で落ちた保留は、開始時の確認では検知できない。運用手順に、作業の直前と終わりに`freeze:list`で確かめる手順を置いているため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-22"></a>R-FRZ-22 | Consoleから凍結とdeployの保留を解除できる。ログインした管理者は、変数に直接書ける権限をすでに持つので、権限は増えない。1回の呼び出しで届く道が増える。解除は止めが外れる向きだが、期限で必ず終わり、置き直せるため、受け入れる。解除した操作者は変数の行に残らないので、情報の通知とジョブの記録に残す。通知の書き込みが失敗しても、解除は取り消さず、画面が知らせる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-23"></a>R-FRZ-23 | `freeze_release`の変数の読み直しと書き込みは排他しないので、CLIや`self_update`と重なると、他の行を黙って消すか、解除を巻き戻すことがある。窓は秒単位で、運用手順に止める直前の`freeze:list`による確認を置いているため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-24"></a>R-FRZ-24 | `session`がdeployの保留を確認なしで置ける区別は、誤操作を防ぐためのもので、境界ではなく、上限は120分である。subagentを止める`hold-guard.ts`の拒否はベストエフォートの規則で、保留の拒否と同じ限界を持つ。`git diff \| bunx prettier --stdin-filepath a.ts -`のように、標準入力をコードでなく入力として読む正当な形も、`-`とパイプで拒否する。誤拒否になるが、コードとの区別が語からは付かないため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-25"></a>R-FRZ-25 | ローカルのセッションが打つ`wmill datatable migrate up\|down`と`wmill sync push`は、`merge-guard`がdeployの保留で止める。`scripts/bootstrap.sh`の全手順のモードのmigrationも、`freeze.ts migrate`を通るので止まる。人の端末(`!`)と、ホストの実行役(`scripts/host_apply/`)は止まらない。端末は人が意図して実行する経路で、実行役は承認の門を別に持つため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-26"></a>R-FRZ-26 | `mise run up`と`mise run deploy`の先頭の確認は、読めないと警告だけで通る。Windmillが止まっているとき、スタックを起こせなくなるためである。後段の`push`と`migrate`は読めないと拒否するので、読めないまま反映が進むことは無い。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-27"></a>R-FRZ-27 | 24時間を超えて保留が続くと、`self_update`が追従するはずだった終わったスケジュールの凍結の行が、次の`place`で捨てられうる。捨てた行は追従されず、スケジュールは次の反映で戻るため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-28"></a>R-FRZ-28 | セッションは、`freeze.ts`の`push`、`place`、`release`を確認なしで実行できる。ユーザー全体の許可と`.claude/settings.json`の許可(`bun run scripts/`など)が通るためである。`prune`付きのpushを止める根拠は、`CLAUDECODE`の判定と端末の確認だけである。`prune`付きのpushが消すのは、人が`push:dry`で確かめる対象であり、誤操作を防げれば足りるため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |
| <a id="r-frz-29"></a>R-FRZ-29 | 除外を作る`parseWmillExcludes`は、`wmill.yaml`の最上位の`excludes`だけを読む。`workspaces.<name>`の`overrides`に`excludes`を足すと、CLIの`--excludes`が黙って置き換えるので、足さない。足さない決まりを守れば、読み違いは起きないため、受け入れる。 | [凍結とdeployの保留](internals/freezes.md#凍結とdeployの保留) |

## PR修正の安全策

### 修正と実装で範囲が違う理由

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-fix-02"></a>R-FIX-02 | PRの修正の一覧が、実装の一覧より狭いことは、設計の理由では説明できない。この差は、残るリスクとして受け入れる。 | [修正と実装で範囲が違う理由](internals/pr-workflow.md#修正と実装で範囲が違う理由) |
| <a id="r-fix-28"></a>R-FIX-28 | 通常の修正の回は、無視されたファイルを`FORBIDDEN_*`の判定に入れない。Claudeが`.gitignore`に無視の規則を足せば、新しく作る`.env`や`bunfig.toml`も、検査が読むまで止まらず、PRに跡が残らない。Claudeが読む文には運用者以外の文が入りうるが、この差を守る条件は置かずに受け入れる。Claudeが書いたソースとテストも検査で実行されるので、判定を広げて減る実行は、lockfileなどが取得する依存の中身に限られ、そのために通常の回を止める費用は、個人のローカル運用では見合わないためである。 | [修正と実装で範囲が違う理由](internals/pr-workflow.md#修正と実装で範囲が違う理由) |

### gitが読む設定を限る

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-fix-03"></a>R-FIX-03 | 固定していないgitの設定(`url.*.insteadOf`、`filter.*`、`merge.*.driver`、`core.alternateRefsCommand`、`core.worktree`など)は、そのまま読まれ、プログラムを実行したり作業ツリーを変えたりしうる。`git gtr new`のcheckoutは`GH_TOKEN`を持つ環境で動くので、`.git/config`の`filter.<名前>.smudge`や`process`を、PRの内容の`.gitattributes`が指名すると、`GH_TOKEN`を読めるプログラムが動く。検査コマンドは検査用のユーザーで動き、main cloneの`.git`に書き込めないので、検査コマンドが`.git/config`を書き換えて、`GH_TOKEN`を持つgitにプログラムを実行させる経路は無い。根本の対処は、ネットワーク操作とcheckoutを分け、checkoutを`localGitEnv`で行うことである。 | [gitが読む設定を限る](internals/pr-workflow.md#gitが読む設定を限る) |

### PRの状態とheadの確認

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-fix-04"></a>R-FIX-04 | 残るリスクとして、準備からpushまでの間に、PRのauto-mergeを有効にされたり、headのブランチを保護されたりする窓が残る。pushの直前に確かめ直すのはheadのshaだけで、auto-mergeと保護は読み直さないためである。窓は修正の実行時間ほどの長さになる。auto-mergeの有効化にもGitHubの書き込み権限が要るので、受け入れる。 | [PRの状態とheadの確認](internals/pr-workflow.md#prの状態とheadの確認) |

### CIのログの扱い

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-fix-05"></a>R-FIX-05 | 切り口にかかった秘密値の一部は、トークンの形の文字列を切る前に伏せることで緩和している。この緩和が効くのは、接頭辞が分かる形の秘密値に限る。全文のgitleaksの検査は、伏せる前に行うので、本物の秘密値はここで止まる。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-06"></a>R-FIX-06 | 生のログの先頭と末尾を残す境目では、秘密値が分断される。分断された後半は接頭辞を持たないので、伏せられず、gitleaksにも検出されない可能性がある。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-07"></a>R-FIX-07 | base64などで符号化された秘密値と、複数の行に分割された秘密値は、gitleaksと`maskSecrets`で検出できない可能性がある。Actionsが自動で伏せる範囲に頼る部分が残る。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-08"></a>R-FIX-08 | 抑制の記述の検出は文字列の照合なので、別の書き方で検査を無効にする変更は検出できない。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-09"></a>R-FIX-09 | CI回のテストの期待値の書き換えは機械では判定できず、再レビューに頼る。PRが足した行の書き換え、同じhunkの中で別の行へ置き換える変更、何もしない行(`void 0;`、`;`、`if (false) ...`など)への置き換えも検出できない。再レビューは、PR全体の差分を読み、CI回のcommit単体の差分(書き換え前後の行)は入力に無い。書き換えは、最終の形が新しいコードとして読まれ、気づかれない可能性が残る。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い)、[既知の限界](internals/ci-fix.md#既知の限界) |
| <a id="r-fix-10"></a>R-FIX-10 | 空白を無視した差分で行の位置がずれることについて、次の2点を受け入れている。隣り合う同じ内容の行は、どちらがPRの追加かを決められず、基点の行がPRの追加に見えることがある。字下げだけが違う複製の行は、同じ行と見なされる。字下げに意味がある言語のテストでは、基点の行がすり替わりうる。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-11"></a>R-FIX-11 | どのファイルへでも、PRが移した行はPRの追加に見える。基点のテストの行を消して別のファイル(新しいファイルを含む)へ移したPRでは、移した行を1行ずつ書き換える変更が通る。名前の変更も検出しない。行を削る変更は、意味のある追加行より多く減らせないので通らない。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い)、[既知の限界](internals/ci-fix.md#既知の限界) |
| <a id="r-fix-12"></a>R-FIX-12 | CIのログは、`gh`が署名付きURLへの302を内部でたどって取得する。認証情報が別のホストへ渡らないことは、`gh`の挙動に頼る。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い)、[ログの取得](internals/ci-fix.md#ログの取得)、[既知の限界](internals/ci-fix.md#既知の限界) |
| <a id="r-fix-13"></a>R-FIX-13 | 拒否した安全装置が直接importするモジュールのうち、`db`、`discord`、`poll_support`、`implement_*`などの共有モジュールは、拒否せずに受け入れている。CI回のClaudeが、PRがすでに変更していればこれらを書き換えられる。受け入れた一覧と理由は、テストが固定する。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-14"></a>R-FIX-14 | 受け入れた共有モジュールに`approver.ts`がある。31行で安定しており、承認の`approval_decide`が以前から同じ依存を持つ。CI回が変えても影響は操作者の名前に限られ、Consoleの解除は導けないときに拒否する。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-15"></a>R-FIX-15 | ルートの`AGENTS.md`、`CLAUDE.md`、`AGENTS.wmill.md`、`.gitignore`と、安全装置以外の`*.script.yaml`は、拒否の一覧に無い。PRがすでに変更していれば、CI回のClaudeが書き換えられる。影響は、マージの後か、人の対話セッションで読まれたときに現れる。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-16"></a>R-FIX-16 | `github.ts`は、CI回のClaudeが変更できない。Factory自身の修正PRのCIが`github.ts`の不具合で落ちても、CI回は直せずに人へ渡す。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い) |
| <a id="r-fix-27"></a>R-FIX-27 | テストの行がPRの足した行かを行の位置で判定するとき、整形で1行が複数行に分かれると、分かれた行がPRの追加になる。この扱いは受け入れている。CIの自動修正の回の、削除された行の数え方も同じである。 | [CIのログの扱い](internals/pr-workflow.md#ciのログの扱い)、[検証のステップ](internals/ci-fix.md#検証のステップ) |

### マージの競合を解く回(PR修正の安全策)の残るリスク

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-fix-17"></a>R-FIX-17 | 意味的に誤った解消(片側を丸ごと採るなど)は、検査では検出しきれない。後続の自動レビューと人のレビューが止める。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-18"></a>R-FIX-18 | ローカルのブランチは、基準コミットを作ってから、pushが済んだ後も、衝突マーカー入りのコミットを指す。通常の回の`commitAndPush`は、`requireLocalHeadAtExpected`でローカルのHEADを確かめて止める。戻すのは、次にworktreeを使うときの`reset --hard`である。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-19"></a>R-FIX-19 | mergeが始まった後に例外が出ると、`merge --abort`をベストエフォートで行う。取り消しが失敗したworktreeは、mergeの途中のまま残りうる。呼び出し側は、次にworktreeを使うときの`reset --hard`と`clean -fd`で戻す。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-20"></a>R-FIX-20 | 署名の変更や、自動でmergeされた箇所に足した呼び出しの食い違いは、検査では見つからない。検査コマンドの失敗として現れる。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-21"></a>R-FIX-21 | 新しく足した行の検査は、JavaScriptとTypeScriptの記法だけを見る。ほかの言語の読み込みや抑制の記述は、検査を通る。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-22"></a>R-FIX-22 | マージの競合を解く回は、`git merge`を呼ぶ経路を新しく足す。`merge.<名前>.driver`は、`.gitattributes`が名前を指名し、`.git/config`の定義がプログラムを動かす。名前が対象ごとに変わるので、名前で固定して潰せない。定義を置けるのはmain cloneの`.git/config`で、検査コマンドは書き込めない([検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限))。この前提で抑え、書き込める経路が増えたときは残るリスクになる。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-23"></a>R-FIX-23 | mergeコミットのpushの直前の照合とpushの間に、人がブランチを祖先へ巻き戻す窓が残る。巻き戻されたブランチへも、pushは通る。`commitAndPush`と同じ窓として受け入れる。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-24"></a>R-FIX-24 | 属性の検査は、競合ファイルだけにかける。両側が変えたが競合しなかったパスの属性は調べない。そのパスの自動のmergeでも、属性の指名したドライバが動きうる。`merge.<名前>.driver`の項([R-FIX-22](#r-fix-22))と同じ前提で抑える。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-25"></a>R-FIX-25 | 差分の大きさの上限(`max_fix_changed_files`と`max_fix_diff_lines`)は、基準コミットから解消後の作業ツリーまでの編集にかける。baseがPRに持ち込む差には、かけない。baseの側の変更はレビューとマージを経ているので、受け入れる。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |
| <a id="r-fix-26"></a>R-FIX-26 | 競合回の完了ステップは失敗をDiscordとnoticeに通知しないので、完了のステップで検出したイメージの古さは、行の起動の回数の上限に達して`rounds_exhausted`になるまで、通知が無い。通知を競合の行の側に集めるためである。 | [マージの競合を解く回(PR修正の安全策)](internals/pr-workflow.md#マージの競合を解く回pr修正の安全策) |

## 検査コマンドの権限

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-chk-01"></a>R-CHK-01 | 検査用のユーザーは、`/workspaces`の下の他のリポジトリのcloneとworktreeを読める。cloneのURLにトークンは無い。`/workspaces/<owner>/<repo>`を0700にすると、worktreeの受け渡しと衝突しやすいので、今は受け入れる。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-02"></a>R-CHK-02 | 検査が並行して動く構成にしたときは、検査の間でもworktreeのファイルは読める。書き込めるのは、検査が権限のビットかACLで誰でも書けるようにしたものだけで、そこに置かれたものは取り戻しでrootに戻り、ACLも消える。ハードリンクで置かれたものは、worktreeの外のリンク先ごとrootに戻る([所有権の取り戻し](internals/check-sandbox.md#所有権の取り戻し))。HOMEは他の枠から書けないが、0755にされると読める。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-03"></a>R-CHK-03 | 検査コマンドは、workerと同じコンテナとnetworkで動く。DBとWindmillの宛先に届く。認証に使う秘密には届かないが、認証が要らない経路には届く。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-04"></a>R-CHK-04 | メモリとCPUはworkerと共有する。検査コマンドがworkerのジョブを枯渇させうる。プロセス数は、検査が上限まで使い、飛ばした枠が2つ残っても、検査の外に256が残るように抑える。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-05"></a>R-CHK-05 | 検査がworktreeの中身を書き換えた結果は、次のラウンドでrootの処理に影響しうる。例えば、gitが無視するパス(`node_modules/`など)に、worktreeの外を指すsymlinkを置ける。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-06"></a>R-CHK-06 | 共有の一時ディレクトリとSystem VのIPCは、並行して動く別の枠の検査と共有する。権限で開いたものは、別の枠から読み書きできる。同じuidを次に使う実行には、枠を取るときに消してから渡す。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-07"></a>R-CHK-07 | `/proc/<pid>/cmdline`は誰でも読める。workerのプロセスの引数に秘密を載せない。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-08"></a>R-CHK-08 | `/var/lib/factory`の`requirements`と`audits`は0755で、検査用のユーザーが読める。`claude`は一覧を読めるが、中のファイルは0600である。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-09"></a>R-CHK-09 | Windmillが`/tmp/windmill`の権限を戻す契機は確かめていない。権限が戻ると、その間だけ`/tmp/windmill`を0700にする保護が外れる。検査の前には、毎回0700へ直す。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-10"></a>R-CHK-10 | 共有の一時ディレクトリの下にある、rootが所有する誰でも書き込めるファイルは数えない。検査用のユーザーは、その中身を書き換えられる。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-11"></a>R-CHK-11 | 共有の`/tmp`に作られる一時ファイルは、まだ無い名前なら検査用のユーザーが先に作れ、その後でrootのジョブがそれを使いうる。`TMPDIR`を渡さないworkerのプロセス自身(Windmillとbunの依存の取得など)は、共有の`/tmp`を使う。ClaudeのBashツールが固定の名前で`/tmp`の下に書く場合は、`TMPDIR`では塞げない。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-12"></a>R-CHK-12 | 取り消されたジョブが残した、枠のuidの孤児プロセスは、同じ枠が次に使われるか、そのworktreeが次に使われるまで残る。その間は、記録したworktreeと`HOME`を書き換え、共有の一時ディレクトリにファイルを作りうる。取り消されたジョブでは手放すときの片付けが走らないので、共有の一時ディレクトリのものは、同じ枠が次に使われて消されるまで残る。片付けでプロセスを止めてから取り戻すので、次にそのworktreeを使う実行と、その枠の次の利用者には引き継がれない。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-13"></a>R-CHK-13 | 所有権の受け渡しと取り戻しはディレクトリの数に比例して時間がかかり、1回の上限の300秒を超えると打ち切られて検査が失敗する。ディレクトリごとの受け渡しでは、1個あたり約0.6ミリ秒なので、約50万個で上限に達する。この数は余裕を含まない切れる点なので、負荷のあるworkerでは手前で切れうる。打ち切られると記録が残り、次にその枠を取る実行と、そのworktreeを次に使うステップの片付けも、同じ上限で失敗し続ける。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-14"></a>R-CHK-14 | 一括の受け渡しと戻しは、worktreeの下にマウントが無いことを前提とする。`chown -R`には`-xdev`に当たるものが無く、別のファイルシステムのマウントがあれば、そこへ入るためである。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |
| <a id="r-chk-15"></a>R-CHK-15 | コンテナで共有するカーネルの脆弱性による脱出は防げない。 | [検査コマンドの権限](internals/check-sandbox.md#検査コマンドの権限) |

## dependabotの更新の自動マージ

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-dep-01"></a>R-DEP-01 | 上流が侵害された版でも、公開の日数、関門、影響調査をすべて通ればマージされる。公開の日数の待ち、registryとの整合性の照合、影響調査が、その機会を減らす。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-02"></a>R-DEP-02 | 影響調査の判断は誤りうる。マージの後の動作を最後に確かめるのは、必須チェックである。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-03"></a>R-DEP-03 | 一覧は、ページの上限(10ページ、1000件)を超えると失敗する。公開の明示リポジトリで第三者が1000件を超えるPRを開くと、一覧が失敗し続け、そのリポジトリのdependabotのPRを処理できない。一覧を読むのは、収集が止まっているか、そのリポジトリの記録を使えない間と、収集が集めないリポジトリ(`owners`に無い所有者の`factory_repo`、fork、先頭が`.`のリポジトリ名など)である。収集が集めないリポジトリでは、収集が動いていても当たる。失敗は`failed`に数え、失敗の記録として残る。 | [候補の元を確かめる](operations/features.md#候補の元を確かめる)、[dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-04"></a>R-DEP-04 | セキュリティ更新と版の更新を区別しない。どちらも同じ関門を通る。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-05"></a>R-DEP-05 | `node_modules`の下の`CLAUDE.md`と`AGENTS.md`は、単独の実験では読み込まれなかった。ただし、Claudeのバージョンが変わると結果が変わりうるので、更新のたびに同じ実験をやり直す。依存が同梱する指示のファイルが読み込まれれば、影響調査の判断に指示を注入される窓が開く。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-06"></a>R-DEP-06 | `main`が頻繁に動くと、マージの直前の確認で取り消しが続き、3回で人に回る。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-07"></a>R-DEP-07 | 共有のモジュールは保護していないので、書き換える変更はレビューで止める。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-08"></a>R-DEP-08 | 作ってから保持期間に近い日数がたったPRは、処理済みの記録が消えうる。そのため、評価せず人へ回し、自動では処理しない。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-09"></a>R-DEP-09 | グループの更新では、複数のパッケージの相互作用が、影響調査のClaudeの判断に依る。パッケージが増えるほど調査が浅くなりうる。変更履歴どうしの影響も、機械では確かめない。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-10"></a>R-DEP-10 | 名前の網羅検査は補助にすぎない([グループの更新](internals/dependabot.md#グループの更新))。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-11"></a>R-DEP-11 | `factory_repo`の値か、その読み込みを書き換えられると、他のリポジトリがマージの経路に入りうる。他のリポジトリを人に回す条件は、`factory_repo`の値と、その読み込み(保護パスの外の`config.ts`)を信頼する前提に立つ。`factory_repo`を書き換えられる者は、`self_update`などで全体を握れるので、新しいリスクではない。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-12"></a>R-DEP-12 | ルールの読み取り(`listBranchRules`)は、保護パスの外の`lib/github.ts`にある。偽の値を返すように書き換える変更は、チェックの一覧(`listPrChecks`)と同じく、PRのレビューだけが止める。解釈と検証は保護パスの`requiredChecksFromRules`にある。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-13"></a>R-DEP-13 | `repo_allowlist`の他のリポジトリを処理していた環境では、`dependabot_other_repos`を足した版の反映後、`dependabot_other_repos`に挙げるまで、そのリポジトリのdependabotのPRを処理しない。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-14"></a>R-DEP-14 | `dependabot_group_enabled`の既定値は、保護パスの外の`config.ts`にある。Factoryの修正が書き換えても保護パスでは止まらず、PRのレビューだけが防ぐ。`dependabot_merge_enabled`も同じである。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |
| <a id="r-dep-15"></a>R-DEP-15 | グループのPRは、メンバーが新しい版を出すたびにheadが変わり、待ちの記録が作り直される。待ちの上限は単独の更新と同じ規則で、人に回るのが遅れうる。 | [dependabotの更新の自動マージ](internals/dependabot.md#dependabotの更新の自動マージ) |

## 反映の承認

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-dap-01"></a>R-DAP-01 | `self_update`の配線が使う保護の外の部品を書き換えて、判定を外す変更は、保護パスに触れないまま反映される。部品は、`lib/workspace.ts`の子プロセスの起動と、`lib/db.ts`の接続と通知である。配線の位置は保護されたテストが固定するが、部品の中身は固定しない。PRの人のレビューが守る。 | [反映の承認](internals/deploy-approvals.md#反映の承認) |
| <a id="r-dap-02"></a>R-DAP-02 | Windmillのscriptは同じdatatableの接続を持つ。保護の外の新しいscriptが承認の表へ承認の行を書く変更は、保護パスに触れないまま反映される。その後にそのscriptが動くと、承認を偽れる。参照の検出(`tests/scripts/deploy_approvals_wiring.test.ts`)は、名前の連結や動的SQLを見つけられない。 | [反映の承認](internals/deploy-approvals.md#反映の承認) |
| <a id="r-dap-03"></a>R-DAP-03 | Consoleの配信物(`console/`)は、`console_fetcher`がCIの後に取り込むので、反映の承認を通らない。保護パスに当たるConsoleのファイルの変更も、マージの後に配信される。 | [反映の承認](internals/deploy-approvals.md#反映の承認) |
| <a id="r-dap-04"></a>R-DAP-04 | 承認する人は、Consoleにログインできる人なら誰でもよい。承認者の区別はしない。 | [反映の承認](internals/deploy-approvals.md#反映の承認) |
| <a id="r-dap-05"></a>R-DAP-05 | 判定の範囲は、`self_update`が本番へ反映するファイル(`f/`と`migrations/`の下、`wmill.yaml`)に絞る。範囲の外の保護パス(`infra/`、`.github/`、`.claude/`、`scripts/`、lockfile、設定)の変更は、反映の承認を通らない。`infra/`はホストで人が`mise run up`するまで効かず、`.github/`はCIにだけ効く。`.claude/`のスキルと`scripts/`はローカルのセッションと人の道具で、`self_update`が反映しない。直近のmainの60件のマージでは28件が止まる。止まった間は、範囲の外の変更も反映されない。 | [反映の承認](internals/deploy-approvals.md#反映の承認) |

## RESTの検索の拒否

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-ghc-01"></a>R-GHC-01 | 拒否は、`callGhApi`を通る呼び出しにだけ効く。argv配列で`gh`を起動するのは`github.ts`だけである。`workspace.ts`のgit credential helperの`gh auth git-credential`は除く。静的テストが、argvの先頭に`gh`を置く配列を書くファイルが`github.ts`だけであることを確かめる。 | [RESTの検索の拒否](internals/github-collect.md#restの検索の拒否) |
| <a id="r-ghc-02"></a>R-GHC-02 | `fetch`でRESTを呼ぶ経路は、`callGhApi`を通らず、実行時の拒否が効かない。経路は、`github.ts`の`fetchIssueObject`、`lib/metadata_patch_download.ts`、GraphQLの`gh_graphql.ts`である。字面の`search/`だけを静的テストが止める。宛先は固定で、実害は無い。 | [RESTの検索の拒否](internals/github-collect.md#restの検索の拒否) |
| <a id="r-ghc-03"></a>R-GHC-03 | GraphQLの`search`のフィールドは拒まない。使う変更は、枠の消費を設計から見直す。 | [RESTの検索の拒否](internals/github-collect.md#restの検索の拒否) |
| <a id="r-ghc-04"></a>R-GHC-04 | endpointを文字列の組み立てで作る呼び出しは、静的テストが見つけられない。`callGhApi`を通る呼び出しなら、実行時の拒否が止める。 | [RESTの検索の拒否](internals/github-collect.md#restの検索の拒否) |
| <a id="r-ghc-05"></a>R-GHC-05 | 実行時の拒否が正規化するのは、先頭の`/`、大文字、絶対URLの3種類だけである。ドットセグメントとパーセントエンコードは正規化しない。呼び出し側は自前で組み立てた名前だけを渡し、その名前は`assertGitHubName`を通る。 | [RESTの検索の拒否](internals/github-collect.md#restの検索の拒否) |

## 実装の安全策

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-imp-01"></a>R-IMP-01 | `implement_prepare.ts`と`auto_retry_stale_image.ts`は保護パスではない。`approval_gate.ts`と`self_update.ts`は保護パスで、変更は人の承認を経て反映される。保護テストが固定するのは、表を呼ぶ字面と、表の宣言と取り込みの位置である。呼び出しの結果を条件にどう組み込むかは固定しないので、この範囲はPRの人のレビューと、保護パスの反映の承認が守る。 | [進め方ごとの承認](internals/implement.md#進め方ごとの承認) |
| <a id="r-imp-02"></a>R-IMP-02 | 比較交換が失敗した作業項目は、`picked`のまま、照合が失敗に移すまでの猶予の間、残る。その間、同じIssueに稼働中の作業項目があり、再投入は挿入に断られる。 | [進め方ごとの承認](internals/implement.md#進め方ごとの承認) |
| <a id="r-imp-03"></a>R-IMP-03 | 目印の探索は、区切りの行を足す前に作ったIssueを、作成済みと信じない。区切りの行を足す前に作ったIssueの番号を書けなかった投入は、同じキーの再送でIssueが二重になりうる。 | [進め方ごとの承認](internals/implement.md#進め方ごとの承認) |
| <a id="r-imp-04"></a>R-IMP-04 | ラベルを外さないので、assigneeを設定しない。Issueの担当者は空のままである。 | [進め方ごとの承認](internals/implement.md#進め方ごとの承認) |

## CIのメタデータの再生成

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-cif-01"></a>R-CIF-01 | 残るリスクとして、Bunのmacroとsdistのビルドが動いても、被害は次の理由で限られるので受け入れる。ランナーに本番の秘密は無く、ジョブの権限は`contents: read`だけである。さらに、受け取る側の内容の制限が、パッチの影響を絞る。 | [install script](internals/ci-fix.md#install-script) |
| <a id="r-cif-02"></a>R-CIF-02 | `windmill_worker_ci`の上流イメージをdigestで固定しないので、タグ(`WM_VERSION`)の指す中身が上流で変わると、変わったイメージで動く。ランナーに秘密が無く、受け取る側が依存の変わるlockを断るため、受け入れる。 | [受け取る側が必ず確かめること](internals/ci-fix.md#受け取る側が必ず確かめること) |
| <a id="r-cif-03"></a>R-CIF-03 | `wmill-lock.yaml`のhashの事前検査は、字句の近似で読むので、読み違いを突いて敵対的に避けられる余地がある。事前検査は悪意のあるPRに対する境界ではなく、悪意のないPRで古い`schema`やlockが最新のように書き直されるのを防ぐだけなので、受け入れる。悪意のあるPRは、人のレビューで止める。 | [hashの再計算](internals/ci-fix.md#hashの再計算) |

## カバレッジの検査

| ID | 残るリスクと、受け入れる理由 | 関連する節 |
| --- | --- | --- |
| <a id="r-cov-01"></a>R-COV-01 | 下限の定数と対象の定義は、implementフローのClaudeが書き換えられる。下限を下げたり、対象を狭めたりする変更が、検査を通りうる。人のレビューが、最後の関門になる。 | [残るリスク](testing-guidelines.md#残るリスク) |
| <a id="r-cov-02"></a>R-COV-02 | 層の下限を下げる変更と、`NOT_LOADABLE_BY_BUN_TEST`に足す変更は、検査を通りうる。止めるのは、人のレビューだけである。lcovに出ないファイルを一覧に足せば、対象を狭められる。ただし、パスの形、追跡、lcovに出ないことを機械で確かめるので、足せる幅は狭い。 | [残るリスク](testing-guidelines.md#残るリスク) |
| <a id="r-cov-03"></a>R-COV-03 | lcovは、検査されるテストのプロセス自身が書く。改ざんを防ぐ関門にならないので、検査はテストの質の保証ではなく、うっかりの退行を拾う網である。 | [残るリスク](testing-guidelines.md#残るリスク) |
| <a id="r-cov-04"></a>R-COV-04 | 読み込みのテスト(`tests/lib/coverage_load_all.test.ts`)の差し替えは、衛生のための検査で、セキュリティの境界ではない。このテストは保護パスに入れない。読み込みのテストで対象を減らすと、未読み込みの対象が出て失敗する。対象を広げる変更と、importだけのテストを足す変更は、止めない。lcovの改ざんと同じく、人のレビューで止める。 | [残るリスク](testing-guidelines.md#残るリスク) |
| <a id="r-cov-05"></a>R-COV-05 | ファイルごとの下限は持たない。読み込みだけで宣言の行が実行済みになるので、テストの無いstepの`main`が低くても、層の平均では守られない。 | [残るリスク](testing-guidelines.md#残るリスク) |

## 欠番

次のIDは、行をほかの行にまとめたので使わない。

- R-CRED-09
- R-FIX-01
