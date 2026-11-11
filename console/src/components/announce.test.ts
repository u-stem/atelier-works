import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExternalToast } from "sonner";
import type { ReleaseNotice } from "../lib/writeNotices.ts";
import {
  type AnnounceOptions,
  announceStaleListWith,
  announceWith,
  type Toaster,
} from "./announce.ts";

type Call = {
  readonly tone: ReleaseNotice["tone"];
  readonly message: string;
  readonly data: ExternalToast | undefined;
};

/** 知らせを出して、トーストの呼び出しを記録する。 */
function announced(notice: ReleaseNotice, options?: AnnounceOptions): Call[] {
  const calls: Call[] = [];
  const toaster: Toaster = {
    success: (message, data) => calls.push({ tone: "success", message, data }),
    info: (message, data) => calls.push({ tone: "info", message, data }),
    warning: (message, data) => calls.push({ tone: "warning", message, data }),
    error: (message, data) => calls.push({ tone: "error", message, data }),
  };
  announceWith(toaster, notice, options);
  return calls;
}

const NOT_SUCCESS = ["info", "warning", "error"] as const;

describe("announceWith", () => {
  test.each(["success", ...NOT_SUCCESS] as const)(
    "shows a %s notice as a toast of the same tone",
    (tone) => {
      expect(announced({ tone, message: "m" })).toMatchObject([
        { tone, message: "m" },
      ]);
    },
  );

  test("lets a success close by itself", () => {
    expect(
      announced({ tone: "success", message: "m" })[0]?.data?.duration,
    ).toBeUndefined();
  });

  test.each(NOT_SUCCESS)("keeps a %s notice until it is closed", (tone) => {
    expect(announced({ tone, message: "m" })[0]?.data?.duration).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test.each(NOT_SUCCESS)(
    "lets a transient %s notice close by itself",
    (tone) => {
      expect(
        announced({ tone, message: "m" }, { transient: true })[0]?.data
          ?.duration,
      ).toBeUndefined();
    },
  );

  test("adds the description under the message", () => {
    expect(
      announced(
        { tone: "warning", message: "m" },
        { description: "作業項目 #7" },
      )[0]?.data?.description,
    ).toBe("作業項目 #7");
  });

  test("puts the next step under the message", () => {
    expect(
      announced({ tone: "info", message: "m", nextStep: "n" })[0]?.data
        ?.description,
    ).toBe("n");
  });

  test("puts the next step after the description", () => {
    expect(
      announced(
        { tone: "info", message: "m", nextStep: "n" },
        { description: "作業項目 #7" },
      )[0]?.data?.description,
    ).toBe("作業項目 #7 n");
  });
});

describe("announceStaleListWith", () => {
  test("lets the stale list warning close by itself", () => {
    const calls: Call[] = [];
    const record =
      (tone: ReleaseNotice["tone"]) =>
      (message: string, data?: ExternalToast) =>
        calls.push({ tone, message, data });
    announceStaleListWith({
      success: record("success"),
      info: record("info"),
      warning: record("warning"),
      error: record("error"),
    });
    expect(
      calls.map((call) => [call.tone, call.data?.duration ?? null]),
    ).toEqual([["warning", null]]);
  });
});

const SRC = resolve(import.meta.dir, "..");

/** `src`の下で、`sonner`を直に読み込むファイル。テストは除く。 */
function filesImportingSonner(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path))
    .filter((path) =>
      /(from\s+|import\s*\(\s*)["']sonner["']/.test(
        readFileSync(join(SRC, path), "utf8"),
      ),
    )
    .sort();
}

// 書き込みの結果のトーストは`announce`から出す。直にトーストを出してよいのは、次のファイルだけである。
// 置き場の部品、版の複製の知らせ、確認が消えたことの知らせ。
const ALLOWED_SONNER_IMPORTERS = [
  "components/announce.ts",
  "components/ui/sonner.tsx",
  "screens/inbox/FailureOverview.tsx",
  "screens/inbox/NoticeMessageText.tsx",
];

describe("the toasts of the writes", () => {
  test("only the listed files call sonner directly", () => {
    expect(filesImportingSonner()).toEqual(ALLOWED_SONNER_IMPORTERS);
  });
});
