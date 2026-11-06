#!/usr/bin/env node
// Save docs/screenshot.png: the built player at 1200x900 CSS px, device scale 1.
// Usage: node scripts/screenshot.mjs [stepId] [sessionId]
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [stepId, sessionId] = process.argv.slice(2);
const { server, url } = await serve('dist');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const q = new URLSearchParams({ lang: 'en' });
  if (stepId) q.set('step', stepId);
  if (sessionId) q.set('session', sessionId);
  await page.goto(`${url}?${q}`);
  await page.waitForFunction(() => document.getElementById('stage')?.dataset.state !== 'loading');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshot.png' });
  console.log('saved docs/screenshot.png');
} finally {
  await browser.close();
  server.close();
}
