import assert from "node:assert/strict";
import test from "node:test";

/**
 * Mirrors os-activate honesty:
 * - plan/resume catch on activate_families_on_disk must return [] (not planned ready)
 * - on-disk finish: only registered names go live; remainder fail + clear pending
 */

/** Catch path: invoke fail/timeout must not pretend every planned family registered. */
function registeredAfterActivateInvoke(plannedReady, invoke) {
  if (!invoke.ok) return [];
  return Array.isArray(invoke.value) ? invoke.value : [];
}

/** On-disk finish accounting after activate_families_on_disk returns a subset (or []). */
function finishOnDiskRegister(requested, registered) {
  const readyLower = new Set(registered.map((n) => n.trim().toLowerCase()));
  const failedNames = requested.filter((n) => !readyLower.has(n.trim().toLowerCase()));
  return {
    liveNames: registered.slice(),
    done: registered.length,
    skipped: registered.length,
    failed: failedNames.length,
    failedNames,
    pendingClearNames: failedNames,
  };
}

test("plan/resume catch returns [] — no false live after kill/timeout", () => {
  const planned = ["Nunito", "Roboto", "Open Sans"];
  assert.deepEqual(registeredAfterActivateInvoke(planned, { ok: false }), []);
  assert.deepEqual(
    registeredAfterActivateInvoke(planned, { ok: true, value: ["Nunito"] }),
    ["Nunito"],
  );
  // Regression: never fall back to planned ready on failure
  const badLegacy = planned; // what .catch(() => readyNames) did
  assert.notDeepEqual(registeredAfterActivateInvoke(planned, { ok: false }), badLegacy);
});

test("partial register: subset live, remainder failed + pending clear", () => {
  const requested = ["Nunito", "Roboto", "Missing"];
  const registered = ["Nunito"];
  const fin = finishOnDiskRegister(requested, registered);
  assert.deepEqual(fin.liveNames, ["Nunito"]);
  assert.equal(fin.done, 1);
  assert.equal(fin.skipped, 1);
  assert.equal(fin.failed, 2);
  assert.deepEqual(fin.failedNames, ["Roboto", "Missing"]);
  assert.deepEqual(fin.pendingClearNames, ["Roboto", "Missing"]);
});

test("full timeout: nothing live, all failed + pending clear", () => {
  const requested = ["A", "B"];
  const fin = finishOnDiskRegister(requested, []);
  assert.deepEqual(fin.liveNames, []);
  assert.equal(fin.done, 0);
  assert.equal(fin.failed, 2);
  assert.deepEqual(fin.pendingClearNames, ["A", "B"]);
});

test("all registered: no failed bump", () => {
  const requested = ["A", "B"];
  const fin = finishOnDiskRegister(requested, ["A", "B"]);
  assert.equal(fin.failed, 0);
  assert.deepEqual(fin.pendingClearNames, []);
  assert.equal(fin.done, 2);
});


/**
 * 1.0.165 async activate_families_on_disk:
 * - Ok([]) after successful invoke means "worker accepted", NOT "registered none"
 * - Invoke fail still → no live (honesty)
 * - Live list comes from progress ready_names when running=false
 */
function interpretActivateInvoke(invoke, workerStarted) {
  if (!invoke.ok) return { accepted: false, waitPoll: false, liveFromInvoke: [] };
  // Return value is always [] when accepted (async); never treat as live list.
  return {
    accepted: workerStarted,
    waitPoll: workerStarted,
    liveFromInvoke: [],
  };
}

function liveFromProgress(ready_names, running) {
  if (running) return []; // honesty: mid-flight ready_names may grow but UI marks via queue; finish when idle
  return (ready_names ?? []).slice();
}

test("async Ok([]) is accepted — not false-all-failed", () => {
  const r = interpretActivateInvoke({ ok: true, value: [] }, true);
  assert.equal(r.accepted, true);
  assert.equal(r.waitPoll, true);
  assert.deepEqual(r.liveFromInvoke, []);
  // Must not treat Ok([]) as finishOnDiskRegister(requested, []) — that would
  // clear pending for everyone while the worker is still registering.
  const requested = ["A", "B"];
  const wrongSyncFinish = finishOnDiskRegister(requested, r.liveFromInvoke);
  assert.equal(wrongSyncFinish.failed, 2, "sync finish on Ok([]) would falsely fail all");
  assert.equal(r.waitPoll, true, "caller must wait on poll instead of sync finish");
});

test("async invoke fail — no poll, nothing live", () => {
  const r = interpretActivateInvoke({ ok: false }, false);
  assert.equal(r.accepted, false);
  assert.equal(r.waitPoll, false);
  assert.deepEqual(r.liveFromInvoke, []);
});

test("progress idle ready_names are the live list", () => {
  assert.deepEqual(liveFromProgress(["Nunito"], true), []);
  assert.deepEqual(liveFromProgress(["Nunito", "Roboto"], false), ["Nunito", "Roboto"]);
  assert.deepEqual(liveFromProgress([], false), []);
});
