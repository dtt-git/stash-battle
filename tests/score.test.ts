import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareByElo,
  elo,
  eloInsertionIndex,
  games,
  linearRating,
  percentileRatings,
  seed,
} from "../src/score";
import type { Scene } from "../src/types";

function scene(id: string, eloValue?: unknown, gamesValue?: unknown): Scene {
  const custom_fields: Record<string, unknown> = {};
  if (eloValue !== undefined) custom_fields.stash_battle_elo = eloValue;
  if (gamesValue !== undefined) custom_fields.stash_battle_games = gamesValue;
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
  assert.equal(games(scene("a", 1500, 12)), 12);
  assert.equal(games(scene("a", 1500, "3")), 3);
  assert.equal(games(scene("a", 1500)), 0);
  assert.equal(games(scene("a", 1500, -4)), 0);
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
