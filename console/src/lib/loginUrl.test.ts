import { describe, expect, test } from "bun:test";
import { buildLoginUrl } from "./loginUrl.ts";

function rdOf(url: string): string | null {
  return new URL(url, "https://factory.example").searchParams.get("rd");
}

describe("buildLoginUrl", () => {
  test("points at the Windmill login page", () => {
    expect(
      new URL(
        buildLoginUrl({ pathname: "/console/", search: "", hash: "" }),
        "https://factory.example",
      ).pathname,
    ).toBe("/user/login");
  });

  test("returns to the current path", () => {
    expect(
      rdOf(
        buildLoginUrl({ pathname: "/console/items/3", search: "", hash: "" }),
      ),
    ).toBe("/console/items/3");
  });

  test("keeps the query and the hash", () => {
    expect(
      rdOf(
        buildLoginUrl({
          pathname: "/console/",
          search: "?approval=7&x=a b",
          hash: "#h-1",
        }),
      ),
    ).toBe("/console/?approval=7&x=a b#h-1");
  });

  test("encodes the return path as one query value", () => {
    expect(
      new URL(
        buildLoginUrl({
          pathname: "/console/",
          search: "?a=1&rd=evil",
          hash: "",
        }),
        "https://factory.example",
      ).searchParams.getAll("rd"),
    ).toEqual(["/console/?a=1&rd=evil"]);
  });

  test("falls back to the console root outside the console", () => {
    expect(
      rdOf(buildLoginUrl({ pathname: "/apps/get/x", search: "", hash: "" })),
    ).toBe("/console/");
  });

  test("falls back to the console root for a look-alike prefix", () => {
    expect(
      rdOf(buildLoginUrl({ pathname: "/console-evil/", search: "", hash: "" })),
    ).toBe("/console/");
  });

  test("falls back to the console root for a protocol-relative path", () => {
    expect(
      rdOf(
        buildLoginUrl({ pathname: "//evil.example/", search: "", hash: "" }),
      ),
    ).toBe("/console/");
  });

  test("falls back to the console root for a dot-dot segment", () => {
    expect(
      rdOf(
        buildLoginUrl({
          pathname: "/console/../user/x",
          search: "",
          hash: "",
        }),
      ),
    ).toBe("/console/");
  });

  test("falls back to the console root for a backslash", () => {
    expect(
      rdOf(
        buildLoginUrl({ pathname: "/console/\\evil", search: "", hash: "" }),
      ),
    ).toBe("/console/");
  });
});
