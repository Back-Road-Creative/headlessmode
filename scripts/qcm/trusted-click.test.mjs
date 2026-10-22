// The shared trusted click (helpers/trusted-click.mjs) presses only a target that is on
// screen, uncovered and holding still -- never whatever happens to sit where it was.
//
// Five browser test files each carried their own copy of a click that read the target's
// rect once and pressed there at once. PR CI run 36607266826 (#646) went red in
// layers-compact-browser.test.mjs at 390px: the press on the Layers summary navigated the
// page away, and the next read found no #qcm-layer-panel at all ("Cannot read properties
// of null (reading 'open')"). On #646 run 36603618563 the same blind press aimed at one
// extend-ring cell and selected its neighbour. These pages are built on purpose to show
// both failures deterministically: a target under a link, and a target still moving.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChromium, launch } from './helpers/browser.mjs';
import { trustedClick } from './helpers/trusted-click.mjs';

const CHROMIUM = findChromium();
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)' : false;

let page = null;
async function freshPage(html) {
  if (!page) page = await launch(CHROMIUM, 'about:blank', { viewport: { width: 390, height: 844 } });
  await page.navigate(`data:text/html,${encodeURIComponent(html)}`);
  return page;
}
after(() => { if (page) page.close(); });

const RECORD = `<script>
  window.hits = [];
  document.addEventListener('mousedown', (e) => hits.push(e.target.id || e.target.tagName), true);
</script>`;

test('a covered target is refused, and the cover never gets the press', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">go</button>
    <a id="cover" href="#elsewhere" style="position:absolute;left:80px;top:90px;width:160px;height:60px;background:#fff">cover</a>`);
  await assert.rejects(() => trustedClick(p, '#target'), /#target.*covered/,
    'the click pressed through to whatever covered the target instead of refusing');
  assert.deepEqual(await p.evaluate('hits'), [], 'the cover received a press meant for the target');
});

test('a moving target is pressed once it holds still, not where it was first read', { skip }, async () => {
  // 5 px per ms for 1.5 s, then still: a rect read mid-move is somewhere it has already
  // left by the time the mouse events arrive.
  const p = await freshPage(`${RECORD}
    <button id="target" style="position:absolute;left:0;top:300px;width:12px;height:40px">m</button>
    <script>
      const t0 = performance.now(), el = document.getElementById('target');
      (function step() {
        const t = performance.now() - t0;
        el.style.left = Math.round((t * 5) % 360) + 'px';
        if (t < 1500) requestAnimationFrame(step);
      })();
    </script>`);
  await trustedClick(p, '#target');
  assert.deepEqual(await p.evaluate('hits'), ['target'], 'the press missed a target that was still moving when first measured');
});

// PR CI run 37022468584 (#670) went red in the test above: the press landed on the page
// body, and the whole test took 1443 ms, inside the target's 1.5 s of motion. A press goes in
// only once two reads agree on the centre, so two reads had agreed on a target that was
// still moving. Two reads cannot tell a target that held still from one that was somewhere
// else between them, so the helper also watches every animation frame between them.
//
// Watching the frames showed a read can be wrong another way: a page can undo a scroll
// before it paints. Leaflet sets its map container's scroll back to 0 on every scroll event
// (vendor/leaflet.js, _onScroll). While every read scrolled the target into view, the reads
// found .qcm-name-marker centred at y 450 and a frame between them found it at y 569, and
// the helper refused it as still moving. This page undoes its scroll the same way but
// deterministically: its scrollIntoView moves the target left, and a microtask moves it
// back before anything paints. It is only ever painted at home, and is pressed there.
test('a target whose scroll into view the page undoes before it paints is pressed where it is painted', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <button id="target" style="position:absolute;left:250px;top:300px;width:120px;height:40px">go</button>
    <script>
      const el = document.getElementById('target');
      el.scrollIntoView = () => {
        el.style.left = '100px';
        queueMicrotask(() => { el.style.left = '250px'; });
      };
    </script>`);
  await trustedClick(p, '#target', { tries: 3 });
  assert.deepEqual(await p.evaluate('hits'), ['target'], 'the press was aimed where the target was only while it was being read');
});

