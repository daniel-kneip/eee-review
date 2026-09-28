import { escapeHtml } from './highlight.mjs';

// Comments the agent brings along, from colleagues on a pull request or its own: at a line
// of a file, at a file, or on the review as a whole. Each becomes a row of its own, so a mark
// on one tells the agent which comment it means, by its ref when the agent gave one.
//
//   { file?, line?, side?: 'new' | 'old', author, text, at?, ref?, replies?: [{ author, text, at? }] }

export function commentText(c) {
  const where = c.file ? ` zu ${c.file}${c.line ? `:${c.line}` : ''}` : '';
  const head = `Kommentar${c.ref ? ` ${c.ref}` : ''} von ${c.author}${where}`;
  const replies = (c.replies ?? []).map((r) => `\n  Antwort von ${r.author}: ${r.text}`).join('');
  return `[${head}] ${c.text}${replies}`;
}

// The comment box, its row pushed onto rows. A box away from its line names the line.
export function commentHtml(rows, c, path, { away = false, named = false } = {}) {
  const line = c.line ?? null;
  const old = c.side === 'old';
  const index =
    rows.push({
      kind: 'comment',
      path,
      new: old ? null : line,
      old: old ? line : null,
      lines: line && !named ? [line, line] : null,
      text: commentText(c),
    }) - 1;
  const one = (x) =>
    `<div class="by">${escapeHtml(x.author)}${x.at ? ` · ${escapeHtml(x.at)}` : ''}</div><div class="text">${escapeHtml(x.text)}</div>`;
  const at = [named && path, away && line && `${old ? 'alte ' : ''}Zeile ${line}`].filter(Boolean).join(' · ');
  const where = at ? `<div class="at">${escapeHtml(at)}</div>` : '';
  const replies = (c.replies ?? []).map((r) => `<div class="thread">${one(r)}</div>`).join('');
  return `<div class="comment" data-row="${index}">${where}${one(c)}${replies}</div>`;
}

// Takes the comments at a line out of the pool as it is laid out; what is left over was not
// at any line shown.
export class CommentPool {
  constructor(comments) {
    this.left = [...comments];
  }
  take(side, line) {
    if (line === null || line === undefined) return [];
    const here = this.left.filter((c) => c.line === line && (c.side === 'old') === (side === 'old'));
    this.left = this.left.filter((c) => !here.includes(c));
    return here;
  }
  get general() {
    return this.left.filter((c) => !c.line);
  }
  get unplaced() {
    return this.left.filter((c) => c.line);
  }
}
