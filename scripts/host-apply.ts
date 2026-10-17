/**
 * ホストの実行役の入口。`plan`だけを実装する。
 * 引数の`--repo`のリポジトリから、gitのオブジェクトを読み取り、判定をJSONで出力する。
 * 作業ツリーの変更とネットワークは使わない。
 */

export async function main(_argv: readonly string[]): Promise<number> {
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
