import fs from 'node:fs';
import path from 'node:path';
import { drawStrokes } from './ink.mjs';
import { decodePngToGray, encodeGrayPng } from './png.mjs';

const MARGIN = 60;
const MAX_HEIGHT = 900;

// The stretch of a rendered page a mark's ink covers, the full width and some lines around
// it, with the ink drawn over a lightened page: the agent sees what was circled, down to a
// word in a table, where rows alone are too coarse. Null when the page was never rendered.
export function markCrop(pagesDir, ink, figuresDir = null) {
  const indexFile = path.join(pagesDir, 'index.json');
  ink = (ink ?? []).filter((stroke) => Array.isArray(stroke) && stroke.every(Array.isArray));
  if (!ink.length || !fs.existsSync(indexFile)) return null;
  const { width, height, strip, figures = [] } = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const figure = figures.find(({ box: [top, bottom, left, right] }) => {
    const [x, y] = middle(ink);
    return x >= left && x <= right && y >= top && y <= bottom;
  });
  const file = figure && figuresDir && path.join(figuresDir, figure.name);
  if (file && fs.existsSync(file)) return figureCrop(file, figure.box, ink);
  const ys = ink.flat().map(([, y]) => y);
  const top = Math.max(0, Math.min(...ys) - MARGIN);
  const bottom = Math.min(height, Math.max(...ys) + MARGIN, top + MAX_HEIGHT);
  if (bottom <= top) return null;
  const pixels = new Uint8Array(width * (bottom - top)).fill(255);
  for (let n = Math.floor(top / strip); n * strip < bottom; n++) {
    const file = path.join(pagesDir, `${n}.png`);
    if (!fs.existsSync(file)) continue;
    const { gray, height: h } = decodePngToGray(fs.readFileSync(file));
    for (let y = Math.max(top, n * strip); y < Math.min(bottom, n * strip + h); y++) {
      const from = (y - n * strip) * width;
      const to = (y - top) * width;
      for (let x = 0; x < width; x++) pixels[to + x] = 150 + Math.round((gray[from + x] * 105) / 255);
    }
  }
  drawStrokes(pixels, width, bottom - top, ink, 1.8, -top);
  return encodeGrayPng(pixels, width, bottom - top, 4);
}

const middle = (ink) => {
  const points = ink.flat();
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

// A mark on a figure is cut from the figure as rendered, at twice the page's size, so the
// small print of a diagram stays readable for the agent.
function figureCrop(file, [top, bottom, left, right], ink) {
  const image = decodePngToGray(fs.readFileSync(file));
  const sx = image.width / (right - left);
  const sy = image.height / (bottom - top);
  const points = ink.flat();
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  const x0 = clamp((Math.min(...points.map(([x]) => x)) - left - MARGIN / 2) * sx, image.width);
  const x1 = clamp((Math.max(...points.map(([x]) => x)) - left + MARGIN / 2) * sx, image.width);
  const y0 = clamp((Math.min(...points.map(([, y]) => y)) - top - MARGIN / 2) * sy, image.height);
  const y1 = clamp((Math.max(...points.map(([, y]) => y)) - top + MARGIN / 2) * sy, image.height);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) pixels[y * w + x] = 150 + Math.round((image.gray[(y0 + y) * image.width + x0 + x] * 105) / 255);
  const scaled = ink.map((stroke) => stroke.map(([x, y]) => [(x - left) * sx - x0, (y - top) * sy - y0]));
  drawStrokes(pixels, w, h, scaled, 2.5);
  return encodeGrayPng(pixels, w, h, 4);
}
