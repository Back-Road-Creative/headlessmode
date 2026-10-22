// Synthetic, sanitised GNIS payload for names-keyboard.test.mjs: fictional
// "Test Place NN" Populated Place features gridded across app-state.js's
// EXAMPLE_AREA bbox, one more row than fits under the default screen-declutter
// cap (name-labels.js DENSITY_CAP.standard = 40), so at least
// PLACE_FEATURES.length - 40 names are guaranteed suppressed by the hard
// index cap alone (placeScreenLabels' `placedCount >= cap`), independent of
// any incidental on-screen pixel collision. Layers 5/6/7 (landforms, stream
// mouths, other hydro features) are answered empty by the test's fixture --
// this file only exercises the Populated Place vocabulary (layer 3).
const COLS = 9;
const ROWS = 5;
const BBOX = { minLon: -83.55, minLat: 35.0, maxLon: -83.4, maxLat: 35.1 };

function grid() {
  const features = [];
  let n = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      n++;
      const lon = BBOX.minLon + (BBOX.maxLon - BBOX.minLon) * (col + 1) / (COLS + 1);
      const lat = BBOX.minLat + (BBOX.maxLat - BBOX.minLat) * (row + 1) / (ROWS + 1);
      features.push({
        attributes: {
          gaz_id: 900000 + n,
          gaz_name: `Test Place ${String(n).padStart(2, '0')}`,
          gaz_featureclass: 'Populated Place',
          state_alpha: 'NC',
          county_name: 'Test County',
        },
        geometry: { points: [[lon, lat]] },
      });
    }
  }
  return features;
}

export const PLACE_FEATURES = grid();

// QUX-05b: a mixed-kind sample proving a kind budget keeps a scarce kind
// (Summit) visible instead of letting a numerous one (Populated Place) fill
// the whole cap. 35 place rows + 10 summit rows, 45 total -- over
// DENSITY_CAP.standard (40) -- in the same raw Esri-attributes shape as
// PLACE_FEATURES above. Each row sits 6 degrees from its neighbours (240px
// apart under name-labels.test.mjs's own 40px/degree toPx), far enough that
// no two candidate offset boxes can collide by construction, matching
// manyFeatures()'s spacing convention in that test file -- a test exercising
// the cap/kind-floor rule must not also be limited by incidental overlap.
// Places sit at lat 30, summits at lat 45, so the two kinds never share a row.
function mixedKindFeatures() {
  const features = [];
  for (let i = 0; i < 35; i++) {
    features.push({
      attributes: {
        gaz_id: 910000 + i + 1,
        gaz_name: `Mixed Town ${String(i + 1).padStart(2, '0')}`,
        gaz_featureclass: 'Populated Place',
        state_alpha: 'NC',
        county_name: 'Test County',
      },
      geometry: { points: [[-170 + i * 6, 30]] },
    });
  }
  for (let i = 0; i < 10; i++) {
    features.push({
      attributes: {
        gaz_id: 920000 + i + 1,
        gaz_name: `Mixed Peak ${String(i + 1).padStart(2, '0')}`,
        gaz_featureclass: 'Summit',
        state_alpha: 'NC',
        county_name: 'Test County',
      },
      geometry: { points: [[-170 + i * 6, 45]] },
    });
  }
  return features;
}

export const MIXED_KIND_FEATURES = mixedKindFeatures();
