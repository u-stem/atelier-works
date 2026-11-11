# 取り込み元

- リポジトリ: https://github.com/nanaism/yomiyasu
- バージョン: 3.0.1
- コミット: b9a69a3791dd7d3c063ed963bc4a408e515f6288(2026-11-11取得)
- ライセンス: MIT(`LICENSE`)。Unicodeデータ由来の部分は`UNICODE-LICENSE.txt`。
- 取り込んだもの: `skills/yomiyasu/`のうち`SKILL.md`、`references/`、`scripts/`、ライセンス2件。プラグイン設定(`.codex-plugin/`)と画像(`assets/`)は除いた。
- ローカルの変更: `SKILL.md`のfrontmatterから`allowed-tools`の行を消した。この行は、引数を絞らずにスクリプトの実行を確認なしで許し、任意のファイルの読み取りと任意の場所への書き込みを確認なしにできるためである。更新するときは取り込み元の同じパスで置き換えた後に、同じ行をもう一度消し、このファイルのコミットを書き換える。
- フックの扱い: `scripts/yomiyasu_hook.py`は取り込み元のまま同梱する。
  Claude Codeのフックとして、どこにも登録しない。
  登録しない対象は、`.claude/settings.json`、`.claude/settings.local.json`、ユーザーの設定、スキルとsubagentのfrontmatterの`hooks`である。
  登録すると、返答の終了(Stop)を続けさせる判定と、BashとMCPのツールの実行(PreToolUse)を確認(`ask`)か拒否(`deny`)にする判定が返りうる。
  どちらも働くのは、原稿を登録してから、登録を終えるかセッションが終わるまでである。
  原稿は、`/yomiyasu`か`yomiyasu_check.py start`で登録する。
  `--print-config`の出力は端末ごとの絶対パスを含む。
  貼る先がgitignore済みのローカルの設定やユーザーの設定になりやすく、レビューを通らない。
  保護パスのレビューが効くのは、`.claude/settings.json`とfrontmatterに登録するときだけである。
  ローカルとユーザーの設定には、登録しない。
  取り込みのたびに戻らないよう、`tests/scripts/claude-config.test.ts`が次の2つを確かめる。
  スキルとsubagentのfrontmatterに`allowed-tools`と`hooks`が無いこと。
  `.claude/settings.json`に`yomiyasu`が無いこと。