// The same, the way Leaflet does it: a clipping container that sets its own scroll back to 0
// whenever it scrolls. Centring the target scrolls the container 110 px, and the page undoes
// that before the next frame.
test('a target in a container that undoes its own scroll is pressed where it is painted', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <div id="map" style="position:absolute;left:0;top:0;width:390px;height:300px;overflow:hidden">
      <div style="height:2000px"></div>
      <button id="target" style="position:absolute;left:135px;top:240px;width:120px;height:40px">go</button>
    </div>
    <script>
      const map = document.getElementById('map');
      map.addEventListener('scroll', () => { map.scrollTop = 0; map.scrollLeft = 0; });
    </script>`);
  await trustedClick(p, '#target');
  assert.deepEqual(await p.evaluate('hits'), ['target'], 'the press was aimed where the target was only while it was being read');
});

// Watching the frames is what tells a held-still target from a moving one, so a page that
// paints none is refused in its own words, not pressed and not reported as moving. Each read
// on such a page waits out a timer, so three of them in a row end it rather than every try.
test('a page that paints no frames is refused as not painting after three reads, never pressed', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">go</button>
    <script>window.requestAnimationFrame = () => 0;</script>`);
  await assert.rejects(() => trustedClick(p, '#target'),
    /#target: not painting \(0 animation frames between its reads\) after 3 reads 200 ms apart/,
    'the click pressed on a page that painted no frames, or kept reading it');
  assert.deepEqual(await p.evaluate('hits'), [], 'a press went in on a page that painted no frames');
});

// A page that is only starved of frames is pressed once they come. On the shared runner
// a page can go seconds without a frame while the box is loaded: of the 20 most recent
// red PR CI runs on 2026-10-05, 17 ended in this helper's "not painting" refusal (runs
// 37381589696 and 37370229061 among them), each read seeing 0 frames and the whole
// click giving up inside 10 s. Here the frames are held back for 10 s and then all
// delivered, as a starved compositor delivers them, and the press must still go in.
//
// The page keeps the clock, not the test. PR CI run 37679044362 (#732) went red here with
// the press correctly in at 10.7 s of test time: the hold starts when the page's script
// runs, during navigate, and on the loaded runner that navigate ate enough of the 10 s
// that a stopwatch started after it read under 10 s. So the page records whether the
// frames had been released when the press came, and that is what is asserted.
test('a page whose frames are held back for ten seconds is pressed once they arrive', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <button id="target" style="position:absolute;left:100px;top:100px;width:120px;height:40px">go</button>
    <script>
      const raf = window.requestAnimationFrame.bind(window), held = [];
      window.released = false;
      window.requestAnimationFrame = (cb) => { held.push(cb); return 0; };
      setTimeout(() => { window.released = true; window.requestAnimationFrame = raf; held.splice(0).forEach((cb) => raf(cb)); }, 10000);
      document.addEventListener('mousedown', () => { window.pressedAfterRelease = window.released; }, true);
    </script>`);
  await trustedClick(p, '#target');
  assert.deepEqual(await p.evaluate('hits'), ['target'], 'the press never went in, or went somewhere else');
  assert.equal(await p.evaluate('pressedAfterRelease'), true, 'the press went in while the page had painted no frame');
});

test('a missing target fails with its selector named', { skip }, async () => {
  const p = await freshPage(`${RECORD}<p>nothing here</p>`);
  await assert.rejects(() => trustedClick(p, '#absent', { tries: 2 }), /#absent/);
});

test('a target with no box (display:none) is refused rather than pressed at 0,0', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <a id="corner" href="#home" style="position:absolute;left:0;top:0;width:60px;height:30px">home</a>
    <button id="target" style="display:none">hidden</button>`);
  await assert.rejects(() => trustedClick(p, '#target', { tries: 2 }), /#target/);
  assert.deepEqual(await p.evaluate('hits'), [], 'a press went to the top-left corner for a target with no box');
});

