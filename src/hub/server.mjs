import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../render/highlight.mjs';
import { Store } from './store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_PORT = Number(process.env.EEE_REVIEW_PORT ?? 8770);

const STATUS = {
  open: 'neu',
  'in-progress': 'in Arbeit',
  submitted: 'beim Agenten',
  closed: 'abgeschlossen',
};

function send(req, res, body, type = 'text/html; charset=utf-8', status = 200) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!type.startsWith('image/') && payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    payload = zlib.gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(payload);
}
const json = (req, res, value, status = 200) => send(req, res, JSON.stringify(value), 'application/json', status);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function inboxPage(store) {
  const reviews = store.list().filter((r) => r.status !== 'closed');
  const items = reviews
    .map(
      (r) =>
        `<a class="item${r.status === 'open' ? ' new' : ''}" href="/r/${r.id}"><b>${escapeHtml(r.title)}</b><span>${
          r.kind === 'code' ? 'Code' : 'Dokument'
        } · Runde ${r.round} · ${STATUS[r.status] ?? r.status}</span></a>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="10">
<title>Reviews</title><link rel="stylesheet" href="/web/inbox.css"></head>
<body><h1>Reviews</h1>${items || '<p class="empty">Nichts offen. Neue Reviews erscheinen hier von selbst.</p>'}</body></html>`;
}

function reviewPage(store, review) {
  const docs = store.docs(review.id, review.round);
  const client = {
    id: review.id,
    title: review.title,
    kind: review.kind,
    round: review.round,
    status: review.status,
    docs: docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      path: d.path,
      added: !!d.added,
      rowNew: d.rows.map((r) => r.new ?? (r.lines ? r.lines[0] : 0)),
    })),
    marks: store.draft(review.id, review.round).marks,
  };
  const store_ = docs.map((d, i) => `<div id="doc-${i}">${d.html}</div>`).join('');
  return `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width"><title>${escapeHtml(review.title)}</title>
<link rel="stylesheet" href="/web/review.css"></head>
<body>
<div class="pane" id="docPane"><div id="docLayer"></div><canvas id="docCanvas"></canvas></div>
<canvas id="rail"></canvas>
<div class="bar" id="noteBar"><span id="grip">&#9776;</span><span id="noteTitle"></span>
<button type="button" data-stamp="ok">OK</button><button type="button" data-stamp="no">Nein</button><button type="button" data-stamp="ask">?</button>
<button type="button" id="askAgent">Frage</button><button type="button" id="noteClose">Schlie&szlig;en</button></div>
<div class="pane" id="notePane"><canvas id="noteCanvas"></canvas></div>
<div class="bar" id="toolBar"><button type="button" id="filesBtn">Dateien</button><button type="button" id="toolPen" class="on">Stift</button><button type="button" id="toolEraser">Radierer</button><button type="button" id="toolHand">Hand</button><button type="button" id="undo">&#8630;</button><span id="status"></span></div>
<div id="files"></div>
<div id="store" style="display:none">${store_}</div>
<script type="text/javascript">var REVIEW = ${JSON.stringify(client)};</script>
<script type="text/javascript" src="/web/review.js"></script>
</body></html>`;
}

function pendingForAgent(store, pending) {
  const { review, round, requests, feedback } = pending;
  const mark = (m, n) => {
    const { where, text } = store.describe(review.id, round, m);
    const note = store.notePng(review.id, round, m.id);
    return { n, id: m.id, where, text, stamp: m.stamp ?? null, note: note ? note.toString('base64') : null };
  };
  return {
    status: feedback ? 'feedback' : 'requests',
    review: { id: review.id, title: review.title, kind: review.kind, round },
    requests: requests.map((r) => mark(r.mark, null)),
    marks: feedback ? feedback.marks.map((m, i) => mark(m, i + 1)) : [],
  };
}

export function startHub({ port = DEFAULT_PORT, home, log = console.log } = {}) {
  const store = new Store(home);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const p = url.pathname;
    let m;
    try {
      if (req.method === 'GET' && p === '/') return send(req, res, inboxPage(store));
      if (req.method === 'GET' && (m = p.match(/^\/web\/([\w.-]+\.(js|css))$/))) {
        const file = path.join(root, 'web', m[1]);
        if (fs.existsSync(file))
          return send(req, res, fs.readFileSync(file), m[2] === 'js' ? 'text/javascript' : 'text/css');
      }
      if (req.method === 'GET' && (m = p.match(/^\/native\/(eeereview|inktest)$/))) {
        const file = path.join(root, 'native', m[1], m[1]);
        if (fs.existsSync(file)) return send(req, res, fs.readFileSync(file), 'application/octet-stream');
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})$/))) {
        log('open', m[1]);
        return send(req, res, reviewPage(store, store.get(m[1])));
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})\/fig\/([0-9a-f]+\.png)$/))) {
        return send(req, res, fs.readFileSync(store.dir(m[1], 'figures', m[2])), 'image/png');
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})\/note\/(\d+)\/([\w-]+)$/))) {
        const png = store.notePng(m[1], Number(m[2]), m[3]);
        if (png) return send(req, res, png, 'image/png');
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/r\/([0-9a-f]{8})\/(draft|submit|request)$/))) {
        const body = await readBody(req);
        if (m[2] === 'draft') store.saveDraft(m[1], body.marks ?? []);
        if (m[2] === 'submit') store.submit(m[1], body.marks ?? []);
        if (m[2] === 'request') store.request(m[1], body.mark);
        if (m[2] !== 'draft') log(m[2], m[1]);
        return json(req, res, { ok: true });
      }

      if (p.startsWith('/api/agent/')) {
        if (!isLocal(req)) return json(req, res, { error: 'agent API is local only' }, 403);
        if (req.method === 'GET' && p === '/api/agent/list') return json(req, res, store.list());
        if (req.method === 'POST' && p === '/api/agent/create') {
          const review = await store.create(await readBody(req));
          log('created', review.id, review.title);
          return json(req, res, { review, url: `/r/${review.id}` });
        }
        if (req.method === 'GET' && (m = p.match(/^\/api\/agent\/wait\/([0-9a-f]{8})$/))) {
          const id = m[1];
          const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 240), 3600) * 1000;
          const take = () => {
            const pending = store.takePending(id);
            return pending ? pendingForAgent(store, pending) : null;
          };
          const now = take();
          if (now) return json(req, res, now);
          return await new Promise((resolve) => {
            const done = (value) => {
              clearTimeout(timer);
              store.off('feedback', onFeedback);
              req.off('close', onClose);
              resolve(value && json(req, res, value));
            };
            const onFeedback = (changed) => changed === id && done(take());
            const onClose = () => done(null);
            const timer = setTimeout(() => done({ status: 'waiting', review: store.get(id) }), timeout);
            store.on('feedback', onFeedback);
            req.on('close', onClose);
          });
        }
        if (req.method === 'POST' && (m = p.match(/^\/api\/agent\/(respond|context|close)\/([0-9a-f]{8})$/))) {
          const body = await readBody(req);
          if (m[1] === 'respond') return json(req, res, { review: await store.respond(m[2], body) });
          if (m[1] === 'context')
            return json(req, res, { docs: (await store.addContext(m[2], body.files ?? [])).length });
          store.close(m[2]);
          return json(req, res, { ok: true });
        }
      }
      send(req, res, 'not found', 'text/plain', 404);
    } catch (err) {
      log('error', p, err.message);
      json(req, res, { error: err.message }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve({ server, store, urls: lanUrls(port) }));
  });
}

export function lanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}/`);
}
