import { FrameSource } from './frames';
import { t } from './i18n';
import { loadSession, type Lang, type Session, type Step } from './session';

const REPO_URL = 'https://github.com/shinyanakashima/30daymapchallenge-2026day10-agent-journal';
const PLAY_INTERVAL_MS = 2200;
const SCRUB_SETTLE_MS = 90;

type StageState = 'loading' | 'ready' | 'failed-step' | 'no-capture' | 'decode-error' | 'session-error';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const stage = $('stage');
const canvas = $<HTMLCanvasElement>('frame');
const ctx = canvas.getContext('2d', { alpha: true })!;
const stageMsg = $('stage-msg');
const stageCap = $('stage-cap');
const log = $<HTMLOListElement>('log');
const scrub = $<HTMLInputElement>('scrub');
const ticks = $('ticks');
const counter = $('counter');
const prevBtn = $<HTMLButtonElement>('prev');
const nextBtn = $<HTMLButtonElement>('next');
const playBtn = $<HTMLButtonElement>('play');
const langBtn = $<HTMLButtonElement>('lang');

const params = new URLSearchParams(location.search);
let lang: Lang = pickLang();
let session: Session | null = null;
let frames: FrameSource | null = null;
let current = 0;
let lastDirection = 1;
let playing = false;
let playTimer: number | undefined;
let settleTimer: number | undefined;
let loadSeq = 0;
let loadCtrl: AbortController | null = null;
let stepEls: HTMLLIElement[] = [];

function pickLang(): Lang {
  const q = params.get('lang');
  if (q === 'en' || q === 'ja') return q;
  try {
    const s = localStorage.getItem('day10-lang');
    if (s === 'en' || s === 'ja') return s;
  } catch { /* storage unavailable */ }
  return 'en';
}

function setStage(state: StageState, step: Step | null, text = '', retry = false) {
  stage.dataset.state = state;
  stage.dataset.stepId = step?.stepId ?? '';
  stage.dataset.status = step?.status ?? '';
  stage.dataset.frameIndex = step?.frameIndex == null ? '' : String(step.frameIndex);
  stageMsg.replaceChildren();
  if (text) {
    const p = document.createElement('p');
    p.textContent = text;
    stageMsg.append(p);
  }
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(lang).retry;
    b.addEventListener('click', () => showFrame(current));
    stageMsg.append(b);
  }
}

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function draw(data: Uint8Array) {
  const img = new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength), canvas.width, canvas.height);
  ctx.putImageData(img, 0, 0);
}

function select(i: number, opts: { settle?: boolean } = {}) {
  if (!session) return;
  const n = session.steps.length;
  const next = Math.max(0, Math.min(n - 1, i));
  if (next !== current) lastDirection = next > current ? 1 : -1;
  current = next;
  renderControls();
  renderLog();
  window.clearTimeout(settleTimer);
  if (opts.settle) {
    // While the timeline is being dragged, show the loading state right away
    // and fetch only once the pointer pauses.
    const step = session.steps[current];
    if (step.frameIndex !== null && !frames?.has(step.frameIndex)) {
      loadSeq++;
      loadCtrl?.abort();
      clearCanvas();
      setStage('loading', step, t(lang).loading);
      settleTimer = window.setTimeout(() => showFrame(current), SCRUB_SETTLE_MS);
      return;
    }
  }
  showFrame(current);
}

async function showFrame(i: number) {
  if (!session) return;
  const seq = ++loadSeq;
  loadCtrl?.abort();
  const ctrl = new AbortController();
  loadCtrl = ctrl;
  const step = session.steps[i];
  const s = t(lang);
  canvas.setAttribute('aria-label', `${s.step} ${i + 1}: ${step.changeSummary[lang]}`);
  stageCap.textContent = `${s.step} ${i + 1} · ${step.changeSummary[lang]}`;

  if (step.frameIndex === null || !frames) {
    clearCanvas();
    if (step.status === 'error') setStage('failed-step', step, s.noCaptureError);
    else setStage('no-capture', step, s.noCapture);
    afterShown(seq);
    return;
  }
  if (!frames.has(step.frameIndex)) {
    clearCanvas();
    setStage('loading', step, s.loading);
  }
  try {
    const data = await frames.get(step.frameIndex, ctrl.signal);
    if (seq !== loadSeq) return; // a newer selection owns the stage
    draw(data);
    setStage('ready', step);
  } catch (err) {
    if (seq !== loadSeq || ctrl.signal.aborted) return;
    console.error(err);
    clearCanvas();
    setStage('decode-error', step, s.decodeError, true);
  }
  afterShown(seq);
  prefetchAdjacent(i);
}

