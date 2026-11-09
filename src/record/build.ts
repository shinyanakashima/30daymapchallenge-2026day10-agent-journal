import { createTwoFilesPatch } from 'diff';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { changedFiles, history, readAt, readMeta, type StepFile } from './git';
import { decodePngRgba } from './png';
import { scanText } from './scan';
import { halve, sha256Hex, writeFramesArray, GZIP_LEVEL } from './zarr-write';

const W = 1200;
const H = 900;
const MAX_DIFF_LINES = 400;

export type BuildOutput = {
  id: string;
  files: Map<string, Uint8Array>; // paths relative to sessions/<id>/
  report: {
    sessionId: string;
    builtWith: string;
    codec: string;
    frames: { frameIndex: number; stepId: string; source: string; width: number; height: number; rgbaSha256: string; rawBytes: number; chunkBytes: number; pngBytes: number; thumbRgbaSha256: string; thumbChunkBytes: number }[];
    totals: { frames: number; rawBytes: number; chunkBytes: number; pngBytes: number; thumbChunkBytes: number };
  };
  problems: string[];
};

const isText = (b: Uint8Array) => !b.subarray(0, 8000).includes(0);

function codeDiff(changes: { path: string; before: Uint8Array | null; after: Uint8Array | null }[]): string | null {
  const parts: string[] = [];
  for (const c of changes) {
    if (c.path.startsWith('steps/')) continue;
    if (c.path.startsWith('data/') && ((c.after && !isText(c.after)) || (c.after?.length ?? 0) > 20000 || (c.before?.length ?? 0) > 20000)) {
      parts.push(`Data file ${c.before ? (c.after ? 'changed' : 'removed') : 'added'}: ${c.path}`);
      continue;
    }
    const a = c.before ?? new Uint8Array();
    const b = c.after ?? new Uint8Array();
    if (!isText(a) || !isText(b)) {
      parts.push(`Binary file changed: ${c.path}`);
      continue;
    }
    const patch = createTwoFilesPatch(c.before ? `a/${c.path}` : '/dev/null', c.after ? `b/${c.path}` : '/dev/null', strFromU8(a), strFromU8(b), '', '', { context: 3 });
    parts.push(patch.replace(/^=+\n/m, '').replace(/^Index: .*\n/m, ''));
  }
  if (!parts.length) return null;
  let text = parts.join('\n').trimEnd();
  const lines = text.split('\n');
  if (lines.length > MAX_DIFF_LINES) text = lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n… ${lines.length - MAX_DIFF_LINES} more lines (see the journal repository)`;
  return text;
}

/** Read the journal's Git history and build session.json + frames.zarr + thumbs.zarr in the browser. */
export async function buildSession(allowEmails: string[] = []): Promise<BuildOutput> {
  const meta = await readMeta();
  if (!meta) throw new Error('No journal.');
  const commits = await history();
  const problems: string[] = [];
  const steps: unknown[] = [];
  const frames: Uint8Array[] = [];
  const thumbs: Uint8Array[] = [];
  const frameInfo: { stepId: string; source: string; png: number }[] = [];
  const models = new Set<string>();

  for (const c of commits) {
    if (!c.stepId) continue;
    const base = `steps/${c.stepId}`;
    const sf = JSON.parse(strFromU8((await readAt(c.oid, `${base}/step.json`))!)) as StepFile;
    const messages = [];
    for (const [j, m] of sf.messages.entries()) {
      const content = strFromU8((await readAt(c.oid, `${base}/${m.file}`)) ?? new Uint8Array()).replace(/\n$/, '');
      problems.push(...scanText(content, `${c.stepId}.messages[${j}]`, allowEmails));
      const out: Record<string, string> = { role: m.role, content };
      if (m.label) out.label = m.label;
      if (m.model) { out.model = m.model; models.add(m.model); }
      messages.push(out);
    }
    problems.push(...scanText(`${sf.changeSummary.en}\n${sf.changeSummary.ja}`, `${c.stepId}.changeSummary`, allowEmails));
    let frameIndex: number | null = null;
    if (sf.capture) {
      const png = await readAt(c.oid, `${base}/${sf.capture}`);
      if (!png) throw new Error(`${c.stepId}: capture missing in commit ${c.oid.slice(0, 7)}`);
      const img = decodePngRgba(png);
      if (img.width !== W || img.height !== H) throw new Error(`${c.stepId}: capture is ${img.width}×${img.height}, expected ${W}×${H}`);
      frameIndex = frames.length;
      frames.push(img.data);
      thumbs.push(halve(img.data, W, H));
      frameInfo.push({ stepId: c.stepId, source: `${base}/${sf.capture}`, png: png.length });
    }
    const diff = codeDiff(await changedFiles(c.parent, c.oid));
    if (diff) problems.push(...scanText(diff, `${c.stepId}.codeDiff`, allowEmails));
    steps.push({
      stepId: sf.stepId,
      frameIndex,
      timestamp: sf.timestamp,
      status: sf.status,
      changeSummary: sf.changeSummary,
      revision: c.oid,
      codeDiff: diff,
      messages,
    });
  }
  if (!steps.length) throw new Error('The journal has no steps yet.');

  const files = new Map<string, Uint8Array>();
  const n = frames.length;
  if (n) {
    for (const [k, v] of writeFramesArray(frames, H, W, 'Screen pixels, not a georeferenced raster.')) files.set(`frames.zarr/${k}`, v);
    for (const [k, v] of writeFramesArray(thumbs, H / 2, W / 2, 'Box-downsampled copy of frames.zarr for the layers view.')) files.set(`thumbs.zarr/${k}`, v);
  }
  const session = {
    schemaVersion: 1,
    id: meta.id,
    kind: meta.kind,
    title: meta.title,
    model: models.size ? { provider: 'OpenAI', name: [...models].join(', '), notes: 'Chat Completions API, called from the browser' } : null,
    recording: meta.recording,
    dataSources: meta.dataSources.map(({ name, license, url }) => ({ name, license, url })),
    viewport: { width: W, height: H, deviceScaleFactor: 1 },
    frames: { path: n ? 'frames.zarr' : null, count: n, shape: [n, H, W, 4], dtype: 'uint8', channels: 'RGBA', dimensionNames: ['step', 'y', 'x', 'channel'], chunks: [1, H, W, 4], codecs: ['bytes', `gzip(level=${GZIP_LEVEL})`] },
    thumbnails: { path: n ? 'thumbs.zarr' : null, count: n, shape: [n, H / 2, W / 2, 4], dtype: 'uint8', channels: 'RGBA', chunks: [1, H / 2, W / 2, 4], resampling: 'box' },
    steps,
  };
  files.set('session.json', strToU8(JSON.stringify(session, null, 2) + '\n'));

  const reportFrames: BuildOutput['report']['frames'] = [];
  for (let i = 0; i < n; i++) {
    reportFrames.push({
      frameIndex: i,
      stepId: frameInfo[i].stepId,
      source: frameInfo[i].source,
      width: W,
      height: H,
      rgbaSha256: await sha256Hex(frames[i]),
      rawBytes: frames[i].length,
      chunkBytes: files.get(`frames.zarr/c/${i}/0/0/0`)!.length,
      pngBytes: frameInfo[i].png,
      thumbRgbaSha256: await sha256Hex(thumbs[i]),
      thumbChunkBytes: files.get(`thumbs.zarr/c/${i}/0/0/0`)!.length,
    });
  }
  const sum = (k: 'rawBytes' | 'chunkBytes' | 'pngBytes' | 'thumbChunkBytes') => reportFrames.reduce((s, f) => s + f[k], 0);
  return {
    id: meta.id,
    files,
    problems,
    report: {
      sessionId: meta.id,
      builtWith: 'browser (isomorphic-git, fast-png, fflate)',
      codec: `bytes -> gzip(level=${GZIP_LEVEL})`,
      frames: reportFrames,
      totals: { frames: n, rawBytes: sum('rawBytes'), chunkBytes: sum('chunkBytes'), pngBytes: sum('pngBytes'), thumbChunkBytes: sum('thumbChunkBytes') },
    },
  };
}

/** Zip laid out for public/sessions/<id>/ plus build-report.json at the top. */
export function zipBuild(out: BuildOutput): Uint8Array {
  const entries: Record<string, Uint8Array> = { 'build-report.json': strToU8(JSON.stringify(out.report, null, 2) + '\n') };
  for (const [k, v] of out.files) entries[`${out.id}/${k}`] = v;
  return zipSync(entries, { level: 0, mtime: new Date('2026-01-01T00:00:00Z') });
}
