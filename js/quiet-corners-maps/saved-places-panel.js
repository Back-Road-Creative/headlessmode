// DOM wiring for the "Saved places" section (QUX-09a §2.3): renders a store's
// `read()` result and wires Save/list -- a row's Show, Share, (Before you go), Remove -- plus
// the footer's Download/Import/Clear/Undo (QUX-09a-ii) and the cross-tab
// `storage` listener. Reaches no network (saved-places.test.mjs scans for it).
import { iconFor } from './name-labels.js';
import { SAVED_PLACES_KEY, buildGpx } from './saved-places.js';

// Reader-facing text per load state (plan §2.2); never says "clear", "safe",
// "quiet" or "no hazard" -- scripts/qcm/saved-places.test.mjs scans for that.
export const STATUS_TEXT = Object.freeze({
  unavailable: "Saving places is off: this browser is blocking site storage, so nothing saved here would survive a reload.",
  empty: "No saved places yet. Use Save on a place's card.",
  ok(count, keptCount) {
    let text = `${count} saved place${count === 1 ? '' : 's'}, stored only in this browser.`;
    if (keptCount) {
      text += ` ${keptCount} saved ${keptCount === 1 ? 'entry' : 'entries'} could not be read and are kept unchanged.`;
    }
    return text;
  },
  newer: "Your saved places were written by a newer version of this page. They are kept unchanged. Download them to keep a copy.",
  unreadable(reason) {
    return `Your saved places could not be read (${reason}). Nothing has been deleted. Download the stored text to keep it, or start over using the button below.`;
  },
});

/** The status line for one store.read() result. */
export function statusTextFor(result) {
  switch (result.state) {
    case 'unavailable': return STATUS_TEXT.unavailable;
    case 'empty': return STATUS_TEXT.empty;
    case 'ok':
    case 'migrated': return STATUS_TEXT.ok(result.places.length, result.kept.length);
    case 'newer': return STATUS_TEXT.newer;
    case 'unreadable': return STATUS_TEXT.unreadable(result.reason);
    default: return '';
  }
}

/** Why a camera the operator publishes no coordinates for cannot be shown or checked (QUX-09c). */
export const CAMERA_NO_LOCATION = 'The operator publishes no location for this camera.';

/** The row's kind word. iconFor would call a camera "Other named feature" -- and the printed
 *  key (print-names.js) must not gain a camera row, so the panel words it itself. */
export function kindLabelFor(place) {
  return place.kind === 'camera' ? 'Camera' : iconFor(place.kind).label;
}

/** A saved camera with no position: Show and Before you go have nothing to point at. */
export function isUnlocatedCamera(place) {
  return place.kind === 'camera' && (place.lat === null || place.lon === null);
}

