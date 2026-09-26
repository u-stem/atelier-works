# 運用

## 運用ルール

- Issue を拾ったインスタンスの所有者が、その Issue の承認を行う。
- 各インスタンスは稼働前に `f/factory/factory_config` の `instance_name` を必ず設定する(Issue コメント・Discord 通知・承認 Inbox の担当表示に使われる)。
- 1つの Issue は1つのインスタンスが占有する。claim(assignee 設定 + `wip` ラベル付与)に成功したインスタンスだけがその Issue を処理し、後から来た他インスタンスは撤退する。
- 処理が終端 status(承認済み・要対応・タイムアウト・失敗・レビュー済み・再レビュー依頼・ブロック・キャンセル)になると、`wip` ラベルとトリガーラベル(`factory` / `factory:review` / `factory:fix`)は自動で外れる(承認済みは `factory:approved` に付け替わる)。**もう一度処理させたい場合は、人が改めてラベルを付け直す**(ラベルを残したままにしない設計により、孤児失敗した Issue / PR が自動で無限に再試行されることを防いでいる)。

## 日常運用

- Issue に `factory` ラベルを付けると拾われる(付与者は OWNER / MEMBER / COLLABORATOR のいずれかである必要がある)。
- 手動フォームからも同じパイプラインに Issue を投入できる想定(`manual_intake` フロー)。
- **承認は Factory Console App(`f/factory/factory_console`)の Inbox タブから行う**。Issue コメントに記載された Inbox の URL を開き、対象の作業項目を選択して要件定義・図(draw.io ビューアー)・未確定事項を確認したうえで承認 / 却下する(却下時は理由の入力が必須、補足は任意)。承認者は実行ユーザー(`WM_USERNAME`)として記録される。Windmill の approval page URL(承認 URL)から直接 resume しない(approval がスキップされて `needs_human` に落ちる)。App を使わない代替手順として、Windmill UI で `f/factory/approval_decide` を直接開き、`work_item_id` / `decision`(approve / reject) / `reason` / `note` を入力して Run することもできる。
- Reject すると要件定義が再生成され(`attempt` が加算される)、再度承認待ちになる。試行回数が上限を超えると `needs_human` になる。
- 失敗した work item は Factory Console App の Failures タブから再実行できる(`retry_work_item`)。再実行時は `wip` ラベルと該当するトリガーラベル(`factory` / `factory:review` / `factory:fix`)を再付与して再起動する。
- 通知の種類: `picked` / `awaiting_approval` / `approved` / `rejected` / `needs_human` / `failed` / `expired` / `cancelled` / `self_update`(ホスト操作が必要)/ `daily_summary`(前日のコスト・件数・失敗)。

## PR の使い方(pr_review / pr_fix)

- Claude が生成して GitHub に投稿する文章(指摘・コメント・返信・要約)は共通の文体規則に従う: 半角英数字と日本語の間に半角スペースを入れない(インラインコード・コードブロックの内部は対象外)、です・ます調、1文1行(要点が複数あれば箇条書き)。詳細は `.claude/skills/factory-review/SKILL.md` / `.claude/skills/factory-fix/SKILL.md` の「文体」節を参照。

### 起動条件

- PR に `factory:review` ラベルを付ける、または PR のレビュー依頼・assignee がこのインスタンスのアカウント(未処理の commit がある場合)で自動起動。
- トリガーラベルが外れた後でも、PR に下記いずれかの状態ラベルが付いていれば `poll_prs` が再発見する(例: レビュー完了 → `factory:reviewed` が付いた PR に、後日 `factory:fix` ラベルを付け直した場合)。
- コメント投稿者・レビュー者の `author_association` が `allowed_labeler_associations` に含まれることを確認してから起動する。

### PR レビュー(`pr_review`)

