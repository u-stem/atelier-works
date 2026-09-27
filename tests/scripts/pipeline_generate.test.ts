import { describe, expect, test } from "bun:test";
import {
  buildGenerateFailureMessage,
  classifyDocDirEntries,
  diagramNameFromFile,
  isRequirementsOutput,
  listDiagramFiles,
  readDocFile,
  resolveFeedback,
} from "../../f/factory/steps/pipeline_generate.ts";

describe("resolveFeedback", () => {
  test("passes through a non-empty string", () => {
    expect(resolveFeedback("missing tests")).toBe("missing tests");
  });

  test("normalizes null to null", () => {
    expect(resolveFeedback(null)).toBeNull();
  });

  test("normalizes undefined to null (callers that never pass feedback)", () => {
    expect(resolveFeedback(undefined)).toBeNull();
  });

  test("normalizes an empty string to null", () => {
    expect(resolveFeedback("")).toBeNull();
  });
});

describe("isRequirementsOutput", () => {
  const valid = {
    summary: "s",
    open_questions: ["q1"],
  };

  test("accepts a fully-shaped requirements output", () => {
    expect(isRequirementsOutput(valid)).toBe(true);
  });

  test("accepts an empty open_questions array", () => {
    expect(isRequirementsOutput({ ...valid, open_questions: [] })).toBe(true);
  });

  test("rejects a missing summary field", () => {
    const { summary: _summary, ...withoutSummary } = valid;
    expect(isRequirementsOutput(withoutSummary)).toBe(false);
  });

  test("rejects open_questions containing a non-string", () => {
    expect(isRequirementsOutput({ ...valid, open_questions: [1] })).toBe(false);
  });

  test("rejects a non-object value", () => {
    expect(isRequirementsOutput("not an object")).toBe(false);
  });
});

describe("listDiagramFiles", () => {
  test("keeps entries ending in .drawio", () => {
    expect(listDiagramFiles(["flow.drawio", "requirements.md"])).toEqual([
      "flow.drawio",
    ]);
  });

  test("returns an empty array when there are no diagram files", () => {
    expect(listDiagramFiles(["requirements.md"])).toEqual([]);
  });

  test("preserves the original order", () => {
    expect(listDiagramFiles(["b.drawio", "a.drawio"])).toEqual([
      "b.drawio",
      "a.drawio",
    ]);
  });
});

describe("classifyDocDirEntries", () => {
  test("puts every .drawio entry into diagramFiles", () => {
    const result = classifyDocDirEntries(["requirements.md", "flow.drawio"]);
    expect(result.diagramFiles).toEqual(["flow.drawio"]);
  });

  test("excludes requirements.md from stray", () => {
    const result = classifyDocDirEntries(["requirements.md", "flow.drawio"]);
    expect(result.stray).toEqual([]);
  });

  test("reports an unexpected file as stray", () => {
    const result = classifyDocDirEntries(["requirements.md", "notes.txt"]);
    expect(result.stray).toEqual(["notes.txt"]);
  });

  test("reports an unexpected subdirectory as stray", () => {
    const result = classifyDocDirEntries(["requirements.md", "scratch"]);
    expect(result.stray).toEqual(["scratch"]);
  });

  test("handles a doc dir with only the template file", () => {
    const result = classifyDocDirEntries(["requirements.md"]);
    expect(result).toEqual({ diagramFiles: [], stray: [] });
  });
});

describe("diagramNameFromFile", () => {
  test("strips the .drawio extension", () => {
    expect(diagramNameFromFile("issue-intake-flow.drawio")).toBe(
      "issue-intake-flow",
    );
  });
});

describe("buildGenerateFailureMessage", () => {
  test("joins every issue with a semicolon", () => {
    expect(buildGenerateFailureMessage(["issue A", "issue B"])).toBe(
      "requirements document failed validation: issue A; issue B",
    );
  });

  test("handles a single issue", () => {
    expect(buildGenerateFailureMessage(["issue A"])).toBe(
      "requirements document failed validation: issue A",
    );
  });
});

describe("readDocFile", () => {
  test("returns the file content", async () => {
    const content = await readDocFile(
      "/doc",
      "requirements.md",
      async () => "# x",
    );
    expect(content).toBe("# x");
  });

  test("wraps a read failure in a Japanese message naming the file", async () => {
    await expect(
      readDocFile("/doc", "requirements.md", async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toThrow(/requirements\.md/);
  });
});
