import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';

// Replaces mermaid placeholders from renderMarkdown with PNGs rendered in headless Chromium:
// the tablet's WebKit runs neither mermaid nor inline SVG. Rendered figures are cached by
// source, so an unchanged diagram costs nothing on the next round. Without Playwright or
// network the placeholder keeps showing the diagram's source.
export async function renderFigures(html, figureDir, urlPrefix, width = 700) {
  const sources = [...html.matchAll(/data-mermaid="([^"]*)"/g)].map((m) => unescape(m[1]));
  if (!sources.length) return html;
  fs.mkdirSync(figureDir, { recursive: true });
  const files = new Map();
  let browser = null;
  try {
    for (const source of sources) {
      const name = `${crypto.createHash('sha1').update(source).digest('hex').slice(0, 16)}.png`;
      const file = path.join(figureDir, name);
      if (!fs.existsSync(file)) {
        browser ??= await launch();
        if (!browser) break;
        await renderMermaid(browser, source, file, width);
      }
      if (fs.existsSync(file)) files.set(source, name);
    }
  } finally {
    await browser?.close();
  }
  return html.replace(
    /<div class="figure" data-row="(\d+)" data-mermaid="([^"]*)">[\s\S]*?<\/pre><\/div>/g,
    (whole, row, encoded) => {
      const name = files.get(unescape(encoded));
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

async function renderMermaid(browser, source, file, width) {
  const page = await browser.newPage({ viewport: { width, height: 400 }, deviceScaleFactor: 1 });
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
    if ((await page.evaluate(() => document.body.dataset.done)) !== '1') return;
    const svg = page.locator('pre.mermaid svg');
    await svg.evaluate((el, max) => {
      el.style.maxWidth = `${max}px`;
      el.style.height = 'auto';
    }, width);
    await svg.screenshot({ path: file });
  } catch {
    // leave the diagram's source in place
  } finally {
    await page.close();
  }
}
