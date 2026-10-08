import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BOOTSTRAP = resolve(import.meta.dir, "../../scripts/bootstrap.sh");

// bootstrap.shは読み込むだけで実行が始まるので、関数の定義だけを取り出して検査する。
function extractFunction(name: string): string {
  const source = readFileSync(BOOTSTRAP, "utf8");
  const match = new RegExp(
    `^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`,
    "m",
  ).exec(source);
  if (match === null) {
    throw new Error(`function not found: ${name}`);
  }
  return match[0];
}

describe("harden_wmill_config_dir", () => {
  let root: string;
  let realConfigDir: string;
  let tokenFile: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bootstrap-harden-")));
    realConfigDir = join(root, "real-config");
    mkdirSync(join(realConfigDir, "windmill"), { recursive: true });
    tokenFile = join(realConfigDir, "windmill", "remotes.ndjson");
    writeFileSync(tokenFile, "dummy\n");
    chmodSync(tokenFile, 0o644);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function harden(configDir: string): void {
    const script = `${extractFunction("harden_wmill_config_dir")}\nharden_wmill_config_dir\n`;
    Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, WMILL_CONFIG_DIR: configDir },
    });
  }

  test("extracts the function up to its closing brace line", () => {
    const text = extractFunction("harden_wmill_config_dir");

    expect(text.endsWith("\n}\n")).toBe(true);
  });

  test("sets the config directory to 700", () => {
    chmodSync(realConfigDir, 0o755);

    harden(realConfigDir);

    expect(statSync(realConfigDir).mode & 0o777).toBe(0o700);
  });

  test("sets the linked config directory to 700 when it is a symlink", () => {
    chmodSync(realConfigDir, 0o755);
    const linked = join(root, "linked-config");
    symlinkSync(realConfigDir, linked);

    harden(linked);

    expect(statSync(realConfigDir).mode & 0o777).toBe(0o700);
  });

  test("sets the token file to 600 in a plain config directory", () => {
    harden(realConfigDir);

    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  test("sets the token file to 600 when the config directory is a symlink", () => {
    const linked = join(root, "linked-config");
    symlinkSync(realConfigDir, linked);

    harden(linked);

    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
});
