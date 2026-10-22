# Camera source ledger: intake report

Companion to `camera-source-ledger.json` (the data) and `camera-source-ledger.test.mjs` (the check that holds both in place). Read as of **2026-10-08**. Unit QQA-17a of the Quiet Corners quality plan, section 4.6. This is a document: no source was enrolled, no refresh was run, no product code was touched.

How to read the ledger:

- **Merged** rows are exactly the provider ids the merged code knows (the test derives that list from the code, so a new provider without a row fails the test). **Pending** rows are sources in open PRs; none are pending now (#687 adds only a pin colour, so it adds no source). **Candidate** rows are the section 4.6 expansion paths, not yet built. **Rejected** rows are sources left out, with the reason.
- **Coverage** is a camera count measured from the committed seed (or the PR head for pending rows), never a state bounding box.
- **Rights** is a line quoted from the operator's own page with its URL and the date read (2026-10-08), or exactly `unverified`. Most operator pages are script-built and returned no usage line to a plain read; those pages are listed under `rightsPagesReadWithNoUsageLine` in the JSON. A quote here is the operator's site-wide statement unless the row says otherwise; none of them is a licence for the camera pictures in particular, and the committed seed files still say `unverified`.
- **Capture time** is `no` for every row, because no source publishes a per-image capture time it can vouch for (Caltrans's `recordTimestamp` was disproved as one). The format is no longer the limit: snapshot schema 2 (QQA-17b) can carry `bearing`, `capturedAt`, `validUntil` and `precision`, and `parseIsoTime` / `parseBearing` in `source-camera.js` are the one parser an adapter uses when a source does. A row flips to `yes` only when its adapter maps a real field through them.
- **Last qualified** is the build date of the committed seed, the last time the source was fetched and passed the build's gates. It is not a fresh probe.
- The plan's purpose set (roads, scenery, water, weather-aviation, wildlife, science) has no fire value. HPWREN and AlertWest are fire-detection networks and are filed under `science`.

## What the merged sources give today

| purpose and picture | cameras | where |
| --- | --- | --- |
| roads, with a picture | 12,123 | 18 sources: Caltrans (3,591), Virginia (1,656), Minnesota (1,458), Oregon TripCheck (1,131), Utah (1,121) and the rest |
| scenery, with a picture | 8 rows, 5 distinct cameras | `nps-webcams` (3) and `nps-grsm` (5) are the same Great Smoky Mountains cameras: measured, 3 pairs lie within 150 m. 3 are active; 2 are inactive, and 2 have no position |
| science, link only (no picture) | 574 | `hpwren` (55 sites) and `alertwest` (519) |
| science, with a picture | 721 | `phenocam` (#835, 494): ecosystem research sites; `volcview` (#711, 227): volcano cameras |
| weather-aviation, with a picture | 107 | `aviationwx` (#835): small-airport weather views |
| water, with a picture | 35 | `glerl` (#711): Great Lakes lighthouses, piers and stations |
| wildlife | 0 | no merged source |

Road cameras are 12,123 of the 12,994 merged rows that carry a picture, and sit on highways and city streets. For a rural or scenic view the merged stack has 3 active pictures. That is the gap everything below is ranked against.

Measured duplicates: `or-salem` and `or-tripcheck` share 15 cameras within 150 m. No other pair of merged sources lies within 150 m.

## Ranked gap list

Ranked by useful views in rural and scenic areas (a picture a person can read, away from a highway interchange), not by pin count.

1. **The science and water stack: `volcview`, `glerl`** (merged with #711; `phenocam` and `aviationwx` merged with #835). 227 + 35 = 262 pictures, mostly research, wildland or remote sites (not measured site by site). Adds: volcanoes, Great Lakes shores. Open: GLERL's site-wide disclaimer allows copying and asks for a photo credit.
2. **National park webcams beyond the Smokies: `nps-webcams`.** The adapter already reads the nationwide NPS list, yet the committed seed holds 3 cameras, all in North Carolina. How many a nationwide refresh would add was not measured. Blocks: a refresh needs the free `NPS_API_KEY` and the manual `--refresh-seeds` step; the NPS site-wide statement is "generally considered in the public domain" but says third-party material is not.
3. **Mountain road cameras: `co-cotrip`** (merged with #709). 563 pictures across Colorado, thinned to one per 0.025 degree cell (about 2.8 km). Open: the COtrip page returned no usage line on 2026-10-08, so its rights stay unverified.
4. **USGS river cameras, starting with `usgs-oconaluftee-03512000`.** The catalogue lists 351 USGS webcams (`usgs-webcams`). Adds water views that no other source gives. The Oconaluftee page states "Public Domain" and links a live picture, but gives no camera coordinates and no credit line; a gauge position is not a camera position. Blocks: a reviewed per-camera allowlist and coordinates read from each camera's own page.
5. **Wildlife: no source.** No row has the `wildlife` purpose and no owner-published wildlife camera catalogue was identified in this review. Blocks: someone names an operator; destination submissions (`destination-submissions`) are the only route in the plan.
6. **Link-only road pins: `modot`, `mdchart`, `deldot`, `nmroads`, `njta`** (#692). 2,086 pins that link to the operator's page with no picture. Low value per pin for a rural user; ranked below pictures on purpose.
7. **`faa-weather-cameras`.** Aviation weather views away from roads. Blocks: no list or reuse contract is established, and the site refused an automated read (HTTP 403) on 2026-10-08.
8. **`wa-kirkland` and `wa-wsf`** (merged with #710). 8 city cameras and 44 ferry terminals: useful in place, small in reach. Open: WSDOT's reuse wording is the PR author's reading and was not re-read.
9. **`windy-webcams`.** Broad scenery through one keyed service, but it republishes other people's cameras, so it fails the owner-published rule unless the owner's terms are found camera by camera. Blocks: a paid-key decision, the visible credit it requires, and QQA-15 embed support.
10. **`official-open-data-catalogues`.** A route, not a source: new DOT and city layers through the adapters that already exist. Blocks: the reviewed-item-id allowlist; ArcGIS search order is not stable.

## Candidates: what each would add, what blocks it

| id | would add | blocks | owner |
| --- | --- | --- | --- |
| `usgs-webcams` | 351 webcams listed on the USGS catalogue page on 2026-10-08 (river and streamgage, volcano, hot spring); not yet counted by state, so no coverage claim | candidate: needs a reviewed per-camera allowlist and each camera's coordinates from the camera page, not the gauge | QQA-17b |
| `usgs-oconaluftee-03512000` | 1 camera, Oconaluftee River at Birdtown, North Carolina, beside the 3 NPS cameras of the Smokies seed | candidate: camera coordinates and a stable picture address are missing; the first single-camera trial for the allowlist route | QQA-17b |
| `faa-weather-cameras` | not measured; no list or count has been read | candidate: the media reuse contract is not established; keep distinct from AviationWX | QQA-17b |
| `windy-webcams` | not measured; aggregates cameras owned by others worldwide | candidate: not owner-published (Windy lists other people's cameras); needs QQA-15 embed and stream support and a paid-key decision for the owner | QQA-15 |
| `official-open-data-catalogues` | not measured; each operator is measured when its layer is reviewed | candidate route, not a source: "the order of results may vary each time a search is performed" (ArcGIS search reference, read 2026-10-08), so an allowlist of reviewed item ids is the only safe form | QQA-17b |
| `destination-submissions` | not measured; no submission has been received | candidate route, not a source: record precision, credit and allowed behaviour per submission, then review before publication | QQA-17b |

## Pending sources (open PRs, read only)

None: `volcview` and `glerl` merged with #711.

## Merged sources

| id | cameras | purpose | media | rights | health |
| --- | --- | --- | --- | --- | --- |
| `nps-webcams` | 3 cameras | scenery | still | quoted | active (3 of 3) |
| `nps-grsm` | 5 cameras | scenery | still | quoted | 3 active, 2 inactive |
| `caltrans-cwwp2` | 3591 cameras | roads | still | quoted | 3395 active, 196 inactive in the seed |
| `hpwren` | 55 cameras | science | link-only | unverified | active (55 of 55) |
| `alertwest` | 519 cameras in 10 state files; Hawaii 183 | science | link-only | unverified | active (519 of 519) |
| `volcview` | 227 cameras (223 in `us`, 4 in `ak-west`) | science | still | quoted | active (seed keeps only pictures under a day old) |
| `glerl` | 35 cameras | water | still | site-wide disclaimer: may be copied, credit requested | active (seed keeps only pictures under a day old) |
| `ky-kytc` | 233 cameras | roads | still | unverified | active |
| `tx-arlington` | 56 cameras | roads | still | unverified | active |
| `ks-lawrence` | 65 cameras | roads | still | unverified | active |
| `or-salem` | 16 cameras | roads | still | unverified | active |
| `or-tripcheck` | 1131 cameras | roads | still | unverified | active |
| `ut-udot` | 1121 cameras | roads | still | unverified | active |
| `mn-511` | 1458 cameras | roads | still | unverified | active |
| `in-511` | 722 cameras | roads | still | unverified | active |
| `ks-kandrive` | 227 cameras | roads | still | unverified | active |
| `wa-srtmc` | 119 cameras | roads | still | unverified | active |
| `va-vdot` | 1656 cameras | roads | still | unverified | active |
| `sd-sddot` | 175 cameras | roads | still | unverified | active |
| `tx-austin` | 820 cameras | roads | still | unverified | active |
| `la-batonrouge` | 118 cameras | roads | still | unverified | known follow-up: pictures on 511la.org can be the offline stand-in image; the stand-in is not detectable at refresh time (QQA-10 follow-up) |
| `modot` | 877 cameras | roads | link-only | unverified | merged by #692; not yet measured in a deployed build |
| `mdchart` | 529 cameras | roads | link-only | unverified | merged by #692; not yet measured in a deployed build |
| `deldot` | 361 cameras | roads | link-only | unverified | merged by #692; not yet measured in a deployed build |
| `nmroads` | 183 cameras | roads | link-only | unverified | merged by #692; not yet measured in a deployed build |
| `njta` | 136 cameras | roads | link-only | unverified | merged by #692; not yet measured in a deployed build |

Health notes carried from the acceptance follow-ups (the plan's follow-up table): Baton Rouge's picture host can serve an offline stand-in image (`la-batonrouge`), the NDBC buoy cameras answer 403 (`ndbc-buoycam`), the Alaska panhandle polygon has gaps near Prince Rupert, Masset and the Tatshenshini (no live camera sits there today), and YouTube nocookie embeds belong to QQA-15. Caltrans' own page says its "traffic camera video footage and still images are neither retained nor archived", which is about retention, not reuse.

## Rejected

| id | why | rights |
| --- | --- | --- |
| `sc-scdot` | the operator's disclaimer forbids republishing its content without written permission | quoted |
| `king-county-wa` | the county's terms forbid publishing or displaying its content without written permission | quoted |
| `lexington-ky` | the city's terms ban copying without written permission (#710 author's reading, 2026-10-05); the page text could not be re-read on 2026-10-08, so rights stay unverified | unverified |
| `mt-mdt` | the operator's terms forbid redistribution without MDT's written permission (reading recorded in source-camera.js, 2026-10-04; not re-read on 2026-10-08) | unverified |
| `ga-511` | pictures sit on an IBI 511 host whose "no image" stand-in comes and goes per camera within minutes, and the host answers 429 to one paced client (#709 note, 2026-10-05) | unverified |
| `ndbc-buoycam` | the picture host answers 403 to the build's honest user agent; the build will not imitate a browser (#711 note); deferred until NOAA allows the agent or publishes an API | unverified |

Also left out in the merged code and open PR notes, with no row because the record names no page address for them: Iowa DOT (its terms forbid copying and republishing without written consent, and its picture path is a dated per-snapshot address); 511NY, NYSDOT, NYS Thruway, ACHD and NDDOT (no terms text, or robots.txt blocks the whole site); WV511 (its disclaimer forbids republishing); Hawaii (the only list is a demo layer published by Esri staff); Alaska road-weather cameras (the pictures rotate); Beaufort (its picture host does not resolve and is http only); Louisiana DOTD (streams and page links only). These are other authors' readings, recorded in `source-camera.js` and in the PR descriptions, and were not re-read here.

## Review checklist for adding a source

Every new source passes all of these before it gets a `merged` row. They come from plan section 4.6.

1. **Allowlisted catalogue items.** The operator and each catalogue item id are named in a reviewed list. No runtime search, no wildcard, no "everything the portal returns".
2. **Owner-published only.** The camera belongs to the operator whose page is credited. A site that republishes other people's cameras needs each owner's terms, or it is rejected.
3. **Rights line.** A usage line quoted from the operator's own page with its URL and the date read, or exactly `unverified`. Never a blanket claim, never a licence inferred from a site-wide footer.
4. **A bounded metadata job that produces a reviewable diff.** Discovery runs as a build-time job over approved catalogues, with page and size budgets, and its output is a diff a person reads before it lands.
5. **It never publishes silently.** The job writes a proposed change; a person merges it.
6. **Builds never refresh images.** A normal build reads committed seeds. Seeds refresh only under `--refresh-seeds`; pictures are loaded by the visitor's browser from the operator's host, and only hosts registered for the feed are allowed.
7. **Keep the last good catalogue after an outage.** A failed or empty fetch leaves the previous file in place; it never replaces a good catalogue with a smaller one.
8. **Honest agent and pacing.** The build identifies itself with its own user agent, paces its requests, and does not imitate a browser; a 403 or 429 means the source waits.
9. **Measured coverage and health.** Count what the seed holds and what is usable; record stand-in images, inactive cameras and duplicates (distance and shared id) against existing rows.
10. **Schema fit.** Schema 1 carries a still, a name and an exact position; schema 2 adds, only when a record needs them, a bearing, a capture time, an expiry and an approximate position (`camera-snapshot.js`). Anything beyond those (streams, embeds) waits for the next version, not a quiet workaround. A source that publishes a capture time, direction or expiry maps it through `parseIsoTime` / `parseBearing`; a value the source does not publish stays `null`, never a guess.
11. **Ledger row and owner.** The source gets a row in `camera-source-ledger.json` with every field, an owner unit, and the test passes.
