// The model adapter: given what the page shows and what has been done, answer with one action.
// Two kinds exist. `recorded` replays saved answers, so the whole lane runs offline and
// deterministically. `live` would call a vision model; it is refused here until a provider has
// been chosen and authorised, so nothing in this folder can reach the network.

/** @param {{steps: object[], loop?: boolean}} recording  `loop` repeats the last step forever
 *  (a model stuck in a loop); the runner's budget is what ends it. */
export function recordedAdapter(recording) {
  const steps = recording.steps;
  let i = 0;
  return {
    kind: 'recorded',
    async next() {
      if (i >= steps.length) {
        if (recording.loop && steps.length) return steps[steps.length - 1];
        throw new Error('recording ran out of steps before the task ended');
      }
      return steps[i++];
    },
  };
}

export function createAdapter({ kind, recording } = {}) {
  if (kind === 'recorded') return recordedAdapter(recording);
  if (kind === 'live') throw new Error('no model provider is authorised for the usability lane yet; use the recorded adapter');
  throw new Error(`unknown adapter kind: ${kind}`);
}
