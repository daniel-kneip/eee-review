import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { startHub } from '../src/hub/server.mjs';
import { Store } from '../src/hub/store.mjs';
import { strokesToPng } from '../src/render/ink.mjs';
import { renderMarkdown } from '../src/render/markdown.mjs';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eee-review-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'auth.js'), 'export function issue(id) {\n  return id;\n}\n');
  fs.writeFileSync(path.join(dir, 'spec.md'), '# Plan\n\nRotate tokens.\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'auth.js'), 'export function issue(id) {\n  log(id);\n  return id;\n}\n');
  fs.writeFileSync(path.join(dir, 'log.js'), 'export const log = console.log;\n');
  return dir;
}

test('markdown blocks and code lines each become a row that points back to its source lines', () => {
  const { html, rows } = renderMarkdown(
    [
      '# Title',
      '',
      'Some text.',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '- one',
      '- two',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
    ].join('\n'),
  );
  const byText = (t) => rows.find((r) => r.text === t);
  assert.deepEqual(byText('Title').lines, [1, 1]);
  assert.deepEqual(byText('Some text.').lines, [3, 3]);
  assert.deepEqual(byText('const b = 2;').lines, [7, 7]);
  assert.equal(byText('1 | 2').kind, 'text');
  assert.ok(byText('two'));
  assert.equal(rows.find((r) => r.kind === 'figure').text, 'flowchart LR\n  A --> B');
  for (let i = 0; i < rows.length; i++) assert.ok(html.includes(`data-row="${i}"`), `row ${i} is in the html`);
});

test('strokes rasterise to a grayscale png with ink where the pen went', () => {
  const png = strokesToPng(
    [
      [
        [10, 10, 200],
        [90, 10, 200],
      ],
    ],
    100,
    20,
  );
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const idat = png.indexOf('IDAT');
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const pixel = (x, y) => raw[y * 101 + 1 + x];
  assert.ok(pixel(50, 10) < 60, 'on the stroke');
  assert.equal(pixel(50, 2), 255, 'away from the stroke');
});

test('a code review of the files asked for goes to the tablet as pages and markup, comes back with located marks, and returns as the next round', async () => {
  const repo = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eee-home-'));
  const { server, token } = await startHub({ port: 0, home, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) =>
    (
      await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-EEE-Token': token },
        body: body && JSON.stringify(body),
      })
    ).json();

  try {
    const { review } = await call('POST', '/api/agent/create', {
      title: 'Logging',
      kind: 'code',
      repo,
      files: ['auth.js', 'spec.md'],
    });
    const page = await (await fetch(`${base}/r/${review.id}`)).text();
    const client = JSON.parse(page.match(/var REVIEW = (.*);\n/)[1]);
    assert.deepEqual(
      client.docs.map((d) => `${d.kind} ${d.path}`),
      ['diff auth.js', 'file auth.js', 'spec spec.md'],
    );
    assert.match(await (await fetch(`${base}/`)).text(), /Logging/);

    const diff = client.docs[0];
    const added = diff.rowNew.indexOf(2);
    const inbox = await call('GET', '/api/inbox');
    assert.deepEqual(inbox.map((r) => [r.id, r.round, r.docs]), [[review.id, 1, 3]]);
    const rendered = await (await fetch(`${base}/r/${review.id}/1/pages/0/index.json`)).json();
    const strip = Buffer.from(await (await fetch(`${base}/r/${review.id}/1/pages/0/0.png`)).arrayBuffer());
    assert.ok(strip.subarray(1, 4).equals(Buffer.from('PNG')));
    const [, addedBottom] = rendered.rows.find(([, , row]) => row === added);
    const waiting = fetch(`${base}/api/agent/wait/${review.id}?timeout=30`, { headers: { 'X-EEE-Token': token } }).then((r) => r.json());
    const submitted = {
      round: 1,
      marks: [
        {
          id: 'm1',
          doc: diff.id,
          ink: [
            [10, 10],
            [200, 12],
          ],
          note: [
            [
              [5, 5, 180],
              [80, 30, 190],
            ],
          ],
          rows: [added],
          stamp: 'no',
        },
        { id: 'm2', doc: diff.id, ink: [[[20, addedBottom + 4], [300, addedBottom + 5]]], note: [] },
      ],
    };
    await call('POST', `/api/r/${review.id}/submit`, submitted);
    const feedback = await waiting;
    assert.equal(feedback.status, 'feedback');
    assert.equal(feedback.marks[0].where, 'auth.js (Diff, Zeile 2)');
    assert.equal(feedback.marks[0].text, '+  log(id);');
    assert.equal(feedback.marks[0].stamp, 'no');
    assert.equal(feedback.marks[1].where, 'auth.js (Diff, Zeile 2)', 'ink alone is located on the rendered page');
    assert.ok(Buffer.from(feedback.marks[1].crop, 'base64').subarray(1, 4).equals(Buffer.from('PNG')), 'with the page around it');
    assert.ok(Buffer.from(feedback.marks[0].note, 'base64').subarray(1, 4).equals(Buffer.from('PNG')));
    await call('POST', `/api/r/${review.id}/submit`, submitted);
    const again = await call('GET', `/api/agent/wait/${review.id}?timeout=1`);
    assert.equal(again.again, true, 'an unanswered round comes again, in case the agent never got it');
    assert.equal(again.marks.length, 2, 'and a resent submit did not change it');
    const late = await fetch(`${base}/api/r/${review.id}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ round: 1, marks: [] }) });
    assert.equal(late.status, 409, 'a submitted round takes no more changes');

    const { review: next } = await call('POST', `/api/agent/respond/${review.id}`, {
      replies: [{ mark: 1, text: 'Removed the log call.' }],
    });
    assert.equal(next.round, 2);
    const round2 = await (await fetch(`${base}/r/${review.id}`)).text();
    assert.match(round2, /Removed the log call\./);
    assert.match(round2, new RegExp(`/r/${review.id}/note/1/m1`));
    const stale = await fetch(`${base}/api/r/${review.id}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ round: 1, marks: [] }) });
    assert.equal(stale.status, 409, 'a draft queued for the last round is refused');
    assert.equal((await fetch(`${base}/r/${review.id}/1/pages/2/index.json`)).status, 404, 'a past round is not rendered anew');

    await call('POST', `/api/agent/context/${review.id}`, { files: ['auth.js'] });
    const withContext = JSON.parse(
      (await (await fetch(`${base}/r/${review.id}`)).text()).match(/var REVIEW = (.*);\n/)[1],
    );
    assert.equal(withContext.docs.filter((d) => d.context).length, 0, 'a file already shown whole is not added twice');
  } finally {
    server.close();
  }
});

