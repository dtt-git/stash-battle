import assert from "node:assert/strict";
import { test } from "node:test";

import {
  eloHistogram,
  gemsQuadrant,
  gemsSplit,
  largestTie,
  leastTested,
  leastTestedPool,
  median,
  overview,
  ratingScaleTicks,
  settledBuckets,
  tierMap,
} from "../src/stats";
import type { Scene } from "../src/types";

/** A settled scene (seeded, so never provisional) at this ELO. */
function settled(id: string, eloValue: number): Scene {
  return { id, custom_fields: { stash_battle_elo: eloValue, stash_battle_battles: 0, stash_battle_seeded: 1 } };
}

function tierIds(scenes: Scene[]): (string | undefined)[] {
  const tiers = tierMap(scenes);
  return scenes.map((s) => tiers.get(s.id)?.id);
}

test("tiers follow the percentile ladder in a 100-scene library", () => {
  const scenes = Array.from({ length: 100 }, (_, i) => settled(String(i), 2000 - i));
  const ids = tierIds(scenes);
  const count = (id: string): number => ids.filter((t) => t === id).length;
  assert.equal(count("legendary"), 1);
  assert.equal(count("diamond"), 4);
  assert.equal(count("platinum"), 10);
  assert.equal(count("gold"), 20);
  assert.equal(count("silver"), 30);
  assert.equal(count("bronze"), 35);
  // Best first
  assert.equal(ids[0], "legendary");
  assert.equal(ids[99], "bronze");
});

test("tiers ignore the input order", () => {
  const scenes = [settled("low", 1200), settled("top", 1900), settled("mid", 1500)];
  const tiers = tierMap(scenes);
  assert.equal(tiers.get("top")?.id, "legendary");
  assert.equal(tiers.get("low")?.id, "bronze");
});

test("tied scenes share a tier", () => {
  // 10 scenes: one on top, then 9 tied (middle position 5 of 10, so Silver)
  const scenes = [settled("top", 1800), ...Array.from({ length: 9 }, (_, i) => settled(`t${i}`, 1500))];
  const ids = tierIds(scenes);
  assert.equal(ids[0], "legendary");
  assert.deepEqual(new Set(ids.slice(1)), new Set(["silver"]));
});

test("provisional and unrated scenes get no tier and don't count", () => {
  const provisional: Scene = { id: "p", custom_fields: { stash_battle_elo: 2500, stash_battle_battles: 3 } };
  const unrated: Scene = { id: "u", custom_fields: {} };
  const tiers = tierMap([provisional, unrated, settled("a", 1500), settled("b", 1400)]);
  assert.equal(tiers.has("p"), false);
  assert.equal(tiers.has("u"), false);
  assert.equal(tiers.get("a")?.id, "legendary");
  assert.equal(tiers.get("b")?.id, "silver");
});

test("tiny libraries", () => {
  assert.deepEqual(tierIds([]), []);
  assert.deepEqual(tierIds([settled("a", 1500)]), ["legendary"]);
  assert.deepEqual(tierIds([settled("a", 1600), settled("b", 1500)]), ["legendary", "silver"]);
  const ten = Array.from({ length: 10 }, (_, i) => settled(String(i), 1600 - i));
  assert.deepEqual(tierIds(ten), [
    "legendary",
    "platinum",
    "gold",
    "gold",
    "silver",
    "silver",
    "silver",
    "bronze",
    "bronze",
    "bronze",
  ]);
});

/** A scene with these fields (only the ones given). */
function sc(id: string, eloValue?: number, battlesValue?: number, plays?: number, seeded = false): Scene {
  const custom_fields: Record<string, unknown> = {};
  if (eloValue !== undefined) custom_fields.stash_battle_elo = eloValue;
  if (battlesValue !== undefined) custom_fields.stash_battle_battles = battlesValue;
  if (seeded) custom_fields.stash_battle_seeded = 1;
  return { id, custom_fields, play_count: plays ?? 0 };
}

test("overview counts rated, unrated, provisional and battles", () => {
  const scenes = [sc("a", 1600, 3), sc("b", 1500, 12), sc("c", 1500, 0, 0, true), sc("u")];
  assert.deepEqual(overview(scenes), { rated: 3, unrated: 1, provisional: 1, battles: 15 });
});

