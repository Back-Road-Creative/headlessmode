// NIFC WFIGS fire perimeters: the four measured facts that make this layer honest or dangerous.
//
// ONE, the outage: 188 national polygons measured 37,342,814 bytes unsimplified and the
// transfer FAILED mid-stream, so the query cannot be built without `maxAllowableOffset`.
// TWO, the clock: `poly_PolygonDateTime` is when the boundary was MAPPED -- median 21.9 days
// old, 19 of 188 null, ONE dated the year 0926, which naive arithmetic renders as 401,770 days.
// THREE, prescribed burns: 4 of 188 are planned fire, and drawing one as a wildfire is a
// factual error. FOUR: `attr_PercentContained` null is "not reported" and never 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-registry.js';
import {
  SERVICE, MIN_OFFSET, offsetForSpan, fireQueryFor, fireQueryUrl, serviceError, mappedMs,
  readPerimeters, containmentText, ageText, summarise, areaReport, readerStrings,
  LAYER_LABEL, LAYER_CAVEAT,
} from '../../themes/headlessmode/static/js/quiet-corners-maps/source-fire.js';

const BBOX = { minLon: -124, minLat: 42, maxLon: -117, maxLat: 46 };
const NOW = Date.UTC(2026, 8, 15, 0, 0, 0);
const DAY = 86400000;

const fire = (props) => ({
  type: 'Feature',
  properties: {
    poly_IncidentName: 'Sand Creek', poly_GISAcres: 35520,
    poly_PolygonDateTime: NOW - 22 * DAY, poly_DateCurrent: NOW - DAY,
    poly_MapMethod: 'Mixed Methods', attr_IncidentTypeCategory: 'WF',
    attr_PercentContained: 40, attr_ContainmentDateTime: null,
    attr_FireDiscoveryDateTime: NOW - 40 * DAY, attr_IncidentSize: 35520,
    attr_POOState: 'US-OR', attr_UniqueFireIdentifier: '2026-ORXXX-000123', ...props,
  },
  geometry: { type: 'Polygon', coordinates: [[[-121, 43], [-120.5, 43], [-120.5, 43.5], [-121, 43]]] },
});
const body = (...features) => ({ type: 'FeatureCollection', features });

test('the measured record says what this source is: an inventory of incidents, not a live fire edge', () => {
  const src = SOURCES.nifcFirePerimeters;
  assert.equal(src.claim, 'inventory');
  assert.equal(src.origin, 'https://services3.arcgis.com');
  assert.equal(src.kind, 'feature-query');
  assert.match(src.coverageSemantics, /prescribed burns/i);
  assert.match(src.coverageSemantics, /not a closure/i);
  // The measurement that forces `maxAllowableOffset` is in the record, not only in a comment.
  assert.ok(src.limits.nationalBytesUnsimplified > 30e6);
  assert.equal(src.limits.requiredMaxAllowableOffsetDegrees, MIN_OFFSET);
  assert.ok(MIN_OFFSET > 0);
});

test('the query cannot be built without simplification, a bbox, and the wildfire filter', () => {
  const q = fireQueryFor(BBOX);
  assert.equal(q.url, `${SERVICE}/query`);
  assert.equal(q.params.geometry, '-124,42,-117,46');
  assert.equal(q.params.geometryType, 'esriGeometryEnvelope');
  assert.equal(q.params.where, "attr_IncidentTypeCategory='WF'");
  assert.ok(Number(q.params.maxAllowableOffset) >= MIN_OFFSET,
    '35.6 MB did not transfer; an unsimplified national payload is an outage, not a slow layer');
  // Twelve fields of 119: the other 107 are personnel counts, costs and fuel models, none
  // of them drawn, and a 119-field record is most of what is not geometry.
  assert.equal(q.params.outFields.split(',').length, 12);
  for (const f of ['poly_IncidentName', 'poly_PolygonDateTime', 'attr_IncidentTypeCategory',
    'attr_PercentContained', 'poly_MapMethod']) {
    assert.ok(q.params.outFields.split(',').includes(f), `${f} is not asked for`);
  }
  assert.doesNotMatch(fireQueryUrl(BBOX), /where=1(%3D|=)1/);

  // A coarser view asks for a coarser shape; it never asks for the published geometry.
  const wide = Number(fireQueryFor({ ...BBOX, minLon: -125, maxLon: -66 }).params.maxAllowableOffset);
  assert.ok(wide >= MIN_OFFSET, 'a continental view must not drop below the measured floor');
  assert.ok(offsetForSpan(0.01) >= MIN_OFFSET, 'even a street-level view keeps the floor');
  assert.ok(offsetForSpan(60) > offsetForSpan(1), 'a wider view is simplified harder');
});

