// Answer a paused request (Fetch.fulfillRequest / continueRequest / continueResponse)
// without letting a request the page already cancelled fail the run.
//
// A Fetch.requestPaused listener is async and nothing awaits it, so a rejected verdict
// becomes an unhandled rejection that node's test runner charges to whichever test is
// running. The page may legitimately cancel a paused request before the verdict lands
// (MapLibre aborts tile fetches when its panel closes); Chromium then answers
// "Invalid InterceptionId", and there is nothing left to answer. That one reply is
// ignored. So is a verdict that lands after the test's own teardown closed the session
// ("devtools socket closed", #702's camera-requests run on 2026-10-06): the request was
// paused a moment before close, and there is no session left to answer it on. A session
// that dies mid-test still fails that test through its own awaited sends. Every other
// error still rejects, so a real protocol failure stays red.

const NOTHING_TO_ANSWER = /Invalid InterceptionId|devtools socket closed/;

/** Sends one verdict through `send(method, params)`; resolves null when the page had
 *  already cancelled the request or the session is already closed, otherwise send's own
 *  result or rejection. */
export async function settlePaused(send, method, params) {
  try {
    return await send(method, params);
  } catch (err) {
    if (NOTHING_TO_ANSWER.test(err?.message ?? '')) return null;
    throw err;
  }
}