function prefetchAdjacent(i: number) {
  if (!session || !frames) return;
  const dir = playing ? 1 : lastDirection;
  const adj = session.steps[i + dir];
  if (adj?.frameIndex != null && !frames.has(adj.frameIndex)) {
    frames.get(adj.frameIndex).catch(() => { /* shown as an error if that step is selected */ });
  }
}

function afterShown(seq: number) {
  if (!playing || !session || seq !== loadSeq) return;
  window.clearTimeout(playTimer);
  playTimer = window.setTimeout(() => {
    if (!playing || seq !== loadSeq) return;
    if (current >= session!.steps.length - 1) setPlaying(false);
    else select(current + 1);
  }, PLAY_INTERVAL_MS);
}

function setPlaying(on: boolean) {
  if (on === playing) return;
  playing = on;
  window.clearTimeout(playTimer);
  renderControls();
  if (on && session) {
    if (current >= session.steps.length - 1) select(0);
    else afterShown(loadSeq);
  }
}

function renderControls() {
  if (!session) return;
  const s = t(lang);
  const n = session.steps.length;
  scrub.max = String(n - 1);
  scrub.value = String(current);
  const step = session.steps[current];
  scrub.setAttribute('aria-valuetext', `${s.step} ${current + 1} ${s.of} ${n}: ${step.changeSummary[lang]}`);
  counter.textContent = `${s.step} ${current + 1} ${s.of} ${n}`;
  prevBtn.disabled = current === 0;
  nextBtn.disabled = current === n - 1;
  playBtn.setAttribute('aria-pressed', String(playing));
  playBtn.setAttribute('aria-label', playing ? s.pause : s.play);
  playBtn.textContent = playing ? '❚❚' : '▶';
  for (const [k, el] of Array.from(ticks.children).entries()) el.classList.toggle('on', k === current);
}

function stepBadges(step: Step): HTMLElement[] {
  const s = t(lang);
  const out: HTMLElement[] = [];
  const st = document.createElement('span');
  st.className = `badge ${step.status}`;
  st.textContent = step.status === 'error' ? s.error : s.success;
  out.push(st);
  if (step.frameIndex === null) {
    const nf = document.createElement('span');
    nf.className = 'badge noframe';
    nf.textContent = s.noFrame;
    out.push(nf);
  }
  return out;
}

function fmtTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function buildLog() {
  if (!session) return;
  const s = t(lang);
  stepEls = session.steps.map((step, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.stepId = step.stepId;
    const head = document.createElement('div');
    head.className = 'step-head';
    const num = document.createElement('button');
    num.type = 'button';
    num.className = 'step-num';
    num.textContent = `${s.step} ${i + 1}`;
    num.addEventListener('click', () => { setPlaying(false); select(i); });
    head.append(num, ...stepBadges(step));
    const time = fmtTime(step.timestamp);
    if (time) {
      const tm = document.createElement('time');
      tm.dateTime = step.timestamp!;
      tm.textContent = time;
      head.append(tm);
    }
    const sum = document.createElement('p');
    sum.className = 'summary';
    sum.textContent = step.changeSummary[lang];
    if (step.revision) {
      const rev = document.createElement('code');
      rev.className = 'rev';
      rev.textContent = step.revision.slice(0, 7);
      sum.append(' ', rev);
    }
    const msgs = document.createElement('div');
    msgs.className = 'msgs';
    for (const m of step.messages) {
      const box = document.createElement('div');
      box.className = `msg ${m.role}`;
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = s.roles[m.role] + (m.label ? ` · ${m.label}` : '') + (m.model ? ` · ${m.model}` : '');
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = m.content;
      box.append(who, body);
      msgs.append(box);
    }
    li.append(head, sum, msgs);
    return li;
  });
  log.replaceChildren(...stepEls);

  ticks.replaceChildren(...session.steps.map((step, i) => {
    const b = document.createElement('span');
    b.className = `tick ${step.status}${step.frameIndex === null ? ' noframe' : ''}`;
    b.title = `${s.step} ${i + 1}`;
    b.addEventListener('click', () => { setPlaying(false); select(i); });
    return b;
  }));
}

