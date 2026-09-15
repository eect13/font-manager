import assert from "node:assert/strict";
import test from "node:test";

/**
 * 1.0.168 Variable/status honesty mirrors:
 * - Facet/badge Variable = on-disk *-variable-* only (never catalog.variable alone)
 * - Toast never claims .complete without marker; split files / stamp / GDI cause
 * - Catalog-variable without VF → Incomplete / Repair needed
 * - Retry triggers re-stage+Add (register), not ambient skip-intact only
 */

function applyDiskVariableHonesty(fonts, diskRows) {
  const vf = new Set(
    diskRows.filter((r) => r.has_variable).map((r) => r.name.trim().toLowerCase()),
  );
  return fonts.map((font) => {
    const onDiskVf = vf.has(font.family.trim().toLowerCase());
    if (onDiskVf) return { ...font, variable: true };
    return { ...font, variable: false, axes: undefined };
  });
}

function tallyVariable(list) {
  return list.reduce((n, f) => n + (f.variable ? 1 : 0), 0);
}

/** axesForFont honesty: no synthesized wght without real axes. */
function axesForFontHonest(font) {
  if (font.axes?.length) return font.axes.slice();
  return [];
}

function formatRegisterZeroDetail({ family, intact, expected, hasComplete, cause }) {
  const complete = hasComplete ? "yes" : "no";
  const exp = expected == null ? "—" : String(expected);
  return `${family} — files on disk ${intact}/${exp}, .complete=${complete}, GDI live 0 (${cause})`;
}

function diskFamilyIncomplete(row) {
  return (row.files > 0 && !row.has_complete) || Boolean(row.missing_variable) || Boolean(row.undersized);
}

/** Retry plan: intact → reregister; never wipe; fetch only when incomplete/missing VF. */
function retryPlan(families, disk) {
  const by = new Map(disk.map((d) => [d.name.toLowerCase(), d]));
  const live = [];
  const needFetch = [];
  const failed = [];
  for (const name of families) {
    const row = by.get(name.toLowerCase());
    if (row && row.files > 0) {
      if (row.registerOk) {
        live.push(name);
        continue;
      }
      failed.push({
        name,
        detail: formatRegisterZeroDetail({
          family: name,
          intact: row.files,
          expected: row.expected,
          hasComplete: Boolean(row.has_complete),
          cause: row.cause ?? "AddFontResourceExW returned 0",
        }),
        clearedComplete: true,
      });
      if (row.incomplete || row.missing_variable) needFetch.push(name);
      continue;
    }
    needFetch.push(name);
  }
  return { live, needFetch, failed, wipe: false, action: "restage+Add" };
}

test("facet/badge: Variable count from disk VF only — 42dot statics not Variable", () => {
  const fonts = [
    { family: "42dot Sans", variable: false, catalogVariable: true },
    { family: "Nunito", variable: false, catalogVariable: true },
    { family: "Clear Sans", variable: false, catalogVariable: false },
  ];
  const disk = [
    { name: "42dot Sans", has_variable: false },
    { name: "Nunito", has_variable: true },
    { name: "Clear Sans", has_variable: false },
  ];
  const next = applyDiskVariableHonesty(fonts, disk);
  assert.equal(next.find((f) => f.family === "42dot Sans").variable, false);
  assert.equal(next.find((f) => f.family === "Nunito").variable, true);
  assert.equal(tallyVariable(next), 1);
  // Catalog flag alone never wins
  const catalogOnly = applyDiskVariableHonesty(
    [{ family: "Roboto", variable: true, catalogVariable: true, axes: [{ tag: "wght" }] }],
    [],
  );
  assert.equal(catalogOnly[0].variable, false);
  assert.equal(catalogOnly[0].axes, undefined);
});

