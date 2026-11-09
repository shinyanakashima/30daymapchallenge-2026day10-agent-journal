import './polyfill';
import LightningFS from '@isomorphic-git/lightning-fs';
import git, { TREE } from 'isomorphic-git';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * The journal is an ordinary Git repository kept in the browser (IndexedDB).
 *
 *   journal.json            title, kind, recording note, data sources
 *   prompts/system.md       instructions sent to the model with every request
 *   map/main.js             the map code the model edits
 *   data/…                  data files the map code can read
 *   steps/<stepId>/step.json, NN-<role>.md, capture.png
 *
 * One commit per step. Exported as a zip, it can be cloned with ordinary git.
 */
export const DB_NAME = 'map-rewind-journal';
export const DIR = '/journal';
const fs = new LightningFS(DB_NAME);
const cache = {};

export type Author = { name: string; email: string };

export type JournalMeta = {
  schemaVersion: 1;
  id: string;
  kind: 'fixture' | 'production';
  title: { en: string; ja: string };
  recording: { en: string; ja: string };
  dataSources: { path?: string; name: { en: string; ja: string }; license: string | null; url: string | null }[];
};

export type StepMessage = { role: 'user' | 'assistant' | 'tool' | 'note'; file: string; label?: string; model?: string };
export type StepFile = {
  stepId: string;
  status: 'success' | 'error';
  timestamp: string;
  changeSummary: { en: string; ja: string };
  messages: StepMessage[];
  capture: string | null;
  svg?: string | null;
  llm?: { provider: string; model: string; usage?: unknown } | null;
};

export type CommitInfo = { oid: string; parent: string | null; message: string; timestamp: number; stepId: string | null };

const p = () => fs.promises;

export async function hasRepo(): Promise<boolean> {
  try {
    await p().stat(`${DIR}/.git/HEAD`);
    return true;
  } catch {
    return false;
  }
}

async function mkdirp(path: string) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    try {
      await p().mkdir(cur);
    } catch {
      /* exists */
    }
  }
}

export async function writeFile(path: string, data: Uint8Array | string) {
  const full = `${DIR}/${path}`;
  await mkdirp(full.slice(0, full.lastIndexOf('/')));
  await p().writeFile(full, typeof data === 'string' ? strToU8(data) : data);
}

export async function deleteFile(path: string) {
  try {
    await p().unlink(`${DIR}/${path}`);
  } catch {
    /* already gone */
  }
}

export async function readFile(path: string): Promise<Uint8Array | null> {
  try {
    return (await p().readFile(`${DIR}/${path}`)) as Uint8Array;
  } catch {
    return null;
  }
}

export async function readText(path: string): Promise<string | null> {
  const b = await readFile(path);
  return b ? strFromU8(b) : null;
}

export async function readAt(oid: string, path: string): Promise<Uint8Array | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir: DIR, oid, filepath: path, cache });
    return blob;
  } catch {
    return null;
  }
}

export async function listFiles(prefix: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let names: string[];
    try {
      names = await p().readdir(`${DIR}/${rel}`);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = await p().stat(`${DIR}/${r}`);
      if (st.isDirectory()) await walk(r);
      else out.push(r);
    }
  };
  await walk(prefix.replace(/\/$/, ''));
  return out;
}

/** Stage every change in the working tree and commit it. */
export async function commitAll(message: string, author: Author): Promise<string> {
  const matrix = await git.statusMatrix({ fs, dir: DIR, cache });
  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir === 0) {
      if (head !== 0 || stage !== 0) await git.remove({ fs, dir: DIR, filepath, cache });
    } else if (head !== workdir || workdir !== stage) {
      await git.add({ fs, dir: DIR, filepath, cache });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const who = { name: author.name || 'Map Rewind', email: author.email || '', timestamp: now, timezoneOffset: 0 };
  const oid = await git.commit({ fs, dir: DIR, message, author: who, committer: who, cache });
  await flush();
  return oid;
}

export async function initJournal(meta: JournalMeta, systemPrompt: string, starterCode: string, author: Author) {
  await wipe();
  await mkdirp(DIR);
  await git.init({ fs, dir: DIR, defaultBranch: 'main' });
  await writeFile('journal.json', JSON.stringify(meta, null, 2) + '\n');
  await writeFile('prompts/system.md', systemPrompt);
  await writeFile('map/main.js', starterCode);
  await writeFile('README.md', `# ${meta.title.en}\n\nMap Rewind journal. One commit per step: prompts, responses, map code and screen captures.\n`);
  await commitAll('Start journal', author);
}

export async function readMeta(): Promise<JournalMeta | null> {
  const t = await readText('journal.json');
  return t ? (JSON.parse(t) as JournalMeta) : null;
}

export async function writeMeta(meta: JournalMeta) {
  await writeFile('journal.json', JSON.stringify(meta, null, 2) + '\n');
}

export type NewStep = {
  screenSvg?: string | null;
  stepId: string;
  status: 'success' | 'error';
  changeSummary: { en: string; ja: string };
  messages: { role: StepMessage['role']; content: string; label?: string; model?: string }[];
  capturePng: Uint8Array | null;
  files?: Record<string, string | Uint8Array | null>;
  llm?: StepFile['llm'];
};

