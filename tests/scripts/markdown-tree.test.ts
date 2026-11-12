import { describe, expect, test } from "bun:test";
import type { ListItem, Nodes } from "mdast";
import {
  createTreeReader,
  parseMarkdown,
  visit,
} from "../../scripts/markdown-tree.ts";

function nodesOf(markdown: string): Nodes[] {
  const nodes: Nodes[] = [];
  visit(parseMarkdown(markdown), (node) => {
    nodes.push(node);
  });
  return nodes;
}

function typesOf(markdown: string): string[] {
  return nodesOf(markdown).map((node) => node.type);
}

describe("parseMarkdown", () => {
  test("reads a GFM table", () => {
    expect(typesOf("| a |\n| - |\n| b |\n")).toContain("table");
  });

  test("reads a task list item", () => {
    const items = nodesOf("- [x] a\n").filter(
      (node): node is ListItem => node.type === "listItem",
    );

    expect(items.map((item) => item.checked)).toEqual([true]);
  });

  test("reads the frontmatter as one node", () => {
    expect(typesOf("---\na: 1\n---\n\nB\n")).toContain("yaml");
  });
});

describe("visit", () => {
  test("calls the callback for a node before its children", () => {
    expect(typesOf("# a\n\nb\n")).toEqual([
      "root",
      "heading",
      "text",
      "paragraph",
      "text",
    ]);
  });
});

describe("createTreeReader", () => {
  test("parses a document once and returns the same tree on the next read", () => {
    const read = createTreeReader(() => "# a\n");
    expect(read("a.md")).toBe(read("a.md"));
  });

  test("reads a document only once", () => {
    let reads = 0;
    const read = createTreeReader(() => {
      reads++;
      return "# a\n";
    });
    read("a.md");
    read("a.md");
    expect(reads).toBe(1);
  });

  test("returns undefined for a document that cannot be read", () => {
    expect(createTreeReader(() => undefined)("a.md")).toBeUndefined();
  });
});
