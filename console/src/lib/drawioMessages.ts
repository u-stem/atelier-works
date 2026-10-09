// draw.ioの図を描くiframeとのpostMessageを扱う純粋関数。
// iframe側(public/assets/drawio-frame-*.js)の受け口と、メッセージの形と上限を合わせる。
// iframeは不透明なオリジンなので、親からは送り先のオリジンを指定できず、
// 受け取る側が送り元のwindowを確かめる。

/** 図を描くページ。同じオリジンから配信され、CSPがこのページだけ別になる。 */
export const DRAWIO_FRAME_SRC = "/console/drawio.html";

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
  if (source === null || source === undefined || source !== frameWindow) {
    return null;
  }
  if (!isRecord(data) || data.type !== "drawio:height") {
    return null;
  }
  const height = data.height;
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return null;
  }
  return clampFrameHeight(height);
}
