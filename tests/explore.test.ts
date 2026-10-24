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

test("groups: a tier, provisional or unrated", () => {
  assert.deepEqual(ids({ group: "legendary" }), ["a"]);
  assert.deepEqual(ids({ group: "provisional" }), ["c"]);
  assert.deepEqual(ids({ group: "unrated" }), ["u"]);
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

test("battling a filter: within itself only with both sides on, never for unrated", () => {
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, group: "legendary" }, true), true);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, eloMin: 1600 }, true), true);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, group: "legendary" }, false), false);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, group: "unrated" }, true), false);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, group: "provisional" }, true), true);
  assert.equal(filterBattlesWithin({ ...DEFAULT_EXPLORE_FILTERS, group: "provisional" }, false), false);
});

test("explorePoolScenes: the filter's scenes in ELO order, whatever the Explore sort", () => {
  const title = (s: Scene): string => s.title ?? "";
  const pool = explorePoolScenes(library, { ...DEFAULT_EXPLORE_FILTERS, eloMin: 1500, sort: "plays-desc" }, title);
  assert.deepEqual(
    pool.map((s) => s.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    explorePoolScenes(library, { ...DEFAULT_EXPLORE_FILTERS, group: "unrated" }, title).map((s) => s.id),
    ["u"],
  );
});
