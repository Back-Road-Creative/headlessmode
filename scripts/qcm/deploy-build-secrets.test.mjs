// The camera snapshot build reads its provider keys from the environment and is
// fail-soft without them: a deploy that forgets to pass a key still goes green and
// silently ships the committed seeds. So the wiring itself is pinned here: both
// deploy workflows hand every build-time key to the "Build site for ..." step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Windy is not here: its API terms forbid republishing its webcam data (2026-10-04).
const BUILD_KEYS = ['NPS_API_KEY', 'WSDOT_ACCESS_CODE'];
const WORKFLOWS = ['deploy-production.yml', 'deploy-staging.yml'];

/** The env block of the step whose name starts "Build site for". */
function buildStepEnv(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s*- name: Build site for /.test(l));
  assert.ok(start >= 0, 'a "Build site for" step exists');
  const env = {};
  for (let i = start + 1; i < lines.length && !/^\s*- name: /.test(lines[i]); i++) {
    const m = lines[i].match(/^\s+([A-Z][A-Z0-9_]*):\s*(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

for (const wf of WORKFLOWS) {
  test(`${wf}: the site build step receives every camera key from its own secret`, () => {
    const env = buildStepEnv(readFileSync(new URL(`../../.github/workflows/${wf}`, import.meta.url), 'utf8'));
    for (const key of BUILD_KEYS) assert.equal(env[key], `\${{ secrets.${key} }}`, `${key} in ${wf}`);
    assert.equal(env.WINDY_WEBCAMS_API_KEY, undefined, `WINDY_WEBCAMS_API_KEY in ${wf}`);
  });
}
