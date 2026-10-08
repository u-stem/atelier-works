## 概要

<!-- このPRで何をしたか、なぜ必要かを簡潔に書く -->

## 受入条件

<!-- Issueの受入基準をチェックリストで -->

## 動作確認結果

- [ ] lint (`mise run lint`)
- [ ] typecheck (`mise run typecheck`)
- [ ] test (`mise run test`)
- [ ] E2E(該当する場合)

## 確認して欲しい点

<!-- 実装上のトレードオフや不確実な部分など -->

## 関連リンク

Closes #

## 備考

### Windmillへの反映

<!-- 当てはまるものにチェックを付ける -->

- [ ] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)
- [ ] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)
- [ ] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)
- [ ] 反映するものは無い