export async function commitStep(step: NewStep, author: Author): Promise<string> {
  const base = `steps/${step.stepId}`;
  const messages: StepMessage[] = step.messages.map((m, i) => {
    const file = `${String(i + 1).padStart(2, '0')}-${m.role}.md`;
    const out: StepMessage = { role: m.role, file };
    if (m.label) out.label = m.label;
    if (m.model) out.model = m.model;
    return out;
  });
  for (const [i, m] of step.messages.entries()) await writeFile(`${base}/${messages[i].file}`, m.content.endsWith('\n') ? m.content : m.content + '\n');
  if (step.capturePng) await writeFile(`${base}/capture.png`, step.capturePng);
  if (step.screenSvg) await writeFile(`${base}/screen.svg`, step.screenSvg);
  for (const [path, data] of Object.entries(step.files ?? {})) {
    if (data === null) await deleteFile(path);
    else await writeFile(path, data);
  }
  const file: StepFile = {
    stepId: step.stepId,
    status: step.status,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    changeSummary: step.changeSummary,
    messages,
    capture: step.capturePng ? 'capture.png' : null,
    svg: step.screenSvg ? 'screen.svg' : null,
    llm: step.llm ?? null,
  };
  await writeFile(`${base}/step.json`, JSON.stringify(file, null, 2) + '\n');
  return commitAll(`${step.stepId}: ${step.changeSummary.en}`.slice(0, 200), author);
}

/** Commits on main, oldest first. A commit is a step when it adds steps/<id>/step.json. */
export async function history(): Promise<CommitInfo[]> {
  let commits;
  try {
    commits = await git.log({ fs, dir: DIR, ref: 'main', cache });
  } catch {
    return [];
  }
  commits.reverse();
  const out: CommitInfo[] = [];
  for (const c of commits) {
    const parent = c.commit.parent[0] ?? null;
    const changed = await changedPaths(parent, c.oid);
    const added = changed.find((x) => /^steps\/[^/]+\/step\.json$/.test(x) && x);
    let stepId: string | null = null;
    if (added && (!parent || !(await readAt(parent, added)))) stepId = added.split('/')[1];
    out.push({ oid: c.oid, parent, message: c.commit.message.trim(), timestamp: c.commit.author.timestamp, stepId });
  }
  return out;
}

async function changedPaths(a: string | null, b: string): Promise<string[]> {
  return (await changedFiles(a, b, false)).map((f) => f.path);
}

export type Change = { path: string; before: Uint8Array | null; after: Uint8Array | null };

/** Files that differ between two commits (a may be null for the first commit). */
export async function changedFiles(a: string | null, b: string, withContent = true): Promise<Change[]> {
  const trees = a ? [TREE({ ref: a }), TREE({ ref: b })] : [TREE({ ref: b })];
  const res = (await git.walk({
    fs,
    dir: DIR,
    cache,
    trees,
    map: async (filepath, entries) => {
      const [A, B] = a ? entries : [null, entries[0]];
      const ta = A ? await A.type() : null;
      const tb = B ? await B.type() : null;
      const oa = A ? await A.oid() : null;
      const ob = B ? await B.oid() : null;
      if (ta === 'tree' || tb === 'tree') {
        if (filepath === '.') return undefined;
        if (oa && oa === ob) return null; // identical subtree
        if (ta !== 'blob' && tb !== 'blob') return undefined;
      }
      if (oa === ob) return undefined;
      if (!withContent) return { path: filepath, before: null, after: null };
      return {
        path: filepath,
        before: ta === 'blob' && A ? ((await A.content()) as Uint8Array) : null,
        after: tb === 'blob' && B ? ((await B.content()) as Uint8Array) : null,
      };
    },
  })) as unknown;
  const flat = (x: unknown): Change[] => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' && 'path' in x ? [x as Change] : []);
  return flat(res);
}

export async function exportZip(rootName = 'map-rewind-journal'): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = async (rel: string) => {
    for (const n of (await p().readdir(`${DIR}${rel}`)).sort()) {
      const r = `${rel}/${n}`;
      const st = await p().stat(`${DIR}${r}`);
      if (st.isDirectory()) await walk(r);
      else files[`${rootName}${r}`] = (await p().readFile(`${DIR}${r}`)) as Uint8Array;
    }
  };
  await walk('');
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

export async function importZip(bytes: Uint8Array) {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries).filter((n) => !n.endsWith('/'));
  const headPath = names.find((n) => /(^|\/)\.git\/HEAD$/.test(n));
  if (!headPath) throw new Error('The zip has no .git directory.');
  const prefix = headPath.slice(0, headPath.length - '.git/HEAD'.length);
  await wipe();
  await mkdirp(DIR);
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const rel = n.slice(prefix.length);
    if (!rel || rel.includes('..')) continue;
    await writeFile(rel, entries[n]);
  }
  if (!(await readMeta())) throw new Error('The repository has no journal.json.');
}

/** Remove the journal directory (one LightningFS instance per page; re-creating it with wipe breaks its lock). */
export async function wipe() {
  const rmrf = async (path: string) => {
    let st;
    try { st = await p().stat(path); } catch { return; }
    if (st.isDirectory()) {
      for (const n of await p().readdir(path)) await rmrf(`${path}/${n}`);
      await p().rmdir(path);
    } else await p().unlink(path);
  };
  await rmrf(DIR);
  for (const k of Object.keys(cache)) delete (cache as Record<string, unknown>)[k];
  await flush();
}

export async function flush() {
  await (fs.promises as unknown as { flush?: () => Promise<void> }).flush?.();
}
