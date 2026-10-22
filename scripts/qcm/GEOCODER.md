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
is to show it beside address results. That is a choice for you.

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
- **Deployment:** the Function has run only in tests. Cloudflare compiling `functions/` from the `production`
  branch root, and the function setting its own headers because `_headers` is not documented here to cover Function
  responses, are not verified until the first deploy. The function file is also served publicly as a static file.
- **Alternatives:** the plan's earlier Geoapify proposal was not re-evaluated (its terms, cost and key are your
  decision, and nothing was bought), and no other provider was measured.
