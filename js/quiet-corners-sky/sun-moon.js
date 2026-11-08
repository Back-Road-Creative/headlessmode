// Sun and Moon for one local day at one place: sunrise, sunset, the civil, nautical and astronomical twilight
// boundaries, moonrise, moonset, how much of the Moon is lit, and the intervals it is above the horizon. Pure
// math — no DOM, no network, no key, no provider. The ONE owner of that calculation; sun-track-demo.js only
// charts bundled fixed scenarios. Meeus, "Astronomical Algorithms" 2nd ed.: ch. 25 for the Sun (low accuracy,
// ~0.01°), ch. 12 sidereal time, ch. 47 for the Moon with Table 47.A cut at |Σl| ≥ 1000e-6° and 47.B at |Σb| ≥
// 2000e-6° (~0.01° residual), ch. 48 for the phase, ch. 15 for the rise/set thresholds: −0.8333° for the Sun
// (refraction plus its semidiameter) and 0.7275·π − 0.5667° for the Moon, π its parallax, so a geocentric
// position serves. Rise, set and twilight sample geometric altitude every 5 minutes across the local day and
// bisect each sign change, so no-rise, no-set, polar day and polar night fall out of the same code as an
// ordinary day. Held to U.S. Naval Observatory values by scripts/qcm/sun-moon.test.mjs.
const D2R = Math.PI / 180, R2D = 180 / Math.PI, DAY_MS = 86400000, STEP_MS = 300000;
const AU_KM = 149597870.7, EARTH_KM = 6378.14;
const sin = (d) => Math.sin(d * D2R), cos = (d) => Math.cos(d * D2R);
const jd = (ms) => ms / DAY_MS + 2440587.5, cy = (ms) => (jd(ms) - 2451545) / 36525;

// Table 47.A: D, M, M', F, Σl (1e-6 deg, sine), Σr (1e-3 km, cosine).
const LON_R = [
  0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111, 2, 0, 0, 0, 658314, -2955968, 0, 0, 2, 0, 213618, -569925,
  0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149, 2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066, -152138,
  2, 0, 1, 0, 53322, -170733, 2, -1, 0, 0, 45758, -204586, 0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321, 0, 0, 1, 2, -12528, 0, 0, 0, 1, -2, 10980, 79661,
  4, 0, -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210, 4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208,
  2, 1, 0, 0, -6766, 30824, 1, 0, -1, 0, -5163, -8379, 1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445, 4, 0, 0, 0, 3861, -11650, 2, 0, -3, 0, 3665, 14403, 0, 1, -2, 0, -2689, -7003,
  2, 0, -1, 2, -2602, 0, 2, -1, -2, 0, 2390, 10056, 1, 0, 1, 0, -2348, 6322, 2, -2, 0, 0, 2236, -9884,
  0, 1, 2, 0, -2120, 5751, 0, 2, 0, 0, -2069, 0, 2, -2, -1, 0, 2048, -4950, 2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0, 4, -1, -1, 0, 1215, -3958, 0, 0, 2, 2, -1110, 0,
];
// Table 47.B: D, M, M', F, Σb (1e-6 deg, sine).
const LAT = [
  0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693, 2, 0, 0, -1, 173237, 2, 0, -1, 1, 55413,
  2, 0, -1, -1, 46271, 2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198, 2, 0, 1, -1, 9266, 0, 0, 2, -1, 8822,
  2, -1, 0, -1, 8216, 2, 0, -2, -1, 4324, 2, 0, 1, 1, 4200, 2, 1, 0, -1, -3359, 2, -1, -1, 1, 2463,
  2, -1, 0, 1, 2211, 2, -1, -1, -1, 2065,
];

