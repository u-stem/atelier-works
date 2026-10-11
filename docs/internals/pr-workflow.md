# PRワークフロー

PRのレビュー(`f/factory/pr_review`)とPRの修正(`f/factory/pr_fix`)のフローの内部の挙動、設定値、安全策の仕組みをまとめる。これらのフローのコードを変更する人が読む。運用の手順は[運用](../operations.md)に、作業項目の状態の一覧は[作業項目](work-items.md)に書く。

## 全体の流れ

PRワークフローは、Issueから要件定義を作る工程1と2とは別に、既存のPRをレビューし、修正する。対象は人が作ったPRと、実装フローが作ったPRである。

PRレビューは3つのステップでできている。

| ステップ | 役割 |
| --- | --- |
| `pr_review_prepare` | PRを取得して確かめ、レビュー用のworktreeを用意する |
| `pr_review_generate` | Claudeにレビューを書かせる |
| `pr_review_post` | レビューを投稿して記録し、worktreeを消す |

PR修正は5つのステップでできている。

| ステップ | 役割 |
| --- | --- |
| `pr_fix_prepare` | 安全のための確認をして、PRのブランチのworktreeを用意する |
| `pr_fix_collect` | 修正の対象にするフィードバックを集める |
| `pr_fix_apply` | Claudeに修正させる |
| `pr_fix_verify` | 変更を確かめ、検査コマンドを実行する |
| `pr_fix_finish` | commitしてpushし、返信して再レビューを依頼する |

PRに投稿するのは、PRレビューの指摘と総評、PR修正の返信だけである。失敗、人の対応待ち、ブロック、要件の不足といった運用上の知らせは、PRに書かずDiscordで知らせる。Issue化の提案の承認と却下の結果は、PRのスレッドに返信する。

## 起動条件

`poll_prs`がPRを見つけて作業項目を作り、フローを起動する。

| フロー | 起動条件 |
| --- | --- |
| PRレビュー | PRに`factory:review`ラベルが付いた |
| PRレビュー | PRのレビューの依頼先かassigneeがこのインスタンスのGitHubアカウントで、未処理のhead(`head_sha`)がある |
| PR修正 | PRに`factory:fix`ラベルが付いた |

トリガーのラベルは、着手(claim)したときに消費して外す。レビューの依頼とassigneeの経路には、消費するラベルが無い。ラベル名は`factory_config`の`review_label`と`fix_label`で決める。

PR修正はラベルからしか起動しない。コメントやcommitのpushだけでは起動しない。次のラウンドを始めるには、PRに`factory:fix`ラベルを付け直す。PRレビューが終わった(`reviewed`)PRにも付けられる。

修正への指示は、ラベルを付ける前に、PRへ通常のコメントとして書く。`pr_fix_collect`が、ほかの人のコメントと同じくフィードバックとして集める。

### 投稿者の関係の確認

レビューとコメントの投稿者の`author_association`が`allowed_labeler_associations`に含まれないとき、その投稿は起動の対象から外す。既定値は`OWNER`、`MEMBER`、`COLLABORATOR`である。

### ラベルの付与者の確認

