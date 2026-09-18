import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 1.0.178 Retry tries Gidugu Add before settle (2100, no Retry-loop).
 * Mirrors activate.rs product rules (no GDI in Node).
 */

function familyMaySkipAddThisProcess(
  boundAllInLoaded,
  onDiskFilenameCount,
  boundCount,
  allBoundSizeMatchedMapped,
) {
  return (
    boundAllInLoaded &&
    boundCount > 0 &&
    onDiskFilenameCount === boundCount &&
    allBoundSizeMatchedMapped
  );
}

function catalogExpectedGdiLive(catalogFamilies, knownIncapableIntact) {
  return Math.max(0, catalogFamilies - knownIncapableIntact);
}

function jobDownloadedCount(done, skipped, failed, settled) {
  return Math.max(0, done - skipped - failed - settled);
}

function retryGiduguSettleWithoutRefetch(added, knownIncapable, intact, undersized) {
  return added === 0 && knownIncapable && intact && !undersized;
}

function retryMustAttemptRegisterBeforeSettle(intact) {
  return intact;
}

function jobToastIsFail(failed) {
  return failed > 0;
}

function notifyCopy(done, skipped, failed, settledNames) {
  const settled = settledNames.length;
  if (jobToastIsFail(failed) && failed > 0) {
    return { kind: "error", registered: skipped, settled };
  }
  const downloaded = jobDownloadedCount(done, skipped, failed, settled);
  return {
    kind: "success",
    downloaded,
    registered: skipped,
    settled,
    title:
      skipped && !downloaded
        ? `Already on disk — ${skipped} typefaces registered${settled ? `, ${settled} on disk (Windows refused: ${settledNames.join(", ")})` : ""}`
        : `Background job finished — ${downloaded} downloaded, ${skipped} skipped`,
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const google = JSON.parse(readFileSync(join(root, "src/lib/fonts/google-catalog.json"), "utf8"));
const other = JSON.parse(readFileSync(join(root, "src/lib/fonts/fontsource-other.json"), "utf8"));

test("family skip-Add is this-process loaded only — never maps/sidecar", () => {
  assert.equal(familyMaySkipAddThisProcess(false, 8, 8, true), false);
  assert.equal(familyMaySkipAddThisProcess(true, 9, 8, true), false);
  assert.equal(familyMaySkipAddThisProcess(true, 8, 8, false), false);
  assert.equal(familyMaySkipAddThisProcess(true, 0, 0, true), false);
  assert.equal(familyMaySkipAddThisProcess(true, 8, 8, true), true);
});

test("catalog is 2100; Gidugu is in the catalog and is supposed to GDI-live", () => {
  const googleN = Array.isArray(google.families) ? google.families.length : 0;
  const otherN = Array.isArray(other.families) ? other.families.length : 0;
  assert.equal(googleN, 1946);
  assert.equal(otherN, 154);
  assert.equal(googleN + otherN, 2100);
  const names = [...google.families, ...other.families].map((f) =>
    Array.isArray(f) ? f[0] : typeof f === "string" ? f : f.family || f.name || "",
  );
  assert.equal(names.some((n) => n.toLowerCase() === "gidugu"), true);
  assert.equal(catalogExpectedGdiLive(2100, 0), 2100, "sanitize/2015 pin ⇒ 2100 live");
  assert.equal(catalogExpectedGdiLive(2100, 1), 2099, "last-resort settle only");
  assert.equal(jobToastIsFail(0), false);
  assert.equal(jobDownloadedCount(2100, 2100, 0, 0), 0);
});

test("finish toast: 2100 registered is success; last-resort settle is not a fail", () => {
  const live = notifyCopy(2100, 2100, 0, []);
  assert.equal(live.kind, "success");
  assert.equal(live.registered, 2100);
  assert.equal(live.settled, 0);
  const toast = notifyCopy(2100, 2099, 0, ["Gidugu"]);
  assert.equal(toast.kind, "success");
  assert.equal(toast.registered, 2099);
  assert.equal(toast.settled, 1);
  assert.match(toast.title, /Gidugu/);
  const fail = notifyCopy(2100, 2099, 1, []);
  assert.equal(fail.kind, "error");
});

test("Activate All of already-live families is O(1) skip, not a fail", () => {
  // Worker partitions already-live out of filter_ready. Empty rest + nonempty
  // already must finish as registered, not "nothing intact → all failed".
  const already = 2100;
  const restReady = 0;
  const nothingIntact = already === 0 && restReady === 0;
  assert.equal(nothingIntact, false);
  const toast = notifyCopy(already, already, 0, []);
  assert.equal(toast.kind, "success");
  assert.equal(toast.registered, 2100);
});

test("Retry tries Gidugu register before settle — no refetch loop", () => {
  assert.equal(retryMustAttemptRegisterBeforeSettle(true), true);
  assert.equal(retryMustAttemptRegisterBeforeSettle(false), false);
  assert.equal(retryGiduguSettleWithoutRefetch(0, true, true, false), true);
  assert.equal(
    retryGiduguSettleWithoutRefetch(1, true, true, false),
    false,
    "Add>0 is live, not settled",
  );
  assert.equal(
    retryGiduguSettleWithoutRefetch(0, true, true, true),
    false,
    "undersized remnant must Repair, not settle",
  );
});

function progressBarDoneTotal(done, total) {
  const t = Math.max(total, done, 1);
  return { done: Math.min(Math.max(0, done), t), total: t };
}

test("progress bar never shows done over total (4044/2253)", () => {
  assert.deepEqual(progressBarDoneTotal(4044, 2253), { done: 4044, total: 4044 });
  assert.deepEqual(progressBarDoneTotal(1800, 2253), { done: 1800, total: 2253 });
  assert.deepEqual(progressBarDoneTotal(2253, 2253), { done: 2253, total: 2253 });
  assert.deepEqual(progressBarDoneTotal(0, 0), { done: 0, total: 1 });
  // Numerator is rust `done`, not max(done, skipped).
  const skipped = 4044;
  const rustDone = 2253;
  const rustTotal = 2253;
  const bar = progressBarDoneTotal(rustDone, rustTotal);
  assert.equal(bar.done, 2253);
  assert.equal(bar.total, 2253);
  assert.notEqual(Math.max(rustDone, skipped), bar.done);
});
