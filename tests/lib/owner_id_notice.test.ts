// owner_idの照合のnoticeの種類と本文が、`owner_id_notice.ts`にあり、
// `poll_support.ts`が同じものを再エクスポートすることを確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as notice from "../../f/factory/lib/owner_id_notice.ts";
import * as pollSupport from "../../f/factory/lib/poll_support.ts";

describe("owner_id_notice", () => {
  test("names the mismatch notice kind", () => {
    expect(notice.OWNER_ID_MISMATCH_KIND).toBe("owner_id_mismatch");
  });

  test("names the owner, the expected id, and the actual id in the mismatch message", () => {
    expect(notice.ownerIdMismatchMessage("octo-owner", 4242, 9999)).toMatch(
      /^octo-owner:.*9999.*4242/,
    );
  });

  test("names the owner and the expected id in the not found message", () => {
    expect(notice.ownerNotFoundMessage("octo-owner", 4242)).toMatch(
      /^octo-owner:.*4242/,
    );
  });

  test("imports nothing but types.ts", () => {
    const source = readFileSync(
      new URL("../../f/factory/lib/owner_id_notice.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(imports.filter((path) => path !== "./types.ts")).toEqual([]);
  });
});

describe("poll_support re-exports", () => {
  test("re-exports the notice kind unchanged", () => {
    expect(pollSupport.OWNER_ID_MISMATCH_KIND).toBe(
      notice.OWNER_ID_MISMATCH_KIND,
    );
  });

  test("re-exports the mismatch message builder as the same function", () => {
    expect(pollSupport.ownerIdMismatchMessage).toBe(
      notice.ownerIdMismatchMessage,
    );
  });

  test("re-exports the not found message builder as the same function", () => {
    expect(pollSupport.ownerNotFoundMessage).toBe(notice.ownerNotFoundMessage);
  });
});
