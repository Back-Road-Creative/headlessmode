// A tiny stand-in for the build-time camera snapshot directory, for the browser tests that need a
// fixed set of Caltrans cameras. The page reads `index.json` and one file per (provider, region)
// from /data/quiet-corners-maps/cameras/; these tests answer the index and the District 5 file in
// the page and let every other path through to the real site server. The stub index is the
// committed index with every Caltrans district but D05 removed, so a view anywhere else in
// California requests nothing, and the D05 file holds exactly the cameras the test passes in.
import { readFileSync } from 'node:fs';
import { compactSnapshot } from '../../../themes/headlessmode/static/js/quiet-corners-maps/camera-snapshot.js';
import { normalizeCaltransDistrict } from '../../../themes/headlessmode/static/js/quiet-corners-maps/source-camera.js';

export const CAMERA_DIR = '/data/quiet-corners-maps/cameras';
export const INDEX_PATH = `${CAMERA_DIR}/index.json`;
export const D05_PATH = `${CAMERA_DIR}/caltrans-cwwp2/ca-d05.json`;

const seedDir = new URL('../../../static/data/quiet-corners-maps/cameras/', import.meta.url);
const readSeed = (rel) => JSON.parse(readFileSync(new URL(rel, seedDir), 'utf8'));

/** { indexJson, d05Json }: both as strings, ready to embed in a page's fetch stand-in. `payload` is
 *  a raw Caltrans district feed (`{ data: [{ cctv }] }`), the shape the fixtures hold. */
export function d05Stub(payload, { generatedAt = '2026-10-04T16:00:00.000Z' } = {}) {
  const index = readSeed('index.json');
  const realFile = readSeed('caltrans-cwwp2/ca-d05.json');
  const { fields, rows, schema, ...header } = realFile;
  const records = normalizeCaltransDistrict(payload, 5, { fetchedAt: generatedAt });
  const file = compactSnapshot(records, { ...header, generatedAt });
  const files = index.files
    .filter((f) => f.provider !== 'caltrans-cwwp2' || f.region === 'ca-d05')
    .map((f) => (f.region === 'ca-d05' ? { ...f, count: records.length, generatedAt } : f));
  return { indexJson: JSON.stringify({ ...index, files }), d05Json: JSON.stringify(file), records };
}

/** Page-side source: defines `window.__qcSnapshotAnswer(url)`, which answers the stub index and the
 *  District 5 file (a Response) and returns null for every other url. Reads of the District 5 file
 *  are counted in `window.__qcCatalogFetches`, the counter the camera tests already read. */
export function pageSnapshotAnswer(stub) {
  return `window.__qcCatalogFetches = 0;
  window.__qcSnapshotAnswer = (url) => {
    let path = '';
    try { path = new URL(url, location.href).pathname; } catch { return null; }
    const json = (text) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === ${JSON.stringify(INDEX_PATH)}) return json(${JSON.stringify(stub.indexJson)});
    if (path === ${JSON.stringify(D05_PATH)}) { window.__qcCatalogFetches += 1; return json(${JSON.stringify(stub.d05Json)}); }
    return null;
  };`;
}

