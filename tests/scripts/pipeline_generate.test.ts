import { describe, expect, test } from "bun:test";
import {
  filterValidDiagrams,
  isDiagram,
  isRequirementsOutput,
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

const VALID_XML =
  '<mxfile host="app.diagrams.net"><diagram name="d" id="d1"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';

describe("isDiagram", () => {
  test("accepts an object with string name and drawio_xml", () => {
    expect(isDiagram({ name: "d", drawio_xml: VALID_XML })).toBe(true);
  });

  test("rejects a non-object value", () => {
    expect(isDiagram("not an object")).toBe(false);
  });

  test("rejects an object missing drawio_xml", () => {
    expect(isDiagram({ name: "d" })).toBe(false);
  });
});

describe("isRequirementsOutput", () => {
  const valid = {
    summary: "s",
    markdown: "m",
    diagrams: [{ name: "d", drawio_xml: VALID_XML }],
    open_questions: ["q1"],
  };

  test("accepts a fully-shaped requirements output", () => {
    expect(isRequirementsOutput(valid)).toBe(true);
  });

  test("accepts an empty diagrams array", () => {
    expect(isRequirementsOutput({ ...valid, diagrams: [] })).toBe(true);
  });

  test("rejects a missing summary field", () => {
    const { summary: _summary, ...withoutSummary } = valid;
    expect(isRequirementsOutput(withoutSummary)).toBe(false);
  });

  test("rejects open_questions containing a non-string", () => {
    expect(isRequirementsOutput({ ...valid, open_questions: [1] })).toBe(false);
  });

  test("rejects diagrams containing a malformed entry", () => {
    expect(isRequirementsOutput({ ...valid, diagrams: [{ name: "d" }] })).toBe(
      false,
    );
  });
});

describe("filterValidDiagrams", () => {
  test("keeps a diagram with valid XML", () => {
    const result = filterValidDiagrams([{ name: "d", drawio_xml: VALID_XML }]);
    expect(result).toEqual([{ name: "d", drawio_xml: VALID_XML }]);
  });

  test("drops a diagram with invalid XML", () => {
    const result = filterValidDiagrams([
      { name: "bad", drawio_xml: "<not-mxfile/>" },
    ]);
    expect(result).toEqual([]);
  });

  test("calls onInvalid once per dropped diagram", () => {
    const dropped: string[] = [];
    filterValidDiagrams(
      [
        { name: "bad", drawio_xml: "<not-mxfile/>" },
        { name: "d", drawio_xml: VALID_XML },
      ],
      (diagram) => dropped.push(diagram.name),
    );
    expect(dropped).toEqual(["bad"]);
  });
});
