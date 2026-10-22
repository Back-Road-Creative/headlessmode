#!/usr/bin/env node
// Read-only smoke check of a deployed Quiet Corners site. Usage: --help, or scripts/qcm/README.md.
// Not a *.test.mjs: it hits the network, and CI's node --test glob must never run it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, exitCode, summaryLine, runChecks, openSmokeBrowser, USAGE } from './live-smoke-checks.mjs';

let args;
try { args = parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(`${err.message}\n\n${USAGE}\n`); process.exit(2); }
if (args.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

const needsBrowser = args.only.some((n) => n !== 'marker');
const ctx = { baseUrl: args.baseUrl, expectSha: args.expectSha, timeoutMs: args.timeoutMs, page: null, browserError: null, deadlineAt: Date.now() + args.totalTimeoutMs };
let browser = null;
if (needsBrowser) {
  try {
    // QCM_SMOKE_NO_BROWSER is the test hook for "this box has no Chromium".
    if (process.env.QCM_SMOKE_NO_BROWSER) throw new Error('no browser: QCM_SMOKE_NO_BROWSER is set');
    browser = await openSmokeBrowser({ live: true, timeoutMs: args.timeoutMs });
    ctx.page = browser.page;
  } catch (err) { ctx.browserError = String(err.message).startsWith('no browser') ? err.message : `no browser: ${err.message}`; }
}

if (args.outDir) mkdirSync(args.outDir, { recursive: true });
const onFail = args.outDir ? async (name, c) => {
  // A wedged page must not hold the run past its deadline: the screenshot gets 5 s.
  const shot = await Promise.race([c.page.send('Page.captureScreenshot', { format: 'png' }),
    new Promise((_, no) => setTimeout(() => no(new Error('screenshot timed out')), 5000).unref())]);
  writeFileSync(path.join(args.outDir, `${name}-failure.png`), Buffer.from(shot.data, 'base64'));
} : null;

let results;
try { results = await runChecks(ctx, args.only, { onFail }); } finally { browser?.close(); }

for (const r of results) process.stdout.write(`${summaryLine(r)}\n`);
const n = (st) => results.filter((r) => r.status === st).length;
const [failed, passed, skipped] = [n('fail'), n('pass'), n('skipped')];
const partsSkipped = results.reduce((n, r) => n + (r.skips?.length ?? 0), 0);
process.stdout.write(`live-smoke ${args.baseUrl}: ${passed} passed, ${failed} failed, ${skipped} skipped${partsSkipped ? ` (${partsSkipped} part${partsSkipped === 1 ? '' : 's'} of passing checks skipped: feature not deployed)` : ''}\n`);
if (args.outDir) {
  writeFileSync(path.join(args.outDir, 'live-smoke-report.json'),
    `${JSON.stringify({ baseUrl: args.baseUrl, expectSha: args.expectSha, finishedAt: new Date().toISOString(), results }, null, 2)}\n`);
}
process.exit(exitCode(results, { tolerateServiceErrors: args.tolerateServiceErrors }));
