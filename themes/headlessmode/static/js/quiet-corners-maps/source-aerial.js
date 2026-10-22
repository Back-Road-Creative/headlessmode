// NAIP aerial imagery: a companion sheet, never an overlay.
//
// Decided 2026-09-06: yes, "as an optional extra sheet". That constraint is the whole
// design. Aerial photography cannot sit on top of a topo raster legibly -- two
// full-colour images fight, and the contours lose. So each aerial sheet is its
// own page, at the SAME extent, scale and frame as the topo sheet it pairs with,
// so the two can be laid side by side and read as one.
//
// USDA NAIP is public domain. Verified 2026-09-06: exportImage returned 276 KB
// for a North Carolina extent and 258 KB for an Arizona one, with different
// hashes -- real, distinct imagery. That check exists because 3DEP's exportImage
// returned a BYTE-IDENTICAL image for two different states, and a source that
// answers every request with the same picture is worse than one that errors.
const SERVICE = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer';

// A sheet's raster at 300 dpi is 2400x2850, which NAIP will happily render but
// which costs megabytes per sheet. Aerial detail is worth less per pixel than
// contour detail, so the companion is fetched at half linear resolution and
// drawn at full size -- visibly softer, a fraction of the download.
export const AERIAL_SCALE = 0.5;
const MAX_SIDE = 4000;   // the service's own export ceiling

/** The exportImage request for one sheet. Pure: returns url + params, so a test
 *  can assert the geometry without a network call. */
export function aerialRequestFor(sheet, bboxLonLat) {
  const w = Math.min(MAX_SIDE, Math.round(sheet.pixel.width * AERIAL_SCALE));
  const h = Math.min(MAX_SIDE, Math.round(sheet.pixel.height * AERIAL_SCALE));
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  return {
    url: `${SERVICE}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: '4326',
      imageSR: '4326',
      size: `${w},${h}`,
      format: 'jpg',
      f: 'image',
    },
    width: w,
    height: h,
  };
}

/** The aerial image for one sheet, as bytes. Never throws the build: an aerial
 *  sheet is an extra, so a failure loses the companion page, not the map. */
export async function fetchAerial({ sheet, bboxLonLat, fetchImpl = fetch, signal } = {}) {
  const req = aerialRequestFor(sheet, bboxLonLat);
  const res = await fetchImpl(`${req.url}?${new URLSearchParams(req.params)}`, { signal });
  if (!res.ok) throw new Error(`Aerial imagery: the service answered ${res.status}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error('Aerial imagery: the service returned an empty image.');
  return { id: sheet.id, bytes, width: req.width, height: req.height, format: 'jpg' };
}

export const AERIAL_SOURCE = Object.freeze({
  id: 'usdaNaip',
  name: 'USDA NAIP aerial imagery',
  origin: new URL(SERVICE).origin,
  serviceUrl: SERVICE,
  attribution: 'USDA National Agriculture Imagery Program (NAIP), served by USGS',
  coverageSemantics: 'NAIP is flown on a multi-year cycle, so an aerial sheet can be several '
    + 'seasons old: a track visible here may be overgrown, and one absent may since have been cut. '
    + 'It shows ground cover, not legal access — the topo sheet and the MVUM layer decide that.',
});
