import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../render/highlight.mjs';
import { iconPng } from '../tablet/icon.mjs';
import { Store } from './store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_PORT = Number(process.env.EEE_REVIEW_PORT ?? 8770);
// 127.0.0.1 keeps the hub off the network entirely; the tablet then reaches it only through
// the USB cable, where eeelink connects to it from this machine.
const BIND = process.env.EEE_REVIEW_BIND ?? '0.0.0.0';

// What deploy fetches onto the tablet.
const TABLET_FILES = {
  eeereview: 'eeereview/eeereview',
  inktest: 'inktest/inktest',
  eeelink: 'eeelink/eeelink',
  'start.sh': 'tablet/start.sh',
  qcopspy: 'qcopspy/qcopspy',
  pagetest: 'pagetest/pagetest',
};
const TABLET_ICONS = {
  'icon_b_eeereview.png': () => iconPng(259, 261, 5),
  'icon_s_eeereview.png': () => iconPng(97, 97, 2.5),
};

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
<body><button type="button" id="quit" onclick="eeeApp.quit()">Beenden</button><h1>Reviews</h1>${
    items || '<p class="empty">Nichts offen. Neue Reviews erscheinen hier von selbst.</p>'
  }<script type="text/javascript">if (window.eeeApp) document.getElementById('quit').style.display = 'block';
window.keys = { press: function (name) {
  if (name === 'left' || name === 'right') { window.scrollBy(0, (name === 'left' ? -0.75 : 0.75) * window.innerHeight); return true; }
  return false;
} };</script></body></html>`;
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
      context: !!d.added,
      status: d.status ?? null,
      plus: d.plus ?? null,
      minus: d.minus ?? null,
      rowNew: d.rows.map((r) => r.new ?? (r.lines ? r.lines[0] : 0)),
    })),
    marks: store.draft(review.id, review.round).marks,
  };
  const script = (value) =>
    JSON.stringify(value).replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width"><title>${escapeHtml(review.title)}</title>
<link rel="stylesheet" href="/web/review.css"></head>
<body>
<div class="pane" id="docPane"><div id="docLayer"></div></div>
<canvas id="rail"></canvas>
<div class="bar" id="noteBar"><span id="grip">&#9776;</span><span id="noteTitle"></span>
<button type="button" data-stamp="ok">OK</button><button type="button" data-stamp="no">Nein</button><button type="button" data-stamp="ask">?</button>
<button type="button" id="askAgent">Frage</button><button type="button" id="noteClose">Schlie&szlig;en</button></div>
<div class="pane" id="notePane"><div id="noteLayer"></div></div>
<div class="bar" id="toolBar"><button type="button" id="filesBtn">Dateien</button><button type="button" id="toolPen" class="on">Stift</button><button type="button" id="toolEraser">Radierer</button><button type="button" id="undo">&#8630;</button><button type="button" id="prevDoc">&#9664;</button><button type="button" id="nextDoc">&#9654;</button><span id="status"></span></div>
<div id="shade"></div>
<div id="files"></div>
<div id="store" style="display:none"></div>
<script type="text/javascript">var REVIEW = ${script(client)};
var DOCS = ${script(docs.map((d) => d.html))};</script>
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
    if (process.env.EEE_REVIEW_DEBUG) log(req.method, p, 'from', req.socket.remoteAddress, req.headers['accept-encoding'] ?? '-');
    try {
      if (req.method === 'GET' && p === '/api/ping') return json(req, res, { ok: true });
      if (req.method === 'GET' && p === '/') return send(req, res, inboxPage(store));
      if (req.method === 'GET' && (m = p.match(/^\/web\/([\w.-]+\.(js|css))$/))) {
        const file = path.join(root, 'web', m[1]);
        if (fs.existsSync(file))
          return send(req, res, fs.readFileSync(file), m[2] === 'js' ? 'text/javascript' : 'text/css');
      }
      if (req.method === 'GET' && (m = p.match(/^\/native\/([\w.-]+)$/)) && TABLET_ICONS[m[1]]) {
        return send(req, res, TABLET_ICONS[m[1]](), 'image/png');
      }
      if (req.method === 'GET' && (m = p.match(/^\/native\/([\w.-]+)$/)) && TABLET_FILES[m[1]]) {
        const file = path.join(root, 'native', TABLET_FILES[m[1]]);
        if (fs.existsSync(file)) return send(req, res, fs.readFileSync(file), 'application/octet-stream');
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})$/))) {
        log('open', m[1]);
        return send(req, res, reviewPage(store, store.get(m[1])));
      }
      if (req.method === 'GET' && (m = p.match(/^\/pages\/([0-9a-f]{8})\/(\d+)\/(index\.json|\d+\.png)$/))) {
        const file = path.join(store.home, 'pages', m[1], m[2], m[3]);
        if (fs.existsSync(file)) return send(req, res, fs.readFileSync(file), m[3].endsWith('.png') ? 'image/png' : 'application/json');
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

  server.on('clientError', (err, socket) => {
    log('rejected request', err.code, JSON.stringify(err.rawPacket?.toString('latin1') ?? ''));
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND, () => resolve({ server, store, urls: BIND === '0.0.0.0' ? lanUrls(port) : [] }));
  });
}

export function lanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}/`);
}