function renderLog() {
  stepEls.forEach((el, i) => {
    el.hidden = i > current;
    el.classList.toggle('current', i === current);
    if (i === current) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
  const el = stepEls[current];
  if (el) {
    const side = $('side');
    // Keep the current step in view inside the conversation pane only.
    const top = el.offsetTop - log.offsetTop;
    if (side.scrollHeight > side.clientHeight) side.scrollTop = Math.max(0, top - 8);
  }
}

function renderStatic() {
  const s = t(lang);
  document.documentElement.lang = lang;
  langBtn.textContent = s.lang;
  langBtn.lang = lang === 'en' ? 'ja' : 'en';
  langBtn.setAttribute('aria-label', s.langLabel);
  prevBtn.setAttribute('aria-label', s.prev);
  nextBtn.setAttribute('aria-label', s.next);
  prevBtn.textContent = '‹';
  nextBtn.textContent = '›';
  scrub.setAttribute('aria-label', s.timeline);
  $('controls').setAttribute('aria-label', s.timeline);
  $('side-h').textContent = s.conversation;
  if (!session) return;
  $('title').textContent = session.title[lang];
  const fixture = $('fixture');
  fixture.hidden = session.kind !== 'fixture';
  fixture.textContent = s.fixture;
  renderFooter();
  buildLog();
  renderControls();
  renderLog();
}

function renderFooter() {
  if (!session) return;
  const s = t(lang);
  const foot = $('foot');
  const line = (label: string, ...content: (string | Node)[]) => {
    const p = document.createElement('p');
    const b = document.createElement('strong');
    b.textContent = `${label}: `;
    p.append(b, ...content);
    return p;
  };
  const data: (string | Node)[] = [];
  session.dataSources.forEach((d, k) => {
    if (k) data.push('; ');
    const name = typeof d.name === 'string' ? d.name : d.name[lang];
    if (d.url) {
      const a = document.createElement('a');
      a.href = d.url;
      a.textContent = name;
      data.push(a);
    } else data.push(name);
    if (d.license) data.push(` (${d.license})`);
  });
  const m = session.model;
  const model = m && (m.name || m.provider) ? [m.provider, m.name].filter(Boolean).join(' ') + (m.notes ? ` — ${m.notes}` : '') : s.unknownModel;
  const src = document.createElement('a');
  src.href = REPO_URL;
  src.textContent = s.source;
  foot.replaceChildren(
    line(s.recording, session.recording[lang], ' ', s.frameNote),
    line(s.data, ...data),
    line(s.model, model),
    Object.assign(document.createElement('p'), { className: 'keys', textContent: s.keys }),
    (() => { const p = document.createElement('p'); p.append(src); return p; })(),
  );
}

function bind() {
  prevBtn.addEventListener('click', () => { setPlaying(false); select(current - 1); });
  nextBtn.addEventListener('click', () => { setPlaying(false); select(current + 1); });
  playBtn.addEventListener('click', () => setPlaying(!playing));
  scrub.addEventListener('input', () => {
    const value = Number(scrub.value); // read before setPlaying re-renders the slider
    setPlaying(false);
    select(value, { settle: true });
  });
  langBtn.addEventListener('click', () => {
    lang = lang === 'en' ? 'ja' : 'en';
    try { localStorage.setItem('day10-lang', lang); } catch { /* ignore */ }
    renderStatic();
    if (session) showFrame(current);
  });
  document.addEventListener('keydown', (e) => {
    if (!session || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('textarea, input:not([type=range]), select, [contenteditable]')) return;
    const onRange = target === scrub;
    const onButton = target.tagName === 'BUTTON';
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown':
        if (onRange) return;
        e.preventDefault(); setPlaying(false); select(current + 1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        if (onRange) return;
        e.preventDefault(); setPlaying(false); select(current - 1); break;
      case 'Home':
        if (onRange) return;
        e.preventDefault(); setPlaying(false); select(0); break;
      case 'End':
        if (onRange) return;
        e.preventDefault(); setPlaying(false); select(session.steps.length - 1); break;
      case ' ': case 'k':
        if (onButton) return;
        e.preventDefault(); setPlaying(!playing); break;
    }
  });
}

async function init() {
  renderStatic();
  bind();
  setStage('loading', null, t(lang).loadingSession);
  const base = new URL(import.meta.env.BASE_URL, location.href);
  try {
    const { session: s, url } = await loadSession(base, params.get('session'));
    session = s;
    if (s.frames.path && s.frames.count > 0) {
      frames = new FrameSource(new URL(s.frames.path, url), s.viewport.width, s.viewport.height);
    }
    app.dataset.state = 'ready';
    renderStatic();
    const startId = params.get('step');
    const start = startId ? s.steps.findIndex((st) => st.stepId === startId) : 0;
    select(Math.max(0, start));
  } catch (err) {
    console.error(err);
    app.dataset.state = 'error';
    clearCanvas();
    setStage('session-error', null, `${t(lang).sessionError} ${(err as Error).message}`);
  }
}

init();
