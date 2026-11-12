# 反映の承認の内部仕様

保護パスに触れた変更の反映を、HEADの版ごとに人の承認まで止める仕組みの仕様である。
次のファイルを変更する人と、承認の運用を確かめる人が読む。

- `f/factory/lib/deploy_approvals.ts`
- `f/factory/lib/deploy_gate.ts`
- `f/factory/self_update.ts`
- `f/factory/console_deploy_decide.ts`
- `f/factory/console_holds.ts`
- `f/factory/poll_issues.ts`
- `migrations/datatable/main/20261105100000_deploy_approvals.up.sql`

運用の手順は[運用](../operations.md)の「保護パスの変更の反映を承認する」にある。
安全策と残るリスクは[この文書の「反映の承認」](#反映の承認)に書く。

## 方針

mainは承認0件でマージでき、`self_update`が2分ごとに反映する。
保護パスはPR修正の自動修正を止め、実装のPR本文に明記させるが、マージと反映は止めない。
そこで、`self_update`は反映の直前に、本番へ反映する保護パスのファイルかmigrationの変更を探す。
見つけたら、人がConsoleで承認するまで反映しない。
止めるのは`self_update`が反映するファイルだけで、範囲は「判定の流れ」の2にある。

- 承認はHEADの版ごとに行う。
  mainが進んだら、新しい版で承認し直す。
- 止めた状態は期限で解けない。
  却下したときは、mainへ戻すPRが要る。
- 却下はその版に対するものである。
  後からmainが進むと新しい版の依頼ができ、却下した変更を含んだまま再び判断を求める。
  戻すPRが反映されるまで、保護パスの変更は反映されない。
- 初回の反映(`deployed_sha`が空)は止めない。
  全ファイルが差分になるためである。

## 承認の表

承認は`factory.deploy_approvals`に置く。
`factory.holds`は使わない。
止めるためだけの表で、許可に使わない決まりのためである。
`factory.approval_requests`も使わない。
作業項目が必須のためである。

| 列 | 意味 |
| --- | --- |
| `sha` | HEADの版(40桁の小文字の16進)。主キー |
| `protected_paths` | 反映する範囲で反映を止めたファイル。1件以上 |
| `requested_at` | 依頼を作った時刻 |
| `decided_at`、`decision`、`decided_by` | 判断の時刻、結果(`approved`か`rejected`)、判断した人。3つとも同時にNULLか、同時にNULLでない |

判断の対象は最後に成功した反映(`factory.deployments`の`result = 'success'`)より後に作られた依頼のうち、最も新しい1件だけである。
次の2種類の依頼は行を残したまま対象から外れる。

- mainが進んで新しい依頼ができた古い依頼。
- 保護パスの変更が戻されて、判定を通らずに反映された依頼。

行は消さず、履歴として残す。
読み書きは`lib/deploy_approvals.ts`だけが行い、依頼を作るのは`self_update`、判断を書くのはConsoleの判断のscriptだけである。
守らせるのは`tests/scripts/deploy_approvals_wiring.test.ts`の参照の検出である。

判断の対象を最後に成功した反映の時刻で決めるので、DBの掃除は期限を過ぎても最後に成功した反映の行を残す。
`cleanup_db`が消すと、古い依頼が対象に戻り、承認済みの版を誤って待つためである。

## 判定の流れ

`self_update`は、凍結の保留の判定の直後、トークンの取得より前に判定する。
追従だけの回と初回は判定しない。

1. `git diff --name-status --no-renames -z <deployed_sha>..<HEAD>`で、反映する範囲の変更を読む。
2. 変更のうち、反映を止めるものを選ぶ。
   削除も数える。
   無ければ反映を続ける。
   - 範囲は、`self_update`が本番へ反映するファイルである。
     `f/`と`migrations/`の下と`wmill.yaml`で、`wmill-lock.yaml`と`*.script.lock`を除く。
   - `migrations/`の下は保護パスかどうかによらず止める。
     `self_update`が自動で適用し、表を消すような操作も書けるためである。
   - `f/`の下と`wmill.yaml`は、`matchesImplementProtectedPath`に当たるものと、新しい`*.sh`だけを止める。
   - 範囲の外の保護パスは止めない。
     止めても安全策にならず、反映を止めるだけになるためである。
     `infra/`は人が`mise run up`を実行するまで効かず、`.github/`はCIにしか効かない。
     `.claude/`と`scripts/`とlockfileと設定は`self_update`が反映しない。
3. HEADの版の依頼を読む。
   承認されていれば、反映を続ける。
4. 依頼が無ければ、依頼を作り、古い版の承認待ちの通知を解決する。
   依頼が判断待ちか却下なら、依頼を作らず、解決もしない。
5. 止めるたびに、要対応の通知`deploy_approval_required`を残す。
   同じ版の未解決の通知があれば重ねない。
6. 通知を新しく残したときだけ、Discordに送る。
7. 承認されていなければ、`held`(理由`protected_paths_approval`)で戻る。
   `deployed_sha`を進めず、失敗の行も足さない。

差分と依頼を読めない回、依頼を書けない回は、例外でジョブを失敗させ、反映しない。
通知とDiscordの失敗では止め方を変えない。
反映が成功したら、承認待ちの通知をすべて解決する。

判定は`lib/deploy_gate.ts`にあり、読み込むのは保護パスの一覧と承認の表の部品だけである。
どちらも保護パスで、判定のimportの連鎖がすべて保護パスに入っていることを`tests/lib/protected_paths.test.ts`が確かめる。
組み込みの位置は`tests/scripts/self_update_deploy_gate.test.ts`が固定する。

判定の入力は守らないモジュールから来る。
差分を取る`lib/workspace.ts`の`runCommand`と、承認の行を読む`lib/db.ts`の`defaultSqlClient`である。
守ると、全機能が使うモジュールを直すほぼすべてのPRが承認待ちになる。
この部分は人のレビューとDBの権限に頼る([この文書の「反映の承認」](#反映の承認))。

## 通知

| 種類 | 重要度 | 本文 | 解決 |
| --- | --- | --- | --- |
| `deploy_approval_required` | 要対応 | 待っている版と、保護パスのファイルの件数、次の操作。パスは載せない | 承認、新しい版の依頼、反映の成功で自動で解決する。却下では残る。Consoleの解決はできない |
| `deploy_approval_decided` | 情報 | 判断した版、判断、操作者 | 情報の通知と同じ |

却下した版は承認待ちの一覧に出ず、版の食い違いの通知も抑止される。
その状態で要対応の通知を解決すると、反映が止まったままなのに要対応が消える。
そのため、却下では要対応の通知を残し、戻すPRの反映の成功か、新しい版の依頼が解決する。

要対応の通知は、止めるたびに残す。
未解決の通知が既にあれば重ねないので、依頼を作った回に書き込みが失敗しても、次の回が残す。
古い版の通知の解決は、依頼を作った回だけに行う。
解決は版を区別せずに前方一致で当たり、続く回で行うと同じ版の通知を毎回作り直すためである。
Consoleの「反映の承認待ち」の一覧が受け皿で、通知が無くても承認できる。

## Console

システムの画面の「保留と凍結」の節の先頭に、承認待ちの版、保護パス(50件まで)、止めた時刻、承認と却下のボタンを出す。
承認待ちが無いときは出さない。
読み取りは`console_holds`の取得に含める。
承認待ちを読めないときは、承認待ちなしとは書かず、反映が止まったままである旨と理由を出す。
判断は`console_deploy_decide`(tag `console`)が記録する。
操作者はジョブの実行文脈から導き、操作の記録(`factory.console_actions`)を残せないときは判断しない。
このscriptの名前はローカルのClaudeのセッションから呼べないよう、拒否フックの一覧に入れる。

## 版の食い違いの通知

`poll_issues`は承認待ちの間も、deployの保留の間と同じく、`deployed_sha_mismatch`の通知を出さずに待つ。
最新の依頼が承認されていない間を、承認待ちとみなす。
保留と承認待ちのどちらかが有効なら、もう一方が読めなくても待つ。

## この仕組みを足した変更の反映

この仕組みを足した変更が反映される時点では、動いている`self_update`が判定を持たない。
そのため、この変更自体は承認なしで反映され、以後の保護パスの変更から承認が要る。

## 反映の承認

保護パスに触れた変更の反映は、HEADの版ごとに、人がConsoleで承認するまで止まる。
仕様はこの文書の前半にある。
判定、承認の表の部品、Consoleの判断のscript、判定の組み込みを固定するテストは、保護パスに入れる。
判定のimportの連鎖は、すべて保護パスに入れる。
Consoleの判断のscript(`console_deploy_decide`)は、ローカルのClaudeのセッションから呼べないよう、拒否フックの一覧に入れる。

関門が止めるのは、関門のコード自体と、保護パスの改変である。
関門の入力は守らない。
入力は、gitの差分を取る`lib/workspace.ts`の`runCommand`と、承認の行を読む`lib/db.ts`の`defaultSqlClient`である。
`lib/db.ts`は全機能が触るので、守るとほぼすべてのPRが承認待ちになる。
守っても、反映済みのどのscriptもDBに書けるので、承認の行を直接作る経路は閉じない。
ここは人のレビューとDBの権限に頼る。

残るリスクは次のとおりである。

- [R-DAP-01](../security-risks.md#r-dap-01)
- [R-DAP-02](../security-risks.md#r-dap-02)
- [R-DAP-03](../security-risks.md#r-dap-03)
- [R-DAP-04](../security-risks.md#r-dap-04)
- [R-DAP-05](../security-risks.md#r-dap-05)
- 要対応の通知は、止めるたびに残し、重複はしない。
  書き込みに失敗しても、次の回が残す。
  Consoleの「反映の承認待ち」の一覧が受け皿で、通知が無くても承認できる。
