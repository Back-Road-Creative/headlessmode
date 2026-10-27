---
title: "Privacy"
description: "What this site, the Quiet Corners map, Band Coach and Waypost send and store: browsing, map layers, location, saved places, the microphone, and tokens."
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
- **Band Coach and Waypost** are separate programs you download or run
  yourself, not part of this site's pages. Each has its own section below,
  written from that program's public source.
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

## Band Coach

[Band Coach](/band-coach/) is a single HTML file you download and open in a
browser. This section is written from its public source (package version 1.11.0,
repository commit `2736d8f`).

**Microphone.** Instruments that listen ask the browser for the microphone
when you press Start or Connect (`getUserMedia`, with echo cancellation, noise
suppression and automatic gain turned off). The sound goes into the browser's
audio analysis in the page, which works out pitch and loudness for the level
meter and the feedback. The source has no code that records the microphone
(there is no `MediaRecorder`), and no code that sends audio anywhere. Switching
to an instrument that does not listen closes the microphone.

**What it keeps, and where.** Everything is in your browser, under the address
the file was opened from:

- local storage: `bandcoach.v1` (your progress and settings), `bandcoach.v1.backupAt`
  (when you last saved a backup), `bandcoach.v1.tuneAsked` (which instruments
  have already been asked about tuning), and `bandcoach.v1.corrupt` (a copy of
  the saved profile, only if it could not be read);
- session storage: `bandcoach.v1.errors`, the last 20 caught errors (message,
  place, time), kept until the tab closes;
- IndexedDB: `bandcoach-songs` (your saved songs) and `band-coach-model-packs`
  (a downloaded model pack);
- on the hosted copy only, a service worker and a browser cache named
  `band-coach-pages-v` plus the version. The service worker is registered only
  on `https:`, `localhost` or `127.0.0.1`, so a downloaded copy opened as a file
  does not have one.

**What leaves your device.** The source makes two network requests, and each runs
only when you press its button under Settings. **Check for updates** fetches
`https://back-road-creative.github.io/band-coach/version.json`. **Download model
pack** fetches a manifest from `https://back-road-creative.github.io/band-coach/model-packs/core/manifest.json`
and then the pack file it names, from the same folder. Neither request carries
any of your progress, songs or audio; as with any web request, the server can see
your IP address and browser. That address is the project's GitHub Pages site, not
this site, so this site receives nothing from either. The app has no other
`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or analytics code.
**Copy diagnostics** only puts text on your clipboard (app version, browser
string, which features exist, and recent errors with web addresses and file
paths blanked); the app does not send it, and what you do with the text is your
choice. **Save a backup** downloads `band-coach-progress.json` to your computer.

**Deleting it.** Settings has **Erase all my data**. After you confirm, it removes
every local-storage and session-storage key beginning `bandcoach`, deletes the
two IndexedDB databases and the `band-coach-pages-v` caches, then reloads. A
backup file you saved is a file on your computer and is yours to delete. Clearing
your browser's site data for the page also removes the browser-held items above.

## Waypost

[Waypost](/waypost/) is software you run on your own computer. This section is
written from the public `seo-manager` package (version 0.3.0, repository commit
`78d65fa`). The web console in the studio deployment is not part of that package,
so this section does not describe it. The read-only demo on this site is a fixed
saved example.

**What it handles.** Sign-in tokens for your own accounts, and the numbers the
platforms report back:

- **YouTube.** An OAuth token from Google's sign-in flow, which opens a browser
  window on your computer. The package asks for the `youtube.readonly` and
  `yt-analytics.readonly` scopes for analytics; the uploader asks for
  `youtube.upload`, `youtube` and `youtube.readonly`.
- **Facebook.** A Page access token and Page ID, read only by the earnings probe
  (`meta_earnings_probe`).
- **Analytics.** Per video: views, likes and comments (YouTube Data API) and
  views, minutes watched, average view percentage, and card impressions, card
  clicks and card click rate (YouTube Analytics API). The sync stores views,
  likes, comments, card clicks, card impressions, the card click rate and an
  engagement rate.

**Where it is kept.** On your computer, in places you choose:

- The setup guide's sign-in step saves the YouTube token as a JSON file at the
  path you give (`youtube_credentials.json` in the guide), through an owner-only
  temporary file (mode `0600` on POSIX).
- The `BrandCredentials` helper keeps one folder per brand under a credentials
  directory (default `./credentials`, relative to where you run it): the token
  as `<brand>/youtube_oauth.json.enc` and the OAuth client as
  `<brand>/client_secret.json.enc`, encrypted with Fernet, all with mode `0600`.
  The encryption key is the file `.credentials_key` in that same directory.
- The probes read a token from a SOPS-encrypted file you point them at
  (`youtube_upload_token.json.enc`, `meta_publishing.json.enc`) or from standard
  input. They do not write it anywhere.
- Synced numbers go into an event log (`events.jsonl`, with `index.json`) under
  `<storage path>/<site id>/`, by default `./data/seo/<site id>`. The Metricool
  PDF importer, when no location is given, uses `seo_events` under the data home
  (`$SEO_MANAGER_DATA_HOME`, else `$XDG_DATA_HOME/seo-manager`, else
  `~/.local/share/seo-manager`).

**What leaves your computer.** The package calls only these services, directly
from the machine it runs on, with your token: Google's YouTube Data API (video
statistics; uploads, thumbnails and playlist additions), YouTube Analytics API
and YouTube Reporting API, and Meta's Graph API at `graph.facebook.com` (Page
insights, with the token sent as a request parameter). An upload sends the video
file and its title and description to YouTube. The package contains no call to
this site and no analytics or error-reporting service, so this site receives
none of it. Each platform receives your requests under its own terms.

**Deleting it.** Delete the token file, the brand's folder under `credentials/`
(and `.credentials_key` if you want the key gone), and the `data/seo/<site id>`
folder or the data home folder you used. All of these are ordinary files on your
computer.

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
