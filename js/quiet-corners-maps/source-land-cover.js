// What the ground was mapped as, and how much of it tree crowns covered, in one stated year.
//
// Measured live 2026-09-15 with an `Origin: https://headlessmode.com` header. Five
// measurements decide everything this file does.
//
// 1. THE PLAN'S ENDPOINT IS DARK. `www.mrlc.gov` answered none of 33 probes over 19 minutes:
//    TLS completes against a genuine USGS certificate and then no HTTP response arrives.
//    Not an egress block -- api.weather.gov and basemap.nationalmap.gov answered 200 from
//    the same shell. The Forest Service's IIPP mirror on imagery.geoplatform.gov is the
//    only measured route, and it is somebody else's copy of a USGS product.
//
// 2. THE YEAR IS PINNED ON EVERY REQUEST, OR THE ANSWER IS A LIE. The default mosaic rule
//    silently returns the newest year and nothing in the response says so: at NW Las Vegas
//    an unpinned identify answered 23 (Developed, Medium), which is the 2024 answer, while
//    1985-2005 read 52 (Shrub/Scrub). Pinning also costs 4,250 bytes against 155,647 --
//    `returnCatalogItems` defaults on and each of 40 items carries a full CONUS ring.
//    `mosaicRuleFor` therefore THROWS on a year the product does not hold: a request that
//    cannot be built wrong is better than a rule someone has to remember.
//
// 3. `returnCatalogItems` MUST STAY ON. Switching it off reaches 217 bytes and destroys the
//    only coverage discriminator there is: Paris and the Gulf of Mexico then come back
//    identical. With it on, outside-coverage has ZERO catalogue items and genuine no-data
//    inside CONUS has one -- the pinned raster itself.
//
// 4. HTTP STATUS IS USELESS AS AN ERROR SIGNAL. A missing service answers 200 carrying
//    `{"error":{"code":404,...}}`; a bad mosaicRule answers 200 with the backend SQL. Every
//    JSON answer is tested for an `error` KEY, never for `res.ok`.
//
// 5. THE PICTURE CANNOT ANSWER COVERAGE AT ALL. Paris and the Gulf return byte-identical
//    PNGs. And with the default `format=png` an out-of-coverage export is opaque #000000
//    across all 65,536 pixels -- the tRNS chunk keys transparency to RGB(253,253,253), not
//    black -- so it paints a black rectangle over the basemap. `png32` with
//    `transparent=true` is mandatory, and the coverage ANSWER comes from the service's own
//    published extent or from an identify call, never from the image.
//
// The class numbers are published nowhere: `/rasterAttributeTable` answers `{}` and the
// legend carries labels and swatches with no codes. Fifteen of the sixteen below were
// recovered by exporting one Wisconsin extent twice -- raw `format=tiff` U8 values and
// rendered `format=png` -- and pairing all 65,536 pixels with zero unmatched, corroborated
// by computeHistograms over 100,000,000 pixels at native 30 m. Code 12 does not occur in
// Wisconsin; its colour is measured off the legend swatch, its NUMBER is read off the
// legend's order, and it says so rather than passing as known.
import { SOURCES } from './source-registry.js';
import { fetchWithDeadline } from './request.js';

export const PRODUCTS = Object.freeze({ landCover: SOURCES.nlcdLandCover, canopy: SOURCES.nlcdTreeCanopy });
export const PRODUCT_IDS = Object.freeze(Object.keys(PRODUCTS));

export function productOf(product) {
  const src = PRODUCTS[product];
  if (!src) throw new RangeError(`unknown NLCD product: ${product}`);
  return src;
}

/** This layer's own cap, not the service's 100,000: a deliberate 5,000 x 5,000 request was
 *  ACCEPTED, so the service will not protect the app from itself. 256 square measured 12,912
 *  bytes for land cover and 46,262 for canopy, there is no tile cache, and every pan is a
 *  live render -- so the same 512 the other per-view export uses is the ceiling here too. */
export const MAX_IMAGE_SIDE = 512;

/** The service's own published extent, EPSG:3857. It RULES GROUND OUT and never in: the Gulf
 *  of Mexico point sits inside this rectangle and still answers NoData. */