// Fixed stand-ins for the park and link-only snapshot files, so a browser test asserts against rows
// it owns rather than whatever the build last wrote (deploy CI rebuilds those from live feeds).
// Same compact format as the real files; the index lists only these three, so a view anywhere
// else requests nothing.
const FIXED_AT = '2026-10-04T16:00:00.000Z';
const FIXED_FIELDS = ['providerId', 'name', 'lat', 'lon', 'still', 'health', 'subject', 'officialUrl'];
const NPS_IMG = 'https://www.nps.gov/featurecontent/ard/webcams/images/';
export const FIXED_ROWS = Object.freeze({
  nps: [
    ['PK-1', 'Purchase Knob Webcam', 35.5887, -83.0745, `${NPS_IMG}grpklarge.jpg`, 'active', 'Visit webcam page for current view.', 'https://www.nps.gov/media/webcam/view.htm?id=PK-1'],
    ['LR-2', 'Look Rock Webcam', 35.6326, -83.9431, `${NPS_IMG}grsmlarge.jpg`, 'active', 'Visit webcam page for current view.', 'https://www.nps.gov/media/webcam/view.htm?id=LR-2'],
    ['NG-3', 'Newfound Gap Webcam', 35.6111, -83.4266, `${NPS_IMG}gsnglarge.jpg`, 'active', 'Visit webcam page for current view.', 'https://www.nps.gov/media/webcam/view.htm?id=NG-3'],
  ],
  hpwren: [
    ['bh', 'Boucher Hill, on Palomar Mountain', 33.33462, -116.91938, null, 'active', 'Cameras: Boucher Hill', 'https://www.hpwren.ucsd.edu/cameras/#mode=realTime&cams=bh_bh-n-mobo-c'],
  ],
  alertwest: [
    ['11101:Axis-ArapahoeRidge', 'Axis-ArapahoeRidge', 40.013386, -105.192969, null, 'active', null, null],
  ],
});
const FIXED_FILES = [
  { dir: 'nps-webcams', region: 'nps-nc', regionName: 'North Carolina', layer: 'parkCameras', rows: FIXED_ROWS.nps, header: {
    provider: 'nps-webcams', source: 'https://developer.nps.gov/api/v1/webcams', operator: 'National Park Service', officialUrl: 'https://www.nps.gov/',
    attribution: 'National Park Service', rights: 'unverified', category: 'scenic' } },
  { dir: 'hpwren', region: 'hpwren-ca', regionName: 'California (HPWREN)', layer: 'linkCameras', rows: FIXED_ROWS.hpwren, header: {
    provider: 'hpwren', source: 'https://www.hpwren.ucsd.edu/cameras/sites.js', operator: 'HPWREN', officialUrl: 'https://www.hpwren.ucsd.edu/cameras/',
    attribution: 'HPWREN, UC San Diego', rights: 'unverified', category: 'fire' } },
  { dir: 'alertwest', region: 'alertwest-co', regionName: 'Colorado (AlertWest)', layer: 'linkCameras', rows: FIXED_ROWS.alertwest, header: {
    provider: 'alertwest', source: 'https://alertwest.live/api/firecams/v0/cameras', operator: 'AlertWest', officialUrl: 'https://alertwest.live/',
    attribution: 'AlertWest', rights: 'unverified', category: 'fire' } },
];

/** { [path]: json string } for the stub index and the three fixed files, keyed by url path. */
export function fixedFilesStub() {
  const out = {};
  const files = FIXED_FILES.map((f) => {
    const path = `${f.dir}/${f.region}.json`;
    out[`${CAMERA_DIR}/${path}`] = JSON.stringify({
      schema: 1, ...f.header, layer: f.layer, region: f.region, regionName: f.regionName, generatedAt: FIXED_AT,
      fields: FIXED_FIELDS, rows: f.rows,
    });
    const lats = f.rows.map((r) => r[2]), lons = f.rows.map((r) => r[3]);
    return { file: path, provider: f.header.provider, layer: f.layer, region: f.region, regionName: f.regionName,
      bbox: { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) },
      count: f.rows.length, generatedAt: FIXED_AT };
  });
  out[INDEX_PATH] = JSON.stringify({ schema: 1, files });
  return out;
}

