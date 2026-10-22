---
title: "Quiet Corners"
description: "Find the quiet corners of America that are staying quiet — and are likely to keep staying quiet. Census-driven rural stability and affordability analysis."
date: 2026-07-30
draft: false
layout: quiet-corners-dashboard
tags: ["data", "census", "rural", "maps"]
---

## The quiet corners of America

Quiet Corners scores rural U.S. counties on stability, remoteness, sprawl risk and
affordability, and surfaces the ones that are staying quiet and are likely to keep
staying quiet. The methodology below sets out how stability, remoteness and sprawl risk
are computed and how they roll up into the overall score, and the data trust model names
the source behind each input. The dashboard below is public and free to use in your
browser — no account, no signup.

Every data point comes from the U.S. Census Bureau or USDA, with one disclosed
exception: interstate proximity (30% of the sprawl-risk composite, below) is measured
against a hand-maintained waypoint list, not a government dataset. No commercial APIs,
no scraped listicles, no vibes.

Open **Explore**, at the top of the panel column beside the map (under the map on a
phone), to filter counties by stability, remoteness, sprawl risk
or overall score. The same panel holds the results table, so the counties that match are
right there below the filters.

---

## Methodology

Independent scores, each 0-100:

**Stability** — Coefficient of variation (Bessel-corrected) plus linear regression slope
across 5 years of population estimates. Low CV + flat slope = high stability. Weighted
60/40 CV-to-slope.

**Remoteness** — Great-circle distance from county centroid to nearest city with
population over 25,000. Uses the full Census place gazetteer — capturing regional hubs,
college towns, and county seats that rural residents actually drive to. The pipeline
exports this as raw miles (`distance_to_metro_mi`), not a normalized 0-100 score; the
dashboard's Remoteness filter slides across that raw distance, up to 250 miles,
and slides all the way down to **Any**, which switches it off: a county ten miles
from a small city can be as quiet as one ninety miles out, and a county whose
distance was never computed is not evidence that it is close to anything.

**Sprawl Risk** — A five-factor composite, all five live on this run: interstate
proximity (30%), building permit trend (25%), state migration acceleration (20%),
fast-growing metro proximity (15%), and recreation/retirement county typing (10%).
Lower is better. Permits and metro proximity used to be dead — the Census API retired
both endpoints — and are now read from the keyless bulk files on www2.census.gov
instead (Building Permits Survey county annual files; PEP subcounty estimates).

A county missing an input is scored over the factors it does have, with the remaining
weights renormalized, so a gap cannot quietly deflate a score toward "no sprawl risk".
A factor that scores 0 *from real data* still counts at full weight.

The trust panel on the dashboard lists, per factor, how many counties it scored above
zero on the run that produced this page — read from the data, so it stays true across
regenerations. Those counts are not coverage rates. A factor reads 0 both when its
input is missing and when the county genuinely has no pressure from it: most rural
counties carry no USDA recreation or retirement type at all, migration scores 0 for
every state whose inward flow is flat or falling, and a county more than 100 miles from
an interstate scores 0 there by construction. Permits are the one factor where a low
count is partly a real gap — many rural counties have no usable multi-year permit
series in the survey's county files.

**Overall** — Quietness 55% and Affordability 45%. Quietness is itself stability 40%,
remoteness 30%, and inverted sprawl risk 30%. Both levels renormalize over the inputs a
county actually has, and a county with nothing scoreable gets no score rather than a
zero. Livability was removed: it returned the affordability score verbatim, which
double-weighted affordability while advertising a dimension that did not exist.

Counties must have a USDA Rural-Urban Continuum Code of 6 or higher (nonmetro with urban
population under 20,000) to appear in results. Within qualifying counties, **candidate
towns** (incorporated places with population 1,000-3,000) are surfaced with scores
inherited from their parent county.

---

## Reading the map

The county shading and the map key show **one** measure at a time, and the
**Color the map by** control chooses which: Stability, Overall, Quietness,
Affordability, or plain miles to the nearest city. The key relabels itself in
that measure's own units — a distance key reads in miles, not on a 0–100 ramp —
and outlines and dot sizes follow the same bands, so the map is never colour
alone. It is separate from how the tables sort (Overall for counties, Stability
for candidate towns); changing the colour changes no filter and drops no row.
A county whose value was never computed is drawn in its own grey and listed as
**Not measured**, rather than shaded into the bottom band where a gap in the
data looked like a low result.

The map names two kinds of place. The towns it scores come from the candidate export, and they are small by definition — so the country-wide view also names the large places you would orient by, from a separate list of 347 cities that exists only to say where the small towns are. Those names are capped so they frame the map rather than fill it, and they carry the everyday form of the name rather than the Census one.

Each table says what it is ranked by, in words — *Sorted by Overall, highest
first* — and the heading it names carries a caret and an underline, not just a
colour. The county table and the candidate towns below it sort independently,
and neither follows the map's colour. One line above the tables says all three
at once — *Map color: Stability · County sort: Overall · Town sort: Stability* —
because Stability is a component of Overall rather than a rival ranking of it, so
a county can shade dark on the map and still sit low in the table. It is written
from the live selection and follows every change you make to it.

