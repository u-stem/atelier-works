import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The host's gitleaks ([tools], used by the pre-commit hook) and the worker
// image's gitleaks ([env] GITLEAKS_VERSION, a Dockerfile build arg) must be
// the same version, or the implement flow's fixed check and the local hook
// could disagree on what counts as a leak.
describe("mise.toml", () => {
  test("pins the same gitleaks version in [tools] and [env]", () => {
    const text = readFileSync(join(import.meta.dir, "../../mise.toml"), "utf8");
    const toolsSection =
      text.match(/^\[tools\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? "";
    const envSection = text.match(/^\[env\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? "";
    const toolsVersion = toolsSection.match(/^gitleaks = "([^"]+)"$/m)?.[1];
    const envVersion = envSection.match(/^GITLEAKS_VERSION = "([^"]+)"$/m)?.[1];
    // The version pattern makes a missing entry (undefined on both sides)
    // fail instead of comparing equal.
    expect([toolsVersion, envVersion]).toEqual([
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
      toolsVersion,
    ]);
  });
});