// Apparent RA/dec of the Sun, the obliquity, and the Earth-Sun distance the phase needs (Meeus 25.2-25.10, 22.2-22.3).
function sunAt(ms) {
  const T = cy(ms), L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M)
    + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  const om = 125.04 - 1934.136 * T, lam = L0 + C - 0.00569 - 0.00478 * sin(om);
  const eps = 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T ** 3 + 0.00256 * cos(om);
  return { eps, lam, ra: R2D * Math.atan2(cos(eps) * sin(lam), cos(lam)), dec: R2D * Math.asin(sin(eps) * sin(lam)),
    rKm: AU_KM * 1.000001018 * (1 - e * e) / (1 + e * cos(M + C)) };
}

// Geocentric ecliptic longitude, latitude and distance of the Moon (Meeus ch. 47).
function moonAt(ms) {
  const T = cy(ms), T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000;
  const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000;
  const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.290 * T, A3 = 313.45 + 481266.484 * T;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  let sl = 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2), sr = 0;
  let sb = -2235 * sin(Lp) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lp - Mp) - 115 * sin(Lp + Mp);
  for (let i = 0; i < LON_R.length; i += 6) {
    const a = LON_R[i] * D + LON_R[i + 1] * M + LON_R[i + 2] * Mp + LON_R[i + 3] * F, w = E ** Math.abs(LON_R[i + 1]);
    sl += LON_R[i + 4] * w * sin(a); sr += LON_R[i + 5] * w * cos(a);
  }
  for (let i = 0; i < LAT.length; i += 5) {
    const a = LAT[i] * D + LAT[i + 1] * M + LAT[i + 2] * Mp + LAT[i + 3] * F;
    sb += LAT[i + 4] * E ** Math.abs(LAT[i + 1]) * sin(a);
  }
  const lam = Lp + sl / 1e6, beta = sb / 1e6, dKm = 385000.56 + sr / 1000, eps = sunAt(ms).eps;
  return { lam, beta, dKm, parallax: R2D * Math.asin(EARTH_KM / dKm),
    ra: R2D * Math.atan2(sin(lam) * cos(eps) - Math.tan(beta * D2R) * sin(eps), cos(lam)),
    dec: R2D * Math.asin(sin(beta) * cos(eps) + cos(beta) * sin(eps) * sin(lam)) };
}

// Apparent sidereal time (Meeus 12.4), then altitude from the local hour angle.
function altitude({ ra, dec }, ms, lat, lon) {
  const d = jd(ms) - 2451545, T = d / 36525;
  const H = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T ** 3 / 38710000 + lon - ra;
  return R2D * Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H));
}
/** Geometric altitude of the Sun's centre in degrees, no refraction applied. */
export function sunAltitude(ms, lat, lon) { return altitude(sunAt(ms), ms, lat, lon); }
const moonAbove = (t, lat, lon) => { const mo = moonAt(t); return altitude(mo, t, lat, lon) - (0.7275 * mo.parallax - 0.5667); };

// Every zero crossing of f in [t0, t1], bisected to well under a second, plus whether the body began above.
function crossings(f, t0, t1) {
  const events = []; let pt = t0, pv = f(t0); const startsAbove = pv >= 0;
  for (let t = t0 + STEP_MS; ; t += STEP_MS) {
    if (t > t1) t = t1;
    const v = f(t);
    if ((pv < 0) !== (v < 0)) {
      let a = pt, b = t, fa = pv;
      for (let i = 0; i < 14; i++) { const m = (a + b) / 2, fm = f(m); if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m; }
      events.push({ ms: Math.round((a + b) / 2), rising: pv < 0 });
    }
    pt = t; pv = v;
    if (t >= t1) break;
  }
  return { events, startsAbove };
}

