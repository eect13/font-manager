// Card 20 / N4: storage failures must not be silent.
// - store.ts flush called localStorage.setItem unguarded inside a timer, so a
//   QuotaExceeded/SecurityError was thrown uncaught and the write was lost.
// Behaviour tests against the real module.
import assert from "node:assert/strict";
import test from "node:test";
import { createPersistStorage, storageErrorMessage } from "../src/lib/fonts/persist-storage.ts";

function domError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function memory({ failWrites } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw failWrites();
      data.set(k, v);
    },
    removeItem: (k) => data.delete(k),
  };
}

test("flush reports a quota error instead of throwing", async () => {
  const errors = [];
  const ls = memory({ failWrites: () => domError("QuotaExceededError") });
  const s = createPersistStorage({ storage: () => ls, canWrite: () => true, onWriteError: (e) => errors.push(e), delayMs: 1 });
  s.setItem("k", "v");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "QuotaExceededError");
  // getItem flushes synchronously too — still must not throw.
  s.setItem("k", "v2");
  assert.doesNotThrow(() => s.getItem("k"));
  assert.equal(errors.length, 2);
});

test("writes before canWrite() are dropped, later ones land", async () => {
  let ready = false;
  const ls = memory();
  const s = createPersistStorage({ storage: () => ls, canWrite: () => ready, onWriteError: () => {}, delayMs: 1 });
  s.setItem("k", "defaults");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ls.data.has("k"), false);
  ready = true;
  s.setItem("k", "real");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ls.data.get("k"), "real");
});

test("storage error messages name quota and blocked storage", () => {
  assert.match(storageErrorMessage(domError("QuotaExceededError")).description, /full/i);
  assert.match(storageErrorMessage(domError("NS_ERROR_DOM_QUOTA_REACHED")).description, /full/i);
  assert.match(storageErrorMessage(domError("SecurityError")).description, /block/i);
  assert.ok(storageErrorMessage(new Error("x")).title);
});
