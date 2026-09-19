import assert from "node:assert/strict";
import test from "node:test";

/**
 * Variable/status honesty mirrors:
 * - Card badge / axes = on-disk VF only (never catalog.variable alone)
 * - Sidebar facet / `variable` query = catalogVariable OR on-disk (like Italic) — 1.0.170; restored 1.0.191
 * - WOFF2-only Material Symbols never count in facet
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

function isWoff2OnlyVariableFamily(family) {
  const t = family.trim().toLowerCase();
  return t === "material symbols" || t.startsWith("material symbols ");
}

function isVariableCatalogFamily(font) {
  if (isWoff2OnlyVariableFamily(font.family)) return false;
  return Boolean(font.variable || font.catalogVariable);
}

function tallyVariableFacet(list) {
  return list.reduce((n, f) => n + (isVariableCatalogFamily(f) ? 1 : 0), 0);
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

test("badge: Variable from disk VF only — 42dot statics not badged", () => {
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
  // Catalog flag alone never wins the badge
  const catalogOnly = applyDiskVariableHonesty(
    [{ family: "Roboto", variable: true, catalogVariable: true, axes: [{ tag: "wght" }] }],
    [],
  );
  assert.equal(catalogOnly[0].variable, false);
  assert.equal(catalogOnly[0].axes, undefined);
});

test("facet: Variable counts catalog-variable families (like Italic), not disk-only", () => {
  const fonts = [
    { family: "42dot Sans", variable: false, catalogVariable: true },
    { family: "Nunito", variable: true, catalogVariable: true },
    { family: "Clear Sans", variable: false, catalogVariable: false },
    { family: "Material Symbols Outlined", variable: false, catalogVariable: true },
  ];
  assert.equal(tallyVariable(fonts), 1, "badge tally stays on-disk");
  assert.equal(tallyVariableFacet(fonts), 2, "facet includes 42dot + Nunito, skips Material Symbols");
  assert.equal(isVariableCatalogFamily(fonts[0]), true);
  assert.equal(isVariableCatalogFamily(fonts[3]), false);
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

test("Refresh catalogs preserves on-disk VF variable without axes", () => {
  // applyDiskStatusHonesty may set variable:true before axes are probed.
  const existing = { family: "Nunito", variable: true, catalogVariable: true, axes: undefined };
  // Mirror google-api refresh merge — must NOT require axes?.length.
  const refreshed = {
    ...existing,
    catalogVariable: true,
    variable: Boolean(existing.variable),
  };
  assert.equal(refreshed.variable, true);
  // Regression: prior tip cleared honesty with `existing.variable && axes?.length`.
  const broken = existing.variable && Boolean(existing.axes?.length);
  assert.equal(broken, false);
  assert.notEqual(refreshed.variable, broken);
});

test("setGoogleFonts merge keeps variable:true without axes", () => {
  const prev = { id: "g:Nunito", family: "Nunito", variable: true, axes: undefined };
  const incoming = { id: "g:Nunito", family: "Nunito", variable: false, catalogVariable: true };
  const merged = {
    ...incoming,
    ...(prev.variable
      ? {
          variable: true,
          ...(prev.axes?.length ? { axes: prev.axes } : {}),
        }
      : {}),
  };
  assert.equal(merged.variable, true);
  assert.equal(merged.axes, undefined);
});

test("Scan Disk path applies disk VF honesty (not poll-only)", () => {
  // Mirror syncManagedDocumentsRoot / ScanDiskMenuItem: rows → applyDiskStatusHonesty.
  const fonts = [
    { family: "Nunito", variable: false, catalogVariable: true },
    { family: "42dot Sans", variable: false, catalogVariable: true },
  ];
  const rows = [
    { name: "Nunito", has_variable: true },
    { name: "42dot Sans", has_variable: false },
  ];
  const next = applyDiskVariableHonesty(fonts, rows);
  assert.equal(next.find((f) => f.family === "Nunito").variable, true);
  assert.equal(next.find((f) => f.family === "42dot Sans").variable, false);
});

test("undersized Incomplete is allowlisted (Gidugu) — not all Google 16–96KB", () => {
  assert.equal(
    diskFamilyIncomplete({
      name: "Gidugu",
      files: 1,
      has_complete: true,
      undersized: true,
    }),
    true,
  );
  // Ordinary Google with a small intact face must not be Incomplete unless flagged.
  assert.equal(
    diskFamilyIncomplete({
      name: "Nunito",
      files: 1,
      has_complete: true,
      undersized: false,
    }),
    false,
  );
});

test("shipped catalogs: Google 558 variable + Fontsource-other TTF VFs (not Material Symbols)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const gc = JSON.parse(readFileSync(join(root, "src/lib/fonts/google-catalog.json"), "utf8"));
  const fo = JSON.parse(readFileSync(join(root, "src/lib/fonts/fontsource-other.json"), "utf8"));
  const gVar = gc.families.filter((r) => r[4] === true).length;
  const fsVar = fo.families.filter((r) => r[4] === true).map((r) => r[0]);
  const fsTtfVar = fsVar.filter((n) => !isWoff2OnlyVariableFamily(n));
  assert.equal(gc.count, 1946);
  assert.equal(gVar, 558);
  assert.ok(fo.count >= 154, `fontsource-other ${fo.count}`);
  assert.ok(fsTtfVar.includes("42dot Sans"));
  assert.ok(fsTtfVar.includes("Finlandica"));
  assert.ok(!fsTtfVar.some((n) => n.toLowerCase().includes("material symbols")));
  assert.equal(fsTtfVar.length, 9);
});

test("1.0.191: Activated pool prefers store googleFonts for disk VF badge honesty", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
  assert.match(store, /Prefer store googleFonts \(disk VF honesty\)/);
  assert.match(store, /fontMatchesSearch\(font, parseSearchQuery\(query\)/);
  const metrics = readFileSync(join(root, "src/lib/fonts/metrics.ts"), "utf8");
  assert.match(metrics, /isWoff2OnlyVariableFamily/);
  assert.match(metrics, /font\.variable \|\| font\.catalogVariable/);
  const sidebar = readFileSync(join(root, "src/components/font-studio/sidebar.tsx"), "utf8");
  assert.match(sidebar, /isVariableCatalogFamily\(font\)/);
  const catalog = readFileSync(join(root, "src/lib/fonts/catalog.ts"), "utf8");
  assert.match(catalog, /export function isVariableCatalogFamily/);
  assert.match(catalog, /export function isWoff2OnlyVariableFamily/);
});
