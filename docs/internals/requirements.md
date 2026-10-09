# 要件定義の生成と承認

工程2で要件定義ドラフトを作る処理と、人の承認を待って反映する仕組みを定める仕様である。pipelineフロー、承認のscript、Consoleの要件定義の表示を変更する人が読む。

## 生成の流れ

pipelineフロー(`f/factory/pipeline`)は次の3つのステップで動く。どのステップも、要件定義フローのリースを持つときだけ作業項目を書き換える。リースは[作業項目の状態とリース](work-items.md)に書く。

| ステップ | 処理 |
| --- | --- |
| `pipeline_prepare` | attemptを保存し、対象リポジトリの既定ブランチの先頭に要件定義用のworktreeを用意する。Issueが閉じていれば取り消す |
| `pipeline_generate` | 日次予算を確かめ、headless Claudeに要件定義書と図を書かせ、検査してドラフトとして保存する |
| `pipeline_request_approval` | 承認依頼を記録して通知し、人の判断を待たずにフローを終える |

要件定義用のworktreeは`/workspaces/<owner>/<repo>/req-<N>`に置く。既存のworktreeが既定ブランチの今の先頭と違えば、消して作り直す。

日次予算を超えていれば、`pipeline_generate`はClaudeを起動しない。作業項目を人の対応待ち(`needs_human`)にし、Discordに通知する。

## 要件定義ファイルの置き場所

生成した要件定義書と図は、DBではなくworkerのファイルに置く。試行ごとのディレクトリ(`doc_dir`)の形式は次のとおり。

```text
/var/lib/factory/requirements/<owner>/<repo>/issue-<N>/wi-<work_item_id>/attempt-<attempt>/
```

`/var/lib/factory`は、volume(`factory_state`)である。CLIを動かすworkerのコンテナが書き込みでマウントし、Console用のworkerのコンテナが読み取り専用でマウントする。このディレクトリはコミットしない。`owner`と`repo`は、GitHubの名前として正しいかを確かめてからパスに埋め込む。

ディレクトリには、要件定義書の`requirements.md`と、図の`<name>.drawio`だけを置く。DBの`requirement_drafts`には、本文(`markdown`)、図の参照(`{name, file}`)、未確定事項、`doc_dir`を保存する。図のXMLはDBに保存しない。

Consoleのbackendは、CLIを動かすworkerとは別のConsole用workerで動く。このworkerはワーカーグループ`console`、tag `console`、`NUM_WORKERS=2`で、同じvolumeを読み取り専用でマウントして要件定義書を読む。`console_query`は`doc_dir`を字面で解決し、要件定義の置き場所の下でなければ読まない。CLIを動かすworkerを複数のコンテナに分けるときは、このディレクトリを共有するストレージが要る。

作業項目を削除するときの要件定義ディレクトリの扱いは、DBの掃除(`cleanup_db`)が受け持つ。

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

Consoleの**要件定義**タブと、**承認**タブの要件定義の詳細は、どちらも`f/factory/steps/console_query.ts`の`requirements_doc`ビューを使う。このビューは`requirements_doc.ts`の検査とは別のものである。

ビューは、DBの行の`doc_dir`から`requirements.md`と各図のファイルを読み戻す(`readDocFromDisk`)。raw appの`components/RequirementsDocument.tsx`、`Markdown.tsx`、`DrawioViewer.tsx`が、本文、目次、図をページの中に描画する。見た目はConfluenceの文書ページに近い。

読み戻しの規則は次のとおり。

- `doc_dir`は`/var/lib/factory/requirements/`の下になければ読まない。
- `doc_dir`が無いか`requirements.md`を読めないときは、DBの`markdown`列を返し、図は空にする。
- 図のファイルが1つ読めなくても、その図だけを落として本文は表示する。
- 図名かファイル名が決まった形式に合わない図は、パスをつなぐ前に落とし、警告をログに残す。

図のXMLはConsoleの描画のためだけに読む。GitHubとDiscordには送らない。

## 承認の仕組み

承認はWindmillのsuspendを使わず、承認依頼のテーブル(`approval_requests`)の行で待つ。pipelineフローは承認依頼を記録して終わり、人の決定は別のジョブが反映する。

### 承認依頼

承認依頼の種類(`kind`)は2つある。

| kind | 対象(`subject_id`) | 期限 | 反映するscript |
| --- | --- | --- | --- |
| `requirements` | 要件定義ドラフト(`requirement_drafts.id`) | 7日 | `f/factory/steps/requirements_apply` |
| `issue_proposal` | Issue化の提案(`issue_proposals.id`) | なし | `f/factory/steps/issue_proposal_apply` |

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

人はConsoleの**承認**タブから承認か却下をする。Consoleは`f/factory/approval_decide`を実行する。却下には理由が必須で、承認には要らない。補足(`note`)は理由に織り込んで記録する。判断側のオプション(`options`)は`decision_options`列に記録する。

`approval_decide`は、行の今の状態と今回の決定を比べて扱いを決める(`classifyExistingDecision`)。

| 行の状態 | 扱い |
| --- | --- |
| `pending` | 決定を記録し、反映するscriptを起動する |
| 同じ決定が記録済み | 記録し直さず、反映するscriptだけを起動し直す |
| 違う決定が記録済み、または期限切れ | 上書きせずエラーにする |

同じ決定での再実行は、記録の後に反映するscriptの起動が失敗したときのためにある。

決定の記録は、`status = 'pending'`を条件にした更新で行う(`decideApprovalRequestIfPending`)。読み取りと書き込みの間に別の呼び出しが記録していれば、行を読み直して上の表で分類し直す。

反映するscriptは`wmill.runScriptByPathAsync`で起動する。

承認者(`decided_by`)は引数ではなく、ジョブの実行文脈から決める(`deriveApprover`)。`WM_USERNAME`を使い、無ければ`WM_EMAIL`を使う。どちらも無ければ例外にし、承認者が分からないまま記録しない。

### 要件定義の承認の反映

`requirements_apply`は、作業項目が承認待ち(`awaiting_approval`)のときだけ処理する。それ以外の状態なら何もしない。

承認なら、作業項目を承認済み(`approved`)にする。続けてIssueへのコメント、Discordへの通知、`req-<N>`のworktreeの削除を順に実行する。Issueへのコメントは、Consoleの要件定義へのリンク1件だけである。本文と図はIssueに書かない。

リンクの末尾には`#requirements/<work_item_id>`を付け、コメントには`work_item_id`も書く。Consoleがこのフラグメントを読めない環境でも、IDで探せるようにするためである。

`implement_enabled`が真なら、続けて実装フローを起動する。却下のときの遷移と、実装フローの起動の手順は[作業項目の状態とリース](work-items.md)に書く。

### 期限切れ

要件定義の承認依頼は、記録したときに7日後の期限(`expires_at`)を持つ。期限を判定するのは`poll_issues`だけで、reconcileの後に毎回実行する。

1. `pending`のまま期限を過ぎた依頼を、`status = 'pending'`を条件に期限切れへ更新する。
2. 更新できたら、作業項目を承認待ちから期限切れ(`expired`)へ比較交換で移す。
3. 移せたら、Discordに人の対応待ちとして通知する。理由は`approval timed out`である。

人の決定と期限切れの更新が同時に起きても、条件付きの更新なので片方だけが記録される。作業項目が既に次の状態に進んでいれば、作業項目は変えない。

1件の処理が例外を投げたときは、`job_failures`に記録して次の依頼へ進む。Issue化の提案の承認依頼は期限を持たないので、期限切れにならない。