- 指摘が GitHub の COMMENT として投稿される。完了状態は `reviewed`。
- Factory はレビューの開始コメントを投稿しない。レビュー指摘(インラインコメント + コード提案)と総評のみを投稿する。
- 運用者自身のアカウントで投稿するため、総評・インラインコメントとも 1 行目に `[pr_review 自動レビュー] @<author>` というロールタグ + メンションが付く。
- レビュー総評は Claude の自由記述ではなく、次の固定 4 パターンのいずれかを flow が組み立てて投稿する: (1) 指摘を投稿した場合(初回・再レビュー共通、行に紐づけられず投稿できなかった指摘があるだけの場合も含む)は件数 + 「確認お願いします。」(この場合、最終判断の一文は付かない)、(2) このPRへの factory レビューが過去にあり指摘 0 件の再レビューは「修正を確認しました。LGTMです。」+「最終的なApprove判断は人が行ってください。」、(3) 初回レビューで指摘 0 件は「指摘はありません。LGTMです。」+ 同じ最終判断の一文、(4) このPRへの factory レビューが過去にあり指摘 0 件の再レビューだが、過去の `[MUST]` 指摘で今回の resolve 処理でも解決できなかったものが残っている場合は「新しい指摘はありません。未対応の指摘がN件残っています。確認お願いします。」(最終判断の一文は付かない)。Claude の `summary` は `factory.reviews` に記録されるのみで GitHub には投稿されない。
- 再レビューでは、このPRに対する factory 自身の未解決の指摘一覧が Claude への入力に含まれる。実質的に同じ内容の指摘は新規指摘として再度投稿されず、新規・変化があった指摘のみ報告される(diff で既に解消済みと判断できるものは何も報告されない。スレッドの resolve は別処理が行う)。
- スレッドの自動解決(resolve)は、factory 自身のインラインコメントスレッドのうち、そのスレッドの最後のコメントも factory が書いたものである場合に限られる。スレッド内に人が返信している場合は自動解決の対象にならず、開いたままになる。このPRへの factory レビューが過去にある(=再レビューである)たびに、pr_fix が commit sha 付きで「対応: `<sha>`」と返信済みのスレッドを resolve する(「対応: 見送り」「対応: 変更なし」は人の判断が必要なため resolve しない)。加えて指摘 0 件の再レビュー(上記パターン 2・4 のいずれでも)では、factory 自身の指摘のまま何も返信されていないスレッド(人が手で直した等)も resolve する。初回レビュー(過去の factory レビューがない)では何も resolve しない。resolve 処理後もなお開いたままの `[MUST]` スレッドが 1 件以上あると、パターン 4 になる。
- レビュー形式は `.claude/skills/factory-review/SKILL.md` の「投稿形式」節を参照。
- 運用通知(失敗・要人手・ブロック)は PR に投稿せず Discord に送る。

### PR 修正(`pr_fix`)

- PR に `factory:fix` ラベルを付けると実行される。すでに factory がレビュー済み(`reviewed`)の PR でも有効。修正への指示は、ラベルを付ける前に PR へ通常のコメントとして書いておく(`pr_fix_collect` が他の人間のコメントと同様にフィードバックとして収集する)。
- 運用通知(失敗・要人手・ブロック)は PR に投稿せず Discord に送る。
- レビュー指摘・未解決コメントの修正を行い、各コメントへ返信してから再レビューを依頼(`rereview_requested`)。
- 返信は運用者自身のアカウントで投稿するため、1 行目のロールタグ・本文・末尾の対応行(コミット sha または「見送り」)という固定構造で flow 側がレンダリングする。形式は `.claude/skills/factory-fix/SKILL.md` の「返信形式」節を参照。
- コミットメッセージは Claude が提案する件名(`commit_subject`、50文字以内を目安・72文字を超えると拒否・Conventional Commits形式)と任意の本文(`commit_body`、箇条書き)を flow が結合して作る。トレーラー(`Co-Authored-By` / `Generated-By`)は flow 側が自動で付与する。コミットメッセージにも英数字と日本語の間のスペース除去が適用される(コードスパン内は除く)。
- 要件変更が必要な場合は修正を中断し、元の Issue を requirements_generating に attempt+1 で再起動(`requirements_gap` → 親 Issue)。
- Factory 自身の投稿は「viewer(Factory の GitHub アカウント)と同じログイン **かつ** factory マーカー付き」の両方で判定する。同一アカウントで運用しているため、人が投稿したコメントはログインが一致してもマーカーが無いので human feedback として扱われる。同様に Factory 自身の一次レビュー(`pr_review`)とその未解決のインラインコメントもマーカー無し(または `pr_review` マーカー)であれば feedback として扱われ、pr_fix はその指摘を修正対象にする。除外されるのは Factory 自身の `pr_fix` 返信(`pr_fix` マーカー付き)のみ。

