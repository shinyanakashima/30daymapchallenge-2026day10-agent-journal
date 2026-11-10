// Recording mode of the player (?mode=record): prompts go to OpenAI, each step is a Git
// commit in this browser, and the player shows the journal live.
import './polyfill';
import { strFromU8 } from 'fflate';
import type { Host } from '../main';
import { savePreview } from '../local-store';
import type { Session } from '../session';
import { buildSession, collect, sessionObject, zipBuild, type BuildOutput } from './build';
import * as J from './git';
import * as L from './llm';
import { decodePngRgba, encodePngRgba } from './png';
import { HEIGHT, WIDTH, rasterize, runMap } from './sandbox';

const T = {
  en: {
    recorder: 'Recorder', player: 'Player', journal: 'Journal', newJournal: 'New journal', importZip: 'Import repository (.zip)',
    exportZip: 'Export repository (.zip)', deleteJournal: 'Delete journal', sessionId: 'Session ID', titleEn: 'Title (English)',
    titleJa: 'Title (Japanese)', kind: 'Kind', newNote: 'This replaces the journal stored in this browser. Export the current one first if you need it.',
    cancel: 'Cancel', create: 'Create', runCode: 'Run current code', dataFiles: 'Data files',
    dataNote: 'Open data only. Record the source and licence; they are shown under the map.', addData: 'Add data files', model: 'Model',
    saveKey: 'Save key', forgetKey: 'Forget key', loadModels: 'Load models',
    keyNote: 'The key is stored in this browser only and sent only to api.openai.com. It is never written to the journal. Requests are billed to your OpenAI account.',
    send: 'Send', sendHint: 'Ctrl+Enter', manualStep: 'Add a step without the API', prompt: 'Prompt', response: 'Response',
    summaryEn: 'Summary (English)', summaryJa: 'Summary (Japanese)', status: 'Status', capture: 'Screen (SVG, or PNG at 1200×900)',
    codeFile: 'New map/main.js (optional)', commitStep: 'Commit step', publish: 'Build for the player', build: 'Build Zarr and preview',
    openPreview: 'Open preview', downloadSession: 'Download session (.zip)',
    buildNote: 'Everything is built in this browser: session.json from the Git history, frames.zarr and thumbs.zarr from the captures. Put the downloaded folder in public/sessions/ to publish it.',
    noJournal: 'No journal in this browser yet. Create one or import a repository.', commits: 'commits', steps: 'steps',
    thinking: 'Waiting for the model…', running: 'Running the map code…', committing: 'Committing…', needKey: 'Save an OpenAI API key first.',
    needModel: 'Choose a model first.', ranOk: 'Drawn', ranFail: 'Failed', noCapture: 'no capture', saveSource: 'Save', source: 'Source', licence: 'Licence',
    remove: 'Remove', confirmWipe: 'Delete the journal stored in this browser? This cannot be undone.', keySaved: 'Key saved in this browser.',
    keyForgotten: 'Key removed from this browser.', modelsLoaded: 'models', building: 'Building…', blocked: 'Build stopped. Remove these before publishing:',
    addSample: 'Add sample data', sampleNote: 'Sample: Hokkaido municipal boundaries (MLIT N03, CC BY 4.0) and 2025 census population (e-Stat). Joined by code.',
    studio: 'Studio', close: 'Close', noSteps: 'The journal has no steps yet. Send a prompt to start.',
    recordingMode: 'Recording mode — the journal is kept in this browser', modelNone: 'no model selected', openStudio: 'Open the studio to set the key and model',
    keyPh: 'OpenAI API key (sk-…)', promptPh: 'Ask for a change to the map…',
    roles: { user: 'Prompt', assistant: 'Response', tool: 'Tool output', note: 'Note' } as Record<string, string>,
    lastCapture: 'Last capture', liveRun: 'Current code (not committed)', apiError: 'Request failed. Nothing was committed.', copy: 'Copy',
  },
  ja: {
    recorder: '記録ページ', player: '再生ページ', journal: '記録', newJournal: '新しい記録', importZip: 'リポジトリを読み込む（.zip）',
    exportZip: 'リポジトリを書き出す（.zip）', deleteJournal: '記録を削除', sessionId: 'セッションID', titleEn: '題名（英語）',
    titleJa: '題名（日本語）', kind: '種類', newNote: 'このブラウザに保存されている記録を置き換えます。必要なら先に書き出してください。',
    cancel: 'キャンセル', create: '作成', runCode: '今のコードを実行', dataFiles: 'データファイル',
    dataNote: 'オープンデータに限ります。出典とライセンスを記入してください。地図の下に表示されます。', addData: 'データを追加', model: 'モデル',
    saveKey: 'キーを保存', forgetKey: 'キーを消去', loadModels: 'モデル一覧を取得',
    keyNote: 'キーはこのブラウザにだけ保存し、api.openai.com にだけ送ります。記録（Git）には書き込みません。利用料はご自身のOpenAIアカウントに請求されます。',
    send: '送信', sendHint: 'Ctrl+Enter', manualStep: 'APIを使わずに工程を追加', prompt: 'プロンプト', response: '応答',
    summaryEn: '要約（英語）', summaryJa: '要約（日本語）', status: '状態', capture: '画面（SVG、または1200×900のPNG）',
    codeFile: '新しい map/main.js（任意）', commitStep: '工程をコミット', publish: '再生用に書き出す', build: 'Zarrを作成してプレビュー',
    openPreview: 'プレビューを開く', downloadSession: 'セッションをダウンロード（.zip）',
    buildNote: 'すべてこのブラウザ内で作ります。session.json はGitの履歴から、frames.zarr と thumbs.zarr は画面キャプチャから作ります。ダウンロードしたフォルダを public/sessions/ に置くと公開できます。',
    noJournal: 'このブラウザにはまだ記録がありません。新しく作るか、リポジトリを読み込んでください。', commits: 'コミット', steps: '工程',
    thinking: 'モデルの応答を待っています…', running: '地図のコードを実行しています…', committing: 'コミットしています…', needKey: '先にOpenAIのAPIキーを保存してください。',
    needModel: '先にモデルを選んでください。', ranOk: '描画', ranFail: '失敗', noCapture: '画像なし', saveSource: '保存', source: '出典', licence: 'ライセンス',
    remove: '削除', confirmWipe: 'このブラウザに保存されている記録を削除しますか？元に戻せません。', keySaved: 'キーをこのブラウザに保存しました。',
    keyForgotten: 'キーをこのブラウザから消去しました。', modelsLoaded: '個のモデル', building: '作成中…', blocked: '書き出しを止めました。公開前に次を取り除いてください：',
    addSample: 'サンプルデータを追加', sampleNote: 'サンプル：北海道の市町村境界（国土数値情報N03、CC BY 4.0）と2025年国勢調査の人口（e-Stat）。code で結合できます。',
    studio: '制作パネル', close: '閉じる', noSteps: 'まだ工程がありません。プロンプトを送って始めてください。',
    recordingMode: '制作モード：記録はこのブラウザに保存されます', modelNone: 'モデル未選択', openStudio: '制作パネルでキーとモデルを設定',
    keyPh: 'OpenAI APIキー（sk-…）', promptPh: '地図への変更を依頼する…',
    roles: { user: 'プロンプト', assistant: '応答', tool: 'ツール出力', note: 'メモ' } as Record<string, string>,
    lastCapture: '最後のキャプチャ', liveRun: '今のコード（未コミット）', apiError: 'リクエストに失敗しました。コミットはしていません。', copy: 'コピー',
  },
};


