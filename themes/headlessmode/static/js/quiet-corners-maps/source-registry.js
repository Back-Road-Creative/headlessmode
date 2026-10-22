/* Quiet Corners Field Maps — source registry.
 *
 * The single record of the government map services the /quiet-corners/maps/
 * page fetches directly from the browser. Pure data plus one pure derivation;
 * no imports, no network. Every value is a measurement from 2026-09-05 (see
 * `measuredOn`), not a guess. static/_headers opens the page's CSP to exactly
 * these origins, and scripts/qcm/csp.test.mjs keeps the two in lock-step.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** What KIND of statement a source makes about the ground, as DATA rather than as prose a
 *  caller has to read and interpret. Every entry in SOURCES carries one, and every value is
 *  derived from that source's own `coverageSemantics` rather than chosen:
 *
 *  'observation'  a reading of something that happened, at a time in the past
 *  'forecast'     a statement about a time that has not arrived
 *  'inventory'    a published compilation with a vintage -- a basemap, a boundary set, a
 *                 catalogue of sites, an annual composite
 *  'model'        a computed surface between the places anything was measured
 *  'calculation'  arithmetic over another source's values
 *
 *  It is not documentation. The page shows an active surface's OWN time, and this is what
 *  decides WHICH time that is: a forecast shows the time it is for, an observation the time
 *  it was taken, an inventory its vintage. Retrieval time is never any of them. Adding a
 *  source without declaring one fails scripts/qcm/registry.test.mjs.
 */
export const CLAIMS = Object.freeze(['observation', 'forecast', 'inventory', 'model', 'calculation']);

const MEASURED_ON = '2026-09-05';
const USGS_TERMS_URL =
  'https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map';
const USGS_TOPO_SERVICE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer';
const USGS_IMAGERY_SERVICE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer';
const USGS_RELIEF_SERVICE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer';
/** A screen base on the topo host. Measured 2026-09-12 with `Origin: https://headlessmode.com`:
 *  image/jpeg, `access-control-allow-origin: *`, max-age=86400; ?f=json declares 24 LODs but
 *  the cache stops at `top`, the level after it answering 404. Same origin as usgsTopo, so the
 *  CSP's img-src does not change. Read as an <img> by Leaflet, never fetched into a build. */
const basemapTiles = (id, name, service, top, attribution, coverageSemantics) => ({
  id, name, kind: 'raster-tiles', origin: 'https://basemap.nationalmap.gov',
  serviceUrl: service, metadataUrl: `${service}?f=pjson`,
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  tile: { size: 256, format: 'JPEG', urlTemplate: `${service}/tile/{z}/{y}/{x}`,
    maxCachedLevelObserved: top, [`level${top + 1}Observed`]: 404 },
  limits: { exportTilesAllowed: true, maxExportTilesCount: 100000 },
  pagination: false, cors: 'star', attribution, termsUrl: USGS_TERMS_URL,
  // A tile cache is a published compilation with a vintage, never a reading of now --
  // imagery flown on a multi-year cycle included.
  dateBasis: 'service-metadata', claim: 'inventory', coverageSemantics, measuredOn: '2026-09-12',
});
const USGS_INDEX_SERVICE = 'https://carto.nationalmap.gov/arcgis/rest/services/map_indices/MapServer';
// MRLC's own www.mrlc.gov -- the endpoint the plan names -- answered NONE of 33 probes over
// 19 minutes on 2026-09-15: TLS completes against a genuine USGS certificate and then no HTTP
// response arrives. Not a sandbox block (api.weather.gov and basemap.nationalmap.gov answered
// 200 from the same shell seconds before). The same two USGS products are published as ArcGIS
// ImageServers on the USDA Forest Service's Imagery and Image Products Platform, which is the
// only route measured working -- a different publisher's mirror, with no uptime promise.
const NLCD_IIPP = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation';
const NLCD_LANDCOVER_SERVICE = `${NLCD_IIPP}/USFS_EDW_NLCD_Landcover_CONUS/ImageServer`;
const NLCD_CANOPY_SERVICE = `${NLCD_IIPP}/USFS_EDW_NLCD_TCC_CONUS/ImageServer`;
const NLCD_TERMS_URL = 'https://data.fs.usda.gov/geodata/rastergateway/treecanopycover/';
/** A MOSAIC of annual rasters, not one picture, and the rule is MANDATORY on every request:
 *  without it the service answers whatever its default Northwest/First rule picks (measured:
 *  silently the newest year) and a point query costs 155,647 bytes instead of 4,250.
 *  `beginyear` is a plain integer, never epoch milliseconds. */
const NLCD_MOSAIC_RULE = '{"mosaicMethod":"esriMosaicAttribute","where":"beginyear={year}"}';
const GOVUNITS_SERVICE = 'https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer';
const USFS_MVUM_SERVICE = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer';
const FEMA_NFHL_SERVICE = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
// Every FLD_ZONE value the service holds NATIONALLY, read off its own returnDistinctValues
// over layer 28 -- 10 codes across 72 (FLD_ZONE, ZONE_SUBTY) pairs -- not a list copied from a
// FEMA PDF. The prose is FEMA's published meaning, which is the one thing here that cannot be
// read from the service: every field of layer 28 answers `domain: None`, so no coded-value
// label exists to quote and the wording is ours with the agency named beside it.
const FEMA_FLOOD_ZONES = {
  A: 'High risk, a 1% annual chance of flooding. No base flood elevation was determined.',
  AE: 'High risk, a 1% annual chance of flooding, with a base flood elevation determined.',
  AH: 'High risk, a 1% annual chance of shallow ponding, one to three feet.',
  AO: 'High risk, a 1% annual chance of shallow sheet flow, one to three feet.',
  A99: 'High risk, a 1% annual chance, with a federal flood-protection system under construction.',
  V: 'High risk coastal, a 1% annual chance with wave action. No base flood elevation determined.',
  VE: 'High risk coastal, a 1% annual chance with wave action, base flood elevation determined.',
  D: 'UNDETERMINED. No flood-hazard analysis has been conducted here, which is not a finding of low risk.',
  X: 'Outside the 1% annual-chance floodplain. Read ZONE_SUBTY: an X can be the 0.2% annual-chance '
    + 'area, or minimal hazard, or an area behind a levee, and those are not the same thing.',
  'OPEN WATER': 'Mapped open water, not a hazard designation.',
};
const USFS_OWNERSHIP_SERVICE = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_SurfaceOwnership_01/MapServer';
const BLM_REC_SERVICE = 'https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer/1';
// BARE endpoints, with no filter template behind them. See the gbifOccurrence entry: the
// credential check is a substring match, and `taxonKey=`/`datasetKey=` contain `key=`.
const GBIF_SEARCH_SERVICE = 'https://api.gbif.org/v1/occurrence/search';
const GBIF_DATASET_SERVICE = 'https://api.gbif.org/v1/dataset';
const NTAD_RAIL_SERVICE = 'https://geo.dot.gov/server/rest/services/Hosted/North_American_Class_1_Rail/FeatureServer/0';
const NTAD_AIRPORTS_SERVICE = 'https://geo.dot.gov/server/rest/services/Hosted/Airports_/FeatureServer/0';
// The rail layer's WHOLE field list, as measured; the airport list is the SELECTION this map asks
// for (the service carries about a hundred more, among them airport, locid, ownership and elevation).
const NTAD_RAIL_FIELDS = ['objectid', 'fraarcid', 'frfranode', 'tofranode', 'stfips', 'cntyfips', 'stcntyfips',
  'stateab', 'country', 'fraregion', 'rrowner1', 'rrowner2', 'rrowner3', 'trkrghts1', 'trkrghts2', 'trkrghts3',
  'trkrghts4', 'trkrghts5', 'trkrghts6', 'trkrghts7', 'trkrghts8', 'trkrghts9', 'subdiv', 'yardname', 'passngr',
  'stracnet', 'tracks', 'direction', 'carddirect', 'net', 'miles', 'km', 'timezone', 'im_rt_type', 'ds',
  'area_length_miles', 'SHAPE__Length'];
const NTAD_AIRPORT_FIELDS = ['loc_id', 'fac_name', 'fac_type', 'fac_use', 'city', 'state_name', 'owner_type',
  'status_code', 'atc_tower', 'icao_identifier', 'role', 'category', 'hub'];
const NPS_NRHP_SERVICE = 'https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer';
const NPS_NRHP_FIELDS = ['RESNAME', 'NRIS_Refnum', 'CertDate', 'City', 'State', 'STATUS'];
const AIRNOW_AQI_SERVICE = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/AirNowLatestContoursCombined/FeatureServer/0';
// gridcode -> the label the service's own renderer gives that value, word for word.
const AIRNOW_AQI_CATEGORIES = { 1: 'Good', 2: 'Moderate', 3: 'Unhealthy for Sensitive Groups', 4: 'Unhealthy', 5: 'Very Unhealthy', 6: 'Hazardous' };
const PADUS_ACCESS_SERVICE = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS_Public_Access/FeatureServer/0';
// The service's OWN field description, word for word. There are exactly four values and
// `UK` is never null and never empty: `Pub_Access IS NULL OR Pub_Access=''` returned
// {"count":0} across all 305,960 records. The layer's own renderer defines classes for
// RA, OA and XA ONLY, so a picture drawn with its symbology silently loses the 43,047
// UK records a /query returns. Unknown is decided here instead of inherited.
const PADUS_ACCESS_VALUES = {
  OA: 'Open — no special requirements for public access (may include regular hours of availability)',
  RA: 'Restricted — a special permit from the owner, a registration permit on public land, or highly variable open times',
  XA: 'Closed — no public access is allowed',
  UK: 'Unknown — information is not currently available',
};
// Exactly what a row renders. GIS_AcrsDb, GAP_Sts, IUCN_Cat, Category, BndryName and the
// rest are in the layer and unrequested: asking for a field the layer lacks is answered
// HTTP 200 with an error object and no `features` key at all.
const PADUS_FIELDS = ['Unit_Nm', 'Pub_Access', 'GIS_Acres', 'MngNm_Desc', 'DesTp_Desc', 'ST_Name'];
// Exactly what a card renders; Keywords, ActivityNames, StayLimit, the reservation URL,
// the phone and the email are in the layer and not asked for -- nothing draws them.
const BLM_REC_FIELDS = ['RecAreaName', 'RecAreaDescription', 'RecAreaDirections',
  'LastUpdatedDate', 'BLMRecURL', 'RecAreaFeeDescription'];
// THE KMZ, ALREADY OPENED. NOAA's own file host (satepsanone.nesdis.noaa.gov) returns the
// daily smoke KML with NO access-control-allow-origin header at all, so a browser fetch of it
// fails outright; NESDIS's Satellite Analysis Branch republishes the same analysis as an
// ordinary feature layer, carrying exactly the 103 features that day's KML carried. Nothing
// unzips an archive, nothing parses KML, and the literal parentheses are the publisher's own.
const HMS_SMOKE_SERVICE = 'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0';
// The service's OWN three classes and the column concentrations NOAA says they approximate,
// while stating no guarantee is made about the actual density.
const HMS_DENSITY_CLASSES = {
  Light: { order: 1, approxMicrogramsPerCubicMetre: [0, 10] },
  Medium: { order: 2, approxMicrogramsPerCubicMetre: [10, 21] },
  Heavy: { order: 3, approxMicrogramsPerCubicMetre: [21, 32] },
};
const WFIGS_PERIMETERS_SERVICE = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0';
const WFIGS_INCIDENT_CATEGORIES = { WF: 'Wildfire', RX: 'Prescribed fire', CX: 'Complex' };
// TWELVE of the layer's 119 fields. The other 107 are personnel counts, cost estimates,
// legal descriptions and fuel models -- none of them drawn, so none asked for.
const WFIGS_FIELDS = ['poly_IncidentName', 'poly_GISAcres', 'poly_PolygonDateTime',
  'poly_DateCurrent', 'poly_MapMethod', 'attr_IncidentTypeCategory', 'attr_PercentContained',
  'attr_ContainmentDateTime', 'attr_FireDiscoveryDateTime', 'attr_IncidentSize',
  'attr_POOState', 'attr_UniqueFireIdentifier'];
const USFS_MVUM_FIELDS = [
  'objectid', 'id', 'name', 'symbol', 'mvum_symbol_name', 'seasonal',
  'passengervehicle', 'passengervehicle_datesopen',
  'highclearancevehicle', 'highclearancevehicle_datesopen',
  'forestname', 'districtname', 'routestatus', 'jurisdiction', 'surfacetype',
];

const NWI_ROOT = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services';
const NWI_WETLANDS_SERVICE = `${NWI_ROOT}/Wetlands/MapServer`;
const NWI_STATUS_SERVICE = `${NWI_ROOT}/Wetlands_Status/MapServer`;
const NWI_SOURCE_SERVICE = `${NWI_ROOT}/Data_Source/MapServer`;
// The service's OWN renderer classes, word for word off `.../0?f=json` drawingInfo.
// Eight and only eight; there is no default symbol and no ninth class, so `Other`
// is one of FWS's classes rather than a fallback this app invented.
const NWI_WETLAND_TYPES = ['Estuarine and Marine Deepwater', 'Estuarine and Marine Wetland',
  'Freshwater Emergent Wetland', 'Freshwater Forested/Shrub Wetland', 'Freshwater Pond',
  'Lake', 'Other', 'Riverine'];
// Layer 0 is a JOIN of Wetlands to NWI_Wetland_Codes, so every field name is
// TABLE-QUALIFIED. Asking for a bare `ATTRIBUTE` fails the whole query (200 with an
// error body). OBJECTID leads because the pager dedupes on it -- see source-wetlands.js.
const NWI_WETLAND_FIELDS = ['Wetlands.OBJECTID', 'Wetlands.ATTRIBUTE',
  'Wetlands.WETLAND_TYPE', 'Wetlands.ACRES'];

// Caltrans CWWP2 district feeds, one per district (data/dN/cctv/cctvStatusDNN.json). The box on each
// area is the district's measured camera extent (2026-10-04 feeds, every located camera) rounded
// out by 0.1 degree -- a bound a camera must fall inside, not an administrative boundary.
const CALTRANS_CCTV_BASE = 'https://cwwp2.dot.ca.gov/data';
const CALTRANS_COVERAGE_AREAS = Object.freeze([
  { id: 'ca-d01', name: 'District 1 (North Coast)', serviceUrl: `${CALTRANS_CCTV_BASE}/d1/cctv/cctvStatusD01.json`, bbox: { minLon: -124.3, minLat: 38.6, maxLon: -122.5, maxLat: 42.1 } },
  { id: 'ca-d02', name: 'District 2 (Northeastern California)', serviceUrl: `${CALTRANS_CCTV_BASE}/d2/cctv/cctvStatusD02.json`, bbox: { minLon: -123.1, minLat: 39.6, maxLon: -119.9, maxLat: 42.1 } },
  { id: 'ca-d03', name: 'District 3 (Sacramento area)', serviceUrl: `${CALTRANS_CCTV_BASE}/d3/cctv/cctvStatusD03.json`, bbox: { minLon: -122.3, minLat: 37.9, maxLon: -119.8, maxLat: 39.9 } },
  { id: 'ca-d04', name: 'District 4 (San Francisco Bay Area)', serviceUrl: `${CALTRANS_CCTV_BASE}/d4/cctv/cctvStatusD04.json`, bbox: { minLon: -122.9, minLat: 36.8, maxLon: -121.4, maxLat: 38.7 } },
  { id: 'ca-d05', name: 'District 5 (Central Coast)', serviceUrl: `${CALTRANS_CCTV_BASE}/d5/cctv/cctvStatusD05.json`, bbox: { minLon: -122.2, minLat: 34.2, maxLon: -119.3, maxLat: 37.3 } },
  { id: 'ca-d06', name: 'District 6 (Fresno area)', serviceUrl: `${CALTRANS_CCTV_BASE}/d6/cctv/cctvStatusD06.json`, bbox: { minLon: -120.9, minLat: 34.7, maxLon: -118.7, maxLat: 37.5 } },
  { id: 'ca-d07', name: 'District 7 (Los Angeles and Ventura)', serviceUrl: `${CALTRANS_CCTV_BASE}/d7/cctv/cctvStatusD07.json`, bbox: { minLon: -119.4, minLat: 33.6, maxLon: -117.5, maxLat: 34.9 } },
  { id: 'ca-d08', name: 'District 8 (Inland Empire)', serviceUrl: `${CALTRANS_CCTV_BASE}/d8/cctv/cctvStatusD08.json`, bbox: { minLon: -117.9, minLat: 33.3, maxLon: -114.4, maxLat: 35.8 } },
  { id: 'ca-d09', name: 'District 9 (Eastern Sierra)', serviceUrl: `${CALTRANS_CCTV_BASE}/d9/cctv/cctvStatusD09.json`, bbox: { minLon: -119.6, minLat: 34.8, maxLon: -117.7, maxLat: 38.5 } },
  { id: 'ca-d10', name: 'District 10 (Stockton)', serviceUrl: `${CALTRANS_CCTV_BASE}/d10/cctv/cctvStatusD10.json`, bbox: { minLon: -121.8, minLat: 36.8, maxLon: -119.8, maxLat: 38.6 } },
  { id: 'ca-d11', name: 'District 11 (San Diego and Imperial)', serviceUrl: `${CALTRANS_CCTV_BASE}/d11/cctv/cctvStatusD11.json`, bbox: { minLon: -117.5, minLat: 32.4, maxLon: -115.3, maxLat: 33.5 } },
  { id: 'ca-d12', name: 'District 12 (Orange County)', serviceUrl: `${CALTRANS_CCTV_BASE}/d12/cctv/cctvStatusD12.json`, bbox: { minLon: -118.2, minLat: 33.2, maxLon: -117.4, maxLat: 34.1 } },
].map((area) => Object.freeze({ ...area, bbox: Object.freeze(area.bbox) })));

