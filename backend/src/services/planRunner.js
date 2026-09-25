'use strict';

// Runs a build as an explicit, tracked plan: a fixed list of steps, each a
// real action with its dependencies. Steps whose dependencies are met run in
// parallel; a failed step is retried on its own (never the whole plan); an
// optional step that still fails is skipped instead of failing the build.
// Every change is reported to the client as a `plan` event, so the progress
// card always shows the whole plan with what's done, running and left:
//
//   { type: 'plan', op: 'start', steps: [{ id, label }] }
//   { type: 'plan', op: 'step', id, label, status, detail?, progress: { done, total } }
//       status: 'active' | 'done' | 'retry' | 'failed' | 'skipped'
//   { type: 'plan', op: 'done' } / { type: 'plan', op: 'error' }
//
// A step is { id, label, deps?: [ids], retries?: number, optional?: bool,
// skip?: (ctx) => string|false, run: async (ctx, step) => void }. `skip`
// returns a reason to skip the step up front (e.g. a simple request that
// needs no planning); `ctx` is shared state the steps read and write.

function createPlan({ emit, steps, signal }) {
  const byId = new Map(steps.map((s) => [s.id, { ...s, deps: s.deps || [], status: 'pending', detail: '' }]));
  const total = byId.size;
  // Stop (the caller's signal) is honoured at every boundary: no new round,
  // step, retry or fallback starts once it has fired.
  const checkStopped = () => {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Stopped'), { name: 'AbortError' });
  };
  const finished = (s) => s.status === 'done' || s.status === 'skipped';
  const progress = () => ({ done: [...byId.values()].filter(finished).length, total });

  function report(s, status, detail = '') {
    s.status = status;
    s.detail = detail;
    emit({ type: 'plan', op: 'step', id: s.id, label: s.label, status, detail, progress: progress() });
  }

  // Lets a running step say what it's doing right now ("Continuing (the
  // project is large)") without changing its status.
  function note(id, detail) {
    const s = byId.get(id);
    if (s && s.status === 'active') report(s, 'active', detail);
  }

  async function runStep(s, ctx) {
    checkStopped();
    const reason = s.skip?.(ctx);
    if (reason) {
      report(s, 'skipped', reason);
      return;
    }
    const attempts = 1 + (s.retries || 0);
    for (let attempt = 1; ; attempt += 1) {
      checkStopped(); // no retry after Stop
      report(s, attempt === 1 ? 'active' : 'retry', attempt === 1 ? '' : `Retrying (attempt ${attempt} of ${attempts})`);
      try {
        await s.run(ctx, s);
        report(s, 'done', s.doneDetail || '');
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[plan] step "${s.id}" failed (attempt ${attempt}/${attempts}): ${err.message}`);
        if (attempt < attempts) continue;
        if (s.optional) {
          report(s, 'skipped', 'Could not complete; continuing without it');
          return;
        }
        report(s, 'failed', err.message);
        throw err;
      }
    }
  }

  async function run(ctx) {
    emit({ type: 'plan', op: 'start', steps: [...byId.values()].map(({ id, label }) => ({ id, label })) });
    try {
      // Each round starts every step whose dependencies are all finished --
      // independent steps run side by side -- until nothing is left.
      for (;;) {
        checkStopped();
        const pending = [...byId.values()].filter((s) => s.status === 'pending');
        if (!pending.length) break;
        const ready = pending.filter((s) => s.deps.every((d) => finished(byId.get(d))));
        if (!ready.length) throw new Error(`Plan is stuck: ${pending.map((s) => s.id).join(', ')} wait on steps that never finished`);
        // allSettled: a failure still lets its parallel siblings finish (and
        // report) before the plan stops, so no progress arrives after 'error'.
        const results = await Promise.allSettled(ready.map((s) => runStep(s, ctx)));
        const failed = results.find((r) => r.status === 'rejected');
        if (failed) throw failed.reason;
      }
      emit({ type: 'plan', op: 'done' });
      return ctx;
    } catch (err) {
      emit({ type: 'plan', op: 'error' });
      throw err;
    }
  }

  return { run, note };
}

module.exports = { createPlan };
