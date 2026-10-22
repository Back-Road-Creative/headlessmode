// Wires view-state.js (B0, pure schema) to the map, the address bar and
// localStorage. Pure logic only -- no Leaflet, no `location`/`history` calls
// live here; the caller passes those in so this stays node --test coverable.
//
// "Apply through existing setters only": applyView() never touches Leaflet
// directly. It calls whichever of `setCenterZoom/setBase/setSurface/
// setOverlays/setCounty/setLabels/setEmphasis/setCamera` the caller provides,
// in a fixed order, and silently skips any field with no setter -- a field
// nothing can act on yet (labels, emphasis) is not an error here.

export const APPLY_ORDER = Object.freeze(['center', 'base', 'surface', 'overlays', 'county', 'labels', 'emphasis', 'camera']);

const SETTER_FOR = Object.freeze({
  center: (setters, view) => setters.setCenterZoom && setters.setCenterZoom(view.center, view.zoom),
  base: (setters, view) => setters.setBase && setters.setBase(view.base),
  surface: (setters, view) => setters.setSurface && setters.setSurface(view.surface),
  overlays: (setters, view) => setters.setOverlays && setters.setOverlays(view.overlays),
  county: (setters, view) => setters.setCounty && setters.setCounty(view.county),
  labels: (setters, view) => setters.setLabels && setters.setLabels(view.labels),
  emphasis: (setters, view) => setters.setEmphasis && setters.setEmphasis(view.emphasis),
  camera: (setters, view) => setters.setCamera && setters.setCamera(view.camera),
});

/** Trailing-edge throttle: at most one `fn` call per `waitMs`, always with the
 *  latest args from calls made during the wait. `cancel()` drops any pending
 *  call -- used when the page is about to apply a view programmatically and
 *  a queued routine write would otherwise fire mid-apply. */
export function createThrottle(fn, waitMs) {
  let timer = null;
  let pendingArgs = null;
  return {
    call(...args) {
      pendingArgs = args;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const args2 = pendingArgs;
        pendingArgs = null;
        fn(...args2);
      }, waitMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingArgs = null;
    },
  };
}

/** Marks a span of code as "applying a view programmatically" so routine
 *  writers and popstate handlers can tell a reader-driven move (write history)
 *  from a side effect of their own apply (never write history, never re-apply). */
export function createApplyGuard() {
  let depth = 0;
  return {
    get applying() { return depth > 0; },
    run(fn) {
      depth += 1;
      try { return fn(); } finally { depth -= 1; }
    },
  };
}

/** Applies a resolved view through EXISTING setters only, in APPLY_ORDER,
 *  optionally inside an apply guard so any setter side effect (e.g. a
 *  Leaflet 'moveend' firing synchronously) cannot re-enter the routine writer. */
export function applyView(view, setters = {}, guard = null) {
  const body = () => { for (const field of APPLY_ORDER) SETTER_FOR[field](setters, view); };
  if (guard) guard.run(body); else body();
}

/** The one throttled writer for routine map movement: `write(fragment)` is
 *  called (e.g. `history.replaceState`) at most once per `waitMs`, and only
 *  when (a) an active map fragment already exists -- routine movement never
 *  CREATES one -- and (b) the page is not mid-apply of a view (guard.applying). */
export function createRoutineWriter({ write, hasActiveFragment = () => true, guard = null, waitMs = 400 }) {
  // Whether a request came from a programmatic apply has to be captured at
  // NOTIFY time, not when the throttle later fires: by the time the timer
  // runs, a synchronous applyView() has long since finished and guard.applying
  // is back to false, which would otherwise let a re-entrant write through.
  const throttle = createThrottle((fragment, wasApplying) => {
    if (wasApplying) return;
    if (!hasActiveFragment()) return;
    write(fragment);
  }, waitMs);
  return {
    notify(fragment) { throttle.call(fragment, Boolean(guard && guard.applying)); },
    cancel: throttle.cancel,
  };
}

/** Builds a `popstate` handler: resolves the view for the fragment now in the
 *  address bar and re-applies it, guarded so the apply cannot write new
 *  history or re-enter itself. `resolveView()` returning a falsy value (a
 *  non-map hash, e.g. `#documentation`) is a no-op. */
export function createPopstateHandler({ resolveView, applySetters, guard }) {
  return () => {
    const view = resolveView();
    if (!view) return;
    applyView(view, applySetters, guard);
  };
}

/** Clears display overrides back to the default view and clears the saved
 *  display-prefs key. Takes no recipe/project/pin argument at all -- Reset
 *  view has nothing to say about print recipes, saved print projects or a
 *  user pin, so there is nothing here that could touch them. */
export function resetView({ defaultView, prefsStore = null }) {
  if (prefsStore) prefsStore.clear();
  return { view: { ...defaultView }, removeFragment: true };
}

export const PREFS_KEY = 'qc-field-maps-display-prefs';

export function probedStorage(storage) {
  if (!storage) return null;
  try {
    const probe = '__qc_view_wiring_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** localStorage-backed store for display prefs ONLY (base/labels/emphasis --
 *  see view-state.js's prefsFromView). Its own key, never 'last' -- that key
 *  belongs to project-store.js's print recipe, a different feature this must
 *  never collide with. Every method degrades silently: missing or blocked
 *  storage means no persistence, never a throw. */
export function createPrefsStore(key = PREFS_KEY, storage = probedStorage(typeof localStorage === 'undefined' ? null : localStorage)) {
  return {
    load() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save(prefs) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(prefs));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      if (!storage) return;
      try { storage.removeItem(key); } catch { /* degrade silently */ }
    },
  };
}