export const CONUS_EXTENT_3857 = Object.freeze({
  xmin: -14391085.42, ymin: 2488123.62, xmax: -7026295.42, ymax: 6967723.62,
});

const cls = (label, color, verified = true, note = null) => Object.freeze({ label, color, verified, note });

/** value -> the label the service's OWN legend gives it, word for word, paired to the colour
 *  its OWN renderer paints. `verified: false` means the NUMBER was not measured. */
export const LAND_COVER_CLASSES = Object.freeze({
  11: cls('Open Water', '#466B9F'),
  12: cls('Perennial Ice/Snow', '#D1DEF8', false,
    'Absent from the measured extent: the colour is the legend swatch, the code 12 is read '
    + 'off the legend\'s order and is unverified.'),
  21: cls('Developed, Open Space', '#DEC5C5'),
  22: cls('Developed, Low Intensity', '#D99282'),
  23: cls('Developed, Medium Intensity', '#EB0000'),
  24: cls('Developed, High Intensity', '#AB0000'),
  31: cls('Barren Land', '#B3AC9F'),
  41: cls('Deciduous Forest', '#68AB5F'),
  42: cls('Evergreen Forest', '#1C5F2C'),
  43: cls('Mixed Forest', '#B5C58F'),
  52: cls('Shrub/Scrub', '#CCB879'),
  71: cls('Grassland/Herbaceous', '#DFDFC2'),
  81: cls('Pasture/Hay', '#DCD939'),
  82: cls('Cultivated Crops', '#AB6C28'),
  90: cls('Woody Wetlands', '#B8D9EB'),
  95: cls('Emergent Herbaceous Wetlands', '#6C9FB8'),
});

/** The service echoes the request Origin and sets `access-control-allow-credentials: true`
 *  rather than `*`. It is keyless and anonymous and nothing here has an account with it, so
 *  every request says so explicitly instead of relying on a default. */
const timeoutFor = (request) => (PRODUCTS[request && request.product] || PRODUCTS.landCover).timeoutMs;
export const FETCH_OPTIONS = Object.freeze({ credentials: 'omit' });

/** The year, or a throw. Nothing in this file can build a request without going through it. */
export function mosaicRuleFor(product, year) {
  const src = productOf(product);
  const [first, last] = src.time.years;
  if (!Number.isInteger(year) || year < first || year > last) {
    throw new RangeError(`${src.name} holds ${first}-${last}; ${year} is not a year it can answer for`);
  }
  return src.time.mosaicRuleTemplate.replace('{year}', String(year));
}

export const defaultYearFor = (product) => productOf(product).time.defaultObserved;

/** The exportImage request for one view. Pure, so the geometry and the pinned year can be
 *  asserted without a network call. `bboxSR` is not optional: the service's own spatial
 *  reference is Web Mercator, and a lon/lat box that does not declare 4326 is read as metres. */
