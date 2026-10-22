---
title: "Privacy"
description: "What each action on this site sends and stores: browsing, map layers, search, camera images, location, saved places, sharing, and who receives what."
date: 2026-08-02
draft: false
tags: ["privacy", "policy"]
---

This page describes what happens when you use the site, action by action: what
leaves your browser, who receives it, and what is kept on your device. It is
written from the site's own code and headers, so it is specific about what the
site does rather than reassuring about what it intends. Where the code cannot
show what a third party does with a request, the page says only what that party
can receive, not what it keeps.

Last reviewed 20 October 2026.

## Who is involved

- **This site** is static files plus one small relay (a Cloudflare Pages
  Function) for map address search. It has no database, accounts, logins,
  comment system or forms, and its pages set no cookies from their own code.
  There is no measurement script, tag manager, advertising, tracking pixel or
  beacon, so nothing on a page counts your visit.
- **The host** serves those files and the relay. See [Hosting](#hosting).
- **Your browser** keeps what the Quiet Corners map saves on your device. See
  [Saved places](#saved-places) and the other sections below for exactly what.
- **Map and data providers** receive requests from your browser when you use
  the Quiet Corners map. The one other third party is the script host described
  under Diagram loading, and only on pages with a diagram. Providers are named
  below, per action.

## Ordinary browsing

Reading a page asks this domain for that page and its files: stylesheets,
scripts, images, icons, and the county data files and map libraries the Quiet
Corners dashboard uses. Type is set in your device's own system fonts, so no
font is fetched from anyone. The site embeds no videos, no frames, and no
social widgets. Its content policy blocks background data connections to other
domains on every page except the Quiet Corners map, described below, and permits
exactly one external script host, described under Diagram loading.

This site has no forms. The only text you can type that can leave your browser
is a map search, described under [Search](#search).

The site's code writes nothing to browser storage on these pages, and sets no
cookies. Your browser keeps its ordinary cache of the files it downloaded, and
the site's headers ask it to reuse the county data files for up to four hours
and the bundled libraries for up to seven days.

The two interactive figures on the tool pages (the redactcam and sun-track
demos) each read one data file from this domain and send nothing.

Following a link to another site, such as GitHub, X or Back Road Creative, is
an ordinary link: that site's own privacy practices apply from then on, and
this policy stops covering you. Apart from the Quiet Corners map, following a
link is the only way this site lets any other party know you were here.

## Hosting

The site is served by Cloudflare Pages: static files, plus the address-search
relay. Like any web server, that host necessarily processes the technical data
required to deliver a page to you: your IP address, the request, and your
browser's user-agent string. That processing is the host's, under its own
privacy terms, which this page does not describe, and this site keeps no log of
its own. The search text of a map address search, if one is sent, reaches this
site's relay, which passes it straight to the Census Bureau's geocoder and does
not store it.

## Quiet Corners Field Maps

The [Quiet Corners](/quiet-corners/) page is the dashboard and the Field Maps
builder in one map; [Field Maps](/quiet-corners/maps/) is the documentation
page for the builder and loads no map services. The county data (scores,
boundaries and names) is fetched from this domain as ordinary files, and every
slider, filter and score you interact with is computed in your browser against
data it already has: no selection or filter setting is transmitted anywhere.
The sections below list the exceptions. Each is a request that your browser
sends to a provider, with your IP address and the browser's user-agent string,
as with any web request. Because the site's headers use
`Referrer-Policy: strict-origin-when-cross-origin`, a provider also sees this
site's address (not the page path) as the referrer. The same no-transmission
rule, exceptions included, holds for the smaller interactive demos elsewhere
on the site.

### Default map layers

Three layers are on when the map first loads, so these requests happen before
you change any layer. Each is a request to a USGS service, but at the opening
view only the base map is requested:

- **USGS Topo**, the base map, requests map tiles from `basemap.nationalmap.gov`
  as soon as the map draws.
- **Named places & landmarks** requests place names for the area on screen from
  the USGS Geographic Names Information System (`carto.nationalmap.gov`), once
  the map is zoomed in to zoom level 8.
- **Road names** requests road names for the area on screen from the USGS
  transportation service (`carto.nationalmap.gov`), highways from zoom level 10
  and local roads from zoom level 13. They appear on screen only and are not
  printed.

On screen, Named places and Road names can be turned off under Layers, and the
USGS Topo base is replaced by choosing another base map or "No base map." A
printed set always uses USGS Topo tiles, whatever the screen base map is.
Choosing No base map and turning every layer off keeps the map itself
same-origin; picking a county, a town or a named place still reaches the
National Weather Service as described under
[Selecting a place](#selecting-a-place) regardless of any layer's state.

Every other layer is off until you switch it on. The Layers panel is shared by
the dashboard and the builder: switching on any other layer, or choosing another
base map, on either page, requests map tiles or map data directly from that
layer's own service, for the area on screen. Today those services are U.S.
federal agencies (USGS, whose elevation service also draws contour lines and whose
water service reports stream gauges, the Forest Service, FEMA, BLM and NOAA), NASA satellite
imagery, the Bureau of Transportation Statistics (noise-map tiles, rail lines and airports), the National Park Service (historic places), the USDA Natural Resources Conservation Service (SNOTEL snowpack sites, from wcc.sc.egov.usda.gov), avalanche.org (avalanche danger ratings, from api.avalanche.org; not a government host, but a partnership of the American Avalanche Association and the US Forest Service National Avalanche Center), and the
biodiversity data aggregator GBIF; several of those agencies'
public services are hosted on Esri's commercial ArcGIS Online platform rather
than the agency's own domain, and one imagery layer is served from Amazon S3.
Each service you reach this way receives your IP address and the coordinates of
the tiles or area a layer you turned on requests, under its own terms. The exact
current list of origins is generated at build time from the map's own layer
registry into the map page's Content-Security-Policy, so an added layer cannot
quietly reach a host this policy has not been told about.
Turning on the Weather stations layer asks the National Weather Service
(`api.weather.gov`) for the latest observations of the stations in view, up to
12 stations at a time, using station identifiers from this site's own list
rather than your position.

Drawing or picking a print area asks the USGS map index
(`carto.nationalmap.gov`) which quadrangles the area covers. Building a print
set fetches the selected layers' tiles and data for your chosen area from those
same services. When the printed area includes named roads or trails, it also
sends sample points along up to twelve of them (about sixty each) to the USGS 3D
Elevation Program (`elevation.nationalmap.gov`) to fill the route table's climb
column. The PDF is assembled on your device and nothing is uploaded.

### Search

Typing in the place finder matches towns against files already loaded from
this domain, and a typed pair of coordinates is read locally. Nothing is sent
while you type.

The finder's **Search** button is separate. Only when you press it (or press
Enter with no suggestion selected), the place name you typed, and the state if
you added one, is sent to the USGS Geographic Names service
(`carto.nationalmap.gov`) as part of the request URL.

A street address is not a place name. When you press **Search** on text shaped
like a street address (a house number and street, an apartment or unit, or a ZIP
code), what you typed is passed through headlessmode.com to the US Census
Bureau's geocoder, which returns matches estimated along the street, never a
household. A place already in the town list wins, and then nothing is sent. This
site does not store or log the search and keeps it out of the page's link,
shared links, saved views and your browser's storage; the Census Bureau receives
it under its own terms, and Cloudflare handles the request as described under
[Hosting](#hosting).

### Selecting a place

Picking a county, a town, a street-address match, a coordinate or a named
feature, or asking
**Before you go** on a place's card or on a saved place, sends that point's
coordinates, rounded to four decimal places, to the National Weather Service
(`api.weather.gov`) for tonight's forecast and any alerts in force there. The
sun and moon times shown are calculated in your browser and are not requested
from anyone.

Opening a named terrain feature's details card also requests that one point's
elevation from USGS's 3D Elevation Program (`elevation.nationalmap.gov`), sent
only for the point you opened and only once you open it.

The "Cameras nearby" list on a place's conditions panel is read from camera
lists already loaded from this domain.

### Opening camera images

Turning on **Road cameras** requests the camera list from this site only. The
list covers all twelve districts of Caltrans, California's state transportation
department, and is a snapshot this site builds ahead of time and serves from its
own domain, so the requests for that list go only to this site, and only for the
districts the map is showing. Turning on Road cameras asks nothing of Caltrans.
Opening one Caltrans camera is a separate, second request: your browser asks
Caltrans for that camera's current picture, which tells Caltrans which camera
you looked at.

Turning on **Park cameras** asks nothing of the National Park Service either:
its camera list is the same kind of snapshot, served from this site's own
domain, so the request for that list goes only to this site. Opening one camera
loads that camera's current picture directly from the National Park Service's
own image host, which tells the Park Service which camera you looked at. The
card notes that the picture is about 2 MB, and the Park Service does not say
when each picture was taken.

The same Road cameras switch also loads the lists of seventeen more operators: the
Kentucky Transportation Cabinet, the City of Arlington, Texas, the City of Lawrence,
Kansas, the City of Salem, Oregon, the Oregon Department of Transportation
(TripCheck), the Utah Department of Transportation (UDOT Traffic), the Minnesota
Department of Transportation (511MN), the Indiana Department of Transportation
(511IN), the Kansas Department of Transportation (KanDrive), the
Spokane Regional Transportation Management Center,
the Virginia Department of Transportation,
the South Dakota Department of Transportation,
the City of Austin Transportation and Public Works Department (Texas), the
City of Baton Rouge with the Louisiana DOTD, the Colorado Department of
Transportation (COtrip), the City of Kirkland (Washington) and the
Washington State Department of Transportation (WSDOT, its ferry terminal cameras).
Each of those lists is a snapshot this site builds ahead of time and serves from
its own domain, so the request for a list goes only to this site, and only for
the areas the map is showing. Opening one of these cameras shows a card with its
name, the operator's name and a link to the operator's public camera page, and
makes no request at all: no picture is loaded, and your browser contacts the
operator only if you follow that link, which then opens their page under their
own terms.

Cameras from HPWREN (UC San Diego) and AlertWest are links only. Their lists
are snapshots this site builds ahead of time and serves from its own domain,
and a pin shows a name, the owner's credit and a link, never a picture. Your
browser contacts no HPWREN or AlertWest host unless you follow that link,
which then opens the owner's own page under its own terms.

Cameras from Missouri DOT (MoDOT), Maryland CHART, Delaware DOT (DelDOT), New
Mexico DOT (NMRoads) and the New Jersey Turnpike Authority are links only in
the same way: their lists are snapshots built ahead of time and served from this site, a pin shows a name, the owner's credit and a
link, never a picture, and your browser
contacts none of those hosts unless you follow that link.

Two more camera networks are built the same way. The PhenoCam Network, a university
research network of outdoor cameras, and AviationWX, which publishes airport
webcams, each give out a public list of their cameras; this site reads each list
only when it refreshes its camera lists, not on every build, and serves the result
from its own domain, so turning on the Research cameras (PhenoCam) or Airport cameras
(AviationWX) layer asks neither of them. The PhenoCam list also names
each camera's contact people, and this site does not copy those names or
addresses. Opening one camera loads its current picture directly from the
PhenoCam Network's or AviationWX's own image host, which tells that network
which camera you looked at. This site stores no camera picture.
Two more sets of cameras are built the same way. USGS VolcView, which shows volcano cameras run by the
USGS, the Alaska Volcano Observatory, the FAA and the National Park Service, and NOAA's
Great Lakes Environmental Research Laboratory (GLERL), which runs cameras on Great Lakes lighthouses, piers and stations, each
publish a public camera list. This site reads those lists only when it refreshes its camera lists,
never on a normal build, keeps the result as a snapshot served from its own domain, and asks each
host (volcview.wr.usgs.gov, avo.alaska.edu and www.glerl.noaa.gov) for the camera list; avo.alaska.edu, which holds only the
Alaska Volcano Observatory's list, is asked for nothing else, while volcview.wr.usgs.gov and www.glerl.noaa.gov are also asked,
once for each picture, for its headers, so it can drop a camera whose picture is gone or over a day old. These cameras show on the map today, under the
Research cameras (PhenoCam) switch. Turning that layer on asks none of the three hosts for anything (avo.alaska.edu is asked only by the build, for its list), and
opening one camera loads its picture directly from volcview.wr.usgs.gov or www.glerl.noaa.gov, which will tell that host which camera you looked at.

### Location

The dashboard has a **Use my location** button, and the hillshade light control
has a **Sun now** button. This site sends `Permissions-Policy: geolocation=()`,
which tells browsers to refuse the location feature for its pages. Because of
that header, a browser that honors it will not give either button your
position. The locate button then shows "Location permission was denied. The map
has not moved." and Sun now does nothing.

The rest of this section applies only where a browser does hand over a
position. Each button asks your browser for your position once, when you press
it, and your browser asks your permission first. The position is used only in
the page: Use my location moves the map and draws a marker and an accuracy
circle that are kept in memory (not in browser storage and not in the link),
and Sun now calculates the sun's direction. Neither sends your position to
this site or to a provider as such. The map does move to where you are, though,
so the layers that are on then request tiles and names for that area, and the
providers can infer roughly where you are from that area. **Reset view**
removes the marker and circle.

### Saved places

Saving a named place or a camera stores its name, kind, coordinates, state and
county (when it has them) and the time you saved it in your browser's local
storage under `qc-saved-places`, up to 200 places. It is not sent anywhere.
Remove a place individually with its **Remove** button, or use the saved-places
controls: **Download** gives you a file of your places, **Import** merges a
file you choose, and **Clear saved places** (a two-step confirmation, with Undo)
removes them all. Clearing your browser's site data removes everything described
here as well.

The map also keeps, in your browser only:

- your last print area and settings, in a local database (IndexedDB) named
  `quiet-corners-field-maps`, with a one-word note in local storage when you
  press **Clear print area** so a quick reload cannot bring the old area back;
- your display choices (base map, label density and size, emphasis) in local
  storage under `qc-field-maps-display-prefs`, which **Reset view** removes.

**Reset view** does not remove the last print area. **Clear print area** (or
clearing your browser's site data) does. The map builds any PDF on your device
and uploads nothing.

### Sharing a view

**Share view** copies a link to your clipboard. The link records the map
position, zoom, base map, layer and display choices after the `#` in the
address, which browsers do not send to a server. If the map is centered on a
spot that came from your location, the link leaves that center out unless you
tick the control that includes it; the confirmation message says which
happened. Pasting the link somewhere is your choice, and then the recipient and
that service can read it.

**Share place** on a name card, and **Share** on a saved place, copy a link
whose `#` fragment holds that place's coordinates and the current view
settings. **Copy coordinates** copies the coordinates as text. None of these
actions sends anything to a server or a provider.

## Diagram loading

Pages that contain a technical diagram fetch the library that draws it from a
public code distribution network (`cdn.jsdelivr.net`); that request would
reveal your IP address and browser to its operator. The script that would fetch
it checks the page first and does nothing when there is no diagram present. As
of the date above, no published page on this site contains one, so in practice
the request is not currently made on any page.

## Your data

This site has no accounts and no forms, so it holds no profile of you to
export, correct or delete. The data this page describes is in two places: the
host's request data, which the host controls, and what your own browser keeps.
The search text of a map address search is passed on to the Census Bureau and
not kept by this site. Your saved places, display choices and last map setup
live only in your own browser; remove a saved place individually with its own
Remove button, and clearing your browser's site data removes all of it. You can
also export, import or clear all of your saved places at once from the saved
places' own Download, Import and Clear saved places controls. If you would like
to reach a person about this page, [contact](/contact/).

To report a security issue, please use the private route described on the
[contact](/contact/) page rather than a public issue.

## Changes

If this site ever starts measuring traffic or loading something new from another
party, this page changes in the same commit that adds it, and the review date
above moves. The commit history of this page is public in the repository.
