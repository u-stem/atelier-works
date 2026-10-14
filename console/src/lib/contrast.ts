// WCAGのコントラスト比を、CSSのoklch色から求める。テーマの色が基準を保つことの検査に使う。

export type LinearRgb = readonly [number, number, number];

/** `oklch(...)`の中身(「0.2 0.02 265」の形)を、線形のsRGBにする。範囲外は0〜1に丸める。 */
export function oklchToLinearRgb(body: string): LinearRgb {
  const [lightness = 0, chroma = 0, hue = 0] = body
    .trim()
    .split(/\s+/)
    .map(Number);
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function luminance(color: LinearRgb): number {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

/** 2色のコントラスト比。1〜21の値で、順序は問わない。 */
export function contrastRatio(a: LinearRgb, b: LinearRgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `base`に`tint`を`alpha`の割合で重ねた色。薄い色のバッジの背景を再現する。 */
export function mixLinear(
  base: LinearRgb,
  tint: LinearRgb,
  alpha: number,
): LinearRgb {
  return [
    base[0] * (1 - alpha) + tint[0] * alpha,
    base[1] * (1 - alpha) + tint[1] * alpha,
    base[2] * (1 - alpha) + tint[2] * alpha,
  ];
}
