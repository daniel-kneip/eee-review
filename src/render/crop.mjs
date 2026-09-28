import fs from 'node:fs';
import path from 'node:path';
import { drawStrokes } from './ink.mjs';
import { decodePngToGray, encodeGrayPng } from './png.mjs';

const MARGIN = 60;
const MAX_HEIGHT = 900;

// The stretch of a rendered page a mark's ink covers, the full width and some lines around
// it, with the ink drawn over a lightened page: the agent sees what was circled, down to a
// word in a table, where rows alone are too coarse. Null when the page was never rendered.
export function markCrop(pagesDir, ink) {
  const indexFile = path.join(pagesDir, 'index.json');
  ink = (ink ?? []).filter((stroke) => Array.isArray(stroke) && stroke.every(Array.isArray));
  if (!ink.length || !fs.existsSync(indexFile)) return null;
  const { width, height, strip } = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
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
