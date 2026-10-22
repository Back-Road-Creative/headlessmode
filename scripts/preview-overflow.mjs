// Document-level horizontal overflow probe for preview-shots.sh.
//
// Chromium's CLI pins a screenshot to --window-size and exposes no layout
// metrics, so a 3000px-wide element at 390px still yields a clean 390px PNG.
// The only way to know whether the PAGE scrolls sideways (as opposed to a
// table scrolling inside its own box, which is fine) is to ask the layout
// engine. This talks to a chromium started with --remote-debugging-port over
// the DevTools protocol using Node 22's built-in fetch + WebSocket — no
// dependency, no Playwright.
//
// Usage: node scripts/preview-overflow.mjs <devtools-port> <url> <width>
// Prints the document's scrollWidth as an integer. Exit 0 on a measurement,
// 1 on any failure (no page target, navigation error, evaluate error).
const [port, url, widthArg] = process.argv.slice(2);
const width = Number(widthArg);
if (!port || !url || !Number.isInteger(width)) {
  console.error("usage: preview-overflow.mjs <devtools-port> <url> <width>");
  process.exit(1);
}

const fail = (msg) => { console.error(`preview-overflow: ${msg}`); process.exit(1); };
setTimeout(() => fail("timed out"), 20000).unref();

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) fail("no page target on the debugging port");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let next = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("error", () => fail("websocket error"));
ws.addEventListener("open", async () => {
  try {
    // Desktop emulation on purpose: mobile emulation lays a page without a
    // viewport meta out at 980px, which is a fact about the emulator, not the
    // page. The question here is "does this page fit <width> CSS pixels".
    await send("Emulation.setDeviceMetricsOverride", {
      width, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await send("Page.enable");
    const loaded = new Promise((resolve) => {
      const onMessage = (event) => {
        if (JSON.parse(event.data).method === "Page.loadEventFired") {
          ws.removeEventListener("message", onMessage);
          resolve();
        }
      };
      ws.addEventListener("message", onMessage);
    });
    await send("Page.navigate", { url });
    await loaded;
    // One frame for layout to settle after load.
    await new Promise((r) => setTimeout(r, 250));
    const { result } = await send("Runtime.evaluate", {
      expression: "document.documentElement.scrollWidth",
      returnByValue: true,
    });
    console.log(String(result.value));
    ws.close();
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
});
