# 取り込み元

- リポジトリ: https://github.com/nanaism/yomiyasu
- バージョン: 2.5.0
- コミット: 29d67ccb05e370b5958d72920a9cd1aa829dee80(2026-11-04取得)
- ライセンス: MIT(`LICENSE`)。Unicodeデータ由来の部分は`UNICODE-LICENSE.txt`。
- 取り込んだもの: `skills/yomiyasu/`のうち`SKILL.md`、`references/`、`scripts/`、ライセンス2件。プラグイン設定(`.codex-plugin/`)と画像(`assets/`)は除いた。
- ローカルの変更: `SKILL.md`のfrontmatterから`allowed-tools`の行を消した。この行は、引数を絞らずにスクリプトの実行を確認なしで許し、任意のファイルの読み取りと任意の場所への書き込みを確認なしにできるためである。更新するときは取り込み元の同じパスで置き換えた後に、同じ行をもう一度消し、このファイルのコミットを書き換える。
- フックの扱い: `scripts/yomiyasu_hook.py`は取り込み元のまま同梱し、Claude Codeのフックとして登録しない。
  `--print-config`の出力をsettingsへ貼ると、保護パスの`.claude/settings.json`の変更になるためである。
  登録するときは、保護パスの変更として別にレビューする。
  更新するときは、settingsにこのフックが無いことを確かめる。
