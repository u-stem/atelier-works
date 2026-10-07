import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ホストのgitleaks(`[tools]`、pre-commitフックが使う)と、
// workerイメージのgitleaks(`[env]`の`GITLEAKS_VERSION`、Dockerfileのビルド引数)は
// 同じバージョンでなければならない。
// 違うと、implementフローの固定の検査とローカルのフックで、
// 漏洩の判定が食い違いうる。
describe("mise.toml", () => {
  test("pins the same gitleaks version in [tools] and [env]", () => {
    const text = readFileSync(join(import.meta.dir, "../../mise.toml"), "utf8");
    const toolsSection =
      text.match(/^\[tools\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? "";
    const envSection = text.match(/^\[env\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? "";
    const toolsVersion = toolsSection.match(/^gitleaks = "([^"]+)"$/m)?.[1];
    const envVersion = envSection.match(/^GITLEAKS_VERSION = "([^"]+)"$/m)?.[1];
    // バージョンの形式を照合するので、両方の項目が無い(どちらもundefined)場合も
    // 等しいとはみなさず失敗する。
    expect([toolsVersion, envVersion]).toEqual([
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
      toolsVersion,
    ]);
  });
});
