// The capture's numbers as the summary a person reads: pure functions over the results object
// capture-atlas.mjs builds. Every sentence is a template filled with a number from the run.
import { NEAR_DUPLICATE, RELATED } from './atlas-metrics.mjs';

export const TILE_BASES = ['usgsTopo', 'usgsImagery', 'usgsShadedRelief'];
export const LABELS = { usgsTopo: 'USGS Topo', usgsImagery: 'Aerial imagery', usgsShadedRelief: 'Shaded relief', none: 'No base map' };
const label = (id) => LABELS[id] ?? id;
export const pairKey = (a, b) => `${a}|${b}`;
export const PAIRS = TILE_BASES.flatMap((a, i) => TILE_BASES.slice(i + 1).map((b) => [a, b]));

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const f = (x, d = 2) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything the report says, as data. `scenes` that carry an `error` are listed under
 *  `unmeasured` and left out of every median. */
export function summarise({ scenes = [] } = {}) {
  const measured = scenes.filter((s) => !s.error), unmeasured = scenes.filter((s) => s.error);
  const n = measured.length;
  const pairs = PAIRS.map(([a, b]) => {
    const key = pairKey(a, b), cells = measured.map((s) => s.pairs?.off?.[key]).filter(Boolean);
    return {
      a, b, key, median: median(cells.map((c) => c.score)),
      min: cells.length ? Math.min(...cells.map((c) => c.score)) : null,
      nearDuplicate: cells.filter((c) => c.band === 'near-duplicate').length,
      related: cells.filter((c) => c.band === 'related').length, scenes: cells.length,
    };
  });
  const ranked = pairs.filter((p) => p.median !== null).sort((x, y) => x.median - y.median);
  const mostSimilar = ranked.length ? {
    ...ranked[0], toNearDuplicateLine: ranked[0].median - NEAR_DUPLICATE,
    overNext: ranked[1] ? ranked[1].median - ranked[0].median : null, next: ranked[1] ?? null,
  } : null;

  const bases = {};
  for (const id of [...TILE_BASES, 'none']) {
    const cell = (s, w) => s.bases?.[id]?.[w];
    const tileTrouble = { failed: 0, blank: 0, placeholder: 0, http: 0, judged: 0, scenes: [] };
    for (const s of measured) {
      const t = cell(s, 'off')?.tiles, h = cell(s, 'off')?.http;
      if (!t) continue;
      tileTrouble.judged += t.judged ?? t.total; tileTrouble.failed += t.failed; tileTrouble.blank += t.blank; tileTrouble.placeholder += t.placeholder; tileTrouble.http += h?.bad ?? 0;
      if (t.failed + t.blank + t.placeholder + (h?.bad ?? 0) > 0) tileTrouble.scenes.push(s.id);
    }
    const stats = {
      tileTrouble,
      firstVisitMs: median(measured.map((s) => cell(s, 'off')?.ms)), repeatMs: median(measured.map((s) => cell(s, 'on')?.ms)),
      contrastOff: median(measured.map((s) => cell(s, 'off')?.contrast?.ratio)), contrastOn: median(measured.map((s) => cell(s, 'on')?.contrast?.ratio)),
    };
    stats.verdict = id === 'none' ? verdictNone() : verdictTile(id, stats, pairs, n);
    bases[id] = stats;
  }
  return { scenes: n, pairs, mostSimilar, bases, unmeasured: unmeasured.map((s) => ({ id: s.id, name: s.name, landmark: s.landmark, error: s.error })) };
}

function verdictTile(id, st, pairs, n) {
  const mine = pairs.filter((p) => p.a === id || p.b === id), out = [];
  const other = (p) => label(p.a === id ? p.b : p.a);
  const dup = mine.filter((p) => p.nearDuplicate), rel = mine.filter((p) => p.related);
  if (!n) out.push('Not measured.');
  else if (dup.length) out.push(`Near-duplicate of ${dup.map((p) => `${other(p)} in ${p.nearDuplicate} of ${plural(p.scenes, 'scene')}`).join(' and of ')}: in those scenes it adds little the other does not.`);
  else if (rel.length) out.push(`Related to ${rel.map((p) => `${other(p)} in ${p.related} of ${plural(p.scenes, 'scene')}`).join(' and to ')} (shares structure, not a duplicate).`);
  else out.push(`Distinct from both other bases with scores off in ${n === 1 ? 'the 1 scene' : `all ${n} scenes`} (lowest score ${f(Math.min(...mine.map((p) => p.min)))}).`);
  const t = st.tileTrouble, flat = t.blank + t.placeholder, trouble = [];
  if (t.failed || t.http) trouble.push(`${plural(t.failed, 'tile image')} did not load and ${plural(t.http, 'tile request')} failed or returned an error status`);
  if (flat) trouble.push(`${plural(flat, 'flat tile')} (${t.blank} one-colour, ${t.placeholder} grey or white)`);
  out.push(trouble.length
    ? `${trouble.join('; ')}, in ${plural(t.scenes.length, 'scene')} (${t.scenes.join(', ')}).${flat ? ' Open water and flat ground draw flat too, so look at those screenshots before calling a flat tile a defect.' : ''}`
    : 'No failed, error-status or flat tiles.');
  if (t.judged && flat / t.judged >= 0.5) out.push(`${flat} of ${t.judged} judged tiles are flat, so its high distinctness comes from having little on it, not from showing something the others lack.`);
  if (st.contrastOff !== null) out.push(`Lettering contrast, an estimate from the pixels: median ${f(st.contrastOff, 1)}:1 with scores off${st.contrastOn !== null ? `, ${f(st.contrastOn, 1)}:1 with scores on` : ''}.`);
  return out.join(' ');
}
const verdictNone = () => 'Draws no tiles, so there is nothing to compare: it is the county map alone, and every other base is distinct from it by construction.';

