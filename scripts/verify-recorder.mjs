#!/usr/bin/env node
// End-to-end check of the recording page (run `npm run build` first).
// The OpenAI API is replaced by fixed replies from fixtures/ui-fixture/mock-replies.json.
//
//   node scripts/verify-recorder.mjs [--write-fixture] [--python PATH]
//
// --write-fixture  replaces public/sessions/ui-fixture, fixtures/ui-fixture/journal.zip and
//                  fixtures/ui-fixture/build-report.json with what the page produced.
// --python PATH    a Python with zarr + Pillow, to read the browser-built Zarr and PNGs independently.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const writeFixture = args.includes('--write-fixture');
const pyIdx = args.indexOf('--python');
const python = pyIdx >= 0 ? args[pyIdx + 1] : null;

const mock = JSON.parse(await readFile('fixtures/ui-fixture/mock-replies.json', 'utf8'));
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
};
const work = await mkdtemp(path.join(process.env.VERIFY_TMP || tmpdir(), 'rec-'));
const { server, url: base } = await serve('dist');
const browser = await chromium.launch();
const FAKE_KEY = 'test-key-not-a-real-openai-key';

async function newRecorder() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(([k]) => {
    try {
      if (!localStorage.getItem('day10-openai-key')) localStorage.setItem('day10-openai-key', k);
      localStorage.setItem('day10-openai-model', 'fixture-model');
    } catch { /* */ }
  }, [FAKE_KEY]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, errors };
}

async function mockOpenAI(context, replies, captured) {
  let i = 0;
  await context.route('https://api.openai.com/**', async (route) => {
    const req = route.request();
    captured.push({ url: req.url(), auth: req.headers().authorization, body: req.postData() });
    const content = replies[Math.min(i++, replies.length - 1)];
    await route.fulfill({ json: { model: 'fixture-model', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } } });
  });
}

const stepCount = (page) => page.locator('#log > li.step:not(.pending)').count();

async function createJournal(page, id, titleEn, titleJa, kind) {
  await page.goto(`${base}record.html?lang=en`); // redirects to index.html?mode=record
  await page.waitForSelector('#rec-panel[open]');
  await page.click('#j-new');
  await page.fill('#new-form [name=id]', id);
  await page.fill('#new-form [name=titleEn]', titleEn);
  await page.fill('#new-form [name=titleJa]', titleJa);
  await page.selectOption('#new-form [name=kind]', kind);
  await page.click('#new-form button[value=ok]');
  await page.waitForFunction(() => /0 (steps|工程)/.test(document.getElementById('j-info').textContent));
}

const closePanel = async (page) => { if (await page.isVisible('#rec-panel')) await page.click('#rec-close'); };
const openPanel = async (page) => { if (!(await page.isVisible('#rec-panel'))) await page.click('#rec-open'); };

async function send(page, prompt) {
  const before = await stepCount(page);
  await closePanel(page);
  await page.fill('#r-prompt', prompt);
  await page.click('#r-send');
  await page.waitForFunction((n) => !document.getElementById('pending') && document.querySelectorAll('#log > li.step:not(.pending)').length > n, before, { timeout: 30000 });
}

async function saveDownload(page, selector, file) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  await dl.saveAs(file);
  return new Uint8Array(await readFile(file));
}

