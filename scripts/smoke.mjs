// Smoke checks in a headless Chrome against your running Stash. Nothing is written to Stash:
// the fake layer in harness.mjs keeps every write in memory.
//
//   npm run smoke                   all checks
//   npm run smoke -- fresh          a first install: setup (both starts), picks, undo, every mode and tab
//   npm run smoke -- one            battling one scene until Stop (Explore's ⚔️, a scene page)
//   npm run smoke -- old            a Stash without scene custom fields shows the "newer Stash" message
//   npm run smoke -- big [size]     a synthetic library (default 20,000 scenes), with timings
//
// Exits 1 if a check fails or the page logs an error.

import { launch, openStashBattle, showTab, snapshotDiff, stashSnapshot } from "./harness.mjs";

const which = process.argv[2] || "all";
const bigSize = Number(process.argv[3]) || 20000;
const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const text = (page) => page.evaluate(() => document.querySelector("#sb-modal")?.innerText || "");
const cards = (page) => page.evaluate(() => document.querySelectorAll(".sb-scene-card").length);
const twoCards = (page, timeout = 30000) => page.waitForFunction(() => document.querySelectorAll(".sb-scene-card").length === 2, null, { timeout });
const before = await stashSnapshot();

/** Pick a side and wait for the next pair (the result animation takes 1.5 s). */
async function pick(page, side = "left") {
  await page.click(`.sb-scene-card[data-side="${side}"] .sb-choose-btn`);
  await page.waitForTimeout(1700);
  await page.waitForFunction(() => document.querySelectorAll(".sb-scene-card").length === 2 || document.querySelector(".sb-end-screen"), null, { timeout: 30000 });
}

async function mode(page, name) {
  await page.click(`.sb-mode-btn[data-mode="${name}"]`);
  await page.waitForTimeout(500);
  await twoCards(page);
}

/** Every tab opens with content and no errors. */
async function tabs(page) {
  await showTab(page, "Explore");
  check((await page.evaluate(() => document.querySelectorAll(".sb-mini-card").length)) > 0, "Explore shows cards");
  await showTab(page, "Stats");
  check(/How settled/.test(await text(page)), "Stats shows its sections");
  await showTab(page, "Records");
  check(/Hall of fame/.test(await text(page)), "Records shows the hall of fame");
  await showTab(page, "Settings");
  check(/Stash ratings update mode/.test(await text(page)), "Settings shows its rows");
  await showTab(page, "Battle");
}

// ---------- a first install ----------

async function fresh(start, stashRatings) {
  console.log(`\nfresh install: "${start}" start, Stash ratings "${stashRatings}"`);
  const run = await launch({ mode: "fresh" });
  const { page, writes } = run;
  await openStashBattle(page);
  await page.waitForFunction(() => document.querySelectorAll('#sb-modal input[type="radio"]').length > 0, null, { timeout: 30000 });
  const setupText = await text(page);
  check(/Set up ELO/.test(setupText), "the ELO setup shows on first open");
  check(!/earlier setup/.test(setupText), "no 'earlier setup' notice on a clean library");
  await page.evaluate(
    ([s, r]) => {
      document.querySelector(`#sb-modal input[type="radio"][value="${s}"]`).click();
      document.querySelector(`#sb-modal input[type="radio"][value="${r}"]`).click();
    },
    [start, stashRatings],
  );
  await page.waitForTimeout(500);
  await page.click('#sb-modal [data-role="start"]');
  await page.waitForSelector('#sb-modal [data-role="done"]', { timeout: 60000 });
  const scenesWithElo = [...writes.scenes.values()].filter((e) => "stash_battle_elo" in e.set).length;
  check(scenesWithElo > 0, `setup gave ${scenesWithElo} scenes an ELO`);
  check(typeof writes.config?.eloSetupAt === "string", "setup saved eloSetupAt");
  check(writes.config?.stashRatings === stashRatings, `setup saved stashRatings "${stashRatings}"`);
  if (stashRatings !== "off") check([...writes.scenes.values()].some((e) => "rating100" in e), "setup wrote Stash ratings");

  await page.click('#sb-modal [data-role="done"]');
  await twoCards(page);
  check(/ELO \d/.test(await text(page)), "the first pair shows ELO");
  const writesBefore = writes.count;
  for (let i = 0; i < 3; i++) await pick(page, i % 2 ? "right" : "left");
  check(writes.count > writesBefore, `3 Swiss picks wrote (${writes.count - writesBefore} writes)`);
  check([...writes.scenes.values()].some((e) => "stash_battle_wins" in e.set), "picks wrote record fields");

  const undoEnabled = await page.evaluate(() => !document.querySelector("#sb-undo-btn")?.disabled);
  check(undoEnabled, "Undo is available after a pick");
  await page.click("#sb-undo-btn");
  await page.waitForTimeout(1500);
  check((await cards(page)) === 2, "Undo brings the pair back");

  await mode(page, "placement");
  check(/Narrowing between|Unrated/.test(await text(page)), "Placement starts a run");
  await pick(page, "left");
  await mode(page, "champion");
  await pick(page, "left");
  check(/win/.test(await text(page)), "Champion shows a win streak");
  await mode(page, "swiss");
  await tabs(page);
  check(run.errors.length === 0, `no page errors${run.errors.length ? ":\n      " + run.errors.join("\n      ") : ""}`);
  await run.browser.close();
}

