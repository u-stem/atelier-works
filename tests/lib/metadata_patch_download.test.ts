import { describe, expect, test } from "bun:test";
import { GitHubRateLimitError } from "../../f/factory/lib/github.ts";
import {
  type ArtifactFetch,
  downloadArtifactZip,
  GitHubArtifactDownloadError,
} from "../../f/factory/lib/metadata_patch_download.ts";

const STORAGE_URL =
  "https://productionresultssa1.blob.core.windows.net/actions-results/zip?sig=SECRET-SIGNATURE";

type Call = { readonly url: string; readonly init: RequestInit | undefined };

function fakeFetch(responses: readonly (Response | Error)[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchFake: ArtifactFetch = async (url, init) => {
    calls.push({ url, init });
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error("fakeFetch: no canned response");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { fetch: fetchFake, calls };
}

const redirect = (location: string | null = STORAGE_URL, status = 302) =>
  new Response(null, {
    status,
    headers: location === null ? {} : { location },
  });

const artifactRef = { id: 9001, sizeInBytes: 10, expired: false };
const MAX = 100;

async function downloadError(
  responses: readonly (Response | Error)[],
  artifact = artifactRef,
  max = MAX,
): Promise<GitHubArtifactDownloadError> {
  const { fetch } = fakeFetch(responses);
  try {
    await downloadArtifactZip(
      { ghToken: "tok", fetch },
      "acme",
      "widgets",
      artifact,
      max,
    );
  } catch (error) {
    if (error instanceof GitHubArtifactDownloadError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the download to fail");
}

describe("downloadArtifactZip", () => {
  test("returns the bytes of the body without decoding them", async () => {
    const body = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80,
    ]);
    const { fetch } = fakeFetch([redirect(), new Response(body)]);
    const bytes = await downloadArtifactZip(
      { ghToken: "tok", fetch },
      "acme",
      "widgets",
      artifactRef,
      MAX,
    );
    expect(Array.from(bytes)).toEqual(Array.from(body));
  });

  test("asks the API for the zip of that artifact without following the redirect", async () => {
    const fake = fakeFetch([redirect(), new Response(new Uint8Array(1))]);
    await downloadArtifactZip(
      { ghToken: "tok", fetch: fake.fetch },
      "acme",
      "widgets",
      artifactRef,
      MAX,
    );
    expect([fake.calls[0]?.url, fake.calls[0]?.init?.redirect]).toEqual([
      "https://api.github.com/repos/acme/widgets/actions/artifacts/9001/zip",
      "manual",
    ]);
  });

  test("sends the token to the API only", async () => {
    const fake = fakeFetch([redirect(), new Response(new Uint8Array(1))]);
    await downloadArtifactZip(
      { ghToken: "tok", fetch: fake.fetch },
      "acme",
      "widgets",
      artifactRef,
      MAX,
    );
    const headers = (call: Call | undefined) =>
      JSON.stringify(call?.init?.headers ?? {});
    expect([
      headers(fake.calls[0]).includes("tok"),
      headers(fake.calls[1]).includes("tok"),
    ]).toEqual([true, false]);
  });

  test("fetches the storage URL without following further redirects", async () => {
    const fake = fakeFetch([redirect(), new Response(new Uint8Array(1))]);
    await downloadArtifactZip(
      { ghToken: "tok", fetch: fake.fetch },
      "acme",
      "widgets",
      artifactRef,
      MAX,
    );
    expect([fake.calls[1]?.url, fake.calls[1]?.init?.redirect]).toEqual([
      STORAGE_URL,
      "error",
    ]);
  });

  test("rejects an expired artifact before any request", async () => {
    const fake = fakeFetch([]);
    const promise = downloadArtifactZip(
      { ghToken: "tok", fetch: fake.fetch },
      "acme",
      "widgets",
      { ...artifactRef, expired: true },
      MAX,
    );
    await expect(promise).rejects.toMatchObject({ kind: "expired" });
  });

  test("rejects a declared size over the limit before any request", async () => {
    const fake = fakeFetch([]);
    await downloadArtifactZip(
      { ghToken: "tok", fetch: fake.fetch },
      "acme",
      "widgets",
      { ...artifactRef, sizeInBytes: MAX + 1 },
      MAX,
    ).catch(() => {});
    expect(fake.calls).toHaveLength(0);
  });

  test("reports a declared size over the limit as too large", async () => {
    const error = await downloadError([], {
      ...artifactRef,
      sizeInBytes: MAX + 1,
    });
    expect(error.kind).toBe("too_large");
  });

  test("rejects an artifact id that is not a positive integer", async () => {
    const fake = fakeFetch([]);
    const promise = downloadArtifactZip(
      { ghToken: "tok", fetch: fake.fetch },
      "acme",
      "widgets",
      { ...artifactRef, id: 0 },
      MAX,
    );
    await expect(promise).rejects.toThrow("invalid artifact id");
  });

  test("rejects a redirect to another host", async () => {
    const error = await downloadError([redirect("https://evil.example.com/z")]);
    expect(error.kind).toBe("bad_redirect");
  });

  test("rejects a redirect to a host that only ends like the storage host", async () => {
    const error = await downloadError([
      redirect("https://evilblob.core.windows.net.evil.com/z"),
    ]);
    expect(error.kind).toBe("bad_redirect");
  });

  test("rejects a redirect over plain http", async () => {
    const error = await downloadError([
      redirect("http://a.blob.core.windows.net/z"),
    ]);
    expect(error.kind).toBe("bad_redirect");
  });

  test("rejects a redirect with credentials in the URL", async () => {
    const error = await downloadError([
      redirect("https://user:pw@a.blob.core.windows.net/z"),
    ]);
    expect(error.kind).toBe("bad_redirect");
  });

  test("rejects a redirect without a location", async () => {
    const error = await downloadError([redirect(null)]);
    expect(error.kind).toBe("bad_redirect");
  });

  test("rejects a body served by the API itself", async () => {
    const error = await downloadError([new Response(new Uint8Array(3))]);
    expect(error.kind).toBe("bad_redirect");
  });

  test("keeps the status of a failed API call", async () => {
    const error = await downloadError([new Response("{}", { status: 404 })]);
    expect([error.kind, error.status]).toEqual(["api_status", 404]);
  });

  test("reports a failed storage call", async () => {
    const error = await downloadError([
      redirect(),
      new Response("boom", { status: 500 }),
    ]);
    expect([error.kind, error.status]).toEqual(["storage_status", 500]);
  });

  test("reports a network failure", async () => {
    const error = await downloadError([new Error("connect ECONNRESET")]);
    expect(error.kind).toBe("network");
  });

  test("throws the rate limit error when the API is rate limited", async () => {
    const { fetch } = fakeFetch([
      new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "9999999999",
        },
      }),
    ]);
    const promise = downloadArtifactZip(
      { ghToken: "tok", fetch },
      "acme",
      "widgets",
      artifactRef,
      MAX,
    );
    await expect(promise).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  test("stops reading when the body exceeds the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(60));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await downloadError([redirect(), new Response(stream)]);
    expect([error.kind, cancelled]).toEqual(["too_large", true]);
  });

  test("rejects a declared content length over the limit without reading", async () => {
    const response = new Response(new Uint8Array(1), {
      headers: { "content-length": String(MAX + 1) },
    });
    const error = await downloadError([redirect(), response]);
    expect(error.kind).toBe("too_large");
  });

  test("does not put the signed URL in an error", async () => {
    const error = await downloadError([
      redirect(),
      new Response("boom", { status: 500 }),
    ]);
    expect(error.message).not.toContain("SECRET-SIGNATURE");
  });

  test("does not put the token in an error", async () => {
    const error = await downloadError([new Error("failed for token tok")]);
    expect(error.message).not.toContain("tok");
  });
});
