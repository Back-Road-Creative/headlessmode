// Last-recipe store for /quiet-corners/maps/: exactly one serialized recipe string
// in IndexedDB so a reload restores the previous job. The only other thing kept is a
// one-word "cleared" note in `storage` (see CLEARED_KEY). No
// imports — the page injects sheet-plan's serializeRecipe/parseRecipe. Every method
// resolves even when storage is missing, blocked or never answers (each call has a
// `timeoutMs` deadline), so persistence never breaks the page.

export const DB_NAME = 'quiet-corners-field-maps';
export const STORE = 'recipes';
export const KEY = 'last';
export const VERSION = 1;
/** Written to `storage` (localStorage) the instant clear() is called, before its IndexedDB
 *  delete can have been issued. The delete waits on the database opening; a reader who
 *  presses Clear and reloads inside that wait would otherwise find the old recipe still
 *  stored and get the cleared area back. loadRecipe() honours the note and finishes the
 *  delete; saveRecipe() retires it, since a newer area supersedes the clear. */
export const CLEARED_KEY = 'quiet-corners-field-maps-cleared';

const wait = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
});

/** Builds the store; `serialize`/`parse` are required (TypeError when absent).
 *  `timeoutMs` bounds each IndexedDB call: CI saw Chromium's open never answer under
 *  load, which held start-up's restore (main.js) until every 60 s browser wait ran out.
 *  20 s sits well inside those waits and well past late-restore-browser.test.mjs's
 *  deliberate hold (HOLD_MS plus a few page round trips), which must still restore. */
export function createProjectStore({ indexedDB = globalThis.indexedDB, serialize, parse, storage = null, timeoutMs = 20000 } = {}) {
  if (typeof serialize !== 'function' || typeof parse !== 'function') throw new TypeError('serialize and parse functions are required');
  const available = Boolean(indexedDB);

  function run(mode, fn) {
    const open = indexedDB.open(DB_NAME, VERSION);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    // The work keeps going past the deadline, so a late open still closes its database.
    const work = wait(open).then(async (db) => {
      try { return await fn(db.transaction(STORE, mode).objectStore(STORE)); } finally { if (db.close) db.close(); }
    });
    work.catch(() => {});
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`IndexedDB did not answer within ${timeoutMs} ms`)), timeoutMs); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }
  // Storage can be missing, full or blocked; the note is a safeguard, never a dependency.
  const note = (on) => { try { if (storage) { if (on) storage.setItem(CLEARED_KEY, '1'); else storage.removeItem(CLEARED_KEY); } } catch { /* blocked */ } };
  const noted = () => { try { return Boolean(storage) && storage.getItem(CLEARED_KEY) === '1'; } catch { return false; } };
  const remove = async () => { if (available) await run('readwrite', (s) => wait(s.delete(KEY))); };

  return {
    available,
    timeoutMs,
    async saveRecipe(input) {
      const text = serialize(input);
      note(false);
      try { if (available) { await run('readwrite', (s) => wait(s.put(text, KEY))); return true; } } catch { /* blocked */ }
      return false;
    },
    async loadRecipe() {
      if (noted()) { try { await remove(); note(false); } catch { /* the note stays until a delete lands */ } return null; }
      let text = null;
      try { if (available) text = await run('readonly', (s) => wait(s.get(KEY))); } catch { return null; }
      if (typeof text !== 'string') return null;
      try { return parse(text); } catch { await remove().catch(() => {}); return null; }
    },
    async clear() { note(true); await remove().catch(() => {}); },
  };
}
