import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bottomIndex,
  landingElo,
  maxPlacementJump,
  newPlacementRun,
  placementStep,
  recordPlacementResult,
} from "../src/placement";
import { placementElo } from "../src/score";
import type { Scene } from "../src/types";

function scene(id: string, eloValue?: number): Scene {
  return { id, custom_fields: eloValue === undefined ? {} : { stash_battle_elo: eloValue } };
}

/** An ELO-sorted pool of n scenes, 2000 down in steps of 1 (all distinct). */
function pool(n: number): Scene[] {
  return Array.from({ length: n }, (_, i) => scene(`p${i}`, 2000 - i));
}

/**
 * Run a placement to the end. The placed scene beats any opponent with a lower true ELO.
 * Returns the landing slot, the opponents' indexes in battle order, and the finished run.
 */
function simulate(trueElo: number, opts: { storedElo?: number; fromBottom?: boolean; n?: number } = {}) {
  const opponents = pool(opts.n ?? 600);
  const run = newPlacementRun(scene("placed", opts.storedElo), opts.fromBottom ?? false);
  const visited: number[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const step = placementStep(run, opponents);
    if (step.done) return { slot: step.slot, visited, run, opponents };
    visited.push(step.index);
    const opponent = opponents[step.index];
    recordPlacementResult(run, trueElo > 2000 - step.index, opponent.id);
  }
  throw new Error("placement never finished");
}

/** Where a scene with this true ELO belongs: below every opponent with a higher ELO. */
const expectedSlot = (trueElo: number, n = 600) => Math.max(0, Math.min(n, Math.ceil(2000 - trueElo)));

test("placementElo: midpoint of the neighbours, 25 beyond an edge, 1500 with none", () => {
  assert.equal(placementElo(1800, 1700), 1750);
  assert.equal(placementElo(1600.5, 1600.2), 1600.4);
  assert.equal(placementElo(1500, 1500), 1500);
  assert.equal(placementElo(null, 2000), 2025);
  assert.equal(placementElo(1010, null), 985);
  assert.equal(placementElo(null, null), 1500);
});

test("landingElo reads the neighbours, and treats unrated ones as missing", () => {
  const p = [scene("a", 1800), scene("b", 1700), scene("u")];
  assert.equal(landingElo(p, 0), 1825);
  assert.equal(landingElo(p, 1), 1750);
  assert.equal(landingElo(p, 2), 1675);
  assert.equal(landingElo(p, 3), 1675, "below the unrated scene: still below the lowest rated one");
  assert.equal(bottomIndex(p), 1, "the bottom is the lowest scene with an ELO");
});

test("normal placement lands in the right slot from any start", () => {
  for (const trueElo of [2100, 1999.5, 1800.5, 1500.5, 1401.5, 1200.5, 1000]) {
    assert.equal(simulate(trueElo).slot, expectedSlot(trueElo), `unrated, true ${trueElo}`);
    assert.equal(simulate(trueElo, { storedElo: 1500 }).slot, expectedSlot(trueElo), `stored 1500, true ${trueElo}`);
  }
});

test("normal placement confirms a correctly rated scene in about 2 battles", () => {
  const { visited } = simulate(1700.5, { storedElo: 1700.5 });
  assert.ok(visited.length <= 3, `took ${visited.length}`);
});

test("start from the bottom: first opponent is the bottom, then jumps of 1, 2, 4, 8...", () => {
  const { visited, run } = simulate(1900.5, { fromBottom: true, storedElo: 1900.5 });
  assert.deepEqual(visited.slice(0, 6), [599, 598, 596, 592, 584, 568]);
  assert.equal(run.fromBottom, true);
  // It kept winning until it overshot, so the streak is the wins before its first loss
  const firstLoss = visited.findIndex((idx) => 1900.5 < 2000 - idx);
  assert.equal(run.streak, firstLoss);
});

test("start from the bottom ignores the stored ELO and lands in the right slot", () => {
  for (const trueElo of [2100, 1999.5, 1700.5, 1500.5, 1401.5, 1001.5, 1000]) {
    const { slot } = simulate(trueElo, { fromBottom: true, storedElo: 1500 });
    assert.equal(slot, expectedSlot(trueElo), `true ${trueElo}`);
  }
});

test("start from the bottom: never losing means beating the top (slot 0, streak = battles)", () => {
  const { slot, run } = simulate(2100, { fromBottom: true });
  assert.equal(slot, 0);
  assert.equal(run.streak, run.battles);
});

test("start from the bottom stays short: at most 22 battles in a 600-scene pool", () => {
  for (let slot = 0; slot <= 600; slot++) {
    const { visited } = simulate(2000.5 - slot, { fromBottom: true });
    assert.ok(visited.length <= 22, `slot ${slot} took ${visited.length}`);
  }
});

test("start from the bottom never jumps more than 10% of the pool, so a streak climbs to #1", () => {
  assert.equal(maxPlacementJump(600), 60);
  assert.equal(maxPlacementJump(20), 4, "small pools still jump at least 4 ranks");
  for (const trueElo of [2100, 1999.5, 1950.5, 1700.5]) {
    const { visited } = simulate(trueElo, { fromBottom: true });
    for (let i = 1; i < visited.length; i++) {
      const jump = Math.abs(visited[i] - visited[i - 1]);
      assert.ok(jump <= 60, `true ${trueElo}: jump ${visited[i - 1]} → ${visited[i]}`);
    }
  }
  // Beating the top now takes a real climb (it was 11 straight wins without the cap)
  const { run } = simulate(2100, { fromBottom: true });
  assert.ok(run.battles >= 15, `took ${run.battles}`);
});
