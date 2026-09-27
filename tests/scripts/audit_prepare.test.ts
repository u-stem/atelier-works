import { describe, expect, test } from "bun:test";
import {
  decideAfterFailedStart,
  decidePrepareEntry,
} from "../../f/factory/steps/audit_prepare.ts";

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

describe("decideAfterFailedStart", () => {
  test("resumes when a concurrent run already moved the item to auditing", () => {
    expect(decideAfterFailedStart("auditing")).toBe("resume");
  });

  test("skips when the item moved to a different status", () => {
    expect(decideAfterFailedStart("cancelled")).toBe("skip");
  });
});
