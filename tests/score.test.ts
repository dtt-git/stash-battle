import assert from "node:assert/strict";
import { test } from "node:test";

import {
  afterSetup,
  battles,
  compareByElo,
  elo,
  eloInsertionIndex,
  isSeeded,
  kGames,
  linearRating,
  percentileRatings,
  seed,
  stashRatingChanges,
  startingElo,
} from "../src/score";
import type { Scene } from "../src/types";

function scene(id: string, eloValue?: unknown, battlesValue?: unknown, seededValue?: unknown): Scene {
  const custom_fields: Record<string, unknown> = {};
  if (eloValue !== undefined) custom_fields.stash_battle_elo = eloValue;
  if (battlesValue !== undefined) custom_fields.stash_battle_battles = battlesValue;
  if (seededValue !== undefined) custom_fields.stash_battle_seeded = seededValue;
  return { id, custom_fields };
}

test("seed maps 1-100 onto 1010-2000 with 50 at 1500", () => {
  assert.equal(seed(1), 1010);
  assert.equal(seed(50), 1500);
  assert.equal(seed(100), 2000);
});

test("linearRating undoes seed for every rating", () => {
  for (let r = 1; r <= 100; r++) assert.equal(linearRating(seed(r)), r);
});

test("linearRating clamps at both ends", () => {
  assert.equal(linearRating(1995), 100);
  assert.equal(linearRating(1994), 99);
  assert.equal(linearRating(2500), 100);
  assert.equal(linearRating(1014), 1);
  assert.equal(linearRating(1015), 2);
  assert.equal(linearRating(200), 1);
});

test("elo and games read numbers, numeric strings, and treat anything else as missing", () => {
  assert.equal(elo(scene("a", 1740.5)), 1740.5);
  assert.equal(elo(scene("a", "1620")), 1620);
  assert.equal(elo(scene("a")), null);
  assert.equal(elo(scene("a", "")), null);
  assert.equal(elo(scene("a", "abc")), null);
  assert.equal(elo({ id: "a" }), null);
  assert.equal(elo({ id: "a", custom_fields: null }), null);
  assert.equal(battles(scene("a", 1500, 12)), 12);
  assert.equal(battles(scene("a", 1500, "3")), 3);
  assert.equal(battles(scene("a", 1500)), 0);
  assert.equal(battles(scene("a", 1500, -4)), 0);
});

test("kGames is real battles plus the head start (10) for seeded scenes only", () => {
  assert.equal(kGames(scene("a", 1740, 3, true)), 13);
  assert.equal(kGames(scene("a", 1740, 0, true)), 10, "seeded, never battled: past the K 40 stage");
  assert.equal(kGames(scene("a", 1500, 3, false)), 3);
  assert.equal(kGames(scene("a", 1500, 3)), 3);
  assert.equal(isSeeded(scene("a", 1500, 0, "true")), true);
  assert.equal(isSeeded(scene("a", 1500, 0, 1)), true, "Stash stores true as 1");
  assert.equal(kGames(scene("a", 1740, 2, 1)), 12);
  assert.equal(isSeeded(scene("a", 1500, 0, false)), false);
  assert.equal(isSeeded(scene("a", 1500, 0, 0)), false);
  assert.equal(isSeeded({ id: "a" }), false);
});

test("percentileRatings spreads ranks evenly from 100 to 1", () => {
  const elos = [2150, 1980, 1700, 1650, 1600, 1550, 1500, 1400, 1250, 1100];
  const ratings = percentileRatings(elos.map((e, i) => scene(String(i), e)));
  assert.deepEqual(
    elos.map((_, i) => ratings.get(String(i))),
    [100, 89, 78, 67, 56, 45, 34, 23, 12, 1],
  );
});

test("percentileRatings gives tied scenes the middle of their group and skips unrated", () => {
  // The setup screen's "Use my ratings" example: two tied at the top, one unrated
  const elos = [2000, 2000, 1960, 1850, 1740, 1700, 1620, 1450, 1200];
  const scenes = elos.map((e, i) => scene(String(i), e));
  scenes.push(scene("unrated"));
  const ratings = percentileRatings(scenes);
  assert.deepEqual(
    elos.map((_, i) => ratings.get(String(i))),
    [94, 94, 75, 63, 50, 38, 26, 13, 1],
  );
  assert.equal(ratings.has("unrated"), false);
});