// ---------- a Stash without custom fields ----------

async function old() {
  console.log("\nStash older than v0.31.0");
  const run = await launch({ mode: "old" });
  const { page } = run;
  await openStashBattle(page);
  await page.waitForTimeout(3000);
  check(/needs a newer version of Stash/.test(await text(page)), "the 'needs a newer Stash' message shows");
  check(run.stats.refused === 0, "nothing tried to write");
  await run.browser.close();
}

// ---------- battling one scene until Stop ----------

async function oneScene() {
  console.log("\none scene: Explore's ⚔️ and a scene page");
  const run = await launch({
    mode: "big",
    size: 2000,
    config: { eloSetupAt: new Date().toISOString(), eloSetupMode: "ratings", stashRatings: "off" },
  });
  const { page } = run;
  const left = () => page.evaluate(() => document.querySelector('.sb-scene-card[data-side="left"] [data-winner]')?.dataset.winner);
  const status = () => page.evaluate(() => document.querySelector("#sb-pool-status")?.innerText || "");
  await openStashBattle(page);
  await twoCards(page);

  await showTab(page, "Explore");
  const id = await page.evaluate(() => document.querySelector(".sb-mini-battle")?.dataset.battle);
  await page.click(".sb-mini-battle");
  await twoCards(page);
  check(/Battling one scene/.test(await status()), "Explore's ⚔️ says it's battling one scene");
  let stayed = (await left()) === id;
  for (let i = 0; i < 3; i++) {
    await pick(page, i % 2 ? "left" : "right");
    stayed &&= (await left()) === id;
  }
  check(stayed, "the scene stays on the left pick after pick");
  await page.click('#sb-pool-status [data-action="stop-explore-pool"]');
  await page.waitForTimeout(500);
  await twoCards(page);
  check(!/Battling one scene/.test(await status()), "Stop goes back to the whole library");

  // As if opened on that scene's page (Stash's page itself isn't loaded: only the URL matters)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await page.evaluate((sceneId) => history.pushState({}, "", `/scenes/${sceneId}`), id);
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("nav a, nav button")].find((e) => /Battle/.test(e.textContent));
    (link || document.querySelector("#plugin_sb_icon button")).click();
  });
  // The hidden modal still holds the last pair: wait for it to open again
  await page.waitForFunction(() => !document.querySelector("#sb-modal")?.classList.contains("sb-modal-hidden"), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await twoCards(page);
  const opened = await status();
  check(/Battling one scene/.test(opened), `opening on a scene page battles that scene${/Battling one scene/.test(opened) ? "" : ` (status: ${opened.replace(/:.*?·/, ": … ·")})`}`);
  await pick(page, "right");
  check((await left()) === id, "the scene page's scene stays after a pick");

  // Looking at the opponent's page mid-battle keeps the pair and the scene being battled
  const opponent = await page.evaluate(() => document.querySelector('.sb-scene-card[data-side="right"] [data-winner]')?.dataset.winner);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await page.evaluate((sceneId) => history.pushState({}, "", `/scenes/${sceneId}`), opponent);
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("nav a, nav button")].find((e) => /Battle/.test(e.textContent));
    (link || document.querySelector("#plugin_sb_icon button")).click();
  });
  await page.waitForFunction(() => !document.querySelector("#sb-modal")?.classList.contains("sb-modal-hidden"), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const kept = await page.evaluate(() => [...document.querySelectorAll(".sb-scene-card [data-winner]")].map((e) => e.dataset.winner));
  check(kept[0] === id && kept[1] === opponent, "opening on the opponent's page keeps the pair");
  await pick(page, "right");
  check((await left()) === id, "...and keeps battling the same scene");
  check(run.errors.length === 0, `no page errors${run.errors.length ? ":\n      " + run.errors.join("\n      ") : ""}`);
  await run.browser.close();
}