const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
let host: Host;
const t = () => T[host.lang()];
let busy = false;
let apiFailed = false;
let lastBuild: BuildOutput | null = null;
const AUTHOR_KEY = 'day10-author';

const PANEL = `
<dialog id="rec-panel" class="rec-panel" aria-labelledby="rp-h">
  <div class="rp-head"><h2 id="rp-h" data-t="studio">Studio</h2><button id="rec-close" type="button" data-t="close">Close</button></div>
  <section>
    <h3 data-t="journal">Journal</h3>
    <p class="j-info" id="j-info"></p>
    <div class="btn-row">
      <button id="j-new" type="button" data-t="newJournal">New journal</button>
      <label class="filebtn"><span data-t="importZip">Import repository (.zip)</span><input id="j-import" type="file" accept=".zip,application/zip"></label>
      <button id="j-export" type="button" data-t="exportZip">Export repository (.zip)</button>
      <button id="j-wipe" type="button" class="danger" data-t="deleteJournal">Delete journal</button>
    </div>
  </section>
  <section>
    <h3 data-t="model">Model</h3>
    <div class="btn-row">
      <input id="s-key" type="password" autocomplete="off" spellcheck="false" data-tp="keyPh" placeholder="OpenAI API key (sk-…)" aria-label="OpenAI API key">
      <button id="s-save" type="button" data-t="saveKey">Save key</button>
      <button id="s-forget" type="button" data-t="forgetKey">Forget key</button>
    </div>
    <div class="btn-row">
      <select id="s-model" aria-label="Model"></select>
      <button id="s-models" type="button" data-t="loadModels">Load models</button>
    </div>
    <p class="note" data-t="keyNote"></p>
    <p class="note mono" id="r-run-status"></p>
  </section>
  <section>
    <h3 data-t="dataFiles">Data files</h3>
    <p class="note" data-t="dataNote"></p>
    <ul id="d-list" class="d-list"></ul>
    <div class="btn-row">
      <label class="filebtn"><span data-t="addData">Add data files</span><input id="d-add" type="file" multiple></label>
      <button id="d-sample" type="button" data-t="addSample">Add sample data</button>
    </div>
    <p class="note" data-t="sampleNote"></p>
  </section>
  <section>
    <h3>map/main.js</h3>
    <div class="btn-row"><button id="r-run" type="button" data-t="runCode">Run current code</button></div>
    <figure class="r-preview"><canvas id="r-canvas" width="1200" height="900"></canvas><figcaption id="r-cap"></figcaption></figure>
    <details class="r-code"><summary>map/main.js</summary><pre id="r-code"></pre></details>
  </section>
  <section>
    <details class="r-manual">
      <summary data-t="manualStep">Add a step without the API</summary>
      <form id="m-form">
        <label><span data-t="prompt">Prompt</span><textarea name="user" rows="3"></textarea></label>
        <label><span data-t="response">Response</span><textarea name="assistant" rows="3"></textarea></label>
        <label><span data-t="summaryEn">Summary (English)</span><input name="summaryEn" required></label>
        <label><span data-t="summaryJa">Summary (Japanese)</span><input name="summaryJa"></label>
        <label><span data-t="status">Status</span><select name="status"><option value="success">success</option><option value="error">error</option></select></label>
        <label><span data-t="capture">Screen</span><input name="capture" type="file" accept="image/png,image/svg+xml,.svg"></label>
        <label><span data-t="codeFile">New map/main.js</span><textarea name="code" rows="4" spellcheck="false"></textarea></label>
        <button type="submit" data-t="commitStep">Commit step</button>
      </form>
    </details>
  </section>
  <section>
    <h3 data-t="publish">Build for the player</h3>
    <div class="btn-row">
      <button id="b-build" type="button" class="primary" data-t="build">Build Zarr and preview</button>
      <a id="b-preview" href="./index.html?session=local" target="_blank" rel="noopener" hidden data-t="openPreview">Open preview</a>
      <button id="b-download" type="button" hidden data-t="downloadSession">Download session (.zip)</button>
    </div>
    <pre id="b-out" class="b-out" hidden></pre>
    <p class="note" data-t="buildNote"></p>
  </section>
</dialog>
<dialog id="new-dialog" class="rec-panel small">
  <form method="dialog" id="new-form">
    <h2 data-t="newJournal">New journal</h2>
    <label><span data-t="sessionId">Session ID</span> <input name="id" required pattern="[A-Za-z0-9._-]+" value="production-2026"></label>
    <label><span data-t="titleEn">Title (English)</span> <input name="titleEn" required></label>
    <label><span data-t="titleJa">Title (Japanese)</span> <input name="titleJa"></label>
    <label><span data-t="kind">Kind</span>
      <select name="kind"><option value="production">production</option><option value="fixture">fixture</option></select>
    </label>
    <p class="note" data-t="newNote"></p>
    <div class="btn-row end"><button value="cancel" formnovalidate data-t="cancel">Cancel</button><button value="ok" class="primary" data-t="create">Create</button></div>
  </form>
</dialog>`;

