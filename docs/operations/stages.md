# 設計工程と実装フローの運用

設計工程と実装フローを有効にして使う手順と、止まったときの対処である。
Factoryを運用する人が読む。
[運用](../operations.md)の手順のうち、設計工程と実装フローにかかわるものをこの文書に置く。

## 設計工程を有効にする

設計工程は、要件定義の承認の後、実装の前に、設計書の生成と人の承認を挟む。
既定は無効である。
有効にするには、`factory_config`の`design_enabled`を`true`にし、`design_enabled_since`に日時を書く。
`design_enabled`だけを`true`にしても有効にならず、設定は`false`として読まれる。
このとき要対応の通知`design_enabled_ignored`が残る。
`design_enabled_since`が日時として読めない値のときも同じである。
設定を読む処理は例外にしない。
例外にすると、自己更新まで止まるためである。
通知は[通知の種類](../operations.md#通知の種類)に、設定値の一覧は[設計書の生成](../internals/design.md)の「設定値」に書く。

`design_enabled_since`は、有効にする意思の表明と、有効にした時刻の記録である。
他の`*_since`(`pr_ci_fix_enabled_since`など)のように、この時刻より前の作業を除く境にはならない。
未来の日時を書いても、書いた時点で有効になる。
書式は、秒まで書いたタイムゾーン付きの日時である。
例は`2026-11-01T00:00:00Z`である。
日付だけ(`2026-11-01`)などの書き損じは、設定を読む処理を失敗させず、設計工程を開けない。

`design_enabled_since`を書くのは運用者である。
subagentと背景のセッションは書かない。
有効にする操作が、人の判断を経るようにするためである。
`console_config_update`の許可表に入るのは、`design_enabled`を`true`から`false`へ閉じる向きだけである。
Consoleの設定タブは、`design_enabled`が`true`のとき**止める**を出す。
この書き込みは`design_enabled`の1キーだけを書き、`design_enabled_since`は残す。
`design_enabled`を`true`にする向きと、`design_enabled_since`に値を書く操作は、許可表に入れないので、Consoleからは書けない。
開く操作は、Windmillの画面か、`wmill resource push`で書く。
全停止が止めた`design_enabled`は、運用者が端末で実行する`mise run stop:restore`も戻し、そのとき`design_enabled_since`を実行時刻に書き直す。
手順は[記録した設定を戻す](stop.md#記録した設定を戻す)にある。

設定タブは、一覧の値を書かれたまま出す。
「設計」グループの先頭の**設計工程(実際の状態)**の行が、実際に効いている値(有効、無効のどちらか)を出す。
書かれた値が無視されているときは、その理由も出る。
`design_enabled`か`design_enabled_since`を参照(`$var:`か`$res:`)で書いたときは、設定タブが参照の先を解決しないので、行は「判定できない」と出る。
`design_enabled`の参照が、文字列やオブジェクトなど真偽値でない値に解決されると、設定を読む処理は例外で止まる。
`design_enabled_since`の参照が、日時として読めない値に解決されても、例外にならない。
その場合は、設計工程が閉じたまま、`design_enabled_ignored`の通知が出る。
設計工程の2つの設定は、参照で書かず、値を直接書く。
有効にした直後の確認は、この行でしかできない。

### 有効にする前に確かめること

次の4つをすべて満たしてから、有効にする。

1. ホストが最新に追い付いている。
   ホストのメインのチェックアウトで、`git fetch origin`の後、`git log --oneline HEAD..origin/main`が空であることを確かめる。
   最後に`mise run up`を実行した時点は、`git reflog`で探す。
   `mise run up`が要る変更が残っていると、実機の1周が、本番に入る環境と違う環境の確認になるためである。
2. 変更が反映されている。
   Consoleのシステムの画面の更新履歴で、最新のデプロイが成功していることを確かめる。
   設定タブに**設計工程(実際の状態)**の行が出て、「無効」と読めればよい。
   リソース型(ルートの`c_factory_config.resource-type.yaml`)は、自己更新の`wmill sync push`が反映する見込みである。
   `wmill sync push --dry-run`が、このファイルを反映の対象に数えるためである。
   実際の反映は実機で確かめていない。
   `wmill resource-type get c_factory_config --json`の出力に`design_enabled_since`があることを確かめる。
   無いときは、有効にせず、反映を待つか原因を調べる。
   `mise run push`を手で実行しない。
   自己更新と手動の反映の経路が二重になり、どちらが反映したか追えなくなるためである。
3. 有効にする時点で止まっている作業項目が無い。
   次のコマンドで数える。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT status, count(*) FROM factory.work_items WHERE kind = 'issue' AND status IN ('approved', 'implementing', 'needs_human') GROUP BY status ORDER BY status"
   ```

   該当の作業項目は、有効にしても自動では再開されない。
   承認済み(`approved`)で止まった項目は、次の実装の準備の関門が、設計の承認が無いことを理由に止める(理由は`no approved design for design attempt 0`)。
   人が再実行すると、実装ではなく設計から始まる。
   `needs_human`のうち、自動で再開する理由(workerのイメージが古い、PRに動いている修正がある)を持つ項目も、同じ扱いになる。
   Consoleの要対応で理由を確かめる。
   `implementing`の項目は、終わってから有効にする。
   0にできない分の残るリスクは、[R-DES-40](../security-risks.md#r-des-40)である。
4. 本番の過去の要件定義書で、承認画面が止める条件に当たる割合を確かめる。
   設計書はまだ本番に無いので、要件定義書で近似する。
   次のコマンドは読み取りだけで、書き込まない。
   `flagged`が多いときは、承認画面が止めすぎる可能性がある。
   有効にする前に、止める条件を見直す。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "WITH p AS (SELECT '[' || chr(8203) || '-' || chr(8207) || chr(8232) || chr(8233) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8303) || chr(65024) || '-' || chr(65039) || chr(12644) || chr(65440) || chr(10240) || chr(4447) || chr(4448) || chr(13) || ']' AS re) SELECT count(*) AS total, count(*) FILTER (WHERE rd.markdown ~ p.re) AS flagged FROM factory.requirement_drafts rd, p"
   ```

   このパターンは、書式文字、行と段落の区切り、異体字セレクタ、ハングルのフィラー、点字の空白、`\r`に当たる。
   承認画面の判定と完全には同じでないので、近似として読む。

### 有効にする手順

1. `factory_config`に、`design_enabled: true`と`design_enabled_since`を同じ編集で書く。
   `design_enabled_since`には、書く時点の時刻を書く(例: `2026-11-01T00:00:00Z`)。
2. 書いた時点で効く。
   設定タブの**設計工程(実際の状態)**の行が「有効」になったことを、すぐ確かめる。
   「無効」のまま、書かれた値が無視されていると出たときは、`design_enabled_since`の書式を直す。
   理由の無い「無効」と出たときは、`design_enabled`が真偽値(引用符なしの`true`)かを確かめる。
   文字列や数値だと、設定を読む処理は例外で止まるが、設定タブは理由なしで「無効」と出すためである。
   自己更新(2分ごと)を待つのは通知の解決だけである。
   `design_enabled_ignored`が未解決なら、自己更新が次の回に解決する。
3. 検証用のIssueを1件投入し、1周を確かめる。
   - 要件定義を承認すると、作業項目が設計中(`designing`)になり、設計書が生成される。
   - 設計の承認依頼が、Consoleの要対応に出る。
   - 設計の承認画面が、原文の表示で、実装に渡る全文をそのまま出す。
     不可視文字は、コードポイントの表記で見える。
     「プレビュー」に切り替えると、承認が止まる。
     「原文」に戻すと、原文で確かめたかのチェックが出て、チェックを付けると承認できる。
   - 設計を承認すると、実装が始まり、PRができる。
   - 設計を却下すると、理由を添えて設計が作り直される。
4. 1周に問題が無ければ、通常の運用に入る。
   問題があれば、次の手順で無効に戻す。

### 無効にする手順

Consoleの設定タブの`design_enabled`の行にある**止める**でも、無効にできる。
Consoleは`design_enabled_since`を消さない。
もう一度有効にするときは、`design_enabled`を`true`にし、`design_enabled_since`に新しい時刻を書く。
**`design_enabled`だけを`true`に戻してはならない。**
残った時刻が読めるので、有効にする意思の表明が無いまま、設計工程がすぐ開く。
Consoleから止めても、全停止の記録には載らないので、`mise run stop:restore`は戻さない。

1. `design_enabled`を`false`にし、`design_enabled_since`も消す(`null`にする)。
   もう一度有効にするときは、`design_enabled_since`に新しい時刻を書く。
2. 書いた時点で効く。
   設定タブの**設計工程(実際の状態)**の行が「無効」になったことを、すぐ確かめる。
   自己更新(2分ごと)を待つのは通知の解決だけである。

無効にしても、進行中の設計は止まらない。
設計中(`designing`)と設計の承認待ち(`awaiting_design_approval`)の作業項目は動き続け、`design_apply`も動く。
無効の間は、次のとおり動く。

- 設計の承認は、設計書を実装に渡さず、実装へ進める。
  確認文もそう伝える。
- 設計の却下は、設計を作り直さず、人の対応待ちで止める。
- 無効の間に再開した実装も、設計書を受け取らない。
- 実装とPRの修正は、設計の不足を返せない。

進行中の項目の数は、次のコマンドで確かめる。
実行するのは、無効にする前である。
数が0になるまで待ってから無効にすると、設計書なしで実装へ進む項目が出ない。
待てないときは、設計書なしで進む項目が出ることを受け入れて閉じる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec db psql -U postgres -d datatable_db -c "SELECT status, count(*) FROM factory.work_items WHERE kind = 'issue' AND status IN ('designing', 'awaiting_design_approval') GROUP BY status ORDER BY status"
```

### 設計の上限と設定の書き損じ

`max_design_attempts`は、現在の要件定義の試行で、設計を作り直せる回数の上限である。
人の却下、実装からの戻し、PR修正からの戻しが、この上限を分け合う。
上限に達した却下は、作業項目を人の対応待ちにする。
設計の失敗や期限切れの再実行は、回数に数えない。

`design_enabled`が真偽値でないとき、または`max_design_attempts`が1以上10以下の整数でないときは、設定を読む処理が例外になる。
このとき自己更新と検知が止まるので、値を直す。
`design_enabled_since`の書き損じは、例外にならず、設計工程が開かないだけである。

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

## 設計の承認の反映で止まったとき

設計の承認と却下は、`design_apply`が作業項目に反映する。
反映が止まった作業項目は、Discordの人の対応待ちの通知か、Consoleの**要対応**に出る。
理由ごとの手順は次のとおりである。
どの手順も、作業項目の再実行は[失敗した作業を再実行する](../operations.md#失敗した作業を再実行する)の操作で行う。

| 理由 | 意味 | 手順 |
| --- | --- | --- |
| `design rejected after max_design_attempts N` | 現在の要件定義の試行で、反映できた却下がN回に達した | Consoleの承認の履歴で却下の理由を確かめる。再実行すると設計書を作り直し、直前の却下の理由を渡す。再実行ごとに設計を1回試す |
| `design approval record is inconsistent`、`approved design does not match the approved requirements`、`no approved design for design attempt N` | 承認の照合が通らなかった。承認の行が書き換えられたか、要件定義が替わった | Consoleで設計の承認の記録と要件定義の承認の状態を確かめてから、再実行する。設計が有効なら設計から再開する |
| `design requires approved requirements for attempt N` | 設計の承認待ちなのに、要件定義が現在の試行で承認済みでない | Consoleで要件定義の承認の状態を確かめる。承認が無ければ、`factory`ラベルを付け直して要件定義を作り直す |
| `design approval timed out` | 設計の承認依頼が7日の期限を過ぎた | 再実行する。最新の依頼が承認済みなら実装から始め、そうでなければ設計書を作り直す |
| `requirements regeneration could not be started` | 設計の却下でIssueが変わっていて、要件定義の作り直しを起動できなかった | 再実行する。要件定義を作り直し、承認し直しが要る。取り込み内容は現在のIssueで更新され、却下の理由は要件定義の生成に渡る |
| `design flow could not be started` | 設計の却下の後、設計の再生成を起動できなかった | 再実行する。設計書を作り直す |
| `design stage is closed, so the rejected design was not regenerated` | 設計の却下を反映するとき、設計工程が無効だった | 設計工程の設定を確かめ、有効な状態になってから再実行する。設計書を作り直し、直前の却下の理由を渡す |
| `approval decision could not be applied after 3 restarts of the handler` | 承認の判断を、処理先の起動し直しを3回しても作業項目に反映できなかった | Consoleで作業項目の状態と承認の記録を確かめてから、再実行する |

最後の理由は、設計と要件定義で共通である。
承認待ちの走査(`poll_issues`が5分ごとに行う)が、決定から5分たっても反映されない依頼の処理先を起動し直す。
起動し直しの間は15分あける。
3回起動し直した15分後にも作業項目が承認待ちのままなら、人の対応待ちにして通知する。
処理先の失敗は`job_failures`に残るので、Consoleの失敗の記録で原因を確かめる。

承認の断りで「Issueを比べられなかった」と案内されたときは、しばらく待ってからやり直す。
Issueが移されたか消されたなら、却下する。
設計の却下は、Issueを読めないと要件定義へ戻れず、設計の再生成が`max_design_attempts`に達するまで繰り返される。

## PR修正が設計の不足を返して止まったとき

設計工程が有効なとき、レビュー回のPR修正は、承認済みの設計書どおりに直すと要件を満たせない場合に、設計の不足を報告する。
Factoryは、親のIssueの作業項目を設計中へ戻し、設計フローを起動する。
このときPR修正の作業項目は、ブロック(`blocked`)で終わる。
設計の承認の後は、実装フローがPRを引き継ぐ。
設計の最中に、親を持つPRの修正を依頼しても、準備の確認が止める。
止まった理由は`parent issue is in the design stage`で、設計の承認と実装が終わってからやり直す。

Factoryが親を戻せなかったときは、PR修正が人の対応待ちになる。
通知の理由は、次のとおりである。
どの理由でも、修正のラウンドは記録済みである。

| 理由の先頭 | 意味 | 手順 |
| --- | --- | --- |
| `design gap from the PR fix after max_design_attempts` | 設計の却下と戻しが、上限に達した | Issueにトリガーのラベルを付け直して新しいサイクルを始めるか、PRを人が直す |
| `design gap from the PR fix while the design stage is closed` | 設計工程が無効だった | Issueにトリガーのラベルを付け直して新しいサイクルを始めるか、PRを人が直す |
| `design gap from the PR fix: parent work item not found` | 戻す先の親が見つからない | Consoleで作業項目の状態を確かめる |
| `parent work item N (issue #M) is in the design stage` | 親が設計の段階にある | 設計の承認と実装が終わってから、`factory:fix`を付け直す |
| `parent work item N (issue #M) is being implemented` | 親が実装中である | 実装フローの完了を待ってから、`factory:fix`を付け直す |
| `parent work item N (issue #M) was replaced by a newer cycle` | 親が新しいサイクルに置き換わっている | このPRは古いサイクルのものである。Consoleで現在のサイクルを確かめ、必要ならPRを人が直す |
| `parent work item N (issue #M) moved after the fix started` | PR修正の開始後に、親の状態が動いた | Consoleで親の状態を確かめ、設計と実装が終わってから、`factory:fix`を付け直す |
| `parent work item N (issue #M) changed before the design_gap reroute` | 戻す直前に、親の状態が変わった | Consoleで親の状態を確かめ、設計と実装が終わってから、`factory:fix`を付け直す |

上限と設計工程の無効のときは、親がPR作成済み(`pr_open`)のまま残る。
親は再実行の対象でないので、再実行しても設計を作り直せない。
手順の1つ目は、新しいサイクルが要件定義から作り直すので、承認し直しが要る。
親が別の経路ですでに設計の段階にあるときも、数が上限に達していれば、この理由になる。
その場合は、親が進行中なので、設計の承認と実装を待つ。

設計の起動に失敗したときは、親が人の対応待ちになる。
親を再実行すると、PR修正の報告が設計に渡り、設計書を作り直す。
理由は`design flow could not be started`で始まる。
再実行の前に、設計工程が有効かを確かめる。
無効のまま再実行すると、報告が設計に届かず、実装へ進む。
処理済みの位置は進んでいるので、元の指摘は消える。

## 実装フローを有効にして使う

要件定義の承認の後に実装まで進めるには、`factory_config`の`implement_enabled`を`true`にする。
既定は`false`で、その間は作業項目が承認済み(`approved`)で止まる。

実装フロー(`f/factory/implement`)は、実装ブランチ`factory/issue-<N>-wi-<work_item_id>`を作ってpushする。
検査に通ったらコミットしてPRを作成する。
既にPRがあれば、その本文を更新する。

PRには`factory:review`ラベルが付くので、自動レビューが起動する。
PR本文の`Closes #N`で元のIssueに紐づく。
マージは常に人が行う。

実装フローの設定値と既定値、時間の上限は[実装フローの仕様](../internals/implement.md)にある。
時間の設定を変えるときは、そこに書かれたステップのtimeoutの範囲で組み合わせる。
実装フローの実行中は時間の設定を変えない。
設定を確かめるのは準備のステップだけだからである。

### 検査コマンドを設定する

実装の検査コマンドは、リポジトリごとに`check_commands_by_repo`で設定する。

```json
{
  "<owner>/<repo>": ["bun install --frozen-lockfile", "bun test"]
}
```

- エントリが無いリポジトリでは、検査コマンドを実行しない。
  PRの修正で使う`allowed_check_commands`は、実装では使わない。
- 検査の前に毎回`git clean -fdX`で無視ファイル(`node_modules/`など)を消す。
  そのため先頭で依存関係をインストールする。
- workerのイメージにmiseは無い。
  worker内で直接動くコマンドにする。
  例は次のとおり。
  - `bun install --frozen-lockfile`
  - `bun test`
  - `bunx --no-install --bun tsc --noEmit`
  - `bunx --no-install --bun biome check .`
  workerのイメージは、`bunx`をbunへのsymlinkとして`/usr/bin`に置く。
  `bunx`などの実行ファイルが無いと検査コマンドを実行できず、修正のラウンドを回さずに人の対応待ちで止まる。
- `bunx`は、先頭の`bun install --frozen-lockfile`でlockfileから入れた実行ファイルにだけ使う。
  入っていないと、`bunx`は版を固定しないままレジストリから取得し、検査用のuidで実行するためである。
  `--no-install`を付けると、入っていないときは取得せずに止まる。
  この指定は、実機のbunの`bunx --help`にある。
- 検査コマンドは、シェルを通さず、空白で区切った引数として実行する。
  クォートは文字としてそのまま渡り、`*`は展開されない。
  たとえば`bun test --path-ignore-patterns 'console/**'`の`'`は外し、`console/**`と書く。
- 依存を別に入れるサブディレクトリがあるリポジトリでは、先頭の`bun install --frozen-lockfile`の直後に、そのサブディレクトリの導入を足す。
  たとえば`console/`を持つこのリポジトリでは、`bun install --cwd console --frozen-lockfile --ignore-scripts`を足す。
  足さないと、`tsc`がそのサブディレクトリの型を解決できず、必ず失敗する。
- 検査は、未コミットの作業ツリーに対して実行する。
  gitの`HEAD`のコミットからハッシュを計算し直すテストは通らない。
  このリポジトリでは、`wmill-lock.yaml`のハッシュを確かめる`tests/lib/metadata_*`を除く。
  `bun test`に`--path-ignore-patterns tests/lib/metadata_*`を付ける。
  CIは除かずに実行するので、メタデータのずれはCIの`metadata`ジョブが検知する。
  `wmill-lock.yaml`の再生成(`mise run metadata`)と`lint:docs`は、検査コマンドに含められない。
  実装のPRが、この2つでCIに落ちたら、人かローカルのセッションが同じブランチに直しを足す。
- 検査コマンドの数を増やすときは、時間の合計を確かめる。
  `implement_flow_timeout_sec` + 600 + コマンド数 × (`implement_check_timeout_sec` + 15)が、ステップのtimeoutの21600秒以内でなければ、準備のステップが止める。
  8件の検査コマンドを置くときは、`implement_check_timeout_sec`を800にする。
- 検査コマンドの設定を足す、または変えたら、軽い作業項目で実際に流して、検査が通ることを確かめる。
  検査コマンドが一度も実機で動いていない設定は、初回の実装を止める。
- 1つのリポジトリの検査コマンドは4件までを目安にする。
  検査コマンドが多いほど、修正のラウンドを始められる時間が短くなるためである。
- 検査コマンドが書き込めるのは、worktree、その`HOME`、共有の一時ディレクトリ(`/tmp`、`/var/tmp`、`/dev/shm`、`/dev/mqueue`、`/run/lock`)だけである。
  main cloneの`.git`に書けないので、`git add`、`git commit`、`git stash`、lint-stagedのように`.git`へ書き込む検査コマンドは失敗する。
  検査コマンドには使わない。
- 検査コマンドの`TMPDIR`は`HOME`の下を指す。
  共有の一時ディレクトリに置いたものは、並行して動く別の検査から読めることがある。
- 取り消しやworkerの再起動で後始末が走らなかった検査の残りは、次にその枠を取る検査か、次にそのworktreeを使うステップが片付ける。
  片付けられない枠は手放して次の枠を試し、`check_slot_skipped`を残す。
  すべての枠で片付けに失敗したときだけ、検査が失敗する([検査の枠の記録を片付ける](../operations.md#検査の枠の記録を片付ける))。
- 検査コマンドの枠のユーザーが同時に持てるプロセスは、スレッドを含めて256までである。
  超えるとforkが失敗し、その検査コマンドは失敗する。
  子を作り続ける検査コマンドが、workerのほかのジョブを止めないためである。
  値の根拠は[プロセス数の上限の決め方](../internals/check-sandbox.md#プロセス数の上限の決め方)にある。
- 所有権の受け渡しは、ハードリンクのあるファイルがworktreeに無ければ一括で行い、あればディレクトリごとに行う。
  取り戻しは常に一括で行う。
  ディレクトリごとの受け渡しは、1個あたり約0.6ミリ秒かかる。
  50万個を超えると300秒の上限で打ち切られて検査が失敗する。
  50万個は余裕を含まない切れる点で、負荷のあるworkerでは手前で切れうる。
  目安は、9,000個のディレクトリで約5秒、9万個で約1分である。
  取り戻しは、条件に当たるエントリが少なく、ACLも無いときだけ、ディレクトリが9万個でも合わせて約8秒で済む。
  当たるエントリを含むディレクトリが多いと、ディレクトリごとの起動で1個あたり約0.5ミリ秒かかる。
  ACLの確認は1回の最悪で約600秒かかる。
  一括の確認が300秒で打ち切られた後に、ディレクトリごとの確認にも300秒が与えられるためである。
  測り方と各段の時間は[検査枠の走査時間を測る](#検査枠の走査時間を測る)にある。
- 検査がworktreeの外を指すsymlinkを置くと、取り戻しの後に消される。
  `python3 -m venv`の`.venv/bin/python3`のような正当な置き物も消えるが、検査は失敗しない。
  「check sandbox: symlink scan」という失敗した検査が足されるのは、検出が不完全だったときと、追跡されているsymlinkが書き換えられたときだけである。
  足されたら、出力に書かれたパスのコマンドを直す。
- 枠がすべて使われていると、検査は空くのを最大5分待つ。
  同時に動く検査は1つなので、通常は枠が埋まらない。
  待っても取れなければ「no check slot became free」で失敗し、作業項目は失敗になる。
  `retry_work_item`で再実行する。
- 検査コマンドに常駐のデーモンを残させない。
  ロックのファイル記述子を持ったまま残ると、以降のラウンドがロックを取れずに失敗する。
  記述子を閉じて残ったものも、次の準備やPRの修正を止める。

> [!WARNING]
> 検査コマンドは、Claudeが書いたコードをworker内で非特権のユーザーとして、コンテナの分離なしに実行する。
> networkとworkerの資源を共有するので、Issueを信頼できる人だけが起票するリポジトリにだけ`check_commands_by_repo`を設定する。

実装ブランチのpushとPRの作成で、人のレビューの前に対象リポジトリ自身のCIも動く。
atelier-worksのCIはPRの作成から動く。
そのCIが使えるsecretsの範囲を確かめておく。

検査コマンドを実行すると、Consoleの**システム**の「情報の通知」にコンテナの分離が無い検査コマンドの実行(`unsandboxed_check_commands`)が記録される。
本文は件数と対象と作業項目で決まるので、記録は作業項目ごとになる。
同じ本文の未解決の通知があれば、新しく作らず、作成から1日を過ぎていれば時刻を更新する。
秘密情報の検査(gitleaks)は、設定に関わらず毎ラウンド実行する。

### 検査枠の走査時間を測る

所有権の受け渡しと取り戻しの上限(300秒)は、コマンド1回ごとにかかる。
規模の目安を見直すときは、使い捨てのコンテナを使い、実機のボリュームには触れない。
`node_modules`に近い木をrootの所有で作り、受け渡しから順に、段ごとに`time`で測る。
環境変数`P`がディレクトリの数を、`L`がsymlinkの数を決める。

```sh
docker run --rm --pull never --network none -e P=300 -e L=2000 --entrypoint /bin/bash infra-windmill_worker:latest -c '
python3 - <<PY
import os
n = int(os.environ["P"])
for p in range(n):
    for s in range(30):
        d = f"/data/node_modules/p{p}/d{s}"
        os.makedirs(d)
        for f in range(6):
            open(f"{d}/f{f}.js", "w").write("x")
    os.symlink(f"../p{(p + 1) % n}", f"/data/node_modules/p{p}/link")
os.makedirs("/data/links")
for i in range(int(os.environ["L"])):
    os.symlink(f"../node_modules/p{i % n}", f"/data/links/l{i}")
PY
time find -P /data -xdev "(" -type d -o -links 1 ")" -printf . > /dev/null
time find -P /data -xdev "(" -type d -o -links 1 ")" -execdir /usr/bin/chown -h --from=0:0 10001:10001 "{}" +
time chown -R -P -h --from=10001 0:0 -- /data
time find -P /data ! -type l -execdir /usr/bin/getfacl -s -p -- "{}" +
time getfacl -R -P -s -p -- /data
time find -P /data -xdev ! -type l -execdir /usr/bin/setfacl -b -k "{}" +
time find -P /data/links -type l -fprint0 /tmp/links -printf . > /dev/null
time python3 -c "import os; [os.readlink(l) for l in open(\"/tmp/links\", \"rb\").read().split(b\"\0\")[:-1]]"
'
```

`P`が300のとき、木は9,301個のディレクトリと5万4千個のファイルを持つ。
`P`が3000のときは、9万3千個のディレクトリと54万個のファイルになる。
ハードリンクがある場合は、`os.link`で1つ足してから測る。

測った結果は次のとおりである(`mise run up`で作るworkerのイメージ、Linuxのコンテナ、ファイルシステムはoverlay)。
左の列は`P=300 L=2000`、右の列は`P=3000 L=20000`で測った。

| 段 | 約9,300個 | 約9万3千個 |
| --- | --- | --- |
| `find`の1回の走査(列挙と条件だけ) | 約0.07秒 | 約0.8秒 |
| ディレクトリごとの`chown`(受け渡し、ハードリンクあり) | 約5.3秒 | 約56秒 |
| 一括の`chown -R` | 約0.11秒 | 約2.1秒 |
| ディレクトリごとの`getfacl`(取り戻しの確かめ) | 約4.7秒 | 約49秒 |
| 一括の`getfacl -R` | 約0.11秒 | 約1.8秒 |
| ディレクトリごとの`setfacl -b -k`(ACLの削除、ACLの無い木で) | 約4.6秒 | 約48秒 |
| symlinkの列挙と中身の読み込み(2千個と2万個) | 約0.01秒 | 約0.1秒 |

- ディレクトリごとに起動する段は、どれも1個あたり0.5〜0.6ミリ秒で、ディレクトリの数にほぼ比例する。
  起動が支配的で、ファイルの数にはほとんど依存しない。
- 取り戻しは、`find`を5回、`chown -R`と`getfacl -R`を1回ずつ行う。
  合わせると、9,300個で約0.6秒、9万3千個で約8秒である。
  この時間で済むのは、条件に当たるエントリが少なく、ACLも無いときだけである。
  当たるエントリを含むディレクトリが多いと、その数だけ`chown`の起動が増え、1個あたり約0.5ミリ秒かかる。
- ACLの確かめは、先に一括の`getfacl -R`で行う。
  失敗、タイムアウト、出力があるときは、ディレクトリごとの`getfacl`に戻る。
  ACLが残っていれば、さらにディレクトリごとの`setfacl`で消すので、9,300個で約9秒、9万3千個で約100秒かかる。
  消した後の確かめは一括で済む。
- ACLの確かめ1回の最悪は、一括が300秒で打ち切られた後に、ディレクトリごとの確かめにも300秒が与えられるので、最大約600秒である。
- 受け渡しがディレクトリごとになるのは、ハードリンクが1つでもあるときである。
  上限は同じ300秒で、1個あたり約0.6ミリ秒なので約50万個で切れる。
  この数は余裕を含まない、切れる点である。
  負荷のあるworkerでは、手前で切れうる。
- symlinkの走査は、`find`の列挙の後に、1個ずつ中身を読んで指す先を解く。
  表の行はこのうちOSの側の時間だけで、走査のスクリプト全体の時間は測っていない。
  1個あたり約0.1ミリ秒で、走査の上限(60秒)に達するのは約60万個というのは、推定である。
  達すると検出が不完全として扱われ、検査が失敗する。

### 取り戻しのACLの一括確認が頼る挙動を確かめる

取り戻しのACLの確かめは、先に`getfacl -R -P -s -p`の1回で行う。
終了コードが0で、標準出力と標準エラーが空のときだけ、ACLが無いとみなす。
この前提は、workerのイメージの`getfacl`(2.3.2)で、使い捨てのコンテナを使って次のように確かめた。

```sh
docker run --rm --pull never --network none --entrypoint /bin/bash infra-windmill_worker:latest -c '
mkdir -p /data/a/sub
echo x > /data/a/sub/file.txt
setfacl -m u:10001:r /data/a/sub/file.txt
setfacl -d -m u:10001:rwx /data/a/sub
getfacl -R -P -s -p -- /data/a; echo "exit=$?"

mkdir /data/b && cd /data/b
for i in $(seq 25); do mkdir "$(printf "d%.0s" $(seq 200))" && cd "$(printf "d%.0s" $(seq 200))"; done
echo x > leaf.txt
setfacl -m u:10001:r leaf.txt
setfacl -d -m u:10001:rwx .
cd /
getfacl -R -P -s -p -- /data/b > /tmp/b.out 2> /tmp/b.err; echo "exit=$? stdout_bytes=$(wc -c < /tmp/b.out)"; cut -c1-60 /tmp/b.err

mkdir -p /data/c/locked
echo x > /data/c/locked/f
setfacl -m u:10001:r /data/c/locked/f
chmod 000 /data/c/locked
setpriv --reuid=20000 --regid=20000 --clear-groups getfacl -R -P -s -p -- /data/c; echo "exit=$?"
getfacl -R -P -s -p -- /data/c | wc -l
'
```

- ファイルのユーザーのACLと、ディレクトリのデフォルトのACLを付けた木では、終了コードは0で、両方を出力する。
  どちらも拡張のACLの名前付きのエントリなので、`-s`で飛ばされない。
- パスの長さがPATH_MAXを超える木(深さ25、1階層200文字で約5千文字)では、ACLを付けていても、終了コードは1で、標準出力は空である。
  標準エラーにパスの付いた`getfacl:`のエラーが出る。
  終了コードが0で何も出さない場合は無かったので、この木は一括では「無い」とみなされず、ディレクトリごとの確かめに戻る。
- 読めないディレクトリがあると、別のuidで実行したとき、終了コードは1で、標準エラーに`Permission denied`が出る。
  rootは読めるので、終了コードは0で、その下のエントリまで出力する。
  取り戻しはrootで実行するので、読めないディレクトリで一括が止まることは、通常は無い。
  それでも、終了コードが0で標準エラーに出力があるときは、ディレクトリごとの確かめに戻す。
- 引数がsymlinkのとき、`-R`は`-P`なしでもたどらず、何も出さずに終了コード0で終わる。
  `-L`を付けるとたどる。
  `-P`は、`find -P`と同じ挙動を明示するために付ける。

### PRができたら

Discordに実装のPRの通知(`pr_opened`)が届く。
通知とPR本文で次を確かめる。

- 保護パスの変更は、実装を止めずにPR本文の「確認して欲しい点」と通知に並ぶ。
  保護パスは`.claude/**`、`.github/**`、`infra/**`、`mise.toml`、`package.json`、lockfileなどである。
- 保護パスを変えたラウンドでは、検査コマンドを実行しない。
  PR本文の「動作確認結果」に「検査未実施」と理由が出るので、GitHub側のCIの結果を確かめる。

保護パスの一覧と理由は[PRワークフローの安全策の内部仕様](../internals/pr-workflow/security.md#保護パスの変更を止める)にある。

### 人の対応待ちになったら

Discordの通知の「次の操作」に従う。
主な場合は次のとおり。

| 起きたこと | 途中の変更 | 人がすること |
| --- | --- | --- |
| 実装が変更を生まなかった | 無い | 要件定義を見直すか、Issueを閉じる |
| ラウンド・予算の上限、期限、停滞、差分の超過で止まった(PRが無い) | 秘密情報の検査に通れば、実装ブランチにpush済み | ブランチを確かめて人がPRを作る、要件を直す、不要ならブランチを消す |
| 同じ理由で止まった(PRが既にある) | pushせずworktreeに残す | 同上 |
| symlinkの変更、Claudeの実行の失敗、worktreeの`.git`の書き換えで止まった | pushせずworktreeに残す | 同上 |
| PRに終端でない修正かレビューがある(理由が「このPRで自動修正が実行中のため実装を止めました」で、`pull request has an active fix run`が載る) | worktreeに触れずに止まる | 何もしない。その回が終わった後に、自己更新が自動で再開する。3回再開しても止まるときと、止まってから24時間を過ぎたときは、回が終わっているかをConsoleで確かめてから再実行する |
| 前のステップのClaudeや検査コマンドが、worktreeに残っている。理由に残っているプロセスが載る | pushしない | 載ったプロセスを止めてから再実行する |
| 検査コマンドがローカルでcommitかブランチの切り替えをした(「worktreeのHEAD(…)が記録したブランチの先頭(…)と異なります」など) | pushしない | 検査コマンドを確かめて人が直してから再実行する |
| commitしたツリーが、検査したツリーと違う | pushしない | 検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめてから再実行する |
| 途中経過では秘密情報の検査の後に、最終のcommitでは検証の後に、worktreeが変わった(「秘密情報の検査の後にworktreeが変更されました」、「検証の後にworktreeが変更されました」) | pushしない | 同上 |
| 検証のラウンドで、変更の判定と秘密情報の検査の間にworktreeが変わった | そのラウンドで止め、pushしない | 同上 |
| 検査コマンドの実行ファイルを起動できなかった(理由が「検査コマンドを実行できませんでした」で、`setpriv: failed to execute`が載る) | pushしない | 載った実行ファイルをworkerのイメージに足すか、検査コマンドを直す。イメージを変えたときは[f/とworkerのイメージを両方変えたとき](deploy.md#fとworkerのイメージを両方変えたとき)に従う。自動の再開はイメージが古い理由だけなので、この理由では自動で再開しない。直した後に再実行する |

完了時に新しい変更が無くても、ブランチに分岐点より先のコミット(途中経過のコミットなど)があれば、FactoryはそれでPRを作るか更新する。
ブランチに分岐点より先のものが何も無いときだけ、変更を生まなかったとして止まる。

atelier-worksのCIはPRの作成から動くので、PRを作らずに止まったブランチはCIの結果が無い。
PRを作るか、手元で`mise run check`を実行して確かめる。

原因を取り除いたら、Consoleの**要対応**で人の対応待ちの作業項目を選び、**再実行**を押して、実装フローを再実行する。
途中経過のコミットは、再実行で完了したときのコミットとは別のコミットとして残る。

実装が要件の不足(`requirements_gap`)を報告したときは、Factoryが自動で要件定義を作り直す。
再承認すると、同じブランチ名で実装をやり直す。
既にPRがあれば、そのPRを更新する。

### 実装フローを再実行するとき

`retry_work_item`で再実行すると、準備のステップが、同じ作業項目の前の実装フローが起動して残っているプロセスを止めてから続ける。
そのため、実行中に同じ実行の検査コマンドなどが残したプロセスがロックを持ち続けて失敗したときは、再実行するだけでよい。

PRの修正のプロセスや、持ち主の分からないプロセスがworktreeを使っていると、作業項目は人の対応待ちになる。
理由に、残っているプロセスが載る。
この場合は、載ったプロセスが終わるのを待つか、何のプロセスかを確かめてworkerのコンテナで止めてから再実行する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker kill <pid>
```

残ったプロセスが掃除の対象のworktreeを使っていると、作業領域の掃除はそのworktreeを消さずに飛ばす。
このときConsoleの**要対応**に`cleanup_worktree_busy`が残る。
載ったプロセスを止めれば、次の掃除で消える。

Consoleのジョブの中止や、Windmillで取り消した実行のClaudeや検査コマンドは、止まらずに残る。
Consoleで実行中のIssueの作業項目を中止したときは、Claudeと検査コマンドが自分で止まる([作業項目を中止する](../operations.md#作業項目を中止する))。
残ったプロセスの扱いと、実行中に作業項目を取られたときの挙動は[実装フローの仕様](../internals/implement.md)を参照する。

### 実装フローの実行中に避けること

- mainへのマージとデプロイを避ける。
  自己更新は実行中の実装フローを待たずに新しいステップを反映するので、1回の実行の中で別の版のステップが動きうる。
  実装中(`implementing`)の作業項目があれば、実行中である。
- defaultのworkerは同時に1つのジョブしか動かさないので、実装フローは1回の実行で、数時間worker全体を使う。
  その間、ほかのジョブは待つ。
- `mise run up`と`mise run deploy`は、実行中の仕事があると止まる([workerを作り直す前の確認](#workerを作り直す前の確認))。
- インスタンスの`job_default_timeout`を設定するなら、21600秒以上にする。
  実装と検証のステップ、PRの修正の検証のステップより先に打ち切らないためである。

### workerを作り直す前の確認

`mise run up`と`mise run deploy`は、defaultのworkerのコンテナを作り直す前に、実行中の仕事が無いことを確かめる。
workerを作り直すと、実行中のジョブは10秒の猶予で止められ、別のworkerが同じジョブを最初から再実行するためである。
実装は最長6時間かかるので、途中で止まると、その時間が無駄になる。

確認は読み取りだけで、次のどちらかがあると終了コード1で止まり、一覧を出す。

- defaultのworkerの枠で実行中のジョブ。
  フローの親ジョブと、Console用、定期ジョブ用、nativeのworkerが受けるtagのジョブは数えない。
  受けるworkerが分からないtagのジョブは数える。
  数え漏らして実行中のジョブを止めるより、余分に止めるほうが安全なためである。
- 実行中の状態の作業項目。
  要件定義の生成中(`requirements_generating`)、設計中(`designing`)、実装中(`implementing`)である。
  レビュー中(`reviewing`)、修正中(`fixing`)、監査中(`auditing`)、調査中(`investigating`)も含む。
  ジョブの一覧に載らない合間も拾うために、両方を見る。

実行中の状態の作業項目のうち、動いているジョブが付いていないものは、ジョブが死んで状態だけが残ったものとして、警告にとどめて通す。
残りと判定するのは、最後の更新から10分以上たっていて、次のどちらかのときだけである。

- `flow_job_id`が記録されていない。
- `flow_job_id`がジョブIDの形で、Windmillのqueue(`v2_job_queue`)を問題なく読め、同じIDの行が無い。
  runningかどうかは問わず、待機中のフローの親ジョブも生きているものとする。

次のときは、動いているものとして止める。

- 最後の更新から10分たっていない。
  状態を移してからジョブIDを記録するまでの合間と、フローの引き継ぎの合間を、残りと取り違えないためである。
- `flow_job_id`が、ジョブIDの形でない。
- `flow_job_id`があり、queueを読めない、または読めない行がある。
  `flow_job_id`が無い作業項目はqueueを引かないので、この影響を受けない。

残りは、`poll_issues.ts`の照合が猶予の後に失敗へ移す。
残りの警告は標準エラーに出る。
残るリスクは、フローの親ジョブがqueueに残るという前提を、動いているフローで確かめていないことである。
読み取りの時点で動いているフローが無かったため、未確認である。
外れると、更新から10分以上たった作業項目は、ステップの合間やworkerの枠待ちのあいだ、残りとして通る。
ジョブの問い合わせは、動いている(`running`)ステップしか拾わないためである。

動いている仕事が見つかっても、すぐには止めない。
5秒ごとに読み直し、60秒のうちに一度でも何も動いていなければ通す。
2分ごとの定期ジョブは短く終わるので、何も動いていない瞬間を拾える見込みである。
実機の記録での確認は未了である。
60秒は最初の読み取りの開始から数え、最後の待ちと読み取りもこの上限を超えない。
60秒のあいだ動き続けたときだけ止め、一覧は最後に動いていた読み取りのものを出す。
待っている間は、標準エラーに待っている秒数が出る。
読み直しで読めなかったときは、何も動いていないと確かめられないので、通さずに読み直しを続ける。

読み取りに失敗したときは、理由で扱いを分ける。

- サーバが居ないと分かるときは、警告を出して続ける。
  スタックが止まっている間と初回の起動では、止める相手のworkerが居ないためである。
  次のどれかが該当する。
  - dbのコンテナが動いていない。
    Dockerが止まっている。
    dockerの実行ファイルが無い。
  - psqlが接続できず、メッセージがサーバの不在を示す。
    接続の拒否、ソケットやホストが見つからない、まだ無いデータベースを指した、などである。
- それ以外の失敗は、止める。
  何も動いていないと確かめられないためである。
  次のものが該当する。
  - SQLの失敗。
    時間内に終わらなかった。
  - dockerの実行ファイルはあるのに、プロセス数やメモリの不足などで起動できなかった。
  - psqlが接続できなかったが、メッセージが接続数の上限、起動中、停止中、復旧中、認証の失敗を示す。
    サーバは居るのに読めない状態だからである。
  - 片方のDBだけがこの状態でも止まる。
    止めるときのメッセージに、`CHECK_IDLE_FORCE=1`で抜けられると出る。

確認が走るのは、`docker compose up --dry-run`が、defaultのworkerかDBの作り直しを示したときだけである。
Caddyだけが変わる起動は止めない。
defaultのworkerかDBのコンテナの状態が、動いていること(`Running`)以外なら、作り直しか起動のどちらかなので確認する。
次のどれかのときは、作り直されるものとして確認する。

- dry-runの出力を読めない。
- `Container`で始まる行に、形の合わないものがある。
- dry-runが失敗した。

`mise run up`と`mise run deploy`は、イメージの取得とビルドを確認の前に済ませる。
確認の後は、取得とビルドを省いて作り直す。
確認と作り直しの隙間を数秒にして、その間に新しい仕事が始まるのを減らすためである。

dry-runの出力は、実機で測った。
接頭辞は無く、行頭と行末に空白があり、`Container <名前> <状態>`の3列で、終了コードは0である。
最後に`end of 'compose up' output, interactive run is not supported in dry-run mode`の行が付く。
Caddyだけが変わるときは、Caddyの行が`Recreate`と`Recreated`になり、ほかは`Running`のままだった。

作り直しを示さない変更を見逃す残るリスクは、[R-HOST-56](../security-risks.md#r-host-56)である。
イメージを取得した直後に`mise exec -- bun ./scripts/check-idle.ts`を手で実行すると、dry-runに頼らず確認できる。

止められたときは、一覧の仕事が終わるのを待ち、同じコマンドをやり直す。
`mise run deploy`が止まったとき、`git pull`は進んでいる。
checkoutは新しい版で、コンテナは古い版のままである。
同じコマンドでやり直すと、pullは何もせず、続きから進む。
止まるときのメッセージにも、この旨が1行出る。
ジョブの様子は、Windmillの画面か`wmill job list`で見る。
作業項目はConsoleで見る。
一覧が定期のジョブだけのときは、ジョブが終わらず詰まっていないかを、Windmillの画面で確かめる。
Consoleのジョブの画面の実行中と待ちは、補助に使える。
ただし、`f/factory/`のscriptとフローだけを、キューの1ページ(100件)まで読み、待ちも含む。
一方`check-idle`は、defaultのworkerの枠で実行中のジョブだけを数える。
待ちは数えない。
フローの親ジョブと、他のworkerが受けるtagのジョブも数えない。
そのため、件数は食い違うことがある。
止めるかどうかの確認には、Consoleの画面を使わない。

確認だけを手で実行するには、次を使う。

```bash
mise exec -- bun ./scripts/check-idle.ts
```

`mise run up`の取得は、失敗を無視して進む。
レジストリの障害で、緊急の復旧が止まらないようにするためである。
`mise run deploy`の取得は、失敗したら止まる。
`mise run up`は、取得とビルドと60秒の再確認で時間がかかる。
Claudeが実行するときは、Bashの10分の上限に収めるため、`run_in_background`を付けて実行する。

`CHECK_IDLE_FORCE=1`を付けると、確認を飛ばす。
付けるのは人だけで、次のどちらかを確かめたときである。

- 一覧のジョブが無いことを、`wmill job list`か、`check-idle`が出すジョブのidをWindmillの画面で開いて、自分で確かめた。
  作業項目が実装中などのまま残っていても、対応するジョブが無ければ、動いていない。
  残った作業項目は、更新から10分たてば警告にとどまり、止めない。
  10分以内に止まるときは、この残った作業項目の場合がある。
  - Windmillの画面を開けないときは、一覧の開始時刻(`started`)と、workerの状態を照らし合わせる。
    workerの状態は、`mise exec -- docker compose -f infra/docker-compose.yml ps windmill_worker`で見る。
    workerが起動し直した時刻より前に始まったジョブは、動いていない可能性が高い。
- 止められてもよい緊急の作業で、実行中の仕事が止まることを受け入れる。

```bash
CHECK_IDLE_FORCE=1 mise run up
```

Claudeは自己判断で付けない。
Claudeのbash-guardが`CHECK_IDLE_FORCE`の代入を拒否する。
誤って付けるのを防ぐもので、すべての回避を塞ぐものではない。
予備として、`.claude/settings.json`の`permissions.deny`も置く。
