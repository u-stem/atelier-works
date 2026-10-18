# スケジュールの凍結の内部仕様

確認作業のためにWindmillの画面でスケジュールを止めている間、無関係な反映がスケジュールを有効に戻さないようにする仕組みの仕様である。
この仕組みは、指定したスケジュールを`wmill sync push`から外す。
次のファイルの凍結に関わる部分を変更する人と、凍結を使う人が読む。

- `f/factory/lib/freezes.ts`
- `f/factory/lib/freeze_apply.ts`
- `scripts/freeze.ts`
- `f/factory/self_update.ts`

残るリスクは[セキュリティ](../security.md)の「スケジュールの凍結」に書く。

## 方針

`self_update`と`mise run push`は、リポジトリの定義でスケジュールを上書きする。
画面で止めても、次の反映で有効に戻る。
凍結は、この上書きからスケジュール1つを期限つきで外す。

凍結の状態は、sync対象から外したWindmillの変数に置く。
sync対象に含めると、無関係なpushが凍結を消すためである。
判断できないときは反映しない(fail-closed)。

## データ

状態は、秘密でない変数`f/factory/freezes`にJSONで置く。
`wmill.yaml`の`excludes`に`f/factory/freezes.variable.yaml`を足してあるので、syncの対象にならない。
行は最大50件で、項目は次のとおりである。

| 項目 | 内容 |
| --- | --- |
| `id` | 行の識別子。解除に使う |
| `target` | 凍結するスケジュールのパス(`f/<folder>/<name>`) |
| `reason` | 凍結の理由 |
| `holder_kind` | 置いた主体の種類。`session`(Claudeの作業)か`human`(人) |
| `holder` | 置いた主体。`session`では`session:<ブランチ名>` |
| `created_at` | 置いた時刻 |
| `expires_at` | 期限。置いた時刻から24時間以内 |
| `released_at` | 解除した時刻。解除していなければ空 |

`f/factory/self_update`は凍結できない。
凍結すると、凍結を戻す追従も止まるためである。
同じ`target`に有効な凍結を2つ置けない。

期限切れは、書き込みに頼らず、時刻で無効と数える。
解除済みの行と期限切れの行を、終わった行と呼ぶ。

## 除外の作り方

`wmill sync push --excludes`は、`wmill.yaml`の`excludes`を置き換える。
そのため、`wmill.yaml`の`excludes`と、有効な凍結の`<target>.schedule.yaml`の和を、`--excludes=<値>`の1要素で渡す。

`wmill.yaml`の`excludes`に次の3項目のどれかが欠けているときは、反映しない。
欠けたまま渡すと、秘密でない設定や反映済みのshaまでpushで上書きするためである。

- `factory_config.resource.yaml`
- `deployed_sha.variable.yaml`
- `freezes.variable.yaml`

実在しない`target`の凍結は、除外に足したうえで警告を出す。

## 追従

終わった行があると、`self_update`は、shaが変わらない回でも`wmill sync push`だけをやり直す。
やり直しで、凍結のあいだ除外していたスケジュールが、リポジトリの定義へ戻る。
migrationと`deployed_sha`の更新はしない。
pushが成功したら、その行を消す。
この一連を追従と呼ぶ。

追従だけの回が失敗しても、`deployments`に失敗の行を足さない。
反映の対象のコミットが無く、次の回が再試行するためである。
行を消す書き込みが失敗したときは警告だけを残し、次の回が同じpushを繰り返す。

終わってから24時間を過ぎた行は、次の`place`で捨てる。
捨てた行は追従のpushが行われないので、スケジュールは次の反映で戻る。

## 読めないとき

`self_update`が変数を読めない、または壊れていると判定した回の動作は、反映が要るかで分かれる。

| 回の種類 | 動作 |
| --- | --- |
| 反映が要る(shaが変わった) | 失敗にする。pushも、migrationも、`deployed_sha`の更新もしない |
| 反映が不要 | 警告だけを残して終わる |

失敗の文言に回復手順`freeze:reset`を示すのは、変数が壊れていると判定したときだけである。
読み取りの失敗(APIのエラー、10秒の時間切れ)には示さない。
読み取りの失敗は一時的なことが多く、次の回の再試行を待つ。

`wmill variable list`が100件以上を返したときは、変数が無いと判定できないので、読み取りの失敗として扱う。

読む段と書く段は、それぞれ`FREEZE_PHASE_TIMEOUT_MS`(10秒)で包む。
段の中は、変数のAPIとファイルの読み取り(`wmill.yaml`の読み込みと`f/`の列挙)だけで、子プロセスは起動しない。
区切った呼び出しの数には数えず、ジョブ全体の最悪の長さに2段ぶんを足す([アーキテクチャ](../architecture.md)の「自己更新」)。

## 置く主体

環境変数`CLAUDECODE`があれば`session`、無ければ`human`として扱う。
この区別は誤操作を防ぐためで、権限の境界ではない。

| 操作 | `session` | `human` |
| --- | --- | --- |
| 置く(`freeze:place`) | 置ける | 端末(TTY)で`yes`を入力して置く |
| 解除(`freeze:release`) | 自分の`holder`の凍結だけ解除できる | 端末で`yes`を入力して解除する |
| 壊れた変数を空に戻す(`freeze:reset`) | できない | 端末で`yes`を入力して実行する |
| 削除を反映するpush(`push:prune`) | できない | 端末で`yes`を入力して実行する |

`--dry-run`付きのpushは、どちらの主体も実行できる。

## 運用手順

スケジュールを画面で止めて確認する手順である。

1. 凍結を置く。

   ```bash
   mise run freeze:place -- --target f/factory/<name> --minutes <n> --reason <text>
   ```

2. `place`が表示する時刻(7分後)まで待つ。
   置く前に始まった`self_update`のpushが、終わるまでの時間にあたる。
3. 止める直前に`mise run freeze:list`を実行し、自分の行が残っているかを確かめる。
   同時に書き込むと、行を失うことがあるためである。
4. Windmillの画面でスケジュールを止める。
5. 確認する。
6. スケジュールを有効に戻す。
7. 凍結を解除する。
   解除を忘れても、期限で無効になる。

   ```bash
   mise run freeze:release -- <id>
   ```

解除か期限切れの後、`self_update`が次の回に追従のpushで、スケジュールをリポジトリの定義へ戻す。

`mise run freeze:list`で、凍結の一覧を見る。
`id`は`place`と`list`の出力に表示される。

## 失敗の回復

凍結の変数が壊れると、反映が要る回は止まる。
人が端末で次を実行して、変数を空に戻す。
空に戻すと、すべての凍結が消える。

```bash
mise run freeze:reset
```

`mise run deploy`は、先頭の`git pull`の前に`freeze.ts check`を実行する。
変数を読めないときは警告だけで進み、壊れていれば失敗する。

## 反映の経路

`mise run push`、`push:prune`、`push:dry`、`deploy`は、`scripts/freeze.ts push`を通る。
このラッパーが除外を作って`wmill sync push`を実行する。
`scripts/bootstrap.sh`の全手順のモード(`mise run bootstrap`)も、同じラッパーを通してpushする。
凍結の変数がまだ無い初回は、一覧で無いと確かめられたときだけ、凍結なしとして進む。
変数を読めないとき、壊れているときは、bootstrapもpushの手順で止まる。
