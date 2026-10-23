import assert from "node:assert/strict";
import { test } from "node:test";

import { eloExpected, eloKFactor, eloResult } from "../src/elo";

test("K drops from 40 to 24 to 16 as games build up", () => {
  assert.equal(eloKFactor(0), 40);
  assert.equal(eloKFactor(9), 40);
  assert.equal(eloKFactor(10), 24);
  assert.equal(eloKFactor(29), 24);
  assert.equal(eloKFactor(30), 16);
  assert.equal(eloKFactor(500), 16);
});

test("expected score uses the standard 400 divisor", () => {
  assert.equal(eloExpected(1500, 1500), 0.5);
  assert.ok(Math.abs(eloExpected(1900, 1500) - 10 / 11) < 1e-12);
  assert.ok(Math.abs(eloExpected(1700, 1500) - 0.7597) < 1e-4);
  assert.ok(Math.abs(eloExpected(1500, 1900) + eloExpected(1900, 1500) - 1) < 1e-12);
});

test("equal scenes with equal K trade exactly K/2", () => {
  assert.deepEqual(eloResult({ elo: 1500, games: 0 }, { elo: 1500, games: 0 }), {
    winner: 1520,
    loser: 1480,
  });
});

test("each side uses its own K: a newcomer moves more than an established scene", () => {
  const { winner, loser } = eloResult({ elo: 1500, games: 0 }, { elo: 1500, games: 50 });
  assert.equal(winner - 1500, 20);
  assert.equal(1500 - loser, 8);
});

test("an upset moves more than an expected win, and nothing is clamped", () => {
  const expectedWin = eloResult({ elo: 1900, games: 50 }, { elo: 1500, games: 50 });
  const upset = eloResult({ elo: 1500, games: 50 }, { elo: 1900, games: 50 });
  assert.equal(expectedWin.winner, 1901.5);
  assert.equal(upset.winner, 1514.5);
  assert.ok(eloResult({ elo: 2600, games: 50 }, { elo: 2600, games: 50 }).winner > 2600);
  assert.ok(eloResult({ elo: 300, games: 50 }, { elo: 300, games: 50 }).loser < 300);
});
