import { describe, expect, test } from "bun:test";
import { matchRoutes } from "react-router";
import { ROUTES } from "./router.tsx";

function matchedPaths(pathname: string): string[] {
  return (matchRoutes(ROUTES, pathname, "/console") ?? []).map(
    (match) => match.route.path ?? "(index)",
  );
}

describe("ROUTES under the /console base", () => {
  test("matches the inbox at the root", () => {
    expect(matchRoutes(ROUTES, "/console/", "/console")).not.toBeNull();
  });

  test.each([
    "/console/items",
    "/console/reports",
    "/console/system",
    "/console/items/12/requirements",
    "/console/reports/audit/5",
  ])("matches %s", (pathname) => {
    expect(matchRoutes(ROUTES, pathname, "/console")).not.toBeNull();
  });

  test("passes the work item id to the requirements route", () => {
    expect(
      matchRoutes(ROUTES, "/console/items/12/requirements", "/console")?.at(-1)
        ?.params.id,
    ).toBe("12");
  });

  test("passes the audit id to the audit route", () => {
    expect(
      matchRoutes(ROUTES, "/console/reports/audit/5", "/console")?.at(-1)
        ?.params.id,
    ).toBe("5");
  });

  test("sends an unknown path to the not found screen", () => {
    expect(matchedPaths("/console/nope")).toContain("*");
  });

  test("does not match outside the base", () => {
    expect(matchRoutes(ROUTES, "/other/items", "/console")).toBeNull();
  });
});
