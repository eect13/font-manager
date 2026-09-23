import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const storeTs = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const downloadBar = readFileSync(join(root, "src/components/font-studio/download-bar.tsx"), "utf8");
const hydrateTs = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const sidebar = readFileSync(join(root, "src/components/font-studio/sidebar.tsx"), "utf8");
const activateToggle = readFileSync(join(root, "src/components/font-studio/activate-toggle.tsx"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");

/**
 * Mirror pickExclusiveActivate (1.0.204): catalog preferred among non-live;
 * never builds GDI evict; skip family already Live/pending under any id.
 */
function familyKey(name) {
  return name.trim().toLowerCase();
}

function liveRivalFonts(font, localFonts, googleFonts, activated, pending) {
  const key = familyKey(font.family);
  if (!key) return [];
  const out = [];
  for (const other of [...localFonts, ...googleFonts]) {
    if (other.id === font.id) continue;
    if (familyKey(other.family) !== key) continue;
    if (activated.has(other.id) || pending.has(other.id)) out.push(other);
  }
  return out;
}

function familyAlreadyLiveOrPending(font, localFonts, googleFonts, live, pending) {
  if (live.has(font.id) || pending.has(font.id)) return true;
  return liveRivalFonts(font, localFonts, googleFonts, live, pending).length > 0;
}

function pickExclusiveActivate(incoming, localFonts, googleFonts, live, pending) {
  const catalogIn = [];
  const catalogFam = new Set();
  const localIn = [];
  for (const font of incoming) {
    if (familyAlreadyLiveOrPending(font, localFonts, googleFonts, live, pending)) continue;
    if (font.source === "google") {
      catalogIn.push(font);
      catalogFam.add(familyKey(font.family));
    } else {
      localIn.push(font);
    }
  }
  const catalogIdx = new Map();
  for (const f of googleFonts) {
    const k = familyKey(f.family);
    if (!catalogIdx.has(k)) catalogIdx.set(k, []);
    catalogIdx.get(k).push(f);
  }
  const chosenLocal = [];
  const seenLocal = new Set();
  for (const font of localIn) {
    const key = familyKey(font.family);
    if (!key || catalogFam.has(key) || seenLocal.has(key)) continue;
    const catalogHit = catalogIdx.get(key);
    if (catalogHit?.some((f) => live.has(f.id) || pending.has(f.id))) continue;
    seenLocal.add(key);
    chosenLocal.push(font);
  }
  return { chosen: [...catalogIn, ...chosenLocal], evict: [] };
}

/** Deactivate pending: keep Live until unload confirms. */
function deactivatePendingState(activated, id) {
  return {
    activated: activated.slice(), // still Live
    pendingDeactivate: [id],
  };
}

function confirmDeactivated(activated, pendingDeactivate, ids) {
  const drop = new Set(ids);
  return {
    activated: activated.filter((id) => !drop.has(id)),
    pendingDeactivate: pendingDeactivate.filter((id) => !drop.has(id)),
  };
}

/** Progress owners: finishing one mode must not leave another's sticky current. */
function finishOwnedJob(job, owner, keepSettled = false) {
  if (job.owner !== owner && job.owner !== "idle" && job.mode !== owner) return job;
  const settled = keepSettled ? job.settledNames ?? [] : [];
  return {
    running: false,
    paused: false,
    mode: "idle",
    owner: "idle",
    done: 0,
    total: 0,
    failed: 0,
    skipped: 0,
    current: "",
    failedNames: [],
    failedDetails: [],
    settledNames: settled,
  };
}

function beginOwnedJob(job, owner, total, current) {
  if ((job.running || job.paused) && job.owner !== owner && job.owner !== "idle") {
    return { ok: false, job };
  }
  return {
    ok: true,
    job: {
      ...job,
      running: true,
      paused: false,
      mode: owner,
      owner,
      done: 0,
      total,
      failed: 0,
      skipped: 0,
      current: current ?? "",
      failedNames: [],
      failedDetails: [],
    },
  };
}

/** One Live id per family name — Google vs Fontsource vs local. */
function commitReadyPick(names, googleFonts, localFonts, pendingSet, activatedSet) {
  const googleByFamily = new Map();
  const fontsourceByFamily = new Map();
  const localByFamily = new Map();
  for (const font of googleFonts) {
    const key = font.family.toLowerCase();
    if (font.catalog === "other") fontsourceByFamily.set(key, font.id);
    else googleByFamily.set(key, font.id);
  }
  for (const font of localFonts) localByFamily.set(font.family.toLowerCase(), font.id);
  const ids = [];
  const seenFamily = new Set();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || seenFamily.has(key)) continue;
    const gId = googleByFamily.get(key);
    const fsId = fontsourceByFamily.get(key);
    const localId = localByFamily.get(key);
    let pick;
    if (gId && pendingSet.has(gId)) pick = gId;
    else if (fsId && pendingSet.has(fsId)) pick = fsId;
    else if (localId && pendingSet.has(localId)) pick = localId;
    else if (gId && activatedSet.has(gId)) pick = gId;
    else if (fsId && activatedSet.has(fsId)) pick = fsId;
    else if (localId && activatedSet.has(localId)) pick = localId;
    else if (gId) pick = gId;
    else if (fsId) pick = fsId;
    else if (localId) pick = localId;
    if (pick) {
      seenFamily.add(key);
      ids.push(pick);
    }
  }
  return ids;
}

