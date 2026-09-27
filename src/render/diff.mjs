import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, highlightLines, languageOf } from './highlight.mjs';

const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });

// Files beyond this many lines show only the stretch around their changes as "whole file";
// laying out thousands of table rows is what the tablet's WebKit is slowest at.
const WHOLE_FILE_MAX = 1200;
const WINDOW = 150;

// The files a change touches, with their hunks. base alone compares the working tree with
// it (uncommitted work when base is HEAD); base and head compare two commits.
export function changedFiles(repo, base = 'HEAD', head = null) {
  const range = head ? [base, head] : [base];
  const names = git(repo, 'diff', '--name-status', '-M', ...range)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status: status[0], path: paths.at(-1), oldPath: paths.length > 1 ? paths[0] : paths[0] };
    });
  if (!head) {
    for (const untracked of git(repo, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
      names.push({ status: 'A', path: untracked, oldPath: untracked, untracked: true });
    }
  }
  return names.map((f) => ({
    ...f,
    hunks: f.untracked
      ? addedHunks(fileAt(repo, f.path))
      : parseHunks(git(repo, 'diff', '-U3', ...range, '--', ...new Set([f.oldPath, f.path]))),
    content: f.status === 'D' ? null : fileAt(repo, f.path, head),
  }));
}

export function fileAt(repo, file, rev = null) {
  if (rev) return git(repo, 'show', `${rev}:${file}`);
  return fs.readFileSync(path.join(repo, file), 'utf8');
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

export function renderDiff(file) {
  const rows = [];
  const language = languageOf(file.path);
  const added = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add').length;
  const removed = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del').length;
  const body = file.hunks
    .map((h) => {
      const html = highlightLines(
        h.lines.map((l) => l.code),
        language,
      );
      return `<div class="hunk">${escapeHtml(h.header)}</div><table>${h.lines.map((l, i) => tableRow(rows, file.path, l, html[i], true)).join('')}</table>`;
    })
    .join('');
  const moved = file.oldPath !== file.path ? ` · von ${escapeHtml(file.oldPath)}` : '';
  return {
    html: `<div class="doc code"><div class="head">${escapeHtml(file.path)}</div><div class="sub">Diff · +${added} −${removed}${moved}</div>${body}</div>`,
    rows,
  };
}

export function renderFile(path, content, changedLines = new Set()) {
  const rows = [];
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
      return tableRow(
        rows,
        path,
        { kind: changedLines.has(n) ? 'add' : 'ctx', old: null, new: n, code: lines[n - 1] },
        h,
        false,
      );
    })
    .join('');
  const range =
    from === 1 && to === lines.length ? `${lines.length} Zeilen` : `Zeilen ${from}–${to} von ${lines.length}`;
  return {
    html: `<div class="doc code"><div class="head">${escapeHtml(path)}</div><div class="sub">Ganze Datei · ${range}</div>${
      from > 1 ? `<div class="gap">… ${from - 1} Zeilen davor</div>` : ''
    }<table>${body}</table>${to < lines.length ? `<div class="gap">… ${lines.length - to} Zeilen danach</div>` : ''}</div>`,
    rows,
  };
}
