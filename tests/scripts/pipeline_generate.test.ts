import { describe, expect, test } from "bun:test";
import {
  buildGenerateFailureMessage,
  classifyDocDirEntries,
  diagramNameFromFile,
  isRequirementsOutput,
  listDiagramFiles,
  readDocFile,
  resolveFeedback,
  type SnapshotIo,
  snapshotDocDir,
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

describe("snapshotDocDir", () => {
  const HASH = "f".repeat(64);

  /** 呼び出しの順を控える偽の依存。`hashes`は呼び出しごとに順に返す。 */
  function io(hashes: (string | null)[], entries: string[] = []) {
    const events: string[] = [];
    let hashCall = 0;
    const deps: SnapshotIo = {
      hashTree: async () => {
        events.push("hash");
        const value = hashes[hashCall];
        hashCall += 1;
        return value === undefined ? null : value;
      },
      readDir: async () => {
        events.push("readDir");
        return entries;
      },
      readText: async () => {
        events.push("readText");
        return "# body";
      },
      inspect: async () => {
        events.push("inspect");
      },
    };
    return { deps, events };
  }

  test("hashes, inspects, reads the markdown and the diagram list, then hashes again", async () => {
    const h = io([HASH, HASH], ["requirements.md", "flow.drawio"]);
    await snapshotDocDir("/doc", h.deps);
    expect(h.events).toEqual([
      "hash",
      "inspect",
      "readDir",
      "readText",
      "hash",
    ]);
  });

  test("does not inspect a directory that does not exist", async () => {
    const h = io([null, null]);
    await snapshotDocDir("/doc", h.deps).catch(() => undefined);
    expect(h.events).toEqual(["hash"]);
  });

  test("lets the failure of the inspection through as it is", async () => {
    const h = io([HASH, HASH]);
    const deps: SnapshotIo = {
      ...h.deps,
      inspect: async () => {
        throw new Error("invalid diagram");
      },
    };
    await expect(snapshotDocDir("/doc", deps)).rejects.toThrow(
      "invalid diagram",
    );
  });

  test("does not read the markdown after an inspection that fails", async () => {
    const h = io([HASH, HASH]);
    const deps: SnapshotIo = {
      ...h.deps,
      inspect: async () => {
        h.events.push("inspect");
        throw new Error("invalid diagram");
      },
    };
    await snapshotDocDir("/doc", deps).catch(() => undefined);
    expect(h.events).toEqual(["hash", "inspect"]);
  });

  test("fails when an entry other than the markdown and the diagrams appeared after the cleanup", async () => {
    const h = io([HASH, HASH], ["requirements.md", "flow.drawio", "notes.txt"]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow(
      "pipeline_generate: doc snapshot failed (unexpected_entry)",
    );
  });

  test("names the unexpected entry", async () => {
    const h = io([HASH, HASH], ["requirements.md", "notes.txt"]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow("notes.txt");
  });

  test("accepts a directory of only the markdown and diagrams", async () => {
    const h = io([HASH, HASH], ["requirements.md", "a.drawio", "b.drawio"]);
    expect((await snapshotDocDir("/doc", h.deps)).docHash).toBe(HASH);
  });

  test("returns the hash as the baseline", async () => {
    const h = io([HASH, HASH]);
    expect((await snapshotDocDir("/doc", h.deps)).docHash).toBe(HASH);
  });

  test("returns the markdown that was read between the two hashes", async () => {
    const h = io([HASH, HASH]);
    expect((await snapshotDocDir("/doc", h.deps)).markdown).toBe("# body");
  });

  test("returns the diagram files of the listing", async () => {
    const h = io([HASH, HASH], ["requirements.md", "a.drawio", "b.drawio"]);
    expect((await snapshotDocDir("/doc", h.deps)).diagramFiles).toEqual([
      "a.drawio",
      "b.drawio",
    ]);
  });

  test("fails when the directory changed while it was read", async () => {
    const h = io([HASH, "0".repeat(64)]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow(
      "changed while it was being saved",
    );
  });

  test("fails when the directory does not exist before the read", async () => {
    const h = io([null, null]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow(
      "no baseline hash",
    );
  });

  test("fails when the directory disappears during the read", async () => {
    const h = io([HASH, null]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow(
      "changed while it was being saved",
    );
  });

  test("reports a missing baseline as a snapshot failure", async () => {
    const h = io([null, null]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow(
      "pipeline_generate: doc snapshot failed (doc_hash_unavailable)",
    );
  });

  test("reports a change during the read as a snapshot failure", async () => {
    const h = io([HASH, "0".repeat(64)]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.toThrow(
      "pipeline_generate: doc snapshot failed (doc_changed_during_save)",
    );
  });

  test("reports a hash that throws before the read as a snapshot failure", async () => {
    const h = io([HASH, HASH]);
    const deps: SnapshotIo = {
      ...h.deps,
      hashTree: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    await expect(snapshotDocDir("/doc", deps)).rejects.toThrow(
      "pipeline_generate: doc snapshot failed (doc_hash_failed): EACCES: permission denied",
    );
  });

  test("reports a hash that throws after the read as a snapshot failure", async () => {
    const h = io([HASH, HASH]);
    let call = 0;
    const deps: SnapshotIo = {
      ...h.deps,
      hashTree: async () => {
        call += 1;
        if (call === 2) throw new Error("ENOENT: entry vanished");
        return HASH;
      },
    };
    await expect(snapshotDocDir("/doc", deps)).rejects.toThrow(
      "pipeline_generate: doc snapshot failed (doc_hash_failed): ENOENT: entry vanished",
    );
  });

  test("reports a listing that throws as a snapshot failure", async () => {
    const h = io([HASH, HASH]);
    const deps: SnapshotIo = {
      ...h.deps,
      readDir: async () => {
        throw new Error("EIO: i/o error");
      },
    };
    await expect(snapshotDocDir("/doc", deps)).rejects.toThrow(
      "pipeline_generate: doc snapshot failed (doc_list_failed): EIO: i/o error",
    );
  });

  test("does not report a snapshot failure as a failed Claude run", async () => {
    const h = io([null, null]);
    await expect(snapshotDocDir("/doc", h.deps)).rejects.not.toThrow(
      "runClaude failed",
    );
  });
});

// mainはWindmillとDBを直接使うので、基準値の受け渡しはソースの文面で固定する。
describe("the wiring of pipeline_generate main", () => {
  async function stepSource(): Promise<string> {
    return Bun.file(
      new URL("../../f/factory/steps/pipeline_generate.ts", import.meta.url),
    ).text();
  }

  test("saves the draft with the baseline hash of the snapshot", async () => {
    expect(await stepSource()).toMatch(
      /await saveDraft\(\{[^}]*doc_hash: snapshot\.docHash,?\s*\}\)/,
    );
  });

  test("inspects the diagrams inside the window of the snapshot", async () => {
    expect(await stepSource()).toMatch(
      /snapshotDocDir\(docDir, \{[\s\S]*inspect: async \(\) => \{[\s\S]*collectDocIssues\(docDir\)[\s\S]*\},\s*\}\)/,
    );
  });

  test("does not inspect the diagrams before the snapshot", async () => {
    const text = await stepSource();
    const beforeSnapshot = text.slice(0, text.indexOf("await snapshotDocDir("));
    expect(beforeSnapshot).not.toMatch(
      /const issues = await collectDocIssues\(docDir\);/,
    );
  });

  test("saves the markdown of the same snapshot", async () => {
    expect(await stepSource()).toMatch(
      /await saveDraft\(\{[^}]*markdown: snapshot\.markdown,/,
    );
  });
});
