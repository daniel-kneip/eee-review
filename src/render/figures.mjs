import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodePngToGray, encodeGrayPng } from './png.mjs';

const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const DRAWIO = 'https://viewer.diagrams.net/js/viewer-static.min.js';
// Figures are rendered at twice their size: the page shows them scaled to its width, and the
// tablet's zoom view at full size, where a diagram's small print becomes readable.
const SCALE = 2;

// Replaces the placeholders of mermaid blocks (renderMarkdown) and draw.io pages
// (renderDrawio, whose file comes as drawio) with gray PNGs rendered in headless Chromium.
// Rendered figures are cached by source, so an unchanged diagram costs nothing on the next
// round. Without Playwright or network the placeholder keeps showing the diagram's source.
export async function renderFigures(html, figureDir, urlPrefix, { drawio = null, width = 700 } = {}) {
  const figures = [
    ...[...html.matchAll(/data-mermaid="([^"]*)"/g)].map((m) => ({ key: m[0], source: unescape(m[1]) })),
    ...[...html.matchAll(/data-drawio="(\d+)"/g)].map((m) => ({ key: m[0], page: Number(m[1]), source: `${m[1]}:${drawio}` })),
  ];
  if (!figures.length) return html;
  fs.mkdirSync(figureDir, { recursive: true });
  const files = new Map();
  let browser = null;
  try {
    for (const figure of figures) {
      const name = `${crypto.createHash('sha1').update(figure.source).digest('hex').slice(0, 16)}@${SCALE}.png`;
      const file = path.join(figureDir, name);
      if (!fs.existsSync(file)) {
        browser ??= await launch();
        if (!browser) break;
        const png = figure.page === undefined ? await renderMermaid(browser, figure.source, width) : await renderDrawioPage(browser, drawio, figure.page);
        if (png) {
          const { gray, width: w, height: h } = decodePngToGray(png);
          fs.writeFileSync(file, encodeGrayPng(gray, w, h));
        }
      }
      if (fs.existsSync(file)) files.set(figure.key, name);
    }
  } finally {
    await browser?.close();
  }
  return html.replace(
    /<div class="figure" data-row="(\d+)" (data-(?:mermaid|drawio)="[^"]*")>[\s\S]*?<\/pre><\/div>/g,
    (whole, row, key) => {
      const name = files.get(key);
      return name ? `<div class="figure" data-row="${row}"><img src="${urlPrefix}/${name}" alt=""></div>` : whole;
    },
  );
}

function unescape(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function launch() {
  try {
    const { chromium } = await import('playwright-core');
    return await chromium.launch();
  } catch {
    return null;
  }
}

async function renderMermaid(browser, source, width) {
  const page = await browser.newPage({ viewport: { width, height: 400 }, deviceScaleFactor: SCALE });
  try {
    await page.setContent(
      `<!DOCTYPE html><body style="margin:0;background:#fff"><pre class="mermaid">${source
        .replace(/&/g, '&amp;')
        .replace(
          /</g,
          '&lt;',
        )}</pre><script src="${MERMAID}"></script><script>mermaid.initialize({ startOnLoad: false, theme: 'neutral', themeVariables: { fontSize: '22px' }, flowchart: { useMaxWidth: false } }); mermaid.run().then(() => document.body.dataset.done = 1, () => document.body.dataset.done = 'error');</script></body>`,
    );
    await page.waitForFunction(() => document.body.dataset.done, null, { timeout: 15000 });
    if ((await page.evaluate(() => document.body.dataset.done)) !== '1') return null;
    const svg = page.locator('pre.mermaid svg');
    await svg.evaluate((el, max) => {
      el.style.maxWidth = `${max}px`;
      el.style.height = 'auto';
    }, width);
    return await svg.screenshot();
  } catch {
    return null; // leave the diagram's source in place
  } finally {
    await page.close();
  }
}

async function renderDrawioPage(browser, xml, index) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: SCALE });
  try {
    const config = JSON.stringify({ xml, page: index, toolbar: '', nav: false, lightbox: false, resize: true, border: 16 });
    await page.setContent(
      `<!DOCTYPE html><body style="margin:0;background:#fff"><div class="mxgraph" data-mxgraph="${config
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')}"></div><script src="${DRAWIO}"></script></body>`,
    );
    await page.waitForSelector('.mxgraph svg', { timeout: 15000 });
    return await page.locator('.mxgraph').first().screenshot();
  } catch {
    return null;
  } finally {
    await page.close();
  }
}