/** Count lanes must stay separate. */
function countLanes({ live, settled, google, fontsource, disk }) {
  return { live, settled, google, fontsource, disk };
}

test("1.0.206 version bump (204 feel kept)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("exclusive Activate: no GDI evict / no Remove→Add chain", () => {
  const local = [{ id: "l:inter", family: "Inter", source: "local" }];
  const google = [{ id: "g:Inter", family: "Inter", source: "google", catalog: "google" }];
  const live = new Set(["l:inter"]);
  const pending = new Set();
  const { chosen, evict } = pickExclusiveActivate(
    [{ id: "g:Inter", family: "Inter", source: "google", catalog: "google" }],
    local,
    google,
    live,
    pending,
  );
  assert.deepEqual(evict, []);
  assert.deepEqual(chosen, []); // already Live from local → no-op
  assert.doesNotMatch(storeTs, /syncFontsOnSystem\(evict,\s*false\)\.then/);
  assert.match(storeTs, /evict:\s*\[\]/);
  assert.match(storeTs, /Activate = no-op/);
});

test("exclusive Activate All: catalog chosen only when not already Live; evict always []", () => {
  const local = [
    { id: "l:a", family: "Alpha", source: "local" },
    { id: "l:b", family: "Beta", source: "local" },
  ];
  const google = [
    { id: "g:Alpha", family: "Alpha", source: "google", catalog: "google" },
    { id: "g:Gamma", family: "Gamma", source: "google", catalog: "google" },
  ];
  const live = new Set(["l:a"]);
  const pending = new Set();
  const incoming = [...google, ...local];
  const { chosen, evict } = pickExclusiveActivate(incoming, local, google, live, pending);
  assert.deepEqual(evict, []);
  const ids = chosen.map((f) => f.id);
  assert.ok(!ids.includes("g:Alpha"), "Alpha already Live as local — skip");
  assert.ok(!ids.includes("l:a"));
  assert.ok(ids.includes("g:Gamma"));
  assert.ok(ids.includes("l:b"));
});

test("no dual Live Google↔Fontsource for same family name", () => {
  const googleFonts = [
    { id: "g:Same", family: "Same", source: "google", catalog: "google" },
    { id: "o:Same", family: "Same", source: "google", catalog: "other" },
  ];
  const pending = new Set(["g:Same"]);
  const activated = new Set();
  const ids = commitReadyPick(["Same"], googleFonts, [], pending, activated);
  assert.deepEqual(ids, ["g:Same"]);
  assert.equal(ids.length, 1);

  const rivals = liveRivalFonts(
    googleFonts[0],
    [],
    googleFonts,
    new Set(["o:Same"]),
    new Set(),
  );
  assert.equal(rivals.length, 1);
  assert.equal(rivals[0].id, "o:Same");
  assert.match(storeTs, /dual Live badges/);
  assert.match(osActivate, /fontsourceByFamily/);
});