export function surfaceRequestFor({ product = 'landCover', bboxLonLat, width, height, year = null }) {
  const src = productOf(product);
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  const side = (n) => Math.max(1, Math.min(MAX_IMAGE_SIDE, Math.round(Number(n) || 0)));
  const w = side(width);
  const h = side(height);
  const pinned = year === null ? src.time.defaultObserved : year;
  return {
    url: `${src.serviceUrl}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: '4326',
      imageSR: '3857',
      size: `${w},${h}`,
      // png32 + transparent: the ONLY combination that leaves ground the service never
      // classified undrawn instead of painting it opaque black over the basemap.
      format: 'png32',
      transparent: 'true',
      mosaicRule: mosaicRuleFor(product, pinned),
      // f=json answers an href to a generated file under /rest/directories/, which is an
      // extra round trip to a path that looks temporary. Take the bytes.
      f: 'image',
    },
    product,
    year: pinned,
    width: w,
    height: h,
  };
}

export const surfaceImageUrl = (req) => `${req.url}?${new URLSearchParams(req.params)}`;

/** One point, one product, one pinned year -- and the catalogue left switched on, because
 *  the count of items in it IS the difference between "outside the country" and "ocean". */
export function pointRequestFor({ product = 'landCover', lon, lat, year = null }) {
  const src = productOf(product);
  const pinned = year === null ? src.time.defaultObserved : year;
  return {
    url: `${src.serviceUrl}/identify`,
    params: {
      geometry: JSON.stringify({ x: Number(lon), y: Number(lat), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPoint',
      returnGeometry: 'false',
      returnCatalogItems: 'true',
      mosaicRule: mosaicRuleFor(product, pinned),
      f: 'json',
    },
    product,
    year: pinned,
  };
}

export const pointUrl = (req) => `${req.url}?${new URLSearchParams(req.params)}`;

const answer = (state, text, extra = {}) =>
  Object.freeze({ state, text, label: null, code: null, percent: null, ...extra });

/** Four outcomes, never two. The three missingness states are separately DETECTABLE and are
 *  separately SAID, because the picture distinguishes none of them. */
export function readPointAnswer(body, product = 'landCover', year = null) {
  const src = productOf(product);
  const pinned = year === null ? src.time.defaultObserved : year;
  const what = product === 'canopy' ? 'Tree canopy' : 'Land cover';
  if (!body || body.error || body.value === undefined || body.value === null) {
    return answer('error', `The ${src.name} service did not answer for this point, so its `
      + `${product === 'canopy' ? 'canopy' : 'land cover'} is unknown.`);
  }
  const items = body.catalogItems && Array.isArray(body.catalogItems.features)
    ? body.catalogItems.features.length : null;
  const raw = String(body.value).trim();
  if (raw.toLowerCase() === 'nodata') {
    // Zero catalogue items means the mosaic holds no raster covering this ground at all.
    if (items === 0) {
      return answer('outsideCoverage', `${what} is mapped for the lower 48 states only, and this `
        + 'point is outside that. Nothing is known here — it is not ground the survey found empty.');
    }
    return answer('noData', `${what} for ${pinned} covers this point but records no value for it — `
      + 'open water and ground the year\'s raster left out both read this way.');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return answer('error', `The ${src.name} service answered something this map cannot read, so its `
      + 'value here is unknown.');
  }
  if (product === 'canopy') {
    const { nonProcessing, background } = src.values;
    if (n === nonProcessing || n === background) {
      return answer('noData', `Tree canopy for ${pinned} carries no percentage at this point: the `
        + `service marks it ${n === background ? 'background' : 'a non-processing area'}, which is `
        + 'not a canopy figure and is never averaged with one.');
    }
    return answer('value', `Tree crowns covered about ${n}% of this 30 m square in ${pinned} — `
      + 'seen from above, which is not the same as shade on the ground.', { percent: n });
  }
  const found = LAND_COVER_CLASSES[n];
  if (!found) {
    return answer('error', `The land-cover service answered class ${n}, which is not one of the `
      + 'sixteen this map has a label for.', { code: n });
  }
  const caveat = found.verified ? '' : ' (this class number is unverified — see the key)';
  return answer('value', `Mapped as ${found.label} in ${pinned}${caveat} — an algorithm's `
    + 'classification of a quarter-acre square, not a look at the ground.',
  { label: found.label, code: n });
}

const merc = (lon, lat) => ({
  x: (Number(lon) * 20037508.34) / 180,
  y: (Math.log(Math.tan(((90 + Number(lat)) * Math.PI) / 360)) / (Math.PI / 180)) * (20037508.34 / 180),
});

/** Whether the view can be RULED OUT of coverage before a request is spent on it. The
 *  service's rectangle rules ground out and never in, so there are two answers and not
 *  three: 'outside' is proof, 'unproven' is the honest name for everything else. */
export function viewCoverage(bboxLonLat) {
  const a = merc(bboxLonLat.minLon, bboxLonLat.minLat);
  const b = merc(bboxLonLat.maxLon, bboxLonLat.maxLat);
  const e = CONUS_EXTENT_3857;
  const disjoint = b.x <= e.xmin || a.x >= e.xmax || b.y <= e.ymin || a.y >= e.ymax;
  return disjoint ? 'outside' : 'unproven';
}

/** What the layer row says about the VIEW. An out-of-coverage view draws nothing, and the
 *  row has to say that is ground this service never mapped rather than ground with no cover. */
