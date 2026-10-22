// PNG encode and decode with Node built-ins only (zlib), for the atlas: a CDP screenshot
// arrives as a PNG, and the browser test serves synthetic PNG tiles. An image here is
// { width, height, data } with data an RGBA Uint8Array, 8 bits a channel.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type, data) => {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};

/** An RGBA image as a PNG (colour type 6, no filtering, no interlace). */
export function encodePng({ width, height, data }) {
  const stride = width * 4, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };   // grey, RGB, grey+alpha, RGBA

/** A PNG as RGBA. Reads 8-bit, non-interlaced grey, RGB, grey+alpha and RGBA files (what
 *  Chromium's screenshots and this repo's synthetic tiles are); anything else throws. */
export function decodePng(buf) {
  buf = Buffer.from(buf);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at), name = buf.toString('ascii', at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  const n = CHANNELS[type];
  if (!n || depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (colour type ${type}, ${depth} bit, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * n, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= n ? out[dst + i - n] : 0, b = y ? out[dst - stride + i] : 0, c = i >= n && y ? out[dst - stride + i - n] : 0;
      let add = 0;
      if (filter === 1) add = a; else if (filter === 2) add = b; else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      out[dst + i] = (raw[src + i] + add) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * n, d = p * 4;
    if (n === 1 || n === 2) { data[d] = data[d + 1] = data[d + 2] = out[s]; data[d + 3] = n === 2 ? out[s + 1] : 255; }
    else { data[d] = out[s]; data[d + 1] = out[s + 1]; data[d + 2] = out[s + 2]; data[d + 3] = n === 4 ? out[s + 3] : 255; }
  }
  return { width, height, data };
}