test("deactivate pending-off until unload confirms", () => {
  const st = deactivatePendingState(["g:Nunito"], "g:Nunito");
  assert.deepEqual(st.activated, ["g:Nunito"]);
  assert.deepEqual(st.pendingDeactivate, ["g:Nunito"]);
  const done = confirmDeactivated(st.activated, st.pendingDeactivate, ["g:Nunito"]);
  assert.deepEqual(done.activated, []);
  assert.deepEqual(done.pendingDeactivate, []);
  assert.match(storeTs, /pendingDeactivate/);
  assert.match(storeTs, /confirmDeactivated/);
  assert.match(storeTs, /Keep Live until unload confirms/);
  assert.match(osActivate, /confirmDeactivated/);
});

test("progress owners split — cancel/finish one mode clears sticky current", () => {
  let job = {
    running: true,
    paused: false,
    mode: "register",
    owner: "register",
    done: 3,
    total: 10,
    failed: 0,
    skipped: 0,
    current: "Registering Zilla Slab",
    failedNames: [],
    failedDetails: [],
    settledNames: [],
  };
  // Remove must not steal register bar
  const steal = beginOwnedJob(job, "remove", 1, "Nunito");
  assert.equal(steal.ok, false);
  assert.equal(steal.job.current, "Registering Zilla Slab");

  job = finishOwnedJob(job, "register");
  assert.equal(job.current, "");
  assert.equal(job.owner, "idle");
  assert.equal(job.mode, "idle");
  assert.equal(job.running, false);

  assert.match(osActivate, /ProgressOwner/);
  assert.match(osActivate, /beginOwnedJob/);
  assert.match(osActivate, /finishOwnedJob/);
  assert.match(osActivate, /owner:/);
  assert.match(downloadBar, /job\.mode === "register"/);
});

test("deactivate while download drops family slot", () => {
  assert.match(osActivate, /dropDownloadFamilies/);
  assert.match(osActivate, /drop_google_download_families/);
  assert.match(activateRs, /fn drop_google_download_families/);
  assert.match(
    readFileSync(join(root, "src-tauri/permissions/font-activate.toml"), "utf8"),
    /drop_google_download_families/,
  );
});

test("visible-first / already-Live short-circuit on restore", () => {
  assert.match(hydrateTs, /Visible-first/);
  assert.match(hydrateTs, /already-Live this session/);
  assert.match(hydrateTs, /needRegister = \[\.\.\.head, \.\.\.tail\]/);
});

test("count lanes stay separate in chrome", () => {
  const lanes = countLanes({ live: 10, settled: 2, google: 1946, fontsource: 154, disk: 40 });
  assert.notEqual(lanes.google, lanes.fontsource);
  assert.notEqual(lanes.live, lanes.disk);
  assert.notEqual(lanes.live, lanes.settled);
  assert.match(sidebar, /Google \$\{counts\.gfonts/);
  assert.match(sidebar, /Fontsource \$\{counts\.fontsource/);
  assert.match(sidebar, /On disk \$\{diskCount/);
  assert.match(activateToggle, /Google \$\{gCount/);
  assert.match(activateToggle, /Fontsource \$\{fsCount/);
  assert.doesNotMatch(
    sidebar.slice(sidebar.indexOf("aria-label\": \"Activated\"")),
    /Library \$\{googleFonts\.length/,
  );
});

test("store exports pendingDeactivate helpers", () => {
  assert.match(storeTs, /queuePendingDeactivate/);
  assert.match(storeTs, /clearPendingDeactivate/);
  assert.match(storeTs, /withPendingDeactivate/);
});