const COMPOSER = `
<form id="r-chat" class="r-chat">
  <textarea id="r-prompt" rows="3" data-tp="promptPh" placeholder="Ask for a change to the map…" aria-label="Prompt"></textarea>
  <div class="r-chat-row">
    <button id="r-model-line" type="button" class="r-model-line"></button>
    <span id="r-busy" class="r-busy" aria-live="polite"></span>
    <button id="r-send" type="submit" class="primary" data-t="send">Send</button>
  </div>
</form>`;

function author(): J.Author {
  try { const a = JSON.parse(localStorage.getItem(AUTHOR_KEY) ?? 'null'); if (a?.name) return a; } catch { /* */ }
  return { name: 'Map Rewind', email: '' };
}

function setText() {
  const lang = host.lang();
  document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
    if (!el.closest('#rec-panel, #new-dialog, #r-chat, #rec-open')) return;
    const v = T[lang][el.dataset.t as keyof (typeof T)['en']];
    if (typeof v === 'string') el.textContent = v;
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-tp]').forEach((el) => {
    if (el.id === 's-key' && L.loadKey()) return;
    const v = T[lang][el.dataset.tp as keyof (typeof T)['en']];
    if (typeof v === 'string') el.placeholder = v;
  });
  renderModelLine();
}

function renderModelLine() {
  const m = L.loadModel();
  const k = L.loadKey();
  $('r-model-line').textContent = k && m ? `${m} · ${t().studio}` : t().openStudio;
}

