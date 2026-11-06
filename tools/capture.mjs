#!/usr/bin/env node
// Capture one step of a map-making session as a 1200x900 CSS-pixel PNG at device scale 1.
// Usage: node tools/capture.mjs <url-or-html-file> <out.png> [--wait-selector CSS] [--timeout ms]
//
// Waits for: page load, network idle, document.fonts.ready, an optional selector,
// and window.__mapReady (a Promise or boolean the map page may set, e.g. after MapLibre "idle").
// CSS animations and transitions are stopped before the shot.
// Writes <out.png> and <out.png>.capture.json (URL, time, browser version, viewport).
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const waitSelector = opt('--wait-selector', null);
const timeout = Number(opt('--timeout', '30000'));
const [target, out] = args;
if (!target || !out) {
  console.error('Usage: node tools/capture.mjs <url-or-html-file> <out.png> [--wait-selector CSS] [--timeout ms]');
  process.exit(2);
}
// A local file may carry a query string, e.g. page/index.html?v=2
const [filePart, query] = target.split(/\?(.*)/s);
const url = existsSync(filePart)
  ? pathToFileURL(path.resolve(filePart)).href + (query ? `?${query}` : '')
  : target;

const VIEWPORT = { width: 1200, height: 900 };
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US' });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  if (waitSelector) await page.waitForSelector(waitSelector, { timeout });
  await page.evaluate(async (ms) => {
    await document.fonts.ready;
    const ready = window.__mapReady;
    if (ready && typeof ready.then === 'function') {
      await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('__mapReady timed out')), ms))]);
    } else if (ready === false) {
      const t0 = performance.now();
      while (window.__mapReady !== true) {
        if (performance.now() - t0 > ms) throw new Error('__mapReady timed out');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, timeout);
  await page.screenshot({ path: out, animations: 'disabled', caret: 'hide', fullPage: false });
  const meta = {
    url: url.startsWith('file:') ? path.relative(process.cwd(), new URL(url).pathname) + new URL(url).search : url,
    capturedAt: new Date().toISOString(),
    browser: `chromium ${browser.version()}`,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  };
  await writeFile(`${out}.capture.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log(`captured ${out}`);
} finally {
  await browser.close();
}
