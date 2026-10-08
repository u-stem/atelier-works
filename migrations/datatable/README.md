# Data Tableのmigration

FactoryのData Tableのmigrationを置くディレクトリである。migrationを追加する人が読む。

`main/`の下のmigrationは、`wmill datatable migrate new`、`up`、`down`で管理する。適用先は、ワークスペースの既定のData Table(インスタンスのDB)にある`factory`スキーマである。

## 追加だけで変更する

一度出荷したmigrationの`.up.sql`と`.down.sql`は書き換えない。後のmigrationでも、古い形に依存するコードを壊す列やテーブルの名前変更や削除はしない。変更が要るときは、新しい列、テーブル、viewを足すmigrationを追加する。

この決まりで、どのmigrationまで適用済みのインスタンスでも、`wmill datatable migrate up`を安全に実行し直せる。
