// Every camera layer's pins carry their colour in the stylesheet, one colour per layer, and the
// colours read apart on the map.
//
// The link-only pin was painted by script (an inline background on Leaflet's wrapper) while
// every other layer drew its dot from a `.qcm-camera-pin--<kind>::before` rule. An inline style
// is invisible to css-selector-reach and to anyone reading the stylesheet, and its violet sat a
// few steps from the airport pins' purple, so two layers looked like one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYERS } from '../../themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js';

const MAIN = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../themes/headlessmode/static/css/quiet-corners-maps.css', import.meta.url), 'utf8');
const CAMERA_IDS = LAYERS.filter((l) => l.group === 'cameras').map((l) => l.id);

// Smallest RGB distance two layers' dots may sit apart: below it, a reader cannot tell them apart
// at 12px on the dark basemap. The old link violet sat 49 from the airport purple.
const MIN_RGB_DISTANCE = 60;

function pinClasses() {
  const block = MAIN.match(/const CAMERA_PIN_CLASS = \{([^}]*)\}/);
  assert.ok(block, 'main.js no longer has a CAMERA_PIN_CLASS table');
  return Object.fromEntries([...block[1].matchAll(/(\w+): '([\w-]+)'/g)].map((m) => [m[1], m[2]]));
}

function dotColour(cls) {
  const re = new RegExp(`\\.${cls}::before\\s*\\{[^}]*background:\\s*#([0-9a-f]{6})`, 'i');
  const m = CSS.match(re);
  return m ? m[1].toLowerCase() : null;
}

const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

test('every camera layer has a pin class whose dot colour is a stylesheet rule', () => {
  const classes = pinClasses();
  for (const id of CAMERA_IDS) {
    assert.ok(classes[id], `${id} is a camera layer with no CAMERA_PIN_CLASS entry`);
    assert.ok(dotColour(classes[id]), `.${classes[id]}::before has no background in quiet-corners-maps.css`);
  }
});

test('no camera pin is painted by script', () => {
  assert.doesNotMatch(MAIN, /pin\.getElement\(\)\.style/, 'a camera pin takes an inline style; give its layer a ::before rule instead');
});

test('the camera layers\' dot colours read apart', () => {
  const classes = pinClasses();
  const colours = CAMERA_IDS.map((id) => [id, dotColour(classes[id])]).filter(([, c]) => c);
  for (let i = 0; i < colours.length; i++) {
    for (let j = i + 1; j < colours.length; j++) {
      const d = Math.round(distance(colours[i][1], colours[j][1]));
      assert.ok(d >= MIN_RGB_DISTANCE, `${colours[i][0]} #${colours[i][1]} and ${colours[j][0]} #${colours[j][1]} are ${d} apart (need ${MIN_RGB_DISTANCE})`);
    }
  }
});
