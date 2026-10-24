// The bounded runner: one task, one adapter, one driver. The adapter sees the task text and the
// screen, never the checks. Every action is validated against a small vocabulary before it
// reaches the driver, and the run ends at the first of: done, give up, a step budget, a time
// budget, a refused action, or an adapter error. It repairs nothing and accepts no baseline.

export const ACTION_KINDS = new Set(['click', 'type', 'key', 'scroll', 'wait', 'done', 'giveUp']);
const MAX_TEXT = 200;
const MAX_WAIT_MS = 5000;
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const words = (v, max = MAX_TEXT) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Returns a problem string, or null when the action is allowed. */
export function actionProblem(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'action is not an object';
  if (!ACTION_KINDS.has(a.kind)) return `unknown action kind: ${String(a.kind).slice(0, 40)}`;
  if (a.kind === 'click' && !words(a.target)) return 'click needs a target described in words';
  if (a.kind === 'type' && !words(a.text)) return `type needs text of 1 to ${MAX_TEXT} characters`;
  if (a.kind === 'key' && !words(a.key, 40)) return 'key needs a key name';
  if (a.kind === 'scroll' && !DIRECTIONS.has(a.direction)) return 'scroll needs a direction';
  if (a.kind === 'wait' && !(Number.isInteger(a.ms) && a.ms >= 0 && a.ms <= MAX_WAIT_MS)) return `wait needs whole milliseconds up to ${MAX_WAIT_MS}`;
  if (a.kind === 'giveUp' && a.reason !== undefined && !words(a.reason)) return 'giveUp reason must be short text';
  return null;
}

/**
 * @param {{id: string, task?: string, budget: {maxSteps: number, maxMs: number}}} task
 * @param {{adapter: {next(ctx: object): Promise<object>}, driver: {observe(): Promise<object>, act(a: object): Promise<void>}, now?: () => number}} io
 * @returns {Promise<{taskId: string, outcome: string, steps: object[], error?: string}>}
 */
export async function runTask(task, { adapter, driver, now = () => performance.now() }) {
  const steps = [];
  const end = (outcome, error) => ({ taskId: task.id, outcome, steps, ...(error ? { error } : {}) });
  const start = now();
  for (;;) {
    if (steps.length >= task.budget.maxSteps) return end('budget-steps');
    if (now() - start >= task.budget.maxMs) return end('budget-time');
    let action;
    try {
      const observation = await driver.observe();
      action = await adapter.next({ task: task.task, observation, history: steps.slice(-10), stepsLeft: task.budget.maxSteps - steps.length });
    } catch (e) {
      return end('adapter-error', String(e && e.message ? e.message : e));
    }
    const problem = actionProblem(action);
    if (problem) return end('invalid-action', problem);
    if (action.kind === 'done') return end('claimed-done');
    if (action.kind === 'giveUp') return end('gave-up');
    steps.push(action);
    try {
      await driver.act(action);
    } catch (e) {
      return end('driver-error', String(e && e.message ? e.message : e));
    }
  }
}