try {
  // ---- record the fixture through the page ----
  const { context, page, errors } = await newRecorder();
  const captured = [];
  await mockOpenAI(context, mock.steps.map((s) => s.reply), captured);
  await createJournal(page, 'ui-fixture', 'UI fixture (not the production session)', 'UI確認用fixture（本番の制作記録ではありません）', 'fixture');
  await page.setInputFiles('#d-add', 'fixtures/ui-fixture/points.csv');
  await page.waitForSelector('#d-list li');
  await page.fill('#d-list li [name=name]', 'Synthetic points made for the UI fixture (not real data)');
  await page.click('#d-list li button[type=submit]');
  await page.waitForFunction(() => document.getElementById('j-info').textContent.includes('3 commits'));
  for (const s of mock.steps) await send(page, s.prompt);

  const ui = await page.evaluate(() => [...document.querySelectorAll('#log > li.step')].map((li) => ({
    id: li.dataset.stepId, error: !!li.querySelector('.badge.error'), hasCapture: !li.querySelector('.badge.noframe'),
    tool: li.querySelector('.msg.tool .body')?.textContent ?? null,
  })));
  check('five steps committed from five prompts', ui.length === 5, { steps: ui.map((s) => s.id) });
  const expect = [[false, true], [false, true], [true, false], [false, true], [false, false]];
  check('statuses and captures: ok, ok, failed run without capture, ok, no code change without capture',
    ui.every((s, i) => s.error === expect[i][0] && s.hasCapture === expect[i][1]), { ui: ui.map((s) => [s.error, s.hasCapture]) });
  check('failed run keeps the error as a tool message', /pointColour/.test(ui[2].tool ?? ''), { tool: ui[2].tool?.split('\n')[0] });
  check('API requests carry the key only in the Authorization header', captured.length === 5 && captured.every((c) => c.auth === `Bearer ${FAKE_KEY}` && !c.body.includes(FAKE_KEY)), { requests: captured.length });
  const last = JSON.parse(captured[4].body);
  check('requests include system prompt, earlier turns, current code and data summary',
    last.model === 'fixture-model' && last.messages[0].role === 'system' && last.messages.length === 1 + 4 * 2 + 1 + 1
      && last.messages.at(-1).content.includes('Current map/main.js') && last.messages.at(-1).content.includes('data/points.csv'),
    { messages: last.messages.length });

  // ---- the player shows the journal live ----
  {
    const live = await page.evaluate(async () => {
      const s = document.getElementById('stage');
      return { state: s.dataset.state, stepId: s.dataset.stepId, counter: document.getElementById('counter').textContent, ticks: document.querySelectorAll('#ticks .tick').length };
    });
    check('recording mode: timeline and stage follow the journal live', live.ticks === 5 && live.stepId === 's05' && live.state === 'no-capture', live);
    await page.locator('body').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.getElementById('stage').dataset.state === 'ready');
    await page.keyboard.press('c');
    await page.waitForSelector('#stage[data-thumbs=ready]', { timeout: 20000 });
    const layers = await page.evaluate(() => Number(document.querySelector('.stack').dataset.layers));
    check('recording mode: layers view built from the journal', layers === 3, { layers });
    await page.keyboard.press('c');
  }

  // ---- build in the browser ----
  await openPanel(page);
  await page.click('#b-build');
  await page.waitForSelector('#b-preview:not([hidden])', { timeout: 60000 });
  const report = JSON.parse(await page.getAttribute('#b-out', 'data-report'));
  check('build: 3 frames in frames.zarr and thumbs.zarr', report.totals.frames === 3 && report.frames.map((f) => f.stepId).join() === 's01,s02,s04', { frames: report.frames.map((f) => f.stepId) });

  const sessionZip = unzipSync(await saveDownload(page, '#b-download', path.join(work, 'session.zip')));
  const repoZip = await saveDownload(page, '#j-export', path.join(work, 'journal.zip'));
  check('no page errors while recording', errors.length === 0, { errors });

  // ---- the exported repository is ordinary Git ----
  const repoDir = path.join(work, 'repo');
  for (const [name, data] of Object.entries(unzipSync(repoZip))) {
    if (name.endsWith('/')) continue;
    const out = path.join(repoDir, name);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, data);
  }
  const gitDir = path.join(repoDir, 'journal-ui-fixture');
  const log = execFileSync('git', ['-C', gitDir, 'log', '--reverse', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');
  let fsck = 'ok';
  try { execFileSync('git', ['-C', gitDir, 'fsck', '--strict'], { stdio: 'pipe' }); } catch (e) { fsck = String(e.stderr || e); }
  check('exported repository: git log shows setup, data and five step commits', log.length === 8 && log.slice(3).every((m, i) => m.startsWith(`s0${i + 1}:`)), { log });
  check('exported repository passes git fsck --strict', fsck === 'ok', { fsck: fsck.slice(0, 300) });
  const show = execFileSync('git', ['-C', gitDir, 'show', '--format=', '--stat', 'HEAD~1'], { encoding: 'utf8' });
  check('step commit holds the prompt, response, code change, screen SVG and PNG', /map\/main\.js/.test(show) && /steps\/s04\/capture\.png/.test(show) && /steps\/s04\/screen\.svg/.test(show) && /01-user\.md/.test(show) && /02-assistant\.md/.test(show), { stat: show.trim().split('\n').slice(-1)[0] });

  // ---- independent read of the browser-built Zarr and PNGs ----
  const sessDir = path.join(work, 'session');
  for (const [name, data] of Object.entries(sessionZip)) {
    if (name.endsWith('/')) continue;
    const out = path.join(sessDir, name);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, data);
  }
  if (python) {
    const py = `
import hashlib, json, sys, zarr, numpy as np
from PIL import Image
sess, repo, report = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3]))
f = zarr.open_array(sess + '/frames.zarr', mode='r'); t = zarr.open_array(sess + '/thumbs.zarr', mode='r')
out = []
for fr in report['frames']:
    i = fr['frameIndex']
    a = hashlib.sha256(np.ascontiguousarray(f[i]).tobytes()).hexdigest()
    b = hashlib.sha256(np.ascontiguousarray(t[i]).tobytes()).hexdigest()
    p = hashlib.sha256(np.asarray(Image.open(repo + '/' + fr['source']).convert('RGBA')).tobytes()).hexdigest()
    out.append([a == fr['rgbaSha256'], b == fr['thumbRgbaSha256'], p == fr['rgbaSha256']])
print(json.dumps({'shape': list(f.shape), 'tshape': list(t.shape), 'zarr': zarr.__version__, 'ok': out}))
`;
    await writeFile(path.join(work, 'check.py'), py);
    await writeFile(path.join(work, 'report.json'), JSON.stringify(report));
    const r = JSON.parse(execFileSync(python, ['-I', path.join(work, 'check.py'), path.join(sessDir, 'ui-fixture'), gitDir, path.join(work, 'report.json')], { encoding: 'utf8' }));
    check(`zarr-python ${r.zarr} reads the browser-built arrays; hashes match`, r.shape.join() === '3,900,1200,4' && r.tshape.join() === '3,450,600,4' && r.ok.every((x) => x[0] && x[1]), r);
    check('Pillow decodes the committed PNGs to the same RGBA as the browser', r.ok.every((x) => x[2]), { ok: r.ok.map((x) => x[2]) });
  }

  // ---- local preview in the player ----
  {
    const p2 = await context.newPage();
    await p2.goto(`${base}index.html?session=local`);
    await p2.waitForFunction(() => document.getElementById('stage')?.dataset.state !== 'loading', null, { timeout: 20000 });
    const session = JSON.parse(new TextDecoder().decode(sessionZip['ui-fixture/session.json']));
    let ok = true;
    const seen = [];
    for (let i = 0; i < session.steps.length; i++) {
      if (i) { await p2.keyboard.press('ArrowRight'); await p2.waitForFunction(() => document.getElementById('stage').dataset.state !== 'loading'); }
      const st = session.steps[i];
      const info = await p2.evaluate(async () => {
        const s = document.getElementById('stage');
        const cur = document.querySelector('.step.current');
        const c = document.getElementById('frame');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const h = await crypto.subtle.digest('SHA-256', d);
        return { state: s.dataset.state, stepId: s.dataset.stepId, diff: !!cur?.querySelector('details.diff'), sha: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') };
      });
      const want = st.frameIndex === null ? (st.status === 'error' ? 'failed-step' : 'no-capture') : 'ready';
      const shaOk = st.frameIndex === null || info.sha === report.frames[st.frameIndex].rgbaSha256;
      if (info.state !== want || info.stepId === undefined || !shaOk || info.diff !== !!st.codeDiff) ok = false;
      seen.push([st.stepId, info.state, info.diff]);
    }
    check('player previews the local build: states, pixels and code diffs per step', ok, { seen });
    const note = await p2.isVisible('#local-note');
    check('local preview is labelled as not published', note);
    await p2.close();
  }

  // ---- persistence and import ----
  await page.reload();
  const persisted = await page.waitForFunction(() => document.querySelectorAll('#log > li.step').length === 5, null, { timeout: 15000 }).then(() => true, () => false);
  check('journal persists after reload (IndexedDB)', persisted, { steps: await stepCount(page) });
  await context.close();

  {
    const { context: c2, page: p3 } = await newRecorder();
    await p3.goto(`${base}index.html?mode=record&lang=en`);
    await p3.waitForSelector('#rec-panel[open]');
    await p3.setInputFiles('#j-import', path.join(work, 'journal.zip'));
    await p3.waitForFunction(() => document.querySelectorAll('#log > li.step').length === 5);
    check('exported repository imports into a fresh browser profile', true);
    await c2.close();
  }

  // ---- sandbox: model code cannot read the key or reach the network ----
  {
    const { context: c3, page: p4 } = await newRecorder();
    const probe = "Summary (en): probe\nSummary (ja): probe\n```js\nlet k; try { k = String(localStorage.getItem('day10-openai-key')); } catch (e) { k = 'blocked:' + e.name; }\nlet c; try { c = document.cookie; c = 'cookie:' + c; } catch (e) { c = 'blocked:' + e.name; }\nlet f; try { await fetch('https://example.com/'); f = 'fetched'; } catch (e) { f = 'blocked:' + e.name; }\nlet p; try { p = String(parent.document.title); } catch (e) { p = 'blocked:' + e.name; }\nthrow new Error(['probe', k, c, f, p].join('|'));\n```\n";
    await mockOpenAI(c3, [probe], []);
    await createJournal(p4, 'probe', 'probe', 'probe', 'fixture');
    await send(p4, 'probe');
    const tool = await p4.locator('#log > li.step .msg.tool .body').first().textContent();
    const parts = (tool.match(/probe\|([^\n]*)/)?.[1] ?? '').split('|');
    check('sandbox: no access to localStorage, cookies, network or the parent page',
      parts.length === 4 && parts[0].startsWith('blocked') && parts[1].startsWith('blocked') && parts[2].startsWith('blocked') && parts[3].startsWith('blocked') && !tool.includes(FAKE_KEY),
      { probe: parts });
    await c3.close();
  }

  if (writeFixture) {
    await rm('public/sessions/ui-fixture', { recursive: true, force: true });
    for (const [name, data] of Object.entries(sessionZip)) {
      if (name.endsWith('/')) continue;
      const out = name === 'build-report.json' ? 'fixtures/ui-fixture/build-report.json' : path.join('public/sessions', name);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, data);
    }
    await writeFile('fixtures/ui-fixture/journal.zip', repoZip);
    console.log('wrote public/sessions/ui-fixture, fixtures/ui-fixture/journal.zip and build-report.json');
  }

  const out = {
    checkedAt: new Date().toISOString(),
    browser: `chromium ${browser.version()}`,
    note: 'OpenAI API replaced by fixtures/ui-fixture/mock-replies.json',
    sizes: report.totals,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
  await writeFile('docs/verification-recorder.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${out.passed} passed, ${out.failed} failed`);
  process.exitCode = out.failed ? 1 : 0;
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}