test("axesForFont does not synthesize wght without VF axes", () => {
  assert.deepEqual(
    axesForFontHonest({ variable: true, weights: [100, 400, 700], axes: undefined }),
    [],
  );
  assert.equal(
    axesForFontHonest({
      variable: true,
      axes: [{ tag: "wght", min: 100, max: 900, def: 400 }],
    }).length,
    1,
  );
});

test("toast never claims .complete without marker", () => {
  const msg = formatRegisterZeroDetail({
    family: "Clear Sans",
    intact: 10,
    expected: 10,
    hasComplete: false,
    cause: "AddFontResourceExW returned 0",
  });
  assert.match(msg, /\.complete=no/);
  assert.doesNotMatch(msg, /on disk \(\.complete\)/);
  assert.match(msg, /GDI live 0/);
  assert.match(msg, /files on disk 10\/10/);
});

test("toast splits stage-copy vs Add vs unloading", () => {
  for (const cause of [
    "stage-copy failed (ensure_gdi_session_copy)",
    "AddFontResourceExW returned 0",
    "unloading — register aborted",
  ]) {
    const msg = formatRegisterZeroDetail({
      family: "Clear Sans",
      intact: 10,
      expected: 10,
      hasComplete: false,
      cause,
    });
    assert.ok(msg.includes(cause), msg);
  }
});

test("catalog-variable incomplete without VF even when .complete present", () => {
  const row = {
    name: "Chiron Hei HK",
    files: 8,
    has_complete: true,
    has_variable: false,
    missing_variable: true,
  };
  assert.equal(diskFamilyIncomplete(row), true);
  assert.equal(
    diskFamilyIncomplete({
      name: "Nunito",
      files: 10,
      has_complete: true,
      has_variable: true,
      missing_variable: false,
    }),
    false,
  );
});

test("Retry triggers restage+Add — not wipe / not skip-intact-only", () => {
  const plan = retryPlan(
    ["Clear Sans", "Chiron Hei HK", "Missing Face"],
    [
      {
        name: "Clear Sans",
        files: 10,
        expected: 10,
        has_complete: false,
        registerOk: true,
      },
      {
        name: "Chiron Hei HK",
        files: 8,
        expected: 8,
        has_complete: true,
        missing_variable: true,
        registerOk: false,
        cause: "stage-copy failed (ensure_gdi_session_copy)",
      },
    ],
  );
  assert.equal(plan.wipe, false);
  assert.equal(plan.action, "restage+Add");
  assert.deepEqual(plan.live, ["Clear Sans"]);
  assert.ok(plan.needFetch.includes("Chiron Hei HK"));
  assert.ok(plan.needFetch.includes("Missing Face"));
  assert.equal(plan.failed.length, 1);
  assert.match(plan.failed[0].detail, /\.complete=no|stage-copy/);
  assert.equal(plan.failed[0].clearedComplete, true);
});

test("Fontsource-other live sync variable:true ignored without disk VF", () => {
  // Bundle has 0×variable; live API may still set true — honesty clears it.
  const afterSync = [{ family: "Clear Sans", variable: false, catalogVariable: false }];
  const lied = [{ family: "Clear Sans", variable: true, catalogVariable: true }];
  const fixed = applyDiskVariableHonesty(lied, [{ name: "Clear Sans", has_variable: false }]);
  assert.equal(fixed[0].variable, false);
  assert.equal(applyDiskVariableHonesty(afterSync, [])[0].variable, false);
});

test("Gidugu undersized remnant is incomplete — not skip-intact done", () => {
  const row = {
    name: "Gidugu",
    files: 1,
    has_complete: true,
    has_variable: false,
    missing_variable: false,
    undersized: true,
  };
  assert.equal(diskFamilyIncomplete(row), true);
  const msg = formatRegisterZeroDetail({
    family: "Gidugu",
    intact: 1,
    expected: 1,
    hasComplete: false, // cleared after verify
    cause: "undersized vs Google (latin/subset remnant)",
  });
  assert.match(msg, /undersized vs Google|latin\/subset/);
  assert.doesNotMatch(msg, /skip intact done/i);
});
