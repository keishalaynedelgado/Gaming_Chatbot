'use strict';

// Minimal, dependency-free ZIP writer (STORED entries only, so no compression
// codec is needed) -- just enough to package a small generated project for
// download without pulling in an npm dependency.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS date/time fields, as the ZIP format requires.
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

// files: [{ path, content: string|Buffer, mode? }]. Returns a Buffer
// containing a valid, uncompressed (STORED) .zip archive. `mode` (Unix
// permissions, e.g. 0o100755) is recorded so macOS's Archive Utility keeps a
// file executable -- the Mac app's launcher needs it (see exporter.js).
function buildZip(files) {
  const { time, day } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { path: name, content, mode } of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const flags = /[^\x00-\x7f]/.test(name) ? 0x0800 : 0; // UTF-8 file name

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(0, 8); // method: stored
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(day, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    localParts.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(mode ? 0x0314 : 20, 4); // version made by (0x03xx: Unix, so the mode below counts)
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(0, 10); // method
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(day, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(mode ? (mode << 16) >>> 0 : 0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // offset of local header
    centralParts.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, central, eocd]);
}

module.exports = { buildZip, crc32 };