export function coverageText(product, coverage, drawn = true) {
  const what = product === 'canopy' ? 'Tree canopy' : 'Land cover';
  if (coverage === 'outside') {
    return `${what} is published for the lower 48 states only and does not reach this view, so `
      + 'nothing is drawn. Alaska, Hawaii and the territories are outside it.';
  }
  if (!drawn) {
    return `The ${what.toLowerCase()} service did not answer for this view, so nothing is drawn.`;
  }
  return `${what} drawn for this view. Where the picture is blank the service mapped nothing — `
    + 'that is missing coverage, not bare ground.';
}

/** The key, from the same table the service's own renderer paints from. The canopy rows are
 *  VALUE bands with no swatches: this site has not measured the service's 103-entry ramp,
 *  and inventing colours for a key would be worse than a key that states numbers only. */
export function legendRows(product) {
  if (product === 'canopy') {
    const { range, nonProcessing, background } = productOf('canopy').values;
    return [
      { code: null, color: null, label: `${range[0]}–${range[1]}% of the square covered by tree crowns, `
        + 'shaded by the service\'s own ramp' },
      { code: nonProcessing, color: null, label: `${nonProcessing} (non-processing area) and `
        + `${background} (background) are NOT percentages and are never averaged as one` },
    ];
  }
  return Object.entries(LAND_COVER_CLASSES).map(([code, c]) => ({
    code: Number(code),
    color: c.color,
    label: c.verified ? c.label : `${c.label} — class number unverified`,
  }));
}

/** The year, said out loud, because the service will not say it and its default answer is
 *  silently the newest year. "Current" never appears. */
export function yearLine(product, year = null) {
  const src = productOf(product);
  const pinned = year === null ? src.time.defaultObserved : year;
  const [first, last] = src.time.years;
  return product === 'canopy'
    ? `Tree canopy as modelled for ${pinned} (NLCD v2025-6; the service publishes ${first}–${last}).`
    : `Land cover as mapped for ${pinned} (Annual NLCD Collection 1.1; the service publishes ${first}–${last}).`;
}

export const LAND_COVER_LABEL = 'What the ground was mapped as (NLCD land cover, by year)';
export const LAND_COVER_CAVEAT = 'A classified estimate from satellite images, not a look at the '
  + 'ground: every 30 m square — about a quarter-acre — is an algorithm\'s best guess at one of '
  + 'sixteen classes, and USGS publishes a separate confidence product precisely because the guess '
  + 'can be wrong. The year is stated because the service will not: ask it without a year and it '
  + 'quietly answers its newest one, which is 2024. A road, a creek or a clearing narrower than the '
  + 'square disappears into whichever class won it. It says nothing about who owns the ground, '
  + 'whether you may walk on it, or what stands there now. The lower 48 states only — there is no '
  + 'land-cover service here for Alaska, Hawaii or the territories, and a blank view there means '
  + 'the survey never reached it, not that the ground is bare.';

export const CANOPY_LABEL = 'How much tree crown covers the ground (NLCD canopy percent, by year)';
export const CANOPY_CAVEAT = 'The modelled percentage of a 30 m square that tree crowns cover, seen '
  + 'from above in one stated year — newest 2025, and stated because the service otherwise answers '
  + 'its newest year without saying so. The publisher calls its own inputs model outputs and then '
  + 'smooths them across years, so one year\'s figure is a number about a time series rather than a '
  + 'measurement of one summer. 70% canopy is not 70% shade on a trail: it says nothing about what '
  + 'is under the crowns, nothing about the season, and nothing about any particular day. Two values '
  + 'in the data are not percentages at all — 254 marks a non-processing area and 255 the background '
  + '— and they are never read as canopy. The lower 48 states here; coastal Alaska, Hawaii and '
  + 'Puerto Rico are separate services this map does not draw.';

/** Every string this layer can put in front of a reader, in one place, so a test can scan
 *  the lot for a claim it cannot keep. */
