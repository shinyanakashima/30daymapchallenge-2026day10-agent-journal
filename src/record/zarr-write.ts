import { gzipSync } from 'fflate';

export const GZIP_LEVEL = 6;

/** Zarr v3 array metadata for frames shaped (step, y, x, RGBA), one frame per chunk. */
export function framesMetadata(n: number, height: number, width: number, note: string) {
  return {
    shape: [n, height, width, 4],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, height, width, 4] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [{ name: 'bytes' }, { name: 'gzip', configuration: { level: GZIP_LEVEL } }],
    attributes: { channels: 'RGBA', note },
    dimension_names: ['step', 'y', 'x', 'channel'],
    zarr_format: 3,
    node_type: 'array',
    storage_transformers: [],
  };
}

/** Returns the files of a Zarr v3 store as path → bytes (paths relative to the store root). */
export function writeFramesArray(frames: Uint8Array[], height: number, width: number, note: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  out.set('zarr.json', enc.encode(JSON.stringify(framesMetadata(frames.length, height, width, note), null, 2) + '\n'));
  frames.forEach((f, i) => {
    if (f.length !== height * width * 4) throw new Error(`frame ${i}: ${f.length} bytes, expected ${height * width * 4}`);
    out.set(`c/${i}/0/0/0`, gzipSync(f, { level: GZIP_LEVEL, mtime: 0 }));
  });
  return out;
}

/** 2×2 box average (rounded), RGBA. */
export function halve(src: Uint8Array, width: number, height: number): Uint8Array {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((2 * y) * width + 2 * x) * 4;
      const b = a + 4;
      const c = a + width * 4;
      const d = c + 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
    }
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
