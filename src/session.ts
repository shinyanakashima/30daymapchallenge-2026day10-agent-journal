export type Lang = 'en' | 'ja';
export type Bilingual = { en: string; ja: string };

export type Message = {
  role: 'user' | 'assistant' | 'tool' | 'note';
  content: string;
  label?: string;
  model?: string;
};

export type Step = {
  stepId: string;
  frameIndex: number | null;
  timestamp: string | null;
  status: 'success' | 'error';
  changeSummary: Bilingual;
  revision: string | null;
  codeDiff?: string | null;
  messages: Message[];
};

export type DataSource = { name: Bilingual | string; license: string | null; url: string | null };

export type Session = {
  schemaVersion: 1;
  id: string;
  kind: 'fixture' | 'production';
  title: Bilingual;
  model: { name?: string; provider?: string; notes?: string } | null;
  recording: Bilingual;
  dataSources: DataSource[];
  viewport: { width: number; height: number; deviceScaleFactor: number };
  frames: {
    path: string | null;
    count: number;
    shape: [number, number, number, number];
    dtype: 'uint8';
    channels: 'RGBA';
  };
  thumbnails?: {
    path: string | null;
    count: number;
    shape: [number, number, number, number];
  };
  steps: Step[];
};

export type ArraySource = URL | ((key: string) => Promise<Uint8Array | undefined>);
export type Loaded = { session: Session; source: (path: string) => ArraySource; local: boolean };

export async function loadSession(base: URL, requested: string | null): Promise<Loaded> {
  if (requested === 'local') {
    const { previewReader } = await import('./local-store');
    const r = previewReader();
    const raw = await r.get('session.json');
    if (!raw) throw new Error('No local preview in this browser. Build one on the recording page first.');
    const session = JSON.parse(new TextDecoder().decode(raw)) as Session;
    validate(session);
    return { session, local: true, source: (path) => (key: string) => r.get(`${path}${key}`) };
  }
  const { session, url } = await loadRemote(base, requested);
  return { session, local: false, source: (path) => new URL(path, url) };
}

async function loadRemote(base: URL, requested: string | null): Promise<{ session: Session; url: URL }> {
  let id = requested;
  if (!id) {
    const idx = await fetchJson<{ default: string }>(new URL('sessions/index.json', base));
    id = idx.default;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
  const url = new URL(`sessions/${id}/session.json`, base);
  const session = await fetchJson<Session>(url);
  validate(session);
  return { session, url };
}

async function fetchJson<T>(url: URL): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url.pathname}`);
  return (await res.json()) as T;
}

function validate(s: Session): void {
  if (s.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion ${String(s.schemaVersion)}`);
  if (!Array.isArray(s.steps) || s.steps.length === 0) throw new Error('Session has no steps');
  const [, h, w, c] = s.frames.shape;
  if (h !== s.viewport.height || w !== s.viewport.width || c !== 4) throw new Error('Frame shape does not match viewport');
  const ids = new Set<string>();
  for (const st of s.steps) {
    if (ids.has(st.stepId)) throw new Error(`Duplicate stepId ${st.stepId}`);
    ids.add(st.stepId);
    if (st.frameIndex !== null && (!Number.isInteger(st.frameIndex) || st.frameIndex < 0 || st.frameIndex >= s.frames.count)) {
      throw new Error(`Step ${st.stepId} has frameIndex ${st.frameIndex} outside 0..${s.frames.count - 1}`);
    }
  }
}
