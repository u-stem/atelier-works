import { describe, expect, test } from "bun:test";

// `self_update.ts`への`factory_repo_id`の照合の組み込みを、ソースの文字列照合で固定する。
// 構文は解析しないので、呼び出しを別の形に書き換えると、実装が正しくても落ちることがある。
// そのときは照合を直す。目的は、照合を取得より後ろへ動かしたり、
// 照合に落ちた回が取得や反映へ進んだりする変更に気づくことである。

/** コメントを除いた`self_update.ts`のソース。 */
async function selfUpdateSource(): Promise<string> {
  const text = await Bun.file("f/factory/self_update.ts").text();
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

describe("self_update factory repo id wiring", () => {
  test("prepares the self clone through the verified path with the configuration", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(/await ensureVerifiedFactoryClone\(\s*config,/);
  });

  test("does not call the unverified clone function", async () => {
    const source = await selfUpdateSource();

    expect(source).not.toMatch(/\bensureFactoryClone\(/);
  });

  test("rethrows every error that is not a repository id mismatch", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /catch \(err\) \{\s*if \(!\(err instanceof FactoryRepoIdMismatchError\)\) \{\s*throw err;\s*\}/,
    );
  });

  test("records the failure and skips the update on a mismatch", async () => {
    const source = await selfUpdateSource();

    expect(source).toMatch(
      /throw err;\s*\}\s*await recordGateFailure\([\s\S]*?return \{ outcome: "skipped"[^}]*\};\s*\}\s*\/?[\s\S]*?readSelfCloneBranch\(/,
    );
  });
});