function setBusy(text: string) {
  $('r-busy').textContent = text;
  busy = !!text;
  for (const id of ['r-send', 'r-run', 'b-build', 'j-new', 'j-wipe']) ($(id) as HTMLButtonElement).disabled = busy;
}

function show(rgba: Uint8Array | Uint8ClampedArray, caption: string) {
  const ctx = $<HTMLCanvasElement>('r-canvas').getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), WIDTH, HEIGHT), 0, 0);
  $('r-cap').textContent = caption;
}

function blank(caption: string) {
  $<HTMLCanvasElement>('r-canvas').getContext('2d')!.clearRect(0, 0, WIDTH, HEIGHT);
  $('r-cap').textContent = caption;
}

async function dataFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of await J.listFiles('data')) out[p] = strFromU8((await J.readFile(p))!);
  return out;
}

function previewOf(path: string, text: string): string {
  try {
    if (/\.(geo|topo)?json$/i.test(path)) {
      const j = JSON.parse(text);
      if (j.type === 'FeatureCollection') {
        const f = j.features ?? [];
        const keys = f[0]?.properties ? Object.keys(f[0].properties).slice(0, 20).join(', ') : '';
        const geom = [...new Set(f.slice(0, 200).map((x: { geometry?: { type?: string } }) => x.geometry?.type))].join('/');
        const ex = f[0]?.properties ? JSON.stringify(f[0].properties).slice(0, 300) : '';
        return `GeoJSON FeatureCollection, ${f.length} features, geometry ${geom}; properties: ${keys}\nfirst: ${ex}`;
      }
      if (j.type === 'Topology') return `TopoJSON, objects: ${Object.keys(j.objects ?? {}).join(', ')}`;
      return `JSON: ${text.slice(0, 300)}`;
    }
  } catch { /* fall through */ }
  return text.split('\n').slice(0, 4).join('\n').slice(0, 400);
}

async function renderData() {
  const meta = await J.readMeta();
  const list = $('d-list');
  list.replaceChildren();
  if (!meta) return;
  for (const path of await J.listFiles('data')) {
    const size = (await J.readFile(path))!.length;
    const src = meta.dataSources.find((d) => d.path === path);
    const li = document.createElement('li');
    const name = document.createElement('code');
    name.textContent = `${path} (${size.toLocaleString()} B)`;
    const form = document.createElement('form');
    form.className = 'src';
    form.innerHTML = `<input name="name" placeholder="${t().source}"><input name="license" placeholder="${t().licence}"><input name="url" type="url" placeholder="https://…"><button type="submit">${t().saveSource}</button><button type="button" class="rm">${t().remove}</button>`;
    (form.elements.namedItem('name') as HTMLInputElement).value = src?.name[host.lang()] ?? src?.name.en ?? '';
    (form.elements.namedItem('license') as HTMLInputElement).value = src?.license ?? '';
    (form.elements.namedItem('url') as HTMLInputElement).value = src?.url ?? '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const m = (await J.readMeta())!;
      const entry = { path, name: { en: String(fd.get('name')), ja: String(fd.get('name')) }, license: String(fd.get('license')) || null, url: String(fd.get('url')) || null };
      m.dataSources = [...m.dataSources.filter((d) => d.path !== path), entry];
      await J.writeMeta(m);
      await J.commitAll(`Data source: ${path}`, author());
      await refresh('keep');
    });
    form.querySelector('.rm')!.addEventListener('click', async () => {
      await J.deleteFile(path);
      const m = (await J.readMeta())!;
      m.dataSources = m.dataSources.filter((d) => d.path !== path);
      await J.writeMeta(m);
      await J.commitAll(`Remove data: ${path}`, author());
      await refresh('keep');
    });
    li.append(name, form);
    list.append(li);
  }
}