test("percentileRatings: everyone tied is 50, a single scene is 50, none is empty", () => {
  for (const n of [2, 3, 10, 11]) {
    const ratings = percentileRatings(Array.from({ length: n }, (_, i) => scene(String(i), 1500)));
    assert.deepEqual([...new Set(ratings.values())], [50], `n=${n}`);
  }
  assert.deepEqual([...percentileRatings([scene("a", 1800)])], [["a", 50]]);
  assert.equal(percentileRatings([scene("a")]).size, 0);
});

test("compareByElo sorts highest first, unrated last, ties stable", () => {
  const scenes = [scene("u1"), scene("b", 1500), scene("a", 1800), scene("u2"), scene("c", 1500)];
  assert.deepEqual(
    scenes.sort(compareByElo).map((s) => s.id),
    ["a", "b", "c", "u1", "u2"],
  );
});

test("eloInsertionIndex places below equal or higher ELO and above unrated", () => {
  const pool = [scene("a", 1800), scene("b", 1500), scene("c", 1500), scene("u")];
  assert.equal(eloInsertionIndex(pool, 1900), 0);
  assert.equal(eloInsertionIndex(pool, 1500), 3);
  assert.equal(eloInsertionIndex(pool, 1600), 1);
  assert.equal(eloInsertionIndex(pool, 1000), 3);
  assert.equal(eloInsertionIndex([scene("a", 1800)], 1000), 1);
});

/** The setup preview's "Now in Stash" example: a tie at 100 and one unrated scene. */
const PREVIEW_NOW: (number | null)[] = [100, 100, 96, 85, 74, 70, 62, 45, 20, null];
const previewScenes = (): Scene[] =>
  PREVIEW_NOW.map((rating100, i) => ({ id: String(i), rating100, custom_fields: { other_plugin: "x" } }));

test("startingElo seeds rated scenes from their rating, or starts everyone at 1500", () => {
  assert.deepEqual(startingElo({ id: "a", rating100: 74 }, "ratings"), { elo: 1740, battles: 0, seeded: true });
  assert.equal(startingElo({ id: "a", rating100: null }, "ratings"), null);
  assert.equal(startingElo({ id: "a" }, "ratings"), null);
  assert.deepEqual(startingElo({ id: "a", rating100: 74 }, "fresh"), { elo: 1500, battles: 0, seeded: false });
  assert.deepEqual(startingElo({ id: "a" }, "fresh"), { elo: 1500, battles: 0, seeded: false });
});

test("afterSetup replaces only our fields, and drops an old ELO when the scene starts unrated", () => {
  const before: Scene = {
    id: "a",
    rating100: null,
    custom_fields: { other_plugin: "x", stash_battle_elo: 1612, stash_battle_battles: 4, stash_battle_seeded: true },
  };
  assert.deepEqual(afterSetup(before, "ratings").custom_fields, { other_plugin: "x" });
  assert.deepEqual(afterSetup(before, "fresh").custom_fields, {
    other_plugin: "x",
    stash_battle_elo: 1500,
    stash_battle_battles: 0,
    stash_battle_seeded: false,
  });
  assert.equal(before.custom_fields?.stash_battle_elo, 1612, "original untouched");
});

test("stashRatingChanges matches the setup preview's counts", () => {
  const ratings = previewScenes().map((s) => afterSetup(s, "ratings"));
  const fresh = previewScenes().map((s) => afterSetup(s, "fresh"));
  assert.deepEqual(
    previewScenes().map((s) => elo(afterSetup(s, "ratings"))),
    [2000, 2000, 1960, 1850, 1740, 1700, 1620, 1450, 1200, null],
  );
  // Use my ratings + Straight-line gives every scene its own rating back
  assert.equal(stashRatingChanges(ratings, "linear").size, 0);
  // Use my ratings + Percentile: every rated scene moves, the unrated one isn't written
  const pct = stashRatingChanges(ratings, "percentile");
  assert.deepEqual([...pct.values()], [94, 94, 75, 63, 50, 38, 26, 13, 1]);
  assert.equal(pct.has("9"), false);
  // Start at 1500: everything becomes 50 under either mode, the unrated scene included
  for (const mode of ["linear", "percentile"] as const) {
    const changes = stashRatingChanges(fresh, mode);
    assert.equal(changes.size, 10, mode);
    assert.deepEqual([...new Set(changes.values())], [50], mode);
  }
  assert.equal(stashRatingChanges(ratings, "off").size, 0);
  // A scene already at its target isn't written
  assert.equal(stashRatingChanges([{ id: "a", rating100: 50, custom_fields: { stash_battle_elo: 1500 } }], "linear").size, 0);
});