`poll_prs`は、`factory:review`と`factory:fix`のそれぞれについて、そのラベルを最後に付けた人を、ラベルの`labeled`イベントの`actor`で確かめる。
許可されるのは、FactoryのPATのアカウントと、`allowed_labeler_logins`に挙げたアカウントである。
許可されない人が付けたラベルと、付与者を特定できないラベルは、外さずに残し、起動しない。
取得の直前にも、同じ確認をもう一度行う。
イベントを取得できなかったPRは、そのポーリングでは対象にしない。
付与者を判定できないPR(直近100件のラベルのイベントにトリガーラベルのイベントが無い)は、`labeler_check_limit`のnoticeを残し、ラベルを外して付け直すまで対象にしない。
仕組みの全体は[ラベル付与の制限](../security.md#ラベル付与の制限)にある。

レビュー依頼かassigneeによる起動と、追跡中のPRの新しいcommitによる再レビューは、ラベルを介さない。
この2つは、PRの作成者が許可されたアカウントのときに限る。
トリガーラベルが拒否された状態で付いているPRでも、始めない。
同じリポジトリのブランチから出した第三者のPRは、許可されたアカウントがラベルを付けたときだけレビューされ、新しいcommitのたびにラベルの付け直しが要る。

PRのheadが対象のリポジトリにないとき(forkのPRと、headのリポジトリを取得できないPR)は、ラベルの経路もラベルを介さない経路も、レビューを始めない。
`decidePrActions`が、始めるはずだったレビューを見送りとして返し、`poll_prs`が`fork_head_denied`のnoticeを残す。
ラベルは外さない。
`pr_review_prepare`も、作業項目を手で作るなどの経路に備えて、clone、fetch、worktreeの前に同じ確認をする。
通らなければ、作業項目を終端の`blocked`にして理由を残し、Discordで人に知らせてから、処理を飛ばす。
同じ判定は、PR修正の準備のステップの「forkからでない」確認と共有する。

### 対象のリポジトリ

対象は、`factory_config`の`repo_allowlist`に含まれるリポジトリだけである。`repo_allowlist`が空なら、`owners`に含まれるリポジトリのすべてが対象になる。`factory_repo`は`repo_allowlist`に関わらず常に対象である。

`poll_prs`は作業項目を作る前に許可リストで候補を絞る。作業項目を作った後で`factory_config`を変えることもあるので、両方のフローの準備のステップも許可リストを確かめ直す。

### ラベルを外した後の追跡

Factoryが扱ったPRには、トリガーのラベルのほかにラベルを付けない。状態は作業項目の状態(`work_items.status`)だけで表し、Consoleの**パイプライン**タブに表示する。

ラベルが外れた後も追跡を続けるため、`poll_prs`はDBからPRを見つけ直す。`f/factory/lib/db.ts`の`listTrackedPrs`が、次の条件をすべて満たす作業項目を返す。

- 種類(`kind`)が`pr_review`か`pr_fix`である。
- 状態が取り消し(`cancelled`)でない。
- `tracked_pr_days`以内に更新された。

`poll_prs`は、そのPRがまだopenであることを`getPr`で確かめてから候補にする。人が新しいcommitをpushすると、この経路でPRレビューが自動で起動する。1回のpushにつき、Claudeの実行は1回である。

`review_post_mode`が`gated`のときは、レビューを投稿しない。`gated`は検証用に予約した値で、承認を経て投稿する画面はまだ無い。このモードでは、PRはレビューの依頼かassigneeの経路でだけ見つけ直す。

## 自己再発火の防止

Factoryが投稿するIssueのコメント、PRのレビュー、レビューへの返信には、必ず目印(`<!-- factory:<kind>:<work_item_id> -->`)を入れる。目印は本文の最後の行に置き、判定では最後の行の目印だけを読む。

Factory自身の投稿かどうかは、`f/factory/lib/github.ts`の`isFactoryPost`で次の両方を満たすかで判定する。

- 投稿者のログインが、viewer(PATの持ち主のGitHubアカウント)と一致する。大文字と小文字は区別しない。
- 本文が、最後の行にFactoryの目印を持つ。

Factoryは人と同じGitHubアカウント(共有のPAT)で動く。そのため、ログインの一致だけでは人の投稿と区別できない。目印は誰でも本文に貼れるので、目印だけでも区別できない。

フィードバックとして扱わないのは、Factory自身のPR修正の返信(`pr_fix`の目印を持つもの)だけである。人が同じアカウントで書いたコメントは、目印が無いのでフィードバックになる。Factory自身のPRレビューと、その未解決のインラインの指摘もフィードバックになる。

## 作業ディレクトリ

対象リポジトリのメインのクローン(`/workspaces/<owner>/<repo>/main`)はfetchだけに使い、working treeをcheckoutしない。

PRレビューは、PRごとにdetachedのworktreeを作り、投稿のステップで消す。

```bash
git worktree add --detach /workspaces/<owner>/<repo>/review-<pr>-<sha7> <sha>
```

`<sha7>`はレビューするコミットのshaの先頭7文字である。準備のステップは、worktreeを作る間にheadのshaが動いていないかを最後にもう一度確かめる。生成のステップが早く抜けて投稿しなかったときも、投稿のステップがworktreeを消す。worktreeが残ると、同じshaを再実行したときに`git worktree add`が既存のパスで失敗するためである。

PR修正は、`git gtr new`で作るPRのブランチのworktreeを使う。PR修正の完了のステップはworktreeを消さず、後で`cleanup_workspaces`が片付ける。

## レビュー

生成のステップ(`pr_review_generate`)は、`factory-review`スキルと読み取り専用のツールで、headless Claudeを実行する。作業ディレクトリはレビュー用のworktreeである。

Claudeへの入力は次のとおりである。

- PRの本文
- PRの差分(`diff_max_lines`行で切り詰める)
- 変更されたファイルの一覧
- 承認済みの要件定義(PRが要件定義に紐づくとき)
- このPRへのFactory自身の未解決の指摘の一覧(再レビューのとき)

PRが要件定義に紐づくのは、Factoryの実装フローが作ったPRか、本文に`Closes #123`と書いたPRである。`Fixes`と`Resolves`も使える。`poll_prs`はそのIssueの承認済みの要件定義を探し、PRレビューとPR修正のClaudeに渡す。

日次予算を超えているか、時間設定がステップのtimeoutに収まらないときは、Claudeを起動せずに人の対応待ちにする。

再レビューでは、実質的に同じ内容の指摘を新しい指摘として投稿しない。新しい指摘と、変化があった指摘だけを報告する。差分で解消済みと判断できる指摘は何も報告しない。スレッドの解決は別の処理が行う。

レビューは常にGitHubのCOMMENTレビューとして投稿する。承認(approve)と変更の要求(request changes)は使わない。スキルが返す判定(`verdict`)は`factory.reviews`とDiscordに残すだけで、投稿の種類には使わない。

### 投稿の形

Factoryはレビューの開始のコメントを投稿しない。投稿するのは、インラインの指摘(コードの提案を含む)と総評だけである。指摘の形は`.claude/skills/factory-review/SKILL.md`の「投稿形式」に書く。

Factoryは運用者自身のアカウントで投稿する。そのため、総評とインラインのコメントは、1行目に`[pr_review 自動レビュー] @<author>`というロールタグとメンションを付ける。

ClaudeがGitHubに投稿する文章は、共通の文体の規則に従う。半角英数字と日本語の間に半角スペースを入れない(インラインコードとコードブロックの中は除く)。文体はです・ます調で、1文を1行に書き、要点が複数あれば箇条書きにする。規則の詳細は`factory-writing`スキルに書く。

### 通知の判定

投稿の後、Discordの通知の種類を決める。今回の指摘に`[MUST]`があるか、前回までの`[MUST]`の指摘が今回の解決の後も残っていれば、`changes_requested`にする。それ以外は`reviewed`にする。変更が要るのか、承認だけでよいのかを通知で見分けられるようにするためである。

PRレビューが終わると、作業項目はレビュー済み(`reviewed`)になる。

## 総評のパターン

総評はClaudeの自由記述ではなく、次の4つの定型からフローが組み立てる(`renderReviewSummary`)。Claudeの要約(`summary`)は`factory.reviews`に記録するだけで、GitHubには投稿しない。

| パターン | 条件 | 総評 |
| --- | --- | --- |
| 1 | 指摘を投稿した | 件数と「確認お願いします。」 |
| 2 | 再レビューで指摘が0件 | 「修正を確認しました。LGTMです。」と最終判断の一文 |
| 3 | 初回のレビューで指摘が0件 | 「指摘はありません。LGTMです。」と最終判断の一文 |
| 4 | 再レビューで指摘が0件だが、未解決の`[MUST]`が残る | 「新しい指摘はありません。未対応の指摘がN件残っています。確認お願いします。」 |

最終判断の一文は「最終的なApprove判断は人が行ってください。」である。パターン1と4には付けない。

パターン1は、初回と再レビューで共通である。行と紐づけられずに投稿できなかった指摘があるだけの場合も、パターン1である。再レビューとは、このPRへのFactoryのレビューが過去にある場合をいう。

行に紐づけられなかった指摘は、総評に並べる。並べる`path`と`message`は、`<!--`を`&lt;!--`に置き換える。`path`の改行は空白にまとめる。

## スレッドの解決

再レビューのたびに、PR修正が対応済みとみなせるFactory自身のスレッドを、ベストエフォートで解決(resolve)する(`selectThreadsToResolve`)。初回のレビューでは何も解決しない。

解決の対象にするのは、Factory自身のインラインの指摘のスレッドのうち、最後のコメントもFactoryが書いたものだけである。スレッドに人が返信していれば、対象から外して開いたまま残す。

| スレッドの状態 | 解決するか |
| --- | --- |
| PR修正がcommitのsha付きで「対応: `<sha>`」と返信した | 再レビューのたびに解決する |
| PR修正が「対応: 見送り」か「対応: 変更なし」と返信した | 人の判断が要るので解決しない |
| Factoryの指摘のまま、何も返信されていない | 指摘が0件の再レビュー(パターン2と4)で解決する |

何も返信されていないスレッドは、人が手で直した場合などに残る。解決の処理の後も開いたままの`[MUST]`のスレッドが1件以上あれば、パターン4になる。

## 投稿の冪等性

投稿のステップ(`pr_review_post`)は、投稿の前に、同じ作業項目が同じ`review_sha`に対して投稿済みのレビューを探す(`findPostedReview`)。見つかれば投稿せずに、そのレビューのidで`factory.reviews`に記録する。投稿と記録の間でステップが落ちても、再実行でレビューを二重に投稿しないためである。

総評には、レビューしたcommitのshaを表す目印(`<!-- factory-review-sha:<sha> -->`)を入れる。shaの目印は、PRレビューの目印(`<!-- factory:pr_review:<work_item_id> -->`)の前の行に置く(`withReviewMarkers`)。PRレビューの目印が最後の行に残るので、自己再発火の判定とPR修正の指摘の収集の読み方は変わらない。

投稿済みとみなすのは、次をすべて満たすレビューである(`findPostedReviewId`)。

- 投稿者がviewerである。目印は誰でも本文に貼れるので、投稿者も確かめる。
- 本文が、shaの目印とこの作業項目のPRレビューの目印でこの順に終わる。末尾の空白は無視し、CRLFはLFとして比べる。

本文の途中に貼られたshaの目印には一致させない。shaの目印の無いレビューは、どのshaに対するものか分からないので一致させない。

### 投稿済みのレビューを再利用するとき

再利用するときは、スレッドを1つも解決しない。再実行ではClaudeがレビューを作り直すので、新しい指摘が0件になりやすい。それを根拠に、投稿済みのレビューの指摘を閉じないためである。

代わりに、未解決の`[MUST]`のスレッドをすべて数える。再利用したレビュー自身の指摘も含める。1件以上あれば、Discordの通知を`changes_requested`にする。

前の実行がスレッドの解決の前に落ちていた場合、そのラウンドで解決するはずだったスレッドは開いたまま残る。これは人が確かめて解決する。

再利用には、既知の制約が2つある。

- 再利用したレビューの`[MUST]`のうち、行と紐づけられず総評に並べたものはスレッドにならない。そのため、残っている`[MUST]`の数に入らない。
- `factory.reviews`には、再実行で作り直した`verdict`と`findings`が、再利用したレビューのidと組で記録される。そのため、実際に投稿した内容と食い違うことがある。監査の証跡(`audit_evidence`)のレビューの数と指摘の集計は、この記録をそのまま数える。

### 投稿のステップの失敗

投稿済みのレビューを探すのに要るviewerとレビューの一覧を取得できないときは、投稿せずに失敗する。投稿済みかが分からないまま投稿しないためである。

再利用するときにスレッドの一覧を取得できなければ、記録する前に失敗する。このときも投稿は起きない。

投稿した後のGitHub APIの呼び出し(スレッドの解決)は、失敗しても警告を残して続ける。そのため、投稿済みなのに記録と状態の遷移が無い、という状態は残らない。

## 修正

### 止めたときの作業項目の状態

PR修正のステップの結果の`blocked`と、作業項目の状態のブロック(`blocked`)は別のものである。
修正と検証のステップは、続けられないときに止める結果(`blocked`)を返す。
完了のステップ(`decideFixFinishAction`)は、この結果の作業項目を人の対応待ち(`needs_human`)にする。

作業項目がブロックになるのは、次の3つのときだけである。

| 止めたところ | 例 |
| --- | --- |
| 準備のステップの確認([準備での確認](#準備での確認)) | PRがdraft、forkのPR、親のIssueの実装フローが実行中、worktreeの使用中、時間設定 |
| 完了のステップの、pushの直前の確認 | 修正の実行中にPRのheadが動いた |
| 要件の不足の差し戻しに成功した | [requirements_gapの差し戻し](#requirements_gapの差し戻し) |

それ以外で止めたとき(Claudeが止めた、日次予算、禁止された変更、検査の失敗、`.git`の書き換えなど)は、作業項目は人の対応待ちになる。

### フィードバックの収集

収集のステップ(`pr_fix_collect`)は、作業項目の処理済みの位置より新しいフィードバックを集める。処理済みの位置は[watermark](#watermark)に書く。集めるのは、PRのレビュー、インラインのレビューコメント、Issueコメントである。

Factory自身のPRレビューと、目印の無いインラインの指摘も集める。Factoryのレビューの後に`factory:fix`ラベルを付けるのは、その指摘を直させる操作だからである。集めるものが無ければ、「no actionable feedback」として人の対応待ちにする。

承認済みの要件定義は、このステップの結果で受け渡さない。修正と検証のステップが、親の作業項目(`parent_work_item_id`)から直接取得する。

### 修正の適用

修正のステップ(`pr_fix_apply`)は、`factory-fix`スキルでheadless Claudeを実行する。入力は、集めたレビューとコメント、未解決のコメント、承認済みの要件定義である。

Claudeは修正の結果(`outcome`)、理由、要約、各コメントへの返信、コミットの件名と本文を返す。日次予算を超えていれば、Claudeを起動せずに止める結果(`blocked`)を返す。Claudeの実行が失敗したときは例外を投げる。

### 検証

検証のステップ(`pr_fix_verify`)は、修正をpushしてよいかを確かめる。Claudeが要件の不足かブロックを返したときは、検証するものが無いのでそのまま返す。

検証は次の順に進む。

1. 変更を調べ、禁止された変更があれば止める結果を返す。
2. 検査コマンドを全件実行する。
3. 検査に失敗したら、日次予算の範囲で、失敗の出力を添えてClaudeの修正を1回だけ追加で実行する。
4. 変更をもう一度調べ、検査コマンドの全件をもう一度実行する。
5. それでも失敗するときは止める結果を返す。

変更を調べる時点と内容は[安全策の実装](#安全策の実装)に書く。

### commitとpush

完了のステップ(`pr_fix_finish`)は、commitの前に[コミットの前の再確認](#コミットの前の再確認)をする。続けてcommitしてpushし、各コメントに返信して、再レビューを依頼する。作業項目は再レビューの依頼済み(`rereview_requested`)になる。

コミットメッセージは、Claudeが提案する件名(`commit_subject`)と、任意の本文(`commit_body`)をフローがつないで作る。

- 件名はConventional Commitsの形で、50文字以内を目安にする。72コードポイントを超えると拒否する。
- 本文は箇条書きにする。
- `Co-Authored-By`と`Generated-By`のトレーラーは、`commitAndPush`の`withCommitTrailers`が付ける。
- 英数字と日本語の間のスペースを取り除く。コードスパンの中は除く。

pushするcommitが無くても、溜めた返信は投稿する。Claudeがすべての指摘を見送った場合も、返信をGitHubに届けるためである。この場合、作業項目は人の対応待ちになる。

### 再レビューの依頼

再レビューは`factory_config`の`default_reviewers`に依頼する。空なら、そのラウンドを起こしたレビューとコメントの投稿者に依頼する。PRの作者とFactoryのアカウントは依頼先から除く。

修正はpushまで済んでいるので、依頼の結果に関わらず作業項目は再レビューの依頼済みに進める。
依頼できなかったときの記録は、結果によって次のように分ける。

| 依頼の結果 | 作業項目の理由(`status_reason`) | notice | Discordの通知 |
| --- | --- | --- | --- |
| 依頼先の候補がいない | 残す | 残さない | 別に通知しない |
| 候補が全員除外された | 残す | 残さない | 別に通知しない |
| 依頼のAPIが失敗した | 残す | `pr_fix_reviewer_request_failed` | `pr_fixed`の通知の補足欄に載せる |

候補がいない場合と全員除外された場合は想定内で、人がすることは無い。
`pr_fixed`の通知そのものが、再レビューの依頼という結果を伝える。

依頼のAPIが失敗したときは、人がGitHubのPRでレビュアーを依頼する必要がある。
依頼の前のPRの取得(`getPr`)の失敗と、Botや削除済みの作成者の名前で依頼を組み立てられない場合も、APIの失敗として扱う。

## 返信の形式

返信は運用者自身のアカウントで投稿する。そのため、フローが固定の構造で組み立てる(`renderFixReply`)。1行目がロールタグ、続いて本文、末尾が対応の行である。形式は`.claude/skills/factory-fix/SKILL.md`の「返信形式」に書く。

各コメントへの返信は、次の3つの判断(`decision`)のどれかになる。

| `decision` | 意味 | 返信の末尾 |
| --- | --- | --- |
| `fixed` | このPRの範囲で修正した | `対応: <commit sha7>` |
| `skipped` | 対応しないと判断した。理由は`body`に書く | `対応: 見送り` |
| `propose_issue` | 指摘は妥当だが、このPRの範囲外なのでIssue化を提案する | `対応: Issue化を提案(承認待ち)` |

返信は、実際に集めたコメントの`review_comment_id`を指すものだけを扱う。Claudeの出力の全体は、監査のために`insertFixRound`がそのまま記録する。

## Issue化の提案

Claudeは`propose_issue`を選んだとき、修正を強行せず、Issueの`title`と`body`を返す。`pr_fix_finish`は、返信を投稿する前に提案を`factory.issue_proposals`に記録する。

- レビューコメントのスレッドのidは、`listReviewThreads`を使ってベストエフォートで解決する。
- コメントがPRのレビューコメントか、通常のIssueコメントかは、`is_inline`列に記録する。
- `matchReviewThreadForComment`は、コメントの`databaseId`でスレッドを照合し、`(path, line)`には頼らない。

提案が1件でもあるラウンドは、再レビューの依頼済みではなく人の対応待ちで終わり、レビュアーへの依頼もしない。Discordには「Consoleの承認タブで提案を承認または却下してください」と通知する。commitするものが無いラウンドでも、提案は記録する。

### 承認と却下の反映

人がConsoleの**承認**タブで決定すると、`f/factory/approval_decide`が決定を記録し、`f/factory/steps/issue_proposal_apply`を起動する。承認依頼の種類(`kind`)は`issue_proposal`である。要件定義の承認と同じく、人が判断してから進む仕組みである。

| 決定 | 処理 |
| --- | --- |
| 承認 | 提案の`title`と`body`でIssueを対象リポジトリに作り、スレッドに「Issue #Nを起票しました。」と返信して解決する |
| 却下 | スレッドに「見送りとします。」と入力した理由を返信し、スレッドは開いたままにする |

承認で作るIssueの本文では、`{{pr_url}}`を元のPRのURLに置き換え、末尾に起票元を示す一文を付ける。`with_factory_label`が真なら、作ったIssueに`factory_config.trigger_label`(既定値は`factory`)を付け、そのまま要件定義の工程に乗せる。偽なら起票だけをする。

返信の宛先は、`is_inline`列をもとに決まった方法で選ぶ。

### 状態の切り替え

対象の作業項目の提案がすべて決まると、作業項目の状態を人の対応待ちから切り替える(`decidePostProposalStatus`)。そのラウンドでcommitをpushしていれば再レビューの依頼済みに、していなければレビュー済みにする。未決定の提案が残る間は、人の対応待ちのままである。

### 再実行の安全性

同じ決定での再実行は安全である。途中でジョブが失敗しても、Issueを二重に作ったり、決定を上書きしたりしない。

- 承認者(`decided_by`)は、要件定義の承認と同じくfail-closedで導出する。
- 決定は、状態が`pending`であることを条件にしたUPDATEで1回だけ記録する(楽観ロック)。
- 作ったIssueの本文に`<!-- factory:issue_proposal:<id> -->`の目印を入れる。再実行では`findIssueByMarker`でこのIssueを探して再利用する。
- 決定済みの提案に違う決定を送ると、上書きせずにエラーで拒否する。

起票に失敗した提案は**承認**タブに残る。Issueの作成自体が失敗したときは、決定の前の`pending`に戻す。Issueの作成の後の返信、スレッドの解決、状態の遷移が失敗したときは、「承認済み・起票未完了」として残す。どちらも、もう一度承認すれば続きから起票する。

## watermark

処理済みの位置(watermark)は、`last_review_id`、`last_comment_id`、`last_review_comment_id`の3つである。収集のステップは、これより新しいフィードバックだけを集める。

watermarkを進めるのは、そのラウンドのフィードバックを実際に消化したときだけである(`shouldAdvanceWatermarks`)。

| 終わり方 | watermark |
| --- | --- |
| pushに成功した | 進める |
| pushに成功し、Issue化の提案があって人の対応待ちで終わった | 進める |
| 要件の不足を親のIssueに差し戻した | 進める |
| 失敗、人の対応待ち、ブロック | 進めない |
| 差し戻しに失敗した | 進めない |
| pushが反映されなかった(コミットメッセージが無い、headが動いた、commitするものが無い) | 進めない |

Issue化の提案があっても、元のコメントには提案で返信しているので、フィードバックは消化済みである。

結果が分かる前に進めてはならない。先に進めると、後のステップが例外で失敗したときに、watermarkがそのラウンドのフィードバックを越えてしまう。すると`retry_work_item`で再実行しても集めるものが無く、「no actionable feedback」の人の対応待ちになる。進めないことで、再実行が同じフィードバックを集め直せる。

## requirements_gapの差し戻し

修正中に要件の変更が必要になったとき、Claudeは要件や設計を自分で書き換えない。要件の不足(`requirements_gap`)を返して中断する。

完了のステップは、親の作業項目(`parent_work_item_id`)で元のIssueの作業項目を探し、工程2へ差し戻す。差し戻すのは、親が承認済み(`approved`)かPR作成済み(`pr_open`)のとき、つまり親のフローが動いていないときだけである。

1. 親の状態を、読み取った時点の`status`と`flow_job_id`のままであることを条件にした比較交換で、要件定義の生成中(`requirements_generating`)にする。同じ文で試行(attempt)を1つ増やし、`flow_job_id`を空にする。
2. 要件定義のフロー(pipeline)を起動する。
3. `flow_job_id`が空のままのときだけ、起動したジョブIDを記録する。
4. PR修正の作業項目をブロックで終える。

記録できなかったときは、比較交換の後に別の実行が親に書いている。そのときは、起動したジョブの取り消しを試み、`job_failures`に記録する。取り消しに失敗しても、起動したpipelineはリースを持たないので、作業項目を書き換えずに終わる。pipelineのリースは[作業項目](work-items.md)に書く。

次の場合は差し戻さず、PR修正の作業項目を人の対応待ちにする。PRへのリンクと次の操作をDiscordで知らせ、要件の不足の報告は通知の理由に載せる。

- 元のIssueの作業項目が見つからない。例えば、Factory製でないPRを手動で投入した場合である。
- 親にIssue番号が無い。
- 親が承認済みとPR作成済み以外の状態である(実装中、要件定義の生成中、承認待ちなど)。
- 親の試行回数が`max_attempts`に達している。
- 読み取った後に親の`status`か`flow_job_id`が変わり、比較交換に失敗した。

親が実装中になるのは、準備のステップが確かめた後に実装フローが動き出した場合である。差し戻さないのは、動いているフローや人の判断を上書きしないためである。

## 設定値

PRワークフローは`f/factory/factory_config`の次の値を読む。

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `review_label` | `factory:review` | PRレビューを起動するラベル |
| `fix_label` | `factory:fix` | PR修正を起動するラベル |
| `allowed_labeler_logins` | `[]` | ラベルを付けてよいアカウント。FactoryのPATのアカウントに加えて許可する |
| `allowed_labeler_associations` | `["OWNER", "MEMBER", "COLLABORATOR"]` | 修正の材料にする投稿者の関係 |
| `repo_allowlist` | `[]` | 対象のリポジトリ。空なら`owners`のすべて |
| `tracked_pr_days` | `30` | ラベルが外れた後もPRを追跡する日数 |
| `review_post_mode` | `comment_only` | `gated`ならレビューを投稿しない |
| `diff_max_lines` | `3000` | レビューに渡す差分の行数の上限 |
| `claude_timeout_sec` | `1800` | Claude 1回の実行と、PR修正の検査コマンド1件を打ち切る秒数 |
| `max_fix_rounds` | `3` | PR修正のラウンドの上限 |
| `allowed_check_commands` | `[]` | PR修正の検査コマンド |
| `max_fix_changed_files` | `30` | PR修正で変えてよいファイル数の上限 |
| `max_fix_diff_lines` | `1500` | PR修正の追加と削除の行数の上限 |
| `default_reviewers` | `[]` | 再レビューを依頼する人 |
| `daily_budget_usd` | `50` | 全フローで共有する1日の費用の上限(USD) |
| `max_attempts` | `3` | 要件定義の試行回数の上限 |
| `model` | `claude-sonnet-5-5` | PR修正のモデル。同じPRの修正が2回失敗した後は`heavy_model`を使う |
| `heavy_model` | `claude-opus-5-5` | PRレビューのモデルと、2回失敗した後のPR修正のモデル |

モデルの昇格に使う失敗の数は、同じPRの`pr_fix`の作業項目から数える。
次の3つを足す。

- Claudeが動いて`blocked`で終えた`fix_rounds`の行
- 検査の再実行(`pr_fix_verify_retry`)をした作業項目
- `agent_runs.error`がある失敗した実行の行

除く条件と数の理由は、[運用](../operations.md)の「モデルを使い分ける」にある。

PR修正のラウンドが`max_fix_rounds`を超えると、準備のステップが止め、作業項目は人の対応待ちになる。ラウンドの番号(`fix_round`)は、`poll_prs`が作業項目を作るときに入れる。PR修正の各ラウンドは別の作業項目になり、完了のステップは番号を増やさない。

## タイムアウト

`flow.yaml`の各ステップにはWindmillのtimeoutを付ける。アプリ側のtimeoutが効かなかったときに、最後に打ち切るためである。

| フロー | ステップ | Windmillのtimeout | 定数 | 理由 |
| --- | --- | --- | --- | --- |
| PRレビュー | 準備 | 1800秒 | なし | ロックの待ちだけで900秒かかりうる |
| PRレビュー | 生成 | 7200秒 | `PR_REVIEW_GENERATE_STEP_TIMEOUT_SEC` | Claude 2回分と余裕が収まる |
| PRレビュー | 投稿 | 5400秒 | なし | 個別の見積もりは無い |
| PR修正 | 準備 | 1800秒 | なし | ロックの待ちだけで900秒かかりうる |
| PR修正 | 収集 | 600秒 | なし | 個別の見積もりは無い |
| PR修正 | 修正 | 7200秒 | `PR_FIX_APPLY_STEP_TIMEOUT_SEC` | Claude 2回分と余裕が収まる |
| PR修正 | 検証 | 21600秒 | `PR_FIX_VERIFY_STEP_TIMEOUT_SEC` | 検査コマンドの2周とClaude 2回分が収まる |
| PR修正 | 完了 | 5400秒 | なし | 個別の見積もりは無い |

準備のロックの待ちは、factory cloneとリポジトリのロックの待ち(1回300秒、最大3回)である。定数は`f/factory/steps/pr_workflow_support.ts`にある。上限を上げるときは、`flow.yaml`と定数を同じ変更で上げる。`tests/scripts/pr_flows.test.ts`が両者の一致を確かめる。

### 時間設定の確認

Claudeは`claude_timeout_sec`で打ち切り、不正な出力の後に1回だけ再試行する。そのため、Claudeは1つのステップで`claude_timeout_sec`まで2回走りうる。各式の15秒は、Claude 1回か検査コマンド1件が打ち切りの後に上乗せしうる停止と出力待ちの時間である。600秒は、GitHub API、git、DBの操作の余裕である。

| ステップ | 見積もり | 収まらないとき |
| --- | --- | --- |
| PRレビューの生成 | 2 × (`claude_timeout_sec` + 15) + 600 | Claudeを起動せず、人の対応待ちにする |
| PR修正の修正 | 2 × (`claude_timeout_sec` + 15) + 600 | 準備でworktreeに触れずにブロックにする |
| PR修正の検証 | (2 + 2 × 検査コマンド数) × (`claude_timeout_sec` + 15) + 600 | 準備でworktreeに触れずにブロックにする |

検証の見積もりは、検査コマンドがあるときだけ確かめる。検査コマンドが無ければ、検証のステップは検査とClaudeを実行しない。

既定値では、生成と修正の見積もりは4230秒である。`claude_timeout_sec`は3285秒まで収まる。PR修正の検証は、既定値なら検査コマンド4件まで収まる。

PR修正で時間設定を確かめるのは準備のステップだけである。そのため、PR修正の実行中は時間設定を変えない。

### Windmillの再試行

PRレビューの生成とPR修正の修正のステップには、Windmillの再試行(`attempts: 2`)がある。

- PRレビューの生成は、timeoutで打ち切られた後に再試行されうる。読み取り専用のClaudeが2回目も起動し、費用がかかる。
- PR修正の修正も、timeoutで打ち切られた後に再試行されうる。打ち切られたClaudeがworktreeのロックを持ったままなら、再試行はロックを取れずにすぐ失敗する。

### Windmillのtimeoutで打ち切られたとき

打ち切られたステップが起動したClaudeや検査コマンドは残り、作業項目は失敗(`failed`)になる。残ったプロセスがworktreeを使っている間は、再実行しても準備のステップがブロックにする。

### rate limitを待てないとき

GitHub APIのrate limitの扱いは[通知](notifications.md)に書く。PRワークフローのステップで解除を待てないときの挙動は次のとおりである。

| ステップ | 挙動 |
| --- | --- |
| PRレビューの準備 | `GitHubRateLimitError`で失敗し、作業項目は失敗になる |
| PRレビューの投稿 | レビューを投稿する前なら、投稿せずに失敗する |
| PR修正の準備と収集 | `GitHubRateLimitError`で失敗し、作業項目は失敗になる |
| PR修正の完了 | pushの前なら、pushせずに失敗する |

PR修正の完了のステップで、pushの後のGitHub APIの呼び出しは、失敗しても続けるものと、ステップを失敗させるものに分かれる。

| 呼び出し | 失敗したとき |
| --- | --- |
| Issue化の提案のスレッドの取得 | 警告を残して続ける |
| 返信の投稿 | 警告を残して続け、noticeの`fix_reply_post_failed`を1件残す |
| 再レビューの依頼 | noteを残して続ける |
| 再レビューの依頼の前のPRの取得(`getPr`) | 再レビューの依頼の失敗として扱い、noteを残して続ける |

`fix_reply_post_failed`には、失敗した件数、`review_comment_id`、最初のエラーを載せる。Discordには通知しない。

## 再実行と中断

`retry_work_item`は、失敗、人の対応待ち、ブロックのPR修正の作業項目を再実行できる。watermarkはpushの成功か差し戻しでしか進まないので、それ以外の終わり方から再実行すると、前回と同じフィードバックを集め直す。
headがforkのPRのレビューが`blocked`になったときは、再実行すると、準備のステップが同じ理由でまた止め、Discordにも再通知する。PRを同一リポジトリのブランチから出し直す。

人の対応待ちとブロックの通知の次の操作は、修正のどこで止めたかで分ける(`nextAction`に渡すフロー`pr_fix`)。

| 止めたところ | 例 | 次の操作 |
| --- | --- | --- |
| 修正の前(準備のステップ) | PRがドラフト、親のIssueかブランチの実装フローが実行中、worktreeの使用中、時間設定 | `retry_work_item`で同じ作業項目を再実行する |
| 修正の後 | 要件定義への差し戻しの見送り、commitしたツリーが検査したツリーと違う、秘密情報の検査の後にworktreeが変わった、worktreeのHEADが動いた | `factory:fix`を付け直す |

修正の前に止めたときは、修正のラウンドを使っていない。
`factory:fix`を付け直すと新しい作業項目で修正のラウンドを1つ使うので、同じ作業項目のまま再実行させる。
修正の後に止めたときは、修正のClaudeを実行してそのラウンドを使い終わっているので、新しいラウンドとして付け直させる。

PR修正の準備は、worktreeを使っているプロセスがいても何も止めない。同じPR修正の前の実行のプロセスでも止めない。PR修正は実装フローのリースを持たないので、保持者が終わった実行の生き残りだと言えないためである。保持者を理由に載せてブロックにする。
人は、載ったプロセスが終わるのを待つか、workerのコンテナで止めてから、`retry_work_item`で再実行する。
workerの再起動は同じworkerのすべてのジョブを止めるので、載ったプロセスを止められないときだけにする。

PRレビューとPR修正の作業項目は、`retry_work_item`で再起動した後も`listTrackedPrs`の追跡の対象であり続ける。

## 安全策の実装

PR修正はClaudeに書き込みのツールを渡すので、次の安全策を持つ。実装フローと共通の仕組みは[実装フロー](implement.md)にも書く。安全策を変えたときのE2Eの検証は、本番のIssueやブランチではなく、捨てるブランチとPRで行う。

### Claudeに渡すツールの制限

PR修正のClaudeに渡すツールは`Read,Glob,Grep,Edit,Write`だけで、`Bash`は渡さない。起動のオプションは次のとおりである。

| オプション | 目的 |
| --- | --- |
| `--permission-mode dontAsk` | 確認なしで実行する。`Edit`と`Write`を拒否する既定の動作を上書きするため |
| `--allowedTools Edit Write` | `Read`、`Glob`、`Grep`に加えて、`Edit`と`Write`だけを許可する |
| `--restricted` | `Bash`などのコードを実行するツールと`WebFetch`を外し、ファイルのツールを作業ディレクトリ(`--add-dir`を含む)に閉じる |

`--restricted`はネットワークを遮断しない。PRレビューのClaudeには、読み取り専用のツールだけを渡す。

### 検査コマンドの実行

対象リポジトリの検査(lint、typecheck、testに当たるもの)は、Claudeではなく検証のステップが実行する。実行するのは`factory_config.allowed_check_commands`に書いたコマンドで、例えば`["mise run check"]`である。結果は、Claudeの2回目の実行(修正)への入力にする。

検査コマンドは、対象リポジトリのコードをworkerのコンテナ内でrootとして実行する。環境変数を最小にしても隔離にはならず、同じuidなので`/proc`を経由してジョブのトークンに届きうる。そのため、サンドボックス(別のコンテナ、非root、network none)ができるまで、既定値の`[]`を保つ。空でなければ、実行のたびにnoticeの`unsandboxed_check_commands`を記録する。

検査コマンドには、`PATH`と、実行ごとに作る非公開の`HOME`だけを渡し、秘密情報は引き継がない。終わったら`HOME`のディレクトリを消す。

検査コマンドが指す先(対象リポジトリの`mise.toml`や`package.json`のscriptsなど)は、信頼できない内容として扱う。workerのmiseは対象リポジトリの`mise.toml`をtrustしない(`mise --yes trust`をしない)。`mise.toml`に頼るコマンドと、`MISE_TRUSTED_CONFIG_PATHS`を使わずには実行できないコマンドは、実行せずにブロックとして報告する。

検査コマンドは1件ずつ`claude_timeout_sec`で打ち切る。出力の扱いは[実装フロー](implement.md)の[検査コマンドの出力の上限](implement.md#検査コマンドの出力の上限)と同じである。

### 禁止パスによる停止

修正の差分に次のどれかが含まれると、検証のステップが止める結果を返す。作業項目は人の対応待ちになる。

- `.claude/`、`.agents/`、`.github/workflows/`、`.mise/`、`.config/mise/`、`.lefthook/`の下のファイル
- `console/public/`、`infra/console_fetcher/`の下のファイル
- 個別のファイル(一覧は下の説明を参照)
- `mise.toml`、`mise.*.toml`、`.mise.toml`
- `lefthook.yml`、`lefthook-local.yml`、`lefthook.toml`、`lefthook.json`
- `bunfig.toml`、`.npmrc`、`.gitattributes`、`.gitmodules`
- markdownlintとmarkdownlint-cli2の設定(`.markdownlint.*`と`.markdownlint-cli2.*`。拡張子は`jsonc?`、`ya?ml`、`[cm]?js`)
- textlintの設定(`.textlintrc`と`.textlintrc.*`)
- `package.json`の`scripts`の変更
- 新しく追加した`*.sh`

一覧の本体は、`f/factory/lib/protected_paths.ts`の次の3つの定数である。

- `FORBIDDEN_PATH_PREFIXES`
- `FORBIDDEN_EXACT_PATHS`
- `FORBIDDEN_BASENAME_PATTERNS`

`steps/pr_workflow_support.ts`が判定の関数を再exportして使う。
実装フローが記録だけに使う一覧(`IMPLEMENT_PROTECTED_PATH_PREFIXES`など)は別の定数で、PR修正の判定には使わない。

ディレクトリは、リポジトリのルートからの相対パスの前方一致で判定する。個別のファイルは、ルートからの相対パスの完全一致で判定する。ファイル名の一覧は、ディレクトリを問わずファイル名で判定する。

`console/public/`と`console/index.html`は、Consoleでバンドルを通らずにそのまま配信され、ページの中で動く。
`console/index.html`はファイル名だけではほかの`index.html`と区別できないので、パスで判定する。
個別のファイルの一覧は、`FORBIDDEN_EXACT_PATHS`にある。
一覧には、次の6種類が入る。

- Consoleのページの入口: `console/index.html`
- draw.ioのビューアの固定: `console/drawio-viewer.json`
- 固定を強制し、配信物を作って検査する側: `console/scripts/`の一部、`console/vite.config.ts`、`scripts/check-console-lockfile.ts`
- 配信の設定: `infra/Caddyfile`
- 旧Consoleのraw appが図を隔離して描く部品: `DrawioViewer.tsx`、`lib/drawioMessages.ts`、`lib/drawioFrameState.ts`と、照合するテスト
- CIの実行の範囲を決める側: `scripts/ci-scope.ts`

`console/drawio-viewer.json`は、CIが取得して配信するビューアの取得元とsha256を固定する。
書き換えられると、別のスクリプトが固定の値として配信される。
固定を強制する側のスクリプトは、書き換えられると、検査をすり抜けた内容が配信物に混ざる。
`scripts/ci-scope.ts`は、書き換えられると、検査のジョブを黙って飛ばせる。
`infra/Caddyfile`には、Consoleのscriptの許可と、draw.ioの図を隔離するCSPがある。
`infra/console_fetcher/`は、配信物を検証して配信する。
どちらも書き換えられると、検証や隔離をすり抜けた内容が運用者のブラウザで動く。

markdownlint-cli2の設定は、`customRules`、`markdownItPlugins`、`modulePaths`で任意のモジュールを`import()`できる。
textlintの設定は、`rules`の名前からモジュールを解決して読み込む。
どちらもpre-commitの文書の検査と`mise run check`が読むので、書き換えられると、人の手元とCIでコードを実行される。

### 変更パスの取得

変更パスは、次の2つの和集合で取る。

```bash
git status --porcelain -z --untracked-files=all --ignore-submodules=none
git diff --name-only -z
```

symlinkのモード(`git ls-files -s -z`)と差分の行数(`git diff --numstat -z`)も、NUL区切りで読む。引用符付きのパス(非ASCII文字や制御文字を含むもの)でも、禁止パス、symlink、差分の大きさの判定を素通りしない。

未追跡のディレクトリは`dir/`の1件にまとめず、中のファイルを1件ずつ判定する。そのため、まだ無い`.github/`の下に作ったworkflowも止める。renameは新しいパスと元のパスの両方を判定するので、禁止パスへの移動も、禁止パスから外への移動も止める。

symlinkのモードを引くときは`--literal-pathspecs`でパスを文字どおりに渡す。`*`や`[`を含む名前を、別のファイルに一致させないためである。

### symlinkと特殊なファイルの検出

main cloneのconfigには`core.symlinks=false`を書いておく。PR修正の検証は、symlinkの新規作成(未追跡のものを含む)、変更、削除、typechangeで止める結果を返す。symlinkは次の3つで探し、どれかで見つかれば止める。

| 探し方 | 見つけるもの |
| --- | --- |
| 索引のモード(`git ls-files -s -z`) | 追跡しているsymlink |
| 削除以外の変更パスの`lstat` | 検査コマンドが作ったものなど、未追跡の新しいsymlink |
| `git diff --raw --no-renames -z --ignore-submodules=none HEAD`のモード | 通常のファイルとして置かれた追跡済みのsymlink |

`core.symlinks=false`のworktreeでは、追跡済みのsymlinkが通常のファイルとして置かれる。その中身を書き換えると指す先が変わるのに、`readlink`と`lstat`はsymlinkと報告しない。そのため、HEADと作業ツリーのモードも比べる。変更、削除、typechangeを含む。

検証のステップは、次の変更パスでも止める結果を返す。

- 末尾が`/`のパス(`git status`が未追跡の入れ子のリポジトリを`dir/`の1件にまとめたもの)
- 要素が`.git`のパス(大文字と小文字を区別しない)
- HEADと作業ツリーの`git diff --raw`で、古いか新しいモードがgitlink(`160000`)のパス。サブモジュールのディレクトリを消したgitlinkの削除も止める。
- 削除以外の変更パスのうち、`lstat`が通常のファイルとsymlinkのどちらでもないもの(ディレクトリ、FIFO、デバイスなど)

パスが無い以外の理由で`lstat`が失敗したときは、検証を失敗させる。これらとsymlinkのどれかで止めるときは、`package.json`の中身と差分の行数を読まない。symlinkの先やFIFOを読まないためである。

### 変更を調べる時点

検証のステップは、変更の一覧と上の判定を次の時点で行う。

- Claudeの実行の後
- Claudeの再実行の後
- 検査コマンドが通った後(1回目の検査が通ったときと、再実行の後の2回目の検査の後)

判定するのは、禁止パス、symlink、入れ子のリポジトリ、通常のファイルでないもの、`package.json`のscripts、差分の大きさである。`allowed_check_commands`は対象リポジトリのコードなので、保護パスのファイルやsymlinkを作りうる。そのため、検査コマンドの後にも調べる。

### HEADとブランチの確認

検証のステップは、変更を調べる前に毎回、次の2点を確かめる(`checkHead`)。違えば止める結果を返す。

- worktreeのHEADが、準備のステップが見たPRのhead(`head_sha`)である。
- `git symbolic-ref HEAD`が`refs/heads/<PRのheadブランチ>`である。

検査コマンドがローカルでcommitやブランチの切り替えをすると、HEADを基準にした変更の一覧から、そのcommitの変更が消えるためである。準備のステップの結果に`head_sha`か`branch`が無いときも止める結果を返す。

### worktreeの.gitの検証

worktreeの`.git`の書き換えを止める。参照先を別のディレクトリに向けると、そこに置いた`config`のfilterやfsmonitorなどを、次のgitがrootで実行するためである。Claudeが起動するときに実行するgitも含む。検証の仕組みは[実装フロー](implement.md)の[worktreeの.gitの検証](implement.md#worktreeのgitの検証)と同じである。

PR修正の各ステップは、次のように確かめる。

| ステップ | 確かめる時点 | 違うとき |
| --- | --- | --- |
| 準備 | worktreeを用意した直後に`.git`を1回だけ読み、検証して記録する | 例外 |
| 修正 | Claudeを起動する前 | Claudeを起動せずに止める結果を返す |
| 修正と検証 | Claudeの不正な出力への再試行の前 | 再試行しない |
| 検証 | 変更を調べる前と、検査コマンドの後にClaudeを再実行する前 | gitとClaudeのどちらも実行せずに止める結果を返す |
| 完了 | commitの前 | commitせずに人の対応待ちにする |

準備のステップは、記録した中身(`worktree_git_pointer`)を修正、検証、完了のステップに渡す。前回の実行が書き換えたまま残した`.git`を信頼しないよう、検証した1回の読み取りをそのまま記録する。

修正のステップが、違うときに例外を投げず止める結果を返す理由は、例外だとフローの再試行がClaudeを起動し直すからである。再試行の前の確かめが失敗したときも、再試行しない。最初の試行の記録(費用)はそのまま残す。確かめが例外を投げたときは、秘密を伏せたメッセージを最初の失敗の詳細に足し、原因を追えるようにする。

Claudeの実行が失敗で終わったときは、修正と検証のステップが`.git`を確かめ直す。書き換えられていれば、Claudeの失敗ではなく`.git`の書き換えを理由として止める結果を返す。

準備のステップの結果に`worktree_git_pointer`が無いときは、どのステップもgitとClaudeを実行せず、止める結果を返す。

### コミットの前の再確認

完了のステップは、検証のステップの最後の検査とは別のジョブである。そのため、commitの前に次を確かめる。どれかに通らなければ、commitとpushをせずに人の対応待ちにし、理由を`status_reason`に記録する。

1. worktreeのロックを持つプロセスがいない。何も止めずに確かめる。前のステップのClaudeや検査コマンドが残っていると、検証の後もworktreeを書き換えうるためである。
2. `.git`が準備のステップの記録と一致し、準備のステップの結果に`branch`がある。
3. `commitAndPush`の前に、実装フローと同じgitleaksの検査をする。
4. fetchの前に、`git symbolic-ref -q HEAD`が`refs/heads/<準備のステップの記録したPRのブランチ>`である。detachedの`HEAD`も止める(`commitAndPush`の`expectedBranch`)。
5. `git add -A`の前に、ローカルのHEADがPRのhead(`head_sha`)である(`commitAndPush`の`requireLocalHeadAtExpected`)。
6. `git add -A`の後、commitの前に、ステージした内容を`head_sha`と比べ、索引のツリーをgitleaksが検査したツリーと比べる。
7. commitの後、pushの前に、作ったcommitのツリーが検査したツリーであることを確かめる。

手順3のgitleaksは、[実装フロー](implement.md)の[gitleaksによる秘密情報の検査](implement.md#gitleaksによる秘密情報の検査)と同じ検査である。

- 比較の基準は`head_sha`で、この修正が足す行だけを検査する。
- 検査は長くかかりうるので、リポジトリのロックの外で行う。
- 秘密情報らしき文字列が見つかれば、`secrets detected, changes not pushed`を理由に止める。検出したルール名とファイル名はジョブのログに残し、一致した文字列は残さない。
- 検査そのものが失敗したときは、commitとpushのどちらもせずに失敗させる。

手順6では、`git diff --cached -z --name-status`と`git diff --cached --raw -z`でステージした内容を読む。次のどれかがあれば止める。

- 禁止パス
- 新しい`*.sh`
- symlinkのモードとgitlink(入れ子のリポジトリ)のモード
- 要素が`.git`のパス
- `package.json`のscriptsの変更(ステージした中身を`git show :0:<path>`で読む)
- commitする索引の`git write-tree`が、gitleaksの検査したツリーと違う。理由は`worktree changed after the secret scan`になる。

どれかに当たれば、`git reset -q`でステージを戻してcommitしない。この検査自体が失敗したときも、ステージを戻してから失敗させる。

手順7で違えば、`git reset -q <head_sha>`でcommitを取り消し、`committed tree differs from the inspected tree`を理由にする。
戻す先は、`HEAD`からたどらずに明示する。

pushは`HEAD`ではなく、作ったcommitのshaを`refs/heads/<ブランチ>`へ送る。

### サブモジュールと置換オブジェクトの扱い

検証と完了のステップが変更の一覧に使う`git status`と`git diff`には、`--ignore-submodules=none`を付ける。対象は`--raw HEAD`、`--cached --raw`、`--cached --name-status`の各呼び出しである。`.gitmodules`や設定の`ignore = all`で、サブモジュール(gitlink)の変更を隠させないためである。

`f/factory/lib/workspace.ts`と`steps/pr_workflow_support.ts`が実行するgitには、環境変数`GIT_NO_REPLACE_OBJECTS=1`を付ける。PR修正と実装フローのworktreeでの操作も含む。`refs/replace/`で差し替えたオブジェクトを読まないためで、差し替えのrefは検査コマンドが作れる。

`commitAndPush`のfetchは、サブモジュールに降りない(`--no-recurse-submodules`)。

### 差分の大きさの上限

差分に含まれるファイル数が`max_fix_changed_files`を超えるか、追加と削除の行数の合計が`max_fix_diff_lines`を超えると、検証のステップが止める結果を返す。マージのコンフリクトやファイルの削除による大きな変更を見つけるためである。

### 準備での確認

PR修正の準備のステップは、worktreeを作る前に次を確かめる(`evaluatePrFixSafetyGuards`など)。

| 確かめること | 通らないとき |
| --- | --- |
| リポジトリが許可リストに含まれる | ブロック |
| `fix_round`が`max_fix_rounds`以下である | 人の対応待ち |
| 時間設定がステップのtimeoutに収まる | ブロック |
| 親のIssueの作業項目が実装中でない | ブロック |
| PRのブランチ名から引いた実装の作業項目が実装中でない | ブロック |
| PRがopenである | ブロック |
| `head.repo`が`base.repo`と同じである(forkのPRにはpushしない) | ブロック |
| PRがdraftでない | ブロック |
| baseのブランチが保護ブランチでない | ブロック |

親のIssueの作業項目と実装の作業項目を確かめるのは、実装フローとPR修正がPRのブランチのworktreeを共有するからである。ブランチ名から引くのは、ブランチ名が`factory/issue-<N>-wi-<id>`の形のときで、親の行が無いPRでも止まる。理由を分けているので、どちらで止まったかを見分けられる。

worktreeを使っているプロセスがいるときもブロックにする([再実行と中断](#再実行と中断))。

### pushの直前の確認

pushの直前には、`commitAndPush`がfetchし直した`head_sha`と、準備のステップが確かめた値を比べる。違えば、その間に人がpushしたとみなし、pushを止めてブロックにする。

### コミットの作成者情報

コミットのauthorとcommitterには、PATが解決するGitHubアカウントのログイン名とnoreplyのメールアドレスを使う。メールアドレスの形は`<数値ID>+<ログイン名>@users.noreply.github.com`である。個人のメールアドレスをどこにも書き込まないためである。値は`git commit`の環境変数(`GIT_AUTHOR_*`と`GIT_COMMITTER_*`)としてだけ渡し、git configには書き込まない。