type SampleSources = { files: { path: string; source: { name: { en: string; ja: string }; license: string; url: string } }[] };

/** Copy the bundled sample (public/samples/hokkaido-2025) into data/ with its sources. */
async function addSample() {
  const base = new URL(`${import.meta.env.BASE_URL}samples/hokkaido-2025/`, location.href);
  const src = (await (await fetch(new URL('sources.json', base))).json()) as SampleSources;
  const meta = (await J.readMeta())!;
  for (const f of src.files) {
    const res = await fetch(new URL(f.path, base));
    if (!res.ok) throw new Error(`${f.path}: ${res.status}`);
    const path = `data/${f.path}`;
    await J.writeFile(path, new Uint8Array(await res.arrayBuffer()));
    meta.dataSources = [...meta.dataSources.filter((d) => d.path !== path), { path, name: f.source.name, license: f.source.license, url: f.source.url }];
  }
  await J.writeMeta(meta);
  await J.commitAll('Add sample data: Hokkaido municipalities and 2025 census population', author());
}

/** Re-read the journal and hand it to the player. */
async function refresh(pick: 'first' | 'last' | 'keep') {
  const has = await J.hasRepo();
  const meta = has ? await J.readMeta() : null;
  for (const id of ['j-export', 'j-wipe', 'b-build', 'r-send', 'r-run']) $(id).toggleAttribute('disabled', !meta);
  if (!meta) {
    $('j-info').textContent = t().noJournal;
    $('d-list').replaceChildren();
    $('r-code').textContent = '';
    host.empty(t().noJournal);
    return;
  }
  const c = await collect();
  const commits = await J.history();
  $('j-info').textContent = `${meta.title[host.lang()] || meta.title.en} · ${meta.id} · ${meta.kind} · ${c?.steps.length ?? 0} ${t().steps} · ${commits.length} ${t().commits}`;
  $('r-code').textContent = (await J.readText('map/main.js')) ?? '';
  await renderData();
  if (!c || !c.steps.length) {
    host.empty(t().noSteps);
    return;
  }
  const frames = c.frames;
  const thumbs = c.thumbs;
  host.apply(
    sessionObject(c) as unknown as Session,
    { has: (i) => i >= 0 && i < frames.length, get: async (i) => frames[i] },
    async () => ({ data: thumbs, width: WIDTH / 2, height: HEIGHT / 2 }),
    pick,
  );
}

// ---------- running and the model ----------

async function runCurrent(code: string): Promise<{ ok: true; rgba: Uint8ClampedArray; png: Uint8Array; svg: string } | { ok: false; error: string }> {
  const r = await runMap(code, await dataFiles());
  if (!r.ok) return { ok: false, error: r.error + (r.logs.length ? `\n${r.logs.slice(-10).join('\n')}` : '') };
  try {
    const rgba = await rasterize(r.svg);
    return { ok: true, rgba, png: encodePngRgba(WIDTH, HEIGHT, rgba), svg: r.svg };
  } catch (e) {
    return { ok: false, error: `Could not rasterise the SVG: ${(e as Error).message}` };
  }
}

function nextStepId(steps: { stepId: string }[]): string {
  const used = new Set(steps.map((s) => s.stepId));
  let n = steps.length + 1;
  let id = `s${String(n).padStart(2, '0')}`;
  while (used.has(id)) id = `s${String(++n).padStart(2, '0')}`;
  return id;
}

