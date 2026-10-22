// Proof that a scheme-less CSP host-source really does permit the https fetch.
//
// The whole Field Maps policy is written as `arcgis.dnr.alaska.gov` rather than
// `https://arcgis.dnr.alaska.gov`, which returns 456 characters and is the only
// reason the nine parcel origins fit under Cloudflare's 2,000-per-line cap.
//
// That rests on one claim: a host-source with no scheme-part is matched against the
// DOCUMENT's scheme, so on an https page it permits https and nothing else. If the
// claim were wrong, every layer would fail to load in production with a green suite
// and nothing in the diff to explain it -- the exact silent failure the generated
// _headers comments warn about. Reading it out of the spec is not evidence, so this
// runs a real Chromium against a real https origin and watches the fetch.
//
// Self-signed on 127.0.0.1 with --ignore-certificate-errors: the point is the CSP
// check, and a trusted cert would need a CA this box does not have. Skips (rather
// than fails) with no Chromium or no openssl, the way the other browser proofs do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChromium, launch } from './helpers/browser.mjs';
import { hostSource } from './helpers/headers.mjs';

const CHROMIUM = findChromium();
let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }
const skip = !CHROMIUM ? 'no Chromium on this box (set CHROME_PATH to run this proof)'
  : !openssl ? 'no openssl to mint the test certificate' : false;

function selfSigned(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) };
}

// Port 0: the kernel hands each server its own port at bind time. A port picked
// first and bound later can be taken in between by another test file on a busy
// runner (EADDRINUSE, CI 2026-09-28), and a listen error with no handler hangs the
// file until its 600 s timeout instead of failing.
const serve = (tls, handler) => new Promise((resolve, reject) => {
  const s = https.createServer(tls, handler);
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const portOf = (s) => s.address().port;

test('a scheme-less host-source reaches https, and only the hosts it names', { skip }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qcm-csp-'));
  const tls = selfSigned(dir);

  const body = (text) => (req, res) => { res.setHeader('access-control-allow-origin', '*'); res.end(text); };
  const listed = await serve(tls, body('LISTED'));
  const unlisted = await serve(tls, body('UNLISTED'));
  const [listedPort, unlistedPort] = [portOf(listed), portOf(unlisted)];
  // Written exactly as gen-headers.mjs writes it, host-source and all.
  const csp = `default-src 'self'; connect-src 'self' ${hostSource(`https://127.0.0.1:${listedPort}`)}`;
  const page = await serve(tls, (req, res) => {
    res.setHeader('content-security-policy', csp);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>csp proof</title>');
  });
  const pagePort = portOf(page);
  const servers = [listed, unlisted, page];

  const browser = await launch(CHROMIUM, `https://127.0.0.1:${pagePort}/`,
    { timeoutMs: 30000, args: ['--ignore-certificate-errors'] });
  t.after(() => { browser.close(); for (const s of servers) s.close(); rmSync(dir, { recursive: true, force: true }); });

  const probe = (url) => browser.evaluate(
    `(async () => { try { const r = await fetch(${JSON.stringify(url)}); return 'ALLOWED:' + (await r.text()); }
       catch { return 'BLOCKED'; } })()`);

  assert.equal(await browser.evaluate('location.protocol'), 'https:', 'the proof needs an https document');
  assert.equal(await probe(`https://127.0.0.1:${listedPort}/`), 'ALLOWED:LISTED',
    `a host-source with no scheme did NOT permit https — the whole policy is wrong: ${csp}`);
  // The control: without it, a browser ignoring the policy entirely would pass the line above.
  assert.equal(await probe(`https://127.0.0.1:${unlistedPort}/`), 'BLOCKED',
    'an unlisted origin was reachable — the policy is not being enforced at all');
});
