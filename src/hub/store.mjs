import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, fileAt, renderDiff, renderFile } from '../render/diff.mjs';
import { renderFigures } from '../render/figures.mjs';
import { strokesBounds, strokesToPng } from '../render/ink.mjs';
import { renderMarkdown } from '../render/markdown.mjs';
import { escapeHtml } from '../render/highlight.mjs';

export const defaultHome = () => process.env.EEE_REVIEW_HOME ?? path.join(os.homedir(), '.eee-review');

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
};
const newId = () => crypto.randomBytes(4).toString('hex');

// A review is a folder: review.json, and per round the rendered documents, the tablet's
// draft, what was submitted and any context requests. Each round's documents are rendered
// once, when the round starts, so the tablet only ever fetches finished HTML.
export class Store extends EventEmitter {
  constructor(home = defaultHome()) {
    super();
    this.home = home;
    fs.mkdirSync(path.join(home, 'reviews'), { recursive: true });
  }

  dir(id, ...parts) {
    if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`no such review: ${id}`);
    return path.join(this.home, 'reviews', id, ...parts);
  }
  roundDir(id, round, ...parts) {
    return this.dir(id, 'rounds', String(round), ...parts);
  }

  get(id) {
    const review = readJson(this.dir(id, 'review.json'), null);
    if (!review) throw new Error(`no such review: ${id}`);
    return review;
  }
  save(review) {
    review.updatedAt = new Date().toISOString();
    writeJson(this.dir(review.id, 'review.json'), review);
    this.emit('changed', review.id);
  }
  list() {
    return fs
      .readdirSync(path.join(this.home, 'reviews'))
      .filter((id) => fs.existsSync(this.dir(id, 'review.json')))
      .map((id) => this.get(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  docs(id, round) {
    return readJson(this.roundDir(id, round, 'docs.json'), []);
  }
  draft(id, round) {
    return readJson(this.roundDir(id, round, 'draft.json'), { marks: [] });
  }
  feedback(id, round) {
    return readJson(this.roundDir(id, round, 'feedback.json'), null);
  }
  requests(id, round) {
    return readJson(this.roundDir(id, round, 'requests.json'), []);
  }

  // kind 'spec': files are documents (markdown rendered, anything else shown whole).
  // kind 'code': the change between base and head (or the working tree) in repo, a diff and
  // a whole-file view per touched file, plus any extra files as context.
  async create({ title, kind = 'spec', repo, files = [], base = 'HEAD', head = null }) {
    const review = {
      id: newId(),
      title,
      kind,
      repo,
      base,
      head,
      files,
      round: 1,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.dir(review.id), { recursive: true });
    await this.startRound(review, 1, await this.buildDocs(review));
    return this.get(review.id);
  }

  async buildDocs(review) {
    const docs = [];
    if (review.kind === 'code') {
      for (const file of changedFiles(review.repo, review.base, review.head)) {
        const changed = new Set(file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.new)));
        const lines = file.hunks.flatMap((h) => h.lines);
        docs.push({
          kind: 'diff',
          path: file.path,
          title: path.basename(file.path),
          status: file.untracked ? 'A' : file.status,
          plus: lines.filter((l) => l.kind === 'add').length,
          minus: lines.filter((l) => l.kind === 'del').length,
          ...renderDiff(file),
        });
        if (file.content !== null) {
          docs.push({
            kind: 'file',
            path: file.path,
            title: path.basename(file.path),
            ...renderFile(file.path, file.content, changed),
          });
        }
      }
    }
    for (const file of review.files) docs.push(this.renderSource(review, file));
    return docs;
  }

  renderSource(review, file) {
    const content = fileAt(review.repo, file, review.kind === 'code' ? review.head : null);
    const rendered = /\.(md|markdown)$/i.test(file) ? renderMarkdown(content) : renderFile(file, content);
    return {
      kind: /\.(md|markdown)$/i.test(file) ? 'spec' : 'file',
      path: file,
      title: path.basename(file),
      ...rendered,
    };
  }

  async startRound(review, round, docs) {
    const withIds = [];
    for (const doc of docs) {
      withIds.push({
        ...doc,
        id: doc.id ?? newId(),
        html: await renderFigures(doc.html, this.dir(review.id, 'figures'), `/r/${review.id}/fig`),
      });
    }
    writeJson(this.roundDir(review.id, round, 'docs.json'), withIds);
    review.round = round;
    review.status = 'open';
    this.save(review);
  }

  saveDraft(id, marks) {
    const review = this.get(id);
    writeJson(this.roundDir(id, review.round, 'draft.json'), { savedAt: new Date().toISOString(), marks });
    if (review.status === 'open') {
      review.status = 'in-progress';
      this.save(review);
    }
  }

  submit(id, marks) {
    const review = this.get(id);
    const round = review.round;
    writeJson(this.roundDir(id, round, 'draft.json'), { savedAt: new Date().toISOString(), marks });
    writeJson(this.roundDir(id, round, 'feedback.json'), {
      submittedAt: new Date().toISOString(),
      marks,
      delivered: false,
    });
    this.renderNotes(id, round, marks);
    review.status = 'submitted';
    this.save(review);
    this.emit('feedback', id);
  }

  request(id, mark) {
    const review = this.get(id);
    const requests = this.requests(id, review.round);
    requests.push({ id: newId(), at: new Date().toISOString(), mark, delivered: false });
    writeJson(this.roundDir(id, review.round, 'requests.json'), requests);
    this.renderNotes(id, review.round, [mark]);
    this.emit('feedback', id);
  }

  renderNotes(id, round, marks) {
    for (const mark of marks) {
      if (!mark.note?.length) continue;
      const { maxX, maxY } = strokesBounds(mark.note);
      const png = strokesToPng(mark.note, Math.ceil(maxX) + 20, Math.ceil(maxY) + 20);
      fs.mkdirSync(this.roundDir(id, round, 'notes'), { recursive: true });
      fs.writeFileSync(this.roundDir(id, round, 'notes', `${mark.id}.png`), png);
    }
  }

  notePng(id, round, markId) {
    const file = this.roundDir(id, round, 'notes', `${markId}.png`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  // What the agent has not seen yet: a submitted round, and context requests made while the
  // round is still being reviewed. Taking it marks it delivered.
  takePending(id) {
    const review = this.get(id);
    const round = review.round;
    const requests = this.requests(id, round).filter((r) => !r.delivered);
    const feedback = this.feedback(id, round);
    const pending = { review, round, requests, feedback: feedback && !feedback.delivered ? feedback : null };
    if (requests.length) {
      writeJson(
        this.roundDir(id, round, 'requests.json'),
        this.requests(id, round).map((r) => ({ ...r, delivered: true })),
      );
    }
    if (pending.feedback) writeJson(this.roundDir(id, round, 'feedback.json'), { ...feedback, delivered: true });
    return requests.length || pending.feedback ? pending : null;
  }

  describe(id, round, mark) {
    const doc = this.docs(id, round).find((d) => d.id === mark.doc);
    if (!doc) return { where: '(unbekanntes Dokument)', text: '' };
    const rows = (mark.rows ?? []).map((i) => doc.rows[i]).filter(Boolean);
    const lines = rows.flatMap((r) => (r.lines ? [r.lines[0], r.lines[1]] : [r.new ?? r.old].filter(Boolean)));
    const [from, to] = [Math.min(...lines), Math.max(...lines)];
    const range = !lines.length ? '' : from === to ? `, Zeile ${from}` : `, Zeilen ${from}–${to}`;
    const label = { spec: 'Dokument', diff: 'Diff', file: 'Datei', replies: 'Antworten' }[doc.kind] ?? doc.kind;
    const sign = { add: '+', del: '-', ctx: ' ' };
    const text = rows.map((r) => (r.kind in sign ? sign[r.kind] + r.text : r.text)).join('\n');
    return { where: `${doc.path ?? doc.title} (${label}${range})`, text, doc };
  }

  // The agent's answers start the next round: its replies become a document of their own at
  // the top, next to your notes, and the sources are rendered again to show what changed.
  async respond(id, { replies = [], files = null, rerender = true }) {
    const review = this.get(id);
    const round = review.round;
    const marks = this.feedback(id, round)?.marks ?? this.draft(id, round).marks;
    if (files) review.files = files;
    const docs = rerender ? await this.buildDocs(review) : this.docs(id, round).filter((d) => d.kind !== 'replies');
    const repliesDoc = this.renderReplies(review, round, marks, replies);
    writeJson(this.roundDir(id, round, 'replies.json'), replies);
    await this.startRound(review, round + 1, [repliesDoc, ...docs]);
    return this.get(id);
  }

  renderReplies(review, round, marks, replies) {
    const rows = [];
    const byMark = new Map(replies.map((r) => [String(r.mark), r.text]));
    const items = marks
      .map((mark, i) => {
        const { where, text } = this.describe(review.id, round, mark);
        const reply = byMark.get(String(i + 1)) ?? byMark.get(mark.id) ?? '';
        const index = rows.push({ kind: 'text', text: reply, mark: mark.id }) - 1;
        const note = mark.note?.length
          ? `<img class="note" src="/r/${review.id}/note/${round}/${mark.id}" alt="">`
          : '';
        return `<div class="reply" data-row="${index}"><h2>${i + 1}. ${escapeHtml(where)}</h2>${
          text ? `<pre class="code">${escapeHtml(text)}</pre>` : ''
        }${note}<p class="answer">${escapeHtml(reply) || '<i>keine Antwort</i>'}</p></div>`;
      })
      .join('');
    return {
      kind: 'replies',
      title: `Antworten Runde ${round}`,
      path: null,
      html: `<div class="doc spec replies"><h1>Antworten auf Runde ${round}</h1>${items || '<p>Keine Markierungen.</p>'}</div>`,
      rows,
    };
  }

  async addContext(id, files) {
    const review = this.get(id);
    const docs = this.docs(id, review.round);
    for (const file of files) {
      if (docs.some((d) => d.path === file && d.kind !== 'diff')) continue;
      const doc = this.renderSource(review, file);
      doc.html = await renderFigures(doc.html, this.dir(id, 'figures'), `/r/${id}/fig`);
      docs.push({ ...doc, id: newId(), added: true });
    }
    writeJson(this.roundDir(id, review.round, 'docs.json'), docs);
    this.save(review);
    return docs;
  }

  close(id) {
    const review = this.get(id);
    review.status = 'closed';
    this.save(review);
  }
}
