// The screen base is a CHOICE. The base-map checkbox rendered checked and disabled and
// controlled nothing on screen: the dashboard adds its own topo tiles at field zoom.
// Measured 2026-09-12: USGSImageryOnly stops at level 16 (17 is 404), USGSShadedReliefOnly
// at level 13 (14 is 404). Both share the topo host, so the CSP does not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASES, DEFAULT_BASE, leafletOptions, baseLayer, zoomStatus, readerStrings }
  from '../../themes/headlessmode/static/js/quiet-corners-maps/source-basemaps.js';
import { SOURCES, cspDirectivesFor } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';

test('four bases in a fixed order, topo first and by default', () => {
  assert.deepEqual(BASES.map((b) => b.id), ['usgsTopo', 'usgsImagery', 'usgsShadedRelief', 'none']);
  assert.equal(DEFAULT_BASE, 'usgsTopo');
  for (const b of BASES) assert.ok(b.label, `${b.id} has no reader label`);
  assert.match(BASES.find((b) => b.id === 'usgsImagery').label, /June 2024/, 'the refresh reaches the reader');
});

test('each tile base carries its own measured ceiling and the registry template', () => {
  assert.equal(leafletOptions('usgsShadedRelief').options.maxNativeZoom, 13);
  assert.equal(leafletOptions('usgsImagery').options.maxNativeZoom, 16);
  assert.equal(leafletOptions('usgsTopo').options.maxNativeZoom, 16);
  for (const id of ['usgsTopo', 'usgsImagery', 'usgsShadedRelief']) {
    const { url, options } = leafletOptions(id);
    assert.equal(url, SOURCES[id].tile.urlTemplate);
    assert.equal(options.maxZoom, 16, 'the map’s own ceiling: enlarge rather than vanish');
    assert.equal(options.opacity, 1, 'the base is no longer dimmed: owned overlays carry their own backplates');
    assert.ok(options.attribution);
  }
  assert.equal(SOURCES.usgsShadedRelief.tile.level14Observed, 404);
  assert.equal(SOURCES.usgsImagery.tile.level17Observed, 404);
  assert.equal(SOURCES.usgsImagery.origin, SOURCES.usgsTopo.origin, 'same host, so img-src is unchanged');
  // The full img-src list: the topo host, night lights, radar, and (QUX-08D-ii) the NPS
  // webcam stills. No tile base adds a host of its own.
  assert.deepEqual(cspDirectivesFor()['img-src'],
    [
    'https://511la.org', 'https://api.aviationwx.org', 'https://assets.lawrenceks.gov', SOURCES.usgsTopo.origin, 'https://cctv.austinmobility.io',
    'https://cocam.carsprogram.org', 'https://egov.cityofsalem.net', SOURCES.btsTransportNoise.origin, SOURCES.nasaBlackMarble.origin, 'https://images.srtmc.org', 'https://images.wsdot.wa.gov', 'https://its.kirklandwa.gov',
    'https://kscam.carsprogram.org', SOURCES.nwsRadar.origin, 'https://phenocam.nau.edu', 'https://public.carsprogram.org',
    'https://sd.cdn.iteris-atis.com', 'https://snapshot.vdotcameras.com', 'https://tripcheck.com', 'https://udottraffic.utah.gov',
    SOURCES.volcview.origin, 'https://webapps.arlingtontx.gov', SOURCES.glerl.origin, SOURCES.npsWebcams.origin, 'https://www.trimarc.org',
  ]);
});

test('"none" is null — nothing to add — and only the relief says it is enlarged at 14', () => {
  const fakeL = { tileLayer: (u, o) => ({ u, o }) };
  assert.equal(baseLayer(fakeL, 'none'), null);
  assert.equal(baseLayer(fakeL, 'usgsImagery').u, SOURCES.usgsImagery.tile.urlTemplate);
  assert.throws(() => baseLayer(fakeL, 'nope'), RangeError);
  assert.equal(typeof zoomStatus('usgsShadedRelief', 14), 'string');
  assert.match(zoomStatus('usgsShadedRelief', 14), /zoom 13/);
  assert.equal(zoomStatus('usgsShadedRelief', 13), null);
  assert.equal(zoomStatus('usgsImagery', 14), null);
  assert.equal(zoomStatus('none', 16), null);
  assert.ok(readerStrings().includes(zoomStatus('usgsShadedRelief', 14)));
});