const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

/** The markdown report. */
export function renderReport(results) {
  const s = summarise(results), { scenes = [] } = results, out = [];
  out.push('# Base-map comparison atlas', '');
  out.push(`Generated by \`scripts/qcm/atlas/capture-atlas.mjs\`${results.generated ? ` on ${results.generated}` : ''} against the live USGS tile services${results.viewport ? `, headless Chromium, ${results.viewport.width}x${results.viewport.height} window, zoom ${results.zoom}` : ''}. No images are committed; the screenshots stay in the run's output directory.`, '');
  if (s.mostSimilar) {
    const m = s.mostSimilar;
    out.push(`**Most similar pair:** ${label(m.a)} and ${label(m.b)}, median distinctness ${f(m.median)} over ${plural(m.scenes, 'scene')} (lowest single scene ${f(m.min)}). That is ${f(Math.abs(m.toNearDuplicateLine))} ${m.toNearDuplicateLine < 0 ? 'inside' : 'above'} the near-duplicate line (${NEAR_DUPLICATE})${m.next ? `, and ${f(m.overNext)} below the next pair, ${label(m.next.a)} and ${label(m.next.b)} (${f(m.next.median)})` : ''}.`, '');
  } else out.push('**Most similar pair:** not available, no scene was measured.', '');
  if (s.unmeasured.length) {
    out.push(`**Not measured:** ${s.unmeasured.map((u) => `${u.id} (${u.landmark ?? u.name}): ${u.error}`).join('; ')}.`, '');
  }
  out.push('## Role of each base, from the numbers', '', ...[...TILE_BASES, 'none'].map((id) => `- **${label(id)}.** ${s.bases[id].verdict}`), '');
  const cell = (x, a, b) => ['off', 'on'].map((k) => { const d = x.pairs?.[k]?.[pairKey(a, b)]; return `${f(d?.score)}${d && d.band !== 'distinct' ? ` ${d.band}` : ''}`; }).join(' / ');
  out.push('## Pairwise distinctness per scene', '',
    'Each cell is the score with scores off / with scores on (0 the same structure, 1 unrelated); a band is named only when it is not distinct. Colour difference is in `atlas.json`, not part of the score.', '');
  out.push(table(['Scene', ...PAIRS.map(([a, b]) => `${a} vs ${b}`)], scenes.filter((x) => !x.error).map((x) => [x.id, ...PAIRS.map(([a, b]) => cell(x, a, b))])), '');
  out.push('## Tiles, timing and lettering, all scenes together', '');
  out.push(table(['Base', 'Tiles judged', 'Failed', 'Blank', 'Placeholder', 'Bad HTTP', 'First visit (ms)', 'Repeat (ms)', 'Contrast off', 'Contrast on'],
    [...TILE_BASES, 'none'].map((id) => { const b = s.bases[id], t = b.tileTrouble; return [id, t.judged, t.failed, t.blank, t.placeholder, t.http, Math.round(b.firstVisitMs ?? 0), Math.round(b.repeatMs ?? 0), f(b.contrastOff, 1), f(b.contrastOn, 1)]; })),
    'Times and contrast are medians over the scenes; the other columns are totals. The per-scene numbers are in `atlas.json`.', '');
  out.push('## Scenes', '', scenes.map((x) => `**${x.id}**: ${x.landmark} (${x.at?.join(', ')})`).join('; ') + '.', '');
  out.push('## What the numbers mean', '',
    `- Distinctness compares two captures of the same map box by brightness structure and edges; a hue shift alone scores near 0. Near-duplicate below ${NEAR_DUPLICATE}, related below ${RELATED}, distinct above. It does not show a layer is useful (plan 4.4); the role sentences state what was measured and the call is a person's.`,
    '- Screenshots show the base alone: controls, legend, labels, markers and outlines are hidden (identical on every base, they would make any two look alike). With scores on, the county wash is kept.',
    '- "Blank" is a one-colour tile; "Placeholder" a flat grey or white one, alone or with a few marks. Pixels cannot tell a no-data tile from open water or flat ground, so these are flags to look at. "Failed" (tile image did not load) and "Bad HTTP" (request failed or answered 400 or above) are definite.',
    '- Lettering contrast is an estimate (WCAG ratio of the median to the 2nd or 98th percentile luminance), not a reading of the real labels. "First visit" is the time from choosing the base to every tile loaded and still; "Repeat" is the same with scores on, tiles from cache.', '');
  return out.join('\n');
}
