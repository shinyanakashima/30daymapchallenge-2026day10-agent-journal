// A built session kept in this browser (IndexedDB) so it can be previewed before publishing.
import LightningFS from '@isomorphic-git/lightning-fs';

const NAME = 'map-rewind-preview';
const ROOT = '/session';

let shared: LightningFS | null = null;
const instance = () => (shared ??= new LightningFS(NAME));

export async function savePreview(files: Map<string, Uint8Array>) {
  const p = instance().promises;
  const rmrf = async (path: string) => {
    let st;
    try { st = await p.stat(path); } catch { return; }
    if (st.isDirectory()) {
      for (const n of await p.readdir(path)) await rmrf(`${path}/${n}`);
      await p.rmdir(path);
    } else await p.unlink(path);
  };
  await rmrf(ROOT);
  const made = new Set<string>();
  const mkdirp = async (dir: string) => {
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) {
      cur += `/${part}`;
      if (made.has(cur)) continue;
      try { await p.mkdir(cur); } catch { /* exists */ }
      made.add(cur);
    }
  };
  for (const [path, data] of files) {
    const full = `${ROOT}/${path}`;
    await mkdirp(full.slice(0, full.lastIndexOf('/')));
    await p.writeFile(full, data);
  }
  await (p as unknown as { flush?: () => Promise<void> }).flush?.();
}

export function previewReader() {
  const fs = instance();
  return {
    async get(path: string): Promise<Uint8Array | undefined> {
      try {
        return (await fs.promises.readFile(`${ROOT}/${path.replace(/^\//, '')}`)) as Uint8Array;
      } catch {
        return undefined;
      }
    },
  };
}
