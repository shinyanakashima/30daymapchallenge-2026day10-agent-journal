#!/usr/bin/env node
// Browser checks for the built player (run `npm run build` first).
// Usage: node scripts/verify-browser.mjs [sessionId] [--source fixtures/ui-fixture]
// Writes docs/verification.json and exits non-zero on any failed check.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const srcIdx = args.indexOf('--source');
const sourceDir = srcIdx >= 0 ? args.splice(srcIdx, 2)[1] : 'fixtures/ui-fixture';
const shotDir = process.env.VERIFY_SHOTS || null;
const sessionId = args[0] || 'ui-fixture';

const session = JSON.parse(await readFile(`dist/sessions/${sessionId}/session.json`, 'utf8'));
const report = JSON.parse(await readFile(`${sourceDir}/build-report.json`, 'utf8'));
const hashByFrame = new Map(report.frames.map((f) => [f.frameIndex, f.rgbaSha256]));
const steps = session.steps;
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
};

const { server, url: base } = await serve('dist');
const browser = await chromium.launch();
const isChunk = (u) => /\/frames\.zarr\/c\//.test(u);
const chunkIndex = (u) => Number(u.match(/\/frames\.zarr\/c\/(\d+)\//)[1]);

async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, ...opts });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, requests, errors };
}

const settled = (page) => page.waitForFunction(() => {
  const s = document.getElementById('stage');
  return s && s.dataset.state && s.dataset.state !== 'loading';
}, null, { timeout: 15000 });