function buildRow(place, { onShow, onShare, onConditions, onRemove, setStatus }) {
  const li = document.createElement('li');
  li.className = 'qc-saved-row';
  const name = document.createElement('span');
  name.className = 'qc-saved-row-name';
  name.textContent = `${place.name} — ${kindLabelFor(place)}`;
  li.append(name);

  const actions = document.createElement('div');
  actions.className = 'qc-saved-row-actions';

  const showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.className = 'qc-saved-row-action';
  showBtn.textContent = 'Show';
  // aria-disabled, not `disabled`: a disabled button swallows the press, and the reader who
  // pressed it should be told why (the row's status line) rather than nothing happening.
  const noPlace = isUnlocatedCamera(place);
  const needsPlace = (btn, run) => {
    if (!noPlace) { btn.addEventListener('click', run); return; }
    btn.setAttribute('aria-disabled', 'true');
    btn.title = CAMERA_NO_LOCATION;
    btn.addEventListener('click', () => setStatus(CAMERA_NO_LOCATION));
  };
  needsPlace(showBtn, () => onShow && onShow(place));
  actions.append(showBtn);

  // A camera row has no Share: the share fragment is centre-only, and a camera's card cannot be
  // reopened from a URL (QUX-09c D2).
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'qc-saved-row-action';
  shareBtn.textContent = 'Share';
  shareBtn.addEventListener('click', () => {
    Promise.resolve()
      .then(() => onShare && onShare(place))
      .then((text) => setStatus(text))
      .catch((err) => setStatus(err?.message || String(err)));
  });
  if (place.kind !== 'camera') actions.append(shareBtn);

  // QUX-09b: after Share, so 09a's Show/Share positions (and their tests) hold.
  if (onConditions) {
    const condBtn = document.createElement('button');
    condBtn.type = 'button';
    condBtn.className = 'qc-saved-row-action';
    condBtn.textContent = 'Before you go';
    needsPlace(condBtn, () => onConditions(place));
    actions.append(condBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'qc-saved-row-action';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => onRemove(place));
  actions.append(removeBtn);

  li.append(actions);
  return li;
}

/** Wires `#qc-saved` to `store`. Called once from main.js's start(). `onShare`
 *  returns a promise of status text, the card's own Share contract.
 *  `onConditions` wires "Before you go" (QUX-09b); 09a leaves it absent.
 *  `onChange` is called after every render, so another list of the same places (QQA-16b's Saved
 *  cameras) can follow a removal, an import or a clear made here. */
export function mountSavedPlaces({ root = document, store, onShow = null, onShare = null, onConditions = null, onChange = null } = {}) {
  const find = (id) => root.querySelector(`#${id}`);
  const statusEl = find('qc-saved-status');
  const listEl = find('qc-saved-list');
  if (!statusEl || !listEl || !store) return null;

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function render(statusOverride) {
    const result = store.read();
    setStatus(statusOverride !== undefined ? statusOverride : statusTextFor(result));
    const places = result.places || [];
    const readOnly = result.state === 'unreadable' || result.state === 'newer' || result.state === 'unavailable';
    listEl.hidden = readOnly || places.length === 0;
    listEl.replaceChildren(...places.map((place) => buildRow(place, {
      onShow,
      onShare,
      onConditions,
      onRemove: (p) => { store.remove(p.ref); render(); },
      setStatus,
    })));
    if (onChange) onChange();
  }

  // Download: the main.js:2292 Blob-then-<a download> pattern (plan §2.3),
  // filename dated with the codebase's one YYYY-MM-DD convention.
  function saveBlob(text, type, ext) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `quiet-corners-saved-places-${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }
  find('qc-saved-download')?.addEventListener('click', () => {
    saveBlob(store.exportText(), 'application/json', 'json');
  });

  // GPX (E7): waypoints only, from the readable places; routes are out of scope.
  find('qc-saved-download-gpx')?.addEventListener('click', () => {
    const { gpx, skipped, count } = buildGpx(store.read().places || []);
    if (!count) { setStatus('No saved places with a position to put in a GPX file.'); return; }
    saveBlob(gpx, 'application/gpx+xml', 'gpx');
    setStatus(`Saved a GPX file with ${count} place${count === 1 ? '' : 's'}${skipped ? ` (${skipped} without a position left out)` : ''}.`);
  });

  // Import: a hidden file input behind a visible <label> (plan §2.3); merges
  // by ref, never replaces or deletes (saved-places.js's importText).
  const importInput = find('qc-saved-import');
  importInput?.addEventListener('change', () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    file.text().then((text) => {
      const result = store.importText(text);
      if (result.overLimit) { setStatus('That file is too large to import.'); return; }
      if (result.reason) { setStatus(`That file could not be imported (its saved places ${result.reason === 'newer' ? 'were written by a newer version of this page' : result.reason}).`); return; }
      // render() itself would overwrite this with the plain count text (it
      // calls setStatus(statusTextFor(...)) first) -- pass the import message
      // as render's override so the reader still sees what just happened.
      render(`Imported ${result.added} place${result.added === 1 ? '' : 's'}.`);
    });
  });

  // Clear/Undo: two-step confirm on one button (plan §2.3), then a
  // session-only Undo -- restore(raw) refuses once anything else has
  // written the key, so this never clobbers an intervening save or import.
  const clearBtn = find('qc-saved-clear');
  const undoBtn = find('qc-saved-undo');
  let confirmingClear = false;
  let lastCleared = null;
  clearBtn?.addEventListener('click', () => {
    if (!confirmingClear) {
      const count = (store.read().places || []).length;
      clearBtn.textContent = `Confirm: clear ${count} saved place${count === 1 ? '' : 's'}`;
      confirmingClear = true;
      return;
    }
    lastCleared = store.clear();
    confirmingClear = false;
    clearBtn.textContent = 'Clear saved places';
    if (undoBtn) undoBtn.hidden = lastCleared == null;
    render();
  });
  undoBtn?.addEventListener('click', () => {
    if (store.restore(lastCleared)) {
      lastCleared = null;
      undoBtn.hidden = true;
      render();
    }
  });

  (root.defaultView || (typeof window !== 'undefined' ? window : null))?.addEventListener('storage', (e) => {
    if (e.key === null || e.key === SAVED_PLACES_KEY) render();
  });

  render();
  return { render };
}
