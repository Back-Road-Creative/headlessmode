/** A second DevTools client on the page launch() opened (the atlas browser test's Fetch
 *  interception, the capture CLI's Network events): launch() has no persistent event subscription. */
export async function attach(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', () => no(new Error('devtools socket failed')), { once: true }); });
  let id = 0;
  const pending = new Map(), listeners = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  });
  ws.addEventListener('close', () => { for (const settle of pending.values()) settle({ error: { message: 'devtools socket closed' } }); pending.clear(); });
  const send = (method, params) => new Promise((ok, no) => {
    const mine = ++id;
    pending.set(mine, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const on = (method, fn) => { listeners.set(method, (listeners.get(method) ?? new Set()).add(fn)); };
  return { send, on, close: () => ws.close() };
}
