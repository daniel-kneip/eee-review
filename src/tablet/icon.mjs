import { strokesToPng } from '../render/ink.mjs';

// The launcher's icons for eeereview: a page with lines of text and a check mark drawn over
// it, at the sizes the stock icons have (259x261 for the app list, 97x97 for the dock).
const PAGE = [
  [
    [0.2, 0.1],
    [0.62, 0.1],
    [0.8, 0.28],
    [0.8, 0.9],
    [0.2, 0.9],
    [0.2, 0.1],
  ],
  [
    [0.62, 0.1],
    [0.62, 0.28],
    [0.8, 0.28],
  ],
  [
    [0.3, 0.4],
    [0.7, 0.4],
  ],
  [
    [0.3, 0.52],
    [0.7, 0.52],
  ],
  [
    [0.3, 0.64],
    [0.55, 0.64],
  ],
  [
    [0.45, 0.76],
    [0.55, 0.86],
    [0.92, 0.5],
  ],
];

export function iconPng(width, height, radius) {
  const strokes = PAGE.map((s) => s.map(([x, y]) => [x * width, y * height]));
  return strokesToPng(strokes, width, height, radius);
}
