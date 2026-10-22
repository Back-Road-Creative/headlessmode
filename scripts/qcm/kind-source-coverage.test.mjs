// Every name kind must have a real source behind it: one registered in source-registry.js,
// whose geometry can place the kind inside any view it crosses, and whose zoom range reaches
// the kind's minZoom. A kind added without a source (river and creek had none: the only
// stream data was a stream-MOUTH point, which a view upstream of the mouth never contained)
// fails here instead of shipping a label that can never appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import { KINDS } from '../../themes/headlessmode/static/js/quiet-corners-maps/terrain-names.js';
import { NAME_ICON_BY_KIND } from '../../themes/headlessmode/static/js/quiet-corners-maps/print-names.js';

const entries = Object.entries(KINDS).flatMap(([layer, table]) => Object.entries(table).map(([cls, e]) => ({ layer, cls, ...e })));
/** A point is in a view only if the point is; a line is in every view it crosses. */
const ALONG = new Set(['esriGeometryPolyline']);
const PLACEABLE = new Set(['esriGeometryPoint', 'esriGeometryMultipoint', ...ALONG]);

test('KINDS is not empty and every entry names its source', () => {
  assert.ok(entries.length > 30);
  for (const e of entries) assert.ok(e.source, `${e.layer}/${e.cls} (${e.kind}) names no source`);
});

test('every kind has a registry source that can place it inside a view it crosses', () => {
  for (const e of entries) {
    const src = SOURCES[e.source];
    assert.ok(src, `${e.kind}: source ${e.source} is not in the registry`);
    const types = (src.layers || []).map((l) => l.geometryType);
    assert.ok(types.some((t) => PLACEABLE.has(t)), `${e.kind}: ${e.source} has no placeable geometry (${types})`);
    if (e.crossing) assert.ok(types.every((t) => ALONG.has(t)), `${e.kind} must be placed along a line, ${e.source} offers ${types}`);
    assert.ok(src.zoomRange && Number.isFinite(src.zoomRange.min), `${e.source} declares no zoomRange`);
    assert.ok(src.zoomRange.min <= e.minZoom && e.minZoom <= src.zoomRange.max, `${e.kind}: minZoom ${e.minZoom} outside ${e.source} zoomRange ${JSON.stringify(src.zoomRange)}`);
  }
});

test('river and creek are placed along a stream line, not at a mouth point', () => {
  for (const kind of ['river', 'creek']) {
    const e = entries.find((x) => x.kind === kind);
    assert.ok(e, `${kind} missing from KINDS`);
    assert.equal(e.source, 'nhdFlowlines');
    assert.equal(e.crossing, true);
  }
});

test('every kind in KINDS has an icon entry', () => {
  for (const e of entries) assert.ok(NAME_ICON_BY_KIND[e.kind], `no icon for ${e.kind}`);
});
