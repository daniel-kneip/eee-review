import fs from 'node:fs';
import path from 'node:path';
import { decodePngToGray, encodeGrayPng } from './png.mjs';

// The tablet's document pane: its width less the 38 px rail.
export const PAGE_WIDTH = 730;
export const STRIP_HEIGHT = 512;
const IDLE_CLOSE_MS = 60_000;

// Renders a document page in headless Chromium into 4-bit gray PNG strips, which the tablet
// only has to copy to the screen, and records where each source row sits on the page.
// Renders run one at a time; the browser closes after a minute without work.
export class PageRenderer {
  constructor() {
    this.browser = null;
    this.queue = Promise.resolve();
    this.idle = null;
  }

  render(url, dir) {
    const run = this.queue.then(() => this.renderNow(url, dir));
    this.queue = run.catch(() => {});
    return run;
  }

  async renderNow(url, dir) {
    clearTimeout(this.idle);
    this.browser ??= await launch();
    const page = await this.browser.newPage({ viewport: { width: PAGE_WIDTH, height: 1000 }, deviceScaleFactor: 1 });
    try {
      await page.goto(url, { waitUntil: 'load' });
      const { height, rows, figures } = await page.evaluate(() => {
        const layer = document.getElementById('docLayer');
        const base = layer.getBoundingClientRect().top;
        const rows = [];
        for (const el of layer.querySelectorAll('[data-row]')) {
          const box = el.getBoundingClientRect();
          rows.push([Math.round(box.top - base), Math.round(box.bottom - base), Number(el.getAttribute('data-row'))]);
        }
        // Where the figures sit, for the tablet to open them in its zoom view.
        const figures = [...layer.querySelectorAll('.figure img')].map((img) => {
          const box = img.getBoundingClientRect();
          const box4 = [box.top - base, box.bottom - base, box.left, box.right].map(Math.round);
          return { box: box4, name: img.getAttribute('src').split('/').pop() };
        });
        return { height: Math.ceil(layer.getBoundingClientRect().height), rows, figures };
      });
      const partial = `${dir}.partial`;
      fs.rmSync(partial, { recursive: true, force: true });
      fs.mkdirSync(partial, { recursive: true });
      const count = Math.max(1, Math.ceil(height / STRIP_HEIGHT));
      for (let n = 0; n < count; n++) {
        const clip = { x: 0, y: n * STRIP_HEIGHT, width: PAGE_WIDTH, height: Math.max(1, Math.min(STRIP_HEIGHT, height - n * STRIP_HEIGHT)) };
        const shot = decodePngToGray(await page.screenshot({ clip, fullPage: true }));
        fs.writeFileSync(path.join(partial, `${n}.png`), encodeGrayPng(shot.gray, shot.width, shot.height, 4));
      }
      const index = { width: PAGE_WIDTH, height, strip: STRIP_HEIGHT, count, rows, figures };
      fs.writeFileSync(path.join(partial, 'index.json'), JSON.stringify(index));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(partial, dir);
      return index;
    } finally {
      await page.close();
      this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS);
      this.idle.unref();
    }
  }

  async close() {
    clearTimeout(this.idle);
    const browser = this.browser;
    this.browser = null;
    await browser?.close();
  }
}

async function launch() {
  const { chromium } = await import('playwright-core');
  return chromium.launch();
}
