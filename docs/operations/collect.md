# GitHubの収集の運用

GitHubの収集を有効にして見守る手順と、IssueとPRの発見の元を確かめる手順である。
Factoryを運用する人が読む。
[運用](../operations.md)の手順のうち、収集にかかわるものをこの文書に置く。

## 収集の運用

`collect_github`が5分ごとに、`factory_config`の`owners`の所有者を順に読み、DBに集める。
集めるのは、リポジトリの一覧と、開いているPRとトリガーラベル付きのIssueの件数(段1)と、設定`gh_collect_detail_enabled`が`true`のときのそれらの詳細(段2)である。
tag `periodic`のworkerで動き、所有者ごとの読み取り専用のトークンだけを使う。
仕組みと記録の意味は[GitHubの収集](../internals/github-collect.md)にある。
設定`gh_collect_enabled`が`false`の間は、トークンを読まず、何も書かずに終わる。
既定は`false`である。
今の収集は記録を書くだけで、Factoryの判断は記録を読まない。
`self_update`だけが記録を読み、収集が続けて成功しているかを確かめる。
止まっていれば通知する([収集が止まったときの通知](#収集が止まったときの通知))。
`repo_allowlist`が空で`owners`に所有者がいるときは、設定で止めていても通知する([設定で止めた収集の通知](#設定で止めた収集の通知))。

### 収集を有効にする

反映の順は次のとおりである。
マージの後、`self_update`がscriptとスケジュールとmigrationを反映する。
このときは`gh_collect_enabled`が`false`なので、収集は何もしない。
反映を確かめてから、トークンを入れて有効にする。
`repo_allowlist`が空で`owners`に所有者がいる間は、有効にするまで、収集の無効の通知が残る。
新しいインスタンスは両方の設定が既定の`false`なので、この通知が最初から出る。
今は行動が要らない通知だが、これは受け入れている。
収集を有効にすると解決される。

1. 反映の後に、`gh_collect_enabled`が`false`のまま、収集が何も書かずに終わることを実ジョブで確かめる。

   ```bash
   wmill job list --script-path f/factory/collect_github --limit 3
   ```

   定期ジョブ用のworkerで動いたことを見る。
   `job get`の`worker`の名前に`periodic`が含まれていれば、動いている。
   `auto_retry_pr_review`と`notify_daily_summary`が続けて成功することも見る。
   未解決の通知`periodic_worker_missing`が残っていれば、次の`self_update`で解決される。
2. 所有者ごとの読み取りトークンを作り、環境変数`GITHUB_READ_TOKEN_<OWNER>`として投入する。
   手順は[セキュリティ](../security.md#収集用の読み取りトークン)と[セットアップ](../setup.md#資格情報を用意する)にある。
3. `mise run bootstrap`を実行し、Windmillの変数`github_read_tokens`に反映する。
4. 設定`gh_collect_enabled`を`true`に直す。
   リソースの値を取得し、直して、定義ファイルから反映する。

   ```bash
   wmill resource get f/factory/factory_config --json
   wmill resource push <定義ファイル> f/factory/factory_config
   ```

   取得した出力の`value`の項目だけを直し、`resource_type`と`description`は変えずに残して、定義ファイルに書く。
   定義ファイルは、リポジトリの外の一時ディレクトリに置く。
   反映した後に、もう一度取得し、直した項目以外が変わっていないことを確かめる。
5. 次の周回(5分以内)の後に、所有者ごとの実行の記録を読む。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT owner, ok, error_code, verified, id_checked, requests, cost, remaining, finished_at FROM factory.gh_collect_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 10"
   ```

   トークンを入れた所有者の`ok`が`true`で、`requests`と`cost`が残っていることを見る。
   トークンの無い所有者は`error_code`が`no_token`になる。
   成功が一度も無い所有者は、`repo_allowlist`が空でないとき、収集が動いている間は通知しない。
   `repo_allowlist`が空のときは、監視の開始から閾値の後に通知する。
   収集が止まると、最後の実行から18分の後に知らせる。
   一度成功した所有者が`no_token`になったときは、閾値を超えると`github_collect_stale`で知らせる。
6. 所有者ごとの`requests`が、リポジトリの数を100で割って切り上げた値に合うことを見る。
7. 設定の`repo_allowlist`が空の所有者は、[件数の確かめ方](#許可リストが空のときの件数の確かめ方)の手順で、一覧の漏れを確かめる。

### 詳細の収集を有効にする

設定`gh_collect_detail_enabled`は、既定が`false`である。
`false`の間、段2の要求を送らず、`gh_pull_requests`と`gh_issues`に書かない。
段1の失敗の扱いと、段1が使えない行を無効にする処理は、このキーによらず動く。

1. 収集を有効にし、段1が数周回で成功することを確かめる。
2. migrationが反映済みであることを確かめる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT to_regclass('factory.gh_pull_requests'), to_regclass('factory.gh_issues')"
   ```

   手順1から手順3の間は、`repo_allowlist`が空で`owners`に所有者がいると、収集の無効の通知が出る。
   手順3で両方の設定が`true`になると、自動で解決される。
3. `gh_collect_detail_enabled`を`true`に直す。
   直し方は[収集を有効にする](#収集を有効にする)の手順4と同じである。
4. 次の周回(5分以内)の後に、所有者ごとの実行の記録と、リポジトリごとの印を読む。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT owner, ok, error_code, stage, detail_targets, detail_requests, detail_done, detail_incomplete, finished_at FROM factory.gh_collect_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 10"
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT owner, repo, truncated, detail_failed, last_collected_at, last_attempted_at FROM factory.gh_repos WHERE NOT gone AND (truncated OR detail_failed OR last_collected_at IS NULL) ORDER BY owner, repo LIMIT 30"
   ```

   `detail_done`が`detail_targets`に近づき、`detail_failed`が真のリポジトリが続かないことを見る。
5. 止めるときは、`gh_collect_detail_enabled`を`false`に戻す。
   書いた行は残る。
   使えない行の無効化は続き、閉じた行はDBの掃除が保持期間で消す。
   `repo_allowlist`が空で`owners`に所有者がいるときは、`false`の間、収集の無効の通知が残る。
   止めたままにするなら、先に`repo_allowlist`に必要なリポジトリを並べる。

段1は、段2が有効なとき、残りが40秒を切ると新しい要求を始めない。
約600リポジトリ以上の所有者は、`stage`が`list`の`deadline`が続く。
そのときは、リポジトリを減らすか、段2を止める。

### 収集が止まったときの通知

`self_update`が2分ごとに、所有者ごとの最後の成功を確かめる。
最後の成功は、全ページを取り終え、照合が通った実行である。
最後の成功からの経過が閾値を超えると、要対応の通知`github_collect_stale`を所有者ごとに1件残し、Discordに1回送る。
Discordの通知には、閾値、最後の成功の時刻(JST)、最新の実行の原因、次の操作、Consoleの通知へのリンクが載る。

閾値は、`owners`が2人までなら25分である。
3人以上なら、所有者の数をnとして`(2n + 1) × 5分`である。
所有者は順に予算を使うので、自分の番の周回で1回失敗すると、成功の間隔が`2n × 5分`まで延びる。
その間隔に、収集の1周回の余裕を足した値である。

基準の時刻は、最後の成功と、監視が所有者を有効の状態で初めて見た時刻の遅い方である。
長く無効にした後と、`owners`に足し直した後は、古い成功から閾値を超えたと誤って判定しないためである。
監視の開始時刻は、`self_update`のWindmillのstateに、キー`gh_collect_watch_since_ms`で残す。
stateを読めない回は、所有者の最古の実行の開始時刻で代える。
基準を決められない所有者は、通知せず、解決もしない。

次の場合は、閾値を超えても知らせない。
行動が要らないか、別の通知が知らせるためである。

| 状況 | 扱い |
| --- | --- |
| 成功が一度も無く、トークンの無い所有者。収集が動いている間で、`repo_allowlist`が空でないとき | 通知しない。最新の実行の終わりが18分以内なら、収集が動いていると見なす。`repo_allowlist`が空のときは、この行に当たらず、猶予の後に通知する |
| レート制限で待っている間 | 待ちが終わってから10分まで通知しない。基準の時刻から60分を超えたら通知する |
| GitHubの5xxと時間切れ | 基準の時刻から60分まで通知しない |
| 最新の実行が150秒以内に始まって実行中 | 通知しない |
| 定期ジョブ用のworkerが止まっている | 新しい通知を足さない。`periodic_worker_missing`が知らせる |

最新の実行の終わりが18分より前なら、収集が動いていないと見なす。
定期ジョブ用のworkerの待ち(最大13分)に、収集の1周回を足した時間である。
このとき通知の原因は、スケジュールが止まったか、定期ジョブ用のworkerが受けていないことである。

`repo_allowlist`が空のときは、成功が一度も無くトークンの無い所有者も、ほかの所有者と同じ猶予と閾値で通知する。
猶予は、監視の開始時刻から閾値までである。
原因は`no_token`で、本文は所有者の通知と同じ固定の文である。
トークンを入れて収集が成功すると解決し、`no_token`の間は解決しない。
`repo_allowlist`が空でないと、明示のリポジトリだけが対象なので、この所有者は通知しない。

通知は、収集が成功に戻ると、自己更新が自動で解決する。
所有者を`owners`から外したときも解決する。
`gh_collect_enabled`を`false`にしたときは、`repo_allowlist`が空でなければ、立っている通知をすべて解決する。
`repo_allowlist`が空なら解決しない([設定で止めた収集の通知](#設定で止めた収集の通知))。
止まったまま人が解決すると、次の自己更新で出直す。

所有者の収集が成功していても、一部のリポジトリの記録だけが古いままのときがある。
そのときは、本文が`<所有者>のリポジトリ:`と空白で始まる通知を、所有者ごとに1件残し、Discordに1回送る。
Discordの通知には、閾値、記録が古いリポジトリの数と理由別の内訳(日本語の語)、次の操作、Consoleの通知へのリンクが載る。
数えるのは、`repo_allowlist`と`factory_repo`で明示していない、許可されたリポジトリである。
一覧から消えたリポジトリと、archive済みのリポジトリは数えない。
新しく一覧に載ったリポジトリは、載った時刻から閾値の間、古くても数えない。

この通知は、所有者の収集が成功しても解決しない。
足す閾値は、所有者の通知と同じである。
解決は、対象のリポジトリがすべて、下流が記録を使う閾値(`max(15分, (n+1)×5分)`)の内へ戻ったときに、自己更新が自動で行う。
2つの閾値の間では、noticeを足さず、解決もしない。
通知が出ては消えることを繰り返さないためである。
レート制限などで待っている間は、noticeを足さず、解決もしない。
`gh_collect_detail_enabled`を`false`にすると、詳細を集めないので、対象を0件として扱い、立っている通知を解決する。
`repo_allowlist`が空のときは、代わりに収集の無効の通知が立つ([設定で止めた収集の通知](#設定で止めた収集の通知))。

打ち切りが続くリポジトリは、記録が進まないので、通知が残り続ける。
次のどれかで直す。

- `repo_allowlist`で、集めるリポジトリを絞る。
- 開いたPRが多いリポジトリなど、規模の大きいリポジトリを減らす。
- `collect_github`のジョブログで、そのリポジトリの失敗を確かめる。

記録が古いリポジトリは、次のSQLで探す。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT repo, last_collected_at, last_attempted_at, truncated, detail_failed, first_seen_at FROM factory.gh_repos WHERE owner = '<所有者>' AND NOT gone AND NOT archived ORDER BY last_collected_at NULLS FIRST LIMIT 20"
```

記録が古くなってから通知が出るまで、記録が下流で使えない状態が通知なしに続く。
下流は、記録の経過が`max(15分, (n+1)×5分)`を超えると、記録を使わなくなる。
通知が出るまでの上限は、通知の閾値に、レート制限などの待ちの最大60分が足された時間である([鮮度の足りないリポジトリ](../internals/github-collect.md#鮮度の足りないリポジトリ))。

同じ停止について、ほかの通知と重なって届くことがある。
収集が例外で落ち続けると、`job_failed`と`schedule_failing`に重なる。
設定にIDがある所有者の`owner_mismatch`では、`owner_id_mismatch`に重なる。
二重に届く害は、黙る害より小さいので、重なりを抑えない。

通知を受けたら、Discordの「次の操作」と、Consoleの通知の説明に従う。
最新の実行の`error_code`は[実行の記録の読み方](../operations.md#実行の記録の読み方)の表で対処を引く。
記録が古いときは、スケジュールとジョブの履歴を確かめる。

```bash
wmill schedule get f/factory/collect_github --json
wmill job list --script-path f/factory/collect_github --limit 5
```

### 設定で止めた収集の通知

`repo_allowlist`が空で`owners`に所有者がいるときは、`owners`の全リポジトリが対象になりうる。
このとき、`gh_collect_enabled`か`gh_collect_detail_enabled`のどちらかが`false`の間は、収集の記録が更新されない。
この状態を通知なしに続けないため、`github_collect_stale`の通知を所有者ごとに1件残し、Discordに1回送る。
本文は`<所有者>の収集の無効:`と空白で始まる固定の文で、所有者の通知とリポジトリの古さの通知の先頭と重ならない。
Discordの通知の原因は`collect_disabled`で、次の操作が載る。

`gh_collect_enabled`が`false`の間だけ、立っている所有者の通知とリポジトリの古さの通知を解決しない。
`gh_collect_detail_enabled`だけが`false`の間は、リポジトリの古さの通知を解決し、収集の無効の通知を立てる。
所有者の通知は、どちらの場合も通常どおり判定する。
設定の事実なので、定期ジョブ用のworkerが止まっていても抑えない。

次のどれかで、自己更新が自動で解決する。

- 両方の設定を`true`に戻す。
- `repo_allowlist`に1件以上並べる。
- その所有者を`owners`から外す。

`repo_allowlist`が空でないと、明示のリポジトリだけが対象なので、この通知は出ない。
このとき`gh_collect_enabled`が`false`なら、立っている通知はすべて解決する。
`owners`が空のときも出さない。

### 許可リストが空のときの件数の確かめ方

`repo_allowlist`が空の所有者は、見えないリポジトリを判別できない。
`repo_allowlist`にあるリポジトリが一覧に無いときは`not_visible`として記録するが、空のときはその手がかりが無いためである。
`gone`でないリポジトリの件数を、GitHubの所有者のリポジトリ一覧(forkとarchivedを除く)の件数と、目で比べる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT owner, count(*) AS repos FROM factory.gh_repos WHERE NOT gone GROUP BY owner ORDER BY owner"
```

合わないときは、トークンのRepository accessと、組織の承認を確かめる。

### 収集を止める

- 収集だけを止めるには、`repo_allowlist`に必要なリポジトリを並べてから、`gh_collect_enabled`を`false`に戻す。
  設定は上と同じ手順で直す。
  `factory_config`はsyncの対象外なので、反映で上書きされない。
  `repo_allowlist`が空のまま`false`にすると、収集の無効の通知が残る。
  `owners`を空にして止める方法は、Factory全体が止まるので使わない。
  `repo_allowlist`が空でない間の無効は、収集の通知を出さず、残った通知を自己更新が解決する。
- スケジュールを止めるには、`collect_github.schedule.yaml`の`enabled`を`false`にする修正のPRを出す。
  `self_update`が`sync push`するので、Windmillの画面で止めても上書きされうる。
  確認のために画面で止めるときは、先に凍結を置く([凍結とdeployの保留の内部仕様](../internals/freezes.md)の「運用手順」)。
  スケジュールだけを止めると、収集が成功しなくなるので、閾値の後に通知が出る。
  止めるつもりなら、`repo_allowlist`に必要なリポジトリを並べてから、`gh_collect_enabled`も`false`にする。
- migrationのdownは自動では走らない。
  表は残るが、害は無い。

### 設計工程のmigrationを戻す

設計工程のmigrationを戻す手順である。
`wmill datatable migrate down`は1回に最新の1つだけを戻し、途中のmigrationを飛ばす指定は無い。
新しい順に打つので、設計工程のmigrationに届くまでに、設計工程より新しいmigrationも戻ることになる。

1. 設計工程より新しいmigrationを、新しい順にすべて戻す。
   何があるかは`ls migrations/datatable/main`で確かめ、`20261026130000_design_drafts`より新しい名前を数える。
2. 次の表の3つを、上から順に戻す。

| 順 | migration | 戻る内容 |
| --- | --- | --- |
| 1 | `20261026130000_design_drafts` | 設計の下書きの表(`design_drafts`)と、要件定義の下書きの複合の一意制約が戻る |
| 2 | `20261026120100_design_stage_approval_kind` | 承認依頼の種類の制約から`design`が外れる |
| 3 | `20261026120000_design_stage_work_items` | 作業項目の列(`design_attempt`)、状態の制約、一意インデックスが戻る |

設計の下書きが先に戻り、承認の記録を失わないために、承認依頼の制約がその次に戻る。
表の3行目では、`designing`と`awaiting_design_approval`の作業項目が人の対応待ち(`needs_human`)に移り、元の状態が`work_item_events`に残る。

#### 戻す前に反映するコード

最初の`migrate down`を打つ前に、戻す列や表を読み書きしないコードを反映する。
設計工程より新しいmigrationにも、同じ確認が要る。
`ls`で見つけたmigrationのdownを読み、戻す列や表を使うコードを先に外す。

- `design_attempt`は、作業項目を読むコードが必須の列として読む。
  列を先に消すと、作業項目を読むすべての経路が例外になる。
- 作業項目の進め方の列(`profile`)は、状態を移す更新が書くので、列を先に消すと、状態を移すすべての更新と自動再開の候補の取得が失敗する。
  この列を足したmigrationも、設計工程より新しいので、戻す前に名指しで書くコードを外す。
- 設計中の作業項目のジョブが動いている間に表の3行目を戻すと、フローの後の状態の書き込みが制約に当たって失敗する。
  戻す前に設計フローを止める。
- 要件定義の下書きの基準値の列(`doc_hash`)は、列が無ければ基準値の無い下書きとして保存し、読む。
  例外にはならないが、基準値が空になり、承認済みの要件定義の書き換えの照合が飛ぶ。
  列を消した後に`migrate up`で当て直しても、既存の下書きの基準値は空のままである。
  列を消した後に下書きを保存すると、通知`doc_hash_column_missing`(要対応)が残る。
  対応は[通知の種類](../operations.md#通知の種類)の表に書く。
- Consoleの操作の記録の表(`console_actions`)は、操作の記録を書くコードが残っていると、表が無いエラーで記録の挿入が失敗し、Consoleの書き込みの操作が拒否される。

`doc_hash`と`console_actions`は、どちらも設計工程のmigrationではなく、設計工程より新しいmigrationが足す。

#### 新しいmigrationも戻ること

`migrate down`に飛ばす指定が無いので、設計工程だけを戻すことはできない。
表の1行目に届くまでに、設計工程より新しいmigrationが戻り、その内容は失われる。
`doc_hash`の列が消え、`console_actions`の操作の記録が失われる。
これらを残すなら、設計工程のmigrationは戻さない。

#### 失敗したとき

表の1行目は、`design_drafts`に行が1件でもあれば、先頭で足す制約の検証に失敗する。
トランザクションごと戻るので、表と制約は残る。
設計の下書きを、行があるまま失わないためである。
行の扱いを決めて消してから、1行目をやり直す。

設計工程より新しいmigrationには、ラウンドの結果の制約を戻すものが2つある。
実装のラウンドは`20261028100000_implement_rounds_design_gap`である。
PR修正のラウンドは`20261028110000_fix_rounds_design_gap`である。
どちらも、`design_gap`のラウンドが1件でもあれば、制約の足し直しに失敗する。
トランザクションごと戻るので、制約とラウンドは残る。
ラウンドは修正の記録で、行を失わないためである。
設計工程が無効の間は、`design_gap`のラウンドは書かれないので、通常は止まらない。
止まったときは、`implement_rounds`と`fix_rounds`で`outcome = 'design_gap'`の行を確かめ、扱いを決めてから、やり直す。

設計工程は既定で無効で、無効の間は、設計の下書きも設計の承認依頼も書き込まれない。
そのため、設計工程を有効にしたことがなければ、通常は表の1行目と2行目で止まらない。
有効にしたことがあると、設計の下書きと種類が`design`の承認依頼が残るので、止まりうる。
2行目が失敗したときは、種類が`design`の承認依頼が残っている。
制約を足し直せないので、migrationはそこで止まる。
`approval_requests`で`kind = 'design'`の行を確かめ、扱いを決めてから、2行目をやり直す。

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

## Issueの発見の元を確かめる

`poll_issues`は、`gh_collect_enabled`と`gh_collect_detail_enabled`が真のとき、トリガーラベル付きのIssueを収集の表から見つける。
表を使えない明示リポジトリ(`factory_repo`と`repo_allowlist`の各項目)は、その周回だけRESTの一覧で読む。
一覧は`GET /repos/{owner}/{repo}/issues?labels=<トリガーラベル>&state=open`である。
どちらも検索を使わない。
発見の元を選ぶ設定は無い。
リソースに削除した設定の項目が残っていても、読み捨てられて動作に影響しない。
詳しくは、[GitHubの収集の内部仕様](../internals/github-collect.md#所有者の単位の読み取り)にある。
付与者の確認、取得、作業項目の登録、通知は、どの経路でも同じである。

リポジトリごとに記録の鮮度を判定する。
閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`である。
鮮度が足りないときの扱いは、明示リポジトリかで分かれる。

- 明示リポジトリ: 一覧で読む。
  `gh_repos`に行が無いとき、表の読み取りが失敗したとき、収集の設定が偽のときも、一覧で読む。
- 明示でないリポジトリ: 見送る。
  見送りは失敗にしない。
  通知は鮮度の監視が出す([リポジトリ単位の古さ](../internals/github-collect.md#リポジトリ単位の古さ))。

鮮度の判定の語は、次の5つである。

- `no_record`: 明示リポジトリの行が`gh_repos`に無い。
- `unusable`: 記録の`allowed`が偽、開いた行がすべて使えない、または明示リポジトリが読み取りトークンに見えないか一覧から消えている。
- `not_collected`: 詳細を一度も取り終えていない。
- `in_future`: `last_collected_at`がDBの時刻より後である。
- `too_old`: 記録の時刻が閾値を超えている。

候補は、表の行も一覧の番号も`getIssue`で読み直す。
使うのは、開いていて、PRでなく、トリガーラベルが付いているものだけである。
閉じたIssue、PR、ラベルが外れたIssueは、失敗にせず外す。

次の4つに注意する。

- ラベルを付けてから着手までが、表を使うリポジトリでは、普段は4〜9分ほどになる。
  次の収集が終わるまで表に載らないためである。
  明示リポジトリで一覧を読んでいる間は、遅れない。
- 収集の設定の片方でも偽の間は、明示リポジトリ以外のIssueを見つけない。
  `repo_allowlist`が空のときは、鮮度の監視が通知を出す。
  止めるなら、先に`repo_allowlist`へ必要なリポジトリを並べる。
- 明示でないリポジトリの記録が閾値を超えている間は、そのリポジトリのIssueを見つけない。
  鮮度の監視が通知するまでの間は、黙って見送る。
- 処理の順が、リポジトリと番号の順になる。

次の手順で、収集が動き、表が使えていることを確かめる。

1. [詳細の収集を有効にする](#詳細の収集を有効にする)を済ませ、対象のリポジトリの記録が進んでいることを確かめる。
   `gh_repos`の`allowed`、`archived`、`gone`、`age`の見方は、[候補の元を確かめる](features.md#候補の元を確かめる)の手順1と同じである。
2. 表の結果とGitHubの結果を照らし合わせる。
   所有者ごとに、表の側を次のSQLで集める。
   閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`で、`interval`に書く。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "SELECT i.repo || '#' || i.number FROM factory.gh_issues i JOIN factory.gh_repos r ON r.owner = i.owner AND r.repo = i.repo AND r.repo_id = i.repo_id WHERE i.owner = '<owner>' AND i.state = 'open' AND i.usable AND r.allowed AND NOT r.gone AND NOT r.archived AND now() - r.last_collected_at <= interval '15 minutes' ORDER BY 1"
   ```

   GitHubの側は、リポジトリごとにRESTの一覧を読む。
   PRも返るので、`pull_request`を持つ要素を除く。

   ```bash
   gh api -X GET repos/<owner>/<repo>/issues -f labels='<トリガーラベル>' -f state=open -f per_page=100 --paginate --jq '.[] | select(has("pull_request") | not) | "<repo>#" + (.number | tostring)' | sort -u
   ```

   2つの出力をファイルに保存し、`cmp -s`で比べて、`same`と`different`のどちらになったかだけを見る。
   トリガーラベルは取得のときに外れるので、開いたトリガーラベル付きのIssueは、ふだん0件か数件しかない。
   両方が空で`same`でも、表の経路が実際のトリガーを見つけることの確かめにはならない。
   手順6で、自然に付いたラベルの着手までの遅れを記録して補う。
   `different`なら、収集の周回の遅れ(5分以内)で説明できるかを確かめ、数分後に読み直す。
   GitHubが1件以上を返し、表の候補が0件のリポジトリがあるときは、収集のラベルの絞り込みが合っていないおそれがある。
   次の確認で説明できなければ、収集の不具合として調べる。
3. 収集がラベルの絞り込みで、ラベル名の大小文字を区別しないことを確かめる。
   収集はGraphQLの`issues(labels: [...])`でIssueを絞る。
   この挙動が変わると、表に行が載らないまま、リポジトリが`fresh`で見落とされる。
   実行中には検知できないので、`trigger_label`を変えたときと、収集の周りを変えたときに確かめる。
   開いたIssueかどうかを問わず、ラベルが付いたIssueのあるリポジトリで、同じラベル名の小文字、先頭だけ大文字、すべて大文字の3通りの`totalCount`を比べる。

   ```bash
   gh api graphql -f 'query=query { repository(owner: "<owner>", name: "<repo>") { a: issues(labels: ["<小文字>"]) { totalCount } b: issues(labels: ["<先頭だけ大文字>"]) { totalCount } c: issues(labels: ["<すべて大文字>"]) { totalCount } } }' --jq .data.repository
   ```

   3つが等しければ、大小文字を区別していない。
   等しくなければ、収集の側の変更として扱う。
   明示リポジトリを読む一覧のAPIも、同じ性質を前提にする。
   ラベル名の大小文字と、カンマを含むラベル名が合うことを、次のコマンドで確かめる。

   ```bash
   gh api -X GET repos/<owner>/<repo>/issues -f labels='<トリガーラベル>' -f state=open --jq 'length'
   ```

   大小文字を変えたラベル名でも件数が等しいことと、カンマを含む名前が複数のラベルの指定として読まれないことを見る。
4. 続く3回の`poll_issues`の結果を、Consoleのジョブの画面で確かめる。
   履歴をscriptで絞り、各ジョブの結果を読む。
   `collect_disabled`が`false`、`failed`が0であることを見る。
   `candidates`は、手順2の表の候補の数と近いはずである。
   `dropped`は、0か、古い行で説明できる値になる。
   失敗の記録に、段`read_gh_owner_issues:<owner>`、`list_labeled_issues:<owner>/<repo>`、`confirm_issue:<owner>/<repo>#<番号>`が続かないことを見る。
5. 表の経路で最初に作られた`issue`の作業項目で、`owner`と`repo`がGitHubの正規の綴りと大小文字まで一致することを確かめる。
   一致しなければ、収集の不具合として調べる。
   綴りは`gh api repos/<owner>/<repo> --jq .full_name`で読む。
6. 1日の間、`poll_issues`の失敗の記録に403と429が無いことを確かめる。
   自然にトリガーラベルが付いたら、付けた時刻から着手までの遅れを記録する。

結果の`rest_lists`と`skipped_stale`が1以上なら、理由の語で原因を読む。
`rest_lists`は表の代わりに一覧で読んだ明示リポジトリの数で、理由は`rest_reasons`に出る。
`skipped_stale`は見送った明示でないリポジトリの数で、理由は`skipped_stale_reasons`に出る。

| 理由の語 | 対処 |
| --- | --- |
| `collect_disabled` | `gh_collect_enabled`か`gh_collect_detail_enabled`が偽である。意図した停止でなければ、真に戻す。`rest_reasons`にだけ出る |
| `no_record` | `gh_repos`に明示リポジトリの行が無い。そのリポジトリが収集の対象(`owners`の所有者の、forkでないリポジトリ)かと、`repo_allowlist`の書き間違いを確かめる。`rest_reasons`にだけ出る |
| `unusable` | 許可の外か、開いた行がすべて使えない。明示リポジトリが読み取りトークンに見えない、または一覧から消えた(`gone`)ときも当たる。forkや改名前の名前が`repo_allowlist`にあると、毎周回一覧で読み、本当に消えたリポジトリは404が失敗として残る。記録が閾値の内にあるarchive済みの明示リポジトリは、この語にならず、一覧でも読まない |
| `not_collected`、`too_old` | 詳細が取り終えられていない。`truncated`、`detail_failed`、所有者の`gh_collect_runs`の`detail_targets`と`detail_incomplete`を見て、[実行の記録の読み方](../operations.md#実行の記録の読み方)の対処をする |
| `in_future` | `last_collected_at`がDBの時刻より後で、正しく書かれていれば起きない。収集の不具合として調べる |
| `read_failed` | 表の読み取りが失敗した。失敗の記録の段`read_gh_owner_issues:<owner>`と、DBの状態を確かめる。`rest_reasons`にだけ出る |

定期ジョブ用のworkerの待ちや一時的な収集の失敗で説明でき、確認の期間を延ばして0に戻るなら、そのままにする。
説明できなければ、収集の失敗として調べる。

一覧の読み取りが失敗すると、失敗の記録の段`list_labeled_issues:<owner>/<repo>`に残り、`failed`に数える。
トリガーラベルの付いた開いたIssueとPRが合わせて1000件を超えるリポジトリでは、一覧が上限に当たって失敗し続ける。
ラベル付きのPRも一覧に含まれ、10ページ分に数えるためである。
一覧を読むのは、収集が止まっている間と、収集が集めない明示リポジトリである。
開いたPRが90件を超えて収集が打ち切られている明示リポジトリも読む。
外の人がforkから自分でPRを開けて、そこへ到達できる。
1000件を超えると、通知なしに失敗が続く。
明示リポジトリの一覧が失敗し続けても、通知は出ない。
失敗は`job_failures`に残り、日次のまとめに載る。
`repo_allowlist`が空でないと、リポジトリ単位の古さの通知と収集の無効の通知が出ないためである。
結果の`failed`と、失敗の記録の段`list_labeled_issues:`を定期的に見る。

`confirm_issue:`が404で続くときは、読み取りトークンに見えるが、書き込みのPATに見えないリポジトリがある。
書き込みのPATがそのリポジトリを読めないので、候補を確かめられない。
読み取りトークンの範囲を書き込みのPATに合わせるか、`repo_allowlist`で絞って直す。

`confirm_issue:`の不一致が続くときは、明示リポジトリの移管か改名を疑い、`repo_allowlist`を直す。
旧名は新しい名前に転送され、別のリポジトリの番号が返って、不一致で落ちる。
安全側に倒れるが、通知は出ない。

`trigger_label`を変えるときは、手順2と手順3をやり直す。
収集が各リポジトリを取り直すまで、表は古いラベル名で答えるためである。

## PRの発見の元を確かめる

`poll_prs`は、`gh_collect_enabled`と`gh_collect_detail_enabled`が真のとき、ラベル、レビューの依頼、assigneeのPRを収集の表から見つける。
表を使えない明示リポジトリ(`factory_repo`と`repo_allowlist`の各項目)は、その周回だけRESTの一覧で読む。
一覧は`GET /repos/{owner}/{repo}/pulls?state=open`である。
どちらも検索を使わない。
発見の元を選ぶ設定は無い。
リソースに削除した設定の項目が残っていても、読み捨てられて動作に影響しない。
詳しくは、[GitHubの収集の内部仕様](../internals/github-collect.md#所有者の単位の読み取り)にある。
付与者の確認、作者の確認、取得、作業項目の登録、通知、追跡中のPRの見つけ直しは、どの経路でも同じである。

リポジトリごとに記録の鮮度を判定する。
閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`である。
鮮度が足りないときの扱いは、明示リポジトリかで分かれる。

- 明示リポジトリ: 一覧で読む。
  `gh_repos`に行が無いとき、表の読み取りが失敗したとき、収集の設定が偽のときも、一覧で読む。
- 明示でないリポジトリ: 見送る。
  見送りは失敗にしない。
  通知は鮮度の監視が出す([リポジトリ単位の古さ](../internals/github-collect.md#リポジトリ単位の古さ))。

鮮度の判定の語は、[Issueの発見の元を確かめる](#issueの発見の元を確かめる)と同じ5つである。

表の行と一覧の要素は、同じ規則で4つの条件に分ける。
条件は、PATのアカウントへのレビューの依頼、PATのアカウントのassignee、レビューのラベル、修正のラベルである。
依頼とassigneeは、PATのアカウントの数値IDで比べる。
どれにも当たらない行は読まない。
当たる行と、ラベルかassigneeが不明の行は、`getPr`と`getIssue`で読み直す。
使うのは、開いていて、ラベルかPATのアカウントへの依頼かassigneeに当たるものだけである。
閉じたPRと、どれにも当たらなくなったPRは、失敗にせず外す。
`requested_reviewers`を読めないときは、外さずに失敗として記録する。
候補にした後は、`buildPrCandidate`がもう一度`getPr`と`getIssue`を読む。
候補ごとにRESTの読み取りが2回増える。

チーム宛てのレビューの依頼は、組織の所有者のPRだけ、PATのアカウントが属するチームの数値IDと、PRの依頼先のチームの数値IDで照合する。
照合が要る行は、分類が「チーム」で、チームへの依頼が偽と分かっていない行である。
組織の所有者に、そのような覚えていない行が1件でもある周回だけ、`GET /user/teams`を1回読む。
個人の所有者のリポジトリには、チーム宛ての依頼が付かない。
個人の所有者の行は、直接の依頼だけで判定する。
`GET /user/teams`とstateは使わない。

照合が要る行は、`getPr`の`requested_reviewers`と`requested_teams`で確かめる。
直接の依頼か、PATのアカウントが属するチームへの依頼があれば、候補にする。
チームへの依頼は、PRの作者が許可された人(PATのアカウントと`allowed_labeler_logins`)のときだけ数える。
許可されていない人が開いたPRは、チームへの依頼が付いていても、直接の依頼でなければ候補にしない。
どちらでもなければ、失敗にせず外し、`dropped`に数える。
`requested_teams`を読めないときは、外さずに失敗として記録する。

組織の所有者では、その組織のチームが1件でも返ったときだけ、チームを使える。
`GET /user/teams`を読めなかったとき、またはその組織のチームが1件も返らないときは、その組織のチームを使えない。
チームを使えない間は、チーム宛ての依頼だけが付いた行を、確かめずに見送る。
ほかの行は、直接の依頼だけを確かめる。
直接の依頼でなければ、見送る。
見送った数は`team_unresolved`に出る。
組織ごとに、固定の文の失敗(段`viewer_teams:<owner>`)を毎周回1件記録する。
`GET /user/teams`の失敗の理由は、段`viewer_teams`に残る。
どちらも通知は出ないので、組織の所有者を足したら、`failed`と失敗の記録を見る。

チームを使えて、照合の結果対象でなかったPRは、リポジトリ、番号、headのコミットで覚え、1時間は確かめ直さない。
覚えは、`poll_prs`のstateの`team_checked_prs`に置く。
stateを読めない、または書けないときは、覚えていない扱いにして確かめる。
同じheadのまま別のチームが依頼されたPRも、1時間以内に確かめ直される。
確かめずに済ませた件数は`team_remembered`に出る。
分類が「チーム」の行をRESTで確かめるのは、1周回に20件までである。
候補を鍵の昇順に並べ、前の周回で確かめた最後の候補の鍵より後ろから選ぶ。
末尾に来たら、先頭に戻る。
その鍵は、結果によらず、stateの`team_confirm_cursor`に置く。
超えた件数は`team_capped`に出る。
超えた分は、次の周回以降に、続きから確かめられる。
stateを書けない間は、毎周回先頭から選ぶ。

組織の所有者を足すときは、先に[組織の所有者を足す前の確認](#組織の所有者を足す前の確認)の手順を実施する。

次の6つに注意する。

- ラベルを付けてから着手までが、表を使うリポジトリでは、普段は4〜9分ほどになる。
  次の収集が終わるまで表に載らないためである。
  明示リポジトリで一覧を読んでいる間は、遅れない。
- 収集の設定の片方でも偽の間は、明示リポジトリ以外のPRを見つけない。
  `repo_allowlist`が空のときは、鮮度の監視が通知を出す。
  止めるなら、先に`repo_allowlist`へ必要なリポジトリを並べる。
- 明示でないリポジトリの記録が閾値を超えている間は、そのリポジトリのPRを見つけない。
  鮮度の監視が通知するまでの間は、黙って見送る。
- archive済みのリポジトリは、記録が閾値の内にあるとき読まない。
  読み取り専用で、ラベルを外すことも作業項目の起動もできない。
- `repo_allowlist`が空の構成では、`gh_repos`に行の無いリポジトリのPRを見つけない。
  所有者のfork、直近の一覧より後に作られたリポジトリ、読み取りトークンに見えないリポジトリが当たる。
- 処理の順が、リポジトリと番号の順になる。

次の手順で、収集が動き、表が使えていることを確かめる。

1. [詳細の収集を有効にする](#詳細の収集を有効にする)を済ませ、対象のリポジトリの記録が進んでいることを確かめる。
   `gh_repos`の`allowed`、`archived`、`gone`、`age`の見方は、[候補の元を確かめる](features.md#候補の元を確かめる)の手順1と同じである。
   `repo_allowlist`が空でないことも確かめる。
   空だと、上の5つ目の変化が当たる。
2. 所有者ごとに、表の開いたPRの行が、4つの条件のどれに当たるかを数える。
   PATのアカウントの数値IDは、`gh api user --jq .id`で読む。
   閾値は、`owners`の所有者がn人のとき`max(15分, (n+1)×5分)`で、`interval`に書く。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "WITH open_rows AS (SELECT p.*, (p.has_review_label IS TRUE OR p.has_fix_label IS TRUE OR <PATの数値ID> = ANY(p.review_requested_user_ids) IS TRUE OR <PATの数値ID> = ANY(p.assignee_ids) IS TRUE) AS is_target FROM factory.gh_pull_requests p JOIN factory.gh_repos r ON r.owner = p.owner AND r.repo = p.repo AND r.repo_id = p.repo_id WHERE p.owner = '<owner>' AND p.state = 'open' AND p.usable AND r.allowed AND NOT r.gone AND NOT r.archived AND now() - r.last_collected_at <= interval '15 minutes') SELECT count(*) FILTER (WHERE is_target) AS target, count(*) FILTER (WHERE NOT is_target AND (team_review_requested IS NOT FALSE OR review_requested_user_ids IS NULL)) AS team, count(*) FILTER (WHERE NOT is_target AND team_review_requested IS FALSE AND review_requested_user_ids IS NOT NULL AND (has_review_label IS NULL OR has_fix_label IS NULL OR assignee_ids IS NULL)) AS maybe FROM open_rows"
   ```

   `team`の行は、直接の依頼を`getPr`で確かめる。
   個人のアカウントの所有者で`team`が1以上なら、原因を調べる。
   そのPRの`gh api repos/<owner>/<repo>/pulls/<番号>`で、`requested_reviewers`と`requested_teams`を見る。
   依頼先の利用者を読めない、削除された、収集の項目のエラーが原因になりうる。
   組織の所有者で、`requested_teams`にチームが入ったPRは、PATのアカウントが属するチームへの依頼なら、チームの数値IDの照合で当たる。
   `maybe`は、`getPr`と`getIssue`で確かめる行の数である。
3. 表の対象の行と、一覧の結果を照らし合わせる。
   表の側は、次のSQLで集める。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -At -c "SELECT p.repo || '#' || p.number FROM factory.gh_pull_requests p JOIN factory.gh_repos r ON r.owner = p.owner AND r.repo = p.repo AND r.repo_id = p.repo_id WHERE p.owner = '<owner>' AND p.state = 'open' AND p.usable AND (p.has_review_label IS TRUE OR p.has_fix_label IS TRUE OR <PATの数値ID> = ANY(p.review_requested_user_ids) IS TRUE OR <PATの数値ID> = ANY(p.assignee_ids) IS TRUE) AND r.allowed AND NOT r.gone AND NOT r.archived AND now() - r.last_collected_at <= interval '15 minutes' ORDER BY 1"
   ```

   GitHubの側は、リポジトリごとにRESTの一覧を読み、4つの条件に当たる要素を集める。

   ```bash
   gh api -X GET repos/<owner>/<repo>/pulls -f state=open -f per_page=100 --paginate --jq '.[] | select(any(.labels[]; (.name | ascii_downcase) == ("<review_label>" | ascii_downcase) or (.name | ascii_downcase) == ("<fix_label>" | ascii_downcase)) or any(.assignees[]; .id == <PATの数値ID>) or any(.requested_reviewers[]; .id == <PATの数値ID>)) | "<repo>#" + (.number | tostring)' | sort -u
   ```

   2つの出力をファイルに保存し、`cmp -s`で比べて、`same`と`different`のどちらになったかだけを見る。
   トリガーラベルは取得のときに外れるので、ラベルで対象になるPRは、ふだん0件か数件しかない。
   両方が空で`same`でも、表の経路が実際のラベルや依頼を見つけることの確かめにはならない。
   手順5で、自然に付いた依頼とラベルの着手までの遅れを記録して補う。
   `different`なら、収集の周回の遅れ(5分以内)か、上の変化で説明できるかを確かめ、数分後に読み直す。
   説明できなければ、収集の不具合として調べる。
4. 続く3回の`poll_prs`の結果を、Consoleのジョブの画面で確かめる。
   `collect_disabled`が`false`、`failed`が0であることを見る。
   `candidates`は、手順2の`target`と`maybe`と`team`の合計と近いはずである。
   `dropped`は、0か、古い行で説明できる値になる。
   `team_unresolved`は、個人の所有者だけなら、普段は0になる。
   組織の所有者では、チームを使えない間に増える。
   ただし、収集は依頼先を読めない行と、依頼が20件を超える行の依頼先を`NULL`にする。
   この2つの行は、個人のリポジトリでも、直接の依頼でなければ`team_unresolved`に数えられる。
   `team_capped`が1以上なら、チーム宛ての確認の候補が20件を超えている。
   続きから選ぶので、次の周回以降に確かめられ、続けて出なければ収まる。
   `team_remembered`は、覚えていて確かめなかった件数である。
   `GET /user/teams`の失敗の段`viewer_teams`と、組織のチームを使えない段`viewer_teams:<owner>`が、失敗の記録に続かないことを見る。
   失敗の記録に、段`read_gh_owner_prs:<owner>`(`flow_path`が`f/factory/poll_prs`のもの)、`list_open_prs:<owner>/<repo>`、`confirm_pr:<owner>/<repo>#<番号>`が続かないことを見る。
   `confirm_pr:`が依頼先を読めない理由で出たときは、`getPr`の応答の形を調べる。
5. 表の経路で最初に作られた`pr_review`か`pr_fix`の作業項目で、`owner`と`repo`がGitHubの正規の綴りと大小文字まで一致することを確かめる。
   一致しなければ、収集の不具合として調べる。
   綴りは`gh api repos/<owner>/<repo> --jq .full_name`で読む。
   追跡中のPRとの重ねは、大文字小文字を区別した鍵で除く。
   綴りが違うと、同じPRが別の候補として並ぶ。
6. 1日の間、`poll_prs`の失敗の記録に403と429が無いことを確かめる。
   自然にレビューの依頼、assignee、ラベルが付いたら、付けた時刻から作業項目の作成までの遅れを記録する。

結果の`rest_lists`と`skipped_stale`が1以上なら、理由の語で原因を読む。
`rest_lists`は表の代わりに一覧で読んだ明示リポジトリの数で、理由は`rest_reasons`に出る。
`skipped_stale`は見送った明示でないリポジトリの数で、理由は`skipped_stale_reasons`に出る。
理由の語の意味と対処は、[Issueの発見の元を確かめる](#issueの発見の元を確かめる)の表と同じである。
ただし、表の読み取りの失敗の段は`read_gh_owner_prs:<owner>`である。

定期ジョブ用のworkerの待ちや一時的な収集の失敗で説明でき、確認の期間を延ばして0に戻るなら、そのままにする。
説明できなければ、収集の失敗として調べる。

一覧の読み取りが失敗すると、失敗の記録の段`list_open_prs:<owner>/<repo>`に残り、`failed`に数える。
開いたPRが1000件を超えるリポジトリでは、一覧が上限に当たって失敗し続ける。
一覧を読むのは、収集が止まっている間と、収集が集めない明示リポジトリである。
明示リポジトリの一覧が失敗し続けても、通知は出ない。
失敗は`job_failures`に残り、日次のまとめに載る。
`repo_allowlist`が空でないと、リポジトリ単位の古さの通知と収集の無効の通知が出ないためである。
結果の`failed`と、失敗の記録の段`list_open_prs:`を定期的に見る。

`confirm_pr:`が404で続くときは、読み取りトークンに見えるが、書き込みのPATに見えないリポジトリがある。
書き込みのPATがそのリポジトリを読めないので、候補を確かめられない。
読み取りトークンの範囲を書き込みのPATに合わせるか、`repo_allowlist`で絞って直す。

`confirm_pr:`の不一致が続くときは、明示リポジトリの移管か改名を疑い、`repo_allowlist`を直す。
旧名は新しい名前に転送され、別のリポジトリの番号が返って、不一致で落ちる。
安全側に倒れるが、通知は出ない。

`review_label`か`fix_label`を変えるときは、手順3をやり直す。
収集が各リポジトリを取り直すまで、表のラベルの真偽は古い名前で答えるためである。

## 組織の所有者を足す前の確認

`poll_prs`は、組織のリポジトリでチームに宛てたレビューの依頼を、`GET /user/teams`で解決する。
現在の構成は個人の所有者だけで、チーム宛ての依頼が起きないため、この解決は実機で確かめていない。
確かめずに組織の所有者を`owners`に足すと、チーム宛てだけの依頼のレビューが、通知なしに起動しなくなりうる。
足す前に、次の5つを確かめる。
確かめたら、結果と、必要だった権限を、足す変更のPRに書く。

1. `GET /user/teams`が、PATのアカウントのチームを返すことを確かめる。
   `gh`のログインのトークンではなく、Factoryが使うトークンそのもの(`GITHUB_TOKEN`。投入先は[セットアップ](../setup.md)にある)を、このシェルだけの`GH_TOKEN`に渡す。
   値はコマンドにも文書にも書かず、入力して渡す。

   ```bash
   read -rs GH_TOKEN && export GH_TOKEN
   gh api user/teams --jq '"teams: \(length)", (.[] | [.id, .organization.login, .slug] | @tsv)'
   unset GH_TOKEN
   ```

   組織のチームが入っていれば、よい。
   403は、PATにチームを読む権限が足りない。
   手順2に進む。
   `teams: 0`は、権限が足りるが、PATのアカウントがどのチームにも属さない。
   どちらも、足した後の周回で毎周回、失敗の記録が残る。
   出力で見分けて対処する。
2. 必要なPATの権限を確かめる。
   組織の権限のMembersの読み取りなどが要る可能性がある。
   権限は実機で確かめるまで決まらない。
   必要と分かったら、同じ変更で[PATの権限](../security.md#githubのpat)の表に足し、種類をセキュリティとして監査を通す。
   組織のPATの承認が要ることもある。
   権限を足さない間は、チームを使えず、チーム宛てだけの依頼を見送る。
3. 応答の形を確かめる。
   `poll_prs`が読むのは、チームごとの`id`(正の整数)、`slug`、`organization.login`である。
   1つでも欠けた要素があると、応答全体を失敗として扱う。
4. チームに宛てた依頼が付いたPRで、`requested_teams`の形を確かめる。

   ```bash
   gh api repos/<owner>/<repo>/pulls/<番号> --jq '.requested_teams | map({id, slug})'
   ```

   `id`が、手順1の`id`と同じ数値であることを見る。
5. 親チーム経由の依頼の扱いを確かめる。
   PATのアカウントが子チームだけに属するとき、親チームへの依頼が`requested_teams`に親チームとして載るかを確かめる。
   あわせて、手順1の出力に親チームが入るかも確かめる。
   どちらも、親チームに宛てた依頼が付いたPRで照らし合わせる。
   入らないなら、親チームに宛てた依頼は、レビューの起動に当たらない。

足した後の最初の周回で、`poll_prs`の結果の`failed`と、失敗の記録の段`viewer_teams`と`viewer_teams:<owner>`を見る。
続けて出るなら、手順1〜3をやり直す。
