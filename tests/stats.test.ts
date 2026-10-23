import assert from "node:assert/strict";
import { test } from "node:test";

import { tierMap } from "../src/stats";
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
