import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { JobLink, WindmillJobLink } from "./JobLink.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

describe("JobLink", () => {
  test("links to the job detail inside the Console", () => {
    expect(render(<JobLink jobId={ID} label="ジョブを開く" />)).toContain(
      `href="/jobs/${ID}"`,
    );
  });

  test("shows the label", () => {
    expect(render(<JobLink jobId={ID} label="ジョブを開く" />)).toContain(
      "ジョブを開く",
    );
  });

  test("stays in the same tab", () => {
    expect(render(<JobLink jobId={ID} label="ジョブを開く" />)).not.toContain(
      "_blank",
    );
  });

  test("does not point at Windmill", () => {
    expect(render(<JobLink jobId={ID} label="ジョブを開く" />)).not.toContain(
      "/run/",
    );
  });

  test("draws nothing for an id that is not a UUID", () => {
    expect(render(<JobLink jobId="../x" label="ジョブを開く" />)).toBe("");
  });

  test("draws nothing without an id", () => {
    expect(render(<JobLink jobId={null} label="ジョブを開く" />)).toBe("");
  });
});

describe("WindmillJobLink", () => {
  test("links to the job page of Windmill", () => {
    expect(
      render(<WindmillJobLink jobId={ID} label="Windmillで開く" />),
    ).toContain(`href="/run/${ID}"`);
  });

  test("opens in another tab without handing over the opener", () => {
    expect(
      render(<WindmillJobLink jobId={ID} label="Windmillで開く" />),
    ).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  test("draws nothing for an id that is not a UUID", () => {
    expect(
      render(<WindmillJobLink jobId="unknown" label="Windmillで開く" />),
    ).toBe("");
  });
});
