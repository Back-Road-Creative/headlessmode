# Address search: provider decision record (QQA-04a)

For the owner. Nothing was purchased and no account or key exists. The evidence is
`data/quiet-corners-maps/geocode-qualification.json`; `qualify-geocoder.test.mjs` fails if a number
below stops matching it. Re-run with `node scripts/qcm/qualify-geocoder.mjs --select --run`.

## Decision asked

Use the **US Census Bureau geocoder** (`geocoding.geo.census.gov`, benchmark `Public_AR_Current`) for
address search on the Quiet Corners map, reached only through the same-origin function
`GET /api/geocode` (`static/functions/api/geocode.js`).

| | |
| --- | --- |
| Cost | Free. No account, no key, no sign-up, so nothing in SOPS and nothing in browser code. |
| Hosting | Cloudflare Pages Function at `/api/*` only (`static/_routes.json`); every other request stays a static file. |
| Match class | Always "interpolated". The UI must say "estimated along the street, not a doorstep". |

## Why a function

Census sends no `Access-Control-Allow-Origin` header (the fixture's `_captured` field records the header read of 2026-10-08;
the dispatcher's brief reports the same for an OPTIONS preflight, which I did not repeat), so a
browser on headlessmode.com cannot call it. Its JSONP mode would run census.gov script inside the page,
which the site's content policy is built to keep out. The relay keeps `connect-src 'self'`.

## Cloudflare runtime compatibility

The upstream fetch uses `redirect: 'manual'`. Workers supports `manual` and `follow`,
but throws immediately for `error`, even though Node accepts that mode
([Cloudflare Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/)).
The relay rejects every status except 200 (with a separate 429 response), so a redirect
is rejected without forwarding the address to its destination. The offline function tests
model the Workers restriction and exercise 301, 302, 303, 307 and 308 responses.
They do not substitute for a deployed-runtime check.

## Terms, read live 2026-10-08

Page: https://www.census.gov/data/developers/about/terms-of-service.html ("Page Last Revised - April 14, 2026").

- Use: "You may use the Census Bureau API to develop a service or service to search, display, analyze, retrieve, view and otherwise "get" information from Census Bureau data."
- Attribution: "All services, which utilize or access the API, should display the following notice prominently within the application: "This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.""
- Limits: "Your use of the API may be subject to certain limitations on access, calls, or use as set forth within this Agreement or otherwise provided by the Census Bureau." Their right to block follows.
- Identification: users "will not use these data ... to identify any individual person, household, business or other entity".
- Storage and caching of results: the page says nothing. The function stores and caches nothing anyway.

**Not verified:** whether these Data API terms govern the geocoder. The geocoder documentation pages I read
(https://www.census.gov/programs-surveys/geography/technical-documentation/complete-technical-documentation/census-geocoder.html
and https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html, "Last updated 02/2026") do not mention
these terms, a rate limit, or a usage policy. Showing the attribution notice costs one line, so the safe course
is to show it beside address results, and the map now does (see "Shown" below).

## Shown (QQA-04c)

The attribution sentence above is shown verbatim: `CENSUS_NOTICE` in
`themes/headlessmode/static/js/quiet-corners-maps/search-shell.js`, written into `#qc-census-credit` inside the
finder box by `quiet-corners.js`. It appears with street-address matches, with the no-match sentence and with the
unavailable sentences (429, 502, 504, slow, offline, endpoint missing). It never appears with a town, a named place
or a coordinate result, because those do not come from the Census geocoder. The box is capped to the room the stage
has left and scrolls the rest, so on a short stage the notice is reached by scrolling and not clipped.
`finder-geocode-browser.test.mjs` checks all of this, including that the notice is at least 12px and 4.5:1.
The wording of the Data API terms still stands as the only source for the sentence; whether they govern the
geocoder stays unverified, so the line is kept as the cautious course and not as a finding.

## Privacy

A typed address goes from the reader's browser to headlessmode.com, then from the function to the Census
Bureau, with none of the reader's headers or cookies. The function has no log call, no storage and no cache,
never puts the query in a response body, and drops the cookie Census sets. What Census does with a request on its side is not stated on the pages I read; the privacy page says the
search goes to the Census Bureau and is under its own terms. Queries are not put in
shared links (the search box unit owns that). Cloudflare, the host, sees the request as it sees every
request (the privacy page's Hosting section).

## Rural measurement (run 2026-10-08)

Corpus: 40 public buildings, 20 county courthouses and 20 post offices, from the USGS National Map Structures
service (https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer, layers 40 and 38; the
service says "Data Refreshed October, 2026"). Rural means a county with RUCC 8 or 9 in
`static/data/quiet-corners/counties.json` (the repo's own value; not re-checked against USDA here). The pick is a fixed hash order, at most two per state; 24 states appear. All 40 published points are
typed "Centroid" by USGS, so each distance includes the gap between a building's centre and the street segment
Census uses. Queries went one per second through the function itself, live.

| | |
| --- | --- |
| Matched | 33 of 40 (82.5%): courthouses 17 of 20, post offices 16 of 20 |
| Errors (429, 502, 504) | 0 |
| State agrees on a match | 33 of 33; ZIP agrees 33 of 33 |
| Distance from the published point | median 50.2 m, p90 90.1 m, max 299.5 m; 31 of 33 within 100 m, none over 1,000 m |
| Not found | Burt County Courthouse NE, Charlotte County Courthouse VA, Pope County Courthouse IL, Saint Catharine PO KY, Lynco PO WV, Roscoe PO MO, Swink PO OK |

Percentiles are nearest-rank. The evidence file holds the second of two runs the same evening; the first was
discarded because its ZIP check wrongly failed on ZIP+4 values, and I did not compare its matches with this one.

## Known gaps

- **Seven of 40 had no match.** The cause of each was not diagnosed; the run asked once per building.
- **PO box and rural route:** not exercised. The source held none among its 6,771 rural candidates (6,713 street
  numbers, 58 with no number), so no number here speaks for them. Census address ranges cover street addresses.
- **New construction:** not measured. The ranges are TIGER's, so an address newer than them will miss.
- **Reach:** the function drops points outside a coarse US box, which excludes Guam, American Samoa and the Northern
  Marianas (a comment in the function says Census answers for them; I did not query them).
- **Deployment verification:** after deploying, submit a known public address through `/api/geocode`,
  check for a 200 JSON response and the expected match, and select that match on the map.
  Passing Node tests or checking the prompt while typing does not verify the hosted lookup.
  Inspect the Function event's response status: an `ok` execution outcome can still return an HTTP error.
- **Alternatives:** the plan's earlier Geoapify proposal was not re-evaluated (its terms, cost and key are your
  decision, and nothing was bought), and no other provider was measured.
