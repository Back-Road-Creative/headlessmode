// Two guards against a page that grows the longer it is used. Neither draws or fetches.
//
// createUrlSlot: a blob URL pins its bytes until someone revokes it, and a download link that is
// rewritten on every click makes a new one each time. A slot owns exactly one live URL: handing
// it the next blob revokes the previous URL first, and release() gives the last one back.
// A fetch that can outlive a release() takes a ticket() before it starts and passes it to set():
// a release in between makes the ticket stale, and set() then makes no URL and returns null.
//
// createLru: a Map that stops at `limit` entries, dropping the least recently READ-or-written
// one. has() does not count as use; get() and set() do. The same surface as the Map it replaces,
// so a call site keeps its has/get/set.

/** `urls` is the URL global; a test passes a stand-in to count creations and revocations. */
export function createUrlSlot(urls = URL) {
  let live = null, epoch = 0;
  return {
    ticket: () => epoch,
    set(blob, ticket = epoch) {
      if (ticket !== epoch) return null;
      if (live) urls.revokeObjectURL(live);
      live = urls.createObjectURL(blob);
      return live;
    },
    release() {
      epoch += 1;
      if (live) { urls.revokeObjectURL(live); live = null; }
    },
  };
}

export function createLru(limit) {
  const map = new Map();
  return {
    has: (key) => map.has(key),
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key); map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key); map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
      return this;
    },
    get size() { return map.size; },
  };
}