test('a polygon date before 2000 is CORRUPT and reads as unknown, never as 401,770 days old', () => {
  // The record the service itself confirms: `poly_PolygonDateTime` in the year 0926.
  const year0926 = Date.UTC(926, 8, 11, 19, 38, 0);
  assert.equal(mappedMs(year0926), null);
  assert.equal(mappedMs(null), null);
  assert.equal(mappedMs(undefined), null);
  assert.equal(mappedMs(0), null);
  assert.equal(mappedMs(NOW - 22 * DAY), NOW - 22 * DAY);

  const rows = readPerimeters(body(
    fire({ poly_PolygonDateTime: year0926, poly_IncidentName: 'Ancient' }),
    fire({ poly_PolygonDateTime: null, poly_IncidentName: 'Undated' }),
  ), NOW);
  assert.equal(rows.length, 2, 'a boundary with no usable date is still a boundary');
  for (const row of rows) {
    assert.equal(row.mappedMs, null);
    assert.equal(row.ageDays, null);
    assert.match(ageText(row, NOW), /when this boundary was mapped is not stated/i);
    assert.doesNotMatch(ageText(row, NOW), /\b\d{3,}\s*days/, 'a corrupt date must not become an age');
  }
});

test('a prescribed burn is never drawn as a wildfire, whatever the service hands back', () => {
  const rows = readPerimeters(body(
    fire({ attr_IncidentTypeCategory: 'WF', poly_IncidentName: 'Sand Creek' }),
    fire({ attr_IncidentTypeCategory: 'RX', poly_IncidentName: 'Unit 7 burn' }),
    fire({ attr_IncidentTypeCategory: 'CX', poly_IncidentName: 'Complex' }),
  ), NOW);
  assert.deepEqual(rows.map((r) => r.name), ['Sand Creek'],
    'RX is planned fire and CX is an administrative grouping; neither is a wildfire perimeter');
});

test('containment reports what NIFC published, and null is "not reported" rather than zero', () => {
  assert.match(containmentText(null), /not reported/i);
  assert.doesNotMatch(containmentText(null), /\b0\b/);
  assert.match(containmentText(0), /0%/);
  assert.match(containmentText(100), /100%/);
  // Fully contained fires ARE in this layer -- 56 of 188 measured -- so the words must
  // exist rather than the layer pretending they cannot occur.
  const rows = readPerimeters(body(fire({ attr_PercentContained: 100 })), NOW);
  assert.equal(rows[0].contained, 100);
  // attr_ContainmentDateTime was null on all 188 records and is unusable; nothing may
  // build a "contained on" line from it.
  assert.equal('containedMs' in rows[0], false);
});

test('the age of the drawn shape is stated, and the perimeter is never called current', () => {
  const rows = readPerimeters(body(fire({ poly_PolygonDateTime: NOW - 22 * DAY })), NOW);
  assert.equal(rows[0].ageDays, 22);
  assert.match(ageText(rows[0], NOW), /22 days/);
  const at = summarise(rows);
  assert.equal(at.known, true);
  assert.equal(at.oldestAgeDays, 22);
  assert.equal(at.observedMs, NOW - 22 * DAY);
  assert.equal(summarise([]).known, false);

  // Every string EXCEPT the caveat states a finding, and a finding may not turn a mapped
  // boundary into an order about the ground. The caveat is the one place those words are
  // allowed, because there they are a denial.
  for (const s of readerStrings(body(fire({})), NOW).filter((x) => x !== LAYER_CAVEAT)) {
    assert.equal(typeof s, 'string');
    assert.doesNotMatch(s, /evacuat|closure|closed road|safe to|currently burning/i,
      `"${s}" turns a mapped boundary into an order about the ground`);
  }
  assert.match(LAYER_CAVEAT, /mapped/i);
  assert.match(LAYER_CAVEAT, /not legal documents|not a legal document/i);
  assert.match(LAYER_CAVEAT, /closure/i, 'the caveat is where a closure is ruled out, out loud');
  assert.match(LAYER_CAVEAT, /evacuation/i);
  assert.match(LAYER_LABEL, /perimeter/i);
});

test('an error envelope with an EMPTY message still says what went wrong, and is not "no fire here"', () => {
  // Measured on this service: `message` is empty and `details` carries the whole answer.
  const err = { error: { code: 400, message: '', details: ['The requested layer (layerId: 99) was not found.'] } };
  assert.match(serviceError(err), /layerId: 99/);
  assert.equal(readPerimeters(err, NOW).length, 0);
  const failed = areaReport(err, NOW);
  assert.equal(failed.known, false);
  assert.match(failed.text, /could not be read/i);
  assert.doesNotMatch(failed.text, /No mapped fire perimeter/i);

  const quiet = areaReport(body(), NOW);
  assert.match(quiet.text, /No mapped fire perimeter/i);
  const drawn = areaReport(body(fire({})), NOW);
  assert.match(drawn.text, /Sand Creek/);
  assert.match(drawn.text, /22 days/);
});
