# 要件定義の生成と承認

工程2で要件定義ドラフトを作る処理と、人の承認を待って反映する仕組みを定める仕様である。pipelineフロー、承認のscript、Consoleの要件定義の表示を変更する人が読む。

## 生成の流れ

pipelineフロー(`f/factory/pipeline`)は次の3つのステップで動く。どのステップも、要件定義フローのリースを持つときだけ作業項目を書き換える。リースは[作業項目の状態とリース](work-items.md)に書く。

| ステップ | 処理 |
| --- | --- |
| `pipeline_prepare` | attemptを保存し、リポジトリのオーナーを`owners`と照合してから、対象リポジトリの既定ブランチの先頭に要件定義用のworktreeを用意する。Issueが閉じていれば取り消す |
| `pipeline_generate` | 日次予算を確かめ、headless Claudeに要件定義書と図を書かせ、検査してドラフトとして保存する |
| `pipeline_request_approval` | 承認依頼を記録して通知し、人の判断を待たずにフローを終える |

要件定義用のworktreeは`/workspaces/<owner>/<repo>/req-<N>`に置く。既存のworktreeが既定ブランチの今の先頭と違えば、消して作り直す。

日次予算を超えていれば、`pipeline_generate`はClaudeを起動しない。作業項目を人の対応待ち(`needs_human`)にし、Discordに通知する。

リポジトリのオーナーの照合に通らないときは、`pipeline_prepare`が、対象リポジトリをcloneせずに、作業項目を人の対応待ちにしてDiscordに通知する。
後続のステップは飛ばす。
照合は[運用](../operations.md)の「オーナーの数値IDを固定する」に書く。

## 要件定義ファイルの置き場所

生成した要件定義書と図は、DBではなくworkerのファイルに置く。試行ごとのディレクトリ(`doc_dir`)の形式は次のとおり。

```text
/var/lib/factory/requirements/<owner>/<repo>/issue-<N>/wi-<work_item_id>/attempt-<attempt>/
```

`/var/lib/factory`は、名前付きボリューム`factory_state`である。defaultのworkerが読み書きし、Console用のworkerはサブパス`requirements`だけを読み取り専用でマウントする。このディレクトリはコミットしない。`owner`と`repo`は、GitHubの名前として正しいかを確かめてからパスに埋め込む。

