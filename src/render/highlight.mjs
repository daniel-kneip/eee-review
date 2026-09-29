import hljs from 'highlight.js';

const LANGUAGES = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  md: 'markdown',
  pro: 'makefile',
};

export function languageOf(path) {
  const ext = path.split('.').pop().toLowerCase();
  return LANGUAGES[ext] ?? null;
}

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Highlights line by line so every line stays its own element and can be marked on its own.
// A construct spanning lines (a block comment, a template string) loses its colour after the
// first line; for grayscale review that is an acceptable price.
export function highlightLines(lines, language) {
  if (!language || !hljs.getLanguage(language)) return lines.map(escapeHtml);
  const html = lines.map((line) => hljs.highlight(line, { language, ignoreIllegals: true }).value);
  return language === 'markdown' ? html.map(markdownMarkers) : html;
}

// Markdown in a diff or a whole file reads as what it means: emphasis in italics, strong in
// bold, code on gray. Its markers stay, since they are part of the change, but fade.
const MARKERS = { 'hljs-emphasis': /^([*_])(.*)\1$/, 'hljs-strong': /^(\*\*|__)(.*)\1$/, 'hljs-code': /^(`+)(.*)\1$/ };
function markdownMarkers(html) {
  return html
    .replace(/<span class="(hljs-emphasis|hljs-strong|hljs-code)">([^<]*)<\/span>/g, (all, cls, inner) => {
      const m = inner.match(MARKERS[cls]);
      if (!m) return all;
      const marker = `<span class="md-marker">${m[1]}</span>`;
      return `<span class="${cls}">${marker}${m[2]}${marker}</span>`;
    })
    .replace(/<span class="hljs-section">(#+ )/, '<span class="hljs-section"><span class="md-marker">$1</span>');
}