async function sendPrompt(prompt: string) {
  const key = L.loadKey();
  if (!key) { alert(t().needKey); return; }
  const model = ($('s-model') as HTMLSelectElement).value;
  if (!model) { alert(t().needModel); return; }
  const c = await collect();
  if (!c) return;
  const steps = c.steps;
  const system = (await J.readText('prompts/system.md')) ?? L.SYSTEM_PROMPT;
  const code = (await J.readText('map/main.js')) ?? '';
  const files = await dataFiles();
  const history: L.ChatMessage[] = [{ role: 'system', content: system }];
  for (const s of steps) {
    for (const m of s.messages) {
      if (m.role === 'user') history.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') history.push({ role: 'assistant', content: L.shortenCode(m.content) });
      else if (m.role === 'tool') history.push({ role: 'user', content: `Result of running the code:\n${m.content}` });
    }
  }
  history.push({ role: 'user', content: L.contextMessage(prompt, code, Object.entries(files).map(([path, text]) => ({ path, size: text.length, preview: previewOf(path, text) }))) });

  setBusy(t().thinking);
  host.pending(prompt, t().thinking);
  let reply: L.ChatResult;
  try {
    reply = await L.chat(key, model, history);
  } catch (e) {
    setBusy('');
    host.pending('', '');
    $('r-busy').textContent = `${t().apiError} ${(e as Error).message}`;
    apiFailed = true;
    return;
  }
  const parsed = L.parseReply(reply.content);
  const messages: J.NewStep['messages'] = [
    { role: 'user', content: prompt },
    { role: 'assistant', content: reply.content, model: reply.model },
  ];
  let status: 'success' | 'error' = 'success';
  let capturePng: Uint8Array | null = null;
  let screenSvg: string | null = null;
  const filesOut: Record<string, string> = {};
  let summary = { en: parsed.summaryEn ?? prompt.slice(0, 80), ja: parsed.summaryJa ?? parsed.summaryEn ?? prompt.slice(0, 80) };
  if (parsed.code) {
    filesOut['map/main.js'] = parsed.code;
    setBusy(t().running);
    host.pending(prompt, t().running);
    const run = await runCurrent(parsed.code);
    if (run.ok) {
      capturePng = run.png;
      screenSvg = run.svg;

    } else {
      status = 'error';
      messages.push({ role: 'tool', label: 'run', content: run.error });
      const first = run.error.split('\n')[0].slice(0, 120);
      summary = { en: `Run failed: ${first}`, ja: `実行に失敗：${first}` };

    }
  }
  setBusy(t().committing);
  await J.commitStep({
    stepId: nextStepId(steps),
    status,
    changeSummary: summary,
    messages,
    capturePng,
    screenSvg,
    files: filesOut,
    llm: { provider: 'OpenAI', model: reply.model, usage: reply.usage },
  }, author());
  setBusy('');
  await refresh('last');
}

async function commitManual(form: HTMLFormElement) {
  const fd = new FormData(form);
  const steps = (await collect())?.steps ?? [];
  const messages: J.NewStep['messages'] = [];
  const user = String(fd.get('user') ?? '').trim();
  const assistant = String(fd.get('assistant') ?? '').trim();
  if (user) messages.push({ role: 'user', content: user });
  if (assistant) messages.push({ role: 'assistant', content: assistant });
  if (!messages.length) { alert(`${t().prompt} / ${t().response}`); return; }
  const file = fd.get('capture') as File | null;
  let capturePng: Uint8Array | null = null;
  let screenSvg: string | null = null;
  if (file && file.size) {
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
      screenSvg = await file.text();
      capturePng = encodePngRgba(WIDTH, HEIGHT, await rasterize(screenSvg));
    } else {
      capturePng = new Uint8Array(await file.arrayBuffer());
      const img = decodePngRgba(capturePng);
      if (img.width !== WIDTH || img.height !== HEIGHT) { alert(`${img.width}×${img.height} ≠ ${WIDTH}×${HEIGHT}`); return; }
    }
  }
  const code = String(fd.get('code') ?? '');
  const en = String(fd.get('summaryEn'));
  await J.commitStep({
    stepId: nextStepId(steps),
    status: fd.get('status') === 'error' ? 'error' : 'success',
    changeSummary: { en, ja: String(fd.get('summaryJa') || en) },
    messages,
    capturePng,
    screenSvg,
    files: code.trim() ? { 'map/main.js': code.endsWith('\n') ? code : code + '\n' } : {},
  }, author());
  form.reset();
  await refresh('last');
}