test('a pull request comes with its details and comments, shows only what its branch changed, and marks on a comment name it', async () => {
  const repo = tempRepo();
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
  git('branch', '-M', 'main');
  git('checkout', '-qb', 'feature');
  git('add', 'auth.js');
  git('commit', '-qm', 'log issued ids');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'spec.md'), '# Plan\n\nRotate tokens.\n\nKeep the old ones a day.\n');
  git('commit', '-qam', 'meanwhile on main');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eee-home-'));
  const { server, token } = await startHub({ port: 0, home, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) =>
    (await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-EEE-Token': token }, body: body && JSON.stringify(body) })).json();

  try {
    const { review } = await call('POST', '/api/agent/create', {
      title: 'PR 7',
      kind: 'code',
      repo,
      base: 'main',
      head: 'feature',
      files: ['auth.js', 'spec.md'],
      overview: '# Log issued ids\n\nby Anna, feature -> main',
      comments: [
        { file: 'auth.js', line: 2, author: 'Anna', text: 'Is logging ids fine here?', ref: '42', replies: [{ author: 'Ben', text: 'Only in dev.' }] },
        { file: 'spec.md', line: 3, author: 'Ben', text: 'How long?' },
        { author: 'Carl', text: 'Looks good overall.' },
        { file: 'deploy.yml', line: 9, author: 'Carl', text: 'Bump the version.' },
      ],
    });
    const page = await (await fetch(`${base}/r/${review.id}`)).text();
    const client = JSON.parse(page.match(/var REVIEW = (.*);\n/)[1]);
    const docs = JSON.parse(page.match(/var DOCS = (.*);<\/script>/)[1]);
    assert.deepEqual(
      client.docs.map((d) => `${d.kind} ${d.path ?? d.title}`),
      ['spec Übersicht', 'diff auth.js', 'file auth.js', 'spec spec.md'],
      'the overview leads, and main moving on meanwhile is not part of the change',
    );
    assert.doesNotMatch(docs[3], /Keep the old ones/, 'a file without changes is shown as of head');
    assert.match(docs[0], /Log issued ids[\s\S]*<h2>Kommentare<\/h2>[\s\S]*Looks good overall\.[\s\S]*Kommentare zu weiteren Dateien[\s\S]*deploy\.yml · Zeile 9[\s\S]*Bump the version/);
    assert.match(docs[1], /log<\/span>\(id\);[\s\S]*<tr class="note">[\s\S]*Is logging ids fine here\?[\s\S]*Only in dev\./, 'below its line in the diff');
    assert.match(docs[2], /Is logging ids fine here\?/, 'and in the whole file');
    assert.match(docs[3], /Rotate tokens\.<\/p>\s*<div class="comment"[^>]*>[\s\S]*How long\?/, 'after its block in markdown');

    const diff = client.docs[1];
    const store = new Store(home);
    const row = store.docs(review.id, 1)[1].rows.findIndex((r) => r.kind === 'comment');
    await call('POST', `/api/r/${review.id}/submit`, { marks: [{ id: 'm1', doc: diff.id, ink: [[[5, 5], [60, 6]]], note: [], rows: [row] }] });
    const feedback = await call('GET', `/api/agent/wait/${review.id}?timeout=5`);
    assert.equal(feedback.marks[0].where, 'auth.js (Diff, Zeile 2)');
    assert.equal(feedback.marks[0].text, '[Kommentar 42 von Anna zu auth.js:2] Is logging ids fine here?\n  Antwort von Ben: Only in dev.');

    await call('POST', `/api/agent/respond/${review.id}`, {
      replies: [{ mark: 1, text: 'Drafted a reply.' }],
      drafts: [
        { ref: '42', text: 'Only in dev, as Ben says.' },
        { file: 'auth.js', line: 2, text: 'Could be debug level.' },
        { text: 'Thanks all!' },
      ],
    });
    const round2 = store.docs(review.id, 2);
    assert.deepEqual(round2.map((d) => d.title).slice(0, 2), ['Antworten Runde 1', 'Kommentar-Entwürfe']);
    const draftRow = (n) => round2[1].rows.findIndex((r) => r.kind === 'draft' && r.draft === n);
    const onDraft = (n, extra) => ({ id: `d${n}`, doc: round2[1].id, ink: [[[5, 5], [60, 6]]], note: [], rows: [draftRow(n)], ...extra });
    await call('POST', `/api/r/${review.id}/submit`, {
      marks: [onDraft(1, { stamp: 'ok' }), onDraft(2, { note: [[[1, 1, 200], [30, 10, 200]]] })],
    });
    const verdicts = (await call('GET', `/api/agent/wait/${review.id}?timeout=5`)).drafts;
    assert.deepEqual(
      verdicts.map((d) => [d.n, d.ref ?? null, d.verdict, d.marks]),
      [
        [1, '42', 'ok', [1]],
        [2, null, 'change', [2]],
        [3, null, 'none', []],
      ],
      'each draft comes back with what the user stamped or wrote on it',
    );
  } finally {
    server.close();
  }
});