const ZONES = new Map();
function zoneFmt(timeZone) {
  if (!ZONES.has(timeZone)) ZONES.set(timeZone, new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return ZONES.get(timeZone);
}
function zoneOffsetMs(timeZone, ms) {
  const p = {};
  for (const q of zoneFmt(timeZone).formatToParts(ms)) if (q.type !== 'literal') p[q.type] = +q.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// The instant of a wall-clock time in a real zone; two passes settle a DST shift.
function atLocal(timeZone, y, m, d, hour = 0) {
  const wall = Date.UTC(y, m - 1, d, hour); let ms = wall;
  for (let i = 0; i < 2; i++) ms = wall - zoneOffsetMs(timeZone, ms);
  return ms;
}
function ev(timeZone, ms) {
  const t = new Date(Math.round(ms / 60000) * 60000 + zoneOffsetMs(timeZone, ms)), pad = (n) => String(n).padStart(2, '0');
  return { ms, utc: new Date(ms).toISOString(), local: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` };
}

// One vocabulary for both bodies and every twilight depth: a missing time always arrives
// with a state saying why, so "it never rose" cannot read as "it failed".
function band(c, timeZone) {
  const up = c.events.find((e) => e.rising) || null, down = c.events.filter((e) => !e.rising).pop() || null;
  const state = up && down ? 'rises-and-sets' : up ? 'no-set' : down ? 'no-rise' : c.startsAbove ? 'always-above' : 'always-below';
  return { up: up && ev(timeZone, up.ms), down: down && ev(timeZone, down.ms), state };
}

/**
 * Sun and Moon for the calendar day `date` (YYYY-MM-DD) as it runs in `timeZone` (an
 * IANA name, so daylight saving and 23/25-hour days are handled). Unusable input
 * throws; a valid day with no rise, no set, polar day or polar night returns null
 * times beside a `state` naming the situation. Moon illumination and the above-horizon
 * intervals are separate outputs, and clouds are no business of this module: darkness,
 * moonlight and weather stay three facts rather than one verdict.
 */
export function sunMoonForDay({ lat, lon, date, timeZone, illuminationAt }) {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) throw new RangeError(`lat must be -90..90, got ${lat}`);
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) throw new RangeError(`lon must be -180..180, got ${lon}`);
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!parts) throw new TypeError(`date must be YYYY-MM-DD, got ${date}`);
  const [y, m, d] = parts.slice(1).map(Number);
  zoneFmt(timeZone); // an unknown zone throws RangeError here, before any arithmetic
  const t0 = atLocal(timeZone, y, m, d), t1 = atLocal(timeZone, y, m, d + 1);
  const solar = (depth) => band(crossings((t) => sunAltitude(t, lat, lon) - depth, t0, t1), timeZone);
  const day = solar(-0.8333), twi = (depth) => { const b = solar(depth); return { morning: b.up, evening: b.down, state: b.state }; };

  const c = crossings((t) => moonAbove(t, lat, lon), t0, t1), aboveHorizon = [];
  let open = c.startsAbove ? { at: t0, edge: true } : null;
  const shut = (at, toDayEnd) => { aboveHorizon.push({ start: ev(timeZone, open.at), end: ev(timeZone, at), fromDayStart: open.edge, toDayEnd }); open = null; };
  for (const e of c.events) { if (e.rising) open = { at: e.ms, edge: false }; else if (open) shut(e.ms, false); }
  if (open) shut(t1, true);

  // Illuminated fraction (Meeus 48.2-48.3), by default at 12:00 local, the instant USNO's percentage matches.
  const lit = illuminationAt === undefined ? atLocal(timeZone, y, m, d, 12) : Number(illuminationAt);
  const s = sunAt(lit), mo = moonAt(lit), psi = R2D * Math.acos(cos(mo.beta) * cos(mo.lam - s.lam));
  const fraction = (1 + cos(R2D * Math.atan2(s.rKm * sin(psi), mo.dKm - s.rKm * cos(psi)))) / 2;
  const moonBand = band(c, timeZone);
  return {
    date, timeZone,
    day: { start: ev(timeZone, t0), end: ev(timeZone, t1), hours: (t1 - t0) / 3600000 },
    sun: { rise: day.up, set: day.down, state: day.state, twilight: { civil: twi(-6), nautical: twi(-12), astronomical: twi(-18) } },
    moon: { rise: moonBand.up, set: moonBand.down, state: moonBand.state, aboveHorizon,
      illuminatedFraction: fraction, illuminatedPercent: Math.round(fraction * 100), illuminatedAt: ev(timeZone, lit) },
  };
}
