import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CommentPool, commentHtml } from './comments.mjs';
import { escapeHtml, highlightLines, languageOf } from './highlight.mjs';

const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });

// Files beyond this many lines show only the stretch around their changes as "whole file";
// laying out thousands of table rows is what the tablet's WebKit is slowest at.
const WHOLE_FILE_MAX = 1200;
const WINDOW = 150;

// The files a change touches. base alone compares the working tree with it (uncommitted work
// when base is HEAD); with head it is what head changed since it left base, as a pull request
// shows it. -z keeps paths as they are: git otherwise quotes and escapes non-ASCII names.
export function changedPaths(repo, base = 'HEAD', head = null) {
  const range = head ? [`${base}...${head}`] : [base];
  const fields = git(repo, 'diff', '-z', '--name-status', '-M', ...range).split('\0');
  const names = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const status = fields[i++];
    const oldPath = fields[i++];
    const renamed = status[0] === 'R' || status[0] === 'C';
    names.push({ status: status[0], oldPath, path: renamed ? fields[i++] : oldPath });
  }
  if (!head) {
    for (const untracked of git(repo, 'ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean)) {
      names.push({ status: 'A', path: untracked, oldPath: untracked, untracked: true });
    }
  }
  return names;
}

// The given changed paths with their hunks and content as of head.
export function changedFiles(repo, base, head, names) {
  const range = head ? [`${base}...${head}`] : [base];
  return names.map((f) => ({
    ...f,
    hunks: f.untracked
      ? addedHunks(fileAt(repo, f.path))
      : parseHunks(git(repo, 'diff', '-U3', ...range, '--', ...new Set([f.oldPath, f.path]))),
    content: f.status === 'D' ? null : fileAt(repo, f.path, head),
  }));
}

// Only files inside the repository, also through symlinks: an agent's paths reach the tablet.
export function fileAt(repo, file, rev = null) {
  const root = fs.realpathSync(repo);
  const inside = (full) => full === root || full.startsWith(root + path.sep);
  if (!inside(path.resolve(root, file))) throw new Error(`${file} is outside the repository`);
  if (rev) return git(repo, 'show', `${rev}:${file}`);
  const real = fs.realpathSync(path.join(root, file));
  if (!inside(real)) throw new Error(`${file} is outside the repository`);
  return fs.readFileSync(real, 'utf8');
}

function addedHunks(content) {
  const lines = content.replace(/\n$/, '').split('\n');
  return [
    {
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.map((code, i) => ({ kind: 'add', old: null, new: i + 1, code })),
    },
  ];
}

export function parseHunks(text) {
  const hunks = [];
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    const code = line.slice(1);
    if (line[0] === '+') hunk.lines.push({ kind: 'add', old: null, new: newNo++, code });
    else if (line[0] === '-') hunk.lines.push({ kind: 'del', old: oldNo++, new: null, code });
    else if (line[0] === ' ') hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, code });
  }
  return hunks;
}

const SIGN = { add: '+', del: '−', ctx: '' };

function tableRow(rows, path, l, html, withOld) {
  const index = rows.push({ kind: l.kind, path, old: l.old, new: l.new, text: l.code }) - 1;
  const numbers = withOld
    ? `<td class="n">${l.old ?? ''}</td><td class="n">${l.new ?? ''}</td>`
    : `<td class="n">${l.new ?? ''}</td>`;
  return `<tr class="${l.kind}" data-row="${index}">${numbers}<td class="sign">${SIGN[l.kind]}</td><td class="src">${html || ' '}</td></tr>`;
}

// A comment at a line gets a table row of its own right below it.
function commentRows(rows, path, comments, columns) {
  return comments.map((c) => `<tr class="note"><td colspan="${columns}">${commentHtml(rows, c, path)}</td></tr>`).join('');
}

// Comments on the file as a whole lead, those at lines not shown close the document.
function framed(rows, path, pool) {
  const top = pool.general.map((c) => commentHtml(rows, c, path)).join('');
  const bottom = pool.unplaced.map((c) => commentHtml(rows, c, path, { away: true })).join('');
  return { top: top && `<div class="notes">${top}</div>`, bottom: bottom && `<div class="notes">${bottom}</div>` };
}

export function renderDiff(file, comments = []) {
  const rows = [];
  const pool = new CommentPool(comments);
  const language = languageOf(file.path);
  const added = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add').length;
  const removed = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del').length;
  const body = file.hunks
    .map((h) => {
      const html = highlightLines(
        h.lines.map((l) => l.code),
        language,
      );
      const lines = h.lines.map(
        (l, i) =>
          tableRow(rows, file.path, l, html[i], true) +
          commentRows(rows, file.path, [...pool.take('new', l.new), ...pool.take('old', l.old)], 4),
      );
      return `<div class="hunk">${escapeHtml(h.header)}</div><table>${lines.join('')}</table>`;
    })
    .join('');
  const moved = file.oldPath !== file.path ? ` · von ${escapeHtml(file.oldPath)}` : '';
  const { top, bottom } = framed(rows, file.path, pool);
  return {
    html: `<div class="doc code"><div class="head">${escapeHtml(file.path)}</div><div class="sub">Diff · +${added} −${removed}${moved}</div>${top}${body}${bottom}</div>`,
    rows,
  };
}

export function renderFile(path, content, changedLines = new Set(), comments = []) {
  const rows = [];
  const pool = new CommentPool(comments);
  const lines = content.replace(/\n$/, '').split('\n');
  let from = 1;
  let to = lines.length;
  if (lines.length > WHOLE_FILE_MAX && changedLines.size) {
    from = Math.max(1, Math.min(...changedLines) - WINDOW);
    to = Math.min(lines.length, Math.max(...changedLines) + WINDOW);
  }
  const html = highlightLines(lines.slice(from - 1, to), languageOf(path));
  const body = html
    .map((h, i) => {
      const n = from + i;
      return (
        tableRow(rows, path, { kind: changedLines.has(n) ? 'add' : 'ctx', old: null, new: n, code: lines[n - 1] }, h, false) +
        commentRows(rows, path, pool.take('new', n), 3)
      );
    })
    .join('');
  const { top, bottom } = framed(rows, path, pool);
  const range =
    from === 1 && to === lines.length ? `${lines.length} Zeilen` : `Zeilen ${from}–${to} von ${lines.length}`;
  return {
    html: `<div class="doc code"><div class="head">${escapeHtml(path)}</div><div class="sub">Ganze Datei · ${range}</div>${top}${
      from > 1 ? `<div class="gap">… ${from - 1} Zeilen davor</div>` : ''
    }<table>${body}</table>${to < lines.length ? `<div class="gap">… ${lines.length - to} Zeilen danach</div>` : ''}${bottom}</div>`,
    rows,
  };
}