test('the hub answers neither web pages elsewhere nor callers without its token, and reads no file outside the repository', async () => {
  const repo = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eee-home-'));
  const { server, token } = await startHub({ port: 0, home, log: () => {} });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const create = (body, headers) =>
    fetch(`${base}/api/agent/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EEE-Token': token, ...headers }, body: JSON.stringify(body) });

  try {
    assert.equal((await create({ title: 't', kind: 'spec', repo, files: ['spec.md'] }, { 'X-EEE-Token': 'guess' })).status, 403, 'agent API without the token');
    const simple = await fetch(`${base}/api/agent/create`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-EEE-Token': token }, body: '{}' });
    assert.equal(simple.status, 415, 'a post a web page could send without a preflight');
    const rebound = await new Promise((resolve) =>
      http.get({ host: '127.0.0.1', port, path: '/api/inbox', headers: { Host: `evil.example:${port}` } }, (res) => resolve(res.statusCode)),
    );
    assert.equal(rebound, 403, 'a name other than localhost, as DNS rebinding brings');
    fs.symlinkSync(os.homedir(), path.join(repo, 'home'));
    for (const file of ['../outside.md', 'home/.profile']) {
      const res = await create({ title: 't', kind: 'spec', repo, files: [file] });
      assert.match((await res.json()).error ?? '', /outside the repository/, file);
    }
    const { review } = await (await create({ title: 't', kind: 'spec', repo, files: ['spec.md'] })).json();
    const deflated = await fetch(`${base}/api/r/${review.id}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' },
      body: zlib.deflateSync(JSON.stringify({ round: 1, marks: [{ id: 'm1', doc: 'x', ink: [], note: [] }] })),
    });
    assert.equal(deflated.status, 200, 'the tablet deflates what it sends');
  } finally {
    server.close();
  }
});
