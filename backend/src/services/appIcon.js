'use strict';
const zlib = require('node:zlib');
const { crc32 } = require('./zip');

// Icons for the exported apps: PNG for Android and the iPhone & iPad app,
// ICO (PNG entries) for Windows, ICNS (PNG entries) for the Mac. An icon set
// is anything with pixels(n) -> n*n RGBA:
//   defaultIcon()   -- a rounded square in the brand's accent gradient with a
//                      white "play" triangle, drawn in code (the fallback)
//   fromPng(buffer) -- a game's own designed icon (see iconDesigner.js),
//                      rendered once as a large square PNG and scaled down
// No image files or image library needed either way.

const TOP = [0x6d, 0x7b, 0xff];
const BOTTOM = [0x5a, 0x52, 0xc8];
const SAMPLES = 4; // 4x4 supersampling for smooth edges

function insideRoundedSquare(x, y, n) {
  const r = n * 0.22;
  const cx = Math.min(Math.max(x, r), n - r);
  const cy = Math.min(Math.max(y, r), n - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideTriangle(x, y, n) {
  const [ax, ay, bx, by, cx, cy] = [0.4 * n, 0.29 * n, 0.4 * n, 0.71 * n, 0.74 * n, 0.5 * n];
  const side = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = side(ax, ay, bx, by);
  const d2 = side(bx, by, cx, cy);
  const d3 = side(cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// RGBA pixels, row by row.
function drawDefault(n) {
  const px = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    const t = y / (n - 1);
    const bg = TOP.map((c, i) => Math.round(c + (BOTTOM[i] - c) * t));
    for (let x = 0; x < n; x += 1) {
      let shape = 0;
      let play = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const fx = x + (sx + 0.5) / SAMPLES;
          const fy = y + (sy + 0.5) / SAMPLES;
          if (insideRoundedSquare(fx, fy, n)) {
            shape += 1;
            if (insideTriangle(fx, fy, n)) play += 1;
          }
        }
      }
      const o = (y * n + x) * 4;
      const w = shape ? play / shape : 0;
      for (let i = 0; i < 3; i += 1) px[o + i] = Math.round(bg[i] + (255 - bg[i]) * w);
      px[o + 3] = Math.round((shape / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return px;
}

function defaultIcon() {
  return { pixels: drawDefault };
}

// ------------------------------------------------------------------- PNG
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, n) {
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y += 1) px.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4); // filter byte 0 per row
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Reads an 8-bit RGB or RGBA, non-interlaced PNG (what a browser screenshot
// is) into square RGBA pixels. Returns { size, px }.
function decodePng(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2) || data[12] !== 0) throw new Error('Unsupported PNG format');
      type = data[9];
    } else if (name === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (!w || w !== h) throw new Error('Icon PNG must be square');
  const bpp = type === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  if (bpp === 4) return { size: w, px: out };
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out.copy(px, i * 4, i * 3, i * 3 + 3);
    px[i * 4 + 3] = 255;
  }
  return { size: w, px };
}

// Area-average downscale (with premultiplied alpha, so transparent edges
// don't darken), from size s to n.
function downscale(src, s, n) {
  if (n === s) return src;
  const out = Buffer.alloc(n * n * 4);
  const k = s / n;
  for (let y = 0; y < n; y += 1) {
    const y0 = y * k;
    const y1 = y0 + k;
    for (let x = 0; x < n; x += 1) {
      const x0 = x * k;
      const x1 = x0 + k;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wgt = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const o = (sy * s + sx) * 4;
          const al = src[o + 3] / 255;
          r += src[o] * al * wgt;
          g += src[o + 1] * al * wgt;
          b += src[o + 2] * al * wgt;
          a += al * wgt;
          area += wgt;
        }
      }
      const o = (y * n + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return out;
}

function fromPng(buf) {
  const { size, px } = decodePng(buf);
  const cache = new Map();
  return {
    pixels: (n) => {
      if (!cache.has(n)) cache.set(n, downscale(px, size, n));
      return cache.get(n);
    },
  };
}

// iOS shows a home screen icon's transparent pixels as black and rounds the
// corners itself, so its icon is the same picture on a solid background: the
// icon's own average colour, so whatever shows past iOS's mask blends in.
function opaque(icon = defaultIcon()) {
  return {
    pixels: (n) => {
      const px = Buffer.from(icon.pixels(n));
      const sum = [0, 0, 0];
      let weight = 0;
      for (let o = 0; o < px.length; o += 4) {
        const a = px[o + 3] / 255;
        for (let i = 0; i < 3; i += 1) sum[i] += px[o + i] * a;
        weight += a;
      }
      const bg = sum.map((c) => (weight ? c / weight : 0));
      for (let o = 0; o < px.length; o += 4) {
        const a = px[o + 3] / 255;
        for (let i = 0; i < 3; i += 1) px[o + i] = Math.round(px[o + i] * a + bg[i] * (1 - a));
        px[o + 3] = 255;
      }
      return px;
    },
  };
}

// Mac app icons leave a margin around the artwork (Apple's grid draws it at
// about 80% of the canvas), so the same picture, smaller and centred.
function padded(icon = defaultIcon(), scale = 0.8) {
  return {
    pixels: (n) => {
      const m = Math.round(n * scale);
      const inner = icon.pixels(m);
      const off = Math.floor((n - m) / 2);
      const px = Buffer.alloc(n * n * 4);
      for (let y = 0; y < m; y += 1) inner.copy(px, ((y + off) * n + off) * 4, y * m * 4, (y + 1) * m * 4);
      return px;
    },
  };
}

// ------------------------------------------------------------------- Output
function png(n, icon = defaultIcon()) {
  return encodePng(icon.pixels(n), n);
}

function ico(icon = defaultIcon(), sizes = [256, 48, 32, 16]) {
  const images = sizes.map((n) => ({ n, data: png(n, icon) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ n, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = n >= 256 ? 0 : n;
    header[e + 1] = n >= 256 ? 0 : n;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((img) => img.data)]);
}

// A Mac .icns: PNG entries by their type codes (16, 32, 128, 256, 512 px).
function icns(icon = defaultIcon()) {
  const entries = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512]].map(([type, n]) => {
    const data = png(n, icon);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + entries.reduce((sum, e) => sum + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

module.exports = { defaultIcon, fromPng, opaque, padded, png, ico, icns };