export const SOURCES = deepFreeze({
  usgsTopo: {
    id: 'usgsTopo',
    name: 'USGS Topo basemap',
    kind: 'raster-tiles',
    origin: 'https://basemap.nationalmap.gov',
    serviceUrl: USGS_TOPO_SERVICE,
    metadataUrl: `${USGS_TOPO_SERVICE}?f=pjson`,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    tile: {
      size: 256,
      format: 'JPEG',
      urlTemplate: `${USGS_TOPO_SERVICE}/tile/{z}/{y}/{x}`,
      maxCachedLevelObserved: 16,
      level17Observed: 404,
      resolutionAtLevel16MetersPerPixelEquator: 2.389,
    },
    limits: { exportTilesAllowed: true, maxExportTilesCount: 100000 },
    pagination: false,
    cors: 'star',
    attribution: 'USGS The National Map: National Boundaries Dataset, 3DEP Elevation Program, '
      + 'Geographic Names Information System, National Hydrography Dataset, National Land Cover '
      + 'Database, National Structures Dataset, and National Transportation Dataset; USGS Global '
      + 'Ecosystems; U.S. Census Bureau TIGER/Line data',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // The national topographic compilation, not a reading of today.
    claim: 'inventory',
    coverageSemantics: 'Tile cache observed populated through level 16 in the test area; level 17 '
      + 'returned 404 there. A tile the service does not return is a blocking failure, never blank paper.',
    measuredOn: MEASURED_ON,
  },
  usgsImagery: basemapTiles('usgsImagery', 'USGS Imagery Only basemap', USGS_IMAGERY_SERVICE, 16,
    'USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024.',
    'Aerial imagery as flown, on a multi-year cycle: it shows ground cover at the time of the '
      + 'flight, not legal access. Cached through level 16 in the test area; level 17 returned 404.'),
  usgsShadedRelief: basemapTiles('usgsShadedRelief', 'USGS Shaded Relief Only basemap', USGS_RELIEF_SERVICE, 13,
    'USGS The National Map: 3D Elevation Program. USGS Earth Resources Observation & Science (EROS) Center',
    'The shape of the ground, not what is on it. Cached through level 13 in the test area; level 14 '
      + 'returned 404, so closer in the same picture is enlarged.'),
  usgsQuadIndex: {
    id: 'usgsQuadIndex',
    name: 'USGS 7.5-minute quadrangle index',
    kind: 'feature-query',
    origin: 'https://carto.nationalmap.gov',
    serviceUrl: USGS_INDEX_SERVICE,
    metadataUrl: `${USGS_INDEX_SERVICE}?f=pjson`,
    layers: [{
      id: 10,
      name: '7.5 Minute (1:24K) Index',
      queryUrl: `${USGS_INDEX_SERVICE}/10/query`,
      geometryType: 'esriGeometryPolygon',
      fields: ['CELL_ID', 'CELL_NAME', 'PRIMARY_STATE', 'STATE_ALPHA', 'CELL_MAPCODE'],
    }],
    // Not recorded in the 2026-09-05 measurement; requests must pass outSR explicitly.
    spatialReference: null,
    limits: { maxRecordCount: 2000 },
    pagination: true,
    cors: 'star',
    attribution: 'U. S. Geological Survey - National Geospatial Program. Data Refreshed July, 2026.',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // A published index of quadrangle cells.
    claim: 'inventory',
    coverageSemantics: 'National quadrangle index: any cell intersecting the requested extent is returned.',
    measuredOn: MEASURED_ON,
  },
  gnisNames: {
    id: 'gnisNames',
    name: 'USGS Geographic Names Information System (GNIS)',
    kind: 'feature-query',
    // The zooms this source is asked at: terrain-names.js KINDS draws its lowest kind (place) from 8.
    zoomRange: { min: 8, max: 22 },
    // Same origin as the topo base, quad index and gov units, so this source
    // costs the CSP nothing: it is already in connect-src.
    origin: 'https://carto.nationalmap.gov',
    serviceUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer',
    metadataUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer?f=pjson',
    // MEASURED 2026-09-25. Layers 3/5/6/7 share fields gaz_id/gaz_name/
    // gaz_featureclass/fcode/state_alpha/county_name; no elevation field on any of
    // them. Layer 3/5/6 geometry is esriGeometryMultipoint (a name with several
    // points, e.g. a Valley or a split-county Summit, returns its FIRST point as
    // the anchor -- see terrain-names.js normalizeFeature); layer 7 is
    // esriGeometryPoint. Historical layers (11-14) are out of scope for this
    // source on purpose: normalizeFeature always sets historical: false.
    layers: [
      { id: 3, name: 'Populated Places', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/3/query', geometryType: 'esriGeometryMultipoint', fields: ['gaz_id', 'gaz_name', 'gaz_featureclass', 'fcode', 'state_alpha', 'county_name'] },
      { id: 5, name: 'Landforms', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5/query', geometryType: 'esriGeometryMultipoint', fields: ['gaz_id', 'gaz_name', 'gaz_featureclass', 'fcode', 'state_alpha', 'county_name'] },
      { id: 6, name: 'Streams (Mouth)', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/6/query', geometryType: 'esriGeometryMultipoint', fields: ['gaz_id', 'gaz_name', 'gaz_featureclass', 'fcode', 'state_alpha', 'county_name'] },
      { id: 7, name: 'Other Hydrographic Features', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/7/query', geometryType: 'esriGeometryPoint', fields: ['gaz_id', 'gaz_name', 'gaz_featureclass', 'fcode', 'state_alpha', 'county_name'] },
    ],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    // recordBudgetPerExtent is fetchBounded's default `cap` (source-terrain-names.js):
    // over that many features for a bounded query, the adapter refuses to draw
    // rather than page through thousands of names at low zoom.
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit', recordBudgetPerExtent: 1500 },
    pagination: true,
    cors: 'star',
    attribution: 'USGS Geographic Names Information System (GNIS) via The National Map',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // A published gazetteer compilation with a vintage, not a reading of today.
    claim: 'inventory',
    coverageSemantics: 'Named populated places and physical/hydrographic features from the federal '
      + 'gazetteer: points only, no elevation and no trails. A name with several points (a Valley, '
      + 'a Summit split across counties) is returned as one row per point or per county; callers '
      + 'take the first point as the anchor and dedupe by gaz_id. The service accepts injected '
      + '`where` text without validating it (measured 2026-09-25: an `OR 1=1` clause returned a '
      + 'count), so every caller here builds `where` through escapeLiteral, never by concatenation.',
    measuredOn: '2026-09-25',
  },
  usgsRoadNames: {
    id: 'usgsRoadNames',
    name: 'USGS National Map transportation (road names)',
    kind: 'feature-query',
    // Same origin as gnisNames, the trails layer and the topo base, so this source costs the
    // CSP nothing: it is already in connect-src.
    origin: 'https://carto.nationalmap.gov',
    serviceUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer',
    metadataUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer?f=pjson',
    // MEASURED 2026-10-05 (plain keyless GET, access-control-allow-origin: *, cache-control
    // max-age=0,must-revalidate). Five polyline layers, each carrying the fields below;
    // outSR 4326 is honoured. Layer 19 (the publisher's own labels) filters out names it has
    // retired with `name NOT LIKE '%Squaw%' AND name NOT LIKE '%SQUAW%'`; road-names queries
    // copy that filter so no name the publisher withdrew is shown. Route fields can hold a
    // comma list ("23,74"). The zoom each layer first appears at lives in road-names.js.
    layers: [
      { id: 29, name: 'Controlled-access Highways', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/29/query', geometryType: 'esriGeometryPolyline', fields: ['name', 'interstate', 'us_route', 'state_route', 'county_route', 'federal_lands_route', 'stco_fipscode', 'permanent_identifier'] },
      { id: 30, name: 'Secondary Highways', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/30/query', geometryType: 'esriGeometryPolyline', fields: ['name', 'interstate', 'us_route', 'state_route', 'county_route', 'federal_lands_route', 'stco_fipscode', 'permanent_identifier'] },
      { id: 31, name: 'Local Connecting Roads', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/31/query', geometryType: 'esriGeometryPolyline', fields: ['name', 'interstate', 'us_route', 'state_route', 'county_route', 'federal_lands_route', 'stco_fipscode', 'permanent_identifier'] },
      { id: 32, name: 'Local Roads', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/32/query', geometryType: 'esriGeometryPolyline', fields: ['name', 'interstate', 'us_route', 'state_route', 'county_route', 'federal_lands_route', 'stco_fipscode', 'permanent_identifier'] },
      { id: 35, name: '4WD Roads', queryUrl: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/35/query', geometryType: 'esriGeometryPolyline', fields: ['name', 'interstate', 'us_route', 'state_route', 'county_route', 'federal_lands_route', 'stco_fipscode', 'permanent_identifier'] },
    ],
    // The service reports its native reference as web mercator; requests pass outSR 4326.
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit' },
    pagination: true,
    cors: 'star',
    attribution: 'USGS The National Map: National Transportation Dataset; U.S. Census Bureau – TIGER/Line; U.S. Forest Service. Data Refreshed October, 2026.',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // A published, monthly-refreshed compilation with a vintage, not a reading of today.
    claim: 'inventory',
    coverageSemantics: 'Road names and route numbers from the federal transportation dataset: a name is '
      + 'a published label, not a statement that the road is open, maintained or passable. Local roads '
      + 'appear from zoom 13, so a sparse area can show fewer names than a driver would expect.',
    coverageCaveat: 'The dataset is CONUS-focused, so coverage outside the lower 48 is not assured, and '
      + 'it is refreshed monthly, so a very recent change may not appear yet.',
    measuredOn: '2026-10-05',
  },
  // Rivers and creeks, from the National Hydrography Dataset flowlines. The GNIS stream layer
  // (gnisNames layer 6) is a MOUTH point, so a view upstream of the mouth never contains it
  // (the Bitterroot's point is 25 miles north of Stevensville); these are lines, which cross
  // every view they run through. Its own host, so connect-src grows by one origin, which
  // gen-headers.mjs derives from this entry. See source-stream-names.js.
  nhdFlowlines: {
    id: 'nhdFlowlines',
    name: 'USGS National Hydrography Dataset flowlines (river and creek names)',
    kind: 'feature-query',
    zoomRange: { min: 9, max: 22 },
    origin: 'https://hydro.nationalmap.gov',
    serviceUrl: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer',
    metadataUrl: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer?f=pjson',
    // MEASURED 2026-10-06 with plain keyless GETs (scripts/qcm/fixtures/nhd-flowlines-2026-10-06.min.json):
    // access-control-allow-origin: *, maxRecordCount 2000, both polyline layers answer
    // statistics (supportsStatistics true) and outSR 4326. Layer 4 is the small-scale set
    // (UPPER-case fields, FTYPE a string, GNIS_ID unpadded) and layer 6 the large-scale set
    // (lower-case fields, ftype an integer code, gnis_id zero-padded to eight digits); the
    // scale limits are display hints, /query answers outside them. Neither carries a state
    // field (GNIS_ID is national) and unnamed reaches hold GNIS_NAME ' ' rather than NULL.
    // `orderByFields=<statistic alias> DESC` is rejected (HTTP 200, {"error":{"code":400}}),
    // so ranking by summed length is done client-side over the grouped answer. ftype keeps
    // StreamRiver (460) only: CanalDitch, ArtificialPath, Connector, Pipeline and Coastline
    // are never a named river or creek.
    layers: [
      { id: 4, name: 'Flowline - Small Scale', queryUrl: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/4/query', geometryType: 'esriGeometryPolyline', fields: ['GNIS_ID', 'GNIS_NAME', 'LENGTHKM', 'FTYPE', 'FCODE'], ftype: 'StreamRiver', zooms: { min: 9, max: 12 } },
      { id: 6, name: 'Flowline - Large Scale', queryUrl: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query', geometryType: 'esriGeometryPolyline', fields: ['gnis_id', 'gnis_name', 'lengthkm', 'ftype', 'fcode'], ftype: 460, zooms: { min: 13, max: 22 } },
    ],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit' },
    pagination: true,
    cors: 'star',
    attribution: 'USGS The National Map: National Hydrography Dataset (NHD).',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    claim: 'inventory',
    coverageSemantics: 'Named perennial and intermittent streams from the federal hydrography dataset: a name '
      + 'is a published label for a reach, not a statement that water is flowing or that the stream is '
      + 'passable. Only the longest names in a view are shown, ranked by total mapped length.',
    coverageCaveat: 'The dataset is CONUS-focused; names outside the lower 48 are not assured.',
    measuredOn: '2026-10-06',
  },
  usgsGovUnits: {
    id: 'usgsGovUnits',
    name: 'USGS National Map government units',
    kind: 'feature-query',
    // Same origin as the topographic base and the quadrangle index, so this layer
    // costs the CSP nothing: it is already in connect-src.
    origin: 'https://carto.nationalmap.gov',
    serviceUrl: GOVUNITS_SERVICE,
    metadataUrl: `${GOVUNITS_SERVICE}?f=pjson`,
    // MEASURED 2026-09-07, each by name over a real rectangle. BLM (36) is absent
    // on purpose -- its polygons are Field Offices, administrative jurisdictions
    // rather than holdings, and `Moab Field Office` spans 2,907 square miles of
    // mostly non-federal ground. See source-federal-land.js.
    layers: [
      { id: 29, name: 'National Park', queryUrl: `${GOVUNITS_SERVICE}/29/query`, geometryType: 'esriGeometryPolygon', fields: ['name', 'areasqkm'] },
      { id: 31, name: 'National Forest', queryUrl: `${GOVUNITS_SERVICE}/31/query`, geometryType: 'esriGeometryPolygon', fields: ['name', 'areasqkm'] },
      { id: 32, name: 'National Wilderness', queryUrl: `${GOVUNITS_SERVICE}/32/query`, geometryType: 'esriGeometryPolygon', fields: ['name', 'areasqkm'] },
      { id: 35, name: 'US Fish & Wildlife Service', queryUrl: `${GOVUNITS_SERVICE}/35/query`, geometryType: 'esriGeometryPolygon', fields: ['name', 'areasqkm'] },
      // 23 has NO `name` field -- asking for one fails the whole query. Measured 2026-09-08.
      { id: 23, name: 'County or Equivalent', queryUrl: `${GOVUNITS_SERVICE}/23/query`, geometryType: 'esriGeometryPolygon', fields: ['gnis_name', 'county_name', 'state_name', 'permanent_identifier'] },
    ],
    spatialReference: null,
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit' },
    pagination: true,
    cors: 'star',
    attribution: 'U. S. Geological Survey - National Geospatial Program, Government Units.',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // Designation boundaries as published, not observed.
    claim: 'inventory',
    coverageSemantics: 'Designation boundaries. A named unit arrives as several records, and a boundary encloses private inholdings that were never federal.',
    measuredOn: MEASURED_ON,
  },
  usfsMvum: {
    id: 'usfsMvum',
    name: 'USFS Motor Vehicle Use Map',
    kind: 'feature-query',
    origin: 'https://apps.fs.usda.gov',
    serviceUrl: USFS_MVUM_SERVICE,
    metadataUrl: `${USFS_MVUM_SERVICE}?f=pjson`,
    layers: [
      { id: 1, name: 'Motor Vehicle Use Map: Roads', queryUrl: `${USFS_MVUM_SERVICE}/1/query`, fields: USFS_MVUM_FIELDS },
      { id: 2, name: 'Motor Vehicle Use Map: Trails', queryUrl: `${USFS_MVUM_SERVICE}/2/query`, fields: USFS_MVUM_FIELDS },
    ],
    // Not recorded in the 2026-09-05 measurement; requests must pass outSR explicitly.
    spatialReference: null,
    // A partial page carries `exceededTransferLimit: true`; keep paging until it is absent.
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit' },
    pagination: true,
    // Access-Control-Allow-Origin echoes the request Origin (credentials true), not `*`.
    cors: 'reflects-origin',
    // Layer copyrightText is empty; the service-level copyright is the attribution.
    attribution: 'U.S. Forest Service Enterprise Map Services Program',
    termsUrl: 'https://data.fs.usda.gov/geodata/help.php',
    // Nothing uniform is published; record the retrieval time per build (FAILURE.noUniformDate).
    dateBasis: 'unknown',
    // The Forest Service route inventory, published unit by unit.
    claim: 'inventory',
    coverageSemantics: 'Published unit by unit; not every National Forest is included. An empty '
      + 'result can mean "no coverage" rather than "no routes", so coverage state must be reported.',
    measuredOn: MEASURED_ON,
  },
  usfsSurfaceOwnership: {
    id: 'usfsSurfaceOwnership',
    name: 'USFS surface ownership (Land Status Record System)',
    kind: 'feature-query',
    origin: 'https://apps.fs.usda.gov',   // same host as MVUM: costs the CSP nothing
    serviceUrl: USFS_OWNERSHIP_SERVICE,
    metadataUrl: `${USFS_OWNERSHIP_SERVICE}?f=pjson`,
    // `casename` is a PERSON ("SLAGLE, C. W.") and is never in this list. Measured 2026-09-10.
    layers: [{ id: 0, name: 'BdyOwn_LSRS_SurfaceOwnership', queryUrl: `${USFS_OWNERSHIP_SERVICE}/0/query`, geometryType: 'esriGeometryPolygon', fields: ['surfaceownershipid', 'ownerclassification', 'status', 'nfslandunitname'] }],
    spatialReference: null,
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit' },
    pagination: true,
    cors: 'reflects-origin',
    attribution: 'U.S. Forest Service Enterprise Map Services Program',
    termsUrl: 'https://data.fs.usda.gov/geodata/help.php',
    dateBasis: 'unknown',
    // A land-status RECORD, which is what an inventory is.
    claim: 'inventory',
    coverageSemantics: 'The Forest Service’s own land-status record, parcel by parcel: whose ground it '
      + 'is, not a survey of where the line lies and not a statement of access.',
    measuredOn: '2026-09-10',
  },
  usgs3dep: {
    id: 'usgs3dep',
    name: 'USGS 3DEP elevation',
    kind: 'feature-query',
    origin: 'https://elevation.nationalmap.gov',
    serviceUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    metadataUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=pjson',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    layers: [{
      id: 0,
      name: '3DEP elevation (getSamples)',
      queryUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples',
      fields: ['value'],
    }],
    limits: { maxPointsPerCall: 200 },
    pagination: false,
    cors: 'star',
    attribution: 'USGS 3D Elevation Program (3DEP)',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // A gridded surface interpolated between lidar returns, not a reading at your point.
    claim: 'model',
    coverageSemantics: 'Elevation is sampled at points along a drawn line, so it reflects the '
      + 'mapped route rather than the tread underfoot; a short steep pitch between samples can be '
      + 'missed. A NoData sample is bridged rather than read as a drop to zero.',
    measuredOn: '2026-09-06',
  },
  // The SAME origin as usgs3dep above and a different product entirely, which is why it is
  // its own entry: that one samples elevation at points along a drawn line (200 per call),
  // this one exports a rendered surface for a whole view. Two entries on one origin is the
  // established shape here -- usgsTopo, usgsImagery and usgsShadedRelief already share one --
  // and per cspDirectivesFor() a second entry on an origin already in connect-src costs the
  // policy nothing.
  usgs3depSurface: {
    id: 'usgs3depSurface',
    name: 'USGS 3DEP terrain slope and aspect',
    kind: 'raster-image',
    // No `paintedAs: 'img'`. The export is FETCHED as bytes and painted from a canvas, which
    // keeps this host out of img-src -- and is the only route that can read the alpha channel
    // that separates "no coverage" from "flat ground". See source-terrain-surface.js.
    origin: 'https://elevation.nationalmap.gov',
    serviceUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    metadataUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=pjson',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    // bboxSR is NOT optional. Omit it and ArcGIS reads a lon/lat bbox as Web Mercator metres,
    // landing every request in a sub-metre patch off West Africa and answering each one with
    // the SAME empty picture -- which happened on 2026-09-06 and was recorded against the
    // service rather than against the call.
    //
    // format png32 is not optional either, measured 2026-09-15: png, png8 and png24 all come
    // back as PNG colour-type 0, greyscale with no alpha and no tRNS, and a uint8 channel
    // cannot carry the -1 sentinel -- an ocean extent answers 4,096 pixels of 0, the same
    // number as flat ground. png32 answers RGBA with R=G=B=degrees and alpha 0 where the
    // model has nothing.
    request: { bboxSR: 4326, imageSR: 3857, format: 'png32', noData: -1,
      noDataInterpretation: 'esriNoDataMatchAny' },
    renderingRules: {
      slopeDegrees: { rasterFunction: 'Slope Degrees' },   // uint8, whole degrees 0-90
      slopePercent: { rasterFunction: 'Slope',             // float32, percent rise = tan(deg) * 100
        rasterFunctionArguments: { SlopeType: 2, ZFactor: 1 } },
      aspectDegrees: { rasterFunction: 'Aspect Degrees' }, // int16, 0-359 clockwise from north
    },
    // maxImageSide is THIS layer's cap, not the service's 8000: png32 at 512 square measured
    // 185,910 bytes over the steepest extent probed and 633,888 at 1024 square, and there is
    // no tile cache, so every pan is a live render. pointCellMetres is pinned on point reads
    // because the same point read 32.64 degrees at a 1 m cell and 27.25 at 270 m.
    limits: { maxImageSide: 512, serviceMaxImageSide: 8000, maxBytesObserved: 185910,
      pointCellMetres: 30, exportTilesAllowed: false },
    pagination: false,
    cors: 'star',
    attribution: 'USGS 3D Elevation Program (3DEP)',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // Arithmetic over measured elevations: a closed-form finite difference over a 3x3
    // neighbourhood, byte-identical across repeat calls. Not `model` -- nothing is simulated
    // or predicted -- and not `observation`, because nobody measured a slope.
    claim: 'calculation',
    coverageSemantics: 'Slope and aspect are ARITHMETIC on the elevation model, not measurements '
      + 'of the ground: the service reports the steepness of a cell, and the cell is whatever size '
      + 'the request asked for. The same hillside read 27.3 degrees at a 270 m cell and 39.6 at a '
      + '3 m cell, so a number means nothing without the window it describes. Slope is DEGREES; '
      + 'percent rise is tan(degrees) x 100 and roughly doubles the number, so the two are never '
      + 'interchangeable. Aspect is the downslope compass bearing, 0-359 clockwise from north, and '
      + 'it is UNDEFINED on flat ground -- this service marks flat as 0, the same value as due '
      + 'north, so flat is read off the SLOPE surface and never off the aspect surface. The service '
      + 'publishes no legend and no class breaks for its own colour ramps, so the picture it '
      + 'renders cannot be labelled; the site colours the numeric surface itself. There is no tile '
      + 'cache -- every extent is a live render. The elevation is bare earth: no trees, no '
      + 'buildings and no snow are in it.',
    measuredOn: '2026-09-15',
  },
  // The THIRD product on this same origin. usgs3dep samples elevation at points;
  // usgs3depSurface exports slope/aspect arithmetic; this exports a rendered HILLSHADE
  // picture -- an illustration of the model under a chosen light, never a measurement and
  // never a real shadow that fell on this ground. Probed 2026-09-25 (512x512 over the Blue
  // Ridge): azimuth 315 answered mean 173.7/sd 33.3, azimuth 135 answered mean 176.0/sd
  // 33.6, distinct md5s -- two lights paint the same ground differently. A flat Illinois
  // box held sd 1.4 regardless of light, because a hillshade of flat ground is flat under
  // every light. Ready-made rules on this service include Hillshade Gray, Hillshade
  // Multidirectional, Hillshade Elevation Tinted, Aspect Degrees, Slope Degrees and several
  // Contour rasterFunctions (a later, separate source). maxImageWidth/Height 8000; CORS *;
  // 3-8s per image, so `Q/source-hillshade.js` never retries automatically.
  usgs3depHillshade: {
    id: 'usgs3depHillshade',
    name: 'USGS 3DEP hillshade',
    kind: 'raster-image',
    origin: 'https://elevation.nationalmap.gov',
    serviceUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    metadataUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=pjson',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    // Same bboxSR/imageSR contract as usgs3depSurface just above, and for the identical
    // reason: omit bboxSR and ArcGIS reads a lon/lat bbox as Web Mercator METRES, landing
    // every US extent in a sub-metre patch off West Africa. No noData channel here --
    // format is plain `png`, because a hillshade picture has nothing to mark as missing
    // that alpha would help with; coverage is read from the base layer beneath it.
    request: { bboxSR: 4326, imageSR: 3857, format: 'png', f: 'image' },
    renderingRules: {
      // The fixed default: a readability light, not one direction's cast shadow. "Reset
      // light" in Q/source-hillshade.js returns here.
      fixed: { rasterFunction: 'Hillshade Multidirectional' },
      // Manual mode's Azimuth/Altitude are filled in per request by
      // Q/source-hillshade.js; ZFactor is pinned at 1 (no vertical exaggeration). NW/45,
      // azimuth 315 altitude 45, is the plan's first manual setting -- kept here as the
      // shape a manual request takes, not as the only azimuth/altitude pair ever sent.
      manual: { rasterFunction: 'Hillshade', rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 1 } },
    },
    // This layer's own budget, well under the service's 8000: a hillshade export carries
    // no NoData channel to shrink it and is re-rendered on every pan (no tile cache), so
    // Q/source-hillshade.js caps requests at 1024 square -- enough to fill a desktop
    // viewport at a sane device-pixel ratio without stalling a 3-8s-per-image service.
    limits: { maxImageSide: 1024, serviceMaxImageSide: 8000, exportTilesAllowed: false },
    pagination: false,
    cors: 'star',
    attribution: 'USGS 3D Elevation Program (3DEP)',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // An illustration of the model under a chosen light, not a reading of anything and not
    // a real shadow that ever fell on this ground.
    claim: 'model',
    coverageSemantics: 'A rendered relief picture from the national elevation model under a chosen '
      + 'light direction and altitude, not a measurement: two different lights painted the SAME '
      + 'Blue Ridge extent to different pixels (measured 2026-09-25, distinct md5s), and a flat '
      + 'Illinois box stayed flat under every light tried. It is not a cast-shadow, visibility, or '
      + 'passability calculation, and it says nothing about the sun at any real hour unless the '
      + 'reader explicitly asks for that hour -- and even then, sunlight below the horizon is '
      + 'reported as below the horizon rather than drawn as if it were day.',
    measuredOn: '2026-09-25',
  },
  // The FOURTH product on this origin: contour lines, the "later, separate source" the hillshade
  // comment above names. Measured 2026-10-20 (Great Smokies -83.6,35.6,-83.4,35.7, 512x512):
  // rasterFunctionInfos lists Contour 25, Contour Smoothed 25 and Preset 2ft/5ft/10ft Contour
  // Interval. CHOSEN: `Contour Smoothed 25` -- a 25 METRE interval, not feet. The US topo habit
  // is feet, but the feet presets answered 1.2 s (10 ft) and 4.2 s (5 ft) against 0.14-0.5 s for
  // Smoothed 25 over the same box, and a 5 ft preset is dense (102,675 bytes against 33,392 for
  // Smoothed 25 at png32). The interval is therefore metric and the caveat says so. format `png32`, not plain
  // `png`: png answers PNG colour-type 0 (greyscale, no alpha, an opaque white sheet) while png32
  // answers RGBA with transparent ground and opaque black lines, the only form that can lie over
  // the base map. An open-ocean box (-75,30,-74.8,30.1) answered 200 in 7.3 s, so there is no
  // automatic retry (source-hillshade.js's fetcher is reused). CORS `*`; no tile cache.
  usgs3depContours: {
    id: 'usgs3depContours',
    name: 'USGS 3DEP contour lines',
    kind: 'raster-image',
    origin: 'https://elevation.nationalmap.gov',
    serviceUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    metadataUrl: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=pjson',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    // bboxSR is NOT optional, for the reason given at usgs3depSurface above.
    request: { bboxSR: 4326, imageSR: 3857, format: 'png32', f: 'image' },
    renderingRules: {
      contour: { rasterFunction: 'Contour Smoothed 25' },
    },
    // Same 1024 budget as the hillshade: a live, uncached render per pan.
    limits: { maxImageSide: 1024, serviceMaxImageSide: 8000, exportTilesAllowed: false },
    pagination: false,
    cors: 'star',
    attribution: 'USGS 3D Elevation Program (3DEP)',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // Lines traced through a gridded model of the ground, then smoothed: derived, not surveyed.
    claim: 'model',
    coverageSemantics: 'Contour lines drawn on the fly from the national elevation model with the '
      + 'service\'s `Contour Smoothed 25` rule: one line per 25 METRES of elevation (about 82 feet), '
      + 'smoothed; the picture measured 2026-10-20 draws some lines heavier than others. They are '
      + 'derived from a gridded bare-earth model, not surveyed, so a small knoll or hollow between '
      + 'two lines is not drawn, and a line is not a spot height: the service labels no line with '
      + 'its elevation, and neither does this site. There is no tile '
      + 'cache -- every extent is a live render, up to several seconds -- and an area with no '
      + 'coverage draws nothing, which is not the same as flat ground.',
    measuredOn: '2026-10-20',
  },
  usdaNaip: {
    id: 'usdaNaip',
    name: 'USDA NAIP aerial imagery',
    kind: 'raster-image',
    origin: 'https://imagery.nationalmap.gov',
    serviceUrl: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer',
    metadataUrl: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer?f=pjson',
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { maxImageSide: 4000 },
    pagination: false,
    cors: 'star',
    attribution: 'USDA National Agriculture Imagery Program (NAIP), served by USGS',
    termsUrl: USGS_TERMS_URL,
    dateBasis: 'service-metadata',
    // Imagery flown on a multi-year cycle: a compilation with a vintage, like the basemaps.
    claim: 'inventory',
    // The trailing clause used to read "which 3DEP's exportImage did not". That was wrong and
    // it blamed a service for a caller bug: the 2026-09-06 3DEP calls omitted `bboxSR`, so
    // ArcGIS read their lon/lat boxes as Web Mercator metres and answered every one of them
    // with the same empty picture. Reproduced both ways 2026-09-15 — two distinct hashes with
    // `bboxSR=4326`, one identical hash without it.
    coverageSemantics: 'Flown on a multi-year cycle, so an aerial sheet can be several seasons '
      + 'old. It shows ground cover, not legal access. Verified 2026-09-06 to return distinct '
      + 'imagery per extent.',
    measuredOn: '2026-09-06',
  },
  // Live radar. Measured 2026-09-11 with an `Origin: https://headlessmode.com`
  // header: ?f=json answered 200 and echoed the Origin; exportImage returned a
  // 117,263-byte transparent PNG for a 512x512 Midwest extent; /tile/5/12/8
  // answered 404 with a 600-byte HTML body, so there is no tile cache to ask.
  // NOAA SWPC's OVATION aurora model. The ONE fact that shapes everything here is in
  // the payload's own fields: `Observation Time` and `Forecast Time` are 66 minutes
  // apart. This is an OUTLOOK, not a picture of the sky now -- the opposite of the
  // radar layer above, and the gate on it runs the other way.
  nlcdLandCover: {
    id: 'nlcdLandCover',
    name: 'Annual NLCD land cover (Collection 1.1)',
    kind: 'raster-image',
    // No `paintedAs: 'img'`. The export is FETCHED as bytes and handed to the overlay as a
    // blob: URL, which img-src already allows -- so the pair costs the policy one connect-src
    // host, 24 characters, rather than 48. See source-land-cover.js.
    origin: 'https://imagery.geoplatform.gov',
    serviceUrl: NLCD_LANDCOVER_SERVICE,
    metadataUrl: `${NLCD_LANDCOVER_SERVICE}?f=json`,
    spatialReference: { wkid: 102100, latestWkid: 3857 },   // already Web Mercator
    // 40 rasters, 1985-2024. The vintage is read from the service's own `description`
    // ("Annual NLCD, Collection 1.1 ... 1985-2024") and confirmed against the catalogue.
    time: { field: 'beginyear', endField: 'endyear', years: [1985, 2024], defaultObserved: 2024,
      mosaicRuleTemplate: NLCD_MOSAIC_RULE },
    limits: { requiresKey: false, pixelSizeMeters: 30, mosaicItems: 40, maxRecordCount: 1000,
      exportCacheMaxAgeSeconds: 43200, identifyBytesYearPinned: 4250,
      identifyBytesUnpinned: 155647, tileCache: false, serviceMaxImageSide: 100000 },
    pagination: false,
    cors: 'reflects-origin',   // echoes the request Origin with allow-credentials: true, never *
    attribution: 'These products were created by the Annual NLCD team at USGS EROS, Sioux Falls, SD. '
      + 'Served by the USDA Forest Service Imagery and Image Products Platform.',
    termsUrl: NLCD_TERMS_URL,
    dateBasis: 'service-metadata',   // the mosaic item's own beginyear, pinned per request
    claim: 'model',
    coverageSemantics: 'A CLASSIFIED estimate, not a look at the ground: every 30 m pixel is an '
      + 'algorithm\'s best guess at one of sixteen classes from Landsat, and USGS ships a separate '
      + '"Land Cover Confidence" product precisely because the guess can be wrong. It supports "this '
      + 'square of ground was mapped as deciduous forest in <year>" and nothing finer -- not what '
      + 'stands there now, not whether it is walkable, not who owns it, and never a count of trees. '
      + 'A 30 m pixel is about a quarter-acre, so a road, a creek and a clearing narrower than that '
      + 'vanish into whichever class won the pixel. The class NUMBERS are published nowhere -- '
      + 'rasterAttributeTable answers {} -- and were recovered by pairing raw and rendered pixels. '
      + 'CONUS ONLY: Alaska, Hawaii and the territories have NO land-cover service here and must be '
      + 'reported as outside coverage, not as blank ground.',
    measuredOn: '2026-09-15',
  },
  nlcdTreeCanopy: {
    id: 'nlcdTreeCanopy',
    name: 'NLCD percent tree canopy cover (v2025-6)',
    kind: 'raster-image',
    origin: 'https://imagery.geoplatform.gov',   // same host as nlcdLandCover: costs the CSP nothing
    serviceUrl: NLCD_CANOPY_SERVICE,
    metadataUrl: `${NLCD_CANOPY_SERVICE}?f=json`,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    // 0..100 is the percentage. 254 and 255 are NOT percentages and must never be averaged,
    // coloured on the ramp, or read as "no canopy" -- the service's own description names
    // them: 254 non-processing area, 255 background.
    values: { unit: 'percent', range: [0, 100], nonProcessing: 254, background: 255 },
    // 41 rasters, 1985-2025. The service's own `serviceDescription` still says v2023-5 and
    // 1985-2023 and CONTRADICTS its `description`; the catalogue sides with `description`
    // (newest item nlcd_tcc_conus_wgs84_v2025_6_20250101_20251231). Read the catalogue.
    time: { field: 'beginyear', endField: 'endyear', years: [1985, 2025], defaultObserved: 2025,
      mosaicRuleTemplate: NLCD_MOSAIC_RULE },
    limits: { requiresKey: false, pixelSizeMeters: 30, mosaicItems: 41, maxRecordCount: 1000,
      exportCacheMaxAgeSeconds: 43200, tileCache: false, serviceMaxImageSide: 100000 },
    pagination: false,
    cors: 'reflects-origin',
    attribution: 'Funding for this project was provided by the U.S. Forest Service (USFS). '
      + 'RedCastle Resources produced the dataset under contract to the USFS Field Services and '
      + 'Innovation Center Geospatial Office (FSIC-GO).',
    termsUrl: NLCD_TERMS_URL,
    dateBasis: 'service-metadata',
    claim: 'model',
    coverageSemantics: 'Modelled percent of a 30 m square that tree crowns cover, seen from above '
      + 'in one year. The service calls its own inputs "model outputs" and the NLCD version is then '
      + 'smoothed across years and masked against water and non-tree crops, so a single year\'s value '
      + 'is a number about a time series, not a measurement of one summer. 70% canopy is NOT 70% shade '
      + 'on a trail, says nothing about what is under the crowns, and nothing about season -- these are '
      + 'not leaf-on observations of a given day. CONUS here; coastal Alaska, Hawaii and PR/USVI are '
      + 'SEPARATE services and are outside this one\'s coverage.',
    measuredOn: '2026-09-15',
  },
  swpcAurora: {
    id: 'swpcAurora',
    name: 'NOAA SWPC OVATION aurora forecast',
    kind: 'gridded-forecast',
    origin: 'https://services.swpc.noaa.gov',
    serviceUrl: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    metadataUrl: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
    spatialReference: { wkid: 4326 },
    // Measured off the payload, not assumed. Longitudes run 0..359, NOT -180..180: a
    // US longitude of -90 is 270 in this grid, and converting is load-bearing.
    grid: { lonRange: [0, 359], latRange: [-90, 90], cellDegrees: 1, valueRange: [0, 15], points: 65160 },
    // ~900 KB for the whole globe, so it is fetched when the switch goes on and never
    // on first render. `cache-control: max-age=60` is the service's own.
    limits: { requiresKey: false, bytesApprox: 918727, maxAgeSeconds: 60, wholeGlobeOnly: true },
    pagination: false,
    cors: 'wildcard',
    attribution: 'NOAA Space Weather Prediction Center, OVATION aurora model',
    termsUrl: 'https://www.weather.gov/disclaimer',
    dateBasis: 'service-metadata',
    // Its own prose: "A FORECAST about an hour ahead, never an observation of now".
    claim: 'forecast',
    coverageSemantics: 'A FORECAST about an hour ahead, never an observation of now: the '
      + 'payload states its own observation and forecast times and they measured 66 minutes '
      + 'apart. It is the modelled chance of aurora overhead, not a reading of the sky, and '
      + 'it says nothing about cloud. Over the lower 48 it is usually flat zero -- all 1,560 '
      + 'cells there measured 0 at the probe, with the first non-zero values near 65N.',
    measuredOn: '2026-09-11',
  },

  // FEMA's National Flood Hazard Layer. The one entry here that is not about a moment at
  // all, and the reason its `claim` is 'model': a flood zone is an engineering study's
  // floodplain, adopted as regulation and drawn on a panel, so it belongs beside the
  // radar and the air-quality surface on the screen and never in the same sentence as
  // either. Three measurements shape every use of it, all 2026-09-15.
  //
  // THE SERVICE ROOT MOVED. `hazards.fema.gov/gis/nfhl/...`, which most FEMA
  // documentation still cites, answers 404 text/html with NO CORS header at all -- a
  // browser there fails opaquely. The live root is `/arcgis/rest/services/public/NFHL`.
  //
  // THE PAYLOAD. The geometry is un-generalized DFIRM at full study resolution. The 159
  // zones over one 0.12 x 0.07 degree envelope, asked for WITH geometry and WITHOUT
  // `maxAllowableOffset`, answered HTTP **200** carrying an 80-byte ArcGIS 500; with
  // `maxAllowableOffset=0.0003` the same 159 answered in 399,069 bytes. The offset is
  // part of the URL template, not an option a caller may forget.
  //
  // THE SENTINELS. 154 of those 159 carry `STATIC_BFE: -9999` and all 159 carry
  // `DEPTH: -9999`; all 14 panels carry `PRE_DATE: 9999-09-09`. Printed raw they read as
  // an elevation of minus ten thousand feet and a map effective in the year 9999.
  femaNfhl: {
    id: 'femaNfhl',
    name: 'FEMA National Flood Hazard Layer',
    kind: 'feature-query',
    origin: 'https://hazards.fema.gov',
    serviceUrl: FEMA_NFHL_SERVICE,
    metadataUrl: `${FEMA_NFHL_SERVICE}?f=json`,
    layers: [
      // 0 answers "is there a map here at all", and it is the ONLY layer that can: zero
      // features on 28 means "no study was ever published" in interior Alaska and
      // "nothing intersects this rectangle" everywhere else. 174-247 bytes, so it is
      // asked unconditionally. Its declared maxScale stops it DRAWING zoomed in; /query
      // ignores draw scale, verified at a 0.12-degree extent.
      { id: 0, name: 'NFHL Availability', queryUrl: `${FEMA_NFHL_SERVICE}/0/query`,
        geometryType: 'esriGeometryPolygon', fields: ['STUDY_ID'] },
      // 3 carries the VINTAGE, because layer 28 has no date field among its 24. The
      // effective date of a zone is a join to the panel under it, and it varies inside
      // one screen: this envelope returned panels effective 2012-11-02 and 2016-12-08.
      { id: 3, name: 'FIRM Panels', queryUrl: `${FEMA_NFHL_SERVICE}/3/query`,
        geometryType: 'esriGeometryPolygon',
        fields: ['DFIRM_ID', 'FIRM_PAN', 'PANEL_TYP', 'EFF_DATE', 'PRE_DATE', 'SCALE', 'BASE_TYP'] },
      // 28 is the hazard itself. `fields` is what the surface asks for, not the whole
      // list -- the other 15 are geometry, revert-to codes and ids nothing draws.
      { id: 28, name: 'Flood Hazard Zones', queryUrl: `${FEMA_NFHL_SERVICE}/28/query`,
        geometryType: 'esriGeometryPolygon', zones: FEMA_FLOOD_ZONES,
        fields: ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF', 'STATIC_BFE', 'V_DATUM',
          'DEPTH', 'LEN_UNIT', 'DFIRM_ID', 'SOURCE_CIT'] },
    ],
    spatialReference: { wkid: 4269 },   // NAD83 geographic: inSR and outSR on every request
    limits: {
      requiresKey: false,
      maxRecordCount: 2000,
      partialPageFlag: 'exceededTransferLimit',
      maxAllowableOffset: 0.0003,        // ~33 m, in outSR units; see the payload note above
      bytesGeneralized159Features: 399069,
      // A count gate in FRONT of the generalization: 29,016 zone polygons intersect one
      // 0.6 x 1.0 degree extent. Ask returnCountOnly first and refuse above the ceiling
      // rather than page fifteen times for a picture nobody can read at that zoom.
      maxFeaturesDrawn: 1500,
      // -9999 in STATIC_BFE and DEPTH, and 9999-09-09 in PRE_DATE. Declared here so the
      // adapter reads them from the measured record rather than from a magic number.
      noValue: -9999,
      nullDateMs: 253392451200000,
    },
    pagination: true,
    cors: 'reflects-origin',             // the Origin echoed, with vary: Origin
    attribution: 'Federal Emergency Management Agency, National Flood Hazard Layer',
    termsUrl: 'https://www.fema.gov/flood-maps/national-flood-hazard-layer',
    dateBasis: 'feature-field',          // EFF_DATE, on layer 3 -- never on the zone record
    // A computed surface between the places anything was measured, which is exactly what an
    // engineering study's floodplain is. NOT an observation: 'observation' would make the page
    // offer this a moment, and the honest answer is that it has none a screen can carry.
    claim: 'model',
    coverageSemantics: 'A REGULATORY MAP, not a reading: the modelled 1%-annual-chance floodplain '
      + 'from an engineering study, adopted for insurance and floodplain management. It says '
      + 'nothing about where water is now and must never be drawn as, or beside, a live gage or a '
      + 'weather alert. Three states must be told apart and all three are separately queryable. NO '
      + 'MAP: layer 0 returns no features, as two interior-Alaska extents did. MAPPED BUT '
      + 'UNSTUDIED: layer 0 returns a study and the zone is D, undetermined. MAPPED AND STUDIED: a '
      + 'zone letter with a panel behind it. Vintage is per PANEL and varies inside one screen -- '
      + 'one 0.12 x 0.07 degree extent carried panels effective 2012-11-02 and 2016-12-08, four '
      + 'years apart -- so one effective date may never be printed for a view. And an X is not one '
      + 'thing: read ZONE_SUBTY, where 0.2%-annual-chance, minimal-hazard and levee-reduced areas '
      + 'all arrive as X.',
    measuredOn: '2026-09-15',
  },
  nwsRadar: {
    id: 'nwsRadar',
    name: 'NWS base reflectivity (MRMS radar mosaic)',
    kind: 'raster-image',
    origin: 'https://mapservices.weather.noaa.gov',
    serviceUrl: 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer',
    metadataUrl: 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer?f=json',
    spatialReference: { wkid: 3857 },   // the service's own 102100: nothing to reproject
    // The export goes straight into a Leaflet image overlay, so the browser fetches it
    // as an <img> and the CSP needs img-src, not just connect-src.
    paintedAs: 'img',
    // The service's own ceiling and ground resolution, read off ?f=json.
    limits: { requiresKey: false, maxImageWidth: 15000, maxImageHeight: 4100, pixelSizeMeters: 564.774 },
    // A ROLLING window, not an archive: the time extent measured 118 minutes wide,
    // and the fields it is keyed on are the service's own.
    time: { dimension: 'idp_validtime', endField: 'idp_validendtime', windowMinutes: 118 },
    pagination: false,
    cors: 'reflects-origin',
    attribution: 'NOAA National Weather Service, Multi-Radar/Multi-Sensor System (MRMS)',
    termsUrl: 'https://www.weather.gov/disclaimer',
    dateBasis: 'service-metadata',
    // Its own prose: "an observation of the last few minutes and never an outlook".
    claim: 'observation',
    coverageSemantics: 'Base reflectivity is what the beam met ALOFT, not what reached the '
      + 'ground: a beam clears an intervening ridge, and a light return can be dry air or '
      + 'birds. It is an observation of the last few minutes and never an outlook.',
    measuredOn: '2026-09-11',
  },
  // NOAA NOHRSC's Snow Analysis, layer 3 (snow depth) of a two-layer MapServer; layer 7 is
  // snow water equivalent and is never asked for. Same host as nwsRadar above, so the CSP
  // costs nothing: the export is FETCHED as bytes (connect-src) and handed to the overlay as
  // a blob: URL, which img-src already allows. Measured 2026-10-20 with an
  // `Origin: https://headlessmode.com` header: ?f=json and export answered 200 with the Origin
  // echoed; maxImageWidth/Height 4096; no tile cache and no time dimension. /legend lists 12
  // bins for layer 3, "0 - 0.39" to "394 - 787", and NO unit appears in the service, layer or
  // legend metadata -- so none is stated here. A view inside coverage with no snow (Great
  // Smokies) and one outside it (Spain) answered the identical 2,231-byte transparent PNG,
  // so modelled zero and no data cannot be told apart.
  nohrscSnowDepth: {
    id: 'nohrscSnowDepth',
    name: 'NOAA NOHRSC modelled snow depth',
    kind: 'raster-image',
    origin: 'https://mapservices.weather.noaa.gov',
    serviceUrl: 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer',
    metadataUrl: 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer?f=json',
    spatialReference: { wkid: 4269 },   // the service's own; the export is requested in 3857
    layers: { depth: 3, sweNotUsed: 7 },
    // bboxSR is NOT optional (see usgs3depSurface); png32 keeps the empty ground transparent.
    request: { bboxSR: 4326, imageSR: 3857, format: 'png32', transparent: true, f: 'image' },
    limits: { requiresKey: false, maxImageSide: 1024, serviceMaxImageSide: 4096,
      pixelSizeMeters: 1000, legendBins: 12, exportTilesAllowed: false },
    pagination: false,
    cors: 'reflects-origin',
    attribution: 'NOAA National Weather Service, National Operational Hydrologic Remote Sensing '
      + 'Center (NOHRSC), National Snow Analysis',
    termsUrl: 'https://www.weather.gov/disclaimer',
    dateBasis: 'unknown',   // the service states a cadence, not the valid time of the picture
    // Its own description: a snow MODEL at 1 km that assimilates ground, air and satellite snow
    // observations daily. An analysis, not a measurement at your location.
    claim: 'model',
    coverageSemantics: 'A MODELLED snow depth on a 1 km grid, from an energy-and-mass-balance snow '
      + 'model that takes in ground, airborne and satellite snow observations once a day: an '
      + 'analysis, not a measurement where you stand. A 1 km square averages out what a slope, a '
      + 'tree line or a road cut does to snow, so it can miss local drifts and bare ridges. The '
      + 'service states no unit for its 12 bins, so none is stated here. An empty (transparent) '
      + 'area is either modelled zero or no data and the service does not let the two be told '
      + 'apart; the coverage is the coterminous United States. SNOTEL sites report measured depth '
      + 'in the West; this is the surface that fills in between sites, and in the East.',
    measuredOn: '2026-10-20',
  },
  // The USGS Protected Areas Database, read for its ACCESS field rather than its
  // boundaries — which usgsGovUnits already draws. Three measurements shape every use of
  // it and none of them is guessable from the documentation.
  //
  // The served view is ALREADY FLATTENED, contrary to USGS's own web-services page: 190
  // random point probes returned at most ONE record each, and the Superior National Forest
  // fee polygon has the Boundary Waters wilderness cut out of it (1,072,029 acres against
  // Superior's ~2.09M NFS acres, the difference being the wilderness's 1,098,221). So
  // designations do not stack here and nothing needs de-overlapping. That is a MEASURED
  // property of a service USGS republishes, not a contract USGS states: re-measure it.
  //
  // `GIS_Acres` is still a live hazard, for a different reason. It is the WHOLE unit's
  // area: six records intersecting a 491,877-acre rectangle sum to 3,033,604 acres, 6.2x
  // the box, with nothing overlapping — the polygons simply run far outside it. Report it
  // per named unit or not at all; never sum it over an extent.
  //
  // And two `Non-PAD-US Area` polygons, 110,871,316 acres between them, carry Pub_Access
  // UK as background fill for the parts of the country PAD-US does not inventory. In CONUS
  // "not protected" returns zero records; in interior Alaska the same question returns the
  // filler, which reads like an answer and says something false. `excludeWhere` is why it
  // never reaches a reader at all.
  padusPublicAccess: {
    id: 'padusPublicAccess',
    name: 'USGS PAD-US public access',
    kind: 'feature-query',
    // The SAME origin as the AirNow contours above, so this source costs the CSP nothing:
    // services.arcgis.com is already in connect-src.
    origin: 'https://services.arcgis.com',
    serviceUrl: PADUS_ACCESS_SERVICE,
    metadataUrl: `${PADUS_ACCESS_SERVICE}?f=json`,
    layers: [{
      id: 0,
      name: 'PAD-US Public Access',
      queryUrl: `${PADUS_ACCESS_SERVICE}/query`,
      geometryType: 'esriGeometryPolygon',
      fields: PADUS_FIELDS,
      accessValues: PADUS_ACCESS_VALUES,
      fillerUnitName: 'Non-PAD-US Area',
      excludeWhere: "Unit_Nm <> 'Non-PAD-US Area'",
    }],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { requiresKey: false, maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit', cacheMaxAgeSeconds: 30 },
    pagination: true,
    cors: 'wildcard',          // access-control-allow-origin: * on a real /query, key-free
    attribution: 'U.S. Geological Survey, Gap Analysis Project — Protected Areas Database of the United States (PAD-US)',
    termsUrl: 'https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview',
    // NOTHING states a vintage: no version string in the FeatureServer, layer or item JSON,
    // and no date field on a record. `editingInfo.dataLastEditDate` is 2025-06-11T15:31:40Z
    // and PAD-US 4.1 was released March 2025, which makes 4.1 a likely inference and not a
    // fact the service will confirm. So the sheet prints a RETRIEVAL date (FAILURE.noUniformDate).
    dateBasis: 'unknown',
    claim: 'inventory',
    coverageSemantics: 'An INVENTORY of protected-area boundaries and of the access level a land '
      + 'manager REPORTED, never a statement that you may enter tonight: "Open" is the manager\'s '
      + 'own category, not a permission. The served view is already flattened — 190 probed points '
      + 'returned at most one record each — so designations do not stack here. GIS_Acres is the '
      + 'WHOLE unit\'s area, not the part on screen: six records intersecting a 491,877-acre '
      + 'rectangle summed 3,033,604 acres, so it is reported per unit and never summed over an '
      + 'extent. Outside the conterminous states the layer is mostly a single 105,513,892-acre '
      + '"Non-PAD-US Area" polygon carrying Pub_Access UK; inside them, absence is a genuine empty '
      + 'result. The service publishes no version.',
    measuredOn: '2026-09-15',
  },
  nasaBlackMarble: {
    id: 'nasaBlackMarble',
    name: 'NASA Black Marble night lights (VIIRS, Suomi NPP)',
    kind: 'raster-tiles',
    origin: 'https://gibs.earthdata.nasa.gov',
    serviceUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best',
    metadataUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities',
    spatialReference: { wkid: 3857 },   // already Web Mercator: nothing to reproject
    tile: {
      size: 256,
      format: 'image/png',
      layerIdentifier: 'VIIRS_Black_Marble', tileMatrixSet: 'GoogleMapsCompatible_Level8',
      // {z}/{y}/{x}: the service's own {TileMatrix}/{TileRow}/{TileCol}, REVERSED from the
      // usual XYZ order. Levels 0-8 only -- 8/95/60 answered 200 image/png at 51,810 bytes,
      // 9/190/120 answered 400 with a 427-byte XML body, not an empty tile.
      urlTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/{time}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
      maxCachedLevelObserved: 8,
      level9Observed: 400,
    },
    // Exactly these, 2016 the service's own default. Nothing newer exists here.
    time: { dimension: 'Time', values: ['2012-01-01', '2016-01-01'], default: '2016-01-01' },
    limits: { requiresKey: false },
    pagination: false, cors: 'star',
    attribution: 'NASA Black Marble (VIIRS, Suomi NPP), served by NASA EOSDIS Global Imagery Browse Services (GIBS)',
    termsUrl: 'https://www.earthdata.nasa.gov/engage/open-data-services-software-policies',
    dateBasis: 'service-metadata',
    // One year averaged, ten years old at the newest: a vintage, not a moment.
    claim: 'inventory',
    coverageSemantics: 'Upward radiance: where light was sent into the sky, as a satellite saw it, '
      + 'averaged over one year. It is NOT a measure of what the sky looks like from the ground and no '
      + 'number derived from it may be presented as one. Ten years old at the newest.',
    measuredOn: '2026-09-11',
  },
  // BTS National Transportation Noise Map 2020, Lower 48 tiles. Measured 2026-10-20: an ArcGIS
  // hosted tile cache (capabilities TilesOnly,Tilemap), PNG 256 px, Web Mercator, levels 1-12
  // (13/3120/2408 answered 404 text/html), the request Origin echoed with allow-credentials,
  // no key. The ImageServer twin needs a token, so tiles only. Alaska and Hawaii are sibling
  // services with their own caches and are not read. The service's own /legend lists the
  // raster bands 45.0-49.9 ... > 90.0; the 2020 dataset notes
  // (https://maps.dot.gov/NTAD_Data/2020_Noise_Data.txt) say 24-hour A-weighted (LAeq).
  btsTransportNoise: {
    id: 'btsTransportNoise',
    name: 'BTS National Transportation Noise Map 2020 (Lower 48: aviation, road and rail)',
    kind: 'raster-tiles',
    origin: 'https://geo.dot.gov',
    serviceUrl: 'https://geo.dot.gov/server/rest/services/Hosted/NTAD_Noise_2020_CONUS_Aviation_Road_Rail/MapServer',
    metadataUrl: 'https://maps.dot.gov/NTAD_Data/2020_Noise_Data.txt',
    spatialReference: { wkid: 3857 },
    tile: {
      size: 256,
      format: 'image/png',
      urlTemplate: 'https://geo.dot.gov/server/rest/services/Hosted/NTAD_Noise_2020_CONUS_Aviation_Road_Rail/MapServer/tile/{z}/{y}/{x}',
      maxCachedLevelObserved: 12,
      level13Observed: 404,
    },
    vintage: 2020,
    limits: { requiresKey: false, minLevel: 1, maxLevel: 12 },
    pagination: false, cors: 'reflects-origin',
    attribution: 'U.S. DOT Bureau of Transportation Statistics, National Transportation Noise Map',
    termsUrl: 'https://www.bts.gov/geospatial/national-transportation-noise-map',
    dateBasis: 'unknown',   // the service states no date; the vintage (2020) is from the dataset notes
    claim: 'model',
    coverageSemantics: 'A modelled 2020 annual-average day of aircraft, road and rail noise over the lower 48 '
      + 'states (24-hour A-weighted equivalent level). BTS says it should not be used to evaluate noise at '
      + 'individual locations or specific times. Not a measurement, not a forecast, and silent about Alaska and Hawaii here.',
    measuredOn: '2026-10-20',
  },
  // BTS NTAD Class I rail lines and the FAA airport facility list, the two things the noise tiles
  // above are made OF. Both are ArcGIS FeatureServers on the SAME host as the tiles, so neither
  // adds an origin. Measured 2026-10-20 (GET only). CORS: a real /query echoed the request Origin
  // (https://headlessmode.com, https://example.org and http://localhost:1313 each came back with
  // allow-credentials true) and an OPTIONS preflight answered 200. Rail: layer 0 of
  // North_American_Class_1_Rail, polylines, 82,892 segments nationally, maxRecordCount 2000; the
  // 10 sq deg box -85,34.5,-81,37 returned 1,987 of that 2,000, so a box is held to 9 sq deg (the
  // 3 x 3 degree box -84.5,34.5,-81.5,37.5 returned 1,948, uncapped), and maxAllowableOffset 0.001
  // took that answer from 3,408,197 bytes to 383,482 for the same 1,948 segments.
  btsRailClass1: {
    id: 'btsRailClass1',
    name: 'BTS NTAD North American Class I rail lines',
    kind: 'feature-query',
    origin: 'https://geo.dot.gov',
    serviceUrl: NTAD_RAIL_SERVICE,
    metadataUrl: `${NTAD_RAIL_SERVICE}?f=json`,
    layers: [{ id: 0, name: 'North American Class 1 Rail', queryUrl: `${NTAD_RAIL_SERVICE}/query`,
      geometryType: 'esriGeometryPolyline', fields: NTAD_RAIL_FIELDS }],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { requiresKey: false, maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit',
      maxBboxSquareDegrees: 9, simplifyDegrees: 0.001 },
    pagination: true,
    cors: 'reflects-origin',
    attribution: 'U.S. DOT Bureau of Transportation Statistics, National Transportation Atlas Database (North American Class I rail lines)',
    termsUrl: 'https://geodata.bts.gov/',
    dateBasis: 'unknown',   // the service states no date and copyright text is empty
    claim: 'inventory',
    coverageSemantics: 'Where Class I railroads run, as BTS publishes the line. Class I only: a short line, '
      + 'a branch another operator runs or a spur is simply not in this layer, so absence here is not '
      + 'absence of a railway. It says nothing about how many trains pass, at what hour, or how loud.',
    measuredOn: '2026-10-20',
  },
  // The FAA facility list as BTS republishes it (Airports_, layer 0): 13,235 points, all fac_type
  // AIRPORT, fac_use PU 4,931 and PR 8,304, status_code O 13,171. OZ_Airports_All was measured and
  // refused: 511 opportunity-zone airports whose fields are obscure (the Knoxville box held 1).
  // The plan guessed JSON-only; the service lists JSON, geoJSON and PBF. Public-use only is asked
  // (fac_use='PU'): the -85,34.5,-81,37 box holds 190 facilities and 63 public-use, a private strip
  // being a place nobody may land. role and category are FAA codes carried as published.
  btsAirports: {
    id: 'btsAirports',
    name: 'BTS NTAD airports (FAA facility data, public-use)',
    kind: 'feature-query',
    origin: 'https://geo.dot.gov',
    serviceUrl: NTAD_AIRPORTS_SERVICE,
    metadataUrl: `${NTAD_AIRPORTS_SERVICE}?f=json`,
    layers: [{ id: 0, name: 'Airports', queryUrl: `${NTAD_AIRPORTS_SERVICE}/query`,
      geometryType: 'esriGeometryPoint', fields: NTAD_AIRPORT_FIELDS }],
    spatialReference: null,   // the native wkid was not read; outSR 4326 is asked and answered
    limits: { requiresKey: false, maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit',
      maxBboxSquareDegrees: 50 },
    pagination: true,
    cors: 'reflects-origin',
    attribution: 'U.S. DOT Bureau of Transportation Statistics, National Transportation Atlas Database (airports, FAA facility data)',
    termsUrl: 'https://geodata.bts.gov/',
    dateBasis: 'unknown',
    claim: 'inventory',
    coverageSemantics: 'Airports the FAA lists as open to the public, as BTS republishes them. It lists the '
      + 'facility, not its traffic: a grass strip and a hub are both one point, and it says nothing about '
      + 'how often aircraft use it. Private-use fields, heliports and military-only fields are not asked.',
    measuredOn: '2026-10-20',
  },
  // The National Register of Historic Places as the National Park Service publishes it (layer 0 of
  // cultural_resources/nrhp_locations: POINTS; layer 1 is the polygons and is not asked). Measured
  // 2026-10-20, GET only, no key: 74,636 points nationally (STATUS Listed 73,928, Removed 648, blank
  // 60), 114 in -84.2,35.8,-83.6,36.2 and 112 of them Listed; maxRecordCount 2000; formats JSON,
  // geoJSON and PBF. CORS: a real /query echoed the request Origin with allow-credentials true. The
  // host is NEW to this map (the NPS webcam row is www.nps.gov). CertDate is a string 'YYYY-MM-',
  // empty on some records. The points are approximate: the sample record says its point is an
  // unspecified coordinate from NPS NRIS, and the layer's constraint text says it is general
  // reference, not Section 106 consultation. Density is why there is a view gate and a row budget:
  // 993 Listed points sat in 0.09 sq deg of Boston.
  npsNrhp: {
    id: 'npsNrhp',
    name: 'National Park Service National Register of Historic Places (points)',
    kind: 'feature-query',
    origin: 'https://mapservices.nps.gov',
    serviceUrl: NPS_NRHP_SERVICE,
    metadataUrl: `${NPS_NRHP_SERVICE}/0?f=pjson`,
    layers: [{ id: 0, name: 'National Register Of Historic Places Points', queryUrl: `${NPS_NRHP_SERVICE}/0/query`,
      geometryType: 'esriGeometryPoint', fields: NPS_NRHP_FIELDS }],
    spatialReference: null,   // outSR 4326 is asked and answered
    limits: { requiresKey: false, maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit',
      maxBboxSquareDegrees: 0.25, recordBudgetPerExtent: 500 },
    pagination: false,   // one page of the budget; a fuller view is told to zoom in
    cors: 'reflects-origin',
    attribution: 'National Park Service, National Register of Historic Places',
    termsUrl: 'https://www.nps.gov/subjects/nationalregister/database-research.htm',
    dateBasis: 'feature-field',   // CertDate, the month the NPS certified the listing
    claim: 'inventory',
    coverageSemantics: 'Properties on the National Register of Historic Places, as the National Park Service '
      + 'lists them: a point per record, with its reference number and the month it was certified. A listing '
      + 'is a record of significance, not a statement about access, condition or whether anything still stands, '
      + 'and many are private. Positions are approximate (some are an unspecified coordinate from the register '
      + 'database). No point in view means none is listed there, not that nothing old is there.',
    measuredOn: '2026-10-20',
  },
  // USDA NRCS SNOTEL snowpack: snow depth (SNWD) and snow water equivalent (WTEQ) from the AWDB REST
  // service. Measured 2026-10-20, GET only, no key: /v1/stations?stationTriplets=*:*:SNTL&activeOnly=true
  // answered 200, `access-control-allow-origin: *`, 407,574 bytes, 919 sites in AK AZ CA CO ID MT NM
  // NV OR SD UT WA WY -- so the list is a build-time catalogue (scripts/qcm/build-snotel-stations.mjs,
  // five fields a site, 46 KB). /v1/data answers many stations in ONE request (comma-separated
  // triplets, percent-encoded colons accepted): daily values `{date, value}` in inches, each with its
  // own date; an element a site does not report is omitted (957:AK had SNWD and no WTEQ), values are
  // 0 in October at most sites, and the newest day can lag by two. The host is NEW to this map.
  usdaSnotel: {
    id: 'usdaSnotel',
    name: 'USDA NRCS SNOTEL sites (snow depth and snow water equivalent, daily)',
    kind: 'observation-feed',
    origin: 'https://wcc.sc.egov.usda.gov',
    serviceUrl: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1',
    metadataUrl: 'https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html',
    endpoints: {
      data: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data',
      catalogue: '/data/quiet-corners-maps/snotel-stations/stations.json',
    },
    elements: ['SNWD', 'WTEQ'],
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxStationsPerView: 12, maxBboxSquareDegrees: 25, activeSitesObserved: 919 },
    pagination: false,
    cors: 'star',
    attribution: 'USDA Natural Resources Conservation Service, SNOTEL',
    termsUrl: 'https://www.nrcs.usda.gov/privacy-policy',
    dateBasis: 'feature-field',   // each daily value carries its own `date`
    claim: 'observation',
    coverageSemantics: 'The newest daily snow depth and snow water equivalent each listed SNOTEL site has '
      + 'published, with the day of its own reading. The sites are Western and alpine (919 active stations in '
      + '13 states, mostly high mountain ground) and most Eastern counties have none, so no SNOTEL site in view '
      + 'means none is listed there, not that there is no snow. At most 12 sites nearest the centre of the view '
      + 'are read, in one request. A site is a point: snow a short way off can differ a lot. An element the '
      + 'service omits is shown as not reported, and a zero depth is a measured zero.',
    measuredOn: '2026-10-20',
  },
  // Avalanche danger ratings (E-P6). Not an agency host: avalanche.org is a partnership of the
  // American Avalanche Association and the US Forest Service National Avalanche Center, which
  // gathers the daily rating of every US forecast centre into one national GeoJSON of zones. A
  // NINTH kind, `zone-feed`: one file for the whole country, fetched whole and kept a while,
  // whose features are the forecast areas and carry their own issue and expiry times.
  avalancheOrgZones: {
    id: 'avalancheOrgZones',
    name: 'avalanche.org danger ratings by forecast zone',
    kind: 'zone-feed',
    origin: 'https://api.avalanche.org',
    serviceUrl: 'https://api.avalanche.org/v2/public',
    metadataUrl: 'https://github.com/NationalAvalancheCenter/Avalanche.org-Public-API-Docs',
    endpoints: { mapLayer: 'https://api.avalanche.org/v2/public/products/map-layer' },
    spatialReference: { wkid: 4326 },
    // Measured 2026-10-21 07:01 EDT: 200, 283,614 bytes, 84 zones (66 Polygon, 18 MultiPolygon),
    // every one `no rating` (-1) in October, 27 of them off season. The service sends
    // `cache-control: max-age=10`; ratings are issued once a morning, so ten minutes is plenty.
    limits: { requiresKey: false, zonesObserved: 84, bytesObserved: 283614, reuseSeconds: 600,
      maxZonesListed: 6 },
    // `start_date`/`end_date` are ISO strings with NO offset, beside a `timezone` the guide calls
    // the zone the centre uses -- without saying the dates are in it. Expiry reads them as UTC,
    // which is the EARLIER instant for every US zone, so an unclear expiry ends a rating early,
    // never late.
    time: { startField: 'start_date', endField: 'end_date', format: 'ISO 8601 without offset',
      zone: 'unstated', expiryReadAs: 'UTC' },
    dangerScale: 'North American Avalanche Danger Scale, 1 low to 5 extreme; -1 no rating',
    pagination: false,
    cors: 'star',
    attribution: 'Avalanche danger ratings from avalanche.org (American Avalanche Association and the '
      + 'USDA Forest Service National Avalanche Center), issued by each US avalanche forecast centre',
    termsUrl: 'https://github.com/NationalAvalancheCenter/Avalanche.org-Public-API-Docs',
    permission: 'avalanche.org, by email to JP, 2026-10-20: "You are welcome to use it for your use case"',
    dateBasis: 'feature-field',
    claim: 'forecast',
    coverageSemantics: 'Each forecast zone\'s danger rating as its avalanche centre issued it for the day, '
      + 'gathered by avalanche.org -- a summary of the forecast, never the forecast itself, which lives on '
      + 'the centre\'s own site. Zones cover only the mountains a centre serves (84 zones, in the West, Alaska, New Hampshire '
      + 'and New York); outside them no forecast is issued, which says nothing about whether a '
      + 'slope is safe. Out of season, and at centres that publish only a summary, a zone carries no '
      + 'rating. A rating expires: past its end date it is no longer shown as a rating.',
    measuredOn: '2026-10-21',
  },
  // GBIF occurrence records, read as AGGREGATES and never as records. Four measured facts
  // shape every use of this source, all of them from 2026-09-15 probes.
  //
  // (1) `coordinateUncertaintyInMeters` is ABSENT on 97% of records -- 4,043 of 133,925 in the
  // dense probe cell, 62 of 827 in the sparse one -- so the precision of a record is usually
  // UNKNOWN and NO POINT MAY BE DRAWN. A dot is a precision claim; GBIF mostly cannot back one.
  // (2) `license` is a CLOSED enum of five values and the server filters on it exactly:
  // CC0_1_0+CC_BY_4_0 over US georeferenced records returned 1,204,398,047, the arithmetic sum
  // of the two unfiltered facet counts, with CC_BY_NC_4_0 absent from the facets and an unknown
  // value answering HTTP 400. Two names are therefore a COMPLETE whitelist over a finite set.
  // (3) The v2 map density tile API ACCEPTS `license` AND IGNORES IT -- an NC-only request
  // returned a byte-identical tile (45,433 B) while year, taxonKey and country each changed it.
  // A policy that cannot be enforced is not a policy, so the tiles are out of scope and this
  // host is never added to img-src. Media are separately licensed from the record carrying
  // them (27 of 614 objects were NC, one licence field was the free text "Matt Robertson
  // (cc-by-sa)"), so no media is loaded either.
  // (4) `datasetName` is absent on the largest publisher -- eBird sends none, covering 47 of
  // 827 sparse-cell records -- while `datasetKey` was present 600/600. Credit is resolved from
  // the key through /v1/dataset/{datasetKey}, whose `citation.text` is a formal citation with
  // the DOI and access date already interpolated by GBIF.
  //
  // Bare endpoints only, filters assembled at call time (source-gbif.js): the credential check
  // in scripts/qcm/registry.test.mjs is an unanchored /(key|token|apikey)=/i over every string
  // here, and GBIF's own `taxonKey=` and `datasetKey=` parameters would trip it.
  gbifOccurrence: {
    id: 'gbifOccurrence',
    name: 'GBIF species occurrence records (CC0 and CC BY only)',
    kind: 'feature-query',
    origin: 'https://api.gbif.org',
    serviceUrl: GBIF_SEARCH_SERVICE,
    metadataUrl: 'https://api.gbif.org/v1/enumeration/basic/License',
    layers: [{
      id: 'occurrence-aggregate',
      name: 'Occurrence aggregate for one map cell',
      queryUrl: GBIF_SEARCH_SERVICE,
      geometryType: 'esriGeometryEnvelope',   // a decimalLatitude/decimalLongitude range, not geometry
      // FACETS, not records: the whole card is `count` plus these five fields, 3,505 bytes.
      // One 300-record page of the same cell measured 2,206,314 -- 629x for the same card.
      fields: ['count', 'scientificName', 'datasetKey', 'month', 'year', 'basisOfRecord'],
    }, {
      id: 'dataset-citation',
      name: 'Per-dataset credit, resolved from datasetKey',
      queryUrl: GBIF_DATASET_SERVICE,
      fields: ['title', 'license', 'citation', 'doi', 'publishingOrganizationKey'],
    }],
    spatialReference: { wkid: 4326 },   // plain decimal degrees; nothing to reproject
    policy: {
      licenseEnum: ['CC0_1_0', 'CC_BY_4_0', 'CC_BY_NC_4_0', 'UNSPECIFIED', 'UNSUPPORTED'],
      allowed: ['CC0_1_0', 'CC_BY_4_0'],
      mediaPolicy: 'none',        // media carry their OWN licences, NC among them
      densityTiles: 'disqualified',   // the tile API discards `license`
    },
    limits: {
      requiresKey: false, cacheMaxAgeSeconds: 600, datasetCacheMaxAgeSeconds: 3601,
      aggregateBytesObserved: 3505, rawPageBytesObserved: 2206314,
    },
    pagination: false,            // paging is disqualified: 100,001 offset cap, 403 downloads
    cors: 'star',                 // access-control-allow-origin: * on every probe
    attribution: 'Global Biodiversity Information Facility (GBIF.org), with each contributing '
      + 'dataset credited by its own published citation',
    termsUrl: 'https://www.gbif.org/terms/data-user',
    dateBasis: 'feature-field',   // each record's own eventDate; the year/month facets derive from it
    // Each row is one observation event with its own eventDate, recorder and place. NOT
    // 'inventory': an inventory's silence means "not on the list", and GBIF's silence means
    // only "nobody submitted a record" -- the exact inference this layer exists to forbid.
    claim: 'observation',
    coverageSemantics: 'A record is evidence that somebody looked and wrote it down, never '
      + 'evidence of abundance, and an empty cell is "no records in this selection" and nothing '
      + 'else. Recording effort is wildly uneven: two 0.10x0.15-degree cells measured 133,925 '
      + 'records and 827, a 162-fold difference in recording and not in wildlife. A cell count '
      + 'is an UPPER BOUND rather than a count -- two publishers can submit the same sighting '
      + 'and a facet count cannot tell them apart. Precision is usually unknown: '
      + 'coordinateUncertaintyInMeters was present on 4,043 of those 133,925 records (3.0%) and '
      + 'on 62 of 827 (7.5%), so nothing here is drawn as a point. Records carrying '
      + 'informationWithheld are deliberately widened -- all 20 seen said so in words, at about '
      + '28.6 km -- and the `issues` array does not mark them, so they are counted by '
      + 'uncertainty and never placed.',
    measuredOn: '2026-09-15',
  },
  nwsForecast: {
    id: 'nwsForecast',
    name: 'NWS hourly forecast',
    // A fourth kind: not a tile cache, not a queryable layer, not an image export. You hand
    // it a lat/lon and it hands back a forecast -- in two steps on this one origin, because
    // /points RETURNS the forecast URL and hand-building the gridpoints URL would pin a
    // grid number the office is free to change. Measured 2026-09-10; see source-weather.js.
    kind: 'point-forecast',
    origin: 'https://api.weather.gov',
    serviceUrl: 'https://api.weather.gov',
    metadataUrl: 'https://api.weather.gov/openapi.json',
    endpoints: { point: 'https://api.weather.gov/points/{lat},{lon}', hourlyFrom: 'properties.forecastHourly' },
    spatialReference: { wkid: 4326 },
    // Four decimals because /points/33.269912,-85.833712 answered 301 to the short form; the
    // refresh figures are the service's own cache-control, 3600 s hourly, 85,988 on /points.
    limits: { pointCoordinateDecimals: 4, hourlyRefreshMs: 3600000, pointRefreshMs: 86400000 },
    pagination: false,
    cors: 'star',
    // No response carries a copyright field, so the credit is the publisher naming itself,
    // as /offices/BMX does: "NWS Birmingham, Alabama".
    attribution: 'NOAA National Weather Service',
    termsUrl: 'https://www.weather.gov/disclaimer',
    dateBasis: 'service-metadata',
    // Hours that have not happened yet.
    claim: 'forecast',
    coverageSemantics: 'The United States and its territories only -- Alaska and Puerto Rico answer, '
      + 'Paris and Mexico City answer 404 problem+json, a "no forecast here" state and not a failure. A '
      + 'forecast belongs to a grid cell rather than a summit, so a valley and the ridge above it can '
      + 'share one, and a missing field is reported unknown rather than as zero.',
    measuredOn: '2026-09-10',
  },
  // The SAME origin as the hourly forecast and a different product entirely, which is why it
  // is its own entry rather than a second endpoint on the one above: a forecast is a number
  // for an hour, an alert is a product an office issued with a window of its own, and a
  // failure in either must leave the other standing. A SIXTH kind, `alert-feed`: no tiles, no
  // ArcGIS layer, no image export, and not a point-forecast either -- one GeoJSON feed asked
  // by point, whose features carry their own times.
  //
  // THE MEASUREMENT THAT SHAPES EVERYTHING: of 386 features active nationally at the probe,
  // 342 carried `geometry: null`. Nine alerts in ten are ZONE-based, reachable only through
  // `affectedZones`/`geocode.UGC`, so an adapter that reads polygons drops nearly all of them.
  // And all 386 carried `web: "http://www.weather.gov"` -- the agency's front page, not a page
  // about the alert -- so the link a reader is given is the alert's own `@id` record.
  nwsAlerts: {
    id: 'nwsAlerts',
    name: 'NWS active watches, warnings and advisories',
    kind: 'alert-feed',
    origin: 'https://api.weather.gov',
    serviceUrl: 'https://api.weather.gov/alerts/active',
    metadataUrl: 'https://api.weather.gov/openapi.json',
    endpoints: { active: 'https://api.weather.gov/alerts/active?point={lat},{lon}' },
    spatialReference: { wkid: 4326 },
    // Read off the API's own 400: `?message_type=Bogus` answered 'Does not have a value in the
    // enumeration ["alert","update","cancel"]'. Three, and `cancel` is not an alert.
    messageTypes: ['alert', 'update', 'cancel'],
    // Four decimals, the same 301 the point forecast measured. `max-age=5` is the feed's own
    // cache-control: it turns over fast, and a held response goes out of date in minutes --
    // which is why the card reads each alert's OWN expiry rather than trusting the response.
    limits: { requiresKey: false, pointCoordinateDecimals: 4, maxAgeSeconds: 5 },
    pagination: false,
    cors: 'star',
    attribution: 'NOAA National Weather Service, active watches, warnings and advisories',
    termsUrl: 'https://www.weather.gov/disclaimer',
    // Each feature states its own sent/effective/onset/expires/ends. The collection's
    // `updated` is when the FEED was built and is never an alert's time.
    dateBasis: 'feature-field',
    // A statement about a window that has not ended: a warning is issued for what is expected
    // or occurring THROUGH a stated expiry, so the honest time to show is the effect window
    // rather than a moment anything was read off an instrument.
    claim: 'forecast',
    coverageSemantics: 'Only the products the National Weather Service issues, which is not every '
      + 'hazard that exists: a quiet feed is no NWS product in force, never a statement that the '
      + 'ground is safe. Nine in ten alerts are ZONE-based and carry no polygon at all -- 342 of 386 '
      + 'measured `geometry: null` -- so an alert names the areas it applies to rather than a drawn '
      + 'shape. It is a forecast of a window, and a held response keeps saying "in effect" after the '
      + 'alert’s own expiry unless the expiry is read; a cancelled product is withdrawn whatever '
      + 'its end time still says. United States and its territories only.',
    measuredOn: '2026-09-14',
  },
  // USGS stream gauges: the newest flow (00060) and gage-height (00065) reading each active
  // station has published, from the USGS Water Data OGC API. Measured 2026-10-20: a GET with
  // `bbox=-83.6,35.5,-83.0,35.9` answered 200 application/json, `access-control-allow-origin: *`,
  // no key, 9 features / 7,546 bytes with the whole property list; `limit=1000` is the page
  // ceiling asked for. A feature is one station + parameter with its OWN `time`, `value` (a
  // STRING) and `unit_of_measure` (`ft^3/s`, `ft`); names live in a second collection
  // (`monitoring-locations`, `id=` takes a comma list). One station's newest flow reading was
  // dated 2009-10-01, so a reading's age is never assumed.
  //
  // WHY NOT THE LEGACY HOST. https://waterservices.usgs.gov/ (the NWIS `iv` service, which
  // also answered 200 + CORS `*` + 12,715 B for the same box) carries on its landing page,
  // checked 2026-10-20: "WaterServices will be permanently shut down on February 22nd, 2027 ...
  // Users must migrate to https://api.waterdata.usgs.gov". A layer built on it would break
  // four months after it shipped. The new API's bbox query answered a 100 square degree box
  // as well (limit 10), so the 25 square degree ceiling below is the legacy documented cap
  // kept on purpose, not a measured refusal. A new kind, `observation-feed`: a JSON
  // point feed asked by bounding box, with no ArcGIS layer behind it, whose features carry
  // their own reading times.
  usgsWaterGauges: {
    id: 'usgsWaterGauges',
    name: 'USGS stream gauges (flow and gage height, latest reading)',
    kind: 'observation-feed',
    origin: 'https://api.waterdata.usgs.gov',
    serviceUrl: 'https://api.waterdata.usgs.gov/ogcapi/v1',
    metadataUrl: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous',
    endpoints: {
      byBox: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?bbox={bbox}&parameter_code={codes}&limit={limit}&f=json',
      names: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items?id={ids}&properties=monitoring_location_name,id&limit={limit}&f=json',
    },
    parameterCodes: ['00060', '00065'],
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxBboxSquareDegrees: 25, recordBudgetPerExtent: 1000,
      boxObservedBytes: 7546, legacyBoxObservedBytes: 12715 },
    pagination: false,
    cors: 'star',
    attribution: 'U.S. Geological Survey, National Water Information System',
    termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/acknowledging-or-crediting-usgs',
    dateBasis: 'feature-field',   // each value carries its own `time`
    claim: 'observation',
    coverageSemantics: 'The newest value each active USGS station has published for streamflow and '
      + 'gage height, each with its own reading time (one station\u2019s newest flow was from 2009). '
      + 'Most values are provisional and subject to revision. It covers stations USGS operates, '
      + 'not every stream, and no gauge in view means none reports here, not that the water is low or '
      + 'quiet. It is a reading from a past moment: not a forecast, not a flood warning, and never a '
      + 'statement that a crossing is safe. The legacy waterservices.usgs.gov host is announced for '
      + 'decommission on 2027-02-22 and is not used.',
    measuredOn: '2026-10-20',
  },
  // NWS weather stations: the newest temperature, wind and humidity observation a station has
  // published. Measured 2026-10-20 with a User-Agent naming headlessmode.com: GET
  // /stations?limit=500 answered 200 `application/geo+json`, `access-control-allow-origin: *`,
  // 500 stations / 541,480 bytes with a `pagination.next` cursor ({"s":500}); the list ends
  // between offset 48,000 and 49,000 (about 48,500 stations nationally, 98 pages). It has NO
  // bounding-box filter -- `state=TN` is accepted, nothing spatial -- so the station list is a
  // build-time catalogue (scripts/qcm/build-nws-stations.mjs, a reviewable diff, two stations to a line under
  // static/data/quiet-corners-maps/nws-stations/) and only `/stations/{id}/observations/latest`
  // is read live, for at most 12 stations per view. KTYS answered 200, CORS `*`, 1,800 bytes
  // trimmed: `temperature` (wmoUnit:degC), `windSpeed`/`windGust` (wmoUnit:km_h-1),
  // `windDirection` (degree_(angle)) and `relativeHumidity` (percent), each `{unitCode, value,
  // qualityControl}`, with the observation's own `timestamp`. A value can be null (qualityControl
  // `Z`) and `X` marks a reading that failed quality control. The origin is the one the forecast
  // and alerts rows already approved, so connect-src is unchanged.
  nwsObservations: {
    id: 'nwsObservations',
    name: 'NWS weather stations (temperature, wind and humidity, latest observation)',
    kind: 'observation-feed',
    origin: 'https://api.weather.gov',
    serviceUrl: 'https://api.weather.gov',
    metadataUrl: 'https://api.weather.gov/openapi.json',
    endpoints: {
      latest: 'https://api.weather.gov/stations/{id}/observations/latest',
      catalogue: '/data/quiet-corners-maps/nws-stations/stations.json',
    },
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxStationsPerView: 12, maxBboxSquareDegrees: 25,
      stationsPageLimit: 500, nationalStationsObserved: 48500 },
    pagination: false,
    cors: 'star',
    attribution: 'NOAA National Weather Service, station observations',
    termsUrl: 'https://www.weather.gov/disclaimer',
    dateBasis: 'feature-field',   // each observation carries its own `timestamp`
    claim: 'observation',
    coverageSemantics: 'The newest observation each listed station has published, with its own '
      + 'observation time. The list holds airport-style reporting stations from five states only '
      + '(Tennessee, North Carolina, Georgia, South Carolina and Colorado: 332 stations), not every '
      + 'instrument and not every state, and at most 12 stations '
      + 'nearest the centre of the view are read. A station is a point: a valley a few miles '
      + 'away can differ a lot. It is a reading from a past moment, not a forecast. A missing '
      + 'value or one that failed quality control is left out and counted.',
    measuredOn: '2026-10-20',
  },
  // NOAA's Hazard Mapping System smoke analysis. `Start` and `End_` are STRINGS in the HMS
  // wire format `YYYYDDD HHMM`, UTC day-of-year (`2026257 1200` is 2026-09-14 12:00Z): the
  // satellite image sequence the analyst outlined the plume from. The service's own
  // `last-modified` is NOT that time — it measured 4h32m newer than the newest plume.
  noaaHmsSmoke: {
    id: 'noaaHmsSmoke',
    name: 'NOAA HMS smoke plume analysis',
    kind: 'feature-query',
    origin: 'https://services2.arcgis.com',
    serviceUrl: HMS_SMOKE_SERVICE,
    metadataUrl: `${HMS_SMOKE_SERVICE}?f=json`,
    // The WHOLE field list, not a selection: there is no numeric date field and no
    // concentration field. The times are strings and the density is a word.
    layers: [{ id: 0, name: 'NOAA_Satellite_Smoke_Detection', queryUrl: `${HMS_SMOKE_SERVICE}/query`,
      geometryType: 'esriGeometryPolygon', densityClasses: HMS_DENSITY_CLASSES,
      fields: ['FID', 'Satellite', 'Start', 'End_', 'Density', 'Shape__Area', 'Shape__Length'] }],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { requiresKey: false, maxRecordCount: 1000, partialPageFlag: 'exceededTransferLimit',
      cacheMaxAgeSeconds: 30,
      // Measured for the WHOLE country, one UTC day: 103 polygons in three analysis windows.
      nationalFeaturesObserved: 103, nationalBytesObserved: 160863, nationalBytesSimplified: 44085,
      countyBboxBytesObserved: 6466, simplifyOffsetDegrees: 0.01, geometryPrecision: 3 },
    // `Start`/`End_` are `YYYYDDD HHMM` UTC strings, NOT epoch milliseconds.
    time: { startField: 'Start', endField: 'End_', format: 'yyyyDDD HHmm', zone: 'UTC',
      windowsPerDayObserved: 3, dayHeldObserved: 1 },
    pagination: true,
    cors: 'wildcard',
    attribution: 'NOAA/NESDIS Satellite Analysis Branch, Hazard Mapping System (HMS)',
    termsUrl: 'https://www.arcgis.com/home/item.html?id=ab7a5fbd76e3499296350eabf599fc63',
    dateBasis: 'feature-field',
    claim: 'observation',   // an analyst read it off imagery taken at a stated past time
    coverageSemantics: 'Smoke ALOFT, outlined by an analyst from GOES true-colour imagery, and '
      + 'therefore a DAYLIGHT product: nothing is analysed at night, and the current UTC day\'s '
      + 'first plumes do not appear until about local noon. The three density classes are apparent '
      + 'opacity, which NOAA says approximates 0-10, 10-21 and 21-32 micrograms per cubic metre in '
      + 'the column -- with no guarantee. A column reading is not ground-level air quality and may '
      + 'not be rendered as one. The layer holds ONE UTC day: 103 polygons in three analysis '
      + 'windows covered the whole country at the probe. North America only.',
    measuredOn: '2026-09-15',
  },
  // NIFC's current-perimeter service. "Current" is the service's word, not a promise about the
  // polygon: poly_PolygonDateTime is when the boundary was MAPPED, median 21.9 days old, 19 of
  // 188 absent and ONE dated the year 0926. Contained fires are present (56 of 188 at 100 per
  // cent) and attr_ContainmentDateTime was null on ALL 188, so nothing may be built from it.
  nifcFirePerimeters: {
    id: 'nifcFirePerimeters',
    name: 'NIFC WFIGS current interagency fire perimeters',
    kind: 'feature-query',
    origin: 'https://services3.arcgis.com',
    serviceUrl: WFIGS_PERIMETERS_SERVICE,
    metadataUrl: `${WFIGS_PERIMETERS_SERVICE}?f=json`,
    layers: [{ id: 0, name: 'Perimeters', queryUrl: `${WFIGS_PERIMETERS_SERVICE}/query`,
      geometryType: 'esriGeometryPolygon', categories: WFIGS_INCIDENT_CATEGORIES,
      fields: WFIGS_FIELDS }],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { requiresKey: false, maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit',
      cacheMaxAgeSeconds: 300,
      // Both measured on the same query, same minute. The first is why the second is required:
      // the unsimplified transfer FAILED, curl reporting PROTOCOL_ERROR on a truncated stream.
      nationalBytesUnsimplified: 37342814, nationalBytesSimplified: 755975,
      requiredMaxAllowableOffsetDegrees: 0.002, nationalFeaturesObserved: 188 },
    // The polygon's own mapping time, NOT the incident's currency and NOT retrieval.
    time: { polygonField: 'poly_PolygonDateTime', recordCurrencyField: 'poly_DateCurrent',
      discoveryField: 'attr_FireDiscoveryDateTime', epochMilliseconds: true,
      corruptBeforeUtc: '2000-01-01', medianPolygonAgeDaysObserved: 21.9 },
    pagination: true,
    cors: 'wildcard',
    attribution: 'National Interagency Fire Center, Wildland Fire Interagency Geospatial Services '
      + '(WFIGS); source agencies via IRWIN',
    termsUrl: 'https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824',
    dateBasis: 'feature-field',
    claim: 'inventory',   // the interagency RECORD of an incident, with a vintage per polygon
    coverageSemantics: 'The interagency RECORD of an incident, not a live fire edge. The boundary '
      + 'was mapped at poly_PolygonDateTime, whose median measured 21.9 days old and whose p90 '
      + 'measured 60 days; 19 of 188 records carried none, and one carried the year 0926. A '
      + 'perimeter is not a real-time boundary and it is not a closure or an evacuation order; '
      + 'NIFC states the data are dynamic and are not legal documents. Contained fires are '
      + 'present -- 56 of 188 read 100 per cent -- and so are prescribed burns, which are planned '
      + 'fire and must never be drawn as wildfire.',
    measuredOn: '2026-09-15',
  },
  blmRecSites: {
    id: 'blmRecSites',
    name: 'BLM recreation sites',
    kind: 'feature-query',
    origin: 'https://gis.blm.gov',
    serviceUrl: BLM_REC_SERVICE,
    metadataUrl: `${BLM_REC_SERVICE}?f=pjson`,
    // Layer 1: 1,304 points, key-free. Description non-empty on 1,302, directions 1,258.
    layers: [{ id: 1, name: 'BLM Recreation Sites', queryUrl: `${BLM_REC_SERVICE}/query`, geometryType: 'esriGeometryPoint', fields: BLM_REC_FIELDS }],
    spatialReference: null,
    limits: { maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit' },
    pagination: true,
    // Allow-Origin echoed the request Origin on a real /query, not just on the metadata.
    cors: 'reflects-origin',
    attribution: 'Bureau of Land Management, National Recreation Sites and Facilities',
    termsUrl: 'https://www.blm.gov/about/data',
    // LastUpdatedDate is a plain YYYY-MM-DD string per record, not epoch milliseconds.
    dateBasis: 'feature-field',
    // The agency's own published list of sites, each with a last-updated date.
    claim: 'inventory',
    coverageSemantics: 'Sites the Bureau of Land Management publishes as recreation areas, carrying the '
      + 'agency’s own description, directions and last-updated date. A record without directions is the '
      + 'inventory not saying, never "no access", and the layer claims nothing about conditions on a night.',
    measuredOn: '2026-09-11',
  },
  // EPA AirNow's hourly AQI contours. Two measured facts shape every use of it. A record
  // carries `gridcode` and nothing else that says anything -- no pollutant field, no AQI value
  // -- and `gridcode` is the AQI CATEGORY 1..6, named by the service's OWN renderer labels,
  // word for word in the item description. And the FeatureServer ROOT calls itself "AirNow
  // National AQI Forecast Updated Nightly", boilerplate from another service: layer 0 is
  // AirNowLatest_Combined, the item says "the most recent hour available", and all 115 records
  // nationally shared ONE Unixtime. It is an observation of a past hour.
  epaAirNowAqi: {
    id: 'epaAirNowAqi',
    name: 'EPA AirNow air quality index contours (latest hour)',
    kind: 'feature-query',
    origin: 'https://services.arcgis.com',
    serviceUrl: AIRNOW_AQI_SERVICE,
    metadataUrl: `${AIRNOW_AQI_SERVICE}?f=json`,
    // `fields` is the WHOLE list, not a selection: what is absent is the point.
    layers: [{ id: 0, name: 'AirNowLatest_Combined', queryUrl: `${AIRNOW_AQI_SERVICE}/query`,
      geometryType: 'esriGeometryPolygon', categories: AIRNOW_AQI_CATEGORIES,
      fields: ['OBJECTID', 'Id', 'gridcode', 'Unixtime', 'Timestamp', 'Shape__Area', 'Shape__Length'] }],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: { requiresKey: false, maxRecordCount: 2000, partialPageFlag: 'exceededTransferLimit', cacheMaxAgeSeconds: 600 },
    pagination: true,
    cors: 'wildcard',          // access-control-allow-origin: * on a real /query, key-free
    attribution: 'US EPA AirNow, Office of Air and Radiation, Office of Air Quality Planning and Standards',
    termsUrl: 'https://www.arcgis.com/home/item.html?id=ad7046a2b3854c25aea8945b3baac0a7',
    dateBasis: 'feature-field',
    // Its own prose: the category "for one past hour". Interpolated, and still of a past hour.
    claim: 'observation',   // the RECORD's own Unixtime/Timestamp, not service metadata
    coverageSemantics: 'The AQI CATEGORY over an area for one past hour and nothing more: the '
      + 'records carry no pollutant field and no index value, so a category name is the only claim '
      + 'that can be read rather than invented. The surface is INTERPOLATED between monitors, so '
      + 'ground with no monitor near it still takes a colour, and EPA states the hourly data are '
      + 'preliminary and not fully verified. US only -- 115 records covered the country at the '
      + 'probe, sharing one hour, measured 144 minutes behind the wall clock.',
    measuredOn: '2026-09-12',
  },
  // The USFWS National Wetlands Inventory. 38,159,047 polygons nationally, so the
  // only interesting question is what keeps a browser inside its request policy,
  // and the answer is NOT the record count. Measured 2026-09-15: sending
  // resultOffset/resultRecordCount at all -- even at offset 0 -- re-costs a query
  // 20x (8.71 s -> 176.74 s over one degree square), so `recordBudgetPerExtent` is
  // a refusal this layer cannot ship without. Payload is driven by VERTEX count,
  // not record count: 17 features in a DRY Nevada box measured 2,256,343 bytes,
  // because riverine polygons run for miles and are returned whole.
  fwsNwiWetlands: {
    id: 'fwsNwiWetlands',
    name: 'USFWS National Wetlands Inventory',
    kind: 'feature-query',
    origin: 'https://fwspublicservices.wim.usgs.gov',
    serviceUrl: NWI_WETLANDS_SERVICE,
    metadataUrl: `${NWI_WETLANDS_SERVICE}?f=json`,
    layers: [
      { id: 0, name: 'Wetlands', queryUrl: `${NWI_WETLANDS_SERVICE}/0/query`,
        geometryType: 'esriGeometryPolygon', categories: NWI_WETLAND_TYPES,
        fields: NWI_WETLAND_FIELDS },
      // The coverage mask: TWO records nationally, one 'Digital' and one 'No_Data',
      // each a multipart polygon. A POINT query against it is what separates "no
      // wetlands here" from "nobody surveyed here", and it is the only thing that does.
      { id: 0, name: 'Wetlands Mapping Status', queryUrl: `${NWI_STATUS_SERVICE}/0/query`,
        geometryType: 'esriGeometryPolygon', statuses: ['Digital', 'No_Data'],
        fields: ['OBJECTID', 'STATUS'] },
      // The vintage: one polygon per mapping project, carrying the YEAR and SCALE of
      // the aerial imagery the wetlands there were drawn from. The wetland features
      // carry none -- Horicon WI is 1994 B&W at 1:20,000, Tonopah NV 2022 colour
      // infrared, adjacent panes of one national layer 28 years apart.
      { id: 0, name: 'Source Type', queryUrl: `${NWI_SOURCE_SERVICE}/0/query`,
        geometryType: 'esriGeometryPolygon',
        fields: ['PROJECT_NAME', 'IMAGE_YR', 'IMAGE_SCALE', 'ALL_SCALES', 'SOURCE_TYPE'] },
    ],
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    limits: {
      requiresKey: false,
      // 1,000, NOT the 2,000 every other feature-query here carries: the shared
      // pager's PAGE_CAP is clamped server-side. Offsets still line up, measured.
      maxRecordCount: 1000,
      partialPageFlag: 'exceededTransferLimit',
      // Not an optimisation: the difference between 3 MB and 450 KB a page.
      maxAllowableOffsetDegrees: 0.0001,
      // Refuse rather than page. 1,759 records measured in ONE desktop view over
      // Horicon, and 29,608 in a degree square -- ~90 minutes of wall clock against
      // a 20 s timeout. Four pages is what fits REQUEST_POLICY.
      recordBudgetPerExtent: 4000,
      // The PAINTED route returns a fully transparent PNG, HTTP 200, no error, above
      // 1:100,000 -- blank at Leaflet z12, paints at z13. Recorded so nobody adds
      // `export` to img-src and ships a blank picture that reads as "no wetlands".
      paintedMinZoom: 13,
    },
    pagination: true,
    cors: 'reflects-origin',
    attribution: 'U.S. Fish and Wildlife Service, National Wetlands Inventory, '
      + 'National Standards and Support Team',
    termsUrl: 'https://www.fws.gov/page/wetlands-geodatabase-disclaimer',
    // copyrightText and serviceDescription are both empty strings, and no feature
    // field carries a date. The year lives in Data_Source, per project.
    dateBasis: 'unknown',
    claim: 'inventory',
    coverageSemantics: 'A reconnaissance inventory drawn from aerial imagery of a stated year, '
      + 'not a visit: FWS states a margin of error is inherent and that on-the-ground inspection '
      + 'may revise any boundary. A polygon says a photo-interpreter read wetland vegetation, '
      + 'hydrology or geography there in that image — it says NOTHING about whether the ground '
      + 'is wet today, whether anyone may walk on it, who owns it, or whether it is regulated. '
      + 'Absence of a polygon is NOT absence of wetland: the Wetlands Mapping Status layer must '
      + 'be read first, because No_Data ground returns exactly the same empty result as surveyed '
      + 'ground with nothing on it. Layer 0 is a join, so one polygon can arrive twice under one '
      + 'OBJECTID, and returnCountOnly is a lower bound rather than a count.',
    measuredOn: '2026-09-15',
  },
  // Probed 2026-09-25 for E1 (plan §8 Q-terrain): 256x256 8-bit RGB PNG,
  // `Access-Control-Allow-Origin: *`, 108-134 KB per tile at z12/z14/z15, <1.4s.
  // Encoding is Terrarium (MapLibre `raster-dem` `encoding: 'terrarium'`), NOT
  // Terrain-RGB. Mixed-source DEM (Mapzen/Tilezen from 3DEP, SRTM, GMTED2010,
  // ETOPO1 and others) -- never labelled "3DEP" alone. `kind: 'raster-image'`
  // (registry.test.mjs has no 'raster-dem' kind; this is the closest existing
  // shape -- an exported picture with no page count, same as usgs3depSurface):
  // MapLibre's own worker fetches these tiles with fetch()/ArrayBuffer and
  // decodes them itself for the WebGL terrain pipeline, never through an <img>
  // element, so cspDirectivesFor() is right to leave this out of img-src (which
  // only 'raster-tiles' or `paintedAs: 'img'` earn) -- connect-src is the whole
  // cost, exactly like usgs3depSurface just above.
  terrainDem: {
    id: 'terrainDem',
    name: 'AWS Terrain Tiles (Terrarium DEM)',
    kind: 'raster-image',
    origin: 'https://s3.amazonaws.com',
    serviceUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    metadataUrl: 'https://registry.opendata.aws/terrain-tiles/',
    spatialReference: { wkid: 3857, latestWkid: 3857 },
    tile: { size: 256, format: 'PNG', encoding: 'terrarium', maxNativeZoomObserved: 15 },
    limits: { maxNativeZoomObserved: 15 },
    pagination: false,
    cors: 'star',
    attribution: 'Mapzen/Tilezen terrain tiles from 3DEP, SRTM, GMTED2010, ETOPO1 and others',
    termsUrl: 'https://registry.opendata.aws/terrain-tiles/',
    dateBasis: 'unknown',
    // A tile cache built from several published elevation compilations.
    claim: 'inventory',
    coverageSemantics: 'A mixed-source global elevation surface, not a single agency’s survey: '
      + 'quality and vintage vary by region and by the underlying dataset each tile draws from. '
      + 'Never present this as "3DEP" alone.',
    measuredOn: '2026-09-25',
  },
  // Caltrans CWWP2 CCTV, all twelve districts (QUX-08D.md D16; the browser reads the build-time
  // snapshot of each, U4a, and no longer asks cwwp2 for the list). `kind: 'camera-feed'`: a still (fetched to a blob: URL so its own
  // Last-Modified header can be read -- D9) plus an optional HLS stream link, never a tile and
  // never an <img src> straight at cwwp2, so this origin belongs in connect-src only, never
  // img-src. No paintedAs, on purpose. The Conditions of Use PDF returned HTTP 500 on
  // 2026-09-27 (see below); rights stays 'unverified', never a public-domain claim this
  // registry cannot back.
  caltransCctv: {
    id: 'caltransCctv',
    name: 'Caltrans CWWP2 CCTV',
    kind: 'camera-feed',
    origin: 'https://cwwp2.dot.ca.gov',
    // serviceUrl is District 5's feed, kept for the registry's required shape; the build snapshots
    // every district in serviceUrls (build-camera-snapshot.mjs) and the page reads that snapshot.
    serviceUrl: 'https://cwwp2.dot.ca.gov/data/d5/cctv/cctvStatusD05.json',
    serviceUrls: Object.freeze(CALTRANS_COVERAGE_AREAS.map((area) => area.serviceUrl)),
    coverageAreas: CALTRANS_COVERAGE_AREAS,
    metadataUrl: 'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'star',
    attribution: 'Caltrans',
    // Fetched live 2026-09-27; the PDF returned HTTP 500. No CCTV-specific still/stream/bulk-use
    // clause exists on the documentation page either (checked live, same date) -- see
    // source-camera.js's own header comment for the full finding.
    termsUrl: 'https://cwwp2.dot.ca.gov/docs/cctv/CondOfUse.pdf',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: "All twelve Caltrans districts, as of the last build-time list check. The camera list is Caltrans's own; a "
      + "picture's age comes from the image file's Last-Modified header, not a capture time.",
    measuredOn: '2026-09-27',
  },
  // NPS webcams, nationwide (QUX-08D-ii built it for Great Smoky Mountains; camera U5 widened the
  // build to every located record -- the page still reads only the same-origin snapshot). The browser never calls
  // developer.nps.gov itself -- that service `requiresKey`, and a browser-held key is a
  // published key. A build-time step (build-camera-snapshot.mjs) fetches it with a CI
  // secret and writes a same-origin JSON snapshot instead; this registry entry describes
  // what the PAGE actually requests at runtime, which is the park's own image host, no
  // key, no cross-origin call. `cors: 'none'` -- this origin never appears in connect-src
  // (cspDirectivesFor filters it out) because the page's own fetch is same-origin to the
  // snapshot file, not to www.nps.gov; the still is painted straight into an <img src>
  // (`paintedAs: 'img'`), so it DOES belong in img-src, same as a tile cache.
  npsWebcams: {
    id: 'npsWebcams',
    name: 'NPS webcams',
    kind: 'camera-feed',
    origin: 'https://www.nps.gov',
    serviceUrl: 'https://www.nps.gov/featurecontent/ard/webcams/images/',
    metadataUrl: 'https://developer.nps.gov/api/v1/webcams',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'National Park Service',
    termsUrl: 'https://www.nps.gov/aboutus/disclaimer.htm',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every National Park Service webcam that has a position, taken from the '
      + 'service\'s own list when the site is built. A few Great Smoky Mountains cameras show a '
      + 'picture; every other park\'s camera is a link to the camera\'s page on nps.gov. The service does '
      + 'not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  arcgisKyKytc: {
    id: 'arcgisKyKytc',
    name: 'Kentucky traffic cameras (KYTC)',
    kind: 'camera-feed',
    origin: 'https://www.trimarc.org',
    serviceUrl: 'https://www.trimarc.org/images/milestone/',
    metadataUrl: 'https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/trafficCamerasCur_Prd/FeatureServer/0',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Kentucky Transportation Cabinet',
    termsUrl: 'https://maps.kytc.ky.gov/trafficcameras/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Kentucky\'s public camera layer that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  arcgisTxArlington: {
    id: 'arcgisTxArlington',
    name: 'Arlington, Texas traffic cameras',
    kind: 'camera-feed',
    origin: 'https://webapps.arlingtontx.gov',
    serviceUrl: 'https://webapps.arlingtontx.gov/webcams/',
    metadataUrl: 'https://services.arcgis.com/jXi5GuMZwfCYtZP9/arcgis/rest/services/Traffic_Camera_Updates_view/FeatureServer/0',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'City of Arlington, Texas',
    termsUrl: 'https://experience.arcgis.com/experience/a2fceb484bd04e2c9f795e8c9ce78786',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Arlington, Texas\'s public camera layer that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  arcgisKsLawrence: {
    id: 'arcgisKsLawrence',
    name: 'Lawrence, Kansas traffic cameras',
    kind: 'camera-feed',
    origin: 'https://assets.lawrenceks.gov',
    serviceUrl: 'https://assets.lawrenceks.gov/gis/traffic/',
    metadataUrl: 'https://services.arcgis.com/8O9UlSTnqjKptoda/arcgis/rest/services/Traffic_Cameras/FeatureServer/4',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 2000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'City of Lawrence, Kansas',
    termsUrl: 'https://lawrenceks.maps.arcgis.com/apps/instant/basic/index.html?appid=d7c108bb6a0c405aa50a3e8168102b75',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Lawrence, Kansas\'s public camera layer that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  arcgisOrSalem: {
    id: 'arcgisOrSalem',
    name: 'Salem, Oregon traffic cameras',
    kind: 'camera-feed',
    origin: 'https://egov.cityofsalem.net',
    serviceUrl: 'https://egov.cityofsalem.net/traffic-cameras/cameras/',
    metadataUrl: 'https://services.arcgis.com/kIA6yS9KDGqZL7U3/arcgis/rest/services/TrafficCams/FeatureServer/0',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'City of Salem, Oregon',
    termsUrl: 'https://salem.maps.arcgis.com/apps/instant/sidebar/index.html?appid=1dc340e3cbe34aadb723d0d6dd763e15',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Salem, Oregon\'s public camera layer that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  arcgisOrTripcheck: {
    id: 'arcgisOrTripcheck',
    name: 'Oregon DOT cameras (TripCheck)',
    kind: 'camera-feed',
    origin: 'https://tripcheck.com',
    serviceUrl: 'https://tripcheck.com/RoadCams/cams/',
    metadataUrl: 'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/TripCheck_Cameras/FeatureServer/0',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Oregon DOT (TripCheck)',
    termsUrl: 'https://tripcheck.com/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Oregon\'s public camera layer that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  arcgisUtUdot: {
    id: 'arcgisUtUdot',
    name: 'Utah DOT cameras (UDOT Traffic)',
    kind: 'camera-feed',
    origin: 'https://udottraffic.utah.gov',
    serviceUrl: 'https://udottraffic.utah.gov/1_devices/',
    metadataUrl: 'https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services/CCTV/FeatureServer/0',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 2000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Utah DOT (UDOT Traffic)',
    termsUrl: 'https://www.udottraffic.utah.gov/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Utah\'s public camera layer that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  carsPublic: {
    id: 'carsPublic',
    name: 'Road camera pictures (511MN and 511IN)',
    kind: 'camera-feed',
    origin: 'https://public.carsprogram.org',
    serviceUrl: 'https://public.carsprogram.org/cameras/',
    metadataUrl: 'https://mntg.carsprogram.org/cameras_v1/api/cameras',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Minnesota DOT and Indiana DOT',
    termsUrl: 'https://511mn.org/help/terms-of-use.html',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every public, active camera on the Minnesota and Indiana lists that has a position and a picture on this host that is under a day old, taken from the operators\' own lists when the committed snapshot was last refreshed. The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  carsKs: {
    id: 'carsKs',
    name: 'Kansas road camera pictures (KanDrive)',
    kind: 'camera-feed',
    origin: 'https://kscam.carsprogram.org',
    serviceUrl: 'https://kscam.carsprogram.org/snapshots/',
    metadataUrl: 'https://kstg.carsprogram.org/cameras_v1/api/cameras',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Kansas DOT (KanDrive)',
    termsUrl: 'https://kandrive.gov/help/tou.html',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every public, active camera on Kansas DOT\'s list that is owned by Kansas DOT (KDOT ITS or KDOT RWIS), has a position and a picture on this host that is under a day old, taken from the list when the committed snapshot was last refreshed. The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  srtmcImages: {
    id: 'srtmcImages',
    name: 'Spokane road camera pictures (SRTMC)',
    kind: 'camera-feed',
    origin: 'https://images.srtmc.org',
    serviceUrl: 'https://images.srtmc.org/',
    metadataUrl: 'https://www.srtmc.org/api/graphql',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Spokane Regional Transportation Management Center',
    termsUrl: 'https://www.srtmc.org/resources/terms-of-use.html',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every active camera on the Spokane Regional Transportation Management Center\'s map that has a position and a picture on this host, taken from its map query when the committed snapshot was last refreshed. The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  iterisVaVdot: {
    id: 'iterisVaVdot',
    name: 'Virginia DOT cameras (VDOT)',
    kind: 'camera-feed',
    origin: 'https://snapshot.vdotcameras.com',
    serviceUrl: 'https://snapshot.vdotcameras.com/',
    metadataUrl: 'https://data.511-atis-ttrip-prod.iteriscloud.com/datasets/cameras/icons.cameras.geojson',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 2000 },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Virginia DOT (VDOT)',
    termsUrl: 'https://511.vdot.virginia.gov/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in Virginia\'s public camera list that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the list when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  iterisSdSddot: {
    id: 'iterisSdSddot',
    name: 'South Dakota DOT cameras (SDDOT)',
    kind: 'camera-feed',
    origin: 'https://sd.cdn.iteris-atis.com',
    serviceUrl: 'https://sd.cdn.iteris-atis.com/camera_images/',
    metadataUrl: 'https://sd.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'South Dakota DOT (SDDOT)',
    termsUrl: 'https://www.sd511.org/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in South Dakota\'s public camera list that has a position, '
      + 'and a picture address on this host, taken from the list when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  socrataTxAustin: {
    id: 'socrataTxAustin',
    name: 'Austin, Texas traffic cameras',
    kind: 'camera-feed',
    origin: 'https://cctv.austinmobility.io',
    serviceUrl: 'https://cctv.austinmobility.io/image/',
    metadataUrl: 'https://datahub.austintexas.gov/resource/b4k4-adkb.json',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'City of Austin Transportation and Public Works',
    termsUrl: 'https://data.austintexas.gov/d/b4k4-adkb',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in the City of Austin\'s public camera list that the operator marks in service, '
      + 'has a position and has a picture address on this host, taken from the list when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  socrataLaBatonrouge: {
    id: 'socrataLaBatonrouge',
    name: 'Baton Rouge traffic cameras',
    kind: 'camera-feed',
    origin: 'https://511la.org',
    serviceUrl: 'https://511la.org/map/Cctv/',
    metadataUrl: 'https://data.brla.gov/resource/6z6u-ts44.json',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 1000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'City of Baton Rouge / LA DOTD',
    termsUrl: 'https://data.brla.gov/d/6z6u-ts44',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every camera in the City of Baton Rouge\'s public camera list that has a position, '
      + 'and a picture address on this host, taken from the list when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-04',
  },
  phenocam: {
    id: 'phenocam',
    name: 'PhenoCam Network',
    kind: 'camera-feed',
    origin: 'https://phenocam.nau.edu',
    serviceUrl: 'https://phenocam.nau.edu/api/cameras/',
    metadataUrl: 'https://phenocam.nau.edu/api/cameras/',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'PhenoCam Network (CC BY)',
    termsUrl: 'https://phenocam.nau.edu/webcam/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every PhenoCam Network research camera in the United States that the network '
      + 'lists as active and that sent a picture in the 30 days before the site was built, from its own '
      + 'camera list. Each pin shows the camera\'s latest picture straight from the network\'s server and '
      + 'links to the camera\'s page there. The list names each camera\'s contact people; this site '
      + 'does not copy them.',
    measuredOn: '2026-10-04',
  },
  aviationwx: {
    id: 'aviationwx',
    name: 'AviationWX airport cameras',
    kind: 'camera-feed',
    origin: 'https://api.aviationwx.org',
    serviceUrl: 'https://api.aviationwx.org/v1/airports',
    metadataUrl: 'https://api.aviationwx.org/v1/airports',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Weather data from AviationWX.org',
    termsUrl: 'https://aviationwx.org/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every United States airport webcam on the public AviationWX list, one pin per '
      + 'camera, taken from the service\'s own airport list when the site is built. Each pin shows the '
      + 'camera\'s latest picture straight from the service and links to the airport\'s page there. '
      + 'The service does not publish when a picture was taken.',
    measuredOn: '2026-10-04',
  },
  carsCo: {
    id: 'carsCo',
    name: 'Colorado road camera pictures (COtrip)',
    kind: 'camera-feed',
    origin: 'https://cocam.carsprogram.org',
    serviceUrl: 'https://cocam.carsprogram.org/snapshots/',
    metadataUrl: 'https://cotg.carsprogram.org/cameras_v1/api/cameras',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Colorado DOT (COtrip)',
    termsUrl: 'https://www.cotrip.org/',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every public, active camera on Colorado DOT\'s list that is owned by Colorado DOT (CDOT or CDOT Cellular), has a position and a picture on this host that is under a day old, taken from the list when the committed snapshot was last refreshed. The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-05',
  },
  arcgisWaKirkland: {
    id: 'arcgisWaKirkland',
    name: 'City of Kirkland, Washington cameras',
    kind: 'camera-feed',
    origin: 'https://its.kirklandwa.gov',
    serviceUrl: 'https://its.kirklandwa.gov/CamView/',
    metadataUrl: 'https://services2.arcgis.com/loGMwowmR0OPlOQb/arcgis/rest/services/TRN_TrafficCams_10032022/FeatureServer/0',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 2000 },
    pagination: true,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'City of Kirkland, Washington',
    termsUrl: 'https://www.kirklandwa.gov/Site-Footer/Website-Disclaimer',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every City of Kirkland camera in the city\'s public camera layer that has a position, '
      + 'has a picture address on this host, taken from the layer when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-05',
  },
  wsdotWaFerries: {
    id: 'wsdotWaFerries',
    name: 'Washington State Ferries terminal cameras (WSDOT)',
    kind: 'camera-feed',
    origin: 'https://images.wsdot.wa.gov',
    serviceUrl: 'https://images.wsdot.wa.gov/wsf/',
    metadataUrl: 'https://wsdot.com/ferries/vesselwatch/Cameras.ashx',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false, maxRecordCount: 100 },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'Washington State Ferries (WSDOT)',
    termsUrl: 'https://wsdot.wa.gov/about/policies/travel-information-disclaimer',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'Every active Washington State Ferries terminal camera in WSDOT\'s ferry map list that has a position '
      + 'and a picture address under this host\'s /wsf/ folder, taken from the list when the site is built. '
      + 'The operator does not publish when a picture was taken; the snapshot names when its list was last checked.',
    measuredOn: '2026-10-05',
  },
  volcview: {
    id: 'volcview',
    name: 'USGS VolcView and AVO volcano cameras',
    kind: 'camera-feed',
    origin: 'https://volcview.wr.usgs.gov',
    serviceUrl: 'https://volcview.wr.usgs.gov/ashcam-api/webcamApi/webcams',
    metadataUrl: 'https://avo.alaska.edu/ashcam-api/webcamApi/webcams',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'USGS VolcView',
    termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'The USGS VolcView cameras whose owner the feed states or whose page is a federal '
      + 'one (USGS, the Alaska Volcano Observatory, the FAA, the National Park Service), with a position '
      + 'and a picture under a day old when the site was built; the Alaska Volcano Observatory list names '
      + 'each camera\'s owner. Each pin shows the camera\'s latest picture straight from the USGS server '
      + 'and links to the camera\'s VolcView page, credited to its owner. The map does not say when a '
      + 'picture was taken.',
    measuredOn: '2026-10-05',
  },
  glerl: {
    id: 'glerl',
    name: 'NOAA GLERL Great Lakes cameras',
    kind: 'camera-feed',
    origin: 'https://www.glerl.noaa.gov',
    serviceUrl: 'https://www.glerl.noaa.gov/metdata/',
    metadataUrl: 'https://www.glerl.noaa.gov/metdata/',
    spatialReference: { wkid: 4326 },
    limits: { requiresKey: false },
    pagination: false,
    cors: 'none',
    paintedAs: 'img',
    attribution: 'NOAA Great Lakes Environmental Research Laboratory (GLERL)',
    termsUrl: 'https://www.glerl.noaa.gov/home/notice.html',
    dateBasis: 'unknown',
    claim: 'observation',
    coverageSemantics: 'The cameras on the lighthouses, piers and stations of NOAA\'s Great Lakes '
      + 'Environmental Research Laboratory that sent a picture in the day before the site was built, from '
      + 'the laboratory\'s own camera page. Each pin shows the camera\'s latest picture straight from '
      + 'NOAA\'s server and links to the station\'s page there. The laboratory does not publish when a '
      + 'picture was taken.',
    measuredOn: '2026-10-05',
  },
});

export const APPROVED_ORIGINS = Object.freeze(
  [...new Set(Object.values(SOURCES).map((s) => s.origin))].sort(),
);

export const REQUEST_POLICY = deepFreeze({
  timeoutMs: 20000, retries: 2, retryBackoffMs: [500, 2000], maxConcurrent: 6,
});

export const FAILURE = Object.freeze({
  tilesMissing: (n, m) => `USGS Topo did not return ${n} of ${m} required tiles. PDF creation is blocked.`,
  paging: (p, n) => `MVUM returned more records than one response can contain; fetching page ${p} of ${n}.`,
  coverageUnknown: 'MVUM coverage for this area is unavailable or unknown. Remove this layer to continue.',
  noUniformDate: (d) => `This source does not publish a uniform data date. Retrieved ${d}.`,
  closuresUnsupported: 'Temporary closure data is not supported for this forest. Check current Forest Service orders before travel.',
});

/** Attribution lines for the sources a build actually consumed, in registry order
 *  and de-duplicated by credit — several layers share one service, and printing
 *  the Forest Service twice is noise, not diligence.
 *
 *  Terms of use are the reason this is derived rather than written: every entry
 *  in SOURCES carries the credit its publisher asks for, and the sheet used to
 *  print two of them because the line was hand-built from two ids. A source that
 *  cannot be added without its attribution reaching paper cannot be forgotten. */
export function attributionLines(sourceIds = [], extra = []) {
  const seen = new Set(), lines = [];
  for (const id of Object.keys(SOURCES)) {
    if (!sourceIds.includes(id)) continue;
    const s = SOURCES[id];
    if (seen.has(s.attribution)) continue;
    seen.add(s.attribution);
    lines.push(`${s.name} — ${s.attribution}`);
  }
  return [...lines, ...extra];
}

/** CSP hosts the page needs: connect-src for every source, img-src for raster tiles only. */
export function cspDirectivesFor(sources = SOURCES) {
  const list = Object.values(sources);
  const unique = (xs) => [...new Set(xs)].sort();
  return {
    // cors: 'none' (QUX-08D-ii's npsWebcams) means the page never connects to that origin
    // itself -- it reads a same-origin build-time snapshot instead -- so it is excluded here.
    'connect-src': unique(list.filter((s) => s.cors !== 'none').map((s) => s.origin)),
    // A source the browser loads INTO AN <img> needs img-src; connect-src does not
    // cover it, and the picture then fails to paint with nothing in the diff to say
    // why. A tile cache always paints that way; an exported image paints that way
    // when the app hands its URL to an overlay instead of fetching it into a canvas,
    // which is what `paintedAs: 'img'` records.
    'img-src': unique(list.filter((s) => s.kind === 'raster-tiles' || s.paintedAs === 'img')
      .map((s) => s.origin)),
  };
}
