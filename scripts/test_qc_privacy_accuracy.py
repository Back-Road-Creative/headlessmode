"""Reconciles content/privacy.md and content/quiet-corners.md against the
Field Maps layer registry's own list of external origins
(themes/headlessmode/static/js/quiet-corners-maps/source-registry.js,
read-only here — H7 does not own that directory).

Two claims went stale as the live map campaign (#555/#569/#570/#571/#572 +
U0/U1) landed more layers:

1. privacy.md said Field Maps talks to "three government services". The
   registry's cspDirectivesFor() connect-src list is now far larger and
   spans agencies beyond "government" in the narrow sense (GBIF is an
   international science non-profit; several federal services are hosted
   on Esri's commercial ArcGIS Online platform; one origin is Amazon S3).
   A literal count/enumeration goes stale on the next layer PR, so this
   test checks organizations are named, not an exact count.

2. Both privacy.md and content/quiet-corners.md described the shared map's
   tile/data traffic as scoped to the /quiet-corners/maps/ page only.
   themes/headlessmode/layouts/_default/quiet-corners-dashboard.html:106
   includes the same partials/qcm-map-layers.html panel (base map choice
   included) that the Field Maps page uses, so the dashboard can also
   reach those external services once a layer is turned on.

This test does not touch scripts/qcm/** or any reserved QC map-code path;
it only imports source-registry.js's exported cspDirectivesFor() via a
short subprocess (read-only) to ground the content claims in the registry
that actually decides them.

Run: pytest scripts/test_qc_privacy_accuracy.py -v
"""

import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
PRIVACY = ROOT / "content" / "privacy.md"
QUIET_CORNERS = ROOT / "content" / "quiet-corners.md"
DASHBOARD_LAYOUT = (
    ROOT / "themes" / "headlessmode" / "layouts" / "_default" / "quiet-corners-dashboard.html"
)
REGISTRY = (
    ROOT
    / "themes"
    / "headlessmode"
    / "static"
    / "js"
    / "quiet-corners-maps"
    / "source-registry.js"
)

# Domain family -> the organization name privacy.md must mention if the
# registry currently reaches that family. Intentionally coarse (by
# second-level domain) so a new endpoint on an already-named org's host
# does not require a doc edit; a genuinely new org does.
ORG_BY_DOMAIN_SUFFIX = {
    "nationalmap.gov": "USGS",
    "usgs.gov": "USGS",
    "usda.gov": "Forest Service",  # also wcc.sc.egov.usda.gov (NRCS SNOTEL); privacy.md names NRCS in full
    "fema.gov": "FEMA",
    "blm.gov": "BLM",
    "noaa.gov": "NOAA",
    "weather.gov": "NOAA",  # api.weather.gov, the National Weather Service
    # imagery.geoplatform.gov: the NLCD rasters come through the Forest
    # Service's imagery platform (content/quiet-corners-maps.md, NLCD rows).
    "geoplatform.gov": "Forest Service",
    "nasa.gov": "NASA",
    "dot.gov": "Bureau of Transportation Statistics",  # geo.dot.gov, the BTS noise-map tiles
    "gbif.org": "GBIF",
    "avalanche.org": "avalanche.org",  # api.avalanche.org, the avalanche danger ratings (not a government host)
    "arcgis.com": "Esri",
    "amazonaws.com": "Amazon",
    "ca.gov": "Caltrans",  # cwwp2.dot.ca.gov, the Caltrans CCTV pictures (QUX-08D)
    "nps.gov": "National Park Service",  # www.nps.gov, the GRSM webcams (QUX-08D-ii)
    # Road-camera picture hosts of the six ArcGIS-layer operators (privacy.md names each).
    "trimarc.org": "Kentucky Transportation Cabinet",  # www.trimarc.org (KYTC)
    "arlingtontx.gov": "City of Arlington",  # webapps.arlingtontx.gov
    "lawrenceks.gov": "City of Lawrence",  # assets.lawrenceks.gov
    "cityofsalem.net": "City of Salem",  # egov.cityofsalem.net
    "tripcheck.com": "Oregon Department of Transportation",  # tripcheck.com
    "utah.gov": "Utah Department of Transportation",  # udottraffic.utah.gov
    # Picture hosts of the Iteris and Socrata camera operators (privacy.md names each).
    "vdotcameras.com": "Virginia Department of Transportation",  # snapshot.vdotcameras.com
    "iteris-atis.com": "South Dakota Department of Transportation",  # sd.cdn.iteris-atis.com
    "austinmobility.io": "City of Austin Transportation and Public Works",  # cctv.austinmobility.io
    "511la.org": "Louisiana DOTD",  # 511la.org
    # CARS picture hosts (MN and IN share public.carsprogram.org; KS is kscam.carsprogram.org).
    "carsprogram.org": "Indiana Department of Transportation",  # coarse check: any one named CARS operator satisfies it (also MN, KS, CO)
    "srtmc.org": "Spokane Regional Transportation Management Center",  # images.srtmc.org
    "nau.edu": "PhenoCam Network",  # phenocam.nau.edu, the research-camera pictures
    "aviationwx.org": "AviationWX",  # api.aviationwx.org, the airport-camera pictures
    # Small state and city camera feeds.
    "kirklandwa.gov": "City of Kirkland",  # its.kirklandwa.gov
    "wa.gov": "Washington State Department of Transportation",  # images.wsdot.wa.gov, the ferry-terminal pictures
}