The page sets figures and words in different faces on purpose. The score columns
stay monospace, because seven columns of digits only line up when every glyph is
the same width. Everything you read rather than compare — filter labels, column
headings, the map key, the sentences above the tables and the provenance line
under the title — is in the ordinary interface face, and the county's own name is
the largest thing in its row.

On a phone each row becomes a card instead of a table line, and every measure comes
with it. The tables used to drop affordability, remoteness and sprawl below 1024px
while the filters that set them stayed — so the figure you had just filtered on was
the one off screen. Each value now carries the column heading beside it, read from
the table's own header, so a card can never label a number with the wrong measure.

**Share view** copies a link to exactly what the map is showing now — center,
zoom, base layer, surface and any active overlays — as a `#map=` fragment in the
URL, so pasting it elsewhere reopens the same view. The address bar keeps that
fragment in sync as you pan and zoom once a shared link has been opened, and the
browser's back and forward buttons move through those views. **Reset view**
clears the map back to its default and forgets your saved base-layer choice; it
never touches a print recipe, a saved print project, a chosen area, or your
saved places — those belong to the Field Maps builder or live independently of
any view reset.

**Saved places** lets you bookmark a named place from its details card and
keep it in a list you can revisit, right in your browser. It sits with
tonight's sky and forecast below the map, and carries its own Download,
Import and Clear controls; it never affects a shared link, a print recipe,
or a saved print project. A road or park camera's card has a **Save camera**
button too: it keeps only the camera's name, the operator and its position,
never a picture or a stream address. **Show** on a saved camera turns that
camera's layer on and opens its card; if the operator's current list no longer
carries it, the row says so and opens nothing. A saved camera with no
position (an imported list can carry one) stays in the list but cannot be shown
on the map or checked for conditions, and says why. Cameras have no Share button.

**Conditions** answers what the sky and the forecast do at the exact place
you last picked — a county, a town, or a named summit, gap, ridge or
populated place. Asking is explicit: opening a named place's details card
never starts a request on its own, and its card's own **Before you go**
button — also offered on a saved place's row — is what asks. A **Conditions
for** header above tonight's sky, the forecast and the alerts names the place
and states what each of the three sources actually covers: the Sun and Moon
are calculated for that exact point; the forecast is the National Weather
Service's value for the grid cell that contains the point, not a reading at
the point itself, with a further note on a summit, ridge or gap that the
cell's one value is not a measurement on the feature; and the alerts are the
Weather Service products whose area covers the point. Opening a different
place's card while an earlier place's conditions are still on screen asks
nothing new — the header instead says whose conditions those still are, so
you never read one place's weather under another's name.

Under the alerts, **Cameras nearby** lists the road or park cameras within 25
km, straight-line, of the place you asked about — but only cameras from a layer
you have already turned on in the Field Maps panel. It never turns a layer on
and never asks a camera operator for anything by itself; pressing a camera's
name is what opens its card on the map. A camera 25 km away is not the same
weather across a ridge, and the list says so.

The same map carries the [Field Maps](/quiet-corners/maps/) builder's Layers panel — base map choice, a names-and-search layer, a Places in this view list, display controls, and a set of starting presets, one of which, **Compare counties**, turns on this page's own county-ranking wash (off by default) through the same switch the Layers panel's **Land, sky & light context** group already uses for every other context surface: there is no separate toggle for it. Undo and Reset sit beside the presets for backing a shortcut out again. See the Field Maps page for the full list and what each one moves.

On a wider screen the four panels — Explore, Conditions, Layers and Print — sit in one column to the left of the map, one open at a time, so none of them ever covers the map; the column is the same width whichever panel is open, so the map never shifts under you, and Explore's county and town tables show each place as a small card with every figure labelled instead of a wide table. On a phone, opening any panel — Explore, Conditions, Layers or Print — opens it in a sheet under the map instead of over it, so the map stays visible and never blank. Drag the sheet's handle up or down, or use its Expand/Shrink button, to see more of the panel or more of the map; Close or Escape returns you to whichever control you opened it from.

**Use my location** takes one click and asks your browser for your position
exactly once — it never watches your location in the background. Nothing about
that fix is stored: not in the address bar, not in your browser's saved
preferences. If the fix is inside the area this map covers, the map pans and
zooms to it and drops a marker with an accuracy circle, both held only in memory
for that visit. A location-derived view is left out of a shared link unless you
explicitly tick "Include my location in the link" first; Share view's status
line says whether it was included. Finding your location still means asking the
map's tile provider for the area now on screen, the same request any pan or
zoom already makes.

