import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

// pixels: one 0-255 gray value per pixel. At 4 bits the values are rounded to 16 levels,
// which is all the tablet's 64-level panel shows of anti-aliased text anyway.
export function encodeGrayPng(pixels, width, height, bits = 8) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bits;
  header[9] = 0;
  const rowBytes = Math.ceil((width * bits) / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1;
    if (bits === 8) {
      raw.set(pixels.subarray(y * width, (y + 1) * width), row);
      continue;
    }
    for (let x = 0; x < width; x++) {
      const level = Math.round(pixels[y * width + x] / 17);
      raw[row + (x >> 1)] |= x & 1 ? level : level << 4;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Reads an 8-bit RGB or RGBA PNG, as Chromium writes screenshots, or a gray one of 4 or 8
// bits, as encodeGrayPng writes strips, into gray values.
export function decodePngToGray(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let bits = 8;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bits = data[8];
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (data[12] !== 0 || !(bits === 8 || (bits === 4 && channels === 1))) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * channels * bits) / 8);
  const step = Math.max(1, (channels * bits) / 8);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let i = 0; i < stride; i++) {
      const x = raw[start + 1 + i];
      const a = i >= step ? line[i - step] : 0;
      const b = prev[i];
      const c = i >= step ? prev[i - step] : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const p = x * channels;
      gray[y * width + x] =
        bits === 4
          ? ((x & 1 ? line[x >> 1] : line[x >> 1] >> 4) & 15) * 17
          : channels < 3
            ? line[p]
            : Math.round(0.299 * line[p] + 0.587 * line[p + 1] + 0.114 * line[p + 2]);
    }
    prev.set(line);
  }
  return { width, height, gray };
}
