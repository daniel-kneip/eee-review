import MarkdownIt from 'markdown-it';
import { escapeHtml, highlightLines } from './highlight.mjs';

// Renders markdown to an HTML fragment in which every block a mark can land on carries
// data-row, indexing into rows: the block's source lines and plain text. The tablet
// measures the rows itself, so a mark resolves to "lines 12–14" without any rendering here.
// Fenced code gets a row per line; mermaid fences are left to renderFigures.
export function renderMarkdown(source) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const rows = [];
  const addRow = (token, text) => {
    rows.push({ kind: 'text', lines: token.map ? [token.map[0] + 1, token.map[1]] : null, text });
    token.attrSet('data-row', String(rows.length - 1));
  };

  md.core.ruler.push('rows', (state) => {
    const tokens = state.tokens;
    let listDepth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') listDepth++;
      if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') listDepth--;
      const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1].content : '';
      if (t.type === 'heading_open') addRow(t, inline);
      else if (t.type === 'paragraph_open' && listDepth === 0) addRow(t, inline);
      else if (t.type === 'list_item_open') addRow(t, itemText(tokens, i));
      else if (t.type === 'tr_open') addRow(t, rowText(tokens, i));
    }
  });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0];
    const code = token.content.replace(/\n$/, '');
    if (lang === 'mermaid') {
      const index = rows.push({ kind: 'figure', lines: [token.map[0] + 1, token.map[1]], text: code }) - 1;
      return `<div class="figure" data-row="${index}" data-mermaid="${escapeHtml(code).replace(/"/g, '&quot;')}"><pre class="code">${escapeHtml(code)}</pre></div>\n`;
    }
    const lines = code.split('\n');
    const html = highlightLines(lines, lang || null);
    const first = token.map[0] + 2;
    const body = lines
      .map((line, i) => {
        const index = rows.push({ kind: 'code', lines: [first + i, first + i], text: line }) - 1;
        return `<span class="ln" data-row="${index}">${html[i] || ' '}</span>`;
      })
      .join('');
    return `<pre class="code">${body}</pre>\n`;
  };

  const html = md.render(source);
  return { html: `<div class="doc spec">${html}</div>`, rows };
}

function itemText(tokens, start) {
  let depth = 0;
  const parts = [];
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'list_item_open') depth++;
    if (t.type === 'list_item_close' && --depth === 0) break;
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') break;
    if (t.type === 'inline') parts.push(t.content);
  }
  return parts.join(' ');
}

function rowText(tokens, start) {
  const cells = [];
  for (let i = start; i < tokens.length && tokens[i].type !== 'tr_close'; i++) {
    if (tokens[i].type === 'inline') cells.push(tokens[i].content);
  }
  return cells.join(' | ');
}
