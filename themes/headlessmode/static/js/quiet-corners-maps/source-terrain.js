// 3DEP shaded relief: a companion sheet, never an overlay.
//
// Same constraint as the aerial sheet, for the same reason. A hillshade laid over
// the USGS topo raster fights the contours it is meant to explain -- both are
// grey, both carry the terrain, and the sheet ends up muddier than either alone.
// So relief gets its own page at the SAME extent, scale and frame, and the pair is
// read side by side: contours for the number, shading for the shape.
//
// The old blocker was never the service. A hand-built Remap/Colormap raster chain
// was what failed; 3DEP publishes NAMED raster functions and `Hillshade Gray` is
// one of them, so the request is a string, not a chain to get right.
//
// VERIFIED 2026-09-07 against the live service, three extents, three distinct
// hashes and sizes that track the terrain: North Carolina 623 KB, Mount Rainier
// 599 KB, flat western Kansas 270 KB. All answered `access-control-allow-origin: *`.
// That check is not ceremony -- 3DEP's exportImage once returned a BYTE-IDENTICAL
// image for two different states, and a source that answers every request with the
// same picture is worse than one that errors.
const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

/** The named raster function. Not a chain: the service renders it server-side. */
export const RASTER_FUNCTION = 'Hillshade Gray';

// Relief is smooth by nature -- there is no fine detail to lose, unlike contours --
// so the companion is fetched at half linear resolution and drawn at full size.
export const TERRAIN_SCALE = 0.5;
const MAX_SIDE = 4000;   // the service's own export ceiling

/** The exportImage request for one sheet. Pure: returns url + params, so a test
 *  can assert the geometry and the raster function without a network call. */
export function terrainRequestFor(sheet, bboxLonLat) {
  const w = Math.min(MAX_SIDE, Math.round(sheet.pixel.width * TERRAIN_SCALE));
  const h = Math.min(MAX_SIDE, Math.round(sheet.pixel.height * TERRAIN_SCALE));
  const { minLon, minLat, maxLon, maxLat } = bboxLonLat;
  return {
    url: `${SERVICE}/exportImage`,
    params: {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      bboxSR: '4326',
      imageSR: '4326',
      size: `${w},${h}`,
      // PNG, not JPG: a hillshade is a smooth grey ramp, and JPEG ringing on a
      // ridge line reads as a terrace that is not there.
      format: 'png',
      renderingRule: JSON.stringify({ rasterFunction: RASTER_FUNCTION }),
      f: 'image',
    },
    width: w,
    height: h,
  };
}

/** The relief image for one sheet, as bytes. Never throws the build: a terrain
 *  sheet is an extra, so a failure loses the companion page, not the map. */
export async function fetchTerrain({ sheet, bboxLonLat, fetchImpl = fetch, signal } = {}) {
  const req = terrainRequestFor(sheet, bboxLonLat);
  const res = await fetchImpl(`${req.url}?${new URLSearchParams(req.params)}`, { signal });
  if (!res.ok) throw new Error(`Shaded relief: the service answered ${res.status}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error('Shaded relief: the service returned an empty image.');
  return { id: sheet.id, bytes, width: req.width, height: req.height, format: 'png' };
}

export const TERRAIN_SOURCE = Object.freeze({
  id: 'usgs3depRelief',
  name: 'USGS 3DEP shaded relief',
  origin: new URL(SERVICE).origin,
  serviceUrl: SERVICE,
  attribution: 'USGS 3D Elevation Program (3DEP)',
  coverageSemantics: 'Shaded relief rendered from the 3DEP elevation model, lit from the northwest. '
    + 'It shows the SHAPE of the ground, not what is on it and not who owns it — the topo sheet '
    + 'carries the contour values and the land layers carry the designations.',
});
