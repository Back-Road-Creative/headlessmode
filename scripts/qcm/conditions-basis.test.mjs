// QUX-09b "Before you go" (.data/plans/2026-09-27-qux-specs/QUX-09.md §2.5.1,
// §4.3): pure basis-lines proof, the static wiring proof, and the timeout
// ceiling (D5). No DOM, no network -- scripts/qcm/before-you-go.test.mjs
// covers the browser-side behavior these pieces wire into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  basisLines, SKY_LINE, FORECAST_LINE, ALERTS_LINE, GRID_CELL_NOTE,
} from '../../themes/headlessmode/static/js/quiet-corners-sky/conditions-basis.js';
import { createForecastLoader } from '../../themes/headlessmode/static/js/quiet-corners-maps/source-weather.js';

const KINDS = ['summit', 'ridge', 'gap', 'lake', 'town', 'spring', 'other'];
const GRID_CELL_KINDS = ['summit', 'ridge', 'gap'];
const BANNED = /station|clear|safe|no hazard/i;

test('basisLines always returns exactly three lines, one per source', () => {
  for (const kind of KINDS) {
    const lines = basisLines({ kind });
    assert.equal(lines.length, 3, `kind "${kind}" should yield exactly 3 lines, got ${lines.length}`);
  }
});

test('summit, ridge and gap carry the grid-cell sentence on the forecast line; nothing else does', () => {
  for (const kind of KINDS) {
    const [, forecast] = basisLines({ kind });
    if (GRID_CELL_KINDS.includes(kind)) {
      assert.ok(forecast.includes(GRID_CELL_NOTE), `kind "${kind}" should carry the grid-cell sentence`);
      assert.ok(forecast.startsWith(FORECAST_LINE), `kind "${kind}" should still open with the base forecast line`);
    } else {
      assert.equal(forecast, FORECAST_LINE, `kind "${kind}" should not carry the grid-cell sentence`);
    }
  }
});

test('the sky and alerts lines never change with kind', () => {
  for (const kind of KINDS) {
    const [sky, , alerts] = basisLines({ kind });
    assert.equal(sky, SKY_LINE);
    assert.equal(alerts, ALERTS_LINE);
  }
});

test('no basis line ever says station, clear, safe or no hazard(s)', () => {
  for (const kind of KINDS) {
    for (const line of basisLines({ kind })) {
      assert.doesNotMatch(line, BANNED, `"${line}" should not match ${BANNED}`);
    }
  }
});

test('an unknown or missing kind still yields the plain (non-grid-cell) forecast line', () => {
  assert.deepEqual(basisLines({ kind: 'nonsense' }), [SKY_LINE, FORECAST_LINE, ALERTS_LINE]);
  assert.deepEqual(basisLines({}), [SKY_LINE, FORECAST_LINE, ALERTS_LINE]);
  assert.deepEqual(basisLines(), [SKY_LINE, FORECAST_LINE, ALERTS_LINE]);
});

// --- Static wiring proof: the bridge exists in both files, before either is
// ever loaded in a browser. Same idiom scripts/qcm/nws-alerts.test.mjs uses
// to scan quiet-corners.js's own source (its DASH constant). ---
const QC_JS = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners.js', import.meta.url), 'utf8');
const MAIN_JS = readFileSync(new URL('../../themes/headlessmode/static/js/quiet-corners-maps/main.js', import.meta.url), 'utf8');

test('quiet-corners.js defines window.qcConditionsFor next to the other page bridges', () => {
  assert.match(QC_JS, /window\.qcConditionsFor\s*=/);
});

test('main.js calls the bridge only behind a typeof guard, and offers "Before you go"', () => {
  assert.match(MAIN_JS, /typeof window\.qcConditionsFor === 'function'/);
  assert.ok(MAIN_JS.includes('Before you go'));
});

// --- Timeout ceiling (D5): a hang must land in the loader's existing failure
// path (a rejection fetchHourly already throws through) within timeoutMs,
// never hold a pending note up forever. Mirrors weather-nws.test.mjs's own
// fetchImpl-throws rejection proofs, and the AbortSignal wiring real fetch
// itself provides -- a fetchImpl that ignores the call but honours the
// signal it was handed, the only way this can ever settle. ---
test('createForecastLoader rejects within its timeoutMs ceiling when the fetch never settles', { timeout: 2000 }, async () => {
  const neverResolves = (url, init = {}) => new Promise((_resolve, reject) => {
    const { signal } = init;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
  const loader = createForecastLoader({ fetchImpl: neverResolves, timeoutMs: 50 });
  // AbortSignal.timeout()'s own internal timer is unref'd (Node's doc default,
  // so a real caller's event loop is never held open by it) -- with nothing
  // else pending, a bare `node --test` run of this one test can idle out and
  // exit before that timer ever fires. A ref'd interval keeps the loop alive
  // for that window without changing what is under test.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(loader.request({ lat: 33.2699, lon: -85.8337 }));
  } finally {
    clearInterval(keepAlive);
  }
});
