// Two things every bounded ArcGIS view query needs, written once.
//
// `serviceError` exists because an ArcGIS failure is not an HTTP failure: every one measured
// on these services arrived as `{"error":{…}}` inside a 200-shaped JSON body, so `res.ok` is
// true and `features` is absent -- which reads exactly like "nothing here". It reads `details`
// before `message` because NIFC's `message` measured EMPTY on a real 400, with "The requested
// layer (layerId: 99) was not found." in `details` alone.
//
// `viewReader` is the pan protocol the AQI surface established: a bbox query means the new
// view is a NEW question, so the ask waits out a drag and the answer about the view the reader
// left is abandoned. source-aqi.js still holds the original private copy of that loop; folding
// it in is a later unit's job, not this one's.

/** The sentence an ArcGIS error envelope actually carries, or null when the body is a normal
 *  answer. Never throws: a non-JSON-shaped body is simply not an error this can name. */
export function serviceError(body) {
  const e = body && typeof body === 'object' ? body.error : null;
  if (!e) return null;
  const detail = Array.isArray(e.details) ? e.details.filter(Boolean).join(' ') : '';
  return detail || e.message || `the service refused the query (code ${e.code ?? 'unknown'}).`;
}

/** lon/lat envelope in the order every one of these services takes it. */
export const envelope = (b) => `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;

/** One bounded question at a time, for the view the reader stopped on. `ask` resolves false
 *  when it was dropped -- superseded by a newer view, or cancelled -- so a caller can tell a
 *  stale answer from a delivered one without inspecting what came back. */
export function viewReader({ fetchOne, waitMs = 400, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, live = null, drop = null;
  const stop = () => {
    if (timer) clearTimer(timer);
    if (live) live.abort();
    if (drop) drop(false);
    timer = null; live = null; drop = null;
  };
  return {
    cancel: stop,
    ask(bbox, deliver) {
      stop();
      return new Promise((resolve) => {
        drop = resolve;
        timer = setTimer(async () => {
          timer = null;
          const ctl = new AbortController();
          live = ctl;
          const got = await fetchOne(bbox, { signal: ctl.signal });
          if (live !== ctl) return;   // a newer ask took over and already resolved this one
          live = null; drop = null;
          deliver(got);
          resolve(true);
        }, waitMs);
      });
    },
  };
}
