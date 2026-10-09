// draw.ioのビューアの固定(drawio-viewer.json)を検証する純粋関数。
// ビューアはgitに入れず、CIが固定のURLから取得してsha256を照合し、dist/assets/に置く。
import { createHash } from "node:crypto";
import { contentHashedName } from "./asset-name.ts";

export type DrawioViewerPin = {
  readonly version: string;
  readonly commit: string;
  readonly url: string;
  readonly sha256: string;
};

export type ViewerVerification =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: string };

export const VIEWER_STEM = "drawio-viewer";
export const VIEWER_EXTENSION = ".js";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// 固定のURLの取得元。branchやtagではなくcommitを指すので、後から中身が変わらない。
const PIN_URL_PREFIX = "https://raw.githubusercontent.com/jgraph/drawio/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`drawio-viewer.json: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * drawio-viewer.jsonの中身を検証して返す。形が違えば`Error`を投げる(CIの取得を止める)。
 * urlは固定のcommitを含む取得元に限り、版の固定がcommitに結び付くようにする。
 */
export function parseDrawioViewerPin(value: unknown): DrawioViewerPin {
  if (!isRecord(value)) {
    throw new Error("drawio-viewer.json must be an object");
  }
  const version = readString(value, "version");
  const commit = readString(value, "commit");
  const url = readString(value, "url");
  const sha256 = readString(value, "sha256");
  if (!COMMIT_SHA.test(commit)) {
    throw new Error('drawio-viewer.json: "commit" must be a 40-digit hex sha');
  }
  if (!SHA256_HEX.test(sha256)) {
    throw new Error('drawio-viewer.json: "sha256" must be 64 lowercase hex');
  }
  if (!url.startsWith(`${PIN_URL_PREFIX}${commit}/`)) {
    throw new Error(
      'drawio-viewer.json: "url" must be a raw.githubusercontent.com url of the pinned commit',
    );
  }
  return { version, commit, url, sha256 };
}

/**
 * 固定のsha256から、dist/assets/に置くビューアの名前を返す。
 * 名前は`asset-name.ts`の規則どおり、中身のsha256の先頭8桁を含む。
 */
export function viewerAssetName(pin: DrawioViewerPin): string {
  return `${VIEWER_STEM}-${pin.sha256.slice(0, 8)}${VIEWER_EXTENSION}`;
}

/**
 * 取得したビューアが固定のsha256と一致するかを返す。
 * 一致すれば、dist/assets/に置く名前を返す。
 */
export function verifyViewer(
  bytes: Uint8Array,
  pin: DrawioViewerPin,
): ViewerVerification {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== pin.sha256) {
    return {
      ok: false,
      reason: `sha256 mismatch: expected ${pin.sha256}, got ${actual}`,
    };
  }
  return {
    ok: true,
    name: contentHashedName(VIEWER_STEM, VIEWER_EXTENSION, bytes),
  };
}