// ---------- build ----------

async function build() {
  setBusy(t().building);
  const out = $('b-out');
  out.hidden = false;
  out.textContent = t().building;
  try {
    const b = await buildSession();
    if (b.problems.length) {
      out.textContent = `${t().blocked}\n${b.problems.map((p) => `- ${p}`).join('\n')}`;
      lastBuild = null;
      $('b-preview').hidden = true;
      $('b-download').hidden = true;
      return;
    }
    await savePreview(b.files);
    lastBuild = b;
    const r = b.report;
    out.textContent = [
      `${b.id}: ${r.totals.frames} frames`,
      `raw ${r.totals.rawBytes.toLocaleString()} B → frames.zarr ${r.totals.chunkBytes.toLocaleString()} B (PNG ${r.totals.pngBytes.toLocaleString()} B), thumbs.zarr ${r.totals.thumbChunkBytes.toLocaleString()} B`,
      ...r.frames.map((f) => `frame ${f.frameIndex} ${f.stepId} rgba sha256 ${f.rgbaSha256.slice(0, 16)}…`),
    ].join('\n');
    out.dataset.report = JSON.stringify(r);
    $('b-preview').hidden = false;
    $('b-download').hidden = false;
  } catch (e) {
    out.textContent = String((e as Error).message);
  } finally {
    setBusy('');
  }
}

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- settings ----------

function renderModels(ids: string[]) {
  const sel = $<HTMLSelectElement>('s-model');
  const saved = L.loadModel();
  const all = [...new Set([...(saved ? [saved] : []), ...ids])];
  sel.replaceChildren(...all.map((id) => Object.assign(document.createElement('option'), { value: id, textContent: id })));
  if (saved) sel.value = saved;
}

const STARTER = `// Step 0: an empty frame. The model replaces this file at each step.
svg.append('rect').attr('width', width).attr('height', height).attr('fill', '#f4f1ea');
`;

