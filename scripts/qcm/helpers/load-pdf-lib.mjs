// Loads the vendored pdf-lib UMD bundle under Node as CommonJS (the repo is
// "type": "module", so a bare require would misread the wrapper). Same
// technique as vendor.test.mjs; returns the `PDFLib` namespace the browser
// sees on `window.PDFLib`.
import Module, { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_PATH = path.join(here, '..', '..', '..', 'themes', 'headlessmode', 'static', 'vendor', 'pdf-lib.min.js');

export function loadPdfLib() {
  const compiled = vm.runInThisContext(Module.wrap(readFileSync(VENDOR_PATH, 'utf8')), { filename: VENDOR_PATH });
  const mod = { exports: {} };
  compiled.call(mod.exports, mod.exports, createRequire(VENDOR_PATH), mod, VENDOR_PATH, path.dirname(VENDOR_PATH));
  return mod.exports;
}
