import { decode, encode, convertIndexedToRgb } from 'fast-png';

/** Decode a PNG to 8-bit RGBA without colour management (same as Pillow's convert("RGBA")). */
export function decodePngRgba(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const png = decode(bytes);
  const { width, height } = png;
  let src: ArrayLike<number> = png.data;
  let channels = png.channels;
  if (png.palette) {
    src = convertIndexedToRgb(png);
    channels = png.palette[0].length === 4 || png.transparency ? 4 : 3;
    if (src.length === width * height * 4) channels = 4;
    else if (src.length === width * height * 3) channels = 3;
  }
  const shift = png.depth === 16 ? 8 : 0;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    const v = (k: number) => (shift ? (src[j + k] as number) >> shift : (src[j + k] as number));
    if (channels >= 3) {
      out[o] = v(0); out[o + 1] = v(1); out[o + 2] = v(2);
      out[o + 3] = channels === 4 ? v(3) : 255;
    } else {
      const g = v(0);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = channels === 2 ? v(1) : 255;
    }
  }
  return { width, height, data: out };
}

export function encodePngRgba(width: number, height: number, data: Uint8Array | Uint8ClampedArray): Uint8Array {
  return encode({ width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), channels: 4, depth: 8 });
}
