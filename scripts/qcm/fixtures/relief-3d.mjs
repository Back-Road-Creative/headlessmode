// A synthetic hill-and-gorge DEM plus the trails and Forest Service road drawn across it,
// for the 3D trail-on-terrain proof (terrain-relief-browser.test.mjs).
//
// Everything is computed, not captured: `reliefElevationM(lon, lat)` is one smooth function
// of position, and `terrariumTilePng(z, x, y)` samples it into a real Terrarium tile
// (R*256 + G + B/256 - 32768 metres, the encoding the 3D view decodes), so the relief is
// the same at any zoom the camera asks for and no binary is committed.
//
// Placement uses public landmarks in the example area (app-state.js EXAMPLE_AREA, Standing
// Indian / Wayah Bald, Macon County NC): the hill is centred on Standing Indian Mountain
// (about 35.0383 N, 83.5319 W) and a gorge runs north-south 3 km east of it where Forest
// Road 67 follows the valley floor. The elevations and the trail and road GEOMETRY are
// invented for the test; only the names and the summit's position are real, and nothing
// here is near any private address.
import zlib from 'node:zlib';

export const SUMMIT = Object.freeze({ lon: -83.5319, lat: 35.0383 });
const GORGE_LON = -83.495;
const BASE_M = 1000;
const HILL = Object.freeze({ amplitudeM: 800, sigmaM: 1000 });
const GORGE = Object.freeze({ depthM: 350, sigmaM: 350 });
const M_PER_DEG = 111320;
const COS_LAT = Math.cos((SUMMIT.lat * Math.PI) / 180);

/** Ground height in whole metres: a 1,800 m hill beside a 650 m gorge floor. Whole metres
 *  keep the blue channel at zero, so the tiles compress to a few KB. */
export function reliefElevationM(lon, lat) {
  const dx = (lon - SUMMIT.lon) * M_PER_DEG * COS_LAT;
  const dy = (lat - SUMMIT.lat) * M_PER_DEG;
  const gx = (lon - GORGE_LON) * M_PER_DEG * COS_LAT;
  const hill = HILL.amplitudeM * Math.exp(-(dx * dx + dy * dy) / (2 * HILL.sigmaM ** 2));
  const gorge = GORGE.depthM * Math.exp(-(gx * gx) / (2 * GORGE.sigmaM ** 2));
  return Math.round(BASE_M + hill - gorge);
}

const tileLon = (z, x) => (x / 2 ** z) * 360 - 180;
const tileLat = (z, y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** An 8-bit RGB PNG from `rgb` (width*height*3 bytes), Sub-filtered so a smooth ramp
 *  deflates well. */
export function encodeRgbPng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const out = row * (stride + 1);
    raw[out] = 1; // filter type 1: Sub
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? rgb[row * stride + i - 3] : 0;
      raw[out + 1 + i] = (rgb[row * stride + i] - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TILE = 256;
const tileCache = new Map();
/** The Terrarium tile z/x/y of the relief above, 256 x 256. */
export function terrariumTilePng(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const rgb = Buffer.alloc(TILE * TILE * 3);
  for (let py = 0; py < TILE; py++) {
    const lat = tileLat(z, y + (py + 0.5) / TILE);
    for (let px = 0; px < TILE; px++) {
      const lon = tileLon(z, x + (px + 0.5) / TILE);
      const v = reliefElevationM(lon, lat) + 32768;
      const o = (py * TILE + px) * 3;
      rgb[o] = v >> 8; rgb[o + 1] = v & 0xff; rgb[o + 2] = 0;
    }
  }
  const png = encodeRgbPng(TILE, TILE, rgb);
  tileCache.set(key, png);
  return png;
}

/** A flat mid-grey 8x8 tile for the topo base, so the base is one known colour. */
export function greyBasePng() {
  return encodeRgbPng(8, 8, Buffer.alloc(8 * 8 * 3, 150));
}

const along = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// The Appalachian Trail over the summit and down into the gorge; a second foot trail down
// the gorge's west wall. Both are National Map layer 37 rows (source-trails.js FIELDS).
export const TRAILS = Object.freeze([
  {
    id: 'fx-at-standing-indian', name: 'Appalachian Trail', number: '1', designation: 'NST - Appalachian',
    paths: [along(30, (t) => [r6(-83.548 + 0.055 * t), r6(SUMMIT.lat + 0.003 * Math.sin(2 * Math.PI * t))])],
  },
  {
    id: 'fx-lower-ridge', name: 'Lower Ridge Trail', number: '4', designation: null,
    paths: [along(20, (t) => [r6(-83.5035 + 0.0012 * Math.sin(4 * Math.PI * t)), r6(35.012 + 0.058 * t)])],
  },
]);

export const MVUM_ROAD = Object.freeze({
  id: 'fx-fr-67', name: 'Forest Road 67',
  paths: [along(20, (t) => [r6(GORGE_LON + 0.0007 * Math.sin(3 * Math.PI * t)), r6(35.01 + 0.08 * t)])],
});

/** The National Map layer 37 answer for the fixture trails (esri JSON, outSR 4326). */
export function trailsQueryResponse() {
  return {
    features: TRAILS.map((t) => ({
      attributes: {
        permanentidentifier: t.id, name: t.name, trailnumber: t.number, trailtype: 'Terra Trail',
        nationaltraildesignation: t.designation, lengthmiles: 4.2,
        hikerpedestrian: 'Y', bicycle: null, packsaddle: null, motorcycle: null,
      },
      geometry: { paths: t.paths },
    })),
  };
}

/** The MVUM service answer: layer 1 (roads) holds Forest Road 67, layer 2 (trails) is empty.
 *  `url` is the request URL, which says the layer and whether only the count is wanted. */
export function mvumQueryResponse(url) {
  const layer = /MapServer\/(\d+)\/query/.exec(url)?.[1];
  const roads = layer === '1' ? [MVUM_ROAD] : [];
  if (/returnCountOnly=true/.test(url)) return { count: roads.length };
  return {
    features: roads.map((r) => ({
      attributes: {
        objectid: 1, id: r.id, name: r.name, symbol: '1', mvum_symbol_name: 'Open to all vehicles',
        seasonal: 'yearlong', passengervehicle: 'open', passengervehicle_datesopen: '01/01-12/31',
        highclearancevehicle: 'open', highclearancevehicle_datesopen: '01/01-12/31',
        forestname: 'Nantahala National Forest', districtname: 'Nantahala Ranger District',
        routestatus: 'Existing', jurisdiction: 'FS - FOREST SERVICE', surfacetype: 'AGG - CRUSHED AGGREGATE OR GRAVEL',
      },
      geometry: { paths: r.paths },
    })),
  };
}