test("eloHistogram: 25-ELO buckets from lowest to highest, gaps included", () => {
  const scenes = [sc("a", 1500), sc("b", 1524.9), sc("c", 1525), sc("d", 1580), sc("u")];
  assert.deepEqual(eloHistogram(scenes), [
    { from: 1500, count: 2 },
    { from: 1525, count: 1 },
    { from: 1550, count: 0 },
    { from: 1575, count: 1 },
  ]);
  assert.deepEqual(eloHistogram([]), []);
});

test("largestTie finds the biggest group sharing one ELO", () => {
  const scenes = [sc("a", 1600), sc("b", 1600), sc("c", 1500), sc("d", 1500), sc("e", 1500), sc("f", 1400)];
  assert.deepEqual(largestTie(scenes), { elo: 1500, count: 3 });
  assert.equal(largestTie([sc("a", 1600), sc("b", 1500)]), null);
});

test("ratingScaleTicks: Straight-line is fixed, Percentile follows the library, off has none", () => {
  assert.deepEqual(ratingScaleTicks([], "linear"), [
    { elo: 1010, rating: 1 },
    { elo: 1250, rating: 25 },
    { elo: 1500, rating: 50 },
    { elo: 1750, rating: 75 },
    { elo: 2000, rating: 100 },
  ]);
  assert.deepEqual(ratingScaleTicks([sc("a", 1500)], "off"), []);
  // 5 scenes: percentile ratings 100, 75, 50, 26, 1 (top to bottom)
  const five = [sc("a", 1900), sc("b", 1700), sc("c", 1600), sc("d", 1550), sc("e", 1200)];
  assert.deepEqual(
    ratingScaleTicks(five, "percentile").map((t) => [t.rating, t.elo]),
    [[1, 1200], [25, 1550], [50, 1600], [75, 1700], [100, 1900]],
  );
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test("gems quadrants split at the median ELO and play count", () => {
  const scenes = [sc("gem", 1900, 0, 1), sc("fav", 1800, 0, 9), sc("mid", 1600, 0, 4), sc("over", 1300, 0, 12), sc("meh", 1200, 0, 2)];
  const split = gemsSplit(scenes);
  assert.deepEqual(split, { elo: 1600, plays: 4 });
  if (!split) return;
  assert.equal(gemsQuadrant(scenes[0], split), "gem");
  assert.equal(gemsQuadrant(scenes[1], split), null);
  assert.equal(gemsQuadrant(scenes[2], split), null);
  assert.equal(gemsQuadrant(scenes[3], split), "overplayed");
  assert.equal(gemsQuadrant(scenes[4], split), null);
  assert.equal(gemsQuadrant(sc("u", undefined, 0, 0), split), null);
  assert.equal(gemsSplit([sc("u")]), null);
});

test("settledBuckets follow the K tiers: 0, 1-9, 10-29, 30+", () => {
  const scenes = [sc("a", 1500, 0), sc("b", 1500, 1), sc("c", 1500, 9), sc("d", 1500, 10), sc("e", 1500, 29), sc("f", 1500, 30), sc("u")];
  assert.deepEqual(settledBuckets(scenes), [
    { min: 0, max: 0, count: 1 },
    { min: 1, max: 9, count: 2 },
    { min: 10, max: 29, count: 2 },
    { min: 30, max: null, count: 1 },
  ]);
});

test("leastTested picks the fewest battles, at random among equals, not the scene just shown", () => {
  const pool = [sc("a", 1500, 4), sc("b", 1500, 0), sc("c", 1500, 0), sc("d", 1500, 2)];
  assert.equal(leastTested(pool, null, () => 0)?.id, "b");
  assert.equal(leastTested(pool, null, () => 0.99)?.id, "c");
  assert.equal(leastTested(pool, "b", () => 0)?.id, "c");
  // Unrated scenes have no battles, so they're among the least tested
  assert.equal(leastTested([sc("a", 1500, 1), sc("u")], null)?.id, "u");
  assert.equal(leastTested([sc("a", 1500, 1)], "a")?.id, "a");
  assert.equal(leastTested([], null), null);
});

test("leastTestedPool counts the scenes sharing the fewest battles, unrated ones included", () => {
  assert.deepEqual(leastTestedPool([sc("a", 1500, 0), sc("b", 1500, 0), sc("c", 1500, 3), sc("u")]), { battles: 0, count: 3, unrated: 1 });
  assert.deepEqual(leastTestedPool([sc("a", 1500, 4), sc("b", 1500, 2)]), { battles: 2, count: 1, unrated: 0 });
  assert.equal(leastTestedPool([]), null);
});