const canvasHash = (page) => page.evaluate(async () => {
  const c = document.getElementById('frame');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const h = await crypto.subtle.digest('SHA-256', d);
  return { w: c.width, h: c.height, sha: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') };
});

const stageInfo = (page) => page.evaluate(() => {
  const s = document.getElementById('stage');
  const cur = document.querySelector('.step.current');
  const visible = [...document.querySelectorAll('.step')].filter((e) => !e.hidden).length;
  return {
    state: s.dataset.state,
    stepId: s.dataset.stepId,
    frameIndex: s.dataset.frameIndex,
    logStepId: cur?.dataset.stepId,
    visibleSteps: visible,
    lastMsg: cur ? [...cur.querySelectorAll('.msg .body')].at(-1)?.textContent : null,
    scrub: Number(document.getElementById('scrub').value),
  };
});

const expectedState = (st) => (st.frameIndex === null ? (st.status === 'error' ? 'failed-step' : 'no-capture') : 'ready');

try {
  // 1. Initial load
  {
    const { context, page, requests, errors } = await newPage();
    await page.goto(base);
    await settled(page);
    const info = await stageInfo(page);
    await page.waitForTimeout(400); // allow the adjacent prefetch to start
    const chunks = [...new Set(requests.filter(isChunk).map(chunkIndex))];
    const codecChunks = requests.filter((u) => /\/assets\/(zstd|blosc|lz4)-/.test(u));
    check('initial load shows first step', info.state === expectedState(steps[0]) && info.stepId === steps[0].stepId, info);
    check('initial load fetches only first frame and one neighbour', chunks.length <= 2 && chunks.includes(steps[0].frameIndex ?? 0), { chunks });
    check('unused codecs are not downloaded', codecChunks.length === 0, { codecChunks });
    check('no page errors on load', errors.length === 0, { errors });
    await context.close();
  }

  // 2. Pixel round-trip for first, middle and last frames (deep link by stepId)
  {
    const n = report.frames.length;
    const picks = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    for (const fi of picks) {
      const fr = report.frames[fi];
      const { context, page } = await newPage();
      await page.goto(`${base}?step=${encodeURIComponent(fr.stepId)}`);
      await settled(page);
      const hash = await canvasHash(page);
      check(`frame ${fi} (${fr.stepId}) RGBA hash and size match original PNG`, hash.sha === fr.rgbaSha256 && hash.w === fr.width && hash.h === fr.height, { browser: hash.sha.slice(0, 16), original: fr.rgbaSha256.slice(0, 16), size: `${hash.w}x${hash.h}` });
      await context.close();
    }
  }

  // 3. Step-by-step alignment + 4. network per move
  {
    const { context, page, requests } = await newPage();
    await page.goto(base);
    await settled(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    let allAligned = true;
    const perMove = [];
    for (let i = 0; i < steps.length; i++) {
      if (i > 0) {
        const before = requests.length;
        await page.keyboard.press('ArrowRight');
        await settled(page);
        await page.waitForTimeout(150);
        perMove.push(new Set(requests.slice(before).filter(isChunk).map(chunkIndex)).size);
      }
      const info = await stageInfo(page);
      const st = steps[i];
      let ok = info.stepId === st.stepId && info.logStepId === st.stepId && info.state === expectedState(st)
        && info.visibleSteps === i + 1 && info.scrub === i
        && info.lastMsg === st.messages.at(-1)?.content;
      let hash = null;
      if (st.frameIndex !== null) {
        hash = await canvasHash(page);
        ok = ok && hash.sha === hashByFrame.get(st.frameIndex);
      }
      if (!ok) allAligned = false;
      check(`step ${i + 1} ${st.stepId} (${st.status}, frame ${st.frameIndex}) aligned`, ok, { state: info.state, logStepId: info.logStepId });
    }
    check('every move fetches at most the selected and one adjacent frame', perMove.every((c) => c <= 2), { chunkRequestsPerMove: perMove });
    const total = requests.filter(isChunk).length;
    check('walking all steps fetched each frame at most once', total <= report.frames.length, { chunkRequests: total, frames: report.frames.length });
    await context.close();
  }

  // 5. Stale responses never overwrite a newer selection
  {
    const { context, page } = await newPage();
    const delays = new Map(report.frames.map((f, k) => [f.frameIndex, k === 0 ? 1500 : 150 + 250 * k]));
    await page.route(/\/frames\.zarr\/c\//, async (route) => {
      await new Promise((r) => setTimeout(r, delays.get(chunkIndex(route.request().url())) ?? 0));
      await route.continue();
    });
    await page.goto(base);
    await page.waitForSelector('#stage[data-step-id]');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const target = steps.findIndex((s, k) => k > 0 && s.frameIndex !== null);
    for (let k = 0; k < target; k++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(2500);
    let info = await stageInfo(page);
    let hash = await canvasHash(page);
    check('slow earlier frame does not replace the newer selection', info.stepId === steps[target].stepId && hash.sha === hashByFrame.get(steps[target].frameIndex), { selected: info.stepId, state: info.state });

    // Rapid keyboard back-and-forth, then fast drag on the range input.
    const keys = ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowRight'];
    for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(30); }
    await page.waitForTimeout(2500);
    info = await stageInfo(page);
    let st = steps[info.scrub];
    hash = st.frameIndex !== null ? await canvasHash(page) : null;
    check('rapid key presses end on the selected step', info.stepId === st.stepId && info.state === expectedState(st) && (!hash || hash.sha === hashByFrame.get(st.frameIndex)), { scrub: info.scrub, stepId: info.stepId, state: info.state });

    const box = await page.locator('#scrub').boundingBox();
    const dragValues = [];
    await page.exposeFunction('__recordScrub', (v) => dragValues.push(Number(v)));
    await page.evaluate(() => document.getElementById('scrub').addEventListener('input', (e) => window.__recordScrub(e.target.value)));
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    for (let x = box.width - 4; x >= 4; x -= box.width / 25) await page.mouse.move(box.x + x, box.y + box.height / 2, { steps: 1 });
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(2500);
    info = await stageInfo(page);
    st = steps[info.scrub];
    hash = st.frameIndex !== null ? await canvasHash(page) : null;
    const expectedEnd = Math.round(0.35 * (steps.length - 1));
    check('fast timeline drag ends on the selected step', new Set(dragValues).size >= Math.min(3, steps.length) && info.scrub === expectedEnd && info.stepId === st.stepId && info.state === expectedState(st) && (!hash || hash.sha === hashByFrame.get(st.frameIndex)), { visited: [...new Set(dragValues)], scrub: info.scrub, stepId: info.stepId, state: info.state });
    await context.close();
  }

  // 6. Corrupt and missing chunks are shown as errors, not as a blank map
  const framed = steps.filter((s) => s.frameIndex !== null);
  const victim = framed[Math.min(1, framed.length - 1)];
  for (const mode of ['corrupt', 'missing']) {
    const { context, page } = await newPage();
    await page.route(new RegExp(`/frames\\.zarr/c/${victim.frameIndex}/`), (route) =>
      mode === 'corrupt'
        ? route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from('not a gzip stream') })
        : route.fulfill({ status: 404, body: '' }));
    await page.goto(`${base}?step=${encodeURIComponent(victim.stepId)}`);
    await settled(page);
    const info = await stageInfo(page);
    const retry = await page.locator('#stage-msg button').count();
    check(`${mode} chunk shows a load/decode error with retry`, info.state === 'decode-error' && info.stepId === victim.stepId && retry === 1, { state: info.state });
    await context.close();
  }

  // 7. Missing session
  {
    const { context, page } = await newPage();
    await page.goto(`${base}?session=does-not-exist`);
    await settled(page);
    const info = await stageInfo(page);
    check('missing session shows a session error', info.state === 'session-error', { state: info.state });
    await context.close();
  }

  // 8. Keyboard, playback, language
  {
    const { context, page } = await newPage();
    await page.goto(base);
    await settled(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('End');
    await settled(page);
    const end = (await stageInfo(page)).scrub;
    await page.keyboard.press('Home');
    await settled(page);
    const home = (await stageInfo(page)).scrub;
    check('Home/End keys', end === steps.length - 1 && home === 0, { end, home });
    await page.keyboard.press('Space');
    const pressed = await page.getAttribute('#play', 'aria-pressed');
    await page.waitForTimeout(2900);
    const advanced = (await stageInfo(page)).scrub;
    await page.keyboard.press('Space');
    const stopped = await page.getAttribute('#play', 'aria-pressed');
    check('Space starts and stops playback; playback advances', pressed === 'true' && stopped === 'false' && advanced >= 1, { pressed, advanced, stopped });
    await page.click('#lang');
    const ja = await page.evaluate(() => ({ lang: document.documentElement.lang, counter: document.getElementById('counter').textContent }));
    check('language switch to Japanese', ja.lang === 'ja' && ja.counter.includes('工程'), ja);
    await context.close();
  }

  // 9. Mobile layout
  {
    const { context, page } = await newPage({ ...devices['iPhone 13'] });
    await page.goto(base);
    await settled(page);
    const m = await page.evaluate(() => {
      const y = (id) => document.getElementById(id).getBoundingClientRect().top + scrollY;
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        stageY: y('stage'), sideY: y('side'), controlsY: y('controls'),
        controlsBottom: Math.round(document.getElementById('controls').getBoundingClientRect().bottom - innerHeight),
        stageW: Math.round(document.getElementById('stage').getBoundingClientRect().width),
        vw: innerWidth,
      };
    });
    check('mobile: image, conversation, timeline stacked without horizontal scroll', m.overflowX <= 0 && m.stageY < m.sideY && m.sideY < m.controlsY && Math.abs(m.controlsBottom) <= 1, m);
    if (shotDir) await page.screenshot({ path: `${shotDir}/mobile.png` });
    await context.close();
  }

  // 10. Cube view
  {
    const { context, page, requests, errors } = await newPage();
    const last = steps.length - 1;
    await page.goto(`${base}?step=${encodeURIComponent(steps[last].stepId)}`);
    await settled(page);
    const fullBefore = requests.filter(isChunk).length;
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('c');
    await page.waitForSelector('#stage[data-thumbs=ready]', { timeout: 15000 });
    const thumbReqs = [...new Set(requests.filter((u) => /\/thumbs\.zarr\/c\//.test(u)))];
    const fullAfter = requests.filter(isChunk).length;
    const cubeInfo = await page.evaluate(() => {
      const c = document.querySelector('canvas.cube');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4 * 16) if (d[i] > 0) painted++;
      return { layers: Number(c.dataset.layers), visible: getComputedStyle(c).display !== 'none', painted, view: document.getElementById('stage').dataset.view };
    });
    check('cube view: C key switches, all thumbnails loaded once, no extra full frames', cubeInfo.view === 'cube' && cubeInfo.visible && thumbReqs.length === report.frames.length && fullAfter === fullBefore, { thumbChunkRequests: thumbReqs.length, fullFrameRequestsAdded: fullAfter - fullBefore });
    check('cube view: one layer per step up to the selected step, drawn', cubeInfo.layers === steps.length && cubeInfo.painted > 1000, cubeInfo);

    // Thumbnails decode in the browser to the hashes written by the converter.
    const thumbOk = await page.evaluate(async ({ id, n }) => {
      const res = [];
      for (let i = 0; i < n; i++) {
        const r = await fetch(`sessions/${id}/thumbs.zarr/c/${i}/0/0/0`);
        const raw = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        const h = await crypto.subtle.digest('SHA-256', raw);
        res.push([...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''));
      }
      return res;
    }, { id: sessionId, n: report.frames.length });
    check('cube thumbnails decode to the converter hashes', thumbOk.every((h, i) => h === report.frames[i].thumbRgbaSha256), { frames: thumbOk.length });

    // Click a layer on the top face -> that step is selected.
    const targetLayer = Math.min(2, last);
    const pt = await page.evaluate((k) => {
      const c = document.querySelector('canvas.cube');
      const p = c.topFacePoint(k);
      const r = c.getBoundingClientRect();
      return { x: r.left + (p.x / 1200) * r.width, y: r.top + (p.y / 900) * r.height };
    }, targetLayer);
    await page.mouse.click(pt.x, pt.y);
    await settled(page);
    const afterLayer = await stageInfo(page);
    check('cube: clicking a layer opens that step', afterLayer.scrub === last - targetLayer && afterLayer.stepId === steps[last - targetLayer].stepId, { selected: afterLayer.stepId });

    // Click on the front face -> the cut moves; double-click resets.
    const box = await page.locator('canvas.cube').boundingBox();
    const cutBefore = await page.getAttribute('canvas.cube', 'data-cut');
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
    const cutAfter = await page.getAttribute('canvas.cube', 'data-cut');
    await page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.7);
    const cutReset = await page.getAttribute('canvas.cube', 'data-cut');
    check('cube: clicking the map sets a cut; double-click resets it', cutBefore === '1200,0' && cutAfter !== cutBefore && cutReset === '1200,0', { cutBefore, cutAfter, cutReset });

    // Drag rotates without changing the step.
    const stepBeforeDrag = (await stageInfo(page)).stepId;
    const shotBefore = await page.locator('canvas.cube').screenshot();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3, { steps: 8 });
    await page.mouse.up();
    const shotAfter = await page.locator('canvas.cube').screenshot();
    const stepAfterDrag = (await stageInfo(page)).stepId;
    check('cube: drag rotates and keeps the step', !shotBefore.equals(shotAfter) && stepBeforeDrag === stepAfterDrag, { step: stepAfterDrag });
    check('cube: no page errors', errors.length === 0, { errors });
    if (shotDir) await page.screenshot({ path: `${shotDir}/cube-verify.png` });
    await context.close();
  }

  if (shotDir) {
    const { context, page } = await newPage({ viewport: { width: 1200, height: 900 } });
    for (const st of steps) {
      await page.goto(`${base}?step=${st.stepId}`);
      await settled(page);
      await page.screenshot({ path: `${shotDir}/desktop-${st.stepId}.png` });
    }
    await context.close();
  }

  const out = {
    checkedAt: new Date().toISOString(),
    session: sessionId,
    sessionKind: session.kind,
    browser: `chromium ${browser.version()}`,
    zarrita: JSON.parse(await readFile('node_modules/zarrita/package.json', 'utf8')).version,
    codec: report.codec,
    sizes: report.totals,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/verification.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`\n${out.passed} passed, ${out.failed} failed`);
  process.exitCode = out.failed ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