ディレクトリには、要件定義書の`requirements.md`と、図の`<name>.drawio`だけを置く。
DBの`requirement_drafts`には、本文(`markdown`)、図の参照(`{name, file}`)、未確定事項、`doc_dir`、基準値(`doc_hash`)を保存する。
基準値は[基準値](#基準値)に書く。
図のXMLはDBに保存しない。

Consoleのbackendがどのworkerで動くかは、scriptの`tag`で決まる。どちらのworkerも、同じボリュームを読む。workerを別のホストに分けるときは、このディレクトリを共有するストレージが要る。

作業項目を削除するときの要件定義ディレクトリの扱いは、DBの掃除(`cleanup_db`)が受け持つ。

### 基準値

承認された要件定義が承認の後に書き換わっていないことは、承認の前に保存したディレクトリの内容のハッシュと比べて確かめる。
このハッシュを基準値と呼び、`requirement_drafts.doc_hash`に保存する。
基準値の取り方、複製との関係、照合の結果、基準値が無い下書きの扱いは、この節を正本にする。
照合する位置は、[実装](implement.md)の「準備」と「承認済み要件定義の複製」、[設計書の生成](design.md)の「書き込み境界」に書く。

#### ハッシュ

ハッシュは、`doc_dir`の下の項目の名前と中身のSHA-256で、`doc_tree_hash.ts`の`hashDirectoryTree`が求める。
項目の種類の印を前置きして数える。
通常のファイルは`F`、シンボリックリンクは`L`、特殊ファイルは`S`である。
リンクはたどらず、リンク先の文字列を中身として扱う。
印があるので、中身が同じ文字列の通常のファイルとリンクは、別のハッシュになる。
通常のファイルとディレクトリだけのディレクトリは、通常のファイルの印が`F`なので、保存済みの基準値がそのまま有効である。

`doc_dir`自体がシンボリックリンクなら、リンクの先を読まない。
リンクの先に同じ内容のディレクトリを置かれると、中身のハッシュが基準値と一致してしまうためである。
照合では書き換え、保存では失敗として扱う。

#### 保存

`pipeline_generate`は、下書きを保存するとき(`snapshotDocDir`)、次の順に処理する。

1. ディレクトリのハッシュを求める。
2. 図のXMLを検査する(`collectDocIssues`)。
3. ディレクトリの一覧を読む。
   `requirements.md`と図以外の項目があれば、`unexpected_entry`で失敗にする。
4. `requirements.md`と図を読む。
5. ディレクトリのハッシュをもう一度求める。

1回目と5回目のハッシュが違えば、保存せず例外にする。
DBの本文と基準値を、同じ時点の内容にするためである。
検査を2つのハッシュの間に置くのは、検査の後で足された内容を、検査を受けないまま基準値へ入れないためである。
ディレクトリが無く、ハッシュを求められないときも、保存せず例外にする。
基準値の無い下書きを作らないためである。

#### 複製との関係

承認済みの要件定義をClaudeに読ませる複製は、各ファイルを1回だけ読む。
読んだバイト列でハッシュを数え、同じバイト列を書き出す(`copyDirectoryTreeWithHash`、`copyFilesWithHash`)。
複製が返すハッシュを基準値と比べるので、照合した内容と複製の内容が同じになる。
複製の最中だけ元のファイルを書き換えて戻しても、複製には入らない。
複製の前後に元のディレクトリを照合する処理は、これに加えて残る。

リンクと特殊ファイルは、ハッシュには入るが複製しない。
複製したファイルの権限は、既定(umask)である。

#### 照合の結果

照合の結果は4つで、`checkDocTreeHash`が返す。

| 結果 | 条件 |
| --- | --- |
| 一致 | 現在のハッシュが基準値と等しい |
| 基準値なし | 基準値が空である。ディレクトリは読まない |
| 欠落 | 基準値があるのに、ルートのディレクトリが無い |
| 書き換え | 現在のハッシュが基準値と違う。ルートがシンボリックリンクに置き換わったときを含む |

欠落は、workerやボリュームの作り直しで消えた場合であり、書き換えとは原因が違うので、理由を分ける。

ハッシュを数えている途中で項目が消えたか、ディレクトリがファイルに置き換わった例外(ENOENT、ENOTDIR)を受けたときは、ルートのディレクトリを調べ直す。
ルートが無ければ欠落、残っていれば書き換えにする。
例外の判定は、`code`があれば`code`だけで行う。
パスに`ENOENT`を含むファイル名があっても、別の例外を取り違えないためである。

#### 基準値が無い下書き

次の下書きは、基準値が空である。

- 基準値の列を足す前に保存した下書き
- 列が無い間に、基準値なしで保存した下書き

基準値の列は、migration(`20261026150000_requirement_drafts_doc_hash`)が足す。
コードがmigrationより先に反映された間は、列が無いエラーで保存に失敗する。
列が無いエラーは、PostgreSQLのコード42703で、エラーの文が`doc_hash`を含むものだけを指す。
文が無いときは、コードだけで判定する。
別の列が無いエラーは、この迂回に入れず、そのまま失敗にする。
そのときだけ、`doc_hash`を除いて保存し直し、警告をログに残す。
下書きが保存されないと承認に進めないためである。

基準値なしで保存すると、通知`doc_hash_column_missing`(要対応)を残す。
本文は固定で、未解決の通知は1件にまとまる。
この通知を自動で解決する処理は無い。
確かめ終えたら人が解決する。
対応は[運用](../operations.md)の「通知の種類」の表に書く。

基準値が無い下書きは、承認の後の書き換えを検出できない。
照合は基準値なしを返し、ディレクトリを読まない。
実装と設計は、それぞれの位置で、警告を残して飛ばすか、別の比較で補う。

## Claudeの実行

`pipeline_generate`は、試行ごとのディレクトリを空にしてからテンプレートを`requirements.md`として複製し、そこをClaudeのカレントディレクトリにする。空にするのは、再試行した試行に前の試行の書きかけを見せないためである。

| 項目 | 値 |
| --- | --- |
| カレントディレクトリ | 試行ごとのディレクトリ |
| ツール | `Read`、`Glob`、`Grep`、`Write`、`Edit` |
| 許可するツール | `Write`、`Edit`(`--permission-mode dontAsk`で確認なしに実行する) |
| 対象リポジトリ | worktreeを`--add-dir`で読み取り専用として渡す。カレントディレクトリにはしない |
| スキル | `factory-requirements`と`drawio-diagram` |
| 構造化出力 | `{summary, open_questions}` |
| モデル | `heavy_model` |
| 上限 | `max_turns`、`max_budget_usd_per_run`、`claude_timeout_sec` |

Claudeは`requirements.md`を`Edit`で埋め、図があれば`<name>.drawio`を`Write`で横に置く。`Write`と`Edit`を許可しても、`--restricted`によって書き込みはカレントディレクトリの下に閉じる。

本文と図は、実行の後にディレクトリから読み戻す。想定外のファイルやディレクトリがあれば、警告を残して消す。

Claudeに渡すIssueの題名、本文、URLは、作業項目に取り込んだときのものである。2回目以降の試行では、前のドラフトと却下の理由も渡す。

## テンプレートと検査

テンプレートは`.claude/skills/factory-requirements/template.md`にある。生成した文書は`f/factory/lib/requirements_doc.ts`が機械的に検査する。章立てなどの決まりは`f/factory/lib/requirements_template.ts`に定数として持つ。

| 検査 | 内容 |
| --- | --- |
| 章立て | `##`の見出しが、順序も含めて決まった11章と一致する |
| 要件のID | 機能要件、非機能要件、受入条件の表のIDが`FR-001`、`NFR-001`、`AC-001`の形である |
| 禁止の記法 | コードフェンス、太字、絵文字、残ったHTMLタグ、埋めていない`<...>`が無い。アラートは`NOTE`、`WARNING`、`IMPORTANT`だけを使う |
| 引用 | 中身の無い引用の行が無く、アラートの見出しの後に本文の行が続く |
| 長さ | 文書全体が8000字以内、1行が200字以内、地の文の1段落が3文以内である |
| 図 | 図は3つまで。本文の参照`![name](name.drawio)`とファイルが対応する。図名は英小文字、数字、ハイフンの64字以内である |
| 図のXML | 各図のXMLがdraw.ioの形式として正しい |
| 文章 | 見出しにコード表記が無い(`prose_check.ts`の規則) |

常体と敬体の混在も`prose_check.ts`で調べるが、ログに残すだけで失敗にしない。
引用符の無い画面の文言や注記の敬体でも当たり、生成をやり直す費用に見合わないためである。

Claudeの出力が検査を通らないときは、問題点をプロンプトに付け足して1回だけ再試行する(`runClaude`の`reviewOutput`)。
再試行は新しいセッションで動くので、前回書いたファイルを作り直さずに編集して直すよう、プロンプトで伝える(`reviewRetryNote`)。
再試行がタイムアウトなどの別の理由で失敗したときは、再試行に至った問題も失敗の詳細に残す。再試行の後も通らなければ、ステップは例外で失敗する。失敗は`on_error_flow`が扱う。

## Consoleでの表示

Consoleの**作業項目**の要件定義書の画面と、**要対応**の要件定義の詳細は、どちらも`f/factory/steps/console_query.ts`の`requirements_doc`ビューを使う。このビューは`requirements_doc.ts`の検査とは別のものである。

ビューは、DBの行の`doc_dir`から`requirements.md`と各図のファイルを読み戻す(`readDocFromDisk`)。
Consoleの要件定義書の画面(`/console/items/:id/requirements`)が、本文、目次、試行の切り替え、図を描画する。
実装は`src/screens/items/RequirementsDocumentView.tsx`である。
本文は`src/components/markdown/Markdown.tsx`、図は`src/components/drawio/DrawioFrame.tsx`が描く。
左に本文、右に目次を置く。
本文のリンクは、作業項目と同じリポジトリのIssueとPRのURLと、見出しへのフラグメントだけをリンクにする。
図は、読み戻すときにも`validateDrawioXml`で検査し、通らない図は落として、名前を`rejected_diagrams`で返す。
本文は、落とした図を「安全の検査を通らなかったので表示しません」と出す。
通った図は、隔離したiframeの中で描く。
画面の仕様は[Consoleの仕様](console.md)の「要件定義書の画面」にある。
理由は[セキュリティ](../security.md)の「draw.ioの図の描画」と「要件定義書のリンク」にある。

読み戻しの規則は次のとおり。

- `doc_dir`は`/var/lib/factory/requirements/`の下になければ読まない。
- `doc_dir`が無いか`requirements.md`を読めないときは、DBの`markdown`列を返し、図は空にする。
- 図のファイルが1つ読めなくても、その図だけを落として本文は表示する。
- 図名かファイル名が決まった形式に合わない図は、パスをつなぐ前に落とし、警告をログに残す。

図のXMLはConsoleの描画のためだけに読む。GitHubとDiscordには送らない。

## 承認の仕組み

承認はWindmillのsuspendを使わず、承認依頼のテーブル(`approval_requests`)の行で待つ。pipelineフローは承認依頼を記録して終わり、人の決定は別のジョブが反映する。

### 承認依頼

承認依頼の種類(`kind`)は3つある。

| kind | 対象(`subject_id`) | 期限 | 反映するscript |
| --- | --- | --- | --- |
| `requirements` | 要件定義ドラフト(`requirement_drafts.id`) | 7日 | `f/factory/steps/requirements_apply` |
| `issue_proposal` | Issue化の提案(`issue_proposals.id`) | なし | `f/factory/steps/issue_proposal_apply` |
| `design` | 設計の下書き(`design_drafts.id`) | 7日 | なし |

`design`は、設計の承認依頼を記録するための種類で、反映するscriptを持たない。

`(kind, subject_id)`は一意である。依頼側の情報は`payload`に入る。要件定義の承認依頼では`{"attempt": n}`である。

承認依頼の状態は次の4つである。

| status | 意味 |
| --- | --- |
| `pending` | 決定を待っている |
| `approved` | 承認された |
| `rejected` | 却下された |
| `expired` | 期限を過ぎた |

`approvals`テーブルは古い承認と却下の履歴だけを持ち、今は書き込まない。

### 決定の記録

人はConsoleの**要対応**から承認か却下をする。Consoleは`f/factory/approval_decide`を実行する。却下には理由が必須で、承認には要らない。補足(`note`)は理由に織り込んで記録する。判断側のオプション(`options`)は`decision_options`列に記録する。

`approval_decide`は、行の今の状態と今回の決定を比べて扱いを決める(`classifyExistingDecision`)。

| 行の状態 | 扱い |
| --- | --- |
| `pending` | 決定を記録し、反映するscriptを起動する |
| 同じ決定が記録済み | 記録し直さず、反映するscriptだけを起動し直す |
| 違う決定が記録済み、または期限切れ | 上書きせずエラーにする |

同じ決定での再実行は、記録の後に反映するscriptの起動が失敗したときのためにある。

反映するscriptのpathは、行を読んだ直後に引く(`decideApproval`)。
上の表の分類、Issueの確認、決定の記録よりも前である。
反映するscriptの無い種類の決定は、記録せずに断る。
記録した後で無いと分かると、記録だけが残って反映されないためである。
記録済みの依頼を再実行する経路も、同じ位置を通る。

決定の記録は、`status = 'pending'`を条件にした更新で行う(`decideApprovalRequestIfPending`)。読み取りと書き込みの間に別の呼び出しが記録していれば、行を読み直して上の表で分類し直す。

反映するscriptは`wmill.runScriptByPathAsync`で起動する。

承認者(`decided_by`)は引数ではなく、ジョブの実行文脈から決める(`deriveApprover`)。`WM_USERNAME`を使い、無ければ`WM_EMAIL`を使う。どちらも無ければ例外にし、承認者が分からないまま記録しない。

### 承認の前のIssueの確認

要件定義を承認するときは、決定を記録する前に、現在のIssueの題名と本文が取り込み時点(`work_items.title`、`body`)と同じかを確かめる。実装のClaudeに渡るのは取り込み時点の内容なので、承認者が見た内容と一致させるためである。

確認は`approval_decide`の中で行う。
`approval_decide`はConsole用のworkerで動き、`gh`を起動できない。
そのため、`github_token`を読み、GitHubのREST APIを`fetch`で直接呼ぶ(`fetchIssueContent`)。読むのは`GET /repos/<owner>/<repo>/issues/<番号>`である。
別のscriptに頼むと、defaultのworkerの待ち行列に並ぶ間、Console用workerの枠を塞ぐためである。
通信の決まりは次のとおりである。

- 宛先は`https://api.github.com`に固定し、ownerとrepoは検査してから使う。
- `github_token`は`Authorization`ヘッダだけに載せる。
- リダイレクトは辿らない。
- 10秒の締め切りを付ける。
- エラーの文とログに、トークンとIssueの内容を含めない。

判定は次の3つである。

| 判定 | 意味 | 承認 |
| --- | --- | --- |
| `match` | 題名と本文が同じ。改行コードと本文の前後の空白の違いは無視する | 記録する |
| `changed` | 取り込み後に題名か本文が変わった | 断る |
| `unavailable` | 作業項目やIssue番号が無い、トークンを読めない、通信の失敗、締め切りの超過、2xx以外の応答(3xx、4xx、5xxを含む)、形の違う応答のどれかで、比べられなかった | 断る |

確認するのは、要件定義の承認を新しく記録するときだけである(`needsIssueCheck`)。却下、決定が記録済みの行への再実行、Issue化の提案は確認しない。

断るときのエラーは、Issueが変わった旨と、承認者が取れる手を示す。
1つは、Issueを取り込み時点の内容に戻して、もう一度承認することである。
もう1つは、却下することである。却下による作り直しは、現在のIssueの題名と本文を取り込み直し、更新したことを承認者に知らせる([作業項目の状態とリース](work-items.md)の「却下と再生成」)。作り直した要件定義には、あらためて承認が要る。
`unavailable`はしばらく待ってからやり直す。

確認から決定の記録までの間のIssueの書き換えは防げない。
承認者が見た内容のハッシュに結び付ければ防げるが、`approval_decide`がそのハッシュを受け取らないので、今は採れない。
実装を終えたときの、PR本文の注記が残りを拾う。

Console用のworkerで動くscriptのうち、`github_token`を読むのは、`retry_work_item`と`approval_decide`である。
`approval_decide`は2つ目の例外にあたる([セキュリティ](../security.md)の「Console用workerの境界」を参照)。

### 要件定義の承認の反映

`requirements_apply`は、作業項目が承認待ち(`awaiting_approval`)のときだけ処理する。それ以外の状態なら何もしない。

承認なら、作業項目を承認済み(`approved`)にする。続けてIssueへのコメント、Discordへの通知、`req-<N>`のworktreeの削除を順に実行する。Issueへのコメントは、Consoleの要件定義へのリンク1件だけである。本文と図はIssueに書かない。

リンクは、承認した試行の要件定義書のページ(`/console/items/<work_item_id>/requirements?attempt=<k>`)を指す。コメントには`work_item_id`も書き、リンクが開けないときでも、どの作業項目の承認かを特定できるようにする。

承認の分岐は、依存を注入できる関数に切り出してある。
設計フローを起動する依存が空でなければ、承認済みの代わりに設計中(`designing`)へ移して設計フローを起動する。
本番ではこの依存が常に空で、設計フローは動かない。
仕組みは[設計書の生成](design.md)に書く。

`implement_enabled`が真なら、続けて実装フローを起動する。却下のときの遷移と、実装フローの起動の手順は[作業項目の状態とリース](work-items.md)に書く。

### 期限切れ

要件定義の承認依頼は、記録したときに7日後の期限(`expires_at`)を持つ。期限を判定するのは`poll_issues`だけで、reconcileの後に毎回実行する。

1. `pending`のまま期限を過ぎた依頼を、`status = 'pending'`を条件に期限切れへ更新する。
2. 更新できたら、作業項目を承認待ちから期限切れ(`expired`)へ比較交換で移す。
3. 移せたら、Discordに人の対応待ちとして通知する。理由は`approval timed out`である。

人の決定と期限切れの更新が同時に起きても、条件付きの更新なので片方だけが記録される。作業項目が既に次の状態に進んでいれば、作業項目は変えない。

1件の処理が例外を投げたときは、`job_failures`に記録して次の依頼へ進む。Issue化の提案の承認依頼は期限を持たないので、期限切れにならない。
