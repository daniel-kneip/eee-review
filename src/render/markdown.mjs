import MarkdownIt from 'markdown-it';
import { commentHtml } from './comments.mjs';
import { escapeHtml, highlightLines } from './highlight.mjs';

// Renders markdown to an HTML fragment in which every block a mark can land on carries
// data-row, indexing into rows: the block's source lines and plain text. The tablet
// measures the rows itself, so a mark resolves to "lines 12–14" without any rendering here.
// Fenced code gets a row per line; mermaid fences are left to renderFigures. Comments follow
// the block their line is in, and lead the document when they have none.
export function renderMarkdown(source, comments = [], path = null) {
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
    placeComments(state, rows, comments, path);
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

function placeComments(state, rows, comments, path) {
  const tokens = state.tokens;
  const blocks = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || t.nesting === -1 || !t.map) continue;
    let end = i;
    if (t.nesting === 1) while (!(tokens[end].level === 0 && tokens[end].nesting === -1)) end++;
    blocks.push({ from: t.map[0] + 1, to: t.map[1], after: end + 1 });
  }
  const at = (line) => {
    if (!line || !blocks.length) return 0;
    const inside = blocks.find((b) => b.from <= line && line <= b.to);
    return (inside ?? blocks.filter((b) => b.from <= line).at(-1) ?? blocks[0]).after;
  };
  const inserts = comments.map((c, n) => ({ index: at(c.line), n, c }));
  inserts.sort((a, b) => b.index - a.index || b.n - a.n);
  for (const { index, c } of inserts) {
    const token = new state.Token('html_block', '', 0);
    token.content = commentHtml(rows, c, path);
    tokens.splice(index, 0, token);
  }
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
