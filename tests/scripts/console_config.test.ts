import { describe, expect, test } from "bun:test";
import {
  CONFIG_RESOURCE_PATH,
  type ConfigPorts,
  loadConfigView,
} from "../../f/factory/console_config.ts";

const GH_TOKEN = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyzAB"}`;

function portsOf(config: unknown): ConfigPorts {
  return { getConfig: async () => config };
}

describe("loadConfigView", () => {
  test("reads the factory config resource", () => {
    expect(CONFIG_RESOURCE_PATH).toBe("f/factory/factory_config");
  });

  test("returns every key, sorted by name", async () => {
    const view = await loadConfigView(portsOf({ b: 1, a: "x", c: [1, 2] }));
    expect(view.items.map((item) => item.key)).toEqual(["a", "b", "c"]);
  });

  test("returns a plain value as it is", async () => {
    const view = await loadConfigView(portsOf({ max_attempts: 3 }));
    expect(view.items).toEqual([
      { key: "max_attempts", kind: "value", value: 3, masked: false },
    ]);
  });

  test("returns an array and an object as they are", async () => {
    const config = { owners: ["octo"], check_commands_by_repo: { r: ["a"] } };
    const view = await loadConfigView(portsOf(config));
    expect(
      view.items.map((item) => item.kind === "value" && item.value),
    ).toEqual([{ r: ["a"] }, ["octo"]]);
  });

  test("reports the path of the resource", async () => {
    expect((await loadConfigView(portsOf({}))).path).toBe(
      "f/factory/factory_config",
    );
  });

  test("returns a value that holds a variable reference as a reference", async () => {
    const view = await loadConfigView(portsOf({ hook: "$var:f/factory/x" }));
    expect(view.items).toEqual([{ key: "hook", kind: "reference" }]);
  });

  test("returns a value that holds a resource reference as a reference", async () => {
    const view = await loadConfigView(portsOf({ db: "$res:f/factory/db" }));
    expect(view.items).toEqual([{ key: "db", kind: "reference" }]);
  });

  test("finds a reference inside a nested value", async () => {
    const view = await loadConfigView(
      portsOf({ nested: { list: ["ok", "prefix $var:f/x suffix"] } }),
    );
    expect(view.items).toEqual([{ key: "nested", kind: "reference" }]);
  });

  test("does not put the referenced path into the response", async () => {
    const view = await loadConfigView(portsOf({ hook: "$var:f/factory/x" }));
    expect(JSON.stringify(view)).not.toContain("f/factory/x");
  });

  test("masks a token in a plain value", async () => {
    const view = await loadConfigView(portsOf({ note: `x ${GH_TOKEN}` }));
    expect(view.items).toEqual([
      { key: "note", kind: "value", value: "x ***", masked: true },
    ]);
  });

  test("replaces the value under a key that names a secret", async () => {
    const view = await loadConfigView(portsOf({ api_token: "short" }));
    expect(view.items).toEqual([
      { key: "api_token", kind: "value", value: "***", masked: true },
    ]);
  });

  test("throws when the resource is not an object", async () => {
    await expect(loadConfigView(portsOf("text"))).rejects.toThrow();
  });

  test("throws when the resource is an array", async () => {
    await expect(loadConfigView(portsOf([1]))).rejects.toThrow();
  });
});

describe("loadConfigView design_stage", () => {
  const SINCE = "2026-11-01T00:00:00Z";

  test("reports a stage that is not requested as closed and not ignored", async () => {
    const view = await loadConfigView(portsOf({ max_attempts: 3 }));
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: false,
    });
  });

  test("reports a requested stage with a since as open", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: true, design_enabled_since: SINCE }),
    );
    expect(view.design_stage).toEqual({
      enabled: true,
      ignored: false,
      indeterminate: false,
    });
  });

  test("reports a requested stage without a since as closed and ignored", async () => {
    const view = await loadConfigView(portsOf({ design_enabled: true }));
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: true,
      indeterminate: false,
    });
  });

  test("reports a requested stage with a null since as closed and ignored", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: true, design_enabled_since: null }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: true,
      indeterminate: false,
    });
  });

  test("reports a requested stage with an unreadable since as closed and ignored", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: true, design_enabled_since: "2026-11-01" }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: true,
      indeterminate: false,
    });
  });

  test("reports a since without the request as closed and not ignored", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: false, design_enabled_since: SINCE }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: false,
    });
  });

  test("reports a request that is not a boolean as not requested", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: "true", design_enabled_since: SINCE }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: false,
    });
  });

  test("reports a request that holds a variable reference as indeterminate", async () => {
    const view = await loadConfigView(
      portsOf({
        design_enabled: "$var:f/factory/x",
        design_enabled_since: SINCE,
      }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: true,
    });
  });

  test("reports a request that holds a resource reference as indeterminate", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: "$res:f/factory/x" }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: true,
    });
  });

  test("reports a since that holds a reference as indeterminate", async () => {
    const view = await loadConfigView(
      portsOf({
        design_enabled: true,
        design_enabled_since: "$var:f/factory/since",
      }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: true,
    });
  });

  test("reports a since that holds a reference as indeterminate even when the request is false", async () => {
    const view = await loadConfigView(
      portsOf({
        design_enabled: false,
        design_enabled_since: "$var:f/factory/since",
      }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: true,
    });
  });

  test("reports a reference inside a nested value as indeterminate", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: { value: "$var:f/factory/x" } }),
    );
    expect(view.design_stage).toEqual({
      enabled: false,
      ignored: false,
      indeterminate: true,
    });
  });

  test("does not report a reference in an unrelated item as indeterminate", async () => {
    const view = await loadConfigView(
      portsOf({
        hook: "$var:f/factory/x",
        design_enabled: true,
        design_enabled_since: SINCE,
      }),
    );
    expect(view.design_stage).toEqual({
      enabled: true,
      ignored: false,
      indeterminate: false,
    });
  });

  test("does not put the referenced path into the design stage", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: "$var:f/factory/secret_path" }),
    );
    expect(JSON.stringify(view.design_stage)).not.toContain("secret_path");
  });

  test("keeps the items as the resource has them", async () => {
    const view = await loadConfigView(
      portsOf({ design_enabled: true, design_enabled_since: SINCE }),
    );
    expect(view.items.map((item) => item.key)).toEqual([
      "design_enabled",
      "design_enabled_since",
    ]);
  });
});
