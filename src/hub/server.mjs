import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { markCrop } from '../render/crop.mjs';
import { escapeHtml } from '../render/highlight.mjs';
import { PAGE_WIDTH, PageRenderer } from '../render/pages.mjs';
import { rowsUnderInk } from './rows.mjs';
import { iconPng } from '../tablet/icon.mjs';
import { defaultHome, Store } from './store.mjs';

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

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The tablet deflates what it sends: ink compresses well, and its upstream is the slow way.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'deflate') body = zlib.inflateSync(body);
        resolve(body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

// The hub's secret: the agent's MCP server sends it with every call, and deploy leaves it on
// the tablet, whose requests over Wi-Fi carry it. Local requests need it only for the agent API.
export function hubToken(home = defaultHome()) {
  const file = path.join(home, 'token');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(18).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

// A web page elsewhere cannot use the hub through the browser: names other than localhost
// (DNS rebinding) are refused, and posts must be JSON, which a page cannot send cross-site
// without a preflight the hub never allows.
function hostAllowed(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || net.isIP(host) !== 0;
}
const cookieToken = (req) => (req.headers.cookie ?? '').match(/(?:^|;\s*)eee=([^;]+)/)?.[1];

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

function clientReview(store, review) {
  const docs = store.docs(review.id, review.round);
  return {
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
}

function reviewPage(store, review) {
  const docs = store.docs(review.id, review.round);
  const client = clientReview(store, review);
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

// One document alone at the tablet's page width, for PageRenderer to photograph.
function renderPage(store, review, index) {
  const doc = store.docs(review.id, review.round)[index];
  return `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<link rel="stylesheet" href="/web/review.css">
<style>html, body { overflow: visible; } #docLayer { position: static; width: ${PAGE_WIDTH}px; }</style></head>
<body><div id="docLayer">${doc.html}</div></body></html>`;
}

function pendingForAgent(store, pending) {
  const { review, round, requests, feedback, again } = pending;
  const docs = store.docs(review.id, round);
  const mark = (m, n) => {
    const { where, text } = store.describe(review.id, round, m);
    const note = store.notePng(review.id, round, m.id);
    const index = docs.findIndex((d) => d.id === m.doc);
    let crop = null;
    try {
      if (index >= 0) crop = markCrop(store.roundDir(review.id, round, 'pages', String(index)), m.ink, store.dir(review.id, 'figures'));
    } catch {
      // A cut is a help to the agent; the marks go without it.
    }
    return {
      n,
      id: m.id,
      where,
      text,
      stamp: m.stamp ?? null,
      note: note ? note.toString('base64') : null,
      crop: crop ? crop.toString('base64') : null,
    };
  };
  return {
    status: feedback ? 'feedback' : 'requests',
    again,
    review: { id: review.id, title: review.title, kind: review.kind, round },
    requests: requests.map((r) => mark(r.mark, null)),
    marks: feedback ? feedback.marks.map((m, i) => mark(m, i + 1)) : [],
    drafts: feedback ? store.draftVerdicts(review.id, round, feedback.marks) : [],
  };
}

export function startHub({ port = DEFAULT_PORT, home, log = console.log } = {}) {
  const store = new Store(home);
  const token = hubToken(store.home);
  const renderer = new PageRenderer();
  const self = () => `http://127.0.0.1:${server.address().port}`;

  // A round's documents do not change, so their pages are rendered once and kept with it.
  // Only the current round can still be rendered.
  async function pages(id, round, index) {
    const review = store.get(id);
    const dir = store.roundDir(id, round, 'pages', String(index));
    if (!fs.existsSync(path.join(dir, 'index.json')) && round === review.round)
      await renderer.render(`${self()}/r/${id}/render/${index}`, dir);
    return dir;
  }

  // The tablet queues what it sends while offline and sends it again when unsure it arrived,
  // so a post for a round that has moved on is refused, and a repeated one changes nothing.
  function stale(id, body) {
    return body.round !== undefined && body.round !== store.get(id).round;
  }
  function repeated(id, action, body) {
    const round = store.get(id).round;
    if (action === 'submit') {
      const feedback = store.feedback(id, round);
      return !!feedback && JSON.stringify(feedback.marks) === JSON.stringify(locate(id, body.marks ?? []));
    }
    if (action !== 'request') return false;
    const mark = JSON.stringify(locate(id, [body.mark])[0]);
    return store.requests(id, round).some((r) => JSON.stringify(r.mark) === mark);
  }

  // The native app sends ink alone; the rows it means come from where they sit on its pages.
  function locate(id, marks) {
    const review = store.get(id);
    const docs = store.docs(id, review.round);
    return marks.map((mark) => {
      if (Array.isArray(mark.rows)) return mark;
      const index = docs.findIndex((d) => d.id === mark.doc);
      const page = readJsonFile(store.roundDir(id, review.round, 'pages', String(index), 'index.json'));
      return { ...mark, rows: page ? rowsUnderInk(mark.ink ?? [], page.rows) : [] };
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const p = url.pathname;
    let m;
    if (process.env.EEE_REVIEW_DEBUG) log(req.method, p, 'from', req.socket.remoteAddress, req.headers['accept-encoding'] ?? '-');
    if (!hostAllowed(req)) return json(req, res, { error: 'unknown host' }, 403);
    if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] ?? ''))
      return json(req, res, { error: 'posts must be application/json' }, 415);
    const presented = req.headers['x-eee-token'] ?? url.searchParams.get('token') ?? cookieToken(req);
    const knows = presented === token;
    // A browser that brought the token once keeps it as a cookie.
    if (url.searchParams.get('token') === token) res.setHeader('Set-Cookie', `eee=${token}; HttpOnly; SameSite=Strict; Path=/`);
    try {
      if (req.method === 'GET' && p === '/api/ping') return json(req, res, { ok: true });
      if (p.startsWith('/api/agent/')) {
        if (!isLocal(req) || !knows) return json(req, res, { error: 'the agent API needs the hub token, from this machine' }, 403);
      } else if (!isLocal(req) && !knows) return json(req, res, { error: 'the hub token is missing' }, 401);
      if (req.method === 'GET' && p === '/') return send(req, res, inboxPage(store));
      if (req.method === 'GET' && p === '/api/inbox') {
        const open = store.list().filter((r) => r.status !== 'closed');
        return json(
          req,
          res,
          open.map((r) => ({
            id: r.id,
            title: r.title,
            kind: r.kind,
            round: r.round,
            docs: store.docs(r.id, r.round).length,
            status: r.status,
            label: STATUS[r.status] ?? r.status,
          })),
        );
      }
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
      if (req.method === 'GET' && (m = p.match(/^\/api\/r\/([0-9a-f]{8})$/))) {
        return json(req, res, clientReview(store, store.get(m[1])));
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})\/render\/(\d+)$/))) {
        return send(req, res, renderPage(store, store.get(m[1]), Number(m[2])));
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})\/(\d+)\/pages\/(\d+)\/(index\.json|\d+\.png)$/))) {
        const file = path.join(await pages(m[1], Number(m[2]), Number(m[3])), m[4]);
        if (fs.existsSync(file)) return send(req, res, fs.readFileSync(file), m[4].endsWith('.png') ? 'image/png' : 'application/json');
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})\/fig\/([0-9a-f]+(?:@\d)?\.png)$/))) {
        return send(req, res, fs.readFileSync(store.dir(m[1], 'figures', m[2])), 'image/png');
      }
      if (req.method === 'GET' && (m = p.match(/^\/r\/([0-9a-f]{8})\/note\/(\d+)\/([\w-]+)$/))) {
        const png = store.notePng(m[1], Number(m[2]), m[3]);
        if (png) return send(req, res, png, 'image/png');
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/r\/([0-9a-f]{8})\/(draft|submit|request)$/))) {
        const body = await readBody(req);
        if (stale(m[1], body)) return json(req, res, { error: 'the review has moved on to another round' }, 409);
        if (repeated(m[1], m[2], body)) return json(req, res, { ok: true });
        // Once submitted, the round is the agent's: later changes would renumber its marks.
        if (store.get(m[1]).status === 'submitted') return json(req, res, { error: 'the round is already submitted' }, 409);
        if (m[2] === 'draft') store.saveDraft(m[1], locate(m[1], body.marks ?? []));
        if (m[2] === 'submit') store.submit(m[1], locate(m[1], body.marks ?? []));
        if (m[2] === 'request') store.request(m[1], locate(m[1], [body.mark])[0]);
        if (m[2] !== 'draft') log(m[2], m[1]);
        return json(req, res, { ok: true });
      }

      if (p.startsWith('/api/agent/')) {
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
          const now = take() ?? (() => {
            const pending = store.takePending(id, { again: true });
            return pending ? pendingForAgent(store, pending) : null;
          })();
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

  // Qt 4.6 on the tablet posts on a kept-alive connection without checking it is still open,
  // and Node closes idle ones after five seconds: drafts then failed now and again.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.on('close', () => renderer.close());
  server.on('clientError', (err, socket) => {
    log('rejected request', err.code, JSON.stringify(err.rawPacket?.toString('latin1') ?? ''));
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND, () => resolve({ server, store, token, urls: BIND === '0.0.0.0' ? lanUrls(port) : [] }));
  });
}

export function lanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}/`);
}
