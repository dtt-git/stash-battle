import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_EXPLORE_FILTERS,
  exploreEntries,
  explorePoolScenes,
  filterBattlesWithin,
  filterExplore,
  type ExploreFilters,
} from "../src/explore";
import { tierMap } from "../src/stats";
import type { Scene } from "../src/types";

function sc(id: string, eloValue: number | null, extra: Partial<Scene> = {}, battlesValue = 0, seeded = true): Scene {
  const custom_fields: Record<string, unknown> =
    eloValue === null ? {} : { stash_battle_elo: eloValue, stash_battle_battles: battlesValue, stash_battle_seeded: seeded ? 1 : 0 };
  return { id, title: `Scene ${id}`, custom_fields, play_count: 0, ...extra };
}

// ELO-sorted, unrated last (as the all-scenes cache keeps it)
const library: Scene[] = [
  sc("a", 1900, { play_count: 1, studio: { name: "Blue Studio" } }, 12),
  sc("b", 1750, { play_count: 9, performers: [{ name: "Jane Roe" }] }, 3),
  sc("c", 1600, { play_count: 4 }, 0, false),
  sc("d", 1600, { play_count: 2 }, 30),
  sc("e", 1300, { play_count: 9, title: "Blue Night" }, 1),
  sc("u", null, { play_count: 5 }),
];
const entries = exploreEntries(library, tierMap(library), (s) => s.title ?? "");

function ids(filters: Partial<ExploreFilters>): string[] {
  return filterExplore(entries, { ...DEFAULT_EXPLORE_FILTERS, ...filters }).map((e) => e.scene.id);
}

test("exploreEntries: rank follows the library order, unrated has none", () => {
  assert.deepEqual(
    entries.map((e) => e.rank),
    [1, 2, 3, 4, 5, null],
  );
  // "c" isn't seeded and has no battles, so it's provisional and gets no tier
  assert.equal(entries[2].tier, null);
  assert.equal(entries[0].tier?.id, "legendary");
});

test("default filters show everyone by ELO, unrated last", () => {
  assert.deepEqual(ids({}), ["a", "b", "c", "d", "e", "u"]);
});

test("search matches title, studio and performers; every word must match", () => {
  assert.deepEqual(ids({ query: "blue" }), ["a", "e"]);
  assert.deepEqual(ids({ query: "jane" }), ["b"]);
  assert.deepEqual(ids({ query: "blue night" }), ["e"]);
  assert.deepEqual(ids({ query: "  " }), ["a", "b", "c", "d", "e", "u"]);
});

test("groups: a tier, provisional or unrated; several match any of them", () => {
  assert.deepEqual(ids({ groups: ["legendary"] }), ["a"]);
  assert.deepEqual(ids({ groups: ["provisional"] }), ["c"]);
  assert.deepEqual(ids({ groups: ["unrated"] }), ["u"]);
  assert.deepEqual(ids({ groups: ["legendary", "unrated"] }), ["a", "u"]);
  assert.deepEqual(ids({ groups: [] }), ["a", "b", "c", "d", "e", "u"]);
});

test("ELO range is inclusive and leaves unrated scenes out", () => {
  assert.deepEqual(ids({ eloMin: 1600, eloMax: 1624 }), ["c", "d"]);
  assert.deepEqual(ids({ eloMin: 1700 }), ["a", "b"]);
  assert.deepEqual(ids({ eloMax: 1300 }), ["e"]);
});

test("sorting: ELO either way keeps unrated last; ties keep ELO order", () => {
  assert.deepEqual(ids({ sort: "elo-asc" }), ["e", "d", "c", "b", "a", "u"]);
  assert.deepEqual(ids({ sort: "plays-desc" }), ["b", "e", "u", "c", "d", "a"]);
  assert.deepEqual(ids({ sort: "plays-asc" }), ["a", "d", "c", "u", "b", "e"]);
  assert.deepEqual(ids({ sort: "battles-desc" }), ["d", "a", "b", "e", "c", "u"]);
  assert.deepEqual(ids({ sort: "battles-asc" }), ["c", "u", "e", "b", "a", "d"]);
});

test("battling a filter: within itself only with both sides on, never with unrated", () => {
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, groups: ["legendary"] }, true), true);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, eloMin: 1600 }, true), true);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, groups: ["legendary"] }, false), false);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, groups: ["unrated"] }, true), false);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, groups: ["provisional"] }, true), true);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, groups: ["provisional"] }, false), false);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, groups: ["legendary", "unrated"] }, true), false);
});

test("explorePoolScenes: the filter's scenes in ELO order, whatever the Explore sort", () => {
  const title = (s: Scene): string => s.title ?? "";
  const pool = explorePoolScenes(library, { ...DEFAULT_EXPLORE_FILTERS, eloMin: 1500, sort: "plays-desc" }, title);
  assert.deepEqual(
    pool.map((s) => s.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    explorePoolScenes(library, { ...DEFAULT_EXPLORE_FILTERS, groups: ["unrated"] }, title).map((s) => s.id),
    ["u"],
  );
});

test("record sorts: best record, highest peak, longest win streak; no record last", () => {
  const rec = (id: string, eloValue: number, r: Record<string, number>): Scene =>
    sc(id, eloValue, { custom_fields: { stash_battle_elo: eloValue, stash_battle_battles: 1, stash_battle_seeded: 1, ...r } });
  const lib = [
    rec("a", 1900, { stash_battle_wins: 3, stash_battle_losses: 3, stash_battle_peak: 1950, stash_battle_best_streak: 2 }),
    rec("b", 1800, { stash_battle_wins: 5, stash_battle_losses: 1, stash_battle_peak: 1820, stash_battle_best_streak: 4 }),
    sc("n", 1700),
    rec("c", 1600, { stash_battle_wins: 4, stash_battle_losses: 0, stash_battle_peak: 1660, stash_battle_best_streak: 4 }),
  ];
  const es = exploreEntries(lib, tierMap(lib), (s) => s.title ?? "");
  const order = (sort: ExploreFilters["sort"]): string[] => filterExplore(es, { ...DEFAULT_EXPLORE_FILTERS, sort }).map((e) => e.scene.id);
  // wins − losses: b and c are +4, b has more wins
  assert.deepEqual(order("record-desc"), ["b", "c", "a", "n"]);
  assert.deepEqual(order("peak-desc"), ["a", "b", "c", "n"]);
  // b and c tie on a 4 streak: ELO order
  assert.deepEqual(order("streak-desc"), ["b", "c", "a", "n"]);
});