// ---------- a big library ----------

async function timed(page, label, action, done, results) {
  await page.evaluate(() => (window.__long = []));
  const t0 = Date.now();
  await action();
  await page.waitForFunction(done, null, { timeout: 120000, polling: 50 });
  const ms = Date.now() - t0;
  const longest = await page.evaluate(() => Math.max(0, ...(window.__long || [])));
  results.push({ label, ms, longest: Math.round(longest) });
}

async function big(size) {
  console.log(`\nbig library: ${size.toLocaleString()} synthetic scenes`);
  const run = await launch({
    mode: "big",
    size,
    config: { eloSetupAt: new Date().toISOString(), eloSetupMode: "ratings", stashRatings: "off", explorePageSize: 60 },
  });
  const { page } = run;
  // Long tasks (main thread blocked for 50 ms or more): the page feels stuck during them
  await run.context.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long?.push(e.duration))).observe({ type: "longtask", buffered: true });
  });
  const results = [];
  await timed(page, "open Stash Battle (first pair)", () => openStashBattle(page), () => document.querySelectorAll(".sb-scene-card").length === 2, results);
  await timed(
    page,
    "Swiss pick (after the 1.5 s animation)",
    async () => {
      await page.click('.sb-scene-card[data-side="left"] .sb-choose-btn');
      await page.waitForTimeout(1500);
    },
    () => document.querySelectorAll(".sb-scene-card:not(.sb-winner):not(.sb-loser)").length === 2,
    results,
  );
  const tab = (name) => page.evaluate((n) => [...document.querySelectorAll("#sb-modal .nav-link, #sb-modal [data-tab]")].find((t) => t.textContent.includes(n)).click(), name);
  await timed(page, "Explore tab", () => tab("Explore"), () => document.querySelectorAll(".sb-mini-card").length > 0, results);
  await timed(
    page,
    "Explore: sort by best record",
    () =>
      page.evaluate(() => {
        const sel = [...document.querySelectorAll("#sb-modal select")].find((s) => [...s.options].some((o) => o.value === "record-desc"));
        document.querySelector(".sb-mini-card")?.setAttribute("data-stale", "1");
        sel.value = "record-desc";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    () => document.querySelector(".sb-mini-card") && !document.querySelector(".sb-mini-card[data-stale]"),
    results,
  );
  await timed(
    page,
    "Explore: search",
    () =>
      page.evaluate(() => {
        const input = document.querySelector('#sb-modal input[type="search"], #sb-modal input[placeholder*="Search"]');
        document.querySelector(".sb-mini-card")?.setAttribute("data-stale", "1");
        input.value = "studio 12";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    () => !document.querySelector(".sb-mini-card[data-stale]"),
    results,
  );
  await timed(page, "Stats tab", () => tab("Stats"), () => document.querySelectorAll("#sb-modal svg circle").length > 0, results);
  await timed(page, "Records tab", () => tab("Records"), () => /Hall of fame/.test(document.querySelector("#sb-modal").innerText), results);
  await timed(page, "back to Battle", () => tab("Battle"), () => document.querySelectorAll(".sb-scene-card").length === 2, results);

  for (const r of results) console.log(`  ${String(r.ms).padStart(6)} ms   longest block ${String(r.longest).padStart(5)} ms   ${r.label}`);
  check(run.errors.length === 0, `no page errors${run.errors.length ? ":\n      " + run.errors.join("\n      ") : ""}`);
  await run.browser.close();
  return results;
}

if (which === "all" || which === "fresh") {
  await fresh("ratings", "off");
  await fresh("fresh", "percentile");
}
if (which === "all" || which === "old") await old();
if (which === "all" || which === "one") await oneScene();
if (which === "all" || which === "big") await big(bigSize);

const diff = snapshotDiff(before, await stashSnapshot());
check(diff.changed.length === 0 && diff.configSame, `Stash unchanged (${diff.count} scenes)`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
