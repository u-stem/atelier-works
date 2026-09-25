# コーディング規約

## 言語

- ドキュメント(`docs/**`、`README.md` 等)は日本語で書く。
- コード・コメント・識別子は英語で統一する(日本語コメントとの混在はしない)。
- コミットメッセージは Conventional Commits の type + 日本語の説明: `<type>: <日本語説明>`(`type` は `feat` / `fix` / `docs` / `refactor` / `test` / `chore`)。

## TypeScript

- `tsconfig.json` は `strict: true` を必須とする。
- 型アサーション `as`(`<T>expr` 形式含む)は禁止する。例外は次の 2 つのみ:
  - `as const`
  - 型ガード関数の内部での絞り込み
- `any` は使わない(biome の `noExplicitAny` で強制する)。
- 外部由来の値(HTTP レスポンス、`JSON.parse` の結果、サブプロセスの stdout など)は**parse, don't validate** の原則で扱う。「型があるかのように決め打ちしてアクセスする」のではなく、型ガード関数でパースしてから使う。

```ts
// 悪い例: 決め打ちでアクセスする(as で黙らせている)
const data = JSON.parse(stdout) as { summary: string };

// 良い例: 型ガードでパースしてから使う
type ClaudeResult = { summary: string; markdown: string };

function isClaudeResult(value: unknown): value is ClaudeResult {
  if (typeof value !== "object" || value === null) return false;
  if (!("summary" in value) || !("markdown" in value)) return false;
  return true;
}

const parsed: unknown = JSON.parse(stdout);
if (!isClaudeResult(parsed)) {
  throw new Error("unexpected claude output shape");
}
// ここから先は parsed が ClaudeResult として扱える
```

型ガード関数の内部でオブジェクトの形を確認するために絞り込む箇所は許容されるが、`lint-no-type-assertions` のチェック対象になる。判定ロジック自体は `typeof` / `in` / 配列チェックなどで組み立てる。

## TDD

- 新機能はテストから、バグ修正は再現テストから、リファクタはテストが緑の状態から始める(Red → Green → Refactor)。
- 1 テストにつきアサーションは 1 つ。Arrange-Act-Assert の構成にする。
- 外部プロセス起動や `fetch` は引数として注入し、テストではダミー実装に差し替える(実プロセス・実 HTTP を叩くテストは書かない)。

## テストの分類

本リポジトリ自身のテストは Google のテストサイズ分類(small / medium / large)で分ける。

- **small**: 外部依存(DB・ネットワーク・コンテナ)を使わない単体テスト。`bun test`(`mise run test`)。`f/factory/lib/**` の大半はここに属し、外部プロセス起動や `fetch` は注入したダミー実装に差し替える。
- **medium**: compose の Postgres を使う SQL スモークテストなど、単一マシン内のローカルな依存(DB・コンテナ)を使うテスト。`mise run test:db`(M3 で追加)。
- **large**: 実際の Issue 起票から確認する E2E。`factory-dev` スキルおよび `mise run doctor` → `up` → `bootstrap` 後の手順に従う。

## Windmill script の作法

- Windmill 固有の配置・secret 取得・config 取得・native 不使用などの規約は `windmill-script` スキル(`.claude/skills/windmill-script/SKILL.md`)を参照する。

## 検証コマンド

- `mise run check` で `lint`(`biome check` + `wmill lint f` + 型アサーション検出)→ `typecheck`(`tsc --noEmit`)→ `test`(`bun test`)を順に実行する。PR を出す前に必ず緑にする。

## PR チェックリスト

- [ ] `mise run check` が緑
- [ ] 対象範囲外のファイルを「ついで」で変更していない
- [ ] シークレット・個人情報をコミットしていない
- [ ] コード変更に伴う docs / スキルの更新を同じ PR に含めている
- [ ] Windmill への反映(`sync push` / migration / worker image 再ビルド)が必要か明記している
