// Probe: renders one document of a review into PNG strips the way the tablet's native page
// view would show it, and writes them where the hub serves /pages/<id>/<doc>/.
//
//   node scripts/render-pages.mjs <review-id> <doc-index> [hub-url]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [id, docArg, hub = 'http://127.0.0.1:8770'] = process.argv.slice(2);
const doc = Number(docArg ?? 0);
const WIDTH = 730;
const STRIP = 512;
const out = path.join(process.env.EEE_REVIEW_HOME ?? path.join(os.homedir(), '.eee-review'), 'pages', id, String(doc));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${hub}/r/${id}`);
  const html = await page.evaluate((i) => DOCS[i], doc);
  const started = Date.now();
  await page.setContent(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${hub}/web/review.css">
<style>html, body { overflow: visible; } #docLayer { position: static; width: ${WIDTH}px; }</style></head>
<body><div id="docLayer">${html}</div></body></html>`,
    { waitUntil: 'load' },
  );
  const height = await page.evaluate(() => document.getElementById('docLayer').offsetHeight);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const count = Math.ceil(height / STRIP);
  let bytes = 0;
  for (let n = 0; n < count; n++) {
    const file = path.join(out, `${n}.png`);
    const clip = { x: 0, y: n * STRIP, width: WIDTH, height: Math.min(STRIP, height - n * STRIP) };
    await page.screenshot({ path: file, clip, fullPage: true });
    bytes += fs.statSync(file).size;
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ width: WIDTH, height, strip: STRIP, count }));
  console.log(`${count} strips, ${height} px, ${Math.round(bytes / 1024)} KB, ${Date.now() - started} ms -> ${out}`);
} finally {
  await browser.close();
}
