import { encodeGrayPng } from './png.mjs';

const INK_RADIUS = 1.2;

// Rasterises strokes ([[x, y], ...]) to a grayscale PNG, each segment a capsule with a
// one-pixel soft edge, so handwriting reaches an agent as an image it can read.
export function strokesToPng(strokes, width, height, radius = INK_RADIUS) {
  const pixels = new Uint8Array(width * height).fill(255);
  drawStrokes(pixels, width, height, strokes, radius);
  return encodeGrayPng(pixels, width, height);
}

// Draws strokes into gray pixels, shifted down by shiftY.
export function drawStrokes(pixels, width, height, strokes, radius = INK_RADIUS, shiftY = 0) {
  const plot = (px, py, coverage) => {
    if (px < 0 || py < 0 || px >= width || py >= height || coverage <= 0) return;
    const value = Math.round(255 * (1 - Math.min(1, coverage)));
    const i = py * width + px;
    if (value < pixels[i]) pixels[i] = value;
  };
  for (const stroke of strokes) {
    const points = stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
    for (let s = 1; s < points.length; s++) {
      const [x0, y0] = [points[s - 1][0], points[s - 1][1] + shiftY];
      const [x1, y1] = [points[s][0], points[s][1] + shiftY];
      const r = radius;
      const minX = Math.floor(Math.min(x0, x1) - r - 1);
      const maxX = Math.ceil(Math.max(x0, x1) + r + 1);
      const minY = Math.floor(Math.min(y0, y1) - r - 1);
      const maxY = Math.ceil(Math.max(y0, y1) + r + 1);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = dx * dx + dy * dy;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const t = len ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len)) : 0;
          const d = Math.hypot(x0 + t * dx - px, y0 + t * dy - py);
          plot(px, py, r + 0.5 - d);
        }
      }
    }
  }
}

export function strokesBounds(strokes) {
  let maxX = 0;
  let maxY = 0;
  for (const s of strokes)
    for (const [x, y] of s) {
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  return { maxX, maxY };
}