export function readerStrings() {
  const pt = (body, product, year) => readPointAnswer(body, product, year).text;
  const covered = { features: [{ attributes: { beginyear: 2024 } }] };
  return [
    LAND_COVER_LABEL, LAND_COVER_CAVEAT, CANOPY_LABEL, CANOPY_CAVEAT,
    SOURCES.nlcdLandCover.attribution, SOURCES.nlcdTreeCanopy.attribution,
    yearLine('landCover', 2024), yearLine('canopy', 2025),
    ...legendRows('landCover').map((r) => r.label), ...legendRows('canopy').map((r) => r.label),
    pt({ value: '41', catalogItems: covered }, 'landCover', 2024),
    pt({ value: '12', catalogItems: covered }, 'landCover', 2024),
    pt({ value: '77', catalogItems: covered }, 'canopy', 2025),
    pt({ value: '254', catalogItems: covered }, 'canopy', 2025),
    pt({ value: 'NoData', catalogItems: { features: [] } }, 'landCover', 2024),
    pt({ value: 'NoData', catalogItems: covered }, 'landCover', 2024),
    pt({ error: { code: 400 } }, 'landCover', 2024),
    coverageText('landCover', 'outside'), coverageText('landCover', 'unproven'),
    coverageText('canopy', 'unproven', false),
  ];
}

/** Fetched as BYTES and painted from a `blob:` URL, never handed to an <img> as a service
 *  URL: `img-src` already allows blob:, so the whole pair costs the policy one connect-src
 *  host -- 24 characters -- instead of 48. Never throws the map. */
export async function fetchSurface(request, { fetchImpl = fetch, signal } = {}) {
  const got = await fetchWithDeadline(surfaceImageUrl(request), {
    fetchImpl, signal, timeoutMs: timeoutFor(request), init: FETCH_OPTIONS, read: (res) => res.blob(),
  });
  return got.ok ? got.body : null;
}

/** A point read, as JSON. `res.ok` is deliberately not the test for success -- the caller
 *  reads the body, because this service states its errors inside a 200. */
export async function fetchPoint(request, { fetchImpl = fetch, signal } = {}) {
  const got = await fetchWithDeadline(pointUrl(request), {
    fetchImpl, signal, timeoutMs: timeoutFor(request), init: FETCH_OPTIONS, anyStatus: true,
  });
  return got.body ?? null;
}

/** A Leaflet image overlay re-exported for the view it is asked about, the same shape as the
 *  radar and slope surfaces. There is no tile cache, so every extent is a live render and
 *  nothing is asked for until the reader turns the surface on. An export for a view the
 *  reader has left is abandoned, never drawn. */
export function landCoverLayer(L, { product = 'landCover', year = null, opacity = 0.75,
  fetchImpl = fetch, urlFactory = null } = {}) {
  const urls = urlFactory || (typeof URL === 'undefined' ? null : URL);
  const layer = L.imageOverlay('', [[0, 0], [0, 0]], {
    opacity,
    interactive: false,
    // Decorative: what the surface is gets said in the layer row and the key, and a screen
    // reader hearing a bitmap called "land cover" gains nothing it can act on.
    alt: '',
  });
  let live = null;
  let painted = null;
  const release = () => { if (painted && urls) { urls.revokeObjectURL(painted); painted = null; } };
  layer.product = product;
  layer.year = year === null ? defaultYearFor(product) : year;
  layer.cancel = () => { if (live) { live.abort(); live = null; } };
  layer.refresh = async function refresh(map, report = () => {}) {
    layer.cancel();
    const b = map.getBounds();
    const bboxLonLat = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
    const coverage = viewCoverage(bboxLonLat);
    // The rectangle rules ground out, so a view wholly outside it is answered without
    // spending a request on a picture that would be blank whatever it said.
    if (coverage === 'outside') {
      release();
      layer.setUrl('');
      report({ coverage, drawn: false, year: layer.year, product });
      return { coverage, drawn: false };
    }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    live = ctl;
    const size = map.getSize();
    const request = surfaceRequestFor({ product, bboxLonLat, width: size.x, height: size.y, year: layer.year });
    const blob = await fetchSurface(request, { fetchImpl, signal: ctl ? ctl.signal : undefined });
    if (live !== ctl) return null;          // the reader moved on; this answer is about a view they left
    live = null;
    if (!blob || !urls) { report({ coverage, drawn: false, year: layer.year, product }); return null; }
    release();
    painted = urls.createObjectURL(blob);
    layer.setBounds(b);
    layer.setUrl(painted);
    report({ coverage, drawn: true, year: layer.year, product });
    return { coverage, drawn: true };
  };
  return layer;
}
