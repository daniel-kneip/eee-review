import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, hubToken, lanUrls } from '../hub/server.mjs';

// What an agent does with the hub, for the MCP server and the agent CLI alike. Each speaks
// of its own commands in what it tells the agent, so the texts take them as `to`.

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.mjs');
const hub = `http://127.0.0.1:${DEFAULT_PORT}`;
const STAMPS = { ok: 'OK', no: 'Nein', ask: '? unklar' };

export async function call(method, route, body) {
  const res = await fetch(hub + route, {
    method,
    headers: { 'X-EEE-Token': hubToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error ?? `hub answered ${res.status}`);
  return value;
}

// Every agent session runs its own client, but they share one hub, so reviews from all of
// them meet in one inbox on the tablet. The first to need the hub starts it detached.
export async function ensureHub() {
  try {
    await call('GET', '/api/agent/list');
    return;
  } catch {}
  spawn(process.execPath, [cli, 'hub'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await call('GET', '/api/agent/list');
      return;
    } catch {}
  }
  throw new Error(`the review hub did not start on port ${DEFAULT_PORT}`);
}

function repoOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const text = (t) => ({ type: 'text', text: t });
const image = (data, name) => ({ type: 'image', data, name });

// The user says when a round is on its way; the agent then fetches it, instead of waiting.
const waitForUser = (to, id) =>
  `Sag dem Nutzer, dass es auf dem Tablet liegt, und warte auf seine Nachricht, dass er die Runde abgeschickt hat. Dann hol sie mit ${to.fetch(id)} ab.`;

export async function create(to, { title, kind = 'spec', files = [], exclude = [], base = 'HEAD', head, repo, overview, comments = [] }) {
  await ensureHub();
  // Some clients start their tools outside the project (Kiro with a user-level config), so an
  // unset repo only falls back to the working directory when that is a git repo.
  const root = repo ? (repoOf(path.resolve(repo)) ?? path.resolve(repo)) : repoOf(process.cwd());
  if (!root) throw new Error(`Kein Repository gefunden (Arbeitsverzeichnis ${process.cwd()}). Gib repo als absoluten Pfad des Projekts an.`);
  const inRepo = (f) => path.relative(root, path.resolve(root, f));
  const { review } = await call('POST', '/api/agent/create', {
    title,
    kind,
    repo: root,
    files: files.map(inRepo),
    exclude,
    base,
    head,
    overview,
    comments: comments.map((c) => (c.file ? { ...c, file: inRepo(c.file) } : c)),
  });
  const where = lanUrls(DEFAULT_PORT)[0] ?? `Port ${DEFAULT_PORT}`;
  return [text(`Review ${review.id} ("${review.title}") liegt auf dem Tablet bereit (${where}). ${waitForUser(to, review.id)}`)];
}

// What the user sent since the last fetch; with a timeout, waits that long for it.
export async function fetchRound(to, id, timeout = 0) {
  await ensureHub();
  const result = await call('GET', `/api/agent/wait/${id}?timeout=${timeout}`);
  if (result.status === 'waiting')
    return [text(`Noch nichts Neues von Review ${id} (Status: ${result.review.status}). Frag den Nutzer, ob er die Runde schon abgeschickt hat.`)];
  return feedbackContent(to, result);
}

export async function respond(to, id, body) {
  await ensureHub();
  const { review } = await call('POST', `/api/agent/respond/${id}`, body);
  return [text(`Runde ${review.round} von "${review.title}" liegt auf dem Tablet. ${waitForUser(to, id)}`)];
}

export async function addContext(to, id, files) {
  await ensureHub();
  const { docs } = await call('POST', `/api/agent/context/${id}`, { files });
  return [text(`Nachgeliefert. Das Review hat jetzt ${docs} Dokumente. ${waitForUser(to, id)}`)];
}

export async function close(id) {
  await ensureHub();
  await call('POST', `/api/agent/close/${id}`, {});
  return [text(`Review ${id} ist abgeschlossen.`)];
}

export async function list() {
  await ensureHub();
  const reviews = await call('GET', '/api/agent/list');
  const lines = reviews.map((r) => `${r.id}  ${r.status.padEnd(11)}  Runde ${r.round}  ${r.kind}  ${r.title}`);
  return [text(lines.join('\n') || 'Keine Reviews.')];
}

const VERDICT = {
  ok: 'freigegeben (OK): so posten',
  no: 'verworfen (Nein): nicht posten',
  change: 'Änderung gewünscht: Notiz lesen, überarbeiten und in der nächsten Runde erneut vorlegen',
  unclear: 'markiert, aber ohne OK, Nein oder Notiz: nachfragen, nicht posten',
  none: 'nicht markiert: nicht posten',
};

function feedbackContent(to, result) {
  const { review } = result;
  const content = [];
  const describe = (m, heading, name) => {
    const stamp = m.stamp ? ` [${STAMPS[m.stamp] ?? m.stamp}]` : '';
    let t = `## ${heading}: ${m.where}${stamp}\n`;
    if (m.text) t += '\nMarkierter Inhalt:\n```\n' + m.text + '\n```\n';
    if (m.crop) {
      content.push(text(t + '\nSo sieht die Markierung auf der Seite aus (Tinte schwarz über aufgehellter Seite):'));
      content.push(image(m.crop, `${name}-seite.png`));
      t = '';
    }
    t += m.note ? '\nHandschriftliche Notiz dazu:' : '\n(keine Notiz)';
    content.push(text(t));
    if (m.note) content.push(image(m.note, `${name}-notiz.png`));
  };
  if (result.requests.length) {
    content.push(
      text(
        `# Fragen während des Reviews von "${review.title}" (${review.id}), Runde ${review.round}\n\nDer Nutzer liest noch und bittet um Kontext. Lies die Notiz und liefere passende Dateien mit ${to.context(review.id)} nach.`,
      ),
    );
    result.requests.forEach((m, i) => describe(m, `Frage ${i + 1}`, `frage-${i + 1}`));
  }
  if (result.status === 'feedback') {
    const again = result.again
      ? '\n\nDiese Runde wurde schon einmal geliefert, aber noch nicht beantwortet. Falls du sie schon kennst, antworte einfach.'
      : '';
    const next = result.marks.length
      ? `Lies jede handschriftliche Notiz und schreibe als Erstes auf, wie du sie gelesen hast; der Nutzer sieht deine Lesart in der nächsten Runde. Antworte dann mit ${to.respond(review.id)}, eine Antwort pro Markierung (mark = Nummer).`
      : `Der Nutzer hat nichts markiert. Frag im Chat nach, ob das Review damit erledigt ist, und schließe es dann mit ${to.close(review.id)}, statt eine leere Runde zu starten.`;
    content.push(text(`# Review "${review.title}" (${review.id}), Runde ${review.round}: ${result.marks.length} Markierungen\n\n${next}${again}`));
    result.marks.forEach((m) => describe(m, `Markierung ${m.n}`, `markierung-${m.n}`));
    if (result.drafts?.length) {
      const lines = result.drafts.map(
        (d) => `- Entwurf ${d.n}${d.ref ? ` (Antwort auf ${d.ref})` : ''}: ${VERDICT[d.verdict]}${d.marks.length ? ` (Markierung ${d.marks.join(', ')})` : ''}`,
      );
      content.push(text(`# Kommentar-Entwürfe\n\n${lines.join('\n')}\n\nPoste nur die freigegebenen, mit genau ihrem Text.`));
    }
  }
  return content;
}
