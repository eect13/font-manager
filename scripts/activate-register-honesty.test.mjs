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
