import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as agent from '../agent/client.mjs';

// The MCP tools' names, for what the hub's answers tell the agent to do next.
const to = {
  fetch: (id) => `review_fetch (id "${id}")`,
  respond: () => 'review_respond',
  context: () => 'review_add_context',
  close: () => 'review_close',
};

const content = (parts) => ({
  content: parts.map((p) => (p.type === 'image' ? { type: 'image', data: p.data, mimeType: 'image/png' } : p)),
});

const comment = z.object({
  file: z.string().optional().describe('Pfad relativ zum Repository; ohne: allgemeiner Kommentar auf der Übersicht'),
  line: z.number().int().optional().describe('Zeile in der Datei; ohne: Kommentar zur ganzen Datei'),
  side: z.enum(['new', 'old']).optional().describe('"old" für eine entfernte Zeile im Diff'),
  author: z.string(),
  text: z.string(),
  at: z.string().optional().describe('Datum zum Anzeigen'),
  ref: z.string().optional().describe('Deine Kennung, etwa die Kommentar-ID der Plattform; kommt mit Markierungen zurück'),
  replies: z
    .array(z.object({ author: z.string(), text: z.string(), at: z.string().optional() }))
    .optional()
    .describe('Der Thread darunter'),
});
const comments = z
  .array(comment)
  .optional()
  .describe('Kommentare in den Dokumenten, etwa von Kollegen aus einem Pull Request oder deine eigenen Hinweise');
const overview = z
  .string()
  .optional()
  .describe('Markdown, das als eigenes Dokument vor den Dateien erscheint, etwa die Details eines Pull Requests');

export async function startMcp() {
  const server = new McpServer({ name: 'eee-review', version: '0.1.0' });

  server.registerTool(
    'review_create',
    {
      title: 'Review auf dem Tablet starten',
      description:
        'Schickt Dokumente oder eine Code-Änderung zum Review auf das Eee-Note-Tablet des Nutzers. kind "spec": files sind die zu lesenden Dateien (Markdown wird gerendert, Mermaid als Bild). kind "code": die Änderung zwischen base und head (ohne head: Arbeitsverzeichnis gegen base, auch neue Dateien) als Diff und ganze Datei je Datei; files grenzt die Änderung auf diese Pfade ein (Ordner schließen alles darunter ein), eine aufgeführte Datei ohne Änderung erscheint ganz. Mit base und head zeigt es, was head seit der Abzweigung von base geändert hat, wie ein Pull Request. overview und comments bringen PR-Details und Kommentare mit (siehe Skill eee-review, Abschnitt Pull requests). Danach dem Nutzer Bescheid geben und auf seine Nachricht warten, dann review_fetch.',
      inputSchema: {
        title: z.string().describe('Kurzer Titel, erscheint in der Eingangsliste'),
        kind: z.enum(['spec', 'code']).default('spec'),
        files: z.array(z.string()).default([]).describe('Pfade relativ zum Repository'),
        base: z.string().default('HEAD').describe('nur code: Vergleichsbasis'),
        head: z.string().optional().describe('nur code: Ziel-Commit; weglassen für das Arbeitsverzeichnis'),
        overview,
        comments,
        repo: z
          .string()
          .optional()
          .describe(
            'Absoluter Pfad des Projekts; ohne Angabe das Git-Repository des Arbeitsverzeichnisses, falls es eines ist',
          ),
      },
    },
    async (args) => content(await agent.create(to, args)),
  );

  server.registerTool(
    'review_fetch',
    {
      title: 'Runde vom Tablet abholen',
      description:
        'Holt ab, was der Nutzer auf dem Tablet abgeschickt hat: Markierungen mit markiertem Inhalt, Seitenausschnitt und handschriftlicher Notiz als Bilder, oder seine Fragen während des Lesens. Wartet nicht; aufrufen, wenn der Nutzer sagt, dass es einen neuen Stand gibt.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => content(await agent.fetchRound(to, id)),
  );

  server.registerTool(
    'review_wait',
    {
      title: 'Auf das Tablet warten',
      description:
        'Wie review_fetch, wartet aber bis zu timeout_seconds auf die Runde. Nur nutzen, wenn der Nutzer ausdrücklich möchte, dass du wartest.',
      inputSchema: {
        id: z.string(),
        timeout_seconds: z.number().int().min(10).max(1800).default(240),
      },
    },
    async ({ id, timeout_seconds }) => content(await agent.fetchRound(to, id, timeout_seconds)),
  );

  server.registerTool(
    'review_respond',
    {
      title: 'Nächste Runde starten',
      description:
        'Beantwortet die Markierungen der abgeschickten Runde und startet die nächste: Die Antworten erscheinen auf dem Tablet als eigenes Dokument neben den Notizen des Nutzers, die Dateien werden neu gerendert (für überarbeitete Fassungen erst die Dateien ändern, dann antworten). Danach dem Nutzer Bescheid geben und auf seine Nachricht warten, dann review_fetch.',
      inputSchema: {
        id: z.string(),
        replies: z
          .array(z.object({ mark: z.number().int(), text: z.string() }))
          .describe('Pro Markierung: deine Lesart der Notiz und deine Antwort'),
        files: z.array(z.string()).optional().describe('ersetzt die Dokumentliste, falls sie sich ändern soll'),
        overview,
        comments: comments.describe('ersetzt die Kommentare, falls angegeben; sonst bleiben sie'),
        drafts: z
          .array(
            z.object({
              text: z.string(),
              ref: z.string().optional().describe('Antwort auf diesen Kommentar (dessen ref)'),
              file: z.string().optional(),
              line: z.number().int().optional(),
            }),
          )
          .optional()
          .describe('PR-Kommentare zur Freigabe: erscheinen als eigenes Dokument, der Nutzer stempelt jeden mit OK oder Nein'),
      },
    },
    async ({ id, ...body }) => content(await agent.respond(to, id, body)),
  );

  server.registerTool(
    'review_add_context',
    {
      title: 'Kontext nachliefern',
      description:
        'Hängt Dateien an die laufende Runde an; sie erscheinen auf dem Tablet in der Dateiliste als "nachgeliefert".',
      inputSchema: { id: z.string(), files: z.array(z.string()).describe('Pfade relativ zum Repository des Reviews') },
    },
    async ({ id, files }) => content(await agent.addContext(to, id, files)),
  );

  server.registerTool(
    'review_close',
    {
      title: 'Review abschließen',
      description: 'Nimmt das Review aus der Eingangsliste des Tablets, wenn alles geklärt ist.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => content(await agent.close(id)),
  );

  server.registerTool(
    'review_list',
    { title: 'Reviews auflisten', description: 'Listet alle Reviews mit Status und Runde.', inputSchema: {} },
    async () => content(await agent.list()),
  );

  await server.connect(new StdioServerTransport());
}
