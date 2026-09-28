import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { startHub } from '../src/hub/server.mjs';
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
  const { server } = await startHub({ port: 0, home, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) =>
    (
      await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
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
    const waiting = fetch(`${base}/api/agent/wait/${review.id}?timeout=30`).then((r) => r.json());
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
    assert.ok(Buffer.from(feedback.marks[0].note, 'base64').subarray(1, 4).equals(Buffer.from('PNG')));
    await call('POST', `/api/r/${review.id}/submit`, submitted);
    assert.equal((await call('GET', `/api/agent/wait/${review.id}?timeout=1`)).status, 'waiting', 'a resent submit is not new feedback');

    const { review: next } = await call('POST', `/api/agent/respond/${review.id}`, {
      replies: [{ mark: 1, text: 'Removed the log call.' }],
    });
    assert.equal(next.round, 2);
    const round2 = await (await fetch(`${base}/r/${review.id}`)).text();
    assert.match(round2, /Removed the log call\./);
    assert.match(round2, new RegExp(`/r/${review.id}/note/1/m1`));
    const late = await fetch(`${base}/api/r/${review.id}/draft`, { method: 'POST', body: JSON.stringify({ round: 1, marks: [] }) });
    assert.equal(late.status, 409, 'a draft queued for the last round is refused');
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
