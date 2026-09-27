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
  return lines.map((line) => hljs.highlight(line, { language, ignoreIllegals: true }).value);
}
