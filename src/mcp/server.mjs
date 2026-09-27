import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEFAULT_PORT, lanUrls } from '../hub/server.mjs';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.mjs');
const hub = `http://127.0.0.1:${DEFAULT_PORT}`;
const STAMPS = { ok: 'OK', no: 'Nein', ask: 'Frage' };

async function call(method, route, body) {
  const res = await fetch(hub + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error ?? `hub answered ${res.status}`);
  return value;
}

// Every agent session runs its own MCP server, but they share one hub, so reviews from all of
// them meet in one inbox on the tablet. The first session to need the hub starts it detached.
async function ensureHub() {
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

function feedbackContent(result) {
  const { review } = result;
  const content = [];
  const describe = (m, heading) => {
    const stamp = m.stamp ? ` [${STAMPS[m.stamp] ?? m.stamp}]` : '';
    let t = `## ${heading}: ${m.where}${stamp}\n`;
    if (m.text) t += '\nMarkierter Inhalt:\n```\n' + m.text + '\n```\n';
    t += m.note ? '\nHandschriftliche Notiz dazu:' : '\n(keine Notiz)';
    content.push(text(t));
    if (m.note) content.push({ type: 'image', data: m.note, mimeType: 'image/png' });
  };
  if (result.requests.length) {
    content.push(
      text(
        `# Fragen während des Reviews von "${review.title}" (${review.id}), Runde ${review.round}\n\nDer Nutzer liest noch und bittet um Kontext. Lies die Notiz, liefere passende Dateien mit review_add_context nach und rufe danach wieder review_wait auf.`,
      ),
    );
    result.requests.forEach((m, i) => describe(m, `Frage ${i + 1}`));
  }
  if (result.status === 'feedback') {
    content.push(
      text(
        `# Review "${review.title}" (${review.id}), Runde ${review.round}: ${result.marks.length} Markierungen\n\nLies jede handschriftliche Notiz und schreibe als Erstes auf, wie du sie gelesen hast; der Nutzer sieht deine Lesart in der nächsten Runde. Antworte dann mit review_respond, eine Antwort pro Markierung (mark = Nummer).`,
      ),
    );
    result.marks.forEach((m) => describe(m, `Markierung ${m.n}`));
  }
  return content;
}

export async function startMcp() {
  const server = new McpServer({ name: 'eee-review', version: '0.1.0' });

  server.registerTool(
    'review_create',
    {
      title: 'Review auf dem Tablet starten',
      description:
        'Schickt Dokumente oder eine Code-Änderung zum Review auf das Eee-Note-Tablet des Nutzers. kind "spec": files sind die zu lesenden Dateien (Markdown wird gerendert, Mermaid als Bild). kind "code": die Änderung zwischen base und head (ohne head: Arbeitsverzeichnis gegen base, auch neue Dateien) als Diff und ganze Datei je Datei; files kommen als Kontext dazu. Danach review_wait aufrufen.',
      inputSchema: {
        title: z.string().describe('Kurzer Titel, erscheint in der Eingangsliste'),
        kind: z.enum(['spec', 'code']).default('spec'),
        files: z.array(z.string()).default([]).describe('Pfade relativ zum Repository'),
        base: z.string().default('HEAD').describe('nur code: Vergleichsbasis'),
        head: z.string().optional().describe('nur code: Ziel-Commit; weglassen für das Arbeitsverzeichnis'),
        repo: z
          .string()
          .optional()
          .describe(
            'Absoluter Pfad des Projekts; ohne Angabe das Git-Repository des Arbeitsverzeichnisses, falls es eines ist',
          ),
      },
    },
    async ({ title, kind, files, base, head, repo }) => {
      await ensureHub();
      // Some clients start MCP servers outside the project (Kiro with a user-level config),
      // so an unset repo only falls back to the working directory when that is a git repo.
      const root = repo ? (repoOf(path.resolve(repo)) ?? path.resolve(repo)) : repoOf(process.cwd());
      if (!root) {
        throw new Error(
          `Kein Repository gefunden (Arbeitsverzeichnis ${process.cwd()}). Gib repo als absoluten Pfad des Projekts an.`,
        );
      }
      const relative = files.map((f) => path.relative(root, path.resolve(root, f)));
      const { review } = await call('POST', '/api/agent/create', {
        title,
        kind,
        repo: root,
        files: relative,
        base,
        head,
      });
      return {
        content: [
          text(
            `Review ${review.id} ("${review.title}") liegt auf dem Tablet bereit (${lanUrls(DEFAULT_PORT)[0] ?? `Port ${DEFAULT_PORT}`}). Rufe jetzt review_wait mit id "${review.id}" auf und rufe es erneut auf, solange es "wartet noch" meldet.`,
          ),
        ],
      };
    },
  );

  server.registerTool(
    'review_wait',
    {
      title: 'Auf das Tablet warten',
      description:
        'Wartet, bis der Nutzer das Review auf dem Tablet abschickt oder unterwegs um Kontext bittet, und liefert Markierungen mit dem markierten Inhalt und handschriftlichen Notizen als Bilder. Kehrt nach timeout_seconds mit "wartet noch" zurück; dann erneut aufrufen.',
      inputSchema: {
        id: z.string(),
        timeout_seconds: z.number().int().min(10).max(1800).default(240),
      },
    },
    async ({ id, timeout_seconds }) => {
      await ensureHub();
      const result = await call('GET', `/api/agent/wait/${id}?timeout=${timeout_seconds}`);
      if (result.status === 'waiting') {
        return {
          content: [
            text(
              `Review ${id} wartet noch auf den Nutzer (Status: ${result.review.status}). Rufe review_wait erneut auf.`,
            ),
          ],
        };
      }
      return { content: feedbackContent(result) };
    },
  );

  server.registerTool(
    'review_respond',
    {
      title: 'Nächste Runde starten',
      description:
        'Beantwortet die Markierungen der abgeschickten Runde und startet die nächste: Die Antworten erscheinen auf dem Tablet als eigenes Dokument neben den Notizen des Nutzers, die Dateien werden neu gerendert (für überarbeitete Fassungen erst die Dateien ändern, dann antworten). Danach wieder review_wait aufrufen.',
      inputSchema: {
        id: z.string(),
        replies: z
          .array(z.object({ mark: z.number().int(), text: z.string() }))
          .describe('Pro Markierung: deine Lesart der Notiz und deine Antwort'),
        files: z.array(z.string()).optional().describe('ersetzt die Dokumentliste, falls sie sich ändern soll'),
      },
    },
    async ({ id, replies, files }) => {
      await ensureHub();
      const { review } = await call('POST', `/api/agent/respond/${id}`, { replies, files });
      return {
        content: [
          text(
            `Runde ${review.round} von "${review.title}" liegt auf dem Tablet. Rufe review_wait mit id "${id}" auf.`,
          ),
        ],
      };
    },
  );

  server.registerTool(
    'review_add_context',
    {
      title: 'Kontext nachliefern',
      description:
        'Hängt Dateien an die laufende Runde an; sie erscheinen auf dem Tablet in der Dateiliste als "nachgeliefert".',
      inputSchema: { id: z.string(), files: z.array(z.string()).describe('Pfade relativ zum Repository des Reviews') },
    },
    async ({ id, files }) => {
      await ensureHub();
      const { docs } = await call('POST', `/api/agent/context/${id}`, { files });
      return { content: [text(`Nachgeliefert. Das Review hat jetzt ${docs} Dokumente. Rufe review_wait erneut auf.`)] };
    },
  );

  server.registerTool(
    'review_close',
    {
      title: 'Review abschließen',
      description: 'Nimmt das Review aus der Eingangsliste des Tablets, wenn alles geklärt ist.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      await ensureHub();
      await call('POST', `/api/agent/close/${id}`, {});
      return { content: [text(`Review ${id} ist abgeschlossen.`)] };
    },
  );

  server.registerTool(
    'review_list',
    { title: 'Reviews auflisten', description: 'Listet alle Reviews mit Status und Runde.', inputSchema: {} },
    async () => {
      await ensureHub();
      const reviews = await call('GET', '/api/agent/list');
      const lines = reviews.map((r) => `${r.id}  ${r.status.padEnd(11)}  Runde ${r.round}  ${r.kind}  ${r.title}`);
      return { content: [text(lines.join('\n') || 'Keine Reviews.')] };
    },
  );

  await server.connect(new StdioServerTransport());
}
