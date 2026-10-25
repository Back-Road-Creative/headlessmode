// QQA-16c: the privacy guard's detector. Given the requests a page recorded ({ url, body }) and the camera
// that was saved, it says whether any request carries that camera. Pure, so camera-find.test.mjs proves it
// catches each way a camera could leak, and camera-find-browser.test.mjs proves the page-side recorder feeds it.

/** The strings that name a saved camera: its ref, the ref an older visit stored, the `d05:<n>` tail, its name. */
export function cameraCarriers({ ref, name }) {
  const parts = ref.split(':');   // camera:<source>:<district>:<id>, or the older camera:<source>:<id>
  const id = parts[parts.length - 1];
  const raw = [ref, `${parts[0]}:${parts[1]}:${id}`, parts.slice(2).join(':'), name].filter(Boolean);
  return [...new Set(raw.flatMap((c) => [c, encodeURIComponent(c), encodeURIComponent(c).replace(/%20/g, '+')]))];
}

/** `text` holds `carrier` as a whole token: not the front of a longer id (d05:17 is not d05:170). */
const holds = (text, carrier) => {
  for (let at = text.indexOf(carrier); at !== -1; at = text.indexOf(carrier, at + 1)) if (!/\w/.test(text[at + carrier.length] || '')) return true;
  return false;
};

const decoded = (text) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };

/** The first recorded request that carries the camera, as { req, carrier }, or null. */
export function findLeak(reqs, camera) {
  const carriers = cameraCarriers(camera);
  const id = camera.ref.split(':').pop();
  for (const req of reqs) {
    const url = String(req.url), body = String(req.body ?? '');
    for (const text of [url, decoded(url), body, decoded(body)]) {
      const carrier = carriers.find((c) => holds(text, c));
      if (carrier) return { req, carrier };
    }
    // The bare id is only a carrier where it stands alone: a query or hash value, or a token in a body.
    // (As a path part it would also match tile coordinates.)
    let values = [];
    try { const u = new URL(url, 'http://probe.invalid/'); values = [...u.searchParams.values(), ...new URLSearchParams(u.hash.replace(/^#/, '')).values()]; } catch { /* not a url */ }
    if (values.includes(id) || new RegExp(`(^|[^\\w])${id}($|[^\\w])`).test(body)) return { req, carrier: id };
  }
  return null;
}
