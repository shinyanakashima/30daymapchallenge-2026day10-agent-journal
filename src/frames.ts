import * as zarr from 'zarrita';

/**
 * Reads one RGBA screen frame at a time from a Zarr v3 array shaped
 * (step, y, x, channel) with chunks (1, y, x, channel).
 * Only the requested chunk is fetched and decoded. A small LRU cache keeps
 * recently shown frames; concurrent requests for the same frame share one fetch.
 */
export class FrameSource {
  private arr: Promise<zarr.Array<'uint8', zarr.Readable>>;
  private cache = new Map<number, Uint8Array>();
  private inflight = new Map<number, { promise: Promise<Uint8Array>; controller: AbortController; users: number }>();

  constructor(url: URL, readonly width: number, readonly height: number, private capacity = 4) {
    this.capacity = Math.max(1, capacity);
    const fetchStore = new zarr.FetchStore(url.href);
    // zarrita treats a missing chunk (404) as fill_value. Every frame is written,
    // so a missing chunk here is an error, not a blank frame.
    const store = {
      async get(key: `/${string}`, opts?: RequestInit) {
        const bytes = await fetchStore.get(key, opts);
        if (bytes === undefined && key.startsWith('/c/')) throw new Error(`Missing chunk ${key}`);
        return bytes;
      },
    };
    this.arr = zarr.open.v3(store, { kind: 'array' }).then((a) => {
      if (!a.is('uint8')) throw new Error(`Expected uint8 frames, got ${a.dtype}`);
      const [, h, w, c] = a.shape;
      if (h !== height || w !== width || c !== 4) throw new Error(`Unexpected frame shape ${a.shape.join('×')}`);
      const [cs, ch, cw, cc] = a.chunks;
      if (cs !== 1 || ch !== height || cw !== width || cc !== 4) throw new Error(`Unexpected chunk shape ${a.chunks.join('×')}`);
      return a;
    });
  }

  has(index: number): boolean {
    return this.cache.has(index);
  }

  /** Fetch every frame (used for the small thumbnail array only). */
  async getAll(count: number): Promise<Uint8Array[]> {
    return Promise.all(Array.from({ length: count }, (_, i) => this.get(i)));
  }

  /** Resolve RGBA bytes for one frame. Aborting `signal` releases this caller's interest. */
  async get(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit);
      return hit;
    }
    let entry = this.inflight.get(index);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.fetchFrame(index, controller.signal).then(
        (data) => {
          this.inflight.delete(index);
          this.remember(index, data);
          return data;
        },
        (err) => {
          this.inflight.delete(index);
          throw err;
        },
      );
      entry = { promise, controller, users: 0 };
      this.inflight.set(index, entry);
    }
    entry.users++;
    const e = entry;
    if (!signal) return e.promise;
    if (signal.aborted) {
      this.release(index, e);
      throw new DOMException('Aborted', 'AbortError');
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = () => {
        this.release(index, e);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      e.promise.then(
        (d) => { signal.removeEventListener('abort', onAbort); resolve(d); },
        (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
      );
    });
  }

  private release(index: number, e: { controller: AbortController; users: number }) {
    e.users--;
    if (e.users <= 0 && this.inflight.get(index) === e) {
      this.inflight.delete(index);
      e.controller.abort();
    }
  }

  private async fetchFrame(index: number, signal: AbortSignal): Promise<Uint8Array> {
    const arr = await this.arr;
    const chunk = await arr.getChunk([index, 0, 0, 0], { signal });
    const data = chunk.data as Uint8Array;
    if (data.length !== this.width * this.height * 4) throw new Error(`Frame ${index}: decoded ${data.length} bytes`);
    return data;
  }

  private remember(index: number, data: Uint8Array) {
    this.cache.set(index, data);
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
  }
}
