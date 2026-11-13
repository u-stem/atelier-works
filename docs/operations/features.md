# 機能ごとの運用

監査とdependabotの更新と調査を使う手順と、隔離の測定とモデルの使い分けの手順である。
Factoryを運用する人が読む。
[運用](../operations.md)の手順のうち、個別の機能にかかわるものをこの文書に置く。

## 監査を使う

Factory自身の運用記録の監査は、毎週月曜09:30に自動で走る(`audit_kickoff`)。
Consoleの**レポート**の**今すぐ監査**で前倒しできる。

次のときは監査を始めず、スキップの理由を表示する。

- 実行中の監査がある。
- 対象の期間が空である。
- 新しい記録が無い。
- 日次の予算を超えている。

監査レポートはConsoleの**レポート**で読む。
一覧から選ぶと、本文が表示される。

Discordの監査完了の通知(`audit_completed`)のリンクは、監査レポートのページ(`/console/reports/audit/<work_item_id>`)を開く。
旧Consoleの`#audit/<work_item_id>`のリンクも、同じページに読み替える。

改善提案は、Consoleの**要対応**に「改善提案」として並ぶ。
承認すると、Factory自身のリポジトリにIssueを起票する。
「起票と同時にfactoryラベルを付けて要件定義に進める」は、改善提案では既定でオンである。
外せば起票だけになる。
Factory自身のリポジトリは常に対象なので、ラベルを付けたIssueはそのまま要件定義に進む。

監査の内部の挙動は[監査の仕様](../internals/audit.md)にある。

## dependabotの更新を設定する

dependabotが開いた依存の更新PRを、Factoryが評価して自動でマージできる。
`f/factory/factory_config`の次の6つの項目で設定する。
`factory_config`は同期の対象外なので、WindmillのResourcesの編集画面で直す。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `dependabot_enabled` | `false` | dependabotのPRを自動で処理するか |
| `dependabot_merge_enabled` | `false` | マージしてよいと判断したPRを、実際にマージするか。偽の間は試運転で、そのPRを人に回す |
| `dependabot_group_enabled` | `false` | 複数のパッケージを上げるグループ更新のPRを、2〜3つまで対象にするか。偽の間は、人に回す |
| `dependabot_other_repos` | `[]` | `factory_repo`のほかに、dependabotの自動処理の候補にするリポジトリ。`<owner>/<repo>`の形で書く |
| `dependabot_min_published_days` | `7` | 更新先の版が公開されてから、マージしてよくなるまでの日数 |

`dependabot_min_published_days`は、公開から日が浅い版を自動でマージしないための下限である。
1以上の整数にする。
0、負の値、小数は設定の読み込みで拒否する。
既存のリソースにこれらの項目が無くても、既定値で動く。

対象は、`factory_repo`と、`dependabot_other_repos`に挙げたリポジトリである。
`dependabot_other_repos`の項目は、`<owner>/<repo>`の形で、末尾に拡張子を付けない。
リポジトリは、`repo_allowlist`にも載せ、`owners`の照合を通す必要がある。
どちらかを欠くと、そのリポジトリは黙って対象から外れる。
`dependabot_other_repos`が空のときは`factory_repo`だけを見る。
`poll_prs`のように、オーナーの全リポジトリは見ない。
`repo_allowlist`にだけ載せたリポジトリは、dependabotの対象にならない。
この変更の反映前に、`repo_allowlist`の他リポジトリを処理していた環境に注意する。
反映の後は、`dependabot_other_repos`に挙げるまで、そのリポジトリのdependabotのPRを処理せず、通知も出ない。

他のリポジトリの必須チェックは、設定に書かない。
そのリポジトリの`main`のrulesetが課す必須チェックを、収集のたびに読んで使う。
dependabotの対象は、baseが`main`のPRに限る。
次の場合は、人に回る。

- rulesetに必須チェックが無い。
  古典的なブランチ保護だけを使うリポジトリは、これに当たる。
- 必須チェックが、GitHub Actions以外のAppに結ばれている。

試運転に使うリポジトリは、ルートに`package.json`と`bun.lock`を持つ必要がある。
それ以外のファイルを変えるPRは、ゲートで人に回り、準備の理由まで届かない。
挙げたリポジトリのPRも、今は準備のステップで人に回る。
新しいheadのたびに通知が出るので、確かめた後は一覧から外す。
そのリポジトリのコマンド(インストールを含む)を、workerで動かさないためである。
この間は、ゲートまで通ったことを、人に回った理由(`dependabot prepare:`)で確かめるために使う。
`factory_repo`の必須チェックは、今までどおり固定の10件で、設定に左右されない。

