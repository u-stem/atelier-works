# PRのレビューとCIの運用

PRのレビューと修正を使う手順と、mainとPRのCIとPRの競合を見守る手順である。
Factoryを運用する人が読む。
[運用](../operations.md)の手順のうち、PRにかかわるものをこの文書に置く。

## PRでレビューと修正を使う

PRのレビュー(`pr_review`)と修正(`pr_fix`)の内部の挙動は、[PRワークフローの仕様](../internals/pr-workflow.md)にある。

失敗、人の対応待ち、ブロックといった運用上の知らせは、PRには書かずDiscordに送る。
PRに書くのは、レビューの指摘と総評、修正の返信だけである。

### レビューを起動する

次のどれかでレビューが起動する。

- PRに`factory:review`ラベルを付ける。
- PRのレビュー依頼かassigneeにこのインスタンスのGitHubアカウントを入れる。
- Consoleの**作業項目**の「PRレビューの投入」から投入する([レビューを投入する](#レビューを投入する))。
- Windmillから`pr_review_submit`を実行する([レビューを投入する](#レビューを投入する))。

レビュー依頼かassigneeによる起動は、まだレビューしていないcommitがあり、PRの作成者が許可されたアカウントのときだけ起こる。

同じPRに終了していないレビューがあるときは、`factory:review`ラベルを付けても、レビューは始まらない。
ラベルは外さずに残り、今のレビューが終わった後の巡回で、新しいレビューが始まる。
レビューが長く終わらないときは、Consoleの**作業項目**で、そのレビューの状態を確かめる。

`factory:review`ラベルは、最後に付けたのが許可されたアカウントのときだけ起動する。
許可されるアカウントはIssueの`factory`ラベルと同じである。
許可されていない人が付けたラベルは、外さずに残し、Consoleの**システム**の「情報の通知」に`labeler_denied`を残す。
そのPRは、人がラベルを外すまで、ラベルを介さないレビューの自動検出も止まる。
追跡中のPRの新しいcommitによる再レビューも、PRの作成者が許可されたアカウントのときに限る。
同じリポジトリのブランチから出した第三者のPRは、許可されたアカウントがラベルを付けたときだけレビューされる。
新しいcommitが入るたびに、ラベルを付け直す。

PRのheadのリポジトリが、このリポジトリと同一でないときは、レビューを始めない。
同じ組織の別のリポジトリのfork、許可されたアカウントのfork、headのリポジトリを取得できないPRも対象である。
ラベルを付けても、レビュー依頼やassigneeを入れても同じである。
forkの内容は第三者が書いたもので、信頼してレビューに渡せないためである。
判定できないときも見送る。
ラベルは外さずに残し、Consoleの**システム**の「情報の通知」に`fork_head_denied`を残す。
作業項目をすでに作っていたときは、終端の`blocked`にして、Discordで人に知らせる。

レビューさせたいときは、同じリポジトリにブランチを作ってPRを出し直す。
通知を止めるには、次のどれかを行う。

- `factory:review`ラベルを外す。
- FactoryのGitHubアカウントを、assigneeとレビュー依頼から外す。
- PRを閉じる。

ラベルとassigneeが残る間は、通知を解決しても次のポーリングで同じ通知が出直す。
PRを閉じるかマージすると、新しい通知は出ない。
残った通知は自動では解決されない。
情報の通知なので、要対応の一覧には出ず、`?notice=<id>`で開いた詳細にだけ出る。

修正の材料にするコメントやレビューは、投稿者の関係(`author_association`)が`allowed_labeler_associations`に含まれるものだけにする。

レビューは、GitHubのCOMMENTのレビューとして投稿する。
総評とインラインコメントの1行目には、`[Factory 自動レビュー] @<author>`という印とメンションが付く。
運用者自身のアカウントで投稿するため、Factoryの投稿だと分かるようにしている。

総評の文面と、指摘のスレッドを自動で解決する条件は[PRワークフローの仕様](../internals/pr-workflow.md)にある。
指摘が無いときも、最終的なApproveは人が判断する。

スレッドへの返信か解決に失敗すると、そのスレッドは開いたまま残る。
次のレビューが答えるか解決する。

PR全体を読むレビュー(初回と全体の読み直し)の`maxTurns`は、`factory_config`の`pr_review_full_max_turns`(既定80)で決まる。
前回からの差分だけを読むレビューは、`max_turns`を使う。
大きなPRのレビューが上限で止まるときは、`pr_review_full_max_turns`を上げる。
1回の費用は`max_budget_usd_per_run`が抑える。

### レビューを投入する

ラベルを付けられないときや、ラベルの付与者の確認を通さずに、特定のPRをレビューさせたいときは、投入する。
投入できるのは、Consoleにログインした主体のうち、フォルダ`f/factory`を実行できる主体に限る。

#### Consoleから投入する

1. Consoleの**作業項目**を開き、「PRレビューの投入」を押す。
2. 「PRの番号またはURL」に、PRの番号かPRのURLを入力する。
   URLは、`https://github.com/<オーナー>/<リポジトリ>/pull/<番号>`の形で、`/files`などの続きが付いていてもよい。
3. リポジトリ欄は、番号だけを入力するときに、`オーナー名/リポジトリ名`の形で入力する。
   URLを入力するときは、空でよい。
   入力したときにURLのリポジトリと一致しなければ、画面が止める。
4. 「レビューを投入する」を押す。
   確認のダイアログは出ない。
   押すと、PRへのレビューの投稿が始まる。

結果は、送信ボタンの下に出る。

| 表示 | 意味と対処 |
| --- | --- |
| 「結果を待っています」 | 投入したフローが動いている。終わるまで、同じ画面から次の投入は送れない。長く続くときは、「ジョブを開く」で状態を確かめる |
| 「レビューを始めました」 | 作業項目を作って、レビューを起動した。作業項目へのリンクから進捗を確かめる |
| 「投入できませんでした」 | 入口が断った。文に従って欄を直す。何も投入していない |
| 「フローは動きましたが、レビューは始まっていません」で終わる文 | 登録のステップが断った。下の表に従う |
| 「結果を取得できません」 | ジョブの結果か状態を読めず、待っても終わらない。「もう一度取得する」を押すか、ジョブを開いて確かめる |
| 「結果を読み取れません。ジョブを開いて確認してください」 | 結果が読めない形だったか、投入したフローが失敗、取り消し、飛ばしのどれかで終わった。ジョブを開いて確かめる。取り直しても変わらない。登録のステップがGitHubの一時的な失敗で落ちたときは、再送で直ることがある |
| 「投入されたか分かりません」 | 通信の途切れ、5xx、ジョブの失敗、形の違う応答のどれかで、投入されたか分からない。前の投入が進行中の間は、再送しても二重には始まらない。終わった後の再送は新しいレビューになるので、作業項目の一覧とジョブの一覧で確かめてから再送する |

画面を離れると、結果の表示は消える。
投入は消えないので、作業項目の一覧とジョブの一覧から確かめる。

#### Windmillから投入する

Consoleを使えないときは、Windmillで`pr_review_submit`を実行する。
引数は`owner`、`repo`、`pr_number`で、`pr_number`は正の整数である。
実行者は、ジョブの実行文脈から導き、操作の記録(`pr_review_submit`)に残す。

次の場合は、フローを起動せず、理由を返す。
Consoleは、同じ理由を日本語の文で出す。

| 理由 | 対処 |
| --- | --- |
| `invalid_owner`、`invalid_repo`、`invalid_pr_number` | 引数の形を直す |
| `repo_not_allowed` | `factory_config`の`owners`か`repo_allowlist`に、リポジトリを足す |
| `actor_unknown` | ログインした主体から実行する |
| `already_reviewing` | 同じPRのレビューが動いているので、終わるのを待つ。操作は要らない |

起動できたら、`pr_review_intake`フローが動き、登録のステップがPRを確かめる。
次の場合は、作業項目を作らず、登録のステップのジョブの結果に理由が出る。
Consoleから投入したときは、画面が同じ理由を日本語の文で出す。

| 理由 | 内容 |
| --- | --- |
| `pr_not_found` | PRが見つからない。番号がIssueのものでないか確かめる |
| `pr_closed` | PRが閉じているか、マージ済みである |
| `fork_head` | headが別のリポジトリにある。`fork_head_denied`のnoticeが残る |
| `owner_mismatch` | オーナーのIDが食い違う。[オーナーの数値IDを固定する](../operations.md#オーナーの数値idを固定する)の手順で見直す |
| `repo_mismatch` | リポジトリの名前が変わっている。新しい名前で投入する |
| `repo_not_allowed` | 名前が変わった先のリポジトリを、設定が許可していない |
| `already_reviewing` | 投入の確認の後に、別のレビューが始まった。操作は要らない |

起動したのにレビューが始まらないときは、**ジョブ**の履歴で、`pr_review_intake`のジョブの結果を確かめる。
`fork_head`以外の断りは、noticeに残らない。

`poll_prs`のスケジュールを止めても、この投入は止まらない。
投入を止めるには、`pr_review_submit`を実行できる主体を絞る。

### 修正を起動する

1. 直してほしい内容を、PRに通常のコメントとして書く。
2. PRに`factory:fix`ラベルを付ける。

Factoryは、ほかの人のコメントと同じく、ラベルの前に書かれた指示を修正の材料として集める。
Factoryのレビュー済みのPRにも使える。

修正は`factory:fix`ラベルでしか起動しない。
コメントやcommitのpushだけでは起動しない。
ただしCIの失敗を直す回は、`watch_pr_ci`が起動する([失敗の自動修正を有効にする](#失敗の自動修正を有効にする))。
次の修正を始めたいときは、`factory:fix`を付け直す。
同じPRの修正が動いている間は、`factory:fix`を付けても始まらず、ラベルは保留される。
保留中のラベルは消えずに残る。
その修正が終わった後に、1回だけ新しいラウンドが始まる。

修正の作業項目が`fixing`のまま回収されないとき、同じPRのラベルは保留され続ける。
ジョブが動いていない作業項目は、猶予の後にreconcileが孤児として失敗にする。
猶予は、10分と`claude_timeout_sec`の2倍の大きい方である。
失敗になれば、次のポーリングが保留中のラベルから新しい修正を始める。
猶予を大きく過ぎても進行中のまま残るときは、運用者がConsoleの作業項目の詳細で状態とジョブを確認する。
記録されたジョブが実行中かキュー待ちなら、Consoleのジョブの詳細で**ジョブを中止**を押す([動いているジョブを中止する](../operations.md#動いているジョブを中止する))。
止めたジョブの作業項目は、猶予を待たず、次の照合で失敗になる。
ジョブを止めても、reconcileが失敗にしないまま残るときは、回復の手段が無い。
`retry_work_item`は進行中の作業項目を再実行できない。
DBの`work_items`を直接直す前に、運用者は拾われない原因を確かめて判断する。

修正が終わると、Factoryは各コメントに返信してから再レビューを依頼する。
返信の形式は`.claude/skills/factory-fix/SKILL.md`にある。

### 修正の返信の判断

各コメントへの返信は、次の3つのどれかになる。

| 判断 | 意味 | 返信の末尾 |
| --- | --- | --- |
| `fixed` | このPRの範囲で修正した | `対応: <commit sha7>` |
| `skipped` | 対応しないと判断した。理由は返信の本文に書く | `対応: 見送り` |
| `propose_issue` | 指摘は妥当だが、このPRの範囲外。Issue化を提案する | `対応: Issue化を提案(承認待ち)` |

Issue化の提案が1件でもあると、その回の修正は人の対応待ちで終わる。
提案が1件でも残っている間は、この状態が続く。

### Issue化の提案を承認・却下する

1. Consoleの**要対応**を開く。
   Issue化の提案は、要件定義の承認待ちと同じ一覧に種別の印付きで並ぶ。
2. 一覧の題名と種別を見て、提案を選ぶ。
3. 詳細に提案の本文と操作欄が表示される。
4. 起票と同時に要件定義へ進めるなら、「起票と同時にfactoryラベルを付けて要件定義に進める」にチェックを入れる。
   Issue化の提案では既定でオフである。
5. **承認**か**却下**を押す。
   却下では理由が必須である。

承認すると、Factoryが対象リポジトリにIssueを作り、レビューのスレッドに`Issue #Nを起票しました。`と返信してスレッドを解決する。
チェックを入れていれば、Issueに`trigger_label`(既定`factory`)が付いて要件定義に進む。
チェックを外したときは起票だけを行い、必要になったら人が後からラベルを付ける。

却下すると、スレッドに`見送りとします。`と理由を返信する。
スレッドは開いたまま残し、人が改めて判断する。

作業項目に未決定の提案が残らなくなると、作業項目の状態が自動で切り替わる。
その回でコミットをpushしていれば再レビュー依頼(`rereview_requested`)、pushしていなければレビュー済み(`reviewed`)になる。

Consoleを使えないときは、Windmillで`f/factory/approval_decide`を実行する。
入力は[Windmillから直接承認する](../operations.md#windmillから直接承認する)と同じで、承認では`options`に`{"with_factory_label": true}`のように指定する。

同じ判断で承認や却下をやり直しても安全である。
Issueは二重に作られない。
既に決まった提案に別の判断を送ると、Factoryは上書きせずにエラーを返す。

起票が途中で失敗した提案は、**要対応**に残る。
Issueの作成が失敗したときは未決定に戻る。
Issueを作った後の返信やスレッドの解決が失敗したときは、「起票未完了」の印付きで残る。
どちらも、もう一度承認すれば続きから起票する。

### 修正を再実行する

失敗(`failed`)、人の対応待ち、ブロック(`blocked`)で終わった修正は、`retry_work_item`で再実行できる。
ただしCIの失敗を直す回は除く([PRワークフロー](../internals/pr-workflow.md#ciの失敗を直す回))。
実行のしかたは[失敗した作業を再実行する](../operations.md#失敗した作業を再実行する)にある。

修正がpushに成功するか、要件定義へ差し戻すまでは、処理済みの位置が進まない。
そのため、それ以外で終わった修正を再実行すると、前回と同じ指摘を集め直す。

通知の次の操作は、修正のどこで止まったかで変わる。

| 止まったところ | 例 | 人がすること |
| --- | --- | --- |
| 修正の前(準備のステップ) | PRがドラフト、親のIssueかブランチの実装フローが実行中、親のIssueかブランチの作業項目が設計の段階にある、worktreeの使用中、時間の設定 | 原因を取り除いてから、`retry_work_item`で同じ作業項目を再実行する。修正のラウンドを使わない |
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

返信の投稿に失敗した分は、Consoleの**要対応**に返信の投稿の失敗(`fix_reply_post_failed`)が残る。
その場合は、PRで人が返信する。

すべての指摘を見送った回で返信に失敗したときは、このnoticeを残さず、作業項目が人の対応待ちになる。
この場合は人が返信せず、Consoleの**要対応**で再実行する。
再実行は同じ指摘を集め直すので、投稿できていた返信はもう一度投稿されることがある。

### 修正が要件の不足を報告したとき

修正のClaudeが要件の不足を報告すると、Factoryは修正をやめ、元のIssueの要件定義を作り直す。
作り直せるのは、元のIssueの作業項目が承認済みかPR作成済み(`pr_open`)のときだけである。

元のIssueが実装中や承認待ちのとき、試行回数が上限に達しているとき、読み取った後に状態が変わったときは、作り直さない。
修正の作業項目を人の対応待ちにして、Discordで知らせる。
実装フローの完了や要件定義の承認を待ってから、`factory:fix`を付け直す。

### PRの状態と人がすること

レビューと修正の作業項目は、次の状態で止まる。

| 状態 | 意味 | 人がすること |
| --- | --- | --- |
| レビュー済み(`reviewed`) | レビューが終わり、修正は不要 | 内容を確かめてApproveする |
| 再レビュー依頼(`rereview_requested`) | 修正をpushし、再レビューを依頼した | 再レビューを待つ |
| ブロック(`blocked`) | 準備の確認でレビューか修正の前に止めた(headがforkのPRのレビューなど)、修正の実行中にPRのheadが動いた、要件の不足で元のIssueへ差し戻した | 通知の理由に従う。修正の前に止めたときは、原因を取り除いて再実行する。headがforkのPRは、同一リポジトリのブランチから出し直す |
| 人の対応待ち(`needs_human`) | 修正を安全策や検査の失敗で止めた、レビューが失敗した、Issue化の提案がある | 通知の「次の操作」に従う |

### ラベルを外した後の追跡

トリガーラベルが外れた後も、Factoryは`tracked_pr_days`(既定30日)以内に更新があったPRをDBから見つけ直す。
人が新しいcommitをpushすると、そのたびに再レビューが起動する。
1回のpushにつきClaudeの実行は1回である。

それ以上追跡させたくないPRは、closeするか、`tracked_pr_days`を過ぎるまで待つ。

`review_post_mode`を`gated`にすると、レビューを投稿しない。
検証用の予約のモードで、PRはレビュー依頼かassigneeからだけ見つけ直す。
PRレビュー完了の通知も届かない。
結果はConsoleの作業項目で、範囲を「すべて」にして見る。
投稿しなかったレビューの作業項目は`reviewed`で終わり、既定の進行中に出ないためである。
投稿しない状態が続いても気づけるよう、日次のまとめに「レビューの投稿」欄が出る。
3日以上続くと、Consoleの要対応にもnoticeが出る([レビューを投稿しない状態の継続](../internals/notifications.md#レビューを投稿しない状態の継続))。

### 人が作ったPRを要件と紐づける

PR本文に`Closes #123`と書くと、そのIssueの承認済みの要件と照合する。
`Fixes`と`Resolves`も使える。
照合できれば、レビューと修正のClaudeに要件を渡す。

### 保護パスで止まった回数を数える

保護パスの一覧を見直すときは、一覧の項目が実際に何回当たったかを、次のコマンドで数える。
一覧の項目を外す根拠は、この集計の結果とする。
推測では外さない。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec -T -e PGOPTIONS="-c default_transaction_read_only=on" db psql -U postgres -d datatable_db -c "WITH stops AS (SELECT 'pr_fix' AS source, e.work_item_id, e.occurred_at, m[1] AS path FROM factory.work_item_events e CROSS JOIN LATERAL regexp_matches(e.note, 'forbidden path changed: ([^;]+)', 'g') AS m UNION ALL SELECT 'pr_fix_ci', e.work_item_id, e.occurred_at, m[1] FROM factory.work_item_events e CROSS JOIN LATERAL regexp_matches(e.note, 'ci round change not allowed \(protected_path\): ([^;]+)', 'g') AS m UNION ALL SELECT 'implement', r.work_item_id, r.created_at, substr(p.value, length('保護パスを変更: ') + 1) FROM factory.implement_rounds r CROSS JOIN LATERAL jsonb_array_elements_text(r.protected_changes) AS p(value) WHERE p.value LIKE '保護パスを変更: %') SELECT source, path, count(*) AS rounds, count(DISTINCT work_item_id) AS items, max(occurred_at)::date AS last_seen FROM stops GROUP BY source, path ORDER BY items DESC, rounds DESC, source, path"
```

読み取り専用のセッションで実行するので、書き込みは起きない。
列の意味は次のとおりである。

| `source` | 数えるもの | 記録の場所 |
| --- | --- | --- |
| `pr_fix` | PRの修正が、保護パスの変更のためにpushを止めた回 | `factory.work_item_events`の`note` |
| `pr_fix_ci` | CIの修正の変更が、保護パスのために拒否された回 | 同上 |
| `implement` | 実装が、保護パスを変えて検査を省いた回 | `factory.implement_rounds`の`protected_changes` |

`implement`は、止めずに記録する。
PRはそのまま開くので、数えるのは「確認して欲しい点」に載った回である。

結果の読み方は次のとおりである。

- 行が無い保護パスは、集計の期間に1度も当たっていない。
  ただし、期間の短さと件数の少なさは、書き換えられても害が無いことの根拠にならない。
  外すかどうかは、書き換えられたときに何が起きるかで決める。
- 保持期間(`retention_work_items_days`)を過ぎた作業項目は消える。
  数えられるのは、残っている期間だけである。
- 競合の修正が保護パスで止まった回は、パスを記録しないので、このコマンドに現れない。
  回数だけを見るには、`factory.pr_conflict_checks`の`fix_hold_reason`が`protected_path`の行を数える。
- 結果の`path`を、`f/factory/lib/protected_paths.ts`と`f/factory/lib/ci_fix_paths.ts`の一覧と照らし、一覧のどの項目に当たったかを決める。
  1つの項目に複数のパスが当たるので、項目ごとの合計は、人が足す。

## mainのCIを監視する

`watch_main_ci`が5分ごとに、対象リポジトリの既定のブランチ(main)のGitHub Actionsの結果を、コミット単位で確かめる。
対象は、`factory_repo`と`repo_allowlist`のリポジトリである。
`repo_allowlist`の項目は、`owners`の照合を通ったオーナーのものだけが対象になる。
`factory_repo`は照合の対象外で、常に対象になる。
照合が一時的に失敗している間は、そのオーナーのリポジトリが対象に入らない。
PATの失効や権限の剥奪などで24時間以上止まると、直前にpushされたコミットの失敗は通知されないことがある。
復旧した後は、次のコミットから通知される。
`repo_allowlist`が空のときは`factory_repo`だけを見る。
`poll_prs`のように、オーナーの全リポジトリは見ない。
`factory_config`のオーナーやリポジトリの綴りを変えると、そのリポジトリは初めての監視からやり直しになる。
既存のコミットは基準として記録し直し、通知しない。
Factoryが作ったコミットも人が作ったコミットも区別せず、原因のPRは特定しない。

mainの実行が取り消されると、`cancelled`は失敗に数えられる。
また、新しいコミットが通ると、古い失敗は直ったとみなして通知しない。
そのため、次の条件を満たすリポジトリだけを、`repo_allowlist`に入れる。

- mainの実行を取り消さない設定である。
- mainのpushで動くworkflowを、パスで絞っていない。
  パスで絞ると、新しいコミットが通っても、古い失敗は直っていないことがある。
  その場合、古い失敗は通知されない。

事前に、PATに`Actions: Read-only`を付ける([GitHubのPAT](../security.md#githubのpat))。
付けていなくても動き、権限が足りないリポジトリごとに、通知`main_ci_check_denied`が1件残る。

CIが失敗したコミットを見つけると、通知`main_ci_failed`を残し、Discordにも届ける。
リンク先の実行のログで原因を確かめ、直す修正を入れるか、原因のコミットを取り消す。
同じリポジトリでより新しいコミットのCIが通ると、通知は自動で解決される。
mainへのpushで承認待ちになるworkflowなどのために、どのコミットも通らないリポジトリでは、自動で解決されない。
人が解決する。
同じコミットの実行をやり直して通っても、失敗は取り消されない。
次のコミットが通ったときに解決される。
完了した失敗が1件でもあれば、残りの実行が2時間たっても終わらないコミットも、失敗として知らせる。

次の場合は通知しない。

- 初めて監視するリポジトリの既存のコミット。
  基準として記録するだけにする。
- 実行が15分たっても現れないコミット。
- 実行が2時間たっても終わらず、完了した失敗も無いコミット。
- より新しいコミットが先に通った後で、古いコミットの失敗が確定した場合。
- 古い失敗の確定。
  最初に見てから24時間以上たち、より新しい行も記録済みの場合に限る。
  権限が長く戻らなかった間の古い失敗を、一度に通知しないための扱いである。
  そのリポジトリで最新の失敗は、通知する。

workerの時計とGitHubの時計が数分ずれても、確定を待つ時間と期限に余裕があるので、判定は変わらない。

1回の実行で呼ぶGitHubのAPIは次のとおりである。

- `owners`の数だけ、オーナーの照合。
- 対象のリポジトリごとに、既定のブランチの取得と、実行の一覧の取得を1回ずつ。
- 判定待ちのコミットごとに、実行の取得を1〜3ページ。
  1回に取り出す判定待ちは、最大200件である。

1回の実行は、開始から180秒を超えると新しい読み取りを始めず、残りを次の回に回す。

内部の挙動は[mainのCI監視の仕様](../internals/main-ci.md)にある。

## PRのCIを監視する

`watch_pr_ci`が5分ごとに、Factoryが作ったPRのGitHub Actionsの結果を、headのコミット単位で確かめる。
失敗を通知する。
設定で有効にしたときは、失敗を直す作業項目も起動する([失敗の自動修正を有効にする](#失敗の自動修正を有効にする))。
設定で有効にしたときは、許可された人が作ったPRの失敗も通知する([人のPRの失敗を通知する](#人のprの失敗を通知する))。
`watch_pr_ci`自身は、PRとリポジトリへは書き込まず、ログも読まない。
設定`pr_ci_watch_enabled`を`false`にすると、発見、判定、新しい失敗の通知、作業項目の起動をしない。
失敗を直す作業項目が終わった行を戻す回復と、保留していた失敗の通知だけは、対象の行があれば動く。
行が無ければ、何も読まずに終わる。
保留していた失敗の通知はGitHubを読まず、起動もしないので、すぐ届く。
回復はオーナーの照合をせず、設定に合うリポジトリのPRを読む。
行を戻すPRが閉じていたときは、そのPRの失敗の通知を解決し、未完了の行を`superseded`にする。
照合に伴う通知は足さない。
ただし、回復がPRを読めず403か404になると、通知`pr_ci_check_denied`は足しうる。
判定が動かない間は、この通知は解決されないので、権限を直した後に人が解決する。
既定は`true`である。
再び有効にするときは、`pr_ci_fix_enabled_since`を戻す時刻に書き直す。
書き直さないと、無効の間に通知した行が起動の候補に戻り、決定的な保留に変わると本文が違う2件目の通知が出うる。

次の条件をすべて満たすPRだけを見る。

- 実装フローが作ったPRで、作業項目が`tracked_pr_days`(既定30日)以内に更新されている。
- 開いていて、下書きでなく、headのリポジトリがベースと同じである。
- headのブランチが`factory/issue-<N>-wi-<id>`の形で、その作業項目が同じPRを指している。
- リポジトリが、`factory_repo`か、`repo_allowlist`と照合を通った`owners`に合う。

forkのPRは、追跡せず、通知もしない。
人が作ったPRは、`pr_ci_watch_human_prs`が`false`の間は、追跡せず、通知もしない。

事前に、PATに`Actions: Read-only`を付ける([GitHubのPAT](../security.md#githubのpat))。
付けていなくても動き、権限が足りないリポジトリごとに、通知`pr_ci_check_denied`が1件残る。

CIが失敗したheadを見つけると、通知`pr_ci_failed`を残し、Discordにも`needs_human`として届ける。
自動で直す対象の失敗だけは、直せるかが決まってから届く([失敗の自動修正を有効にする](#失敗の自動修正を有効にする))。
リンク先の実行のログで原因を確かめ、PRに修正を入れる。
metadataジョブの失敗なら、`mise run metadata`を実行して差分をコミットする。
`mise run metadata`はローカルのWindmillに接続する。
先に`mise run up`でスタックを起動しておく([セットアップ](../setup.md#gitのフック))。
Factoryが作るPRで、自動修正が有効なときは、次の失敗をFactoryがhashの再計算で直してpushする([失敗の自動修正を有効にする](#失敗の自動修正を有効にする))。
metadataジョブだけの失敗と、checkジョブがロックの整合のテストだけで落ちた失敗である。
ロックの整合のテストは、`wmill-lock.yaml`が古いと落ちる11件のテストである(全項目のhashを比べるテストと、リポジトリのロックを基準にするテスト)。
整合のテストに、ほかのテストやlint、型検査の失敗が混ざるときは、再計算せず、Claudeの回になる。
ログを読めないときも同じである。
読み取りなど一時的な失敗は、保留にせず、flowの再試行に任せる。
再計算では直らないときは、保留`metadata_manual`で通知が出る。
保留した理由の種別は、作業項目の理由に残る。
人の作業は、種別で分かれる。

- 事前検査が通らない保留は、必要ならmainを取り込み、人が`mise run metadata`を実行して差分をコミットする。
  依存や入力のschemaが変わるPR、PRがmainの先端を含まないPRなどである。
  理由の補足で原因を確かめる。
  workerのBunの版が合わない保留(`scan_unavailable`)は`bun <版>`、想定外の例外の保留(`internal_error`)は例外の種類である。
- 再計算しても本文が変わらない保留(`lock_up_to_date`)は、metadataジョブがWindmillの起動やログインで落ちている。
  人の手順は要らず、実行をやり直す。
  `mise run metadata`で差分が出ないときも、同じ原因である。
  checkジョブが整合のテストだけで落ちた回では、再計算で直るhashの食い違い以外の原因で、整合のテストが落ちている。
  この場合は、実行をやり直しても直らないことがあり、テストの出力で原因を確かめる。

Factoryが作るPR(同じリポジトリの`factory/`ブランチ)では、CIが再生成の結果をartifact(`metadata-patch`)に出す([CIのメタデータの検査](../setup.md#ciのメタデータの検査))。
artifactが出ていても、PRには適用されない。
取り消しやフレークなら、実行をやり直す。
通知は、次のときに自動で解決される。

- 同じheadの実行をやり直して通った。
- PRに新しいheadをpushして、そのheadが通った。
- PRを閉じたか、マージした。

次の場合は通知しない。

- 新しいheadがpushされて取り消された、古いheadの実行。
- 実行が15分たっても現れないhead。
- 実行が2時間たっても終わらず、完了した失敗も無いhead。
- 実行の多さや権限の問題で24時間読めないままのhead。

PRのCIが新しいpushで古い実行を取り消す設定のリポジトリを前提にする。
取り消された古い実行は、新しいheadがあれば失敗に数えない。
今のheadの取り消しは失敗に数える。
通ったheadの実行を後からやり直して失敗しても、通知されない。
監視を有効にした直後の最初の巡回では、そのとき赤い開いたFactoryのPRが、すべて通知される。

見落としうる限界と内部の挙動は[PRのCI監視の仕様](../internals/pr-ci.md)にある。

### 人のPRの失敗を通知する

設定`pr_ci_watch_human_prs`を`true`にすると、許可された人が作ったPRのCIの失敗も、`watch_pr_ci`が通知する。
既定は`false`である。
`pr_ci_watch_enabled`が`false`のときは、`true`でも動かない。
通知だけを行い、直す作業項目は起動しない。
通知の文面と、通知が自動で解決される条件は、FactoryのPRと同じである。

対象は、次の条件をすべて満たすPRである。

- 作者が、PATのアカウントか、`allowed_labeler_logins`のアカウントである。
- 開いていて、下書きでなく、forkでない。
- headのブランチが`factory/issue-<N>-wi-<id>`の形でなく、Factoryが作ったPRでない。
- リポジトリが、`factory_repo`か、`repo_allowlist`と照合を通った`owners`に合う。

PATのアカウントが運用者本人のアカウントなら、運用者のPRの失敗がすべて通知される。
通知の設定によっては、GitHubもpushした本人に失敗を知らせる。
Factoryの通知は、見落としを防ぐためのものである。
1回の実行で新しく記録するのは20件まで、PRを読むのは60件までである。
新しく記録した行の判定は、次の回の実行(5分後)になる。

#### 一覧の本数

人のPRの候補は、検索を使わず、収集の表と、設定で明示したリポジトリのRESTの一覧から見つける([人のPRの発見の元を確かめる](#人のprの発見の元を確かめる))。
1回の実行で読む一覧は、表が使えない明示リポジトリごとに1回で、1回は最大10ページ(1000件)である。
表の記録が足りる明示リポジトリは、一覧を読まない。
`owners`に無いオーナーの`factory_repo`は、表に行が無いので、毎周回一覧で読む。
一覧は、PATのcoreの枠を使う。
検索のrate limitは使わない。
一覧がrate limitで拒まれた回は、残りの一覧を止め、人のPRの発見だけを飛ばす。

#### GitHubのAPIの枠

記録済みの人の行は、FactoryのPRの行と同じ判定を受ける。
判定の順は、FactoryのPRの行が先、人の行が後である。
人の行は、1回の実行で40件までを、読み直していない順に判定する。
人の行1件の判定は、PRの取得2回と実行の取得1〜3ページで、3〜5回になる。
40件で1回の実行に最大200回、5分ごとなので1時間に最大2400回である。
発見のPRの取得は、1回の実行で最大60回、1時間で最大720回である。
合わせて最大3120回になり、認証したトークンのRESTの上限(1時間に5000回)の約6割である。
一覧は、表が使えない明示リポジトリ1件につき、1回の実行で最大10回、1時間で最大120回である。
普段は、`owners`に無いオーナーの`factory_repo`の分だけが加わる。
`poll_prs`や`poll_issues`など、同じトークンを使う処理の分は、ここに含まれない。

有効にする手順は次のとおりである。

1. 通知先を確かめる。
   通知は、Consoleの要対応と、Discordの`needs_human`に届く。
2. 対象のアカウントを確かめる。
   PATのアカウントと`allowed_labeler_logins`の全員のPRが、通知の対象になる。
3. 初めて有効にするときは、[表の候補と一覧を突き合わせる](#表の候補と一覧を突き合わせる)手順を済ませる。
4. 有効にした最初の巡回で、そのとき赤い開いた人のPRはすべて通知される。
   数が多いときは、先に片付ける。
5. `factory_config`の`pr_ci_watch_human_prs`を`true`にする。
6. 次の巡回の後、`watch_pr_ci`のログに`pr ci human discovery finished`が出ることと、記録した数が想定と合うことを確かめる。

戻すときは、`pr_ci_watch_human_prs`を`false`にする。
新しい人の行は作られなくなる。
記録済みの人の行は読み直され、PRが閉じる、headが進む、通るのどれかでそのまま決着する。
読み直しは、1回の実行で40件(判定待ち、失敗、実行なしの合計)までである。
超えた分は次の回に回る。
失敗の行は期限切れにしない。
解決されずに残った通知`pr_ci_failed`は、Consoleから手で解決する。
一覧のrate limitや、PATのアカウントを読めない失敗は、人のPRの発見だけを飛ばす。
FactoryのPRの監視は止まらない。

### 人のPRの発見の元を確かめる

`watch_pr_ci`は、`pr_ci_watch_human_prs`が`true`のとき、許可された人のPRの候補を、収集の表と、設定で明示したリポジトリのRESTの一覧から見つける。
明示リポジトリは、`factory_repo`と`repo_allowlist`の各項目である。
一覧は`GET /repos/{owner}/{repo}/pulls?state=open`で、表が使えない明示リポジトリだけを読む。
どちらも検索を使わない。
発見の元を選ぶ設定は無い。
リソースに削除した設定の項目が残っていても、読み捨てられて動作に影響しない。
詳しくは、[GitHubの収集の内部仕様](../internals/github-collect.md#所有者の単位の読み取り)と[PRのCI監視の仕様](../internals/pr-ci.md#人のprの候補を見つけるとき)にある。
`pr_ci_watch_human_prs`が`false`の間は、表と一覧を読まない。
PRの読み直し、作者とforkとブランチの確認、記録するhead、判定、通知は、どの経路でも同じである。

リポジトリごとに記録の鮮度を判定する。
閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`である。
鮮度が足りないときの扱いは、リポジトリが明示されているかで分かれる。

- 明示リポジトリ: 一覧で読む。
  `gh_repos`に行が無いとき、表の読み取りが失敗したとき、収集の設定が偽のときも、一覧で読む。
  `owners`に無いオーナーの`factory_repo`は、表に行が無いので、毎周回一覧で読む。
- 明示でないリポジトリ: 見送る。
  見送りは失敗にしない。
  通知は鮮度の監視が出す([リポジトリ単位の古さ](../internals/github-collect.md#リポジトリ単位の古さ))。

鮮度の判定の語は、[Issueの発見の元を確かめる](collect.md#issueの発見の元を確かめる)と同じ5つである。

次の6つに注意する。

- 明示でないリポジトリの人のPRは、表の記録が古い間、見つからない。
  鮮度の監視が通知するまでの間は、黙って見送る。
- 収集の設定の片方でも偽の間は、明示リポジトリ以外の人のPRを見つけない。
  `repo_allowlist`が空のときは、鮮度の監視が通知を出す。
  止めるなら、先に`repo_allowlist`へ必要なリポジトリを並べる。
- 新しい人のPRと、下書きから戻したPRは、収集が次にそのリポジトリを取り終えるまで、表では見つからない。
  普段は4〜9分ほど遅れる。
  遅れた分だけ、新しいheadの失敗の通知も遅れる。
  記録済みの行の判定と、PRが閉じたことの検知は遅れない。
- 候補が60件を超えると、読む順が収集の時点の更新の時刻で決まる。
  記録済みのPRにpushした直後の新しいheadの記録が、次の収集まで遅れうる。
  60件以下なら、毎周回読むので遅れない。
- `repo_allowlist`が空の構成では、`gh_repos`に行の無いリポジトリの人のPRを見つけない。
  所有者のfork、直近の一覧より後に作られたリポジトリ、読み取りトークンに見えないリポジトリが当たる。
- 記録が閾値の内にあるarchive済みの明示リポジトリは、一覧でも読まない。
  archive済みのリポジトリではActionsが動かず、新しい失敗は出ない。

#### 表の候補と一覧を突き合わせる

`pr_ci_watch_human_prs`を初めて有効にする前の確認として、表の候補とRESTの一覧を突き合わせる。
表と一覧の経路は、有効にするまで実ジョブで動かないので、候補が合うことを先に確かめる。
手順は次のとおりである。

1. [詳細の収集を有効にする](collect.md#詳細の収集を有効にする)を済ませ、対象のリポジトリの記録が進んでいることを確かめる。
   `gh_repos`の`allowed`、`archived`、`gone`、`age`の見方は、[候補の元を確かめる](features.md#候補の元を確かめる)の手順1と同じである。
   `repo_allowlist`が空でないかも確かめる。
   空だと、上の5つ目の注意が当たる。
2. リポジトリごとに、表の候補の番号の集合と、RESTの一覧の番号の集合を照らし合わせる。
   作者は、PATのアカウントと`allowed_labeler_logins`のアカウントを小文字にしたものである。
   閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`で、次のSQLの`interval`に書く。
   表の側は、次のSQLで集める。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "SELECT p.repo || '#' || p.number FROM factory.gh_pull_requests p JOIN factory.gh_repos r ON r.owner = p.owner AND r.repo = p.repo AND r.repo_id = p.repo_id WHERE p.owner = '<owner>' AND p.repo = '<repo>' AND p.state = 'open' AND p.usable AND NOT p.is_draft AND p.author_type = 'User' AND lower(p.author_login) = '<作者>' AND r.allowed AND NOT r.gone AND NOT r.archived AND now() - r.last_collected_at <= interval '15 minutes' ORDER BY 1"
   ```

   RESTの一覧の側は、同じリポジトリの開いているPRを読み、同じ条件に当たる要素を集める。

   ```bash
   gh api -X GET repos/<owner>/<repo>/pulls -f state=open -f per_page=100 --paginate --jq '.[] | select((.draft | not) and ((.user.login // "" | ascii_downcase) == "<作者>")) | "<repo>#" + (.number | tostring)' | sort -u
   ```

   2つの出力をファイルに保存し、`cmp -s`で比べて、`same`と`different`のどちらになったかだけを見る。
   `different`なら、収集の周回の遅れ(5分以内)か、上の注意で説明できるかを確かめ、数分後に読み直す。
   一覧はアカウントの種別を持たないので、一覧の側に`Bot`のPRが入ることがある。
   入ったPRは、読み直しで除かれる。
   `owners`に無いオーナーの`factory_repo`は、表に行が無い。
   一覧の出力だけを見て、想定の人のPRが出ることを確かめる。
   作者が不明の行の数も数える。
   作者が不明の行は、作者を確かめるための読み取りを増やす。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "SELECT count(*) FROM factory.gh_pull_requests WHERE owner = '<owner>' AND state = 'open' AND usable AND NOT is_draft AND (author_login IS NULL OR author_type IS NULL)"
   ```

   `repo_allowlist`が空の構成では、PATのアカウントと許可した作者が開いているPRを持つリポジトリのうち、`gh_repos`に行の無いものの数も数える。
   1以上なら、そのリポジトリの人のPRは見つからない。
   見つけたいリポジトリは、`repo_allowlist`に並べて明示リポジトリにする。
   ただし、`repo_allowlist`が空でなくなると、`owners`の中で許可されるリポジトリが明示したものだけに絞られる。
   `poll_issues`や`poll_prs`など、ほかのフローの対象も同じ範囲に狭まる。
3. [人のPRの失敗を通知する](#人のprの失敗を通知する)の手順で、`pr_ci_watch_human_prs`を`true`にする。
   有効にする前の`pr_ci_check_denied`の未解決の件数を控える。
   手順5の比較の基準になる。
4. 続く3回の`watch_pr_ci`の結果を、Consoleのジョブの画面で確かめる。
   `errors`が0、`human_collect_disabled`が`false`、`human_deferred`が0であることを見る。
   `human_rest_lists`は、表が使えない明示リポジトリの数で、`owners`に無いオーナーの`factory_repo`の分だけのはずである。
   `human_table_candidates`は、手順2の表の候補の数と近いはずである。
5. 人の行の記録の数(`recorded`)と、`pr_ci_failed`の未解決の通知の件数が、前後で説明できることを確かめる。
   `pr_ci_check_denied`の未解決の件数が、手順3の値から増えていないことも確かめる。
   失敗の記録に、段`read_gh_owner_prs:`と`read_gh_repo_prs:`と`list_open_prs:`(`flow_path`が`f/factory/watch_pr_ci`のもの)が続かないことを見る。
6. 1日の間、`watch_pr_ci`の失敗の記録に403と429が無いことを確かめる。

結果の`human_rest_lists`と`human_skipped_stale`が1以上なら、理由の語で原因を読む。
`human_rest_lists`は表の代わりに一覧で読んだ明示リポジトリの数で、理由は`human_rest_reasons`に出る。
`human_skipped_stale`は見送った明示でないリポジトリの数で、理由は`human_skipped_stale_reasons`に出る。
理由の語の意味と対処は、[Issueの発見の元を確かめる](collect.md#issueの発見の元を確かめる)の表と同じである。
ただし、表の読み取りの失敗の段は`read_gh_owner_prs:<owner>`か`read_gh_repo_prs:<owner>/<repo>`である。
`human_deferred`が1以上なら、発見の時間の予算かrate limitで読み残している。
数えるのは、読まなかった所有者とリポジトリと、読み直さなかった候補のPRである。
警告のログ`pr ci human discovery stopped by the time budget`の`stage`は、止めた段を示す。
表と一覧の読み取りなら`collect_candidates`、候補のPRの読み直しなら`read_prs`である。
次の周回で読むので、続くときだけ調べる。

定期ジョブ用のworkerの待ちや一時的な収集の失敗で説明でき、確認の期間を延ばして0に戻るなら、そのままにする。
説明できなければ、収集の失敗として調べる。

一覧の読み取りが失敗すると、失敗の記録の段`list_open_prs:<owner>/<repo>`に残り、`errors`に数える。
開いたPRが1000件を超えるリポジトリでは、一覧が上限に当たって失敗し続ける。
明示リポジトリの一覧が失敗し続けても、通知は出ない。
失敗は`job_failures`に残り、日次のまとめに載る。
`repo_allowlist`が空でないと、リポジトリ単位の古さの通知と収集の無効の通知が出ないためである。
結果の`errors`と、失敗の記録の段`list_open_prs:`を定期的に見る。
一覧から消えた(`gone`)明示リポジトリは、一覧が404になり、段`list_open_prs:`の失敗を毎周回記録する。
改名か移管をした古い名前の明示リポジトリは、一覧がリダイレクトで読めても、応答のリポジトリが候補と違うため、候補を記録せず警告のログを毎周回残す。
どちらも、設定の明示から外して直す。

人のPRの発見をやめるときは、`pr_ci_watch_human_prs`を`false`にする。

#### 読めないリポジトリの通知

表の候補は、PRを読み直す。
収集の読み取りトークンに見えて、書き込みのPATに見えないリポジトリのPRは、読み直しが404か403になる。
PATの権限の不足とは限らないので、表の候補の404と403は、通知を作らない。
警告のログ`pr ci skipped a table candidate that could not be read`だけを残す。
一覧の候補は、PATが一覧を読めたリポジトリのものなので、読み直しが404か403になれば、権限の不足の通知`pr_ci_check_denied`を残す。
続くなら、読み取りトークンの範囲を書き込みのPATに合わせるか、`repo_allowlist`で絞る。

通知`pr_ci_check_denied`は、実行を読めたリポジトリの分が自動で解決される。
リポジトリを対象から外したときと、権限を戻さないと決めたときに残った通知は、Consoleの**要対応**から人が解決する。
解決した後に、次の巡回で実行を読めなければ、同じ通知が再び出る。

### 失敗の自動修正を有効にする

設定`pr_ci_fix_enabled`を`true`にすると、`watch_pr_ci`が失敗したheadを直す作業項目を起動する。
既定は`false`で、偽の間は何も起動しない。
起動した作業項目は、失敗した実行のログの抜粋をClaudeに渡して直し、PRのブランチにpushする([PRワークフロー](../internals/pr-workflow.md#ciの失敗を直す回))。
自動で直す対象の失敗は、見つけた時点では通知しない。
直せるかが決まってから、通知`pr_ci_failed`を1件残し、Discordにも届ける。
直せたときは、通知は出ない。
通知が出るのは、次のどれかのときである。

- 人が直す理由で、起動を見送った。
  理由は[保留の理由の語彙](../internals/pr-ci.md#保留の理由の語彙)の決定的な理由である。
- 直す回数の上限に達した。
- 一時的な理由での見送りが続いた。
  `not_reviewed`と`last_fix_unsettled`は`claude_timeout_sec`の2倍、ほかの理由は30分たったときである。
- 起動されず、見送りの理由も付かないまま、失敗してから2時間たった。
- 直す作業のClaudeの実行がtimeoutか実行ごとの予算の超過で失敗した。
- 使用上限がそのheadを見つけてから8日たっても戻らなかった。

通知の本文には、見送りの理由と、その理由ごとの次の操作が載る。
直す作業が人の判断待ちで止まったときは、止めたフローがDiscordに通知する。
そのため、`pr_ci_failed`はConsoleにだけ残る。
有効にした時刻より前に見つけた失敗と、取り消しなどで終わった失敗は、見つけた時点で届く。
直した結果のheadのCIが通ると、通知は自動で解決される。

次の条件をすべて満たす失敗だけを直す。
満たさない失敗は、人が直す。

- 失敗を見つけた時刻が、`pr_ci_fix_enabled_since`以後である。
- PRのすべてのcommitが、Factoryのトレーラーを持つ。
  トレーラーの無いcommitを含むPRは、自動で直さない。
- ブランチの作業項目が、要件定義の生成から実装までの間(Factoryがブランチを引き継ぐ状態)にない。
  その間は起動を見送り、保留も書かない。
  状態を出た後の巡回で、判断し直す。
- 今のheadのFactoryのレビューがある。
  ドラフトでなく、auto-mergeが有効でもない。
- 失敗が`failure`で、自動で直せる種類である。
  取り消しなどで終わった実行と、名前の無いジョブの失敗は、直さない。
  metadataジョブの失敗と、checkジョブがロックの整合のテストだけで落ちた失敗は、Claudeを起動せず、`wmill-lock.yaml`のhashの再計算で直す。
  依存や入力のschemaが変わるPRは、再計算では直らず、人が直す。
  整合のテストの失敗を再計算の回にする条件は、次のすべてを満たすことである。
  失敗したジョブがmetadata以外で1つだけで、そのログを読める。
  テストの失敗が整合のテスト(11件)だけで、全項目のhashを比べるテストを含む。
  ほかのテスト、lint、型検査の失敗が混ざる回と、ログを読めない回(権限が無い、保存期間が過ぎた)、失敗の原因を決められない回は、従来のとおりClaudeの回になる。
- 同じPRで動いている直す作業項目が無い。
- mainのCIが赤くなく、そのPRで起動した数が`pr_ci_fix_max_rounds`に満たない。
  日次の予算も残っている。
  ただし、再計算で直す失敗は、Claudeを起動しないので、予算を問わない。
  metadataジョブだけが失敗したときと、checkジョブが整合のテストだけで落ちたときである。
  `check`などが同時に落ちているときは、Claudeが先に直すので、予算を確かめる。
  metadataジョブは、次の回で再計算が直す。
  起動の判断は、ジョブの名前で分類する。
  予算かfactory-fixスキルのマーカーで保留する直前に限り、metadata以外で失敗したジョブが1つの行のログを読む。
  整合のテストだけで落ちたcheckジョブの回は、metadataジョブだけの失敗と同じく、Claudeを起動せず再計算で直すので、予算とマーカーを問わない。
  ログを読めないときは、通常の失敗と同じに保留する。
- Factoryのリポジトリの`factory_branch`にあるfactory-fixスキルが、CI回の節(マーカー`ci-fix-skill:v1`)を持つ。
  ファイルはGitHubのAPIで読む。
  `pr_fix`の準備は毎回`factory_branch`をfetchしてhard resetする。
  起動した後にスキルが変わって作業項目が準備で失敗すると、保留`marker_missing`になり、次の巡回で外れて起動し直す。
  仕組みと損失は[PRのCI監視の仕様](../internals/pr-ci.md#判断)にある。

条件を満たさない行は、理由が`pr_ci_checks.fix_hold_reason`に残る。
理由と意味は[PRのCI監視の仕様](../internals/pr-ci.md#保留の理由の語彙)にある。
一時的な理由は、条件が解ければ自動で外れて起動する。
決定的な理由は、そのheadでは外れない。

設定は、WindmillのResourcesの`factory_config`で直す。

| 項目 | 既定値 | 内容 |
| --- | --- | --- |
| `pr_ci_fix_enabled` | `false` | 直す作業項目を起動するか |
| `pr_ci_fix_max_rounds` | `2` | 1つのPRで起動できる数。直近に通ったheadより後を数える |
| `pr_ci_fix_enabled_since` | 無し | この時刻より前に見つけた失敗は直さない。`pr_ci_fix_enabled`が`true`なら必須 |

`pr_ci_fix_enabled`が`true`で`pr_ci_fix_enabled_since`が無い設定は、設定の読み込みが拒否する。
Factoryのほかの処理も止まるので、2項目は同じ編集で書く。

有効にする手順は次のとおりである。
有効にした最初の1件を、実際の失敗で確かめるためである。
検証用のPRを1件だけ選ぶ設定は無いので、次の順に範囲を絞る。

1. Factoryのリポジトリの`factory_branch`のfactory-fixスキルが、マーカー`ci-fix-skill:v1`を持つことを確かめる。
   ファイルをAPIで読み、マーカーを探す。
   出力に行が出れば持っている。
   `<owner>/<repo>`は、`factory_config`の`factory_repo`である。

   ```bash
   gh api -H "Accept: application/vnd.github.raw" "repos/<owner>/<repo>/contents/.claude/skills/factory-fix/SKILL.md?ref=<factory_branch>" | grep ci-fix-skill:v1
   ```

   何も出ないときは、`grep`を外した`gh api`単体が成功するかを先に確かめる。
   ファイルを読めていないだけのことがある。

   マーカーは、保護パスのスキルへの人のPRで入れる。
   PRがマージされるまで、有効にしない。
   持たないと、`metadata`ジョブだけの失敗を除くすべての失敗が、保留`marker_missing`になる。
   スキルが入れば、次の巡回で外れる。
2. 有効にする前から残る失敗(`failed`の行)を片付ける。
   PRを直すか閉じる。
   さらに、赤いFactoryのPRが残っていないかを確かめる。
3. `pr_ci_fix_max_rounds`を`1`にし、`daily_budget_usd`を「当日の使用額に1ラウンド分を足した値」にする。
   当日の使用額は、Factoryが予算の判定に使う集計と同じ式で読む。
   日の区切りはJSTの0時である。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT COALESCE(SUM(cost_usd), 0) AS spent_usd FROM factory.agent_runs WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'"
   ```

   1ラウンド分は、`max_budget_usd_per_run`(Claude 1回の実行の費用の上限)を単位に見積もる。
   1ラウンドは複数回の実行を含みうるので、その数を見込んで足す。
   決めきれなければ、小さい値から始め、巡回ごとに様子を見て増やす。
   `daily_budget_usd`はFactory全体で共有するので、使い切ると`pr_review`など、ほかのフローも止まる。
   走行中の分は数えないので、予算を使い切るまで、巡回ごとに最大2件を起動しうる。
4. `pr_ci_fix_enabled_since`へ有効にする時刻を書く。
   同じ編集で`pr_ci_fix_enabled`を`true`にする。
5. 有効にした後の最初の失敗で、起動した作業項目の結果をConsoleで確かめる。
   失敗しても起動されず通知も出ないときは、保留の理由を読む。
   一時的な理由は、しきい値に届くまで通知しない。
   起動されず、見送りの理由も付かない行は、2時間で通知される。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT id, owner, repo, pr_number, head_sha, state, fix_hold_reason, fix_attempts, fix_work_item_id FROM factory.pr_ci_checks WHERE state IN ('failed','fixing') ORDER BY updated_at DESC LIMIT 20"
   ```

   理由ごとの意味は[保留の理由の語彙](../internals/pr-ci.md#保留の理由の語彙)の表にある。
   一時的な理由は条件が解ければ自動で外れる。
   決定的な理由は人が対処する。
   理由が`claude_run_failed`の行は、[Claudeの失敗で保留したCIの修正を起動し直す](../operations.md#claudeの失敗で保留したciの修正を起動し直す)の手順で扱う。
   ジョブIDの未記録でフローを取り消した回が起きたときは、Discordの通知(`job_failed`)が増えるかを見る。
   取り消したフローで失敗時の通知が動くかは、確かめていない。
6. 結果に問題が無ければ、`pr_ci_fix_max_rounds`と`daily_budget_usd`を戻す。

止め方は次のとおりである。

- すべてを止めるには、`pr_ci_fix_enabled`を`false`に戻す。
  動いている作業項目は止まらず、終わると回復が行を戻す。
  通知を保留していた失敗は、次の巡回で通知される。
  有効に戻すときも、`pr_ci_fix_enabled_since`を戻す時刻に書き直す。
  書き直さないと、止めている間に見つけた失敗まで直しにいく。
  自動修正を止める前に「待つ」と通知した行は、止めた後も「待つ」の案内のまま残る。
  通知は行が`passed`になるかPRが閉じるまで残るので、人が確かめる。
- 1つのPRだけを止めるには、PRをドラフトにする。
  ドラフトのPRは起動せず、動いている作業項目も、準備かpushの直前でドラフトを見て止まる。

直す作業項目が`cancelled`になるのは、PRが閉じたときだけである。
閉じたPRの行は、`superseded`になる。

## PRの競合を検知する

`watch_pr_conflicts`が5分ごとに、Factoryが作ったPRにマージの競合があるかを確かめる。
競合したPRは、通知`pr_conflict`を残し、Discordにも`needs_human`として届ける。
`watch_pr_conflicts`自身は、PRとリポジトリへ書き込まない。
競合を直す作業項目の起動は、既定で無効である。
無効の間は、競合を人が解消する。
既定は無効で、設定`pr_conflict_watch_enabled`を`true`にしたときだけ動く。
`false`の間は、GitHubとDBを読まない。
CIの監視(`pr_ci_watch_enabled`)とは別に切り替える。

次の条件をすべて満たすPRだけを見る。

- 開いていて、下書きでなく、headのリポジトリがベースと同じである。
- headのブランチが`factory/issue-<N>-wi-<id>`の形である。
- PRの作者が、PATのアカウントである。
- リポジトリが、`factory_repo`か、`repo_allowlist`と照合を通った`owners`に合う。

人が作ったPRは、対象にしない。
draw.ioのビューアを上げるPRなど、別の形のブランチのPRも対象にしない。
作業項目は`cleanup_db`が消すので、PRの判定には使わない。

`watch_pr_conflicts`は、次のどれかに入るリポジトリの、開いているPRを読む。
検索は使わない。

- 状態が`pr_open`の作業項目を持つ。
- 競合の記録の行を持つ。
- `factory_repo`か、`repo_allowlist`に明示されている。
- PATのアカウントが作った開いているPRを、収集の表から見つけた。

`owners`だけで許されているリポジトリは、展開しない。
収集の設定`gh_collect_enabled`と`gh_collect_detail_enabled`が真のときは、収集の表でリポジトリを見つけ、記録が新しいリポジトリのPRは表から列挙する。
表を使えない作業項目、競合の行、明示のリポジトリは、RESTの一覧で列挙する([競合の監視の発見の元を確かめる](#競合の監視の発見の元を確かめる))。
作業項目も競合の記録も無く、表の記録も新しくない、明示でないリポジトリにあるFactoryのPRは、拾えなくなる。
このとき`repo_allowlist`にリポジトリを足してはならない。
1件でも入れると、`repo_allowlist`が対象のリポジトリを絞り、書かなかったリポジトリがFactory全体で対象から外れる。
1つのリポジトリで読むのは、1000件までである。
超えたリポジトリは飛ばし、失敗として記録する。
競合の行を持たないマージ済みのPRは、読まない。

競合とみなすのは、GitHubのマージ可否が偽で、その状態が`dirty`のときだけである。
GitHubはマージ可否を、PRを読まれたときに計算する。
計算前は値が空で、何もせずに次の回に判定し直す。
通知は、競合の1回につき1回である。
競合が続く間にPRのコミットが進んでも、通知を重ねない。
通知は、次のときに自動で解決される。

- 競合が解けた。
- PRを閉じたか、マージした。
- 設定が、リポジトリを対象から外した。

競合が解けた後に、再び競合したときは、新しい通知が出る。
ブランチの作業項目が、要件定義の生成から実装までの間(Factoryがブランチを引き継ぐ状態)にあるときは、競合を直す設定が有効なら、通知も競合を直す作業項目の起動も見送る。
設計や実装がpushする間に、人が直し始めないためである。
状態を出た後は、通知を待つ猶予が数え直され、競合を直す作業項目の起動が先に判断される。
通知済みの競合は、そのまま残る。
PATがリポジトリを読めなくなったときは、通知を解決せず、行も閉じない。
GitHubは、読む権限を失ったときも404を返す。
オーナーの照合が一時的に失敗した回も、通知を解決しない。

設定は、WindmillのResourcesの`factory_config`で直す。

| 項目 | 既定値 | 内容 |
| --- | --- | --- |
| `pr_conflict_watch_enabled` | `false` | 競合を検知して通知するか |
| `pr_conflict_fix_enabled` | `false` | 競合を直す作業項目を起動してよいか。`true`にするには、`pr_conflict_watch_enabled`も`true`にし、`pr_conflict_fix_enabled_since`を書く |
| `pr_conflict_fix_enabled_since` | 無し | この監視が競合の回を初めて検知した時刻が、この時刻より前なら直さない |
| `pr_conflict_fix_max_rounds` | `2` | 競合の1回で起動できる数。1以上5以下 |
| `pr_conflict_fix_max_rounds_per_pr` | `5` | 1つのPRで起動できる数。2以上10以下。`pr_conflict_fix_enabled`が`true`なら、`pr_conflict_fix_max_rounds`より大きい |
| `pr_conflict_fix_notify_grace_min` | `60` | 競合の回の開始から、通知を待つ分数。最終の保留は待たずに通知する。0以上1440以下。`pr_conflict_fix_enabled`が`true`なら、10以上 |

競合を直す設定の組み合わせが上の条件を満たさないと、設定の読み込みが拒否する。
Factoryのほかの処理も止まるので、関連する項目は同じ編集で書く。
`pr_conflict_fix_enabled`が`true`のとき、猶予は巡回の間隔(5分)より大きい10分以上にする。
猶予が0だと、最初の巡回から通知が先に出て、起動の判断が一度も回らないためである。

有効にする手順は次のとおりである。
有効にした最初の巡回で、そのとき競合している開いたFactoryのPRが、すべて通知されるためである。

1. migrationが反映済みであることを確かめる。
   競合の記録の表(`pr_conflict_checks`)を作るmigrationは、`self_update`が反映する。
   デプロイの記録で、反映が成功していることを見る。
2. 開いているFactoryのPRの数を、リポジトリごとに数える。
   PATのアカウントのログイン名を作者の条件に渡す。
   下書きは数えない。

   ```bash
   gh api -X GET repos/<owner>/<repo>/pulls -f state=open -f per_page=100 --paginate --jq '[.[] | select((.draft | not) and ((.user.login // "" | ascii_downcase) == ("<PATのアカウント>" | ascii_downcase)) and (.head.ref | startswith("factory/issue-")))] | length'
   ```

   各リポジトリの数を合計して、あとで`tracked`と比べる。
   `--paginate`は、ページごとに数を出す。
   ページが複数あるときは、出た数を足す。
3. 競合している開いたFactoryのPRが多いときは、先に解消するか閉じる。
4. `factory_config`の`pr_conflict_watch_enabled`を`true`にする。
5. 最初の巡回(最大5分後)の後、`watch_pr_conflicts`のログに`pr conflict watch finished`が出ることを確かめる。
   結果の項目は、次のとおりである。
   - `tracked`は読んだPRの数、`conflicted`は競合しているPRの数、`skipped`は見送ったPRの数である。
   - `errors`は0で、`unauthorized`と`rateLimited`は偽である。
     Consoleの失敗の記録に、`f/factory/watch_pr_conflicts`の行が無い。
   - `collect_disabled`は偽である。
     `skipped_stale`か`rest_lists`が1以上なら、[競合の監視の発見の元を確かめる](#競合の監視の発見の元を確かめる)の理由の表で原因を読む。
   - 最初の回は、GitHubがマージ可否をまだ計算しておらず(`null`)、`skipped`が多く出やすい。
6. 2回目の巡回の後、`skipped`が減り、`conflicted`が揃ったことを確かめる。
   `tracked`は、2で合計した数と近いはずである。
7. 競合しているPRがあれば、通知`pr_conflict`が1件ずつ残ることを確かめる。
   解消した後の巡回で、通知が自動で解決されることを確かめる。

有効にした時点で競合するPRが無かったときは、通知、Discord、自動解決の経路は未確認のままである。
最初の実際の競合で確かめる。
通知が1件残ること、Discordに`needs_human`が届くこと、競合が解けると通知が自動で解決されることを見る。
Discordに届かなかったときは、ログ`pr conflict notice was not delivered`が出る。

`tracked`が0で、`errors`も0のときは、PRの一覧の`user.login`や`user.id`が期待どおりに載っていない可能性がある。
作者がPATのアカウントと合わないと、PRを見つけられないためである。

リポジトリを見つける元の動作は、ログ`pr conflict repositories collected`の件数で確かめる。
リポジトリ名は出さない。

| 項目 | 意味 |
| --- | --- |
| `work_items` | 作業項目を持つリポジトリの数 |
| `conflict_rows` | 競合の記録の行を持つリポジトリの数 |
| `explicit` | 設定で明示されたリポジトリの数 |
| `table` | 収集の表で見つけたリポジトリの数。収集の設定が偽のときは0 |
| `total` | 重複を除いたリポジトリの数 |

表が働いたかは、PATのアカウントが開いているPRを持つのに、`table`が0になっていないかで確かめる。
0のままなら、収集の設定と、表の記録の鮮度を疑う。
作業項目、競合の行、設定で明示したリポジトリのPRは、表が働かなくてもRESTの一覧で見つかるので、`table`が0でも異常とは限らない。
`total`は、4つの元を合わせた和集合の数なので、4つの項目の和以下になる。

止めるときは、`pr_conflict_watch_enabled`を`false`にする。
止めた後に残った通知は、そのままにしておく。
再開した後に、競合が続く間は通知が残り、競合が解けると自動で解決される。
手で解決した通知は、その競合が解けるかPRが閉じるまで、再び出ない。

1回の実行は、経過時間の予算(120秒)かrate limitで、読み残すことがある。
読み残した数は、ログの警告と結果の`deferred`に出る。
rate limitに当たったリポジトリとPRそのものも数える。
読み残したものは、次の回に読む。
PATが拒まれた(401)ときは、以降の読み取りを止め、失敗を1件だけ記録する。
PATがリポジトリを読めなくなったときの専用の通知は無い。
この監視だけを有効にしているときは、ログの警告だけが残る。
読めなかったPRと、GitHubのrate limitの扱いは、[PRのCI監視の仕様](../internals/pr-ci.md#競合の検知)に書く。
通知の本文は、競合を直す設定が有効なとき、保留の理由ごとに違う。
実行が重なると、同じ競合の通知が2件残りうる。
競合が解けると、どちらも自動で解決される。

### 競合の監視の発見の元を確かめる

`watch_pr_conflicts`は、`gh_collect_enabled`と`gh_collect_detail_enabled`が真のとき、リポジトリの発見とPRの列挙を収集の表から行う。
表を使えない作業項目、競合の行、明示リポジトリ(`factory_repo`と`repo_allowlist`の各項目)は、その周回だけRESTの一覧で読む。
一覧は`GET /repos/{owner}/{repo}/pulls?state=open`である。
どちらも検索を使わない。
発見の元を選ぶ設定は無い。
リソースに削除した設定の項目が残っていても、読み捨てられて動作に影響しない。
詳しくは、[GitHubの収集の内部仕様](../internals/github-collect.md#所有者の単位の読み取り)にある。
PRごとの読み直し、競合の判定、通知、起動の判断は、どの経路でも同じである。
読み直したPRの作者、ブランチの形、forkは、どの経路でも確かめ直す。
合わないPRは、理由`not_factory`で飛ばし、ログに警告を残す。

リポジトリごとに記録の鮮度を判定する。
閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`である。
鮮度が足りないときの扱いは、リポジトリがどの元に入るかで分かれる。

- 作業項目、競合の行、明示リポジトリ: 一覧で読む。
  `gh_repos`に行が無いとき、表の読み取りが失敗したとき、収集の設定が偽のときも、一覧で読む。
- どれにも入らないリポジトリ: 見送る。
  見送りは失敗にしない。
  通知は鮮度の監視が出す([リポジトリ単位の古さ](../internals/github-collect.md#リポジトリ単位の古さ))。

鮮度の判定の語は、[Issueの発見の元を確かめる](collect.md#issueの発見の元を確かめる)と同じ5つである。

次の6つに注意する。

- 作業項目も競合の行も無く、表も古い、明示でないリポジトリにあるFactoryのPRは、拾えなくなる。
  鮮度の監視が通知するまでの間は、黙って見送る。
- 収集の設定の片方でも偽の間は、作業項目、競合の行、明示リポジトリ以外のPRを見つけない。
  `repo_allowlist`が空のときは、鮮度の監視が通知を出す。
  止めるなら、先に`repo_allowlist`へ必要なリポジトリを並べる。
- 表の値が変わってから列挙に届くまで、普段は1周回(5分ほど)、最大で閾値と5分の和だけ遅れる。
  競合の通知も同じだけ遅れる。
  競合が解けたことと、PRが閉じたことの検知は遅れない。
- `repo_allowlist`が空の構成では、`gh_repos`に行の無いリポジトリのPRを、表では見つけない。
  所有者のfork、直近の一覧より後に作られたリポジトリ、読み取りトークンに見えないリポジトリが当たる。
  作業項目か競合の行に載れば、一覧で読む。
- 設定の明示だけで名前が挙がり、記録が閾値の内にあるarchive済みのリポジトリは、一覧でも読まない。
  読み取り専用で、競合を直せないためである。
- 削除(`gone`)されたリポジトリの競合の行は、404で毎周回読まれ、整理されない。

次の手順で、収集が動き、表が使えていることを確かめる。

1. [詳細の収集を有効にする](collect.md#詳細の収集を有効にする)を済ませ、対象のリポジトリの記録が進んでいることを確かめる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT owner, repo, repo_id, allowed, archived, gone, truncated, detail_failed, last_collected_at, now() - last_collected_at AS age FROM factory.gh_repos ORDER BY owner, repo"
   ```

   対象のリポジトリが許可され、archiveされておらず、`gone`でなく、`age`が閾値の内にあることを見る。
   満たさないリポジトリは、作業項目、競合の行、明示のどれかに入らなければ見送られ、入れば毎周回RESTの一覧で読まれる。
2. 表で見つかるPRの集合を、GitHubの結果と照らし合わせる。
   表の側は、コードが候補に選ぶ条件と同じ条件で集める。
   対象は、記録の数値IDが合い、使ってよい開いた行である。
   リポジトリの記録は、閾値の内にあり、archive済みでも一覧から消えてもいない。
   PRは、下書きでなく、forkでなく、Factoryのブランチである。
   作者は、空か、PATのアカウントである。
   PATのアカウントの数値IDは、`gh api user --jq .id`で読む。
   閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`で、次のSQLの`interval`に書く。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "SELECT p.repo || '#' || p.number FROM factory.gh_pull_requests p JOIN factory.gh_repos r ON r.owner = p.owner AND r.repo = p.repo AND r.repo_id = p.repo_id WHERE p.owner = '<owner>' AND p.state = 'open' AND p.usable AND NOT p.is_draft AND NOT p.is_cross_repository AND p.head_ref ~ '^factory/issue-[1-9][0-9]*-wi-[1-9][0-9]*\$' AND (p.author_login IS NULL OR (lower(p.author_login) = lower('<PATのアカウント>') AND (p.author_id IS NULL OR p.author_id = <PATの数値ID>))) AND r.allowed AND NOT r.gone AND NOT r.archived AND now() - r.last_collected_at <= interval '15 minutes' ORDER BY 1"
   ```

   GitHubの側は、リポジトリごとにRESTの一覧を読み、同じ条件に当たる要素を集める。

   ```bash
   gh api -X GET repos/<owner>/<repo>/pulls -f state=open -f per_page=100 --paginate --jq '.[] | select((.draft | not) and ((.user.login // "" | ascii_downcase) == ("<PATのアカウント>" | ascii_downcase)) and (.head.ref | test("^factory/issue-[1-9][0-9]*-wi-[1-9][0-9]*$")) and (.head.repo.full_name == .base.repo.full_name)) | "<repo>#" + (.number | tostring)' | sort -u
   ```

   2つの出力をファイルに保存し、`cmp -s`で比べて、`same`と`different`のどちらになったかだけを見る。
   作者が空の行は表の側にだけ入る。
   差が出たら、作者が空の行の数を先に確かめる。
   それ以外の差は、収集の周回の遅れ(5分以内)か、archive済みのリポジトリで説明できるかを確かめ、数分後に読み直す。
   `repo_allowlist`が空の構成では、PATのアカウントが開いているPRを持つリポジトリのうち、`gh_repos`に行の無いものがないことも確かめる。
   あれば、そのリポジトリのFactoryのPRは、作業項目か競合の行に載るまで見つからない。
3. 続く3回の`watch_pr_conflicts`の結果を、Consoleのジョブの画面で確かめる。
   `collect_disabled`が`false`、`errors`が0であることを見る。
   `table_repos`は、表から列挙したリポジトリの数で、対象のうち記録が新しいものの数と近いはずである。
   `tracked`と`conflicted`は、直前の周回と同じか、その間のPRの開閉で説明できる値になる。
   失敗の記録に、段`read_gh_owner_prs:<owner>`と`list_open_prs:<owner>/<repo>`が続かないことを見る。

結果の`rest_lists`と`skipped_stale`が1以上なら、理由の語で原因を読む。
`rest_lists`は表の代わりに一覧で読んだリポジトリの数で、理由は`rest_reasons`に出る。
`skipped_stale`は見送った、どの元にも入らないリポジトリの数で、理由は`skipped_stale_reasons`に出る。
理由の語の意味と対処は、[Issueの発見の元を確かめる](collect.md#issueの発見の元を確かめる)の表と同じである。
ただし、表の読み取りの失敗の段は`read_gh_owner_prs:<owner>`である。
その周回に表を読まなかった所有者のリポジトリも、`no_record`になる。
`owners`に無い所有者、照合を通らなかった所有者、時間の予算が尽きて打ち切った所有者が当たる。

定期ジョブ用のworkerの待ちや一時的な収集の失敗で説明でき、確認の期間を延ばして0に戻るなら、そのままにする。
説明できなければ、収集の失敗として調べる。

一覧の読み取りが失敗すると、失敗の記録の段`list_open_prs:<owner>/<repo>`に残り、`errors`に数える。
開いたPRが1000件を超えるリポジトリでは、一覧が上限に当たって失敗し続ける。
一覧を読むのは、収集が止まっている間と、表の記録が新しくない作業項目、競合の行、明示リポジトリである。
明示リポジトリの一覧が失敗し続けても、通知は出ない。
失敗は`job_failures`に残り、日次のまとめに載る。
`repo_allowlist`が空でないと、リポジトリ単位の古さの通知と収集の無効の通知が出ないためである。
結果の`errors`と、失敗の記録の段`list_open_prs:`を定期的に見る。

監視を止めるときは、`pr_conflict_watch_enabled`を`false`にする。

### 競合の自動修正を有効にする

設定`pr_conflict_fix_enabled`を`true`にすると、`watch_pr_conflicts`が、競合したFactoryのPRを直す作業項目を起動する。
既定は`false`で、偽の間は何も起動せず、検知と通知は無効にする前と同じに動く。
起動した作業項目は、競合したファイルだけをClaudeに解かせ、解消したmergeコミットをPRのブランチにpushする([PRワークフロー](../internals/pr-workflow.md#マージの競合を解く回))。

次の条件をすべて満たす競合だけを直す。
満たさない競合は、人が直す。

- 競合の回を、この監視が`pr_conflict_fix_enabled_since`以後に初めて検知した。
- 通知していない。
  最終の保留が付いていない。
- PRが開いていて、headが記録と同じである。
- baseが既定のブランチで、PRがドラフトでなく、auto-mergeも無効である。
- PRのすべてのcommitが、Factoryのトレーラーを持つ。
  人のcommitを含むPRは、自動で直さない。
- Factoryのリポジトリの`factory_branch`にあるfactory-fixスキルが、競合を直す節(マーカー`conflict-fix-skill:v1`)を持つ。
- 日次の予算が残っていて、既定のブランチの先頭のmainのCIが失敗していない。
- 競合の1回で起動した数が`pr_conflict_fix_max_rounds`未満で、PR全体の数が`pr_conflict_fix_max_rounds_per_pr`未満である。
- 直近の直す作業項目が失敗せずに終わってから、5分以上たった。
  GitHubが競合の有無を更新するまで待つためである。
- 同じPRで動いている`pr_fix`が無い。

条件を満たさない行は、理由が`pr_conflict_checks.fix_hold_reason`に残る。
理由と意味は[保留の理由の語彙](../internals/pr-ci.md#保留の理由の語彙)にある。
一時の理由は、条件が解ければ自動で外れて起動する。
最終の理由は、人が直すまで外れない。
競合を直せなかったときは、人に知らせる通知が出る。
通知が出るのは、次のどれかのときである。

- 最終の保留になった。
  猶予を待たず、次の巡回で通知する。
- 一時の保留が続き、競合の回の開始から猶予(`pr_conflict_fix_notify_grace_min`)が過ぎた。
- 起動の判断が失敗し続けた、または起動の文が何も返さないまま、猶予が過ぎた。

通知の本文とDiscordには、自動で直さなかった理由が載る。
直せたときは、通知もDiscordへの成功の通知も出ない。
pushした後に競合が解けると、検知の通常の流れで、行が解決に移る。
結果は、Consoleの作業項目の状態(`pr_fix`の競合回)で読む。
範囲を「すべて」にして探す。
終わった状態は既定の進行中に出ないためである。
pushした回は`rereview_requested`、baseがすでにPRの履歴にあった回は`reviewed`で終わる。
競合回のフローは、通知もDiscordへの送信もしない。
失敗の通知は、`watch_pr_conflicts`だけが出す。
フローが例外で終わったときは、`on_error_flow`のDiscordの通知(`job_failed`)も届く。
起動の直後に落ちた作業項目を、`poll_issues`の照合が`failed`にしたときも、`job_failed`が届く。
`pr_conflict_watch_enabled`を`false`にして検知を止めると、動いている作業項目の結果は、Consoleの作業項目の状態(範囲は「すべて」)でしか読めなくなる。

猶予は、1回目の修正が終わるまでの時間より長くする。
1回目が猶予より長くかかると、2回目は起動せずに通知する。
作業項目が動いている間は、猶予が過ぎても通知せず、終わるまで待つ。
猶予が過ぎた後でも、直近の作業項目が終わってから5分に満たない間は、通知を待つ。
GitHubの競合の判定が古いままのことがあるためである。
起動した直後にwatcherが落ちたときなど、作業項目が状態を進められずに残ったときは、`poll_issues`の照合が失敗にし、回復が行を戻す。
照合の猶予は、10分と`claude_timeout_sec`の2倍の大きい方である。
既定の設定では1時間である。
フローが動き続けている間は、失敗にしない。
結びが2時間以上残った行は、警告`pr conflict fix has been running for a long time`が出る。
Consoleで作業項目の状態を確かめる。

設定の5項目は、上の表にある。
設定は`wmill`で直す。
リソースの値を取得し、直して、定義ファイルから反映する。

```bash
wmill resource get f/factory/factory_config --json
wmill resource push <定義ファイル> f/factory/factory_config
```

取得した出力の`value`の項目だけを直し、`resource_type`と`description`は変えずに残して、定義ファイルに書く。
定義ファイルは、リポジトリの外の一時ディレクトリに置く。
リポジトリの中に置くと、誤ってコミットしうるためである。
反映した後に、もう一度`wmill resource get f/factory/factory_config --json`を実行し、直した項目以外が変わっていないことを、反映前の出力と比べて確かめる。
`pr_conflict_fix_enabled`、`pr_conflict_fix_enabled_since`、猶予は、同じ編集で書く。
書き損じると、設定の読み込み全体が止まり、Factoryのほかの処理も動かなくなる。

有効にする手順は次のとおりである。
最初の1件を実機で確かめるため、範囲を絞って始める。

1. `pr_conflict_watch_enabled`が`true`で、検知が動いていることを確かめる。
2. Factoryのリポジトリの`factory_branch`のfactory-fixスキルが、マーカー`conflict-fix-skill:v1`を持つことを確かめる。
   `<owner>/<repo>`は、`factory_config`の`factory_repo`である。
   出力に行が出れば持っている。

   ```bash
   gh api -H "Accept: application/vnd.github.raw" "repos/<owner>/<repo>/contents/.claude/skills/factory-fix/SKILL.md?ref=<factory_branch>" | grep conflict-fix-skill:v1
   ```

   マーカーは、保護パスのスキルへの人のPRで入れる。
   PRがマージされるまで、有効にしない。
   持たないと、すべての競合が`marker_missing`で保留され、猶予が過ぎると通知される。
3. workerのイメージを作り直して(`mise run up`)、最新にする。
   イメージが古いと、起動した作業項目は、Claudeを動かす前に止まる。
   起動の判断はイメージの古さを見ないので、約25分で、その競合の回が`rounds_exhausted`で通知される。
4. 範囲を絞る。
   `pr_conflict_fix_max_rounds`を`1`、PR全体の上限を`2`、猶予を`60`にする。
   `daily_budget_usd`は、当日の使用額に数ラウンド分を足した値にする。
   見積もりは、[失敗の自動修正を有効にする](#失敗の自動修正を有効にする)の手順3と同じである。
5. `pr_conflict_fix_enabled_since`に、有効にする時刻を書き、同じ編集で`pr_conflict_fix_enabled`を`true`にする。
   この時刻より前の競合は、直さず、通常どおり通知する。
6. 実際のFactoryのPRで確かめる。
   `wmill-lock.yaml`などの保護パスを持たないリポジトリで、Factoryが作ったPRを1件選ぶ。
   既定のブランチに、同じファイルの同じ行を変えるcommitを入れて、競合を起こす。
   自リポジトリは、`wmill-lock.yaml`が競合しやすく、その競合は保護パスとして通知されるので、確かめには向かない。
7. 最初の巡回の後、次を確かめる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT id, owner, repo, pr_number, state, episode, fix_work_item_id, fix_attempts, fix_hold_reason, notified_at FROM factory.pr_conflict_checks WHERE state = 'conflicted' ORDER BY updated_at DESC LIMIT 20"
   ```

   - `watch_pr_conflicts`のログに`pr conflict fix launched`が出て、行の`fix_work_item_id`が作業項目のIDになる。
   - 作業項目が終わると、ログ`pr conflict fix row released`が出て、結びが外れる。
   - pushした回は、PRのブランチに、親が2つでトレーラー`Generated-By`を持つmergeコミットが増える。
   - 次の巡回で、競合が解けて、行が`resolved`になる。
     通知は出ない。
   - 起動されないときは、`fix_hold_reason`を読む。
   - 起動の失敗(`job_failures`の手順名`launch_conflict_fix:`)が続くと、約25分後に保留`rounds_exhausted`で通知される。
     通知文は上限への到達と書くだけで、原因を示さない。
     原因は`job_failures`の記録を読む。
8. 結果に問題が無ければ、`pr_conflict_fix_max_rounds`、`pr_conflict_fix_max_rounds_per_pr`、`daily_budget_usd`を戻す。

実機で確かめていないものは、次のとおりである。

- workerのバージョン管理コマンド(2.47.3)での、`merge --no-ff --no-commit`と`merge-base --is-ancestor`の`--`の扱い。
- PATでmergeコミットをpushできること。
- `.github/workflows/`を変えるmainの更新で、pushが拒まれたときの動作。
手順6で最初に確かめる。

止め方は次のとおりである。

- 起動を止めるには、`pr_conflict_fix_enabled`を`false`に戻す。
  動いている作業項目は止まらない。
  回復は動き続け、作業項目が終わると行の結びを外す。
  結びが残る間は、通知せず待つ。
  終わった後も競合が続く行は、次の巡回で通知される。
- 検知も止めるときは、結びが外れた後に`pr_conflict_watch_enabled`を`false`にする。
  検知が止まっている間は、回復も動かない。
- `pr_conflict_fix_enabled_since`を後ろへ動かすと、動かした時刻より前に始まった競合は、直さずに通知する。
  動いている作業項目の行は、終わるまで待つ。
  ブランチを引き継ぐ間の行は、猶予の起点が巡回ごとに今へ戻る。
  動かした時刻が直近の巡回より前なら、対象から外れない。
- 有効に戻すときは、`pr_conflict_fix_enabled_since`を戻す時刻に書き直す。
  書き直さないと、止めている間に始まった競合まで直しにいく。
- 1つのPRだけを止めるには、PRをドラフトにする。
  ドラフトのPRは検知の対象から外れ、起動と通知をしない。
  動いている作業項目は、準備かpushの直前でドラフトを見て止まる。
- auto-mergeを有効にしたPRは、起動を見送り、保留`pr_draft_or_auto_merge`で通知する。
