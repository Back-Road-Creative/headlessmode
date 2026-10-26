// QQA-03b: the finder's pure "is this a street address?" detector.
//
// The dashboard finder searches a town list, a GNIS name list and coordinates. It had
// no street-address geocoder (QQA-04b added one; geocoding is tested in
// address-geocode.test.mjs), so a typed address used to fall through to the town miss: 'No town matching "<address>" is
// in this list.' -- a sentence that calls a street address a missing town. The
// browser proof (finder-address-browser.test.mjs) holds what the reader is told;
// this file holds the line between an address and everything else the box accepts.
//
// Fixtures are synthetic. The owner's real address stays out of the repo
// (plan section 4.2 / QQA-00); every address below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeStreetAddress, ADDRESS_UNAVAILABLE_MESSAGE } from
  '../../themes/headlessmode/static/js/quiet-corners-maps/search-shell.js';

const ADDRESSES = [
  '1234 Example Rd, Hamilton, MT 59840',
  '1234 example rd, hamilton, mt 59840',
  '12 Main St Apt 4',
  '12 Main Street, Unit 3B',
  '88 Quarry Lane',
  '4021 N. Sample Hwy 93',
  '17 Orchard Ave #5',
  '500 Old Mill Trail, Ashland WI 54806',
  '9 County Road 12',
  '221 Elm Ct.',
  'PO Box 123',
  'Apt 4',
  'Suite 200',
  '59840',
  '59840-1234',
  'Hamilton, MT 59840',
  'Hamilton MT 59840',
  // QQA-03c: the shapes the tighter detector must keep. Invented numbers; the
  // last is the White House's public street address, a landmark and not a household.
  '123 Main St',
  '45 Oak Avenue, Sylva NC',
  '1600 Pennsylvania Ave NW',
  'Unit 4',
  'Apt. 4B',
  '12 Main, Apt 4',
  '12 Main #5',
  // A unit or a name written before the house number is still a household: the
  // street part may start any comma-separated piece, not only the first.
  'Apt 4, 12 Main St',
  'Unit 3B, 4410 W 8 Mile Rd',
  'Smith Farm, 12 Main St',
  'Suite 200, 1600 Pennsylvania Ave NW',
  'Smith Farm, 12 Main, Apt 4',
  // Rural house numbers and numbered highways also need the address geocoder.
  'N1234 County Road B, Example, WI',
  'W123N456 Main St, Example, WI',
  '123 Highway 64, Example, NC',
  '123 US Highway 14',
  '123 State Route 9',
];

const NOT_ADDRESSES = [
  // Plain towns, with and without a state.
  'Amery',
  'Ashland, IL',
  'Banner Elk',
  'Cold Mountain',
  // Coordinates are their own path and are checked before this one.
  '34.5, -83.2',
  '34.5 -83.2',
  '45.30459,-92.363356',
  // Names with leading digits that are places, not street numbers.
  '29 Palms, CA',
  '7 Mile',
  '100 Mile House',
  '3 Rivers, MI',
  '1000 Islands',
  '10th Street Park',
  // A road name with no house number is a named feature, not a household.
  'Rock Bridge Rd',
  'Highway 64',
  // A unit word that is part of a name, not a unit number.
  'Unit Lake',
  // QQA-03c: real place, feature and road names carry digits, '#', 'Unit', 'No.' and
  // route numbers. None has a house number in front of a street word, none ends in a
  // ZIP, so none is an address -- the finder must search them by name.
  'Lake Unit 4',
  'Springfield #2',
  'Springfield # 2',
  'Highway 441',
  'Forest Road 4652',
  'Mile 10 Overlook',
  'Camp No. 7',
  'Route 66 Diner',
  'Unit 4 Lake',
  'Lake Apt 3',
  'Pond Suite 2',
  'Township Road 12 Access',
  'US Highway 14',
  'State Route 9',
  'N1234 Mountain',
  // A number, then "Mile", then a road word is a mileage name ("7 Mile Rd"), not a house.
  '7 Mile Rd',
  '10 Mile Creek Road',
  // Too short or empty.
  '',
  '  ',
  '4',
  '1234',
];

for (const a of ADDRESSES) {
  test(`reads ${JSON.stringify(a)} as a street address`, () => {
    assert.equal(looksLikeStreetAddress(a), true);
  });
}

for (const n of NOT_ADDRESSES) {
  test(`does not read ${JSON.stringify(n)} as a street address`, () => {
    assert.equal(looksLikeStreetAddress(n), false);
  });
}

test('non-strings never throw and are not addresses', () => {
  for (const v of [null, undefined, 0, {}, []]) assert.equal(looksLikeStreetAddress(v), false);
});

test('the unavailable message is plain, names what works, and never calls an address a town', () => {
  // QQA-04b: the lookup exists now, so this is what a failed lookup says (outage,
  // timeout, 404), not "not available yet". The alternatives it offers are unchanged.
  const m = ADDRESS_UNAVAILABLE_MESSAGE;
  assert.match(m, /address lookup/i);
  assert.match(m, /unavailable right now/i);
  assert.match(m, /town/i);
  assert.match(m, /named place/i);
  assert.match(m, /coordinates/i);
  assert.match(m, /latitude, longitude/i);
  assert.match(m, /map/i);
  assert.doesNotMatch(m, /no town|is in this list|matching|not found|no names|not available yet/i);
});