マージする条件と残るリスクは[dependabotの更新の内部仕様](../internals/dependabot.md#dependabotの更新の自動マージ)に、選び方と状態は同じ文書の前半にある。

### 有効にする

有効にする順は、単独の実験、試運転、マージの順である。
1つずつ確かめてから進める。
設定を一度に変えると、問題が起きたときに原因を切り分けられないためである。

1. `dependabot_enabled`を`false`のまま、`poll_dependabot`の実行の結果が`enabled: false`で終わることを、Consoleのジョブの画面で確かめる。
2. [有効化の前の確認](../internals/dependabot.md#有効化の前の確認)の、試運転の前に単独の実験で確かめる項目を確かめる。
   フローは使わない。
   満たさなければ、試運転を始めない。
3. `dependabot_merge_enabled`が`false`であることを確かめてから、`dependabot_enabled`を`true`にする。
   これで試運転が始まる。
4. 次の`poll_dependabot`の実行の結果を確かめる。
   フローを起動していれば、`dependabot`フローの3つのステップの結果と、作業項目の終わり方を確かめる。
5. 同じ節の、試運転で確かめる項目をすべて確かめる。
6. 同じ節の、マージの前に確かめる項目をすべて確かめる。
   マージにはPATのContentsの書き込みが要る。
   実際にマージできるかは、この確認で確かめる。
   classicのPATはリポジトリ単位で権限を絞れないので、fine-grainedのPATを使う。
7. `dependabot_merge_enabled`を`true`にする。
8. 最初のマージの結果を確かめる。
   問題があれば、すぐに`dependabot_merge_enabled`を`false`に戻す。

### グループの更新を有効にする

`dependabot_group_enabled`は、上の手順で単独の更新を確かめた後に、人が決めて有効にする。
次の順に進める。

1. `dependabot_enabled`を`true`、`dependabot_merge_enabled`を`false`にして試運転を続ける。
2. グループのPRが作られる設定になっているかを、リポジトリの設定の「グループのセキュリティ更新」で確かめる。
3. `dependabot_group_enabled`を`true`にする。
4. グループのPRが来たら、作業項目が`dependabot dry run: merge allowed`まで進むことを確かめる。
   人に回った理由と、影響調査の所見も読み、判断が妥当かを確かめる。
   妥当なら、フラグを`true`のままにする。

`dependabot_merge_enabled`が`false`の間は、`dependabot_group_enabled`を`true`にしても何もマージしない。
問題があれば、`dependabot_group_enabled`を`false`に戻す。
マージの直前にもこの項目を読み直すので、動いているフローも人に回る。

### 候補の元を確かめる

`poll_dependabot`は、`gh_collect_enabled`と`gh_collect_detail_enabled`が真のとき、候補のPRを収集の表から読む。
表を使えないリポジトリは、その周回だけ、REST(`GET /repos/{owner}/{repo}/pulls?state=open`)の開いているPRの一覧で読む。
どちらも検索を使わない。
候補の元を選ぶ設定は無い。
リソースに削除した設定の項目が残っていても、読み捨てられて動作に影響しない。
詳しくは、[dependabotの更新の内部仕様](../internals/dependabot.md)の「候補の列挙の元」と「周回の結果」にある。

どの経路でも、次の点は変わらない。
候補の名前とGitHubの返す名前が合わないPRは、飛ばす(`repoMismatch`)。
保持期間と待ちの上限はRESTの`created_at`で判定し、読めなければそのPRの失敗にする。
失敗の記録の段の名前は、リポジトリ名を小文字にそろえる。

記録の時刻が閾値を超えたリポジトリは、その周回だけ一覧に戻る。
閾値は、`owners`の所有者がn人のとき、`max(15分, (n+1)×5分)`である。
収集が動いていても、収集が集めないリポジトリ(`owners`に無い所有者の`factory_repo`、fork、先頭が`.`のリポジトリ名など)は、毎周回一覧で読む。
次の手順で、収集が動き、表が使えていることを確かめる。

1. [詳細の収集を有効にする](collect.md#詳細の収集を有効にする)を済ませ、対象のリポジトリ(`factory_repo`と`dependabot_other_repos`)の記録が進んでいることを確かめる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT owner, repo, repo_id, allowed, archived, gone, truncated, detail_failed, last_collected_at, now() - last_collected_at AS age FROM factory.gh_repos ORDER BY owner, repo"
   ```

   対象のリポジトリが許可され、archiveされておらず、`gone`でなく、`age`が閾値の内にあることを見る。
   `owners`に無い所有者の`factory_repo`など、収集が集めないリポジトリは、行が無く、毎周回一覧に戻る。
   archive済みで、`age`が閾値の内にあるリポジトリは、マージできないので読まない。
   archive済みでも、`age`が閾値を超えていれば一覧で読む。
   収集の無効と表の読み取りの失敗でも、一覧で読む。
2. 表の結果とGitHubの結果が合うことを確かめる。
   dependabotが作者で、draftでなく、baseが`main`の開いているPRの番号を、表とGitHubの`pulls`の一覧のそれぞれから集める。
   2つの集合を`cmp -s`で比べ、`same`と`different`のどちらになったかだけを見る。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "SELECT number FROM factory.gh_pull_requests WHERE state = 'open' AND usable AND NOT is_draft AND base_ref = 'main' AND author_login = 'dependabot' AND author_type = 'Bot' AND owner = '<owner>' AND repo = '<repo>' ORDER BY number"
   ```

   表の作者の値は、1件だけ出して確かめる。
   `author_login`が`dependabot`、`author_type`が`Bot`として入っていなければ、上の絞り込みが合わない。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT author_login, author_type FROM factory.gh_pull_requests WHERE state = 'open' AND author_login ILIKE 'dependabot%' LIMIT 1"
   ```

   周回の遅れ(5分以内)で説明できない差があれば、収集の不具合として調べる。
3. 続く3回の`poll_dependabot`の結果を、Consoleのジョブの画面で確かめる。
   `enabled`が`true`、`paused`が`false`、`failed`が0であることを見る。
4. `fallback_lists`が0であることを確かめる。
   1以上なら、`fallback_reasons`の語で原因を読む。

| `fallback_reasons`の語 | 対処 |
| --- | --- |
| `collection_disabled` | `gh_collect_enabled`か`gh_collect_detail_enabled`が偽である。意図した停止でなければ、真に戻す |
| `no_record` | `gh_repos`に行が無い。そのリポジトリが収集の対象(`owners`の所有者の、forkでないリポジトリ)かを確かめる |
| `unusable` | 許可の外、一覧から消えた、開いた行がすべて使えない、のどれかである |
| `not_collected`、`too_old` | 詳細が取り終えられていない。`truncated`、`detail_failed`、所有者の`gh_collect_runs`の`detail_targets`と`detail_incomplete`を見て、[実行の記録の読み方](../operations.md#実行の記録の読み方)の対処をする |
| `in_future` | `last_collected_at`がDBの時刻より後で、正しく書かれていれば起きない。収集の不具合として調べる |
| `read_failed` | 表の読み取りが失敗した。失敗の記録の段`read_gh_pull_requests`と、DBの状態を確かめる |

一覧の読み取りが失敗すると、失敗の記録の段`list_open_pull_requests`に残り、`failed`に数える。
開いているPRが1000件を超えるリポジトリで一覧が失敗し続ける残るリスクは、[R-DEP-03](../security-risks.md#r-dep-03)である。
一覧を読むのは、収集が止まっている間と、収集が集めないリポジトリである。
公開のリポジトリへ第三者が大量のPRを開くと、その場合に当たりうる([R-DEP-03](../security-risks.md#r-dep-03))。

定期ジョブ用のworkerの待ちや一時的な収集の失敗で説明でき、確認の期間を延ばして0に戻るなら、そのままにする。
説明できなければ、収集の失敗として調べる。

すべてを止める手順は、[無効にする](#無効にする)の節にある。

### 初回の実機で確かめること

試運転とマージの最初の数件は、次の点を作業項目の結果とConsoleのジョブの画面で確かめる。

- 隔離したインストールが、npm registryに届き、`--frozen-lockfile`で成功する。
- インストールが、準備のステップのtimeout(3600秒)の中で終わる。
- 影響調査のClaudeの出力が、構造化出力の形で受け付けられる。
- 試運転でマージ可と判定したPRが、理由「dry run」で人に回る。
- マージしたPRのsquashのcommitの題名が固定の文で、本文が空である。
- 人に回したPRの通知に、PRのリンクと次の操作が載る。

### 無効にする

マージだけを止めるときは、`dependabot_merge_enabled`を`false`にする。
処理は続き、マージしてよいと判断したPRは人に回る。

すべてを止めるときは、`dependabot_enabled`を`false`にする。
次の実行から、`poll_dependabot`はGitHubとDBのどちらにも触れずに終わる。
動いているフローは、準備と終了のステップで作業項目を取り消し(`dependabot_disabled`)、GitHubに書かない。
影響調査のステップも、無効ならClaudeを起動しない。
スケジュールは、Windmillの画面で無効にして止めない。
`mise run push`と自己更新がリポジトリの定義で有効に戻すためである。
確認のために止めるときは、先に凍結を置く([凍結とdeployの保留の内部仕様](../internals/freezes.md)の「運用手順」)。

### 人に回ったとき

dependabotの作業項目は再実行できない。
通知のリンクからPRを開き、理由とPRのコメントの所見を確かめて、手でマージするか閉じる。
理由が「dry run」なら、マージしてよいと判断したPRである。
このPRは、確かめて手でマージする。
`dependabot_merge_enabled`を有効にしても、このPRは再評価されない。
試運転を終えるなら、`dependabot_merge_enabled`を有効にする。
有効にした後の新しいPRとheadから、マージが始まる。
影響の所見が出たPRを修正に回すときは、所見を確かめてから`factory:fix`ラベルを付ける。
修正をpushしたPRは、自動ではマージされないので、レビューを確かめて人がマージする。
新しいcommitが積まれると、Factoryは新しいheadを改めて評価する。

## 調査を実行する

調査(進め方`investigate`)は、実装せずにリポジトリを調べ、結果を依頼したIssueのコメントで返す。
入口は、Windmillから直接実行するフロー`f/factory/investigate`である。
実行できるのは、`f/factory`を実行できる主体に限る。
Consoleの投入フォームと取り消しは無い。
フローは、登録、準備、生成、投稿の4つのstepで進む。
各stepの確認と、本文を作るときの無害化と検査は[調査の隔離の内部仕様](../internals/investigate.md#調査の入口)にある。

### 調査の入口を開ける設定

調査の入口は、`f/factory/factory_config`の`investigate_enabled`で開ける。
既定は`false`で、真偽値の`true`と書いたときだけ開く。
文字列の`"true"`や参照(`$var:`)など、`true`でない値は、例外にならず閉じたものとして読む。
書くのは運用者で、WindmillのResourcesの編集画面か`wmill resource push`で行う。
Consoleの設定タブには出ない。
4つのstepは、それぞれ設定を読み直す。
偽のときは、登録のstepは行を作らずに断り、ほかのstepは調査を取り消して(`cancelled`)止まる。
コードをマージしても、設定を変えない限り、調査は始まらない。

設定を`true`にする前の確認は、次の3つである。

- 隔離の測定が、今のコードで合格している。
  手順は[隔離の測定を実行する](#隔離の測定を実行する)にある。
  Claude Codeの版か、判定の版か、隔離の定数が変わると、関門が閉じる。
- worker imageが、調査のworktreeを置く`/var/lib/factory-investigate`を作っている。
  imageの変更は、マージの後に`mise run up`で反映する。
  反映するまで、生成のstepは、置き場が無いという例外で止まる。
- 実機で確かめる項目を、非公開の試験用リポジトリで済ませる。
  敵対的な依頼文で、秘密や外部のパスが出力に出ないこと、祖先のディレクトリの`CLAUDE.md`が無いことを見る。
  transcriptに秘密の読み出しの跡があれば、[秘密の入れ替え](../security.md#秘密の入れ替え)の手順を先に決めておく。

### 調査を実行する手順

次のコマンドで実行する。
`request`は調べてほしいことで、8,000字以内である。
調査は、Issueの本文を読まず、この文だけを依頼として使う。

```bash
wmill flow run f/factory/investigate -d '{"owner":"<owner>","repo":"<repo>","issue_number":<Issueの番号>,"request":"<調べてほしいこと>"}'
```

対象のIssueは、開いていて、PRでなく、作者が運用者のPATのアカウントであるものに限る。
第三者が書いたIssueの本文を、調査の依頼文にしないためである。

登録のstepが断ると、後のstepは飛ばされ、行は作られない。
断りの理由は、登録のstepのジョブの結果の`reason`に残る。
入力の文字列は、結果に含めない。

| 符号 | 意味 | 次の操作 |
| --- | --- | --- |
| `invalid_input` | ownerとrepoの形、Issueの番号、依頼文のどれかが不正 | 入力を直して実行し直す |
| `repo_not_allowed` | 設定が許可していないリポジトリ | `owners`と`repo_allowlist`を確かめる |
| `owner_mismatch` | オーナーの数値IDが設定と合わない | `owners`を見直す |
| `investigation_disabled` | 調査の設定が偽 | 前の節の確認を済ませてから設定を開ける |
| `issue_not_found`、`issue_closed`、`issue_is_pull_request`、`repo_mismatch` | 対象のIssueが使えない | 対象を確かめる |
| `issue_author_not_operator` | 作者が運用者のPATのアカウントでない | 運用者が書いたIssueを使う |
| `probe_running` | 隔離の測定のジョブが待ちか実行中 | 測定が終わってから実行し直す |
| `investigation_in_progress` | 稼働中の調査がある | その調査が終わってから実行し直す |

登録が通ると、調査は`investigating`になり、結果はIssueのコメントとして投稿される。
コメントの先頭は`[investigate 自動調査]`で、末尾に目印が付く。
同じ調査のコメントは、1件しか投稿されない。

### 調査が止まったとき

調査が止まった理由は、Issueには書かない。
運用者には、Discordの通知とConsoleの要対応で知らせる。
通知には、理由と次の操作が載る。
理由の本文に、Claudeの出力や標準エラーは載らない。

調査の作業項目は再実行できない。
理由を直して、フローを新しく実行する。

隔離の関門が閉じていたときは、生成のstepが、調査を`needs_human`にして止める。
このとき、置き場と作業ツリーには触れない。
閉じた理由は、次の符号で通知に出る。

| 符号 | 次の操作 |
| --- | --- |
| `proof_missing` | 隔離の測定を実行する。実行済みなら、実行した主体の権限を確かめる |
| `proof_unreadable` | Windmillのジョブ記録を読む権限を確かめ、測定を実行し直す |
| `proof_failed` | 測定の結果の失敗の理由を確かめて直し、測定を実行し直す |
| `version_changed` | Claude Codeの版が測定のときと違うので、測定を実行し直す |
| `isolation_changed` | 判定の版か隔離が測定のときと違うので、測定を実行し直す |

関門以外で`needs_human`になる理由は、次のとおりである。
どれも、理由を直してから、フローを新しく実行する。

| 理由 | 次の操作 |
| --- | --- |
| 日次の予算を超えた | 翌日以降か、予算の設定を見直した後に実行する |
| 時間の設定が生成のstepのtimeoutに収まらない | `claude_timeout_sec`を下げるか、フローのtimeoutを見直す |
| ほかの調査か隔離の測定が動いている | 終わってから実行する |
| 調査のClaudeの実行が失敗した | ジョブのログで失敗の理由の符号を確かめ、依頼文を変えて実行する。符号が`usage_limit`なら使用上限が戻ってから、`stopped`なら全停止を解除してから、同じ依頼で実行する |
| 結果に秘密値の形の文字列があった | 投稿されない。検出した文字列はどこにも残らず、確かめる先は無い。workerの秘密値が出た可能性があるので、[秘密の入れ替え](../security.md#秘密の入れ替え)の手順を行ってから、依頼文を変えて実行する |
| 結果の検査ができなかった、または秘密値の変数の形が誤っている | 投稿されない。gitleaksと変数の形を確かめ、依頼文を変えて実行する |

stepが例外で落ちたときは、`on_error_flow`が調査を`failed`にして通知する。
調査を取り消した場合(設定が偽、Issueが閉じた、など)は、通知しない。

調査のClaudeは、読み出し専用のツールだけで動く。
1回の実行の上限は、`max_turns`、`max_budget_usd_per_run`、`claude_timeout_sec`で決まる。
出力の形が不正だと、1回だけ再試行する。
日次の予算は、調査の実行の費用も数える。

調査の隔離の層と、読み出しの固定の一覧、worktreeの置き場の検査は[調査の隔離の内部仕様](../internals/investigate.md#調査の隔離)にある。

### 調査のmigrationを戻す

調査の種別と状態を足すmigration(`20261102120000_investigate_work_items`)を戻す手順である。
このmigrationは設計工程より新しいので、設計工程のmigrationを戻すときは、先にこれが戻る。

戻すと、種別が調査(`investigate`)の作業項目がすべて削除される。
行が残っていると、種別と状態の制約を戻す文が失敗するためである。
調査の答えはIssueのコメントに残るが、作業項目の記録は失われる。

作業項目の削除は、外部キーの`ON DELETE CASCADE`で、状態遷移の履歴(`work_item_events`)とClaudeの実行の記録(`agent_runs`)も消す。
そのほかに消える表は[作業項目の状態とリース](../internals/work-items.md)の「調査の作業項目」に書く。
`agent_runs`は日次予算の元データなので、戻した日は、予算の検査が調査に使った費用の分だけ少なく数える。

稼働中の調査を全体で1件にする索引のmigration(`20261104100000_investigate_singleton`)は、このmigrationより新しいので、先に戻る。
戻すのは索引を落とすだけで、行は変わらず、失敗しない。
戻した後は、稼働中の調査を複数入れられる。
稼働中の調査が2件以上ある間は、索引のmigrationをやり直せない。
重複した行があると、索引を作れないためである。
1件を残して終端にしてから、やり直す。

## 隔離の測定を実行する

調査のClaudeの隔離を測って判定するscript(`f/factory/investigate_isolation_probe`)を、手動で実行する。
合格は、ツールを通る`Read`・`Glob`・`Grep`の読み出しが、3つの置き場で`--restricted`の閉じ込めに拒否され、作業ディレクトリの中では成功したことを指す。
それ以上は保証しない。
Claudeを、ツール(`Read`、`Glob`、`Grep`)と置き場(3つの置き場と作業ディレクトリ)の組ごとに1回、計12回起動する。
目印は秘密でないファイルで、本物の秘密は読ませない。

通常は、1回の起動が3〜5秒で、12回で約1分、費用は合計で$0.1〜0.2である。
最悪は、出力の形の検査に失敗して、各回が1度ずつ再試行される場合である。
1試行の予算の上限は$0.5、時間の上限は180秒なので、費用は$12(12回×2試行×$0.5)、所要時間は約72分(12回×2試行×180秒)になる。
測定の枠と、結果に残す項目と、判定の条件は[調査の隔離の内部仕様](../internals/investigate.md#隔離の測定と判定)にある。

実行の前に、次を確かめる。

- マージした変更を、`self_update`が反映している。
  反映の直後は、依存の再デプロイが終わるまで古いコードで動くので、数十秒待つ。
- 稼働中(`investigating`)の調査の作業項目が無い。
  実行はworktreeの置き場の中身をすべて消す。
  あるときは、測定が置き場を触る前に例外を投げ、ジョブが失敗する。
  関門は`proof_failed`で閉じ、測り直すまで開かない。
  調査が終わってから測り直す。
  逆に、測定のジョブが待ちか実行中の間は、調査の登録と生成が断る。
- Factory自身のcloneが、workerの`/workspaces/<owner>/<repo>/main`にある。
  無いと、結果が`workspace_unavailable`で止まる。

手順は次のとおりである。

1. 次のコマンドで実行する。

   ```bash
   wmill script run f/factory/investigate_isolation_probe
   ```

2. 完了したジョブのIDを、一覧から求める。

   ```bash
   wmill job list --script-path f/factory/investigate_isolation_probe --limit 1
   ```

3. 結果を読む。

   ```bash
   wmill job result <ジョブのID>
   ```

4. `passed`を見る。
   `true`なら、合格が記録されている。
   `probeJudgeVersion`が今の判定の版で、`failures`が空であることも確かめる。
   判定の版が上がった後は、古い版の合格を関門が受けない(`isolation_changed`)ので、この手順で測り直す。
   Claude Codeの版を上げたときは、作業ディレクトリから読む指示や設定の名前を確かめる。
   増えていれば、`INSTRUCTION_ENTRY_NAMES`(`lib/investigate_workspace.ts`)を直す。
5. `false`なら、`failures`の符号を読む。
   「不合格のときの扱い」で、再実行するか諮るかを選ぶ。
   `observations.stoppedBy`に値があれば、次の表で次の操作を選ぶ。

| `stoppedBy` | 意味 | 次の操作 |
| --- | --- | --- |
| `workspace_unavailable` | cloneか置き場かworktreeを用意できない | ジョブのログの符号を見て、cloneと置き場(`/var/lib/factory-investigate`)を確かめる。置き場が無いときは`mise run up`で反映する |
| `canary_placement_failed` | 目印を置けない。作業ディレクトリへの排他的な作成の失敗も含む | 置き場所(`/tmp`、`$HOME`、作業ディレクトリ)の権限と、残骸の有無を確かめる。作業ディレクトリの下の残骸は、次の実行の最初の掃除で消える |
| `unexpected_tool_use` | モデルが目印以外に触れた | 結果の`notice`に従い、[秘密の入れ替え](../security.md#秘密の入れ替え)を行う。実機の出力用のツールの入力の形が違うと、偽の警報が続きうる。予定外が`other`だけで実行が`success`のときは、出力用のツールの形の違いを疑う |
| `transcript_unavailable` | transcriptを特定または解析できない | 同上 |
| `probe_error` | 想定外の例外。`errorName`に名前だけが残る | ジョブのログを確かめる。例外のメッセージは結果にもログにも残らない |

結果に目印の値と本文は載らない。
不合格でも、観測は結果に残る。

実行が途中で中断されると、秘密でない目印が`/tmp`と`$HOME`と作業ディレクトリに残りうる。
実行を手動で取り消すと後始末が走らないが、次の実行を回せば最初の掃除で片付くので、手で消す必要は無い。

### 不合格のときの扱い

不合格の理由を、観測の質の問題と、隔離の問題に分ける。

観測の質の問題は、再実行してよい。
モデルが指示どおりに1回だけ呼ばなかった、実行が失敗した、などの揺れで起きるためである。
次の符号だけが並ぶときは、実行し直す。

- `stopped`のうち、`stoppedBy`が`workspace_unavailable`のもの(Claudeを起動する前に止まる)
- `run_count`、`run_missing`
- `tool_use_count`
- `unmatched_tool_use`
- `outcome`
- `retried`
- `session`
- `run_missing`

`transcript_unavailable`で止まった実行は、再実行しない。
モデルが目印以外に触れていないかを、transcriptで確かめられないため、`notice`も付く。
次の一覧のとおり、結果を示して諮る。

隔離の問題か、測定の前提が崩れた可能性を示す符号は、再実行しない。
結果を示して諮る。
再実行して通すと、隔離が破れていた事実が消えるためである。
関門は最新の1件だけを見るので、不合格の後に再実行して通れば、前の不合格は関門から見えなくなる。
次の符号が1つでもあるときは、再実行しない。

- `stopped`のうち、`stoppedBy`が`transcript_unavailable`のもの
- `not_refused`、`canary_leaked`、`refusal_text`
- `control_error`、`control_missing`
- `notice`、`unexpected_tool_use`
- `config_dir`、`version_command`
- `stopped`のうち、`stoppedBy`が`canary_placement_failed`、`unexpected_tool_use`、`probe_error`のもの
- 再実行してよい符号に挙げていない残りの符号(`error_name`、`run_duplicate`、`version_missing`、`hash_malformed`)

諮るときは、拒否の規則を足し続けて通すことはしない。
受け入れるか、調査の範囲を縮めるかを決める。

## モデルを使い分ける

Factoryは、工程によってClaudeのモデルを使い分ける。
間違えたときにやり直しが高くつく判断は上位のモデルに任せ、安く直せる作業は既定のモデルで済ませるためである。
モデルは`f/factory/factory_config`の2つの項目で決める。

| 項目 | 既定値 | 使う工程 |
| --- | --- | --- |
| `model` | `claude-sonnet-5-5` | 実装、PR修正 |
| `heavy_model` | `claude-opus-5-5` | 要件定義の生成、PRのレビュー、監査 |

実装とPR修正は、同じ作業で`model`が続けて2回失敗したら`heavy_model`に上げる。
Sonnetで試して届かなかった課題を、上位のモデルでやり直すためである。
数えるのは直近に連続した失敗で、成功が1回入ると数え直して`model`に戻る。
基盤の障害で数えた失敗が、復旧した後も`heavy_model`のまま残らないようにするためである。
`model`が成功と失敗を交互に出す課題は、連続しないので上がらない。
失敗は、工程ごとに次の記録から数える。

- 実装は、同じ作業項目の同じ要件定義(同じ試行)の実装ラウンドを新しいほうから見て、検査が通らなかったもの、変更が進まなかったもの、Claudeの実行が失敗したものを数える。
  検査に通ったラウンド、検査をしなかったラウンド、要件の不足を返したラウンドに当たったら、そこで数えるのをやめる。
  実装フローの中の修正ラウンドも、`retry_work_item`で再開する前の失敗も、続いていれば合わさる。
- PR修正は、次の2つの大きいほうを失敗の数にする。
  - 同じPRの直近に連続した失敗。
    内訳は「PR修正の連続した失敗」にある。
  - 再レビューで指摘が続いたラウンドの数。
    作業項目のラウンド番号(`fix_round`)から1を引いた値である。

実装のラウンドが停滞したときの扱いは、[実装](../internals/implement.md)の「ループの終わり方」にある。

要件定義の却下や実装中の要件の不足で試行が増えても、それだけでは上げない。
試行が増えると、実装の失敗の数は0から数え直す。
要件定義の生成、PRのレビュー、監査は、失敗の数にかかわらず`heavy_model`を使う。

`--model`に渡したモデルは、Claudeの実行の記録(`agent_runs`)の`model`列に残る。
`heavy_model`に上がったかどうかは、この列で確かめる。
1回の実行の中で別のモデルが使われたときの実際のモデルは、[実際に使われたモデルごとの使用量](#実際に使われたモデルごとの使用量)の`model_usage`で見る。

`heavy_model`が無い既存のリソースでも、既定値の`claude-opus-5-5`で動く。
一方、既存のリソースに`model: claude-opus-5-5`が書かれていると、既定が変わっても書き換わらない。
その間は、実装とPR修正もOpusで動く。
Sonnetを既定にするには、Windmillの画面で`f/factory/factory_config`を開き、`model`を`claude-sonnet-5-5`に書き換える。
リソースはgitで同期しないので、リポジトリの変更だけでは反映されない。

モデル名は、英数字で始まり、英数字と`.`、`_`、`-`、`[`、`]`だけで書く。
`-`で始まる値や空白を含む値は、設定の読み込みで拒否する。
`claude --model`の引数にそのまま渡すためである。

このリポジトリでClaudeを使うときのモデルの方針は、[コーディング規約](../coding-guidelines.md)の「Claudeのモデルの使い分け」にある。

### バージョンごとの使用量

Claudeのバージョンとモデルごとの使用量は、viewの`v_agent_usage_daily`で見る。
viewは、日、モデル、Claudeのバージョン(`claude_version`)、工程ごとに、実行の数、費用、入力と出力とキャッシュ読み出しのトークン数、ターン数を合計し、実行時間の平均を出す。
`day`は、`v_agent_cost_daily`と同じく、日本時間の0時で日を切る。
値は日本時間の0時の時刻で、UTCでは前日の15時になる。
日付として読みたいときは、`AT TIME ZONE 'Asia/Tokyo'`で日本時間に直して日付にする。

```sql
SELECT (day AT TIME ZONE 'Asia/Tokyo')::date AS day_jst,
       claude_version, model, sum(run_count) AS runs, sum(total_cost_usd) AS cost_usd
FROM factory.v_agent_usage_daily
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

バージョンを上げた前後を比べるには、期間で絞って、バージョンごとの費用を並べる。

```sql
SELECT claude_version, model, sum(run_count) AS runs, sum(total_cost_usd) AS cost_usd
FROM factory.v_agent_usage_daily
WHERE day >= now() - interval '14 days'
GROUP BY claude_version, model
ORDER BY claude_version, model;
```

記録するバージョンは、workerのイメージに入れたClaudeの版(`CLAUDE_VERSION`)である。
Windmillのジョブには、`WHITELIST_ENVS`に挙げていない変数は、PATHなどの既定のものを除いて届かない。
そのため、`infra/docker-compose.yml`が`CLAUDE_VERSION`を挙げている。
バージョンの記録は、workerのイメージを作り直した後の実行から入る。
それより前の行は`claude_version`がNULLのまま残り、viewではNULLの行として別に集計される。
NULLを別の文字列に置き換えないのは、記録が無いことを利用者に見せるためである。

`mise run up`で反映した後は、反映した時刻より後の実行で、`mise.toml`の`CLAUDE_VERSION`と同じ値が入ることを確かめる。
`<反映した時刻>`には、ISO 8601の時刻文字列(例: `2026-10-16T10:00:00+09:00`)を入れる。

```sql
SELECT claude_version, count(*)
FROM factory.agent_runs
WHERE created_at > '<反映した時刻>'
GROUP BY 1;
```

確認クエリの結果にNULLの行があるときは、ジョブにまだ変数が届いていない。
workerが新しいイメージで動いているかと、`WHITELIST_ENVS`を確かめる。

#### Claudeの状態の置き場所

workerのイメージは、`CLAUDE_CONFIG_DIR`(`/var/lib/factory/claude`)と`GH_CONFIG_DIR`を`ENV`に持つ。
どちらも`WHITELIST_ENVS`に挙げないので、ジョブの`process.env`には届かない。
この2つは、コンテナの中で人が`claude`や`gh`を手で使うときの置き場である。

ジョブのClaudeの設定の置き場は、`runClaude`が、ジョブごとの0700の一時ディレクトリの下(`<TMPDIR>/claude-config`)に指定する。
`WM_JOB_ID`がジョブのIDとして読めるときに、置き場が決まる。
読めないときは、`jobTmpDirPath()`(`f/factory/lib/job_tmp.ts`)が`null`を返す。
ジョブの終了で消え、取り消しやタイムアウトで消えずに残ったものは、掃除のジョブが期限を過ぎてから消す。
そのため状態と会話記録は溜まらず、検査用のユーザーからも読めない。
`--setting-sources user`が読むユーザー層も、毎回空から始まり、人が手で動かした設定が混ざらない。
認証は`CLAUDE_CODE_OAUTH_TOKEN`で渡すので、置き場所は認証に関わらない。

`WM_JOB_ID`が読めずにジョブのディレクトリを得られないとき、`buildClaudeEnv`(`f/factory/lib/claude.ts`)は環境変数の`CLAUDE_CONFIG_DIR`を使う。
ジョブには届かないので、未設定のまま渡さない。
このとき`claude`は既定の置き場(`$HOME/.claude`)に戻る。
ジョブのディレクトリが安全でないときは、戻らずにジョブが失敗する。
反映より前のジョブが`$HOME/.claude`に残した状態は、そのまま残る。

`GH_CONFIG_DIR`を届かせないのは、gitの子プロセスがジョブの環境を引き継がないためである。
gitの子プロセスは、資格情報の補助の`gh auth git-credential`を含めて、`GH_TOKEN`、`HOME`、`PATH`などを明示して作る環境で動く。
届かせても、読む処理が無い。
GitHubのAPIへの要求は、子プロセスを起動せず、ジョブのプロセスの`fetch`で送る。
読み取りと書き込みのどちらでも、ジョブの環境を引き継ぐ。
扱いは[セキュリティの「GitHubのAPIへの通信層」](../security.md#githubのapiへの通信層)にある。

ジョブの環境は、実ジョブで次の結果になる。

| 変数 | ジョブでの状態 | 理由 |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | 未設定 | `WHITELIST_ENVS`に挙げない |
| `GH_CONFIG_DIR` | 未設定 | `WHITELIST_ENVS`に挙げない |
| `CLAUDE_VERSION` | 設定あり | `WHITELIST_ENVS`に挙げている |
| `DISABLE_AUTOUPDATER` | 未設定 | `WHITELIST_ENVS`に挙げない。`buildClaudeEnv`が`claude`の子プロセスにだけ明示して渡す |

この表が示すのは、環境変数の有無だけである。
`CLAUDE_CONFIG_DIR`の未設定は、戻る経路で使う値が無いことを示すにすぎず、置き場が正しい保証にはならない。
環境変数が届かないのは変数だけで、ファイルは隔離されていない。
defaultのworkerのジョブは`factory_state`をマウントしている。
そのため、パスを指定すれば、人が手で使う`/var/lib/factory/claude`と`/var/lib/factory/gh`を読める。
残るリスクは[Console用workerの境界](../security.md#console用workerの境界)にある。

#### 反映後に実ジョブで確かめること

置き場が意図どおりかは、環境変数ではなく、ジョブの後のファイルで確かめる。
次の3つがそろえば、`claude -p`が空の設定ディレクトリで起動し、`$HOME/.claude`に戻っていないと言える。
すべて読み取りだけである。

1. `agent_runs`に、反映した時刻より後の成功した行がある。
2. workerの`/root/.claude`と`/root/.claude.json`に、反映した時刻より新しいファイルが無い。
3. ジョブの後に、`/run/factory-tmp`にジョブのディレクトリが残っていない。

反映した時刻は、`factory.deployments`の`occurred_at`である。
対象のshaの行(`sha_to`)から取る。

```sql
SELECT occurred_at
FROM factory.deployments
WHERE sha_to LIKE '<対象のshaの先頭>%'
ORDER BY occurred_at DESC
LIMIT 1;
```

成功した行は、次のSQLで探す。

```sql
SELECT id, stage, created_at
FROM factory.agent_runs
WHERE created_at > '<反映した時刻>'
  AND exit_code = 0
  AND error IS NULL
ORDER BY created_at
LIMIT 5;
```

workerのファイルは、次のコマンドで確かめる。
出力が空なら、新しいファイルは無い。

```sh
mise exec -- docker compose -f infra/docker-compose.yml exec -T windmill_worker \
  find /root/.claude /root/.claude.json -newermt '<反映した時刻>'
mise exec -- docker compose -f infra/docker-compose.yml exec -T windmill_worker \
  ls -A /run/factory-tmp
```

2つ目のコマンドの出力が空なら、ジョブのディレクトリは残っていない。
実行中のジョブのディレクトリは残るので、ジョブが動いていないときに確かめる。

#### 環境変数の再確認

workerやmiseを更新したときは、表の結果が変わっていないかを次の手順で確かめる。

1. 使い捨てのworktreeを、`mise run worktree:new -- <type>/<name>`で作る。
   ブランチ名を`wm-fork/`で始めない。
2. `f/factory/`の下に、後述の内容の一時のscript(例: `f/factory/tmp_env_check.ts`)を置く。
   コミットしない。
3. Claudeの長いジョブが動いていない間に、`wmill script preview f/factory/tmp_env_check.ts -d '{}'`で実行し、上の表と比べる。
4. 一時のscriptを消し、`mise run worktree:prune`で片付ける対象を確かめる(既定は一覧を出すだけで、消すには`-- --apply`を付ける)。

そのworktreeで`mise run push`を実行しない。
`f/`の下の一時のscriptが、ワークスペースに配信されるためである。
defaultのworkerは1つずつ動かすので、長いジョブの最中だとpreviewが待たされる。
値を返すと秘密値が出力に残るので、scriptは有無だけを返す。

```ts
export async function main() {
  const names = [
    "CLAUDE_CONFIG_DIR",
    "GH_CONFIG_DIR",
    "CLAUDE_VERSION",
    "DISABLE_AUTOUPDATER",
  ];
  return Object.fromEntries(names.map((n) => [n, process.env[n] !== undefined]));
}
```

`WHITELIST_ENVS`に変数を足すときは、`CLAUDE_CONFIG_DIR`を足さない。
ジョブのディレクトリを得られず`$HOME/.claude`に戻る経路で、人が手で使う永続の設定とジョブが共有になり、`--setting-sources user`が読む層に人の変更が混ざるためである。
理由は`f/factory/lib/claude.ts`のコメントにも書いてある。

### 実際に使われたモデルごとの使用量

`agent_runs.model`と`v_agent_usage_daily`の`model`は、`claude --model`に渡した値である。
1回の実行の中で別のモデルが使われても、費用とトークンは渡した値に数えられる。
実際に使われたモデルで数えるには、viewの`v_agent_model_usage_daily`を使う。

`agent_runs.model_usage`(jsonbの配列)には、`claude -p`の結果の`modelUsage`を、モデルごとに1要素で保存する。
要素は、`model`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`cost_usd`である。
Claudeが結果を返さなかった実行と、この列を足す前の実行は、空の配列である。
結果の`modelUsage`が無いときと、読めない要素が1つでもあるときは、実行を失敗にせず、内訳を空にする。
一部の要素だけを残すと、実行全体の費用と内訳の合計が食い違うためである。

viewは、日、実際に使われたモデル、Claudeのバージョン、工程ごとに、実行の数、費用、トークン数(入力、出力、キャッシュ読み出し、キャッシュ作成)を合計する。
`day`は`v_agent_usage_daily`と同じく、日本時間の0時で切る。
1回の実行が複数のモデルを使ったときは、それぞれのモデルに1回ずつ数える。
`model_usage`が空の実行は、渡した値と実行全体の値で1行として数え、`total_cache_creation_tokens`には入らない。
内訳を持つ実行と持たない実行が同じ行に混ざると、`total_cache_creation_tokens`は内訳を持つ実行だけの合計で、実際より小さい。
ターン数と実行時間は、モデルごとに分けられないので、このviewには出さない。
それらは`v_agent_usage_daily`で見る。

```sql
SELECT model, sum(run_count) AS runs, sum(total_cost_usd) AS cost_usd
FROM factory.v_agent_model_usage_daily
WHERE day >= now() - interval '14 days'
GROUP BY model
ORDER BY cost_usd DESC;
```

`model_usage`の`model`は、`modelUsage`のキーをそのまま保存する。
claude 2.1.302の`claude -p --output-format json`で、`--model haiku`(エイリアス)を渡した実行を確かめた。
`modelUsage`のキーは、エイリアスではなく、解決後の完全なモデルID(`claude-haiku-5-5`)だった。
値の項目名は、`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`costUSD`である。
この5つを保存する。
保存しない項目は、`webSearchRequests`、`contextWindow`、`maxOutputTokens`、`thinkingTokens`、`canonicalModel`ほかである。
既定の設定は完全なモデルIDなので、`--model`に渡す値とキーは一致する。
設定にエイリアスや`[1m]`などの接尾辞付きの値を書くと、同じモデルが別の行になりうる。
内訳のない実行は渡した値で数え、内訳のある実行はキーで数えるためである。
接尾辞付きの値のキーは確かめていない。
`model_usage`のキーは、次のクエリで確かめる。

```sql
SELECT DISTINCT m.model
FROM factory.agent_runs AS r
CROSS JOIN LATERAL jsonb_to_recordset(r.model_usage) AS m (model text)
ORDER BY m.model;
```

列を足すmigrationより先に、新しいコードが反映された間は、`model_usage`を除いた文で記録する。
このときの実行の内訳は残らない。

### PR修正の連続した失敗

同じPRの修正のうち、`blocked`でないラウンド(`done`か要件の不足)で最後に終えた時刻より後の、次の3つを足す。

- Claudeが動いたのに修正をpushせず`blocked`で終えたラウンド
- 検査が通らず再実行したラウンド
- Claudeの実行そのものの失敗(ターン上限、予算上限、タイムアウト、不正な出力)

使用上限か全停止で終わった実行(`agent_runs.failure_reason`が`usage_limit`か`stopped`)は、この3つのどれにも数えない。
モデルを強くしても防げないためである。
不正な出力の再試行で捨てた試行があるときは、最後の試行の種類で判定する。
その実行の後に再実行し、Claudeを起動せずに`blocked`で止まったラウンドは、そのラウンドの実行が無いので数える。
実装のラウンドの数え方でも、同じ実行の`error`のラウンドと、期限で起動しなかった実行(`not_started`)の`error`のラウンドを数えない。
`.git`ポインタの書き換えで記録した`check_failed`のラウンドは、実行の種類にかかわらず数える。

新しい指摘でラベルを付け直しただけのラウンドは数えない。
Claudeが動かなかったラウンドも数えないが、同じ作業項目で前にClaudeが動いていれば数える。
適用の実行(`pr_fix_apply`)の失敗は例外で終わってラウンドの記録を残さないので、実行の記録(`agent_runs`)の`error`から1回ずつ数える。
検査の再実行の失敗は、`pr_fix_verify`ステップで起きる。
例外にならず、`blocked`のラウンドを残すので、そのラウンドを`blocked`の1回として数える。
flowの再試行や`retry_work_item`で同じ作業項目の実行が何度失敗しても、失敗した回数だけ数える。
ラウンドの記録と重なる失敗は、次のように扱う。

- `blocked`で終えたラウンドの直前の実行の失敗は、`blocked`の1回に含めて重ねない。
  たとえば、検査の再実行が失敗して`blocked`になったときである。
- `blocked`のラウンドより前の失敗と、`blocked`の後に`retry_work_item`で再実行した失敗は、別に数える。
- `done`か要件の不足で終えたラウンドより前の失敗は数えない。
  成功が入ったので、連続が途切れるためである。
- 不正な出力を返して再試行したときは、捨てた最初の試行を数えず、再試行も失敗したときだけ1回と数える。
  捨てた試行は、同じ作業項目、stage、試行で10秒以内に次の記録がある失敗として見分ける。
  別の実行の記録は、flowの再試行の60秒の待ちを経て書かれるので、10秒以内には来ない。
  この見分けは、捨てた行と最後の行が同じ実行の中で続けて書かれ、両者の書き込みの間が10秒を超えないことを前提にする。
- 検査の再実行は、作業項目ごとに1回と数える。
  同じ作業項目で再実行が続いても増えない。
- 同じラウンドで検査の再実行と`blocked`が重なると、2回と数える。
  初回と再実行で、Sonnetが2回失敗しているためである。

### ラウンドの数を下限にする理由

Sonnetが毎回修正をpushして`done`で終え、再レビューで同じ指摘が付く経路は、失敗の記録が残らない。
連続した失敗だけでは、`max_fix_rounds`に達するまでSonnetのまま回って昇格しない。
そこで、ラウンド番号から1を引いた値を下限にする。
3ラウンド目に入ると、失敗の記録が無くても失敗の数が2になり、`heavy_model`を使う。

2つの数は、大きいほうを取る。
足さない。
ラウンドの数は`blocked`で終えたラウンドも含むので、足すと同じラウンドを2回数えるためである。
そのため、2ラウンド目(下限は1)で適用の実行が1回失敗した後のflowの再試行は、`max(1, 1)`で`model`のままになる。
一方、検査の再実行は下限に1回を足すので`heavy_model`になる。
この非対称は受け入れる。
検査の再実行は検査に落ちた後の2回目の修正で、モデルの失敗が確かである。
flowの再試行は基盤の障害でも起きるためである。
合わせると、次のように振る舞う。

- ラウンド番号は戻らないので、3ラウンド目以降は`heavy_model`から`model`に戻らない。
  `model`に戻れるのは、1、2ラウンド目に限る。
- 基盤の障害は、同じ作業項目の再実行で積み重なり、ラウンド番号を進めない。
  障害で下限が上がるのは、障害で作業項目が停止して、人が新しい指摘でラベルを付け直し、新しいラウンドが始まったときだけである。
- 復旧して最初の実行は、直前の失敗が残っているので`heavy_model`で動く。
  それが成功してラウンドが`done`で終わると、連続は途切れる。
- 新しい指摘が付いたラウンドも数える。
  指摘が続くだけで上がる粗い数え方で、誤差は早く上がる方向に出る。

PR修正の検査の再実行では、このラウンドの最初の修正が検査に通らなかった失敗が、まだ記録に無い。
そこで、検査の再実行のモデルを決める`prFixRetryModel`が、記録から出した失敗の数にその1回を足してモデルを選ぶ。
下限に当たるときも1回足すので、2ラウンド目の検査の再実行は`heavy_model`で動く。

### 数えるものの粗さ

数えるのは記録に残った結果だけなので、モデルの失敗でないものも入る。

- 実装の`error`と`check_failed`には、トークンの失効やAPIの障害、期限切れ、`.git`ポインタの不一致など、基盤の失敗も含まれる。
- PR修正の`blocked`には、返信だけで終えて何もcommitしなかったラウンド、人のpushでheadが動いたラウンド、ロックなど基盤の停止も含まれる。
  実行の失敗には、トークンの失効やAPIの障害も含まれる。
- PR修正は同じPRで数える。
  要件の不足で要件定義をやり直しても、ラウンド番号は戻らない。
- 返信だけでcommitの無いラウンドは`blocked`で記録される。
  基盤の障害の後で、Sonnetが正しく見送りを返しても、連続は数え直されない。
  記録から見送りと失敗を見分けられないので、多めに数える。
- `done`で終えた後に`retry_work_item`で再実行し、検査の再実行が起きても、時刻の比較で成功より前になるため数えない。
  昇格が1回遅れる側に外れるので受け入れる。

そのため、基盤の失敗が2回続くと`heavy_model`に上がる。
一方、次に成功したラウンドで数え直すので、復旧すれば`model`に戻る。
上がり方が早すぎても、損失の上限は`max_fix_rounds`(PR修正)、`implement_max_rounds`(実装)と、予算の上限で決まる。
ただし、PR修正を`retry_work_item`で再実行してもラウンドの番号は進まない。
人が再実行を繰り返す間は、予算の上限だけが損失を抑える。