### ラベルと終端状態

- トリガーラベル(人が付与し、起動時に外れる): `factory:review`(レビュー起動) / `factory:fix`(修正起動)。`factory:pr` ラベルは factory 自身が作成した PR の目印(将来の工程3で使用)。このリポジトリ自身の基盤整備 PR(foundation PR)には `factory:review` / `factory:fix` / `factory:pr` のいずれも付けない。
- 状態ラベル(factory 自身が設定・付け替え、PR には常に高々1つだけ付く):

  | ラベル | 意味 | 付与タイミング |
  | --- | --- | --- |
  | `factory:changes-requested` | 一次レビューで修正が必要な指摘(must)があった、または今回は新規指摘がなくても未解決の `[MUST]` が残っている(上記パターン 4) | pr_review 完了時 |
  | `factory:reviewed` | 一次レビュー完了、修正不要(人の Approve 待ち) | pr_review 完了時(must なし、かつ未解決の `[MUST]` も残っていない) |
  | `factory:rereview` | 修正を push して再レビューを依頼中 | pr_fix が push に成功して終了したとき |
  | `factory:needs-human` | 人の対応が必要 | pr_fix が `needs_human` / `blocked` / `failed` で終了したとき、または pr_review 自体が失敗したとき |

  状態ラベルは人への状態表示に加え、`poll_prs` がトリガーラベル脱落後の PR を再発見する手段にもなる(前節「起動条件」参照)。PR がクレームされて新しいレビュー・修正サイクルが始まると、それまでの状態ラベルはすべて一旦外れる。
  - ラベルは対象リポジトリに事前作成しなくても、初回付与時に GitHub が既定色(灰色)・説明なしで自動作成する(`factory:wip` / `factory:approved` が実際にそうなっている)。一覧で見分けやすくしたい場合は、対象リポジトリで 4 つの状態ラベルを色と説明付きで先に作っておく。
  - 状態ラベルが付いた PR は以後も `poll_prs` の発見対象であり続けるため、人が新しい commit を push するたびに自動で再レビューが起動する(1 push につき Claude 実行 1 回)。再レビューを止めたい PR は状態ラベルを手で外す。
  - `review_post_mode: "gated"` ではレビューを投稿しないため状態ラベルも付けない(gated は検証用の予約モードで、PR はレビュー依頼・assignee 経由でのみ再発見される)。
- 対象は `factory_config` の `repo_allowlist`(未指定なら `owners` に含まれるリポジトリ全体)に含まれるリポジトリのみ。試験的に対象を絞りたい場合は `repo_allowlist` に対象リポジトリを明示する。
- 終端状態: `reviewed` / `rereview_requested` / `blocked` / `needs_human`。終端状態になると `wip` ラベルとトリガーラベル(`factory:review` / `factory:fix`)は自動で外れる。

### pr_fix の再実行

- `retry_work_item` で `failed` / `needs_human` / `blocked` の pr_fix 行を再実行できる。処理済み watermark(`last_review_id` / `last_comment_id` / `last_review_comment_id`)は push 成功時(または要件定義への差し戻し、`requirements_gap`)にしか進まないため、それ以外の終端(`failed` / `needs_human` / `blocked`)から再実行すると前回と同じフィードバックが再収集される。
- 次の round を明示的に始めたいときは、PR に `factory:fix` ラベルを付け直す(または新しいレビューを投げる)。

