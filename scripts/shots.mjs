// Headless screenshots of the dashboard (light, dark, phone). Dev tool, not shipped.
// Usage: node scripts/shots.mjs [outDir]   (needs Chrome or Edge installed; set CHROME to override)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { runDemo } from '../dist/demo.js';

const out = path.resolve(process.argv[2] ?? 'docs/img');
fs.mkdirSync(out, { recursive: true });
const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((c) => fs.existsSync(c));
if (!executablePath) throw new Error('No Chrome or Edge found. Set CHROME=/path/to/chrome');

const demo = await runDemo({ fast: true, port: 0, say: () => {} });
const browser = await chromium.launch({ executablePath, headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

const shots = [
  ['light', { colorScheme: 'light', viewport: { width: 1180, height: 900 } }],
  ['dark', { colorScheme: 'dark', viewport: { width: 1180, height: 900 } }],
  ['phone', { colorScheme: 'light', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['phone-dark', { colorScheme: 'dark', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
for (const [name, opts] of shots) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(demo.url);
  await page.waitForSelector('.ev');
  for (const tab of ['now', 'approve', 'rules', 'receipt']) {
    await page.click(`[data-tab="${tab}"]`);
    await sleep(350);
    await page.screenshot({ path: path.join(out, `${name}-${tab}.png`), fullPage: false });
  }
  await ctx.close();
}
await browser.close();
await demo.close();
console.log('wrote', out);
process.exit(0);
