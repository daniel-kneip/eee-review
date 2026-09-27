import zlib from 'node:zlib';

// Stroke width in screen pixels for a raw pen pressure (0-255). Steep at both ends and flat
// through the middle: in handwriting on the EA800 half of all pressures fall between 176 and
// 213, so a linear map leaves ordinary writing looking uniform and makes neither a light
// touch nor bearing down visible. web/review.js and native/common/pen.h carry the same knots.
export const PRESSURE_KNOTS = [
  [0, 0.3],
  [100, 1.1],
  [200, 1.7],
  [235, 4.5],
];

export function inkWidth(pressure) {
  if (pressure === undefined || pressure === null || Number.isNaN(pressure)) return 2;
  const k = PRESSURE_KNOTS;
  if (pressure <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (pressure <= k[i][0]) {
      const t = (pressure - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      return k[i - 1][1] + t * (k[i][1] - k[i - 1][1]);
    }
  }
  return k.at(-1)[1];
}

// Rasterises strokes ([[x, y, pressure?], ...]) to a grayscale PNG, each segment a capsule of
// its width with a one-pixel soft edge, so handwriting reaches an agent as an image it can read.
export function strokesToPng(strokes, width, height) {
  const pixels = new Uint8Array(width * height).fill(255);
  const plot = (px, py, coverage) => {
    if (px < 0 || py < 0 || px >= width || py >= height || coverage <= 0) return;
    const value = Math.round(255 * (1 - Math.min(1, coverage)));
    const i = py * width + px;
    if (value < pixels[i]) pixels[i] = value;
  };
  for (const stroke of strokes) {
    const points = stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
    for (let s = 1; s < points.length; s++) {
      const [x0, y0] = points[s - 1];
      const [x1, y1, p] = points[s];
      const r = Math.max(0.6, inkWidth(p) / 2);
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
  return encodeGrayPng(pixels, width, height);
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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodeGrayPng(pixels, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
