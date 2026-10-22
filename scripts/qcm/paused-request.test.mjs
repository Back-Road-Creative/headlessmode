// A paused request the page has already given up on must not fail an unrelated test.
//
// terrain-panel.test.mjs intercepts every request (Fetch.requestPaused) and answers each
// one from an async listener. Under load the page can cancel a paused request before the
// answer lands -- MapLibre aborts its tile fetches when the panel closes -- and Chromium
// then replies "Invalid InterceptionId". Nothing awaits that listener, so the rejection
// was unhandled and node's runner charged it to whichever test happened to be running:
// terrain :395 and the ten-cycle test both went red that way on 2026-09-27, on trees that
// never touched terrain, and #599's CI with them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settlePaused } from './helpers/paused-request.mjs';

const cancelled = () => Promise.reject(new Error('Fetch.fulfillRequest: Invalid InterceptionId.'));

test('a verdict for a request the page already cancelled resolves quietly', async () => {
  assert.equal(await settlePaused(cancelled, 'Fetch.fulfillRequest', { requestId: '1' }), null);
});

// Verdicts can also land after the test's own finally closed the session: a request paused
// a moment before close is answered into a dead socket. #702's camera-requests run on
// 2026-10-06 lost "park cameras" that way ("Fetch.continueRequest: devtools socket closed")
// as activity charged to a test that had already passed. Nothing is left to answer there
// either; the test body's own awaited sends are what prove a live session.
test('a verdict after the session closed resolves quietly', async () => {
  const closed = () => Promise.reject(new Error('Fetch.continueRequest: devtools socket closed: mkdir: cannot create directory'));
  assert.equal(await settlePaused(closed, 'Fetch.continueRequest', { requestId: '4' }), null);
});

test('every other protocol error still rejects, so a real failure stays red', async () => {
  const timedOut = () => Promise.reject(new Error('Fetch.continueRequest timed out'));
  await assert.rejects(settlePaused(timedOut, 'Fetch.continueRequest', { requestId: '2' }), /timed out/);
});

test('the method and params reach send unchanged and its result comes back', async () => {
  const calls = [];
  const send = async (method, params) => { calls.push([method, params]); return { ok: 1 }; };
  const params = { requestId: '3', responseCode: 200 };
  assert.deepEqual(await settlePaused(send, 'Fetch.fulfillRequest', params), { ok: 1 });
  assert.deepEqual(calls, [['Fetch.fulfillRequest', params]]);
});

for (const file of ['terrain-panel', 'camera-requests']) {
  test(`${file} answers every paused request through settlePaused`, () => {
    const src = readFileSync(new URL(`./${file}.test.mjs`, import.meta.url), 'utf8');
    const direct = src.match(/session\.send\(\s*'Fetch\.(fulfillRequest|continueRequest|continueResponse|failRequest)'/g) || [];
    assert.deepEqual(direct, [], 'a direct Fetch verdict can reject unhandled when the page cancels the request or the session is closed');
    assert.match(src, /settlePaused\(/);
  });
}
