import { describe, expect, test } from "bun:test";
import { decidePrepareEntry } from "../../f/factory/steps/audit_prepare.ts";

describe("decidePrepareEntry", () => {
  test("starts from picked", () => {
    expect(decidePrepareEntry("picked")).toBe("start");
  });

  test("resumes from auditing (step retry)", () => {
    expect(decidePrepareEntry("auditing")).toBe("resume");
  });

  test("skips a terminal status", () => {
    expect(decidePrepareEntry("failed")).toBe("skip");
  });
});