// PR CI run 36644039461 (#652), print-options.test.mjs:170 at 1440x900: "cannot trusted-click
// details.qcm-print-options > summary: covered by null ... y=1407". Nothing covered it. The
// press before it had not opened #qcm-app, and content inside a closed <details> keeps a
// layout box but paints nothing, so scrollIntoView left it 500px below the viewport and
// elementFromPoint there is null. This page is that shape, deterministically.
test('a target inside a closed <details> is refused as not rendered, naming the <details>', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <details id="shut"><summary>more</summary>
      <div style="height:1200px"></div>
      <button id="target" style="width:120px;height:40px">go</button>
    </details>`);
  await assert.rejects(() => trustedClick(p, '#target', { tries: 2 }), /#target: not rendered \(inside a closed details#shut\)/);
  assert.deepEqual(await p.evaluate('hits'), [], 'a press went in for a target that is not rendered');
});

// `until` is for a click that only sets up the thing under test: press again when the
// first press changed nothing. The first click on this summary is swallowed, the way a
// press that misses under runner load changes nothing.
test('until presses again when the first press changed nothing', { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <details id="d"><summary id="target">open me</summary><p>inside</p></details>
    <script>
      let swallowed = false;
      document.getElementById('target').addEventListener('click', (e) => {
        if (!swallowed) { swallowed = true; e.preventDefault(); }
      });
    </script>`);
  await trustedClick(p, '#target', { until: "document.getElementById('d').open" });
  assert.equal(await p.evaluate("document.getElementById('d').open"), true, 'until returned while its condition was still false');
  assert.deepEqual(await p.evaluate('hits'), ['target', 'target'], 'expected one swallowed press and one that opened the <details>');
});

test('until presses once when the first press already made it true', { skip }, async () => {
  // A second press on a toggle undoes the first, so a condition that holds must stop the presses.
  const p = await freshPage(`${RECORD}
    <details id="d"><summary id="target">open me</summary><p>inside</p></details>`);
  await trustedClick(p, '#target', { until: "document.getElementById('d').open" });
  assert.deepEqual(await p.evaluate('hits'), ['target'], 'a toggle was pressed again after it had already opened');
  assert.equal(await p.evaluate("document.getElementById('d').open"), true);
});

// The default scrollIntoView 'center' also scrolls boxes no person can scroll: to script,
// an overflow:hidden box is still a scroll container. At 390x844 the dashboard's
// #qc-map-container is one, and centring a finder row in it slid the whole map 105 px up
// inside its box, a page no one ever sees (name-search.test.mjs, 2026-10-02). `align:
// 'nearest'` scrolls only as far as it takes to bring the target on screen, so a target
// already in view is pressed where it is.
test("align 'nearest' presses a target already in view without scrolling anything", { skip }, async () => {
  const p = await freshPage(`${RECORD}
    <div id="clip" style="position:absolute;left:0;top:300px;width:390px;height:400px;overflow:hidden">
      <div style="position:relative;height:800px">
        <button id="target" style="position:absolute;left:100px;top:300px;width:120px;height:40px">go</button>
      </div>
    </div>
    <div style="height:2400px"></div>`);
  const scrolled = `[document.getElementById('clip').scrollTop, window.scrollY]`;
  await trustedClick(p, '#target', { align: 'nearest' });
  assert.deepEqual(await p.evaluate('hits'), ['target']);
  assert.deepEqual(await p.evaluate(scrolled), [0, 0], "align 'nearest' scrolled a target that was already in view");
  // The control: the default does scroll this page, so the page tells the two apart.
  await trustedClick(p, '#target');
  const [box] = await p.evaluate(scrolled);
  assert.ok(box > 0, "the default no longer centres the target in its overflow:hidden box, so this proof no longer tells 'nearest' apart");
});

test('until that never comes true fails after three presses, naming the condition and where they landed', { skip }, async () => {
  const p = await freshPage(`${RECORD}<button id="target" style="width:120px;height:40px">go</button>`);
  await assert.rejects(() => trustedClick(p, '#target', { until: 'window.never === true' }),
    /#target: pressed 3 times and window\.never === true never came true \(clicks landed on: button#target, button#target, button#target\)/);
  assert.deepEqual(await p.evaluate('hits'), ['target', 'target', 'target']);
});