**Search places** matches as you type, against the same town export the map
scores. Typing a coordinate pair instead jumps straight to it. Neither reaches
outside your browser — both search a list already on the page. The box, its
suggestions, its notes and its **Search** button share one solid panel, so no
map label shows through the text. Type a street address (a house number and street,
a lone apartment or unit, or a ZIP code) and nothing is sent while you type: the box
says to press **Search**. Pressing **Search** (or Enter) then sends what you typed,
through this site, to the U.S. Census Bureau's address geocoder, and lists up to five
street matches under "Street addresses (estimated)", each marked "estimated along the
street, not a doorstep": the point is interpolated along the street's address range,
never a household. Picking one moves the map there and the conditions heading names
the matched address followed by "(street estimate)"; like picking a county or a town, it
asks the National Weather Service for the forecast and alerts at that estimated
point, rounded to four decimal places. When no street matches, it says so, asks you
to check the spelling, and offers a town or named place, coordinates as latitude,
longitude, or dragging the map to the spot. When the lookup is unavailable (the service
is down, busy, slow past ten seconds, or you are offline) it says address lookup is
unavailable right now and offers the same alternatives. A place already in the town list
wins, and then nothing is sent. A newer search cancels an older one and a late answer
is dropped. The typed address is never written to the page's link, a shared link, saved
views, browser storage, the page title or analytics. A name that only looks like an
address ("Lake Unit 4", "Highway 441") is searched like any other name, and an address
never reports a missing town or swaps in a nearby one.
**Search** is the second, explicit search you ask for with its own
button or by pressing Enter with no suggestion highlighted, and it asks the
U.S. Geological Survey's own gazetteer (GNIS) for named summits, gaps, ridges
and populated places by name — up to 80 characters, optionally narrowed to a
state the way "Ashland, IL" narrows a town search. A result too broad to list
in full says so and asks you to narrow the name or add a state, rather than
claiming there were no matches. A geographic name in the results carries a
badge naming its kind — Summit, Gap, Ridge/range and the rest — alongside its
state and county, right in the merged list with the towns and coordinates, so
a peak reads as a peak before you open it. Picking one moves the map to a view
sized for what it is and opens the same details card a map pin opens, naming
it, its kind, its state and county, its USGS GNIS source and its coordinates,
its approximate terrain elevation fetched from USGS 3DEP once you open the
card, with buttons to save the place, copy the coordinates, or copy a
shareable link to that place. The map stops where that card can be read:
clear of the buttons laid over the map (and, on a phone, the panels) where there is room, and
where there is not, with as much of its name clear as the space allows, then
as much of the rest of the card. **Show** on a saved named place aims the same
way, but the panel you pressed it in stays open, so the card has less room.

Tab or Shift+Tab out of the open search closes it, as its button does, so the
search never sits over the control you moved on to. Dragging the map leaves it
open with what you typed.

## Data trust model

Every figure on this page is regenerated from source by a pipeline that refuses to
invent a number it does not have — but it discloses gaps two different ways depending
on the dimension. Stability, remoteness and affordability report a missing county's
field as absent (null) rather than defaulted; the coverage panel states the real scored
percentage for each. The sprawl sub-factors instead report a per-factor non-zero count
in the sprawl-factors panel, and a factor with no input for a county is dropped from
that county's composite with the remaining weights renormalized — never defaulted to a
convenient number. The generation timestamp is stamped into the exported data rather
than typed by hand.

Sources the pipeline draws on:

- **County populations**: Census PEP Vintage 2024 (2020-2024)
- **County coordinates**: Census Gazetteer 2024
- **Nearest cities**: Census Place Gazetteer 2024 (all places >25K)
- **Rural classification**: USDA Rural-Urban Continuum Codes 2023
- **County typing**: USDA County Typology Codes 2015 (recreation/retirement flags)
- **Interstate proximity**: Static, hand-maintained waypoint list along major US
  interstates (422 points across 30 route chains, no duplicates), with distance measured
  to the nearest route segment rather than the nearest point — not a government dataset
- **County geometry**: [us-atlas](https://github.com/topojson/us-atlas)
  `counties-10m.json` (ISC License, © the us-atlas project) — a TopoJSON build derived
  from Census TIGER/Line cartographic boundaries, served from this domain rather than a
  third-party CDN
- **Building permits**: Census Building Permits Survey, county annual bulk files
  (`www2.census.gov/econ/bps/County/`) — the API timeseries endpoint is retired; these
  keyless files replace it
- **Fast-growing metro proximity**: Census Subcounty Population Estimates bulk file
  (SUB-EST2024) — the PEP place API endpoint is retired; this keyless file replaces it
- **State migration**: Census ACS 1-Year B07001 (Geographical Mobility)
- **Affordability**: Census ACS 5-Year (median home value, gross rent, household income)
- **Candidate towns**: Census Subcounty Population Estimates 2024 (SUB-EST2024)

No data is sampled, simulated, or interpolated beyond filling the 2001-2009 intercensal
gap with Census-published CSV data. What you see is what those sources reported.

The county map, its geometry and the scores it shades by are served from this domain,
with no third-party scripts and no analytics on it. This page shares its Layers panel
with [Field Maps](/quiet-corners/maps/): turning on a base map or a context layer there
requests tiles or data directly from that layer's own service, described on the
[privacy page](/privacy/#quiet-corners-field-maps).