### 人が作った PR と要件の紐づけ

- PR 本文に `Closes #123`(`Fixes` / `Resolves` も可)と書くと、その Issue に対応する承認済み要件と照合され、pr_review / pr_fix の Claude 入力に要件が渡る。

## 更新の反映

- 通常の更新は `git pull` してから `mise run deploy` を実行する(ホスト側 checkout で `git pull --ff-only` → worker イメージのビルド → `docker compose up -d` → `wmill sync push` → migration を一括実行する)。
- worker の並列数(`NUM_WORKERS`)のような `infra/docker-compose.yml` の変更は、通常の `git pull` だけでは反映されない。`mise run deploy` を実行して worker イメージの再ビルドとコンテナの再起動まで行う。
- `wmill sync push` に **`--include-secrets` を付けてはいけない**。付けるとリポジトリ内の `f/factory/*.variable.yaml`(値は空のままコミットされている)で4つの secret 変数(`claude_oauth_token` / `github_token` / `wmill_token` / `discord_webhook_url`)が空に上書きされる。`mise run push`(`wmill sync push --yes --keep-deleted`)は `--include-secrets` を付けない設定になっている。
- secret 変数(`f/factory/*.variable.yaml`)と instance 固有の `factory_config` resource は同期対象外のため、これらの **説明文(description)を変えても `mise run push` では既存 instance に反映されない**。既存 instance では Windmill UI(Variables / Resources の編集画面)で説明文だけを更新する。新規 instance は bootstrap がリポジトリの説明文で作成する。
- `f/factory/deployed_sha` 変数も同期対象外(理由は他の2つと異なり、instance 固有の設定ではなく `self_update` が書き込む実行時状態のため)。`mise run push` を実行しても値は変わらない。`bootstrap` は初回のみ空値で作成し、既に存在する場合は値を変更しない。値をリセットしたい場合は Windmill UI から直接編集する。
- `self_update` スケジュール(10 分毎)が `infra/`・`mise.toml`・`mise.local.toml.example`・`scripts/` の変更を検知すると、Discord とダッシュボードの Notices で「`mise run deploy` を実行してください」と通知する。
- ダッシュボード App(Factory Console、`f/factory/factory_console__raw_app/`)は raw app としてコードでリポジトリ管理する。編集は Windmill UI ではなくリポジトリのソース(`App.tsx` / `tabs/*.tsx` / `backend/*.yaml` 等)を直接編集し、`mise run push` でデプロイする。バックエンド runnable を追加・変更した場合は `wmill generate-metadata` でロック情報を更新してからコミットする。

## 秘密のローテーション

1. GitHub PAT / Claude Code OAuth トークンを再発行する(手順は [docs/security.md](security.md) を参照)。
2. 新しい値を `mise set -E local KEY=value`(`read -rs` 経由を推奨)で投入する。
3. `mise run bootstrap` を再実行する。`bootstrap.sh` は冪等なので、既存の Windmill 変数は新しい値で上書き更新される。

## バックアップ

- Windmill のデータ(ワークスペース設定、Data Table、ジョブ履歴など)はすべて `db_data` という Docker volume(Postgres)に入っている。バックアップの対象はこの volume。
- `docker compose -f infra/docker-compose.yml down -v` は `db_data` を含むすべての volume を削除する破壊的操作である([docs/setup.md](setup.md) のトラブルシュートも参照)。

## 未実装の機能

次はまだ実装されていない。実装され次第このドキュメントを更新する。

- 工程 3 の「Issue から実装して PR を作る」フロー(factory 自身が実装 worktree を作成して PR を投稿する機能)
- 工程 4 のマージ後 CI 監視
- 工程 5 の自己改善提案(失敗・却下の履歴から改善 Issue を自動作成する機能)
- Discord 双方向化(ボタン操作による承認)
