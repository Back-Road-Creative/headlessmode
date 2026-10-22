// A node:test reporter that writes one JSON line per finished test, for run-with-evidence.mjs.
// It runs beside the normal reporter (node --test takes several), so the log a person reads
// is unchanged and this file is only the machine-readable copy.
//
// A line is {file, name, nesting, status, skip, todo, suite}. `skip` is false, or the reason
// ('' when the test was skipped with no reason). Suites (describe) are marked, not dropped,
// so the consumer decides what counts. Events without a file (the run's own summary) are
// not tests and are not written.

export default async function* evidenceReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    if (!d.file) continue;
    yield `${JSON.stringify({
      file: d.file,
      name: d.name,
      nesting: d.nesting,
      status: event.type === 'test:pass' ? 'pass' : 'fail',
      skip: d.skip === undefined || d.skip === false ? false : (typeof d.skip === 'string' ? d.skip : ''),
      todo: d.todo === undefined || d.todo === false ? false : (typeof d.todo === 'string' ? d.todo : ''),
      suite: d.details?.type === 'suite',
    })}\n`;
  }
}
