#!/usr/bin/env node
// Save docs/screenshot.png: the built player at 1200x900 CSS px, device scale 1.
// Usage: node scripts/screenshot.mjs [stepId] [sessionId]
// Env: VIEW=layers, OUT=docs/screenshot.png, SHOT_LANG=en
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [stepId, sessionId] = process.argv.slice(2);
const { server, url } = await serve('dist');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const q = new URLSearchParams({ lang: process.env.SHOT_LANG || 'en', view: process.env.VIEW || 'screen' });
  if (stepId) q.set('step', stepId);
  if (sessionId) q.set('session', sessionId);
  await page.goto(`${url}?${q}`);
  await page.waitForFunction(() => document.getElementById('stage')?.dataset.state !== 'loading');
  await page.evaluate(() => document.fonts.ready);
  if (process.env.VIEW === 'layers') {
    await page.waitForSelector('#stage[data-thumbs=ready]');
    await page.waitForTimeout(800); // let the new layer settle
  }
  const out = process.env.OUT || 'docs/screenshot.png';
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
  server.close();
}
