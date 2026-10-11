// draw.ioの図を描くiframeとのpostMessageを扱う純粋関数。
// SPAのConsoleの`console/src/lib/drawioMessages.ts`と、定数とメッセージの形を合わせる。
// iframe側の受け口(`console/public/drawio/drawio-frame-*.js`)も、同じ形と上限で読む。
// iframeは不透明なオリジンなので、親からは送り先のオリジンを指定できず、
// 受け取る側が送り元のwindowを確かめる。

/** 図を描くページ。SPAのConsoleが配信し、CSPがこのページだけ別になる。 */
export const DRAWIO_FRAME_SRC = "/console/drawio.html";

/** iframeのsandbox。`allow-same-origin`が無いので、iframeは不透明なオリジンになる。 */
export const DRAWIO_FRAME_SANDBOX = "allow-scripts";

/** 描く図のXMLの上限(UTF-8のバイト数)。iframe側の受け口の上限と合わせる。 */
export const MAX_XML_BYTES = 256 * 1024;

export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 1600;

export type DrawioRenderMessage = {
  readonly type: "drawio:render";
  readonly xml: string;
};

export type RenderMessageResult =
  | { readonly ok: true; readonly message: DrawioRenderMessage }
  | { readonly ok: false; readonly reason: "empty" | "too_large" };

const textEncoder = new TextEncoder();

/**
 * iframeへ送るメッセージを作る。
 * 空のXMLと、上限を超えるXMLは送らない(描けないので、親が理由を画面に出す)。
 */
export function buildRenderMessage(xml: string): RenderMessageResult {
  if (xml.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (textEncoder.encode(xml).length > MAX_XML_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, message: { type: "drawio:render", xml } };
}

/** iframeが測った高さを、親が使える範囲(80〜1600)の整数にする。 */
export function clampFrameHeight(height: number): number {
  return Math.min(
    MAX_FRAME_HEIGHT,
    Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 送り元がiframeのwindowで、種別が`type`のメッセージだけを返す。 */
function readFromFrame(
  source: unknown,
  frameWindow: unknown,
  data: unknown,
  type: string,
): Record<string, unknown> | null {
  if (source === null || source === undefined || source !== frameWindow) {
    return null;
  }
  if (!isRecord(data) || data.type !== type) {
    return null;
  }
  return data;
}

/**
 * iframeから届いたメッセージの高さを返す。
 * 送り元がiframeのwindowでないもの、種別が違うもの、高さが有限の数値でないものは`null`にする。
 * iframeの中身はデータ由来のXMLを描くので、届いた値は信用せず、範囲に収めてから使う。
 */
export function readFrameHeight(
  source: unknown,
  frameWindow: unknown,
  data: unknown,
): number | null {
  const message = readFromFrame(source, frameWindow, data, "drawio:height");
  const height = message?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return null;
  }
  return clampFrameHeight(height);
}

export type FrameErrorReason = "viewer_missing" | "render_failed" | "too_large";

/** iframeの失敗の種類に、親が決めた「応答なし」を足したもの。応答なしは、iframeからは届かない。 */
export type FrameFailure = FrameErrorReason | "no_response";

const ERROR_TEXTS: Readonly<Record<FrameFailure, string>> = {
  no_response: "図を表示できません。図のページが応答しませんでした。",
  viewer_missing: "図のビューアが読み込まれていないため、図を表示できません。",
  render_failed: "図を表示できませんでした。",
  too_large: "図が大きすぎるため、表示できません。",
};

function isFrameErrorReason(value: unknown): value is FrameErrorReason {
  return (
    value === "viewer_missing" ||
    value === "render_failed" ||
    value === "too_large"
  );
}

/**
 * iframeから届いた失敗の種類を返す。
 * 親が受けるのは、固定の3つの種類だけにする。iframeが送った文は使わず、親が文を決める。
 */
export function readFrameError(
  source: unknown,
  frameWindow: unknown,
  data: unknown,
): FrameErrorReason | null {
  const message = readFromFrame(source, frameWindow, data, "drawio:error");
  const reason = message?.reason;
  return isFrameErrorReason(reason) ? reason : null;
}

/** 失敗の種類に対応する、画面に出す文を返す。 */
export function frameErrorText(reason: FrameFailure): string {
  return ERROR_TEXTS[reason];
}

/** iframeの遷移を検知して表示を止めたときに出す文。 */
export const FRAME_STOPPED_TEXT = "図の表示を止めました。";