def _registry_origins() -> list[str]:
    assert REGISTRY.exists(), f"{REGISTRY} not found"
    script = (
        "import(process.argv[1]).then(m => "
        "console.log(JSON.stringify(m.cspDirectivesFor())))"
    )
    result = subprocess.run(
        ["node", "-e", script, str(REGISTRY)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"node import of source-registry.js failed: {result.stderr}"
    data = json.loads(result.stdout)
    return sorted(set(data["connect-src"]) | set(data["img-src"]))


def _domain_suffix(origin: str) -> str:
    host = origin.split("//", 1)[-1]
    parts = host.split(".")
    return ".".join(parts[-2:])


def test_field_maps_serves_more_than_three_origins_today() -> None:
    """Sanity check on the fixture this test relies on: if the registry ever
    shrinks back to three origins, the "reconciled" wording below should be
    revisited rather than this test silently passing on stale content."""
    origins = _registry_origins()
    assert len(origins) > 3, (
        f"expected more than 3 Field Maps origins (found {len(origins)}); "
        "if this genuinely dropped to 3, privacy.md's enumerated wording may be fine again"
    )


def test_privacy_does_not_undercount_field_maps_services() -> None:
    text = PRIVACY.read_text(encoding="utf-8")
    assert "three government services" not in text, (
        "privacy.md still claims Field Maps talks to \"three government services\"; "
        "the registry now serves more — see source-registry.js cspDirectivesFor()"
    )


def _unnamed_operators(origins: list[str], text: str) -> list[tuple[str, str | None]]:
    """(origin, organization) for every origin whose operator privacy.md does not name."""
    missing = []
    for origin in origins:
        org = ORG_BY_DOMAIN_SUFFIX.get(_domain_suffix(origin))
        # None fails too: a domain this map has never seen means nobody has
        # decided which organization privacy.md must name for it yet.
        if org is None or org not in text:
            missing.append((origin, org))
    return missing


def test_an_origin_with_no_known_operator_is_reported_not_skipped() -> None:
    """A new provider's origin (a camera catalogue, say) on a domain family this file has never seen used
    to be skipped, so it could ship with its operator named nowhere in
    privacy.md while this test stayed green. Synthetic domain (QUX-08D C20):
    ca.gov is now a known suffix (Caltrans, below), so a real ca.gov origin
    would no longer exercise the unmapped-operator path this test guards."""
    missing = _unnamed_operators(
        ["https://cams.example-operator.test"], "Example Operator runs the cameras."
    )
    assert missing == [("https://cams.example-operator.test", None)]


def test_privacy_names_every_organization_field_maps_currently_reaches() -> None:
    text = PRIVACY.read_text(encoding="utf-8")
    missing = _unnamed_operators(_registry_origins(), text)
    assert not missing, (
        "privacy.md does not name these organizations for origins the registry "
        f"currently reaches: {missing} (None = a domain with no ORG_BY_DOMAIN_SUFFIX "
        "entry: add its operator there and name that operator in privacy.md)"
    )


def test_privacy_does_not_scope_field_maps_traffic_to_the_maps_page_only() -> None:
    """The dashboard (/quiet-corners/) embeds the same Layers panel Field Maps
    uses (quiet-corners-dashboard.html includes partials/qcm-map-layers.html),
    so a claim that only /quiet-corners/maps/ can reach these services is false."""
    dashboard_html = DASHBOARD_LAYOUT.read_text(encoding="utf-8")
    assert "qcm-map-layers.html" in dashboard_html, (
        "fixture assumption broken: the dashboard no longer includes the shared "
        "Layers panel partial — re-check whether the map-traffic scoping claim is true again"
    )
    text = PRIVACY.read_text(encoding="utf-8")
    assert "no map tiles, because the map is drawn from local geometry" not in text, (
        "privacy.md still claims the dashboard never fetches map tiles, but it shares "
        "the same Layers panel (base map choice included) as Field Maps"
    )


def test_quiet_corners_page_does_not_claim_no_tile_servers_unconditionally() -> None:
    text = QUIET_CORNERS.read_text(encoding="utf-8")
    assert "no tile servers" not in text, (
        "content/quiet-corners.md still claims the page uses no tile servers, but it "
        "embeds the same Layers panel (with base map choice) as Field Maps and can "
        "request tiles once a layer is turned on"
    )


def test_link_only_camera_owners_are_not_origins_and_privacy_says_so() -> None:
    """HPWREN and AlertWest cameras are pins and links only: the registry reaches no
    host of theirs (so no connect-src or img-src entry), and privacy.md says the
    reader's browser contacts them only when the reader follows the link."""
    hosts = [o for o in _registry_origins() if any(k in o for k in ("hpwren", "ucsd", "alertwest", "weathernode", "modot", "chart.maryland", "deldot", "nmroads", "njta"))]
    assert not hosts, f"a link-only camera owner is a registry origin: {hosts}"
    text = PRIVACY.read_text(encoding="utf-8")
    assert "HPWREN" in text and "AlertWest" in text, "privacy.md does not name the link-only camera owners"
    assert "contacts no HPWREN or AlertWest host unless you follow that link" in text
    for owner in ("MoDOT", "Maryland CHART", "DelDOT", "NMRoads", "New Jersey Turnpike Authority"):
        assert owner in text, f"privacy.md does not name the link-only camera owner {owner}"
    assert "contacts none of those hosts unless you follow that link" in text



def _section(heading: str) -> str:
    text = PRIVACY.read_text(encoding="utf-8")
    start = text.index(f"## {heading}\n")
    return " ".join(text[start:].split("\n## ")[0].split())


def test_privacy_no_forms_line_names_what_can_be_typed() -> None:
    """Was asserted against a "No collection" section. The page is now organised by
    action, so the same claim lives under Ordinary browsing (no forms) and Search
    (the one place typed text can leave the browser)."""
    browsing = _section("Ordinary browsing")
    assert "collects nothing you type" not in browsing
    assert "This site has no forms" in browsing
    search = _subsection("Search")
    assert "street address" in search and "Census" in search


def test_privacy_hosting_and_your_data_cover_the_search_text() -> None:
    hosting = _section("Hosting")
    assert "neither receives that data" not in hosting and "search text" in hosting and "Census" in hosting
    your_data = _section("Your data")
    assert "search text" in your_data and "not kept" in your_data


def test_privacy_names_the_volcano_and_great_lakes_camera_hosts_and_how_they_load() -> None:
    """USGS VolcView (with the Alaska Volcano Observatory list) and NOAA GLERL cameras are
    built into snapshots; a picture loads from the owner's own host only when a pin is opened.
    privacy.md must name each host and say so, and that the Research cameras switch shows them today."""
    text = PRIVACY.read_text(encoding="utf-8")
    for needle in (
        "VolcView",
        "Alaska Volcano Observatory",
        "volcview.wr.usgs.gov",
        "avo.alaska.edu",
        "Great Lakes Environmental Research Laboratory",
        "www.glerl.noaa.gov",
    ):
        assert needle in text, f"privacy.md does not name {needle!r} for the volcano / Great Lakes cameras"
    block = text[text.index("VolcView") - 600 : text.index("www.glerl.noaa.gov") + 900]
    assert "Research cameras (PhenoCam)" in block, "the paragraph must say these show under the Research cameras (PhenoCam) switch"
    assert "none of the three hosts" in block and "avo.alaska.edu is asked only by the build" in text
    assert "volcview.wr.usgs.gov or www.glerl.noaa.gov" in block, "the paragraph must say a pin loads its picture from those hosts"
    assert "stores no camera picture" in text


def test_docs_do_not_say_the_volcano_and_great_lakes_cameras_are_not_on_the_map_while_the_index_files_them() -> None:
    """index.json files volcview and glerl under a layer the map reads (phenoCameras), so the
    "not yet" wording in privacy.md and quiet-corners-maps.md is false."""
    index = json.loads((ROOT / "static/data/quiet-corners-maps/cameras/index.json").read_text(encoding="utf-8"))
    layers = {e["layer"] for e in index["files"] if e["file"].split("/")[0] in ("volcview", "glerl")}
    registry = (ROOT / "themes/headlessmode/static/js/quiet-corners-maps/layer-registry.js").read_text(encoding="utf-8")
    assert layers and all(f"id: '{layer}'" in registry for layer in layers)
    stale = ("does not show these cameras yet", "no layer yet", "no map layer reads the seed yet", "through no layer yet")
    for doc in (PRIVACY, ROOT / "content/quiet-corners-maps.md"):
        text = " ".join(doc.read_text(encoding="utf-8").split())
        for phrase in stale:
            assert phrase not in text, f"{doc.name} still says {phrase!r} while index.json files {sorted(layers)}"
    maps = " ".join((ROOT / "content/quiet-corners-maps.md").read_text(encoding="utf-8").split())
    assert "Research cameras (PhenoCam) switch" in maps


# --- C3: an action-based account in place of blanket claims -------------------
# The page used to open with "stores nothing about you" and a "No collection"
# heading while the same page described the host's request data, browser
# storage, and map services that receive an IP address. Each action below must
# have its own section so a reader can find what that action sends and keeps.

BLANKET_PHRASES = (
    "stores nothing about you",
    "No collection",
    "Nothing about you is collected",
    "What this site collects: nothing",
    "only once you turn it on",
    "on our end",
)

ACTION_HEADINGS = (
    "Ordinary browsing",
    "Default map layers",
    "Search",
    "Selecting a place",
    "Opening camera images",
    "Location",
    "Saved places",
    "Sharing a view",
    "Diagram loading",
)


def _headings(text: str) -> list[str]:
    return [line.lstrip("#").strip() for line in text.splitlines() if line.startswith("#")]


def _subsection(heading: str) -> str:
    """Body of a `### heading` subsection, hard-wrapped lines unwrapped."""
    text = PRIVACY.read_text(encoding="utf-8")
    start = text.index(f"### {heading}")
    stops = [e for e in (text.find("\n### ", start + 1), text.find("\n## ", start + 1)) if e != -1]
    return " ".join((text[start : min(stops)] if stops else text[start:]).split())


@pytest.mark.parametrize("phrase", BLANKET_PHRASES)
def test_privacy_has_no_blanket_claim(phrase: str) -> None:
    text = PRIVACY.read_text(encoding="utf-8")
    assert phrase not in text, f"privacy.md still carries the blanket claim {phrase!r}"


@pytest.mark.parametrize("heading", ACTION_HEADINGS)
def test_privacy_has_a_section_for_each_action(heading: str) -> None:
    found = _headings(PRIVACY.read_text(encoding="utf-8"))
    assert any(h.startswith(heading) for h in found), (
        f"privacy.md has no heading starting {heading!r}; headings are {found}"
    )


def test_privacy_keeps_the_anchors_other_pages_link_to() -> None:
    """content/quiet-corners.md links /privacy/#quiet-corners-field-maps."""
    found = _headings(PRIVACY.read_text(encoding="utf-8"))
    for anchor_heading in ("Hosting", "Quiet Corners Field Maps"):
        assert anchor_heading in found, f"{anchor_heading!r} heading (a linked anchor) is gone"
    assert "/privacy/#quiet-corners-field-maps" in QUIET_CORNERS.read_text(encoding="utf-8")


def test_privacy_says_default_layers_load_without_a_choice() -> None:
    """layer-registry.js ships usgsTopo, names and roads defaultOn: true, so
    external requests happen before the reader changes any layer."""
    registry = (REGISTRY.parent / "layer-registry.js").read_text(encoding="utf-8")
    assert registry.count("defaultOn: true") == 3, "fixture changed: re-derive the default-layer list"
    text = PRIVACY.read_text(encoding="utf-8")
    for default in ("USGS Topo", "Named places", "Road names"):
        assert default in text, f"privacy.md does not name the default-on layer {default!r}"


def test_privacy_default_layers_say_topo_is_required_for_print() -> None:
    section = _subsection("Default map layers")
    assert "always uses USGS Topo" in section
    assert "Those layers can be turned off" not in section
    # Zooms come from the registry: names draw from 8 (gnisNames zoomRange), road
    # names from road-names.js ROAD_CLASSES (highways 10, local roads 13).
    assert "zoom level 10" in section and "zoom level 8" in section and "zoom level 13" in section
    assert "opening view" in section


def test_privacy_separates_camera_list_from_image_requests() -> None:
    section = _subsection("Opening camera images")
    assert "requests the camera list from this site only" in section
    assert "asks Caltrans" not in section.split("Opening one Caltrans")[0], (
        "the Road cameras sentence must not say it asks Caltrans for anything"
    )
    # Caltrans, the National Park Service, the PhenoCam / AviationWX image hosts, and the
    # VolcView / GLERL image hosts load a picture.
    assert section.count("which camera you looked at") == 4
    assert "National Park Service" in section and "PhenoCam" in section and "AviationWX" in section
    # Link-only owners load no picture.
    assert "never a picture" in section
    for owner in ("HPWREN", "AlertWest"):
        assert owner in section
    assert "no picture is loaded" in section
    assert "stores no camera picture" in section


def test_privacy_search_separates_name_search_from_address_relay() -> None:
    """The finder's Search button sends the typed name to USGS (terrain-names.js
    buildNameSearchUrl -> carto.nationalmap.gov geonames); a street address is never
    sent only when Search is pressed (address-geocode.js -> /api/geocode), and the
    Census relay (static/functions/api/geocode.js) is the host's own function."""
    section = _subsection("Search")
    assert "nothing is sent while you type" in section.lower()
    assert "carto.nationalmap.gov" in section and "USGS" in section
    assert "Street address lookup is not available yet" not in section
    assert "estimated along the street" in section and "never a household" in section
    assert "headlessmode.com" in section and "Census Bureau" in section
    assert "does not store" in section


def test_privacy_selecting_a_place_names_every_request() -> None:
    section = _subsection("Selecting a place")
    assert "api.weather.gov" in section and "four decimal places" in section
    assert "elevation.nationalmap.gov" in section
    assert "calculated in your browser" in section


def test_privacy_location_states_the_header_before_the_permission_prompt() -> None:
    headers = (ROOT / "static" / "_headers").read_text(encoding="utf-8")
    assert "geolocation=()" in headers, "fixture changed: re-check the Location section"
    section = _subsection("Location")
    assert "Permissions-Policy" in section
    assert section.index("Permissions-Policy") < section.index("asks your browser")
    assert "Location permission was denied. The map has not moved." in section
    assert "does nothing" in section
    assert "only where a browser does hand over a position" in section


def test_privacy_sharing_covers_place_links_and_copy_coordinates() -> None:
    section = _subsection("Sharing a view")
    for phrase in ("Share view", "Share place", "Copy coordinates", "saved place", "after the `#`"):
        assert phrase in section, f"Sharing section omits {phrase!r}"


def test_privacy_names_the_print_area_control_exactly() -> None:
    text = " ".join(PRIVACY.read_text(encoding="utf-8").split())
    assert "Clear print area" in text
    assert "Reset view** does not remove the last print area" in text


def test_privacy_names_the_storage_keys_the_code_writes() -> None:
    """Every browser-storage name privacy.md gives must be the one the code uses."""
    text = PRIVACY.read_text(encoding="utf-8")
    base = REGISTRY.parent
    for key, source in (
        ("qc-saved-places", "saved-places.js"),
        ("qc-field-maps-display-prefs", "view-wiring.js"),
        ("quiet-corners-field-maps", "project-store.js"),
    ):
        assert key in (base / source).read_text(encoding="utf-8"), f"fixture changed: {key} left {source}"
        assert key in text, f"privacy.md does not name the storage key {key!r}"


def test_privacy_third_party_claims_do_not_contradict_diagram_loading() -> None:
    text = " ".join(PRIVACY.read_text(encoding="utf-8").split())
    assert "from nowhere else on this site" not in text
    assert "The one other third party is the script host described under Diagram loading" in text
    assert "the county data files" in text and "the map data files" not in text


def test_privacy_states_how_local_data_is_cleared() -> None:
    text = PRIVACY.read_text(encoding="utf-8")
    for control in ("Remove", "Clear saved places", "Clear print area", "Reset view", "Download", "Import"):
        assert control in text, f"privacy.md does not mention the {control!r} control"


def test_privacy_dated_after_the_inventory_check() -> None:
    text = PRIVACY.read_text(encoding="utf-8")
    assert "Last reviewed 20 October 2026." in text


def _normalized(path: Path) -> str:
    return " ".join(path.read_text(encoding="utf-8").split())


def test_privacy_discloses_that_a_street_address_pick_sends_a_point_to_the_nws() -> None:
    """QQA-04b: choosing a street match calls showSky, which asks api.weather.gov for the
    forecast and alerts at the matched point (the street estimate, rounded to four
    decimals). The sentence that lists what sends coordinates to the National Weather
    Service must name a street-address match, not only a county, a town or Before you go."""
    text = _normalized(PRIVACY)
    start = text.index("Picking a county")
    sentence = text[start : text.index("api.weather.gov", start)]
    assert "street" in sentence.lower(), sentence


def test_quiet_corners_page_discloses_that_a_street_address_pick_asks_the_nws() -> None:
    text = _normalized(QUIET_CORNERS)
    start = text.index("Picking one moves the map there")
    sentence = text[start : text.index("When no street matches", start)]
    assert "National Weather Service" in sentence, sentence
