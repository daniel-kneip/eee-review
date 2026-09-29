import path from 'node:path';
import zlib from 'node:zlib';
import { escapeHtml } from './highlight.mjs';

// A draw.io file becomes a document with one figure per diagram page. renderFigures turns
// each into an image; the labels on the page become the figure's row text, so a mark on a
// diagram tells the agent what is drawn there.
export function renderDrawio(file, xml) {
  const rows = [];
  const pages = diagramPages(xml);
  const body = pages
    .map((page, i) => {
      const index = rows.push({ kind: 'figure', lines: null, text: `draw.io, ${page.name}: ${page.labels.join(' · ')}` }) - 1;
      const heading = pages.length > 1 ? `<h2>${escapeHtml(page.name)}</h2>` : '';
      return `${heading}<div class="figure" data-row="${index}" data-drawio="${i}"><pre class="code">${escapeHtml(
        page.labels.join('\n') || page.name,
      )}</pre></div>`;
    })
    .join('');
  return {
    kind: 'spec',
    path: file,
    title: path.basename(file),
    drawio: xml,
    html: `<div class="doc spec"><h1>${escapeHtml(path.basename(file))}</h1>${body || '<p>Keine Diagramme.</p>'}</div>`,
    rows,
  };
}

export const isDrawio = (file) => /\.(drawio|dio)$/i.test(file);

function diagramPages(xml) {
  return [...xml.matchAll(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g)].map(([, attrs, inner], i) => {
    const name = unescapeXml(attrs.match(/\bname="([^"]*)"/)?.[1] ?? `Seite ${i + 1}`);
    return { name, labels: labelsOf(model(inner)) };
  });
}

// A page's model is either plain XML or, from older draw.io, deflated, base64 and URL-encoded.
function model(inner) {
  const text = inner.trim();
  if (text.startsWith('<') || !text) return text;
  try {
    return decodeURIComponent(zlib.inflateRawSync(Buffer.from(text, 'base64')).toString('latin1'));
  } catch {
    return '';
  }
}

// Plain cells keep their text in value; C4 and other placeholder shapes in label, with
// %name% filled from the shape's own attributes.
function labelsOf(xml) {
  const labels = [];
  for (const [, tag, attrs] of xml.matchAll(/<(object|UserObject|mxCell)\b([^>]*)>/g)) {
    const a = Object.fromEntries([...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, unescapeXml(v)]));
    let text = tag === 'mxCell' ? a.value : a.label;
    if (!text) continue;
    if (a.placeholders === '1') text = text.replace(/%(\w+)%/g, (_, k) => a[k] ?? '');
    text = unescapeXml(text.replace(/<\/?(br|div|p|li|tr)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) labels.push(text);
  }
  return [...new Set(labels)];
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#xa;|&#10;/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