// QQA-10b: one public point (Salinas, California) with a camera from every layer that can sit there,
// so a browser test puts road, park, link-only, research and airport cameras in one view. Each file
// keeps its provider's real header (operator, attribution, rights) from the committed seed; the rows
// are fixtures with public picture addresses on the provider's own host, laid on a small grid around
// the point so no two pins cover each other. The index lists only these five, so nothing else loads.
export const MIXED_POINT = Object.freeze({ lat: 36.6777, lon: -121.6555 });
const MIXED_REGION = { region: 'scene-salinas', regionName: 'Fixture scene (Salinas)' };
const mixedPos = (slot) => [+(MIXED_POINT.lat + (1 - Math.floor(slot / 3)) * 0.01).toFixed(5), +(MIXED_POINT.lon + ((slot % 3) - 1) * 0.013).toFixed(5)];
const MIXED_PROVIDERS = [
  { layer: 'roadCameras', seed: 'caltrans-cwwp2/ca-d05.json', dir: 'caltrans-cwwp2', plan: 'fetch', reportNoun: 'road camera', altCredit: 'Caltrans',
    names: ['US-101 : Fixture Road One', 'US-101 : Fixture Road Two', 'SR-68 : Fixture Road Three'],
    still: (i) => `https://cwwp2.dot.ca.gov/data/d5/cctv/image/fixtureroad${i}/fixtureroad${i}.jpg`, page: () => null },
  { layer: 'parkCameras', seed: 'nps-webcams/nps-nc.json', dir: 'nps-webcams', plan: 'img', reportNoun: 'park camera', altCredit: 'National Park Service',
    names: ['Fixture Park Webcam One', 'Fixture Park Webcam Two'],
    still: (i) => `https://www.nps.gov/featurecontent/ard/webcams/images/fixturepark${i}.jpg`, page: (i) => `https://www.nps.gov/media/webcam/view.htm?id=FX-${i}` },
  { layer: 'linkCameras', seed: 'hpwren/hpwren-ca.json', dir: 'hpwren', plan: 'link', reportNoun: 'camera', altCredit: null,
    names: ['Fixture Link Camera One', 'Fixture Link Camera Two'],
    still: () => null, page: (i) => `https://www.hpwren.ucsd.edu/cameras/#mode=realTime&cams=fixture${i}` },
  { layer: 'phenoCameras', seed: 'phenocam/us.json', dir: 'phenocam', plan: 'img', reportNoun: 'research camera', altCredit: 'PhenoCam Network (CC BY)',
    names: ['Fixture Research Camera One', 'Fixture Research Camera Two'],
    still: (i) => `https://phenocam.nau.edu/data/latest/fixtureresearch${i}.jpg`, page: (i) => `https://phenocam.nau.edu/webcam/sites/fixtureresearch${i}/` },
  { layer: 'airportCameras', seed: 'aviationwx/us.json', dir: 'aviationwx', plan: 'img', reportNoun: 'airport camera', altCredit: 'AviationWX.org',
    names: ['Fixture Airport (camera 1)', 'Fixture Airport (camera 2)'],
    still: (i) => `https://api.aviationwx.org/v1/airports/fx${i}/webcams/0/image?size=720`, page: (i) => `https://fx${i}.aviationwx.org/` },
];

/** { files: { [path]: json string } (the five files and the index, keyed by url path), scene: [{ layer,
 *  provider, plan, operator, cardOperator, altCredit, reportNoun, file, cameras: [{ ref, providerId,
 *  name, lat, lon, still, officialUrl }] }] }. `cardOperator` is the name the camera's own card shows:
 *  the operator, or for a link-only layer the owner's credit line. */
export function mixedSceneStub() {
  const files = {};
  let slot = 0;
  const scene = MIXED_PROVIDERS.map((p) => {
    const { fields, rows, schema, ...header } = readSeed(p.seed);
    const cameras = p.names.map((name, i) => {
      const [lat, lon] = mixedPos(slot++);
      const providerId = `fx${i + 1}`;
      return { ref: `camera:${header.provider}:${providerId}`, providerId, name, lat, lon, still: p.still(i + 1), officialUrl: p.page(i + 1) || header.officialUrl };
    });
    const path = `${p.dir}/${MIXED_REGION.region}.json`;
    files[`${CAMERA_DIR}/${path}`] = JSON.stringify({
      schema: 1, ...header, ...MIXED_REGION, generatedAt: FIXED_AT, fields: FIXED_FIELDS,
      rows: cameras.map((c) => [c.providerId, c.name, c.lat, c.lon, c.still, 'active', null, c.officialUrl === header.officialUrl ? null : c.officialUrl]),
    });
    const lats = cameras.map((c) => c.lat), lons = cameras.map((c) => c.lon);
    return { layer: p.layer, provider: header.provider, plan: p.plan, operator: header.operator,
      cardOperator: p.plan === 'link' ? header.operator : header.operator, altCredit: p.altCredit, reportNoun: p.reportNoun, file: `${CAMERA_DIR}/${path}`, cameras,
      index: { file: path, provider: header.provider, layer: p.layer, ...MIXED_REGION,
        bbox: { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) },
        count: cameras.length, generatedAt: FIXED_AT } };
  });
  files[INDEX_PATH] = JSON.stringify({ schema: 1, files: scene.map((s) => s.index) });
  return { files, scene };
}
