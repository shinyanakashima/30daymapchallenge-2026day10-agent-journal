#!/usr/bin/env node
// Record a replay of a published session as an MP4 (run `npm run build` first; needs ffmpeg with libx264).
//
//   node scripts/record-video.mjs [sessionId] [--lang en|ja] [--size 1920x1080] [--out media/day10.mp4]
//
// The video is the player replaying the recorded session: the screen view stepping through every
// step, then the layers view building up and turning. It does not call any model and adds nothing
// that is not in the session.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const lang = opt('--lang', 'en');
const [W, H] = opt('--size', '1920x1080').split('x').map(Number);
const out = opt('--out', null);
const sessionId = args[0] || null;
const outFile = out || `media/${sessionId ?? 'session'}-${lang}.mp4`;

const work = await mkdtemp(path.join(process.env.VERIFY_TMP || tmpdir(), 'video-'));
const { server, url } = await serve('dist');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const q = new URLSearchParams({ lang, view: 'screen' });
  if (sessionId) q.set('session', sessionId);
  await page.goto(`${url}?${q}`);
  await page.waitForFunction(() => document.getElementById('stage')?.dataset.state !== 'loading');
  await page.evaluate(() => document.fonts.ready);
  const n = await page.evaluate(() => document.querySelectorAll('#ticks .tick').length);

  // Collect frames with their timestamps from the DevTools screencast.
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closed */ }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  const wait = (ms) => page.waitForTimeout(ms);
  const settled = () => page.waitForFunction(() => document.getElementById('stage').dataset.state !== 'loading');
  await page.mouse.move(W - 4, 4); // keep the pointer out of the way
  await wait(1800);

  // 1. Screen view: step through every step.
  for (let i = 1; i < n; i++) {
    await page.keyboard.press('ArrowRight');
    await settled();
    await wait(2300);
  }
  await wait(800);

  // 2. Layers view: back to the start, then watch the stack build up.
  await page.keyboard.press('Home');
  await page.keyboard.press('c');
  await page.waitForSelector('#stage[data-thumbs=ready]', { timeout: 30000 });
  await wait(1500);
  for (let i = 1; i < n; i++) {
    await page.keyboard.press('ArrowRight');
    await wait(1700);
  }
  // 3. Turn the stack slowly.
  const box = await page.locator('.stack canvas').boundingBox();
  if (box) {
    const y = box.y + box.height * 0.82;
    await page.mouse.move(box.x + box.width * 0.35, y);
    await page.mouse.down();
    for (let k = 0; k <= 60; k++) {
      await page.mouse.move(box.x + box.width * (0.35 + 0.25 * Math.sin((k / 60) * Math.PI)), y - 20 * Math.sin((k / 60) * Math.PI));
      await wait(40);
    }
    await page.mouse.up();
    await page.mouse.move(W - 4, 4);
  }
  await wait(2200);
  await cdp.send('Page.stopScreencast');

  if (frames.length < 2) throw new Error('No frames captured');
  // Write frames and an ffconcat list that keeps the real timing.
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const name = `f${String(i).padStart(5, '0')}.jpg`;
    await writeFile(path.join(work, name), Buffer.from(frames[i].data, 'base64'));
    const dur = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 1;
    lines.push(`file '${name}'`, `duration ${dur.toFixed(4)}`);
  }
  lines.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  await writeFile(path.join(work, 'list.ffconcat'), lines.join('\n') + '\n');
  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.ffconcat'),
    '-vf', `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', '-an',
    path.resolve(outFile),
  ], { stdio: 'inherit' });
  const span = frames.at(-1).t - frames[0].t;
  console.log(`wrote ${outFile} (${frames.length} frames, ${span.toFixed(1)} s, ${W}×${H})`);
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}