function bind() {
  $('j-new').addEventListener('click', () => $<HTMLDialogElement>('new-dialog').showModal());
  $('new-form').addEventListener('submit', async (e) => {
    const f = e.target as HTMLFormElement;
    if ((e as SubmitEvent).submitter?.getAttribute('value') !== 'ok') return;
    const fd = new FormData(f);
    const en = String(fd.get('titleEn'));
    await J.initJournal({
      schemaVersion: 1,
      id: String(fd.get('id')),
      kind: fd.get('kind') === 'fixture' ? 'fixture' : 'production',
      title: { en, ja: String(fd.get('titleJa') || en) },
      recording: fd.get('kind') === 'fixture' ? {
        en: 'UI fixture for testing the player. Built on the recording page with fixed placeholder replies in place of the OpenAI API. The screens are real renders of that code; the conversation is not a recorded AI session.',
        ja: '再生UIの確認用です。記録ページで、OpenAI APIの代わりに用意した仮の応答を使って作りました。画面はそのコードを実際に描画したものですが、会話はAIとの実際の記録ではありません。',
      } : {
        en: 'Made on the Map Rewind recording page. Each step is a Git commit made in the browser. Requests to the model include the system prompt in prompts/system.md, the conversation so far, the current map code and a summary of the data files. Screens were drawn by the model\'s code in a sandbox and captured at 1200×900.',
        ja: 'Map Rewind の記録ページで制作。各工程はブラウザ内でGitにコミットした。モデルへの依頼には、prompts/system.md の指示、それまでの対話、現在の地図コード、データファイルの概要を含めた。画面はモデルが書いたコードを隔離した環境で描画し、1200×900で撮影した。',
      },
      dataSources: [],
    }, L.SYSTEM_PROMPT, STARTER, author());
    await refresh('last');
  });
  $('j-import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    try {
      await J.importZip(new Uint8Array(await f.arrayBuffer()));
    } catch (err) {
      alert((err as Error).message);
    }
    input.value = '';
    await refresh('last');
  });
  $('j-export').addEventListener('click', async () => {
    const meta = await J.readMeta();
    download(await J.exportZip(`journal-${meta?.id ?? 'map'}`), `journal-${meta?.id ?? 'map'}.zip`);
  });
  $('j-wipe').addEventListener('click', async () => {
    if (!confirm(t().confirmWipe)) return;
    await J.wipe();
    await refresh('last');
  });
  $('d-add').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    for (const f of Array.from(input.files ?? [])) {
      const name = f.name.replace(/[^A-Za-z0-9._-]/g, '_');
      await J.writeFile(`data/${name}`, new Uint8Array(await f.arrayBuffer()));
      await J.commitAll(`Add data: data/${name}`, author());
    }
    input.value = '';
    await refresh('last');
  });
  $('r-run').addEventListener('click', async () => {
    setBusy(t().running);
    const r = await runCurrent((await J.readText('map/main.js')) ?? '');
    setBusy('');
    if (r.ok) { show(r.rgba, t().liveRun); $('r-run-status').textContent = t().ranOk; }
    else { blank(''); $('r-run-status').textContent = `${t().ranFail}: ${r.error}`; }
  });
  $('s-key').addEventListener('input', () => undefined);
  $('s-save').addEventListener('click', () => {
    const v = $<HTMLInputElement>('s-key').value.trim();
    if (!v) return;
    L.saveKey(v);
    $<HTMLInputElement>('s-key').value = '';
    $<HTMLInputElement>('s-key').placeholder = '••••••••' + v.slice(-4);
    $('r-run-status').textContent = t().keySaved;
  });
  $('s-forget').addEventListener('click', () => {
    L.forgetKey();
    $<HTMLInputElement>('s-key').placeholder = t().keyPh;
    $('r-run-status').textContent = t().keyForgotten;
  });
  $('s-models').addEventListener('click', async () => {
    const key = L.loadKey();
    if (!key) { alert(t().needKey); return; }
    try {
      const ids = await L.listModels(key);
      renderModels(ids);
      $('r-run-status').textContent = `${ids.length} ${t().modelsLoaded}`;
    } catch (e) {
      $('r-run-status').textContent = (e as Error).message;
    }
  });
  $('s-model').addEventListener('change', () => { L.saveModel($<HTMLSelectElement>('s-model').value); renderModelLine(); });
  $('d-sample').addEventListener('click', async () => {
    setBusy(t().building);
    try {
      await addSample();
    } catch (e) {
      $('r-run-status').textContent = (e as Error).message;
    } finally {
      setBusy('');
    }
    await refresh('keep');
  });
  $('rec-open').addEventListener('click', () => $<HTMLDialogElement>('rec-panel').showModal());
  $('rec-close').addEventListener('click', () => $<HTMLDialogElement>('rec-panel').close());
  $('r-model-line').addEventListener('click', () => $<HTMLDialogElement>('rec-panel').showModal());
  $('r-chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const ta = $<HTMLTextAreaElement>('r-prompt');
    const prompt = ta.value.trim();
    if (!prompt) return;
    apiFailed = false;
    await sendPrompt(prompt);
    if (!apiFailed) ta.value = '';
  });
  $('r-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $<HTMLFormElement>('r-chat').requestSubmit(); }
  });
  $('m-form').addEventListener('submit', async (e) => { e.preventDefault(); await commitManual(e.target as HTMLFormElement); });
  $('b-build').addEventListener('click', () => void build());
  $('b-download').addEventListener('click', () => { if (lastBuild) download(zipBuild(lastBuild), `session-${lastBuild.id}.zip`); });
}


export async function startRecorder(h: Host) {
  host = h;
  document.body.insertAdjacentHTML('beforeend', PANEL);
  host.sideBottom.innerHTML = COMPOSER;
  const open = document.createElement('button');
  open.id = 'rec-open';
  open.type = 'button';
  open.className = 'rec-open';
  open.dataset.t = 'studio';
  host.headerTools.append(open);
  setText();
  bind();
  host.onLang(() => { setText(); void refresh('keep'); });
  const k = L.loadKey();
  if (k) $<HTMLInputElement>('s-key').placeholder = '••••••••' + k.slice(-4);
  renderModels([]);
  renderModelLine();
  await refresh('last');
  if (!(await J.hasRepo())) $<HTMLDialogElement>('rec-panel').showModal();
}
